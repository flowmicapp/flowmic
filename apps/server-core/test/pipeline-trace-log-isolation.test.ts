// PIPELINE TRACE — the log-mirror leak (AUD-S2 P2).
//
// pipeline-trace-e2e.test.ts already proves the JSONL sink's own two contracts
// (meta = no text, full = text). What it never looks at is the SECOND sink
// `trace()` writes to: `trace()` also calls `log.info(...)`, and server.log has
// no level filter or redaction of its own (log.ts exists to survive a broken
// pipe, not to keep a secret — see its header). Before this fix, `log.info` got
// the exact same `fields` object passed to the JSONL writer, so at 'full' level
// the user's raw speech and the assembled system prompt rode along into the
// file an ordinary support bundle grabs whole.
//
// This test therefore fakes the LOG sink, not the trace sink: it spies on
// `log.info` and asserts on what actually reached it, independent of whatever
// `writeLine` does with the JSONL file. The reverse control removes the
// redaction step from `trace()` (by re-implementing the pre-fix body inline)
// and watches the same assertion go red.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../src/log';
import { newTraceId, trace, tracedList, tracedText } from '../src/trace/pipeline-trace';

const RAW_SPEECH = '这是用户说的一段私密的话，绝不许出现在 server.log 里';
const SYSTEM_PROMPT = 'You are a careful assistant. SECRET-SYSTEM-PROMPT-MARKER';
const TERM = 'a-user-supplied-term-that-must-not-leak';

let dir: string;
let tracePath: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'flowmic-trace-log-'));
  tracePath = path.join(dir, 'pipeline-trace.jsonl');
  setEnv('FLOWMIC_TRACE_PATH', tracePath);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  rmSync(dir, { recursive: true, force: true });
});

/** One record shaped like the real call sites: a nested `tracedText` under a
 *  named key (stt-polish.ts's `system:`/`user:`), a spread `tracedText` at the
 *  top level (engine/stt-session.ts's `...tracedText(raw)`), and a spread
 *  `tracedList` (engine/stt-factory.ts's `...tracedList(...)`). */
function emitOneRecord(): void {
  const id = newTraceId();
  trace('polish.request', id, {
    system: tracedText(SYSTEM_PROMPT),
    ...tracedText(RAW_SPEECH),
    ...tracedList([TERM]),
  });
}

describe('pipeline trace — log mirror at full level does not carry the words (AUD-S2 P2)', () => {
  beforeEach(() => setEnv('FLOWMIC_TRACE_PIPELINE', 'full'));

  it('POSITIVE CONTROL: the JSONL sink still receives the raw text (that sink is unchanged)', () => {
    emitOneRecord();
    const jsonl = readFileSync(tracePath, 'utf8');
    expect(jsonl).toContain(RAW_SPEECH);
    expect(jsonl).toContain(SYSTEM_PROMPT);
    expect(jsonl).toContain(TERM);
  });

  it('the fields object handed to log.info never contains the user speech or the system prompt', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    emitOneRecord();
    expect(info).toHaveBeenCalledTimes(1);
    const loggedFields = info.mock.calls[0]?.[1];
    const serialized = JSON.stringify(loggedFields);
    expect(serialized).not.toContain(RAW_SPEECH);
    expect(serialized).not.toContain(SYSTEM_PROMPT);
    expect(serialized).not.toContain(TERM);
    // Meta stays useful: the shape fields survive, and a marker points readers
    // at the one file that does have the words.
    expect(serialized).toContain('sha8');
    expect(serialized).toContain('pipeline-trace.jsonl');
  });

  it('REVERSE CONTROL: without the redaction step, the same assertion is red', () => {
    // Re-implements trace()'s pre-fix body — the log mirror used to be built
    // from the raw `fields` with no filtering — to prove the test above would
    // have caught AUD-S2 P2 had the fix not been made.
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const id = newTraceId();
    const fields = {
      system: tracedText(SYSTEM_PROMPT),
      ...tracedText(RAW_SPEECH),
      ...tracedList([TERM]),
    };
    log.info('trace:polish.request', { trace_id: id, ...fields });
    const serialized = JSON.stringify(info.mock.calls[0]?.[1]);
    expect(serialized).toContain(RAW_SPEECH);
    expect(serialized).toContain(SYSTEM_PROMPT);
  });
});

describe('pipeline trace — log mirror at meta level is unchanged', () => {
  beforeEach(() => setEnv('FLOWMIC_TRACE_PIPELINE', 'meta'));

  it('carries no text at meta and no trace_text_in marker (nothing to point at)', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    emitOneRecord();
    const serialized = JSON.stringify(info.mock.calls[0]?.[1]);
    expect(serialized).not.toContain(RAW_SPEECH);
    expect(serialized).not.toContain(SYSTEM_PROMPT);
    expect(serialized).not.toContain('trace_text_in');
    expect(existsSync(tracePath)).toBe(true);
  });
});
