// SPEC-REF:
//   docs/strategy/2026-07-23-mock-billing-design.md §3 (metering call sites: recordSttUsage
//     is the sole STT-session-finalization entry point / recordLlmUsage is the sole
//     compose-finalization entry point; is_byok=true
//     NOOP; standalone NOOP; month-bucket UPSERT), §5 (the each-exactly-one discipline)
//   docs/rebuild/05-DATA-MODEL.md §1 (usage_records)
//   docs/strategy/2026-08-12-req1208-usage-log-storage-audit-and-design.md
//     §5.3 (write points + the two hard constraints), §5.6 (failure directions)
//   src/db/schema.ts `-- 14. usage_events` (the DDL argues every column)
//   Ported metering mechanism from legacy billing/usage-tracker.ts.
//   *** HUMAN-AUDIT SENSITIVE (billing) ***
//
// The billing-callsites each-exactly-one discipline (mock-billing §5): recordSttUsage and
// recordLlmUsage are each called from EXACTLY ONE production site (the audio /
// compose session finalizers). Those finalizers are R1-3/R1-4 territory; the
// tracker + its single call sites are placed now (fail-loud engine stubs never
// reach the finalizer, so nothing double-counts). Metering is a NOOP in
// standalone and for BYOK (is_byok=true), enforced at the top of every entry.
//
// ── A2-5 / REQ-12-08 (2026-08-12): THIS MODULE NOW WRITES TWO THINGS ────────
//
// ① `usage_records` — the month bucket. UNCHANGED, byte for byte: same three
//    early returns, same UPSERT, same numbers. It is the quota's single source
//    of truth (billing/quota-guard.ts) and nothing below may move it.
// ② `usage_events` — one row per metered event. NEW, additive, and behind a
//    switch that DEFAULTS OFF.
//
// 🔴 ORDER IS LOAD-BEARING AND IT IS INCREMENT-THEN-APPEND. The event append
// runs AFTER `repo.increment` and inside a try/catch that only logs. Two
// reasons, both concrete:
//   · `recordSttUsage` is reached from `SttSessionBridge.settle()`, and THREE of
//     its six production paths come from a bare `setTimeout` or the shutdown
//     loop (engine/stt-session.ts, symbol `dispose`) — an uncaught throw there
//     is FATAL to the relay process. Unbillable AUDIT must never be able to do
//     what unbillable AUDIO is already forbidden from doing;
//   · putting the append first would let a broken log table stop the METER,
//     i.e. an optional record would be able to make the mandatory one wrong.
//     The chosen direction degrades to "the month bucket stays accurate, the detail log is short one row" (design §5.6).
//   ⇒ The reverse control for this is a repo whose `append` throws: the month
//     bucket must still be exact. `test/usage-events.test.ts` runs it.
//
// 🔴 THE SWITCH. Nothing is written unless `config.usageEventsEnabled` is true,
// and it is false unless an operator set `FLOWMIC_USAGE_EVENTS_ENABLED=1`
// (config.ts carries the argument: the privacy policy owes 30 days notice
// before this granularity begins, and a row that exists cannot be un-collected
// by a later ruling). Same shape as `FLOWMIC_MANAGED_STT_ENABLED`.
// Its state is ANNOUNCED at construction, once, either way — a switch nobody
// can observe is worse than no switch.

import type { ServerMode } from '@flowmic/protocol';
import { currentMonth, type UsageRepo } from '../db/repos/usage.repo';
import type { UsageChannel, UsageEventKind, UsageEventsRepo } from '../db/repos/usage-events.repo';
import type { SttCharCounts } from '../engine/stt-session-deps';
import { log } from '../log';

export interface EngineUsageMeta {
  is_byok: boolean;
}

/**
 * 🔴 THE ONE-LINE BYOK TOGGLE — flip this constant, nothing else.
 *
 * `true`  (today) — a session on the USER'S OWN key gets a `usage_events` row
 *                   with `is_byok = 1`, and is still billed NOTHING.
 * `false`         — own-key sessions leave no trace anywhere, exactly as before
 *                   this card.
 *
 * WHY IT IS A NAMED CONSTANT AND NOT JUST CODE: owner has an OPEN question on
 * it (approval packet D2), and the terms of service currently say own-key
 * engines are "never metered" — a sentence an ordinary reader hears as "not
 * recorded". So the behaviour has to be reversible by one edit that a
 * non-author can find, rather than by re-deriving which `if` to put back.
 *
 * WHY RECORDING IS THE DEFAULT: the early return it replaces answered two
 * questions with one statement — "don't charge for this" AND "don't remember
 * it". The first is a billing rule; the second makes a user's own usage page
 * show a blank that is indistinguishable from "I wasn't talking back then" (design §5.3-③).
 *
 * ⚠️ Typed `boolean`, not inferred as the literal `true`, so flipping it does
 * not turn the branch below into code TypeScript has already narrowed away.
 */
export const RECORD_BYOK_EVENTS: boolean = true;

export interface UsageTracker {
  /**
   * The ONE STT metering call (mock-billing §5: exactly one production site).
   *
   * 🔴 A2-5 — `chars` is REQUIRED, and requiring it is the point. Making it
   * optional would let the single call site keep passing two arguments and let
   * the two columns sit at NULL forever, with every test green and the feature
   * absent — "a capability is defined but nobody calls it", this repo's number-one historical bug class.
   * The reverse control is behavioural rather than compile-time (see
   * [[SttSessionDeps.onComplete]] for why TypeScript cannot enforce the callback
   * side): drop the counts at the seam and `test/usage-events.test.ts`'s
   * "the row carries the two REAL character counts" goes red.
   */
  recordSttUsage(user_id: string, engine: EngineUsageMeta, duration_ms: number, chars: SttCharCounts): void;
  recordLlmUsage(user_id: string, engine: EngineUsageMeta, tokens_in: number, tokens_out: number): void;
  /**
   * A2-5 — "this attempt was blocked by the quota".
   *
   * NOT a metering call: it moves no counter and touches `usage_records` not at
   * all. It exists because a quota refusal was, until this card, completely
   * unobservable — `ensureQuota` throws and writes nothing (billing/quota-guard.ts),
   * and on the STT leg the phone never even reads the ack, so BOTH ends were
   * silent about a user being turned away (design §2.3-⑤).
   *
   * The row it writes has every count at 0 and `outcome:'quota_refused'`, which
   * is exactly why `outcome` is a column of its own: "zero minutes" and "blocked"
   * must be two statements.
   */
  recordQuotaRefusal(user_id: string, kind: UsageEventKind): void;
}

export interface UsageTrackerConfig {
  mode: ServerMode;
  now?: () => number;
  /**
   * A2-5 — may a `usage_events` row be written at all. Defaults to FALSE when
   * absent, which is the same answer an unset env var gives, so a harness that
   * does not mention it collects nothing.
   */
  usageEventsEnabled?: boolean;
  /**
   * A2-5 — the event sink, sliced to `append` so the meter cannot read or purge
   * the log it writes.
   *
   * Optional ONLY because "collection is off" is a real state in which no sink
   * is needed. It is NOT a friendly default (book 13 §7 F1 ②): enabling collection
   * without a sink THROWS at construction — see the guard below — so the
   * mis-wiring fails at boot rather than producing a server that answers
   * "it's on" and records nothing.
   */
  events?: Pick<UsageEventsRepo, 'append'>;
}

/** The one string an operator greps for to find out which state a machine is
 *  in. Exported so the test that proves the announcement happens cannot drift
 *  from the line that makes it. */
export const USAGE_EVENTS_SWITCH_LOG = 'usage events: per-event usage log';

/**
 * 🔴 C5 (owner ruling, 2026-08-12) — the ONLY value this table's `channel`
 * column is ever written with.
 *
 * Owner closed the two open questions in one sentence
 * (docs/decisions/2026-08-12-owner-c5-usage-channel-is-cloud-relay.md):
 *   ① "channel" means the DELIVERY channel (LAN vs cloud relay), not an
 *      engine-pool line — reading (a);
 *   ② the DETAIL table records only what went through the cloud relay.
 *
 * ── WHY THIS IS A MEASUREMENT AND NOT THE GUESS THE OLD CODE REFUSED TO MAKE ─
 * Until this ruling `channel` was deliberately left NULL, and the comment at the
 * write site said stamping 'cloud' "because this process is the saas relay"
 * would be a guess wearing a measurement's clothes. That was right THEN, because
 * the word could still have meant an engine-pool line — a fact this layer does
 * not have. With (a) ruled, the question becomes "did this traffic come through
 * the cloud relay", and this layer answers it exactly:
 *   · every write path below returns early unless `config.mode === 'saas'`;
 *   · a saas process IS the cloud relay;
 *   · a LAN session is served by the standalone sidecar, which never reaches
 *     here at all.
 * So the mode check IS the channel determination — the same judgement basis
 * `cloud-image-policy` uses ("the criterion is the server's own config.mode, not what the client claims to be").
 *
 * 🔴 NOTHING WRITES 'lan', AND NOTHING MAY START. The union still HAS that value
 * because the column can hold one and a future ruling could ask for it; owner's
 * ② is explicit that LAN sessions stay out of this table
 * ("don't log an 'lan' row just for the sake of 'symmetry'"). A 'lan' row appearing here would not be a new
 * data point — it would mean somebody widened the write path past the mode gate.
 */
export const USAGE_EVENT_CHANNEL = 'cloud' satisfies UsageChannel;

export function makeUsageTracker(repo: UsageRepo, config: UsageTrackerConfig): UsageTracker {
  const clock = config.now ?? Date.now;
  const events = config.events;
  // 🔴 `enabled` is BOTH conditions, resolved once. Not `config.usageEventsEnabled`
  // alone: a truthy switch with no sink is a lie, and it is refused below rather
  // than silently degraded to "off" — a deployment whose operator turned
  // collection ON and got nothing is the failure this card cannot afford, since
  // the user-visible promise ("we now keep detailed usage") would be live.
  const enabled = config.usageEventsEnabled === true;
  if (enabled && !events) {
    throw new Error(
      'usage events: FLOWMIC_USAGE_EVENTS_ENABLED is on but no usage_events sink was wired '
      + '(bootstrap must pass `events: db.usageEvents` to makeUsageTracker). Refusing to run '
      + 'a deployment that claims to record per-event usage and does not.',
    );
  }
  // Announced ONCE per process, at construction, in BOTH directions. An
  // operator must be able to answer "is this machine collecting detail records" from the log alone; a
  // line that only appears when the feature is ON would make its absence mean
  // either "off" or "this build doesn't even have this switch".
  log.info(`${USAGE_EVENTS_SWITCH_LOG} ${enabled ? 'ENABLED' : 'DISABLED'}`, {
    env: 'FLOWMIC_USAGE_EVENTS_ENABLED',
    enabled,
    mode: config.mode,
    // Only meaningful when disabled; printed always so the two lines have the
    // same shape and a log parser does not need two cases.
    sink_wired: events !== undefined,
  });

  /**
   * Append one event — and NEVER let it take the caller down.
   *
   * The catch is not tidiness. See this file's header: the STT path reaches
   * here from a bare `setTimeout` and from the shutdown loop, where an uncaught
   * throw closes the process. Loud in the log, invisible to the session — the
   * same policy `recordGateOutcome` (http/ops-audit-trail.ts) applies to the
   * audit trail, for the same reason and with the same stated cost: a lost row.
   */
  function appendEvent(input: {
    user_id: string;
    kind: UsageEventKind;
    stt_ms?: number;
    tokens_in?: number;
    tokens_out?: number;
    is_byok: boolean;
    outcome: 'ok' | 'quota_refused';
    /** A2-5 — omitted by every caller that does not MEASURE characters (the two
     *  LLM legs, and both quota refusals). Omitted ⇒ stored NULL ⇒ read back as
     *  `null`, which is "not measured" and not "zero". */
    chars?: SttCharCounts;
  }): void {
    if (!enabled || !events) return;
    try {
      events.append({
        user_id: input.user_id,
        occurred_at: clock(),
        kind: input.kind,
        ...(input.stt_ms !== undefined ? { stt_ms: input.stt_ms } : {}),
        ...(input.tokens_in !== undefined ? { tokens_in: input.tokens_in } : {}),
        ...(input.tokens_out !== undefined ? { tokens_out: input.tokens_out } : {}),
        is_byok: input.is_byok,
        // 🔴 C5 (owner, 2026-08-12) — the channel is now WRITTEN, and it is a
        // MEASUREMENT rather than the guess this site used to refuse to make.
        // See USAGE_EVENT_CHANNEL below for the whole argument; the short version
        // is that `appendEvent` is unreachable outside `mode === 'saas'`, and a
        // saas process IS the cloud relay.
        //
        // ⚠️ A comment saying "`channel` is deliberately NOT set … writing 'cloud'
        // because this process is the saas relay would be a guess stored as a
        // measurement" stood HERE until this change. It was true when written and
        // the ruling is what retired it, so the sentence is kept — but at the two
        // places a reader now asks the question (the DDL in db/schema.ts and the
        // `UsageChannel` type), NOT as a third copy sitting above a line that
        // does the opposite. A superseded comment left beside the code that
        // supersedes it is worse than no comment (anti-façade rule ④).
        channel: USAGE_EVENT_CHANNEL,
        // 🔴 Spread-or-nothing, NOT `?? 0`. The repo's write path turns an absent
        // count into NULL on purpose (db/repos/usage-events.repo.ts
        // `nonNegIntOrNull`); coercing here would erase the distinction one layer
        // before it reaches the column that exists to hold it.
        ...(input.chars !== undefined
          ? { transcript_chars: input.chars.transcript, delivered_chars: input.chars.delivered }
          : {}),
        outcome: input.outcome,
      });
    } catch (err) {
      log.error('usage_events: append FAILED — the meter is unaffected, the detail row is lost', {
        user_id: input.user_id,
        kind: input.kind,
        outcome: input.outcome,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    recordSttUsage(user_id, engine, duration_ms, chars): void {
      if (config.mode !== 'saas') return; // standalone never bills
      // 🔴 MOVED ABOVE the BYOK check, and this reorder changes NO billing
      // behaviour: both branches returned before `increment` before, and both
      // still do. What it buys is that a zero-length utterance produces no
      // EVENT either — "nothing was consumed" is not something to log a row about, and it is
      // the one of the three original early returns that stays a plain drop.
      if (!Number.isFinite(duration_ms) || duration_ms <= 0) return;
      // 🔴 THE ONE-LINE BYOK TOGGLE'S BRANCH. With RECORD_BYOK_EVENTS = false
      // this is the pre-A2-5 `if (engine.is_byok) return;` exactly.
      if (engine.is_byok && !RECORD_BYOK_EVENTS) return;
      // ── billing, unchanged ──
      // BYOK is still NEVER billed. This is the only line that moves money, and
      // the only guard on it is the same one that was there before.
      if (!engine.is_byok) {
        repo.increment(user_id, currentMonth(clock), { stt_minutes: duration_ms / 60_000 });
      }
      // ── the record, AFTER the meter, wrapped ──
      appendEvent({
        user_id,
        kind: 'stt',
        // Rounded here rather than in the repo's clamp so the stored ms is the
        // same quantity the meter divided by 60_000 — one number, one origin.
        stt_ms: Math.round(duration_ms),
        is_byok: engine.is_byok,
        outcome: 'ok',
        // A2-5 — the two counts, forwarded verbatim from the session that
        // measured them. This layer does no arithmetic on them on purpose: a
        // meter that "fixed up" a character count would be a second author of a
        // number the bridge already owns.
        chars,
      });
    },
    recordLlmUsage(user_id, engine, tokens_in, tokens_out): void {
      if (config.mode !== 'saas') return;
      const inN = Number.isFinite(tokens_in) ? Math.max(0, tokens_in) : 0;
      const outN = Number.isFinite(tokens_out) ? Math.max(0, tokens_out) : 0;
      // Same reorder, same argument as the STT leg: an all-zero report is "the
      // model told us nothing", not an event.
      if (inN === 0 && outN === 0) return;
      if (engine.is_byok && !RECORD_BYOK_EVENTS) return;
      if (!engine.is_byok) {
        repo.increment(user_id, currentMonth(clock), { llm_tokens_in: inN, llm_tokens_out: outN });
      }
      appendEvent({
        user_id,
        kind: 'llm',
        tokens_in: inN,
        tokens_out: outN,
        is_byok: engine.is_byok,
        outcome: 'ok',
      });
    },
    recordQuotaRefusal(user_id, kind): void {
      if (config.mode !== 'saas') return; // standalone has no quota to refuse
      // Every count stays at its 0 default and `is_byok` stays 0 — nothing was
      // consumed, on anybody's key. The row's meaning is carried entirely by
      // `outcome`, which is the separation the DDL argues for.
      appendEvent({ user_id, kind, is_byok: false, outcome: 'quota_refused' });
    },
  };
}
