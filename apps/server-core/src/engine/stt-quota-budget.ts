import type { SttSessionDeps } from './stt-session';
import { cappedRemainingSttMs } from '../billing/capped-remaining';

/**
 * 🔴 fix-025 — declare THIS user's remaining STT budget on the session, in the
 * one moment it can be declared.
 *
 * `SttSessionBridge`'s constructor calls `build` with the AudioSession it has
 * just made and BEFORE it calls `start()`, and `setQuotaBudgetMs` is legal only
 * from `idle`. That is the same seam `test/autostop-reason.test.ts` already uses
 * and describes in as many words "the one moment the session is still idle".
 *
 * ⚠️ WHY NOT A BRIDGE DEP. `SttSessionDeps` has exactly one field that reaches
 * the session's ceiling — `hardLimitMs` — and it lands on the ENGINE-session one.
 * Sending the budget through it is the defect this card closes, so the fix cannot
 * be "send a better number down the same pipe". That dep now has no producer at
 * all, which is the honest state: nothing in this repo has any business setting
 * an engine-session ceiling per account. Registered for the window that owns
 * `engine/stt-session*.ts`; the census in `test/quota-limit-origin.test.ts` fails
 * if a producer reappears here.
 *
 * The declaration is made BEFORE the inner build so that the #16 fail-fast
 * (SttConfigMissingError, thrown synchronously by the builder when no routing
 * matches) cannot produce the one ordering nobody would notice: a live session
 * whose budget was never declared.
 */
export function withQuotaBudget(
  build: SttSessionDeps['build'],
  quotaBudgetMs: number,
  /** Card G-8 widened this from `{ remainingSttMs }` to the two reads this
   *  function makes. Still structural rather than `QuotaGuard` itself: the
   *  narrow shape is what lets the unit tests drive it with a two-method
   *  object instead of a database. */
  quota: { remainingSttMs(userId: string): number; continuousCapMs(userId: string): number },
  /** card MP-6 — the site demo's per-browser ceiling, or null. Carried into the
   *  REFRESHER as well as the opening declaration: a refresher that asked only
   *  the payer would raise the wall back up on the next floor window and undo
   *  the cap mid-recording. */
  capUserId?: string | null,
  /** card MP-1 — the integrator key's remaining sub-quota, as a THUNK. A number
   *  would have been a snapshot, and this ceiling moves while the recording runs
   *  (the same key is serving every other visitor on that page). `undefined`
   *  from the thunk means 「this session spends no key」; 0 means 「we could not
   *  read it」, which stops the recording — the direction design §5 asks for. */
  keyRemainingMs?: () => number | undefined,
): SttSessionDeps['build'] {
  return (session, language, userId, vad) => {
    session.setQuotaBudgetMs(quotaBudgetMs);
    // 🔴 Card G-8 — AND HOW LONG THIS SITTING MAY RUN, declared in the same act
    // and from the same `userId` (the build argument — the id this session was
    // actually built for, which since card MP-10 is the PAYER and not
    // necessarily the speaker). A separate ceiling on the same timer, never a
    // smaller budget: `stt/audio/session.ts` `setSessionCapMs` carries the three
    // reasons folding it into `quotaBudgetMs` would be wrong, and
    // `billing/session-cap.ts` carries the one reason it must not enter
    // `cappedRemainingSttMs`.
    //
    // ⚠️ READ HERE, NOT PASSED IN, because this is the layer that already holds
    // the guard and asks it the neighbouring question one line up. A caller-
    // supplied number would be a second place `continuous_minutes` is resolved,
    // and the phone is already reading the first one (`/api/cloud/summary`).
    //
    // 🔴 IT IS ARMED ON EVERY audio:start, NOT ONLY ON A 「CONTINUOUS」 ONE, and
    // that is forced rather than chosen: `audio:start` carries no flag saying
    // which kind of press this is (mode / delivery / language / sample rate, and
    // nothing else), so THIS SIDE CANNOT TELL a continuous sitting from somebody
    // holding the button. ⚠️ 更正（RC-1，2026-09-24）：the field now exists — `audio:start.continuous`; it
    // drives only the reconnect ladder (`buildWithPrefs` above), and this wall stays on every start. It is also the right answer if it ever became a
    // choice: a modified client that simply never releases is the same threat as
    // one that ignores its own countdown, and an ordinary utterance is seconds
    // long — the nearest tier ceiling is ten minutes away, so the wall is
    // unreachable on the path it does not mean to govern.
    session.setSessionCapMs(quota.continuousCapMs(userId));
    // 🔴 card CR-Q (owner 2026-08-29) — installed in the SAME act that declares
    // the opening budget, so a session can never end up with a snapshot and no
    // way to refresh it. The reader is the same call the declaration above used;
    // what changes is only WHEN it is asked (orchestrator-core's spawnEngine
    // tail, once per floor window), never WHO answers.
    //
    // ⚠️ `userId` here is the build argument, not the outer `args.userId`: it is
    // the id this session was actually built for, and using anything else would
    // re-check somebody else's budget — a mistake nothing downstream could see,
    // because the number would still look like a plausible number of minutes.
    session.setQuotaRefresher(() => cappedRemainingSttMs(quota, userId, capUserId, keyRemainingMs?.()));
    return build(session, language, userId, vad);
  };
}

