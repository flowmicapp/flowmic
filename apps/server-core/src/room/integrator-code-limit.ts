// EMB-1: integrator codes share the governor but may reserve at most 20%.
import { ServerError } from '../errors';
import { SHORT_CODE_SPACE, ShortCodeAllocationError, type ShortCodeGovernor } from './short-code';

export const INTEGRATOR_CODE_MAX = SHORT_CODE_SPACE / 5;

export class IntegratorCodeRateLimitError extends ServerError {
  constructor(readonly retryAfterMs: number) {
    super('WEB_ROOM_RATE_LIMITED', undefined, true);
  }
}

export function allocateIntegratorCode(codes: ShortCodeGovernor, ownerId?: string): string {
  const retry = codes.capacityRetryAfterMs('integrator', INTEGRATOR_CODE_MAX, ownerId);
  if (retry > 0) throw new IntegratorCodeRateLimitError(retry);
  try {
    return codes.allocate(ownerId);
  } catch (err) {
    if (err instanceof ShortCodeAllocationError) throw new IntegratorCodeRateLimitError(60_000);
    throw err;
  }
}
