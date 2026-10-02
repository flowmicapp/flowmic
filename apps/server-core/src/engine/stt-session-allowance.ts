// EMB-14: the hold and the meter have the same owner and settlement lifetime.
import type { AudioSession } from '../stt/audio/session';
import type { IntegratorSessionCaps } from '../billing/integrator-session-caps';
import { SttAllowancePool } from '../billing/stt-allowance-pool';
import type { SttCharCounts, SttEngineFailure } from './stt-session-deps';

export function reserveSessionAllowance(pool: SttAllowancePool, input: {
  userId: string; keyId?: string; roomId: string;
  payerMs(): number; keyMs(): number | undefined; planCapMs: number;
  visitors?: IntegratorSessionCaps;
}) {
  const visitor = input.keyId === undefined ? undefined : input.visitors?.take(input.roomId, input.keyId);
  const capMs = Math.min(input.planCapMs, visitor?.capMs ?? Infinity);
  const hold = pool.reserve(input.userId, input.payerMs(), capMs, input.keyId, input.keyMs());
  const started = Date.now();
  let ended: number | undefined;
  const readBudget = (): number => Math.min(hold.ms < capMs ? hold.ms : Infinity,
    pool.available(input.userId, input.payerMs(), input.keyId, input.keyMs(), hold));
  return {
    install(session: AudioSession): void {
      session.setQuotaBudgetMs(readBudget());
      session.setSessionCapMs(capMs);
      session.setQuotaRefresher(readBudget);
      session.on('state', (state) => {
        if (state === 'processing' || state === 'auto_stopped' || state === 'closed') ended ??= Date.now();
      });
    },
    settle(ms: number, commit: (billedMs: number) => void): void {
      // Clamp accelerated/replayed PCM too: wall timers alone cannot bound a
      // batch client's audio count. Never bill more than was reserved for it.
      commit(Math.min(ms, hold.ms));
      pool.release(hold);
      visitor?.release((ended ?? Date.now()) - started);
    },
    abort(): void { pool.release(hold); visitor?.release(0); },
    /** NR-138 item 5 (book 22 §4.10) — the session ended on an engine failure with no usable transcript: the whole
     *  hold goes back and NOTHING is committed (the debit is prevented here, before settlement; there is no refund
     *  path). The visitor cap is released unused for the same reason. *** billing *** */
    settleUncharged(): void { pool.release(hold); visitor?.release(0); },
  };
}

export type SessionAllowance = ReturnType<typeof reserveSessionAllowance>;

/**
 * The factory's ONE settle step (`engine/stt-factory.ts`, the bridge's `onComplete`), lifted here so the hold and
 * the meter are settled by one function that a test can drive with a real pool.
 *
 * 🔴 NR-138 item 5 (owner ruling 2026-10-01, book 22 §4.10) — [failure] present ⇒ the hold is released WHOLE and
 * nothing is committed: the debit is prevented here, before settlement, and there is no refund path. The meter is
 * still called, with the failure, so it can say why it moved no counter (and take no claim). Absent ⇒ exactly the
 * pre-NR-138 behaviour: commit min(ms, hold), release. *** billing ***
 */
export function settleSessionUsage(
  allowance: SessionAllowance | undefined,
  ms: number, isByok: boolean, chars: SttCharCounts, failure: SttEngineFailure | undefined,
  meter: (billedMs: number, isByok: boolean, chars: SttCharCounts, failure?: SttEngineFailure) => void,
): void {
  if (failure !== undefined) {
    allowance?.settleUncharged();
    meter(ms, isByok, chars, failure);
    return;
  }
  if (allowance) allowance.settle(ms, (billedMs) => meter(billedMs, isByok, chars));
  else meter(ms, isByok, chars);
}