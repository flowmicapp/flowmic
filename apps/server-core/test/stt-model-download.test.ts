// Built-in model onboarding — the state machine (§3) and the download
// controller (§4) of docs/strategy/2026-08-19-local-model-onboarding-design.md.
//
// 🔴 NO REAL MODEL IS FETCHED HERE. The shipped manifest is 229 MB from a third
// party; every case below drives the REAL fetch / Range / resume / verify code
// against a local http server serving kilobyte fixtures through an injected
// manifest. What is exercised is the production path, not a mock of it: the
// same `fetch`, the same `Range` header, the same `.part` rename, the same
// SHA-256 gate.
//
// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
// Each was RUN and each really went red on this machine (dev-pc-a,
// 2026-08-19); the readings below are the assertion lines verbatim. Tests are
// named by TITLE rather than by line coordinate on purpose — a coordinate in a
// comment is a fact with no owner, and this repo has a lint about it.
//
// 1. SINGLE-FLIGHT IS A SYNCHRONOUS CLAIM. `SherpaModelController.start()`
//    assigns `inFlight` before it awaits anything. Putting one `await
//    Promise.resolve()` in front of the claim — the edit any reviewer would
//    call equivalent — made 'three starts in the same tick fetch the file ONCE'
//    read:
//
//      AssertionError: three concurrent starts must produce ONE download, not
//      one per caller: expected 3 to be 1 // Object.is equality
//
//    Three callers, three downloads, all appending to one `.part`.
//
// 2. `bytes_total` IS NULL WHEN UNKNOWN, NEVER 0. Returning `0` from
//    `declaredTotalBytes` for an unpinned manifest — the "safe" numeric default
//    — made 'an unpinned manifest has NO total: null, not 0, not a partial sum'
//    read:
//
//      AssertionError: bytes_total must be null when the manifest cannot state
//      a total — 0 makes the interface divide by it: expected +0 to be null //
//      Object.is equality
//
// 3. `ready` MEANS THE BYTES ARE RIGHT, NOT THAT FILES EXIST. Relaxing the
//    readiness criterion to the stat-only progress count (`facts.files_done ===
//    facts.files_total`) made 'a file of the right LENGTH with the wrong bytes
//    is partial, never ready' read:
//
//      AssertionError: a right-sized file with wrong contents must never read
//      ready — that is the whole reason the criterion is SHA-256: expected
//      'ready' to be 'partial' // Object.is equality
//
// 4. `source` IS NAMED FROM THE DIAL, NOT FROM THE FIRST BYTE. Deleting the
//    `file-attempt` emit in model-fetch.ts — leaving `file-start`, which cannot
//    fire until the response headers arrive — made 'names its source from the
//    DIAL, not from the first byte' read:
//
//      AssertionError: expected false to be true // Object.is equality
//
//    That is the polling budget expiring: against a fixture with a 400 ms
//    handshake, nothing named the source for the whole 300 ms the test waited.
//    On a real slow link that blank is minutes long.
//
// ── AND ONE DEFECT THESE TESTS FOUND WITHOUT BEING ASKED TO ─────────────────
// 'bytes that arrive and fail the SHA-256 gate are an INTEGRITY failure, not a
// network one' went red on the first run against the first implementation:
//
//      AssertionError: expected 'MODEL_SOURCE_UNREACHABLE' to be
//      'MODEL_INTEGRITY_MISMATCH' // Object.is equality
//
// A three-source failover ends on the LAST source's failure, and reporting that
// one told a user whose bytes had demonstrably ARRIVED to go check their
// network. Fixed by model-status.ts `pickReportableError`; the case below is
// what holds it.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SherpaModelController, resetSherpaModelControllers,
} from '../src/stt/sherpa/model-downloader';
import {
  RateSampler, classifyDownloadError, declaredTotalBytes, deriveModelState, pickReportableError,
  readDiskFacts,
  type DiskFacts, type ModelErrorCode, type ModelStatusError,
} from '../src/stt/sherpa/model-status';
import type { ModelFile, ModelSource } from '../src/stt/sherpa/model-manifest';

// ── fixtures ─────────────────────────────────────────────────────────────────

const servers: Server[] = [];
afterEach(async () => {
  resetSherpaModelControllers();
  for (const s of servers.splice(0)) {
    // closeAllConnections() before close(): a cancelled download leaves the
    // fixture mid-response, and `close()` alone waits for that response to
    // drain — three seconds of teardown per cancel case, spent proving nothing.
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface Fixture {
  base: string;
  /** Every request the server saw: path + the Range header it carried (null =
   *  none). The download count is what proves single-flight; the Range value is
   *  what proves a resume RESUMED instead of restarting. */
  seen: { path: string; range: string | null }[];
}

/** A local origin for the model files. `chunkSize`/`delayMs` make a download
 *  slow enough to cancel deterministically; `status` forces a refusal. */
function serve(
  files: Record<string, Buffer>,
  opts: { chunkSize?: number; delayMs?: number; status?: number; ignoreRange?: boolean; headerDelayMs?: number } = {},
): Promise<Fixture> {
  const seen: Fixture['seen'] = [];
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      // A slow HANDSHAKE, which is a different thing from a slow body: it is
      // the window in which the card has nothing to show but the source name.
      if (opts.headerDelayMs) await sleep(opts.headerDelayMs);
      if (!res.destroyed) respond(req, res);
    })();
  });

  function respond(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').replace(/^\//, '');
    const range = req.headers['range'] ?? null;
    seen.push({ path, range: typeof range === 'string' ? range : null });
    if (opts.status && opts.status !== 200) {
      res.writeHead(opts.status);
      res.end('refused');
      return;
    }
    const body = files[path];
    if (!body) {
      res.writeHead(404);
      res.end('no such fixture');
      return;
    }
    const m = typeof range === 'string' && !opts.ignoreRange ? /bytes=(\d+)-/.exec(range) : null;
    const from = m ? Number(m[1]) : 0;
    const slice = body.subarray(from);
    if (m) {
      res.writeHead(206, {
        'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
        'content-length': String(slice.length),
      });
    } else {
      res.writeHead(200, { 'content-length': String(slice.length) });
    }
    void (async (): Promise<void> => {
      const chunk = opts.chunkSize ?? slice.length;
      for (let off = 0; off < slice.length; off += chunk) {
        if (res.destroyed) return;
        res.write(slice.subarray(off, off + chunk));
        if (opts.delayMs) await sleep(opts.delayMs);
      }
      if (!res.destroyed) res.end();
    })();
  }

  servers.push(s);
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      resolve({ base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, seen });
    });
  });
}

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `flowmic-model-${tag}-`));
}

function sourcesOf(f: Fixture, name = 'fixture-origin'): readonly ModelSource[] {
  return [{ name, base: f.base }];
}

/** Poll until `pred` holds or the budget runs out. Returns whether it held. */
async function until(pred: () => boolean | Promise<boolean>, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(5);
  }
  return false;
}

// ── §4 bytes_total — the null-vs-zero rule ───────────────────────────────────

describe('§4 bytes_total — 「I do not know the total」 is not 「the total is zero」', () => {
  it('sums the manifest when every file declares a size', () => {
    const files: ModelFile[] = [{ path: 'a', size: 1_000 }, { path: 'b', size: 24 }];
    expect(declaredTotalBytes(files)).toBe(1_024);
  });

  it('an unpinned manifest has NO total: null, not 0, not a partial sum', () => {
    const files: ModelFile[] = [{ path: 'a', size: 1_000 }, { path: 'b' }];
    const total = declaredTotalBytes(files);
    expect(total, 'bytes_total must be null when the manifest cannot state a total — 0 makes the interface divide by it').toBe(null);
    // Spelled out because both wrong answers are *numbers* and would sail
    // through any `typeof total === 'number'` check downstream.
    expect(total).not.toBe(0);
    expect(total).not.toBe(1_000);
  });

  it('the snapshot carries the null through rather than substituting a number', async () => {
    const dir = tempDir('unpinned');
    const c = new SherpaModelController(dir, { files: [{ path: 'a', size: 100 }, { path: 'b' }] });
    expect((await c.snapshot()).bytes_total).toBe(null);
  });
});

// ── §3 the five states, each by its stated criterion ─────────────────────────

describe('§3 state criteria — decided, not guessed', () => {
  const body = Buffer.alloc(2_048, 7);
  const files: ModelFile[] = [{ path: 'model.bin', size: body.length, sha256: sha(body) }];

  it('an empty directory is absent', async () => {
    const c = new SherpaModelController(tempDir('absent'), { files });
    const s = await c.snapshot();
    expect(s.state).toBe('absent');
    expect(s.bytes_done).toBe(0);
    expect(s.files_done).toBe(0);
  });

  it('a .part on disk is partial, and its bytes are counted as progress', async () => {
    const dir = tempDir('part');
    writeFileSync(join(dir, 'model.bin.part'), body.subarray(0, 900));
    const c = new SherpaModelController(dir, { files });
    const s = await c.snapshot();
    expect(s.state).toBe('partial');
    expect(s.bytes_done).toBe(900); // what a resume will not have to fetch again
  });

  it('a file of the right LENGTH with the wrong bytes is partial, never ready', async () => {
    const dir = tempDir('corrupt');
    writeFileSync(join(dir, 'model.bin'), Buffer.alloc(body.length, 9)); // right size, wrong contents
    const c = new SherpaModelController(dir, { files });
    const s = await c.snapshot();
    expect(s.state, 'a right-sized file with wrong contents must never read ready — that is the whole reason the criterion is SHA-256').toBe('partial');
    // …and the PROGRESS count still counts it, because that is a different
    // question (「how far along」) with a different, cheaper criterion.
    expect(s.files_done).toBe(1);
  });

  it('the real bytes are ready', async () => {
    const dir = tempDir('ready');
    writeFileSync(join(dir, 'model.bin'), body);
    const c = new SherpaModelController(dir, { files });
    const s = await c.snapshot();
    expect(s.state).toBe('ready');
    expect(s.bytes_done).toBe(body.length);
    expect(s.error).toBe(null);
  });

  it('deriveModelState orders the criteria: downloading > ready > failed > partial > absent', () => {
    const empty: DiskFacts = { bytes_done: 0, files_done: 0, files_total: 1, files_present: 0, parts_present: 0 };
    const some: DiskFacts = { ...empty, parts_present: 1, bytes_done: 10 };
    const err = { code: 'MODEL_SOURCE_UNREACHABLE' as const, message: 'HTTP 503' };
    // downloading is asked FIRST: mid-download the disk looks exactly like partial.
    expect(deriveModelState({ downloading: true, complete: false, error: err, facts: some })).toBe('downloading');
    // a complete model is ready even if the last attempt failed — the error no
    // longer describes anything.
    expect(deriveModelState({ downloading: false, complete: true, error: err, facts: some })).toBe('ready');
    // failed above partial: both are true of the disk, only one says why it stopped.
    expect(deriveModelState({ downloading: false, complete: false, error: err, facts: some })).toBe('failed');
    expect(deriveModelState({ downloading: false, complete: false, error: null, facts: some })).toBe('partial');
    expect(deriveModelState({ downloading: false, complete: false, error: null, facts: empty })).toBe('absent');
  });

  it('the snapshot has EXACTLY §4 field names — and no field claiming the engine can LOAD it', async () => {
    const dir = tempDir('shape');
    writeFileSync(join(dir, 'model.bin'), body);
    const s = await new SherpaModelController(dir, { files }).snapshot();
    expect(Object.keys(s).sort()).toEqual([
      'bytes_done', 'bytes_total', 'current_file', 'dir', 'error', 'files_done',
      'files_total', 'model_id', 'rate_bytes_per_sec', 'resumed_from_bytes',
      'source', 'state',
    ]);
    // §3's 「不许合并」: `ready` answers 「are the files right」 and NOTHING here
    // may answer 「will the recogniser open」 — a missing DLL or the wrong CPU
    // architecture is true of a model whose bytes are perfect, and the two
    // failures want opposite actions from the user.
    for (const forbidden of ['loadable', 'can_load', 'engine_ready', 'usable']) {
      expect(Object.keys(s)).not.toContain(forbidden);
    }
  });
});

// ── §4 single-flight ─────────────────────────────────────────────────────────

describe('§4 POST /download is single-flight — one download, never two, never a queue', () => {
  const body = Buffer.alloc(32_768, 3);
  const files: ModelFile[] = [{ path: 'model.bin', size: body.length, sha256: sha(body) }];

  it('three starts in the same tick fetch the file ONCE', async () => {
    const f = await serve({ 'model.bin': body }, { chunkSize: 4_096, delayMs: 10 });
    const dir = tempDir('flight');
    const c = new SherpaModelController(dir, { files, sources: sourcesOf(f) });

    const snaps = await Promise.all([c.start(), c.start(), c.start()]);
    for (const s of snaps) expect(s.state).toBe('downloading');

    expect(await until(async () => (await c.snapshot()).state === 'ready')).toBe(true);
    expect(f.seen.filter((r) => r.path === 'model.bin').length,
      'three concurrent starts must produce ONE download, not one per caller').toBe(1);
  });

  it('a start while one runs answers the RUNNING snapshot and queues nothing', async () => {
    const f = await serve({ 'model.bin': body }, { chunkSize: 4_096, delayMs: 10 });
    const c = new SherpaModelController(tempDir('nq'), { files, sources: sourcesOf(f) });

    await c.start();
    expect(await until(async () => (await c.snapshot()).bytes_done > 0)).toBe(true);
    const second = await c.start();
    expect(second.state).toBe('downloading');
    expect(second.current_file).toBe('model.bin');
    expect(second.source).toBe('fixture-origin');

    expect(await until(async () => (await c.snapshot()).state === 'ready')).toBe(true);
    // A QUEUED second download would fire here — after the first finished — and
    // this count is the only thing that would notice.
    await sleep(60);
    expect(f.seen.filter((r) => r.path === 'model.bin').length).toBe(1);
  });

  it('names its source from the DIAL, not from the first byte', async () => {
    // 🔴 The settings card prints 「Source: Hugging Face」 and that line is the
    // only evidence a person on a slow link has that anything is happening. If
    // `source` only appeared once bytes arrived, the line would be BLANK for
    // exactly as long as the connection is slow — the one moment it earns its
    // place. 400 ms of handshake here stands in for a bad link.
    const f = await serve({ 'model.bin': body }, { headerDelayMs: 400 });
    const c = new SherpaModelController(tempDir('dial'), { files, sources: sourcesOf(f) });
    await c.start();
    expect(await until(async () => (await c.snapshot()).source !== null, 300)).toBe(true);
    const early = await c.snapshot();
    expect(early.state).toBe('downloading');
    expect(early.source, 'the source must be named while we are still waiting on the server').toBe('fixture-origin');
    expect(early.current_file).toBe('model.bin');
    // The load-bearing half: named while the server has sent NOTHING. The 300 ms
    // budget above is under the fixture's 400 ms handshake, so this cannot pass
    // by accidentally waiting for the response.
    expect(early.bytes_done, 'and it is named BEFORE any byte has landed').toBe(0);
    await c.cancel();
  });

  it('the speak-time path joins the running flight instead of starting its own', async () => {
    const f = await serve({ 'model.bin': body }, { chunkSize: 4_096, delayMs: 10 });
    const c = new SherpaModelController(tempDir('ensure'), { files, sources: sourcesOf(f) });
    await c.start();
    await c.ensure(); // resolves when THAT download finishes
    expect((await c.snapshot()).state).toBe('ready');
    expect(f.seen.filter((r) => r.path === 'model.bin').length).toBe(1);
  });
});

// ── §4 cancel → partial → resume ─────────────────────────────────────────────

describe('§4 cancel stops at a resumable point — and the snapshot says from where', () => {
  const body = Buffer.alloc(65_536, 5);
  const files: ModelFile[] = [{ path: 'model.bin', size: body.length, sha256: sha(body) }];

  it('cancel keeps the .part, reads partial (not failed), and the resume sends a Range', async () => {
    const slow = await serve({ 'model.bin': body }, { chunkSize: 2_048, delayMs: 25 });
    const dir = tempDir('cancel');
    const c = new SherpaModelController(dir, { files, sources: sourcesOf(slow) });

    await c.start();
    expect(await until(async () => (await c.snapshot()).bytes_done > 2_000)).toBe(true);
    const cancelled = await c.cancel();

    expect(cancelled.state, 'a cancel is a decision, not a failure').toBe('partial');
    expect(cancelled.error).toBe(null);
    const part = join(dir, 'model.bin.part');
    expect(existsSync(part), 'the .part is what makes a later continue a CONTINUE').toBe(true);
    const kept = statSync(part).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(body.length);
    expect(cancelled.bytes_done).toBe(kept);

    // ── resume ──
    const fast = await serve({ 'model.bin': body });
    const c2 = new SherpaModelController(dir, { files, sources: sourcesOf(fast) });
    await c2.start();
    expect(await until(async () => (await c2.snapshot()).state === 'ready')).toBe(true);

    const req = fast.seen.find((r) => r.path === 'model.bin');
    expect(req?.range, 'without a Range header the resume re-downloaded from zero').toBe(`bytes=${kept}-`);
    // §4's `resumed_from_bytes` — outlives the attempt on purpose, so the card
    // can still say 「it continued from here」 once the bar is gone.
    expect((await c2.snapshot()).resumed_from_bytes).toBe(kept);
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true);
  });

  it('a resumed attempt still says so after a LATER file starts fresh', async () => {
    // The shipped manifest has two files. A resumed 229 MB model followed by a
    // fresh 300 KB tokens.txt must not end up reporting `resumed_from_bytes: 0`
    // — that answers 「did it continue?」 with 「no」 about an attempt that did.
    const second = Buffer.alloc(4_096, 6);
    const two: ModelFile[] = [
      { path: 'model.bin', size: body.length, sha256: sha(body) },
      { path: 'tokens.txt', size: second.length },
    ];
    const dir = tempDir('twofile');
    writeFileSync(join(dir, 'model.bin.part'), body.subarray(0, 20_000)); // a remainder from an earlier run
    const f = await serve({ 'model.bin': body, 'tokens.txt': second });
    const c = new SherpaModelController(dir, { files: two, sources: sourcesOf(f) });
    await c.start();
    expect(await until(async () => (await c.snapshot()).state === 'ready')).toBe(true);
    expect((await c.snapshot()).resumed_from_bytes).toBe(20_000);
  });

  it('a server that IGNORES Range restarts the part cleanly instead of appending garbage', async () => {
    // The downloader asks for `bytes=N-`; a 200 back means the server sent the
    // WHOLE file. Appending that to the existing remainder would produce a file
    // of the right length made of the wrong bytes — which the SHA-256 gate would
    // catch, but only after the second full download.
    const dir = tempDir('norange');
    writeFileSync(join(dir, 'model.bin.part'), body.subarray(0, 9_000));
    const f = await serve({ 'model.bin': body }, { ignoreRange: true });
    const c = new SherpaModelController(dir, { files, sources: sourcesOf(f) });
    await c.start();
    expect(await until(async () => (await c.snapshot()).state === 'ready')).toBe(true);
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true);
    // …and it reports honestly that it did NOT resume, because it did not.
    expect((await c.snapshot()).resumed_from_bytes).toBe(0);
  });

  it('resumed_from_bytes is 0 for a fresh download — here 0 IS the fact', async () => {
    const f = await serve({ 'model.bin': body });
    const c = new SherpaModelController(tempDir('fresh'), { files, sources: sourcesOf(f) });
    await c.start();
    expect(await until(async () => (await c.snapshot()).state === 'ready')).toBe(true);
    expect((await c.snapshot()).resumed_from_bytes).toBe(0);
  });

  it('cancel with nothing running is a no-op that answers the snapshot', async () => {
    const c = new SherpaModelController(tempDir('nocancel'), { files });
    const s = await c.cancel();
    expect(s.state).toBe('absent');
    expect(s.error).toBe(null);
  });
});

// ── §3 failed(reason) ────────────────────────────────────────────────────────

describe('§3 failed carries a reason the interface can act on', () => {
  const body = Buffer.alloc(1_024, 1);

  it('an unreachable source fails with MODEL_SOURCE_UNREACHABLE, leaving nothing half-installed', async () => {
    const f = await serve({}, { status: 503 });
    const dir = tempDir('down');
    const c = new SherpaModelController(dir, {
      files: [{ path: 'model.bin', size: body.length, sha256: sha(body) }],
      sources: sourcesOf(f),
      tarballUrl: `${f.base}/archive.tar.bz2`,
    });
    await c.start();
    expect(await until(async () => (await c.snapshot()).state === 'failed')).toBe(true);
    const s = await c.snapshot();
    expect(s.error?.code).toBe('MODEL_SOURCE_UNREACHABLE');
    expect(existsSync(join(dir, 'model.bin'))).toBe(false);
  });

  it('bytes that arrive and fail the SHA-256 gate are an INTEGRITY failure, not a network one', async () => {
    // 🔴 THIS CASE FOUND A REAL DEFECT (2026-08-19). The mirror serves corrupt
    // bytes, then the archive fallback 404s, and the ATTEMPT'S LAST failure is
    // the archive's. Reporting that one — which the first implementation did —
    // read `expected 'MODEL_SOURCE_UNREACHABLE' to be 'MODEL_INTEGRITY_MISMATCH'`:
    // a user whose bytes demonstrably ARRIVED being told to check their
    // network. The fix is model-status.ts pickReportableError; this assertion is
    // what holds it.
    const f = await serve({ 'model.bin': Buffer.alloc(body.length, 2) });
    const c = new SherpaModelController(tempDir('bad'), {
      files: [{ path: 'model.bin', size: body.length, sha256: sha(body) }],
      sources: sourcesOf(f),
      tarballUrl: `${f.base}/archive.tar.bz2`,
    });
    await c.start();
    expect(await until(async () => (await c.snapshot()).state === 'failed')).toBe(true);
    expect((await c.snapshot()).error?.code).toBe('MODEL_INTEGRITY_MISMATCH');
  });

  it('pickReportableError orders by which ACTION the code names, not by recency', () => {
    const e = (code: ModelErrorCode): ModelStatusError => ({ code, message: code });
    // Bytes arrived somewhere ⇒ never send the user to check the network.
    expect(pickReportableError([e('MODEL_SOURCE_UNREACHABLE'), e('MODEL_INTEGRITY_MISMATCH')])?.code)
      .toBe('MODEL_INTEGRITY_MISMATCH');
    // A local condition no source can fix outranks everything remote.
    expect(pickReportableError([e('MODEL_INTEGRITY_MISMATCH'), e('MODEL_DISK_FULL')])?.code)
      .toBe('MODEL_DISK_FULL');
    // The unclassified one never displaces an answer we actually have.
    expect(pickReportableError([e('MODEL_DOWNLOAD_FAILED'), e('MODEL_SOURCE_UNREACHABLE')])?.code)
      .toBe('MODEL_SOURCE_UNREACHABLE');
    expect(pickReportableError([])).toBe(null);
  });

  it('a retry after a failure clears the old reason instead of showing it under a new attempt', async () => {
    const good = Buffer.alloc(512, 4);
    const files: ModelFile[] = [{ path: 'model.bin', size: good.length, sha256: sha(good) }];
    const dead = await serve({}, { status: 503 });
    const dir = tempDir('retry');
    const c1 = new SherpaModelController(dir, { files, sources: sourcesOf(dead), tarballUrl: `${dead.base}/a.tar.bz2` });
    await c1.start();
    expect(await until(async () => (await c1.snapshot()).state === 'failed')).toBe(true);

    const alive = await serve({ 'model.bin': good });
    const c2 = new SherpaModelController(dir, { files, sources: sourcesOf(alive) });
    await c2.start();
    expect(await until(async () => (await c2.snapshot()).state === 'ready')).toBe(true);
    expect((await c2.snapshot()).error, 'a ready model must not carry a failure that no longer describes anything').toBe(null);
  });

  it('classifyDownloadError reads the STRUCTURED cause before it reads any message', () => {
    const withCause = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
    expect(classifyDownloadError(withCause('ENOSPC')).code).toBe('MODEL_DISK_FULL');
    expect(classifyDownloadError(withCause('EACCES')).code).toBe('MODEL_WRITE_DENIED');
    expect(classifyDownloadError(withCause('ECONNREFUSED')).code).toBe('MODEL_SOURCE_UNREACHABLE');
    // …and only then the message, which is the fallback and is labelled as one.
    expect(classifyDownloadError(new Error('sha256 mismatch: abcd')).code).toBe('MODEL_INTEGRITY_MISMATCH');
    expect(classifyDownloadError(new Error('HTTP 503')).code).toBe('MODEL_SOURCE_UNREACHABLE');
    // Unclassifiable stays unclassified — never quietly folded into a neighbour.
    expect(classifyDownloadError(new Error('something new')).code).toBe('MODEL_DOWNLOAD_FAILED');
  });
});

// ── §4 rate_bytes_per_sec ────────────────────────────────────────────────────

describe('§4 rate_bytes_per_sec — measured, or null; never invented', () => {
  it('is null until a full 5-second window exists', () => {
    const r = new RateSampler();
    r.observe(0, 1_000);
    r.observe(500_000, 3_000);
    expect(r.rate(), 'two seconds of observation cannot state a five-second rate').toBe(null);
  });

  it('is bytes per second across the window once there is one', () => {
    const r = new RateSampler();
    for (let i = 0; i <= 6; i += 1) r.observe(i * 1_000_000, 1_000 + i * 1_000);
    expect(r.rate()).toBe(1_000_000);
  });

  it('goes back to null when the byte count moves BACKWARDS', () => {
    // A server that ignores Range restarts the .part from zero. Averaging
    // across that discontinuity would report a plausible, invented number.
    const r = new RateSampler();
    for (let i = 0; i <= 6; i += 1) r.observe(i * 1_000_000, 1_000 + i * 1_000);
    r.observe(0, 8_000);
    expect(r.rate()).toBe(null);
  });

  it('the snapshot reports null whenever nothing is downloading', async () => {
    const c = new SherpaModelController(tempDir('rate'), { files: [{ path: 'a', size: 1 }] });
    expect((await c.snapshot()).rate_bytes_per_sec).toBe(null);
  });
});

// ── disk facts ───────────────────────────────────────────────────────────────

describe('readDiskFacts — the cheap half, and it says so', () => {
  it('counts final files at the declared size, and .part bytes as progress only', () => {
    const dir = tempDir('facts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a'), Buffer.alloc(10));
    writeFileSync(join(dir, 'b.part'), Buffer.alloc(3));
    const facts = readDiskFacts(dir, [{ path: 'a', size: 10 }, { path: 'b', size: 20 }]);
    expect(facts).toEqual({ bytes_done: 13, files_done: 1, files_total: 2, files_present: 1, parts_present: 1 });
  });

  it('a wrong-sized final file is present but NOT done', () => {
    const dir = tempDir('facts2');
    writeFileSync(join(dir, 'a'), Buffer.alloc(4));
    const facts = readDiskFacts(dir, [{ path: 'a', size: 10 }]);
    expect(facts.files_present).toBe(1);
    expect(facts.files_done).toBe(0);
  });
});
