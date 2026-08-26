// V2-16 — the capsule title, moved VERBATIM out of controller.ts on 2026-08-26.
//
// The split is the repo rule, not a preference: controller.ts stood at the
// 800-line cap, and the card that touches a file at the cap splits it first —
// trading the reasoning in these comments for line count is what that rule
// exists to forbid. This is a pure function with a long, load-bearing doc and
// no dependency on any controller state, so it is the piece that can leave
// without moving a single behaviour.
//
// Re-exported from controller.ts, so not one import site moved (same
// precedent as recent-line.ts).

import { S } from '../lib/strings';

/** V2-16 — the capsule title. The CONNECTION frame carries NO phone name (pump.rs
 *  build_connection emits connected/registered/room_uuid/mobiles/reason/channel/
 *  primary — that is the whole payload), so the label is derived from pc:list-mobiles
 *  live presence instead: exactly ONE online phone → its pairing name; zero or ≥2 →
 *  the generic default (naming one of several would be a guess).
 *
 *  ⚠️ CORRECTION (卡 D-a, 2026-07-31). This doc used to end "While an utterance is in
 *  flight the title belongs to audio:start's device_label — left alone", and that
 *  sentence was false in a way that hid a dead branch: `AudioStartSchema` has no
 *  `device_label` field at all (protocol-schemas-audio.ts — sample_rate / channels /
 *  encoding / mode / send_policy / delivery / source_lang / target_lang), zod strips
 *  unknown keys, and the server forwards `parsed.data`. `onAudioStart`'s read of it
 *  was therefore unreachable BY CONSTRUCTION, and the mobile had no producer for it
 *  either. The read is deleted; this is the assertion that replaces it.
 *
 *  `speaking` still guards, for the reason that was always the real one: a directory
 *  refresh mid-utterance must not re-label the capsule under the user's eyes. That is
 *  a stability rule about THIS derivation, not a hand-off to another writer. */
export function deriveSessionTitle(online: readonly string[], speaking: boolean, current: string): string {
  if (speaking) return current;
  return online.length === 1 ? online[0]! : (S.cap_session_default as string);
}
