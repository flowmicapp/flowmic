// The built-in speech model, as a thing the SCREEN can talk about.
//
// SPEC-REF: docs/strategy/2026-08-19-local-model-onboarding-design.md
//   §3 (the state machine), §4 (the snapshot contract this narrows),
//   §5-A/§5-D (what the card renders and the copy discipline).
//
// ── WHY A MODULE AND NOT AN `v-if` LADDER ────────────────────────────────────
//
// §2-2 of the design book names the rule this file exists to keep: THREE STATES
// ARE THREE ANSWERS — absent / partial (resumable) / ready — and downloading and
// failed are two more. Folding any pair of them produces the repo's oldest bug
// shape (one value answering two questions), and the two folds that are actually
// tempting here are both wrong in a way the user pays for:
//   · absent ≡ partial ⇒ the resume offer disappears and a user on a slow link
//     re-downloads 228 MB they already have most of;
//   · ready ≡ "the engine will work" ⇒ §3's closing warning: `ready` answers
//     「are the files right」 and NOTHING about whether the recogniser loads
//     (a missing DLL, a wrong architecture). Two questions, two sentences.
//
// ── 🔴 `bytes_total: null` IS A VALUE, NOT A MISSING NUMBER ──────────────────
//
// §4 makes the server send `null` when it does not know the total, and says why:
// 0 renders as `NaN%` or — worse, because it looks finished — `100%`. So the
// narrowing below REFUSES 0 as a total and every arithmetic function here
// returns `null` rather than a number it cannot justify. 「I do not know the
// size」 and 「the size is zero」 are two different sentences and the caller
// renders them differently.
//
// Nothing in this file imports Vue, Tauri or the string catalogue: it is the
// arithmetic and the narrowing, unit-testable with no locale and no DOM. What
// the words are is the component's job (and the catalogue's).

import type { SttEngineId } from '@flowmic/protocol';

/** §3's five states, verbatim. A sixth value on the wire is not a state we can
 *  render, so [asModelSnapshot] refuses the whole snapshot rather than inventing
 *  a face for it — the same stance `asAccessibilityStatus` takes. */
export const MODEL_STATES = ['absent', 'partial', 'downloading', 'ready', 'failed'] as const;
export type ModelState = (typeof MODEL_STATES)[number];

export interface ModelError {
  code: string;
  message: string;
}

/** §4's snapshot. Field names ARE the contract — they are not renamed on the way
 *  in, so a reader can hold this beside the design book and the server's
 *  response and see one set of names. */
export interface ModelSnapshot {
  state: ModelState;
  model_id: string;
  /** Absolute path. The user needs it to place files by hand (§2-5). */
  dir: string;
  bytes_done: number;
  /** 🔴 `null` = the total is UNKNOWN. Never 0 — see the header. */
  bytes_total: number | null;
  files_done: number;
  files_total: number;
  /** Which file is moving right now; `null` when nothing is. */
  current_file: string | null;
  /** `hf` | `hf-mirror` | `github-tarball` | null — which of the three the
   *  downloader is on. §2-4: a user watching a slow link is entitled to see
   *  that it MOVED ON rather than stalled. */
  source: string | null;
  /** 0 = this is not a resumed download. */
  resumed_from_bytes: number;
  /** Server-measured, 5-second sliding window; `null` while it has less than
   *  a window of data. See [stableRate] for what this module does with it. */
  rate_bytes_per_sec: number | null;
  error: ModelError | null;
}

/** The three download sources, named the way a person names them.
 *
 *  🔴 NOT a catalogue key in any language: these are the proper names of three
 *  services, and translating 「GitHub」 would be the same mistake the locale
 *  registry's endonym rule exists to prevent. An id this map does not know is
 *  rendered VERBATIM rather than dropped — a new source added on the server side
 *  must show up as something, and a bare `s3-mirror` is a worse label but a true
 *  one, where silence would read as 「no source」. */
export const MODEL_SOURCE_LABEL: Record<string, string> = {
  hf: 'Hugging Face',
  huggingface: 'Hugging Face',
  'hf-mirror': 'hf-mirror.com',
  'github-tarball': 'GitHub release',
};

export function sourceLabel(source: string | null): string | null {
  if (source === null || source === '') return null;
  return MODEL_SOURCE_LABEL[source] ?? source;
}

/** The engine id the built-in model belongs to.
 *
 *  Typed as `SttEngineId` on purpose: it makes the protocol's union the one
 *  place the spelling lives, so renaming the engine there fails THIS file's
 *  typecheck instead of quietly leaving the notice below permanently silent
 *  (a comparison against a string nobody produces is always false, and nothing
 *  on screen would say so). */
export const BUILTIN_STT_ENGINE_ID: SttEngineId = 'sherpa-local';

/** Is the built-in engine the one this machine would actually use?
 *
 *  §5-B gates the main-window notice on this: telling somebody who routes every
 *  language to FunASR that 「the built-in model is missing」 is true and
 *  irrelevant, and an irrelevant standing notice is how a product teaches people
 *  to ignore notices. ANY routing on the built-in engine counts — a user with
 *  zh-CN on sherpa and en on a cloud vendor will hit the missing model the
 *  moment they speak Chinese. */
export function builtinEngineSelected(routings: readonly { engine_id: string }[]): boolean {
  return routings.some((r) => r.engine_id === BUILTIN_STT_ENGINE_ID);
}

/**
 * §5-B — may the main window put a notice in front of the reader at all?
 *
 * Four inputs and every one of them can veto, which is why this is a named
 * function and not four `&&`s inside a template:
 *
 *   · `builtinSelected` — see [builtinEngineSelected]. A standing notice about
 *     an engine this machine does not use is how a product teaches people to
 *     ignore notices.
 *   · `state === null` — WE DO NOT KNOW (no local service answered). It renders
 *     NOTHING, deliberately: 「不知道」 and 「没有」 must never share a face, and
 *     this one has a call to action under it. Same rule, same reason as
 *     `needsAccessibilityGrant`'s null arm.
 *   · `state === 'ready'` — nothing to say.
 *   · `dismissed` — 「本次不提醒」. THIS is the one difference from the
 *     Accessibility banner next door, and it is deliberate rather than
 *     inconsistent: that one is a state-style notice with no dismiss button
 *     because 「提示生命周期匹配事实生命周期」 and its fact leaves on its own.
 *     This fact does NOT leave on its own — it leaves when the user decides to
 *     spend 228 MB — so an undismissable version would be a modal with extra
 *     steps, and §5-B says in as many words: 不是模态, 不许挡住产品.
 *
 * ⚠️ `downloading` is deliberately INCLUDED. §5-B's condition is 「模型非
 * ready」, and while bytes are moving the sentence 「it is not ready」 is still
 * true and its one action — go and look at the progress — is still the right
 * one. A reader who does not want it has the dismissal.
 */
export function shouldOfferModelSetup(input: {
  builtinSelected: boolean;
  state: ModelState | null;
  dismissed: boolean;
}): boolean {
  if (!input.builtinSelected) return false;
  if (input.state === null || input.state === 'ready') return false;
  return !input.dismissed;
}

// ── narrowing ────────────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asError(v: unknown): ModelError | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const code = str(o.code);
  const message = str(o.message);
  if (code === '' && message === '') return null;
  return { code, message };
}

/** Field-by-field narrowing of the §4 body.
 *
 *  🔴 CLAUDE.md 反 façade ⑤ — a hand-written predicate is an assertion the
 *  compiler never checks, and this repo has already shipped one that was wrong
 *  in a way nothing could see (`asPairingInfo`'s `lan_candidates` filter, which
 *  made a real feature render empty on every machine for weeks). So: `null` on
 *  any shape this does not recognise, and `null` is a RENDERED outcome upstairs,
 *  never a silent healthy default.
 *
 *  🔴 `bytes_total` is the field this function exists for. A non-positive or
 *  absent total becomes `null`, which is the honest 「unknown」 — and the `> 0`
 *  half is the one that matters: a literal 0 arriving from a server that meant
 *  「I don't know」 is exactly the value §4 forbids, because `done/0` renders as
 *  `NaN%` and `0/0` clamps to a triumphant `100%`. */
export function asModelSnapshot(v: unknown): ModelSnapshot | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const state = MODEL_STATES.find((s) => s === o.state);
  if (state === undefined) return null;
  const total = o.bytes_total;
  return {
    state,
    model_id: str(o.model_id),
    dir: str(o.dir),
    bytes_done: num(o.bytes_done, 0),
    bytes_total: typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null,
    files_done: num(o.files_done, 0),
    files_total: num(o.files_total, 0),
    current_file: nonEmpty(o.current_file),
    source: nonEmpty(o.source),
    resumed_from_bytes: num(o.resumed_from_bytes, 0),
    rate_bytes_per_sec:
      typeof o.rate_bytes_per_sec === 'number' &&
      Number.isFinite(o.rate_bytes_per_sec) &&
      o.rate_bytes_per_sec > 0
        ? o.rate_bytes_per_sec
        : null,
    error: asError(o.error),
  };
}

// ── quantities (§2-4: progress is a quantity, not a spinner) ─────────────────

const MIB = 1024 * 1024;
const KIB = 1024;

/**
 * Bytes → 「228.5 MB」.
 *
 * ⚠️ THE DIVISOR IS 1024², AND THE UNIT IS SPELLED `MB`. That mismatch is
 * deliberate and it is the lesser of two wrongs: the model is 239,549,735 bytes,
 * which is 228.5 by this arithmetic and 239.5 by the decimal one, and the figure
 * every other tool the user can check against — Windows Explorer's size column,
 * `du -sh` (the design book's own 229 M measurement) — is the first. A button
 * that says 240 MB beside a folder that says 228 MB reads as a different file.
 *
 * ONE DECIMAL, always, and that is a movement decision rather than a precision
 * one: on a 20 KB/s link a whole-MB readout does not change for fifty seconds,
 * which is the exact 「is it stuck?」 the owner asked us to stop causing.
 */
export function formatMb(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MB`;
}

/** Bytes → 「228 MB」. The button and the one-line 「about this much」 use this:
 *  a decimal after the word 「about」 is noise, and the size of the download is
 *  not being measured, it is being previewed. */
export function formatMbCoarse(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`;
}

/** Bytes/second → 「1.2 MB/s」 / 「820 KB/s」 / 「640 B/s」. Small links get the
 *  small unit so the number is a number rather than a row of zeros. */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= MIB) return `${(bytesPerSec / MIB).toFixed(1)} MB/s`;
  if (bytesPerSec >= KIB) return `${Math.round(bytesPerSec / KIB)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** Done ÷ total as a whole percent, or `null` when the total is unknown.
 *
 *  FLOOR, not round: 99.6 % must render as 99 %, because a bar that says 100 %
 *  while bytes are still moving is the same lie as a 「delivered」 that has not
 *  been delivered. Clamped at 100 for the case where a server counts a resumed
 *  prefix twice — the clamp is a defence, not a licence, and the caller still
 *  gets the honest state word beside it. */
export function percentDone(done: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}

// ── the rate, and the promise we are allowed to make from it ────────────────

/** How many consecutive readings before we will name a time. */
export const RATE_SAMPLES_NEEDED = 3;
/** How far apart the kept readings may be and still count as 「a rate」.
 *  A factor of two: 500 KB/s and 900 KB/s describe the same link, 100 KB/s and
 *  2 MB/s do not, and an ETA computed across the second pair is a number we
 *  would have to take back within seconds. */
export const RATE_SPREAD_MAX = 2;

/**
 * The measured rate, or `null` when we do not have one we would stand behind.
 *
 * 🔴 §2-6 IS THE WHOLE POINT: 「不许对下载时间撒谎 …除非它是按实测速率算的」. The
 * server already refuses to guess — `rate_bytes_per_sec` is null until it has a
 * full 5-second window — and this adds the second half the server cannot do,
 * because it only ever sees one window at a time: a single 5 s window on a link
 * that just switched sources can be off by an order of magnitude, and an ETA
 * built on it would swing from 「2 min」 to 「40 min」 between two polls. A user
 * watching that learns the number means nothing.
 *
 * So: at least [RATE_SAMPLES_NEEDED] readings, spread no wider than
 * [RATE_SPREAD_MAX], and the MEDIAN of them (a single spike moves a mean and
 * cannot move a median). Anything less is 「estimating」 on screen — a word that
 * promises nothing and is true.
 */
export function stableRate(samples: readonly number[]): number | null {
  const kept = samples.filter((s) => Number.isFinite(s) && s > 0);
  if (kept.length < RATE_SAMPLES_NEEDED) return null;
  const recent = kept.slice(-RATE_SAMPLES_NEEDED);
  const lo = Math.min(...recent);
  const hi = Math.max(...recent);
  if (lo <= 0 || hi / lo > RATE_SPREAD_MAX) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Push a reading, keeping only what [stableRate] can use. Returns a NEW array
 *  (the store assigns it) — a mutated-in-place array would not be seen by Vue's
 *  reactivity on a plain field. */
export function pushRateSample(samples: readonly number[], rate: number | null): number[] {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return [...samples];
  return [...samples, rate].slice(-RATE_SAMPLES_NEEDED);
}

/** Why we are not showing a time. Three different reasons, three different
 *  sentences upstairs — 「we don't know the size」 is permanent for this
 *  download and 「still measuring」 is not, and telling a user to wait for a
 *  number that can never arrive is its own small lie. */
export type EtaVerdict =
  | { kind: 'seconds'; seconds: number }
  | { kind: 'estimating' }
  | { kind: 'no-total' };

/** Seconds remaining, computed from a rate we measured — or the reason we will
 *  not say. Never an optimistic guess, never a countdown that stalls. */
export function etaFrom(
  bytesDone: number,
  bytesTotal: number | null,
  samples: readonly number[],
): EtaVerdict {
  if (bytesTotal === null) return { kind: 'no-total' };
  const rate = stableRate(samples);
  if (rate === null) return { kind: 'estimating' };
  const remaining = Math.max(0, bytesTotal - bytesDone);
  return { kind: 'seconds', seconds: remaining / rate };
}

/** Above this many minutes the card stops naming a figure and says 「more than
 *  an hour」. 90 rather than 60: rounding 61 minutes down to 「an hour」 is a
 *  worse answer than saying the figure, and past an hour and a half the minute
 *  count is precision nobody can use. */
export const ETA_MINUTES_MAX = 90;
/** Below this the card says 「less than a minute」 — a 40-second countdown that
 *  re-renders every second is a stopwatch, and nobody asked for a stopwatch. */
export const ETA_SECONDS_MIN = 60;
