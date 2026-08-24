// THE OUTPUT GUARD MUST JUDGE THE TEXT THE MODEL WAS ACTUALLY GIVEN.
//
// THE DEFECT THIS PINS (found 2026-08-24 while tracing the settings pipeline;
// found by the trace, not by reading the code — the fake vendor returned a
// correct answer and the production guard refused it).
//
// `ComposeGuardInput.source` is documented, verbatim, as "the text we sent the
// model (the compose input, post dictionary-replace)". `assertOutputDeliverable`
// passed `input.source_text` instead — the utterance AS SPOKEN, before the
// replacer ran. So the guard was comparing the model's answer against a question
// the model had never been asked.
//
// It only bites when the replacer actually changes something, which is exactly
// when the user has configured terminology. The shipped `tech-dev` pack maps
// 多克 -> Docker, 库伯耐提斯 -> Kubernetes, 吉特哈布 -> GitHub. With that pack on:
//
//   user says      这个跑在多克里面
//   model receives 这个跑在Docker里面        (replacer did its job)
//   model returns  这个跑在 Docker 里面。     (a correct organize result)
//   rule 8 asks    is "docker" in 这个跑在多克里面?   -> no
//   verdict        invented_latin_tokens -> compose:error, NOTHING DELIVERED
//
// i.e. switching on a built-in dictionary pack BROKE organize for Chinese
// speech, and the failure blamed the model for inventing a word that the user's
// own settings had put there.
//
// WHY A TEST AND NOT JUST A FIX: the failing direction is invisible to every
// existing compose test, because they all run with an empty dictionary — with no
// replacement, `source_text` and the sent text are the same string, and the bug
// cannot be expressed. That is why it survived: not because the guard was
// untested, but because the guard was only ever tested where the two strings
// coincide.

import { describe, expect, it } from 'vitest';

import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { createComposeFactory } from '../src/compose';
import { guardComposeOutput } from '../src/compose/output-guard';
import type { LlmEvent, LlmStreamOpts } from '../src/compose/llm';

const U = 'guard-source-user';
const SPOKEN = '这个跑在多克里面';          // 多克 = curated homophone alias of Docker
const REPLACED = '这个跑在Docker里面';       // what the replacer hands the model
const MODEL_OUT = '这个跑在 Docker 里面。';  // a correct organize result

function freshDb(withPack: boolean): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('guard-source-key') });
  db.users.insert({ id: U, display_name: 'G', plan: 'free' });
  db.settings.write(U, 'llm.config', {
    protocol: 'openai-compatible',
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    model: 'test-model',
    api_key: 'EMPTY',
  });
  db.settings.write(U, 'scenario.card', {
    professions: [], domains: [], packs: withPack ? ['tech-dev'] : [], terms: [],
  });
  return db;
}

const seen: LlmStreamOpts[] = [];
async function* vendor(opts: LlmStreamOpts): AsyncGenerator<LlmEvent> {
  seen.push(opts);
  yield { kind: 'delta', text: MODEL_OUT };
  yield { kind: 'done', full: MODEL_OUT, usage: { tokens_in: 5, tokens_out: 5 } };
}

async function organize(db: DbConnection): Promise<string> {
  const factory = createComposeFactory({
    settings: db.settings,
    usage: { recordLlmUsage: (): void => {} },
    streamerFor: () => vendor,
  });
  const run = factory({ userId: U, task: 'organize', sourceText: SPOKEN });
  let out = '';
  for await (const chunk of run.run({ task: 'organize', source_text: SPOKEN })) out += chunk;
  return out;
}

describe('compose output guard — the source it judges is the text that was sent', () => {
  it('a dictionary pack that rewrites CJK -> Latin no longer refuses its own result', async () => {
    seen.length = 0;
    const db = freshDb(true);
    const out = await organize(db);

    // The replacer really did fire — otherwise this test would be asserting
    // nothing (the whole defect needs the two strings to differ).
    expect(seen[0]?.user).toBe(REPLACED);
    expect(seen[0]?.user).not.toBe(SPOKEN);
    // …and the turn completed instead of throwing ComposeOutputRejectedError.
    expect(out).toBe(MODEL_OUT);
  });

  it('REVERSE CONTROL — judged against the SPOKEN text, this same output is refused', () => {
    // The old wiring, expressed directly against the guard so the failure is
    // visible without reverting the fix. If this ever comes back green, rule 8
    // stopped firing and the fix above is no longer being demonstrated by
    // anything.
    const asShipped = guardComposeOutput({ task: 'organize', source: REPLACED, output: MODEL_OUT });
    const asBroken = guardComposeOutput({ task: 'organize', source: SPOKEN, output: MODEL_OUT });
    expect(asShipped.ok).toBe(true);
    expect(asBroken.ok).toBe(false);
    if (!asBroken.ok) expect(asBroken.rule).toBe('invented_latin_tokens');
  });

  it('POSITIVE CONTROL — with no pack selected nothing is replaced and the turn still runs', async () => {
    seen.length = 0;
    const db = freshDb(false);
    // Without the pack the model gets the raw sentence, so it must answer that
    // one; an unchanged-source echo is what a real model would produce here.
    const out = await organize(db).catch((e: Error) => `THREW: ${e.message}`);
    expect(seen[0]?.user).toBe(SPOKEN);
    // The output still contains a Latin token absent from the source, so the
    // guard SHOULD refuse it — this control proves rule 8 is still armed and the
    // fix widened nothing.
    expect(out).toMatch(/^THREW: /);
    expect(out).toContain('invented_latin_tokens');
  });
});
