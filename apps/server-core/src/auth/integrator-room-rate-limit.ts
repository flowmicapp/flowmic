// EMB-1: writer-local admission counters. Raw addresses are neither kept nor logged.
import { randomBytes } from 'node:crypto';
import { ipBucketOf } from '../billing/trial-ip-bucket';
import type { RegisterRateLimitDecision } from './register-rate-limit';

export const INTEGRATOR_ROOM_WINDOW_MS = 60_000;
export const INTEGRATOR_ROOM_BUCKET_MAX = 5;
// IntegratorKeyRow has no settings field; keep the total cap constant.
export const INTEGRATOR_ROOM_KEY_MAX = 120;
const MAX_TRACKED_KEYS = 4096;

export class IntegratorRoomRateLimiter {
  private readonly salt = randomBytes(32).toString('hex');
  private readonly keys = new Map<string, Array<{ bucket: string; at: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  take(keyId: string, ip: string): RegisterRateLimitDecision {
    const now = this.now();
    for (const [key, attempts] of this.keys) {
      const live = attempts.filter((a) => a.at + INTEGRATOR_ROOM_WINDOW_MS > now);
      if (live.length) this.keys.set(key, live);
      else this.keys.delete(key);
    }
    const attempts = this.keys.get(keyId) ?? [];
    const bucket = ipBucketOf(ip, this.salt);
    const visitor = attempts.filter((a) => a.bucket === bucket);
    const blocked = visitor.length >= INTEGRATOR_ROOM_BUCKET_MAX ? visitor
      : attempts.length >= INTEGRATOR_ROOM_KEY_MAX ? attempts : null;
    if (blocked) return { allowed: false, retryAfterMs: blocked[0]!.at + INTEGRATOR_ROOM_WINDOW_MS - now };
    if (!this.keys.has(keyId) && this.keys.size >= MAX_TRACKED_KEYS) {
      // Never evict spent budgets: cardinality pressure must not reset a cap.
      const first = Math.min(...[...this.keys.values()].map((a) => a[0]!.at));
      return { allowed: false, retryAfterMs: first + INTEGRATOR_ROOM_WINDOW_MS - now };
    }
    attempts.push({ bucket, at: now });
    this.keys.set(keyId, attempts);
    return { allowed: true, retryAfterMs: 0 };
  }
}
