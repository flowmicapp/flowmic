// W6b — a room→key id alone does not prove that this room has a usable billing
// relationship. Resolve the real row and its owner before an admission can
// carry the key ceiling. Missing replication data refuses without deleting a
// valid pairing. Revocation/quota remain integrator-quota.ts's separate facts.
// HUMAN-AUDIT SENSITIVE: billing identity. Production caller: bootstrap.ts.
import type { IntegratorKeyRepo, IntegratorKeyRow } from '../db/repos/integrator-key.repo';
import type { PcRecord } from '../db/repos/pc.repo';

export function boundIntegratorKey(
  keys: Pick<IntegratorKeyRepo, 'keyIdForRoom' | 'findById'>,
  pc: Pick<PcRecord, 'id' | 'user_id' | 'room_kind'> | null,
): IntegratorKeyRow | null {
  if (pc?.room_kind !== 'integrator') return null;
  const keyId = keys.keyIdForRoom(pc.id);
  if (keyId === null) return null;
  const key = keys.findById(keyId);
  if (key === null || key.user_id !== pc.user_id) return null;
  return key;
}
