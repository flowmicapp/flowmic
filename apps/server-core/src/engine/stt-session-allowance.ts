// EMB-14: the hold and the meter have the same owner and settlement lifetime.
import type { AudioSession } from '../stt/audio/session';
import type { IntegratorSessionCaps } from '../billing/integrator-session-caps';
import { SttAllowancePool } from '../billing/stt-allowance-pool';

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
  };
}
