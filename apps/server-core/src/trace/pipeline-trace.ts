// PIPELINE TRACE — one correlated record per stage of one utterance.
//
// WHY IT EXISTS. Every log line in the STT/compose path today is a FAILURE line:
// "polish skipped", "refine is ON but the routed engine is streaming-only",
// "compose output rejected". Grep the pipeline for a line that records what it
// actually DID — which terms it resolved, what it put on the vendor's wire, what
// came back — and there is none. So the only way to answer "is my dictionary
// doing anything" was to read the source and reason about it, and reasoning
// about source is exactly what this repo keeps catching itself getting wrong
// (a comment that asserts another file's behaviour is only true until that file
// changes; a measurement is true about the run that produced it).
//
// This module is the positive half: it records what was used, not only what
// failed. One `trace_id` per audio session ties the lines together, so a session
// reads top to bottom as
//
//   session.start   -> which settings were found, what they resolved to
//   terms.resolved  -> the merged terminology and where each term came from
//   hotwords        -> what the recognizer was told, or why it was told nothing
//   stt.final.raw   -> what the engine returned
//   stt.final.pure  -> after dictionary replacement + normalisation
//   polish.request  -> the system prompt, the protected terms, the input
//   polish.response -> the output, the verdict, the cost
//   delivered       -> the bytes the clients actually received
//
// PRIVACY IS THE REASON FOR TWO LEVELS, and it is not decoration. The content of
// these lines is the user's speech.
//   FLOWMIC_TRACE_PIPELINE unset/'0'/'off' -> OFF. Nothing is written. Default.
//   FLOWMIC_TRACE_PIPELINE='meta'          -> shapes only: lengths, sha8 digests,
//                                             counts, engine ids, verdicts. No
//                                             transcript text, no prompt text.
//   FLOWMIC_TRACE_PIPELINE='full'          -> adds the text itself. This RECORDS
//                                             WHAT THE USER SAID to a file on
//                                             disk. It is for a consented
//                                             diagnostic session on a machine
//                                             whose owner asked for it, and it
//                                             must not be switched on for a
//                                             deployment serving other people.
//
// A sha8 is enough to answer the question the meta level is for: "did this stage
// change the text?" Two stages with the same digest did nothing between them,
// and that is the whole comparison — without ever writing a word down.
//
// THE 'full' RECORD IS SPLIT ACROSS ITS TWO READERS, DELIBERATELY. `trace()`
// mirrors every record into the ordinary log (see its own doc comment below)
// so the person already tailing server.log does not have to be told a second
// file exists — but server.log is also what a support bundle grabs whole, and
// log.ts has no level filter or redaction of its own (it exists to survive a
// broken pipe, not to keep a secret). So at 'full' the log mirror carries the
// same `chars`/`sha8`/`count` fields meta level would have shown, and drops the
// `text`/`sample` fields that only 'full' adds — the words themselves land in
// ONE place, pipeline-trace.jsonl, marked by a `trace_text_in` field on the log
// line that says so. Anyone who actually needs the words already knows to go
// read that file; nobody who only wanted "did this change" pays for a leak.
//
// FAILURE POSTURE: this module can never take the session down with it. A broken
// sink disables itself after one complaint, exactly as log.ts learned to
// (an unhandled stdio error once killed the whole server the moment a user
// spoke). A trace line is worth less than the session it would kill.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { log } from '../log';

export type TraceLevel = 'off' | 'meta' | 'full';

/** Cap on one traced string at 'full'. A pasted wall of text is still a wall of
 *  text in a log file; the digest and the length stay exact either way, so the
 *  truncation costs nothing that the comparison needs. */
const MAX_TEXT = 4000;
/** One rollover at 8 MB, one kept generation — same discipline as log.ts. A
 *  diagnostic file that grows without bound is its own incident. */
const MAX_BYTES = 8 * 1024 * 1024;

function readLevel(): TraceLevel {
  const raw = (process.env.FLOWMIC_TRACE_PIPELINE ?? '').trim().toLowerCase();
  if (raw === 'full') return 'full';
  if (raw === 'meta' || raw === '1' || raw === 'true' || raw === 'on') return 'meta';
  return 'off';
}

/** Read at every call rather than cached at import: tests and the drill script
 *  flip the variable between cases in one process, and a cached level would make
 *  the second half of such a run silently untraced. */
export function traceLevel(): TraceLevel {
  return readLevel();
}

export function traceEnabled(): boolean {
  return readLevel() !== 'off';
}

/** Where the JSONL goes. Explicit path wins; otherwise it sits beside the
 *  server log so a support bundle picks both up with one glob. */
function sinkPath(): string {
  const explicit = (process.env.FLOWMIC_TRACE_PATH ?? '').trim();
  if (explicit !== '') return explicit;
  const logPath = (process.env.FLOWMIC_LOG_PATH ?? '').trim();
  if (logPath !== '') return join(dirname(logPath), 'pipeline-trace.jsonl');
  return '';
}

let sinkBroken = false;
let sinkBytes = 0;

function writeLine(text: string): void {
  const target = sinkPath();
  if (target === '' || sinkBroken) return;
  try {
    if (sinkBytes > MAX_BYTES) {
      const prev = `${target}.1`;
      rmSync(prev, { force: true }); // Windows rename refuses an existing target
      renameSync(target, prev);
      sinkBytes = 0;
    }
    if (sinkBytes === 0) {
      mkdirSync(dirname(target), { recursive: true });
      try {
        sinkBytes = statSync(target).size;
      } catch {
        sinkBytes = 0;
      }
    }
    appendFileSync(target, `${text}\n`, 'utf8');
    sinkBytes += text.length + 1;
  } catch {
    // Complain once, then stay quiet: a sink that fails once fails every line.
    sinkBroken = true;
    log.warn('pipeline trace sink is unwritable — tracing to the log only', { path: target });
  }
}

/** What a traced string reduces to. `sha8` is the comparison key; `text` only
 *  exists at 'full'. Both levels carry `chars`, so "the stage lengthened it" is
 *  answerable without the words. */
export interface TracedText {
  chars: number;
  sha8: string;
  text?: string;
}

export function tracedText(s: string): TracedText {
  const sha8 = createHash('sha256').update(s).digest('hex').slice(0, 8);
  const base: TracedText = { chars: s.length, sha8 };
  if (readLevel() !== 'full') return base;
  return { ...base, text: s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…[+${s.length - MAX_TEXT}]` : s };
}

/** A list of user-supplied strings (terms, aliases). Same rule as tracedText:
 *  the COUNT is always available, the values only at 'full'. */
export function tracedList(items: readonly string[]): { count: number; sample?: string[] } {
  if (readLevel() !== 'full') return { count: items.length };
  return { count: items.length, sample: items.slice(0, 50) };
}

/** Correlation id for one audio session / one compose turn. */
export function newTraceId(): string {
  return randomUUID().slice(0, 8);
}

export type TraceStage =
  | 'session.start'
  | 'terms.resolved'
  | 'hotwords'
  | 'stt.final.raw'
  | 'stt.final.pure'
  | 'polish.request'
  | 'polish.response'
  | 'refine.decision'
  | 'delivered'
  | 'compose.scenario'
  | 'compose.request'
  | 'compose.response';

/** Drops the `full`-only content (`text`, `sample`) from a trace record before
 *  it goes to the ordinary log, one level below the top (`system:`, `user:`,
 *  `block:` are the nested shapes every call site above actually uses — see
 *  `tracedText`/`tracedList`'s callers in stt-polish.ts, engine/stt-session.ts,
 *  engine/stt-factory.ts and compose/orchestrator.ts, compose/index.ts).
 *  `chars`/`sha8`/`count` are left in place: that is the whole set 'meta'
 *  already ships, so the log mirror stays exactly as useful at 'full' as it is
 *  at 'meta' — it just never gains the words. */
function redactFullOnlyFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFullOnlyFields);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'text' || key === 'sample') continue; // full-only — stays in the JSONL sink alone
    out[key] = redactFullOnlyFields(v);
  }
  return out;
}

/**
 * Emit one stage record. No-op when tracing is off, and never throws.
 *
 * The record is written to the JSONL sink AND mirrored to the ordinary log at
 * debug-ish level, because the two have different readers: the JSONL is for
 * `jq` and for diffing two runs line by line; the log is for the person already
 * tailing server.log who should not have to be told a second file exists.
 *
 * The log mirror is NOT the same object as the JSONL record once level is
 * 'full': see `redactFullOnlyFields` above and the file header's "two readers"
 * note. `writeLine` still gets the untouched `fields` — this only narrows what
 * reaches `log.info`, which has no redaction of its own (log.ts).
 */
export function trace(stage: TraceStage, traceId: string, fields: Record<string, unknown>): void {
  const level = readLevel();
  if (level === 'off') return;
  try {
    const record = { ts: new Date().toISOString(), trace_id: traceId, stage, ...fields };
    writeLine(JSON.stringify(record));
    const logFields = level === 'full'
      ? { trace_id: traceId, trace_text_in: 'pipeline-trace.jsonl', ...(redactFullOnlyFields(fields) as Record<string, unknown>) }
      : { trace_id: traceId, ...fields };
    log.info(`trace:${stage}`, logFields);
  } catch {
    // A trace line is worth less than the session it would kill.
  }
}
