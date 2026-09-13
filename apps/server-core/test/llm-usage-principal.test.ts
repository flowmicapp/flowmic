// card MP-9 — the AI turn's `usage_events` row must name the SAME payer and
// speaker as the recording that produced its text (owner ruling §11,
// docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md).
//
// SPEC-REF:
//   apps/server-core/src/billing/usage-tracker.ts (`recordLlmUsage`'s `principal`)
//   apps/server-core/src/socket/handlers/audio-metering.ts (`principalRefOf` — the ONE reader)
//   apps/server-core/test/usage-events.test.ts (the STT half of the same argument, card MP-6)
//   verify/golden/g30-payer-matrix.mjs §6b (the same assertion end to end)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// ⚠️ A FILE OF ITS OWN because `usage-events.test.ts` stands at the 1200-line
// test cap (verify/lint `file-size`). No assertion was weakened to fit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import type { LlmConfig } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker, type UsageTracker } from '../src/billing/usage-tracker';
import { currentMonth } from '../src/db/repos/usage.repo';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers } from '../src/socket/handlers/audio.handler';
import { registerComposeHandlers, type ComposeHandlerDeps } from '../src/socket/handlers/compose.handler';
import { createComposeRun } from '../src/compose';
import type { LlmEvent, LlmStreamer } from '../src/compose';

const USER = 'u-mp9';
const NOW = Date.parse('2026-09-11T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
/** The two character counts the STT metering seam carries. DIFFERENT on purpose,
 *  for the reason usage-events.test.ts gives: equal ones let a wiring that
 *  forwards one twice pass. */
const CHARS = { transcript: 41, delivered: 38 } as const;
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };
/** card MP-9 — the AI turn's fixtures. The endpoint is unreachable on purpose:
 *  the streamer is injected below, so a stray real fetch fails loudly instead of
 *  reaching the network. */
const MP9_CFG: LlmConfig = {
  protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1', model: 'mp9', api_key: 'k',
};
/** A translation that really is in the target script — the output guard rejects
 *  an echo of the English source (`target_script_absent`), and a rejected turn is
 *  a different path with its own test file (compose-usage-on-rejection.test.ts). */
const MP9_OUTPUT = '季度报告周五上午到期。';

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

/** guard + tracker wired the way bootstrap wires them, over `db` — the same
 *  helper `usage-events.test.ts` uses, with the event log switched ON (it is OFF
 *  in production; the switch gates COLLECTION, not these columns). */
function realWiring(db: DbConnection): { guard: ReturnType<typeof makeQuotaGuard>; usageTracker: UsageTracker } {
  const billing = new BillingService({
    settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => NOW,
  });
  return {
    guard: makeQuotaGuard(
      db.usage,
      { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH },
      { mode: 'saas', now: () => NOW },
    ),
    usageTracker: makeUsageTracker(db.usage, {
      mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH,
      usageEventsEnabled: true, events: db.usageEvents,
    }),
  };
}

describe('card MP-9 — one session, one payer, on both metered legs', () => {
  let db: DbConnection;
  beforeEach(() => {
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('mp9-usage-principal-32-bytes!!') });
    db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
  });
  afterEach(() => db.close());

  it('🔴 card MP-9 — the llm row of a session names the SAME payer and speaker as its stt row', async () => {
    // 🔴 THIS IS THE ASSERTION THE CARD EXISTS FOR, and like the character
    // counts above it is taken at the HANDLERS rather than at the tracker.
    // Production on 2026-09-11 (NY relay, one cloud-chain run) held exactly the
    // shape this refuses: an `stt` row with `payer_reason='self'` and a
    // `speaker_ref`, beside an `llm` row from the same session with NULL in
    // both. Card MP-6 stamped one leg; `recordLlmUsage` kept a signature nobody
    // had to revisit, so the AI turn's tokens landed in the one table an
    // operator aggregates with nothing saying who they were for.
    //
    // ONE socket drives BOTH legs, which is the whole point: the two rows must
    // agree because they are two facts about one admission, not because two
    // layers each worked the answer out and happened to agree.
    const mobile = new FakeSocket('m');
    mobile.data.auth = {
      kind: 'mobile',
      userId: USER,
      // 🔴 DELIBERATELY NOT 'self', and deliberately a BROWSER uid rather than
      // `USER`. A wiring that manufactured a principal out of the acting account
      // — the exact inference `refused_user_id` was added to stop — would pass
      // any fixture where the payer, the speaker and the account are one string.
      payerReason: 'peer',
      speakerRef: 'wb-a1b2c3d4',
    };
    const { guard, usageTracker } = realWiring(db);
    const store = new RoomStore<FakeSocket>();
    const io = {} as unknown as import('socket.io').Server;

    // ── the STT leg, through the same seam the character-count test uses ──
    let seam: ((d: number, byok: boolean, chars: { transcript: number; delivered: number }) => void) | null = null;
    registerAudioHandlers(mobile as unknown as Socket, {
      io,
      guard,
      usageTracker,
      store: store as unknown as RoomStore<Socket>,
      sttFactory: (args) => {
        seam = args.onComplete;
        return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} };
      },
    });
    mobile.fire('audio:start', AUDIO_START, () => {});
    expect(seam, 'the handler never built a session — the wiring, not the principal, is broken').not.toBeNull();
    seam!(60_000, false, CHARS);

    // ── the AI turn on the SAME socket, through the production handler ──
    // A streamer that answers and reports what the vendor billed. The Chinese
    // output is what keeps the output guard out of this test's way (see
    // compose-usage-on-rejection.test.ts, which owns the rejected path).
    const streamer = (async function* (): AsyncGenerator<LlmEvent> {
      yield { kind: 'delta', text: MP9_OUTPUT };
      yield { kind: 'done', full: MP9_OUTPUT, usage: { tokens_in: 37, tokens_out: 41 } };
    }) as unknown as LlmStreamer;
    const composeDeps: ComposeHandlerDeps = {
      io,
      guard,
      usageTracker,
      store: store as unknown as RoomStore<Socket>,
      composeFactory: () => createComposeRun(MP9_CFG, 'sys', false, { streamerFor: () => streamer }),
    };
    registerComposeHandlers(mobile as unknown as Socket, composeDeps);
    mobile.fire('compose:start', {
      request_id: 'req-mp9', entry_id: 'entry-mp9',
      task: 'translate', source_text: 'The quarterly report is due on Friday morning.',
      source_lang: 'en', target_lang: 'zh-CN',
    });
    // The run is an async generator; drain the microtask queue until the handler
    // has emitted its terminal frame.
    for (let i = 0; i < 200 && !mobile.emitted.some((e) => e.event === 'compose:done'); i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // Positive control: a turn that never reached the vendor bills nothing, so
    // without this the equality below could be two absent rows agreeing.
    expect(
      mobile.emitted.filter((e) => e.event === 'compose:done'),
      `the compose turn never finished (${JSON.stringify(mobile.emitted.map((e) => e.event))}) — nothing was billed, so the row equality below would be vacuous`,
    ).toHaveLength(1);

    expect(db.raw.prepare('SELECT kind FROM usage_events ORDER BY kind').all()).toEqual([{ kind: 'llm' }, { kind: 'stt' }]);
    // The two columns are read through raw SQL because `listForUser`'s row shape
    // deliberately does not project them (usage-events.repo.ts) — the same route
    // the MP-6 assertions above take.
    const stamped = db.raw.prepare(
      "SELECT kind, payer_reason, speaker_ref FROM usage_events WHERE outcome='ok' ORDER BY id",
    ).all() as { kind: string; payer_reason: string | null; speaker_ref: string | null }[];
    const stt = stamped.find((r) => r.kind === 'stt');
    const llm = stamped.find((r) => r.kind === 'llm');
    // 🔴 EQUAL, AND NOT NULL. Equality alone is satisfied by two NULLs, which is
    // precisely the production state this card closes.
    expect({ payer_reason: llm?.payer_reason, speaker_ref: llm?.speaker_ref })
      .toEqual({ payer_reason: 'peer', speaker_ref: 'wb-a1b2c3d4' });
    expect({ payer_reason: llm?.payer_reason, speaker_ref: llm?.speaker_ref })
      .toEqual({ payer_reason: stt?.payer_reason, speaker_ref: stt?.speaker_ref });
  });
});
