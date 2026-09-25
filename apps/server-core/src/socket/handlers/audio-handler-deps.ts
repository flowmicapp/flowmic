// SPEC-REF: ./audio.handler.ts (the handler these two shapes belong to)
//
// 🔴 STRUCTURAL SPLIT ONLY (card MP-1, 2026-09-11) — the two INTERFACES
// `audio.handler.ts` declares, moved out VERBATIM with every comment, because
// that file stood exactly at the 800-line `file-size` cap and card MP-1 had to
// add a gate to it. NO BEHAVIOUR MOVED WITH THE CODE and nothing was rewritten
// on the way; the shape of this split is `mobile-handler-deps.ts`'s, which was
// carved off `mobile.handler.ts` for the same reason.
//
// 🔴 THE THREE BILLING CALL SITES STAY IN `audio.handler.ts`, and that is why
// this file holds the TYPES and not the gate: `test/billing-call-sites.test.ts`
// asserts the exact FILE each of `recordSttUsage` / `recordLlmUsage` /
// `ensureQuota` lives in, by source census. audio-start-quota.ts's own header
// records the same constraint. A split that moved one of them would pass every
// type check and quietly retire a census that exists to keep money in one place.
//
// `audio.handler.ts` re-exports both names, so every existing
// `import type { AudioHandlerDeps } from './audio.handler'` is untouched.

import type { Server, Socket } from 'socket.io';
import type { Delivery } from '@flowmic/protocol';
import type { QuotaGuard } from '../../billing/quota-guard';
import type { UsageTracker } from '../../billing/usage-tracker';
import type { RoomStore } from '../../room/store';
import type { SttOrchestrator } from '../../engine/orchestrator';
import type { SttCharCounts } from '../../engine/stt-session-deps';
import type { RecoveryEcho } from '../../engine/stt-session-receipt';
import type { AudioSessionRegistry } from '../../engine/audio-registry';
import type { VerificationGraceGuard } from '../../auth/verification-grace';
import type { AnonymousRowReader } from '../../auth/metering-principal';
import type { PcRoomReader } from './audio-metering';
import type { RecoveryOperationsRepo } from '../../db/repos/recovery-operations.repo';
import type { BudgetPusher } from '../../billing/budget-push';

export interface SttStartArgs {
  userId: string;
  /** card MP-6 — the site demo's per-browser ceiling; bounds the hard stop. */
  capUserId?: string;
  /** card MP-1 — the integrator key whose sub-quota also bounds the hard stop. */
  integratorKeyId?: string;
  mode: 'realtime' | 'translate' | 'organize';
  delivery: Delivery;
  sourceLang: string;
  targetLang?: string;
  /** Card CV-1 — the recovery identifiers off `audio:start`, echoed back on the
   *  terminal final. Lifted by `recoveryEchoOf`; undefined when the frame
   *  carried none. Never parsed or validated here. */
  recovery?: RecoveryEcho;
  /** card HANGUP-3 — the `client_caps` the starting socket declared at admission
   *  (wire.ts `getClientCaps`); absent/empty ⇒ nothing declared, keep the old behaviour. */
  clientCaps?: readonly string[];
  /** card RC-1 — `audio:start.continuous === true`: a LONG RECORDING, not a held button (book 04).
   *  Present only when true; the engine factory turns it into the unbounded reconnect ladder. */
  continuous?: true;
  /** GA-04: the stt:* emitter must follow the session across a reconnect, so the
   *  mobile leg is resolved PER FRAME instead of closing over the socket that
   *  happened to send audio:start. Absent → the factory falls back to that
   *  socket (unpaired/local sessions, and every pre-GA-04 call site). */
  resolveSocket?: () => Pick<Socket, 'emit'> | null;
  /** Called exactly once by the orchestrator (R1-3) at session finalize.
   *
   *  A2-5 — `chars` is the third argument the seam grew so the per-event usage
   *  log can answer "how many characters were spoken this time / how many were sent out". See [[SttCharCounts]] for why
   *  it had to travel here rather than be defaulted at the table. */
  onComplete(durationMs: number, isByok: boolean, chars: SttCharCounts): void;
  /** v0.2.3 — the polish LLM's usage, once per polished terminal-final and only
   *  when the model reported it. See the metering note on commitPolishUsage. */
  onPolishUsage?(tokensIn: number, tokensOut: number, isByok: boolean): void;
  /** Card S2-02 — called by the stt emitter immediately BEFORE it sends
   *  `audio:auto-stopped{reason:'quota_exhausted'}`, and never for any other
   *  auto-stop reason. Absent ⇒ no exhaustion budget frame; the auto-stop
   *  itself is untouched either way. */
  onQuotaExhausted?(): void;
}

export interface AudioHandlerDeps {
  io: Server;
  guard: QuotaGuard;
  usageTracker: UsageTracker;
  /** Room presence — the S→PC audio fan-out target (WP-R2-1b, F-2375). */
  store: RoomStore<Socket>;
  /** GA-04 session ownership. Absent → sessions stay socket-scoped (old behaviour). */
  sessions?: AudioSessionRegistry;
  /** STT engine seam (R1-3). Absent in R1-2 → the handler fails loud. */
  sttFactory?: (args: SttStartArgs) => SttOrchestrator;
  /**
   * card QTA-2 (owner 2026-08-15: 「计费在 PC 和手机端都进行检查，两边有一方
   * 不满足都不能继续」) — resolve the PC OWNER's account for this socket's
   * paired PC. `auth.userId` is the acting account (`mobile.user_id ??
   * pc.user_id` — the phone's own when it has one); when the desktop is signed
   * into a DIFFERENT account, that second account's quota must also admit the
   * session. Absent (old wiring, tests that predate the card) ⇒ single-account
   * behaviour, which is also correct whenever the two ids are equal.
   *
   * 🔴 card MP-0 — IT ANSWERS TWO FACTS ABOUT ONE ROW AND SO IT IS ONE
   * LOOKUP. The gate below needs the owner AND `pc_devices.room_kind` (a
   * third-party host room does not ask a second ledger — its owner is already
   * the payer). Two accessors would be two reads of one row that a caller could
   * wire to two different registries, which is exactly how 「which PC is this」
   * gets two answers.
   */
  pcRoom?: PcRoomReader;
  /** Card W4-05 — `users.anonymous` for one row, the SAME reader mobile.handler
   *  gets. Two exceptions hang on it: the QTA-2 gate below skips an anonymous
   *  room owner, and the room's target end follows the microphone's ledger
   *  instead of that owner's. Absent ⇒ neither exception, i.e. the pre-card
   *  behaviour; auth/metering-principal.ts carries both arguments. */
  anonymousUser?: AnonymousRowReader;
  /** card MP-1 — the per-key sub-quota reader (`billing/integrator-quota.ts`).
   *  Absent ⇒ every key reads 0 remaining; see `integratorKeyRefusal` for why
   *  that is the direction and not a friendly default. */
  integratorKeys?: { remainingMs(keyId: string, at: number): number };
  /**
   * NR-2a — the 3-day unverified grace (auth/verification-grace.ts). ONE of the
   * two enforcement sites in the whole server, deliberately the SAME two the
   * quota guard uses: 「云端拒新会话」 (owner ruling item 4) is a statement about
   * SESSION STARTS, and this is where a session starts.
   *
   * Absent ⇒ no gate, which is the pre-NR-2a behaviour every existing test was
   * written against. Standalone is exempt inside the guard itself
   * (`config.mode !== 'saas'` NOOP), not by being unwired here — so the
   * exemption is a fact a test can drive rather than a wiring accident.
   */
  verificationGrace?: VerificationGraceGuard;
  /**
   * Card PR-2 (2026-09-06) — the operation registry (db.recoveryOps).
   *
   * Absent ⇒ a frame carrying an `operation_id` is REFUSED rather than admitted
   * unprotected, because this server advertises `recovery.idempotent_operation`
   * (audio-start-operation.ts argues the direction). Absent + no operation ⇒
   * exactly today's behaviour, which is every test that predates this card.
   */
  recoveryOps?: RecoveryOperationsRepo;
  /**
   * Card S2-02 — the `billing:budget` emitter (billing/budget-push.ts).
   *
   * Absent ⇒ no budget frames at all, which is exactly the pre-card behaviour
   * every existing test was written against. Deliberately NOT defaulted to a
   * no-op that pretends to work: an absent pusher is a wiring fact a test can
   * drive, and CLAUDE.md's anti-façade ② is about exactly this ("a DI default
   * must be the real thing or throw, never a friendly empty implementation").
   */
  budget?: BudgetPusher;
  /** Card S2-02 — the floor between while-streaming budget frames. Defaults to
   *  {@link DEFAULT_BUDGET_HEARTBEAT_MS}; bootstrap passes the env override. */
  budgetHeartbeatMs?: number;
  /** Injected so a test can pin the registry's timestamps to its own clock.
   *  Defaults to `Date.now`. */
  now?: () => number;
}
