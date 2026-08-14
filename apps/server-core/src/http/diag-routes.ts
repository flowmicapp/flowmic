// SPEC-REF:
//   CLAUDE.md red line: no silent failure / live production data never enters this repo
//   docs/decisions/2026-07-29-mobile-diag-upload.md
//
// POST /api/diag/mobile — the phone hands its own diagnostic trail to the PC.
//
// owner 2026-07-29: "For the phone side, you could add a remote log-sync feature
// to help diagnose things — getting logs off the phone is inconvenient." Every failure this window has cost a day to find had the same shape:
// the PC's side was on disk (window-forensics.log) and the PHONE's side existed
// only on a device nobody can read without a USB cable. Half a chain is not a
// chain — "the computer didn't respond" is exactly the case where the missing half is the half
// that matters (did the frame ever leave?).
//
// MOUNTED IN BOTH MODES since D6 (2026-08-04; it was standalone-only before).
// The cloud leg is the ONLY path a public user has, and it used to 404 this
// route — so exactly the users who cannot hand over a USB cable had no way to
// hand over the phone's half of the chain. The old standalone-only argument
// ("on a public saas instance it would be an unauthenticated write endpoint")
// is answered by `requireVerified` below, not by unmounting: saas REFUSES an
// upload that does not carry a live pairing Bearer, while standalone keeps the
// accept-but-mark posture. The mobile posts to the same endpoint it is already
// talking to on either leg.
//
// WHAT MAY BE IN THE BODY is decided on the phone (diag_log.dart): timestamped
// diagnostic EVENTS — connection edges, emit outcomes, sizes, error codes — and
// never transcript text, never image bytes. The server does not police that (it
// cannot tell), so the phone's own writer is the boundary and says so in its
// header. The server's job is only to bound the size and put it where a human
// can find it.
//
// ── RV-13 / RV-32 (2026-07-30): WHO IS ALLOWED TO WRITE HERE ────────────────
//
// "standalone-only" was mistaken for "owner-only". standalone is the mode that
// binds every interface, so this was an ANONYMOUS append into the owner's
// forensic log from anywhere on the LAN — and this repo's whole root-cause method
// rests on believing that file. A chain of evidence that anyone can add links to
// is not a chain of evidence.
//
// The ruling is: the phone must present the SAME pairing token it presents to
// POST /api/inject/image (http/pairing-auth.ts is the one definition of that
// check). It is applied here in TWO STAGES, and the reason is written down so the
// second half is not forgotten:
//
//   NOW (this card) — PROVENANCE. A verified token makes the block "origin=
//   pairing:<id>" and prefixes each line `[phone]`. WITHOUT one, the block is
//   marked "origin=UNVERIFIED peer=<addr>" and every line is prefixed
//   `[phone-unverified]`. The server cannot prove an anonymous upload came from
//   the owner's phone, so it must not write a marker that says it did — that is
//   the same rule as "never claim something was done when it was not" applied to a log line. A forged
//   trail is now visibly forged, which is what RV-13 is actually about. Plus a
//   per-uploader rate window (below), which bounds the volume of that pollution
//   and the disk it can consume.
//
//   NEXT (was: "needs one companion change on the phone") — REFUSAL. ⚠️ The
//   sentence this stage was waiting on EXPIRED: `uploadDiagnostics`
//   (mobile/lib/src/diag/diag_upload.dart, symbol `_post`) DOES send
//   `Authorization: Bearer <token>` now whenever it holds one (and deliberately omits the
//   header when it does not, so "no token" never reads as "bad token"). D6
//   therefore turns refusal ON — but only where marking is worthless:
//   `requireVerified` (set by router.ts for saas) makes `identity === null` a
//   401 DIAG_UNVERIFIED. standalone deliberately KEEPS stage one: the owner's
//   phone with a broken pairing is the single most valuable uploader on the LAN
//   leg, and the UNVERIFIED marker already keeps its lines from impersonating
//   the phone. On the cloud leg the same tolerance would buy nothing — behind
//   nginx every anonymous caller shares one peer address, so an unverified
//   block could be neither attributed nor rate-bucketed per uploader.
//
// REJECTED alternative: "accept it if this peer currently has an authenticated
// socket in a room". A peer address does not answer "who are you", and wiring it
// as if it did would be a fresh instance of the head bug shape — the very thing
// RV-32 is about.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { log } from '../log';
import { readBounded, sendJson } from './body';
import { peerAddress } from './local-only';
import { verifyPairedMobile, type PairingRegistry } from './pairing-auth';

/** Hard ceiling on one upload. A diagnostic trail is a few hundred lines; this
 *  is generous for that and small enough that the endpoint cannot be used to
 *  fill the owner's disk. */
export const MAX_DIAG_BYTES = 256 * 1024;

/** Rate window (RV-13 rate control). Generous for a human pressing "send to computer" — the phone
 *  has no automatic uploader.
 *
 *  ⚠️ D12 (2026-08-04) — this comment used to end "…and small enough that a
 *  flood cannot outrun the 4 MB log rotation", and that sentence was FALSE twice
 *  over (anti-façade ④, an expired-truth shape):
 *   ① arithmetically: 10/min × 256 KB = 2.56 MB/min PER SOURCE, and with up to
 *     DIAG_MAX_KEYS (512) sources a distributed flood could rewrite the entire
 *     4 MB + 4 MB (.1 generation) history in about 3 minutes — the window bounds
 *     each uploader's VOLUME, it never bounded the FILE;
 *   ② structurally: the default writer was a bare `appendFileSync` that bypassed
 *     log.ts's rotation counter entirely, so diag bytes never even counted
 *     toward the 4 MB threshold — the file could grow without bound.
 *  What actually bounds what, now: this window bounds per-uploader volume;
 *  `appendWithRotation` (below) bounds the DIAG file. They are two separate
 *  bounds and neither claims the other's job.
 *
 *  ⚠️ IT-15 (2026-08-05) — EXPIRED CLAIM kept visible (anti-façade ④):
 *  "The ~3 min residue is why saas requires a verified uploader — on the LAN
 *  leg the sources are one household's devices, not 512 strangers."
 *  That sentence answered the WRONG question. `requireVerified` stops anonymous
 *  attribution collapse behind nginx; it does NOT stop ONE authenticated phone
 *  from rolling a SHARED ops log (measured: 10 × 256 KB/min = 2.5 MiB/min →
 *  live 4 MB file in 1.6 min, both generations in 3.2 min). The "one household"
 *  framing never covered the saas/multi-tenant case. Fix = decouple the files
 *  (`diagLogPathBeside`, wired at bootstrap.ts) so diag rotation cannot evict
 *  operational history. Grep anchor: `diagLogPathBeside`. */
export const DIAG_WINDOW_MS = 60_000;
export const DIAG_MAX_PER_WINDOW = 10;
/** Distinct uploaders tracked at once. Bounded so the table itself cannot be the
 *  memory-exhaustion vector; eviction is oldest-first, which can only ever GRANT
 *  someone allowance, never take a legitimate uploader's away. */
const DIAG_MAX_KEYS = 512;

/** D12 — rollover threshold for the diag writer. Mirrors log.ts's MAX_BYTES
 *  (4 MB, one kept `.1` generation) BY POLICY, not by import: log.ts deliberately
 *  exports no rotation surface (its counter is private closure state).
 *
 *  ⚠️ IT-15 (2026-08-05) — EXPIRED CLAIM kept visible: "production `logPath` IS
 *  the same FLOWMIC_LOG_PATH file log.ts writes". That was true at D12 and is
 *  why one authenticated uploader could evict every other tenant's ops trail.
 *  Production now wires a SIBLING file via `diagLogPathBeside` (bootstrap.ts);
 *  the two writers must still agree on the BYTE policy, but they no longer share
 *  a file. Pin: diag-routes.test.ts rotation + IT-15 isolation block. */
export const DIAG_ROTATE_BYTES = 4 * 1024 * 1024;

/**
 * IT-15 — derive the phone-diagnostics sink beside the ops log.
 *
 * `server.log` → `server-mobile-diag.log` (same directory). Mount decision stays
 * `FLOWMIC_LOG_PATH` (unset ⇒ DIAG_NO_SINK); only the WRITE TARGET moves so
 * diag rotation cannot rename away operational history. 🔴 Deployed relays that
 * set FLOWMIC_LOG_PATH will start writing a NEW sibling file — ops readers that
 * only open server.log will not see phone uploads until they open this path
 * (also returned as `written_to` on a successful upload).
 */
export function diagLogPathBeside(opsLogPath: string): string {
  return opsLogPath.endsWith('.log')
    ? `${opsLogPath.slice(0, -'.log'.length)}-mobile-diag.log`
    : `${opsLogPath}-mobile-diag.log`;
}

/**
 * D12 — the route's DEFAULT writer: append THROUGH the same rollover policy
 * log.ts applies to its own lines, measured against the file's REAL size.
 *
 * Why `statSync` instead of sharing log.ts's byte counter: that counter is
 * private closure state and log.ts exports no writer (its `toFile` swallows
 * errors, which this route must NOT do — a swallowed diag write would answer
 * ok:true for bytes that never landed). Measuring the real size each call
 * cannot drift and costs one stat per upload — this path is throttled to
 * DIAG_MAX_PER_WINDOW/min per source, never hot.
 *
 * ⚠️ IT-15: the "two writers, one file" interaction below is the EXPIRED shape.
 * Production now points this writer at `diagLogPathBeside(FLOWMIC_LOG_PATH)`, so
 * rotating HERE cannot rename log.ts's file. The byte policy is unchanged; the
 * coupling is gone. What can no longer happen is the pre-D12 unbounded growth
 * AND the D12-era eviction of ops history by a single tenant's uploads.
 */
export function appendWithRotation(path: string, text: string): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    size = 0; // no file yet — the normal first-write case
  }
  if (size > DIAG_ROTATE_BYTES) {
    const prev = `${path}.1`;
    rmSync(prev, { force: true }); // Windows rename refuses an existing target (same as log.ts)
    renameSync(path, prev);
  }
  appendFileSync(path, text, 'utf8');
}

/**
 * Fixed-window upload counter, keyed per uploader (pairing id when the token
 * verified, peer address otherwise). ONE instance per server — http/router.ts
 * builds it inside makeHttpHandler; a per-request instance would be a limiter
 * that limits nothing (the ReleaseSuppression trap, bootstrap.ts).
 */
export class DiagUploadThrottle {
  private readonly windows = new Map<string, { start: number; count: number; warned: boolean }>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { windowMs?: number; max?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? DIAG_WINDOW_MS;
    this.max = opts.max ?? DIAG_MAX_PER_WINDOW;
    this.now = opts.now ?? Date.now;
  }

  /** Record an attempt. `0` = allowed; otherwise the ms left in this window, so
   *  the refusal can tell the caller when to come back instead of just "no". */
  take(key: string): number {
    const t = this.now();
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
    const current = this.windows.get(key);
    if (!current) {
      if (this.windows.size >= DIAG_MAX_KEYS) {
        const oldest = this.windows.keys().next();
        if (!oldest.done) this.windows.delete(oldest.value);
      }
      this.windows.set(key, { start: t, count: 1, warned: false });
      return 0;
    }
    if (current.count < this.max) {
      current.count += 1;
      return 0;
    }
    return Math.max(1, current.start + this.windowMs - t);
  }

  /** IT-24 — whether the OVER-BUDGET refusal for `key` in its CURRENT window has
   *  not yet produced a log line. Returns `true` (and marks it) exactly once per
   *  window, `false` on every call after that until the window rolls over.
   *
   *  This exists because `take()` gives the caller no way to tell "the first
   *  request that crossed into over-budget" from "the five-hundredth" — a
   *  rejected call never creates or resets a window entry of its own (only an
   *  ACCEPTED call touches `count`), so a caller logging on every `waitMs > 0`
   *  would log once per rejected request, forever. That IS the amplifier commit
   *  2da57f0 removed once already (a sync `log.warn` → `log.ts` `toFile` append
   *  per refusal); this is the same bound applied to the 429 arm instead of the
   *  401 arm. Caller: `tryHandleDiagRoutes`'s `DIAG_RATE_LIMITED` branch. */
  shouldWarnOnceForWindow(key: string): boolean {
    const current = this.windows.get(key);
    if (!current || current.warned) return false;
    current.warned = true;
    return true;
  }
}

export interface DiagRoutesDeps {
  /** Where to append. Production passes the sibling of window-forensics.log;
   *  tests pass a temp path. Absent → the route reports it honestly. */
  logPath?: string;
  /** Seam for tests. */
  append?: (path: string, text: string) => void;
  now?: () => string;
  /** The pairing registry the Bearer token is resolved against — the SAME lookup
   *  mobile:reconnect and POST /api/inject/image use. Threaded from router.ts.
   *  Absent (unit tests that do not exercise auth) ⇒ no upload can be verified,
   *  so every block is marked UNVERIFIED: the route never assumes trust it could
   *  not check. */
  registry?: PairingRegistry;
  /** Per-uploader rate window. Absent ⇒ unlimited; production always passes one
   *  (router.ts), and the test that the WIRING is real — not just the class — is
   *  in test/http-access-control.test.ts. */
  throttle?: DiagUploadThrottle;
  /** D6 — refuse (401 DIAG_UNVERIFIED) instead of marking when the Bearer does
   *  not resolve to a live pairing. Router.ts sets it to `mode === 'saas'`:
   *  the cloud leg is public and behind nginx an unverified upload can be
   *  neither attributed nor rate-bucketed per uploader (every anonymous caller
   *  shares one peer address). Absent/false ⇒ the standalone two-stage posture:
   *  accept and mark UNVERIFIED. */
  requireVerified?: boolean;
}

// sendJson / readBounded moved to http/body.ts (2026-07-30) when the image
// upload route became their second consumer.

export function tryHandleDiagRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DiagRoutesDeps,
): boolean {
  const url = (req.url ?? '').split('?')[0];
  if (url !== '/api/diag/mobile') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const now = deps.now ?? ((): string => new Date().toISOString());
  // D12 — the default writer rotates; a bare appendFileSync here was how diag
  // uploads bypassed the 4 MB rollover entirely (see appendWithRotation).
  const append = deps.append ?? appendWithRotation;

  // ── who is uploading (RV-13) ────────────────────────────────────────────────
  // Resolved BEFORE the body is read: the answer decides the rate-limit bucket,
  // and an over-rate caller must not cost a 256 KB read. `null` is a refusal
  // only where `requireVerified` says so — see the two-stage note in this
  // file's header.
  const identity = deps.registry ? verifyPairedMobile(req, deps.registry) : null;
  const peer = peerAddress(req) || 'unknown';
  const origin = identity ? `pairing:${identity.mobile.id}` : `UNVERIFIED peer=${peer}`;
  const linePrefix = identity ? '[phone]' : '[phone-unverified]';

  // ── D6: the public (saas) leg refuses what standalone merely marks ──────────
  // Still BEFORE any body read (file header principle: do not spend a 256 KB
  // read on an unwanted request).
  //
  // ⚠️ IT-14 (2026-08-05) — EXPIRED CLAIM kept visible: "BEFORE the throttle on
  // purpose… a refusal must not cost a body read". The body-read half is still
  // true. The "skip the throttle entirely" half was false economics: every
  // refusal called `log.warn`, and `log.warn` sync-appends to FLOWMIC_LOG_PATH
  // (log.ts `toFile`). Refusing was MORE expensive than the route claimed it
  // was willing to spend. Fix: run the SAME per-peer throttle; still answer
  // 401 every time (auth failure is not a rate-limit), but only spend the
  // warn/disk line while `take` grants budget. Over-budget refusals stay 401
  // and stay silent — being told "no" cannot amplify disk work.
  if (deps.requireVerified === true && identity === null) {
    const refuseWait = deps.throttle?.take(`peer:${peer}`) ?? 0;
    if (refuseWait === 0) {
      log.warn('diag: mobile upload refused — no verified pairing on a public leg', { peer });
    }
    sendJson(res, 401, { ok: false, error: 'DIAG_UNVERIFIED' });
    return true;
  }

  const rateKey = identity ? `pair:${identity.mobile.id}` : `peer:${peer}`;
  const waitMs = deps.throttle?.take(rateKey) ?? 0;
  if (waitMs > 0) {
    // ⚠️ IT-24 (2026-08-06) — EXPIRED/FALSE CLAIM removed (anti-façade ④): this
    // comment used to say "the first crossings already spent a warn when they
    // were accepted-then-limited". Neither reachable path made that true: an
    // ACCEPTED request on this arm only ever reaches `log.info` (below, on
    // success) or a different named `log.warn` (DIAG_NO_SINK / write failure) —
    // never a warn for being "about to be limited". So `DIAG_RATE_LIMITED` was,
    // in fact, completely silent server-side: "why did phone diagnostics stop
    // arriving?" had no answer anywhere in this file. Fixed with the same
    // bounded shape IT-14 uses on the 401 arm, applied here: at most one warn
    // per rate-limit WINDOW per subject (`shouldWarnOnceForWindow`), never one
    // per request — see that method's doc for why a naive "warn on every
    // waitMs > 0" would recreate the disk-amplification commit 2da57f0 removed.
    if (deps.throttle?.shouldWarnOnceForWindow(rateKey) === true) {
      log.warn('diag: mobile upload rate-limited', { peer, authenticated: identity !== null, wait_ms: waitMs });
    }
    sendJson(res, 429, { ok: false, error: 'DIAG_RATE_LIMITED', retry_after_ms: waitMs });
    return true;
  }

  void (async () => {
    const body = await readBounded(req, MAX_DIAG_BYTES).catch(() => null);
    if (body === null) {
      sendJson(res, 400, { ok: false, error: 'DIAG_BODY_UNREADABLE' });
      return;
    }
    if (body === 'TOO_LARGE') {
      sendJson(res, 413, { ok: false, error: 'DIAG_TOO_LARGE', max_bytes: MAX_DIAG_BYTES });
      return;
    }
    let parsed: { device?: unknown; lines?: unknown };
    try {
      parsed = JSON.parse(body) as { device?: unknown; lines?: unknown };
    } catch {
      sendJson(res, 400, { ok: false, error: 'DIAG_BODY_NOT_JSON' });
      return;
    }
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.filter((l): l is string => typeof l === 'string')
      : [];
    const device = typeof parsed.device === 'string' ? parsed.device.slice(0, 120) : 'unknown-phone';
    if (lines.length === 0) {
      sendJson(res, 400, { ok: false, error: 'DIAG_EMPTY' });
      return;
    }
    if (!deps.logPath) {
      // Never answer ok:true when nothing was written.
      log.warn('diag: mobile upload refused — no log path configured', { device, lines: lines.length });
      sendJson(res, 503, { ok: false, error: 'DIAG_NO_SINK' });
      return;
    }
    const stamp = now();
    // `origin` on the block header AND the provenance in every line prefix: a
    // grep hit that is one line long has to carry its own provenance, or the
    // reader has to scroll to a header that a forged payload can imitate (a
    // forged "===== …" line inside `lines` still arrives prefixed, so the two
    // together are unambiguous).
    const text =
      `\n===== mobile diagnostics ${stamp} device=${device} lines=${lines.length} origin=${origin} =====\n` +
      lines.map((l) => `${linePrefix} ${l}`).join('\n') +
      '\n';
    try {
      append(deps.logPath, text);
    } catch (e) {
      log.warn('diag: mobile upload could not be written', { error: String(e) });
      sendJson(res, 500, { ok: false, error: 'DIAG_WRITE_FAILED' });
      return;
    }
    log.info('diag: mobile diagnostics received', { device, lines: lines.length, origin });
    // `authenticated` is reported so the phone (and a human with curl) can see
    // which of the two the server judged it to be — an unverified upload that
    // looked identical to a verified one would be the silent half-truth this
    // whole route exists to make impossible.
    sendJson(res, 200, {
      ok: true,
      lines: lines.length,
      written_to: deps.logPath,
      authenticated: identity !== null,
    });
  })();

  return true;
}
