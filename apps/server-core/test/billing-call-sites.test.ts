// The billing-callsites invariant, asserted instead of remembered.
//
// mock-billing §5 fixed the shape: usage is recorded at a KNOWN, SMALL number of
// places, so double-counting is impossible by construction rather than by care.
// The doc said 「recordSttUsage and recordLlmUsage exactly 1 each」.
//
// v0.2.3 moves recordLlmUsage to TWO — deliberately, and this file is the reason
// that is safe to do. 0.1.0 scoped the polish LLM out of billing, which meant the
// console's LLM meter could only ever read 0 while polish ran on every single
// utterance (owner 2026-07-29: 「LLM tokens 0 / 250000」). A meter that cannot
// move is not conservative, it is false — the same 「façade」 category this repo
// already hunts for capabilities nobody calls.
//
// 0.3.0 card M6 moves it to THREE, for the same reason a third time: the
// scenario-inference round trip (compose/scenario-infer-call.ts, 8 s budget) ran
// on the resolved LLM config — the PLATFORM's key under the managed default —
// with no meter at all. It is an OFF-BAND call: it is not the compose turn and it
// is not the polish pass, so metering it cannot double-count either of them.
//
// Three is now the number of things that actually call an LLM:
//   · compose:start — the AI action row (translate / organize / draft_polish)
//   · the polish pass on a terminal final
//   · the off-band scenario-inference call (M6)
//
// Counted over SOURCE, not behaviour, on purpose: a fourth site added by someone
// who did not read the design would pass every functional test in the repo and
// silently double-count a user's tokens. Only a census catches that.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Files that CALL `fn(` — the definition and the interface declaration in
 *  usage-tracker.ts are not call sites and are excluded by name. */
function callSites(fn: string): string[] {
  return walk(SRC)
    .filter((f) => !f.endsWith(join('billing', 'usage-tracker.ts')))
    // 2026-08-29 multi-node — node/forwarded-write.ts REPLAYS a call that was
    // already originated somewhere in this census, on a different machine. It
    // decides nothing: it validates a record a replica forwarded and re-performs
    // the same seam call with the same arguments. Counting it as an originating
    // site would be counting one user's minutes twice in a file whose whole job
    // is to stop exactly that. It gets its own assertion below instead, so a
    // SECOND replay site is still a deliberate act rather than a silent one.
    .filter((f) => !f.endsWith(join('node', 'forwarded-write.ts')))
    .filter((f) => {
      const body = readFileSync(f, 'utf8');
      // Strip line comments so the many PROSE mentions of these names (this
      // repo comments heavily, and half those comments name the seam) cannot be
      // mistaken for calls.
      const code = body.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      return new RegExp(`\\.${fn}\\s*\\(`).test(code);
    })
    .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
}

describe('billing call sites — a census, not a convention', () => {
  it('recordSttUsage is called from EXACTLY ONE place', () => {
    expect(callSites('recordSttUsage')).toEqual(['socket/handlers/audio.handler.ts']);
  });

  it('recordLlmUsage is called from EXACTLY the three LLM paths', () => {
    // compose:start (the AI action row), the polish pass, and — M6 — the off-band
    // scenario-inference call, whose meter is injected at the compose subsystem's
    // composition root because the call is scheduled off-band and never passes
    // back through the handler. Adding a fourth requires changing this line, which
    // is the point: the number is a decision, not an accident.
    expect(callSites('recordLlmUsage').sort()).toEqual([
      'compose/index.ts',
      'socket/handlers/audio.handler.ts',
      'socket/handlers/compose.handler.ts',
    ]);
  });

  it('ensureQuota is called from EXACTLY the three admission points', () => {
    // The same discipline on the other side of the meter: quota is checked before
    // STT, before an LLM turn, and — M6 — once per audio session before the polish
    // LLM is armed (engine/stt-factory.ts). The third one is a VALVE, not a gate:
    // the llm_tokens ceiling is ~30-40x what the tier's minutes can physically
    // produce, so hitting it means runaway, and the response is 「this session gets
    // no polish」 with a loud forensic line — never 「the recording fails」.
    const sites = callSites('ensureQuota').sort();
    expect(sites).toEqual([
      'engine/stt-factory.ts',
      'socket/handlers/audio.handler.ts',
      'socket/handlers/compose.handler.ts',
    ]);
  });

  it('🔴 the ONE replay site is node/forwarded-write.ts, and nothing else', () => {
    // The multi-node exception, asserted rather than trusted. A replica cannot
    // write to the shared database, so its metering travels to the writer as a
    // record and the writer replays the seam. That replay is excluded from the
    // census above — which means the exclusion itself needs a guard, or a second
    // file could quietly acquire the same licence to bill.
    //
    // Note this uses the UNFILTERED walk: it is asking 「which files replay」, the
    // opposite question from the census, and answering it with the census's own
    // filter would be a tautology.
    const replaySites = walk(SRC)
      .filter((f) => {
        const code = readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
        return /applyForwardedWrite/.test(code) && /\.recordSttUsage\s*\(/.test(code);
      })
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    expect(replaySites).toEqual(['node/forwarded-write.ts']);
  });

  it('the census can actually fail (it is not matching nothing)', () => {
    // Without this, a regex that quietly stopped matching would make every
    // assertion above pass by returning [] — the failure mode a census has.
    expect(callSites('recordSttUsage').length).toBeGreaterThan(0);
    expect(callSites('recordLlmUsage').length).toBeGreaterThan(0);
    expect(callSites('thisSeamDoesNotExist')).toEqual([]);
  });
});
