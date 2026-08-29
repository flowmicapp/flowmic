// SPEC-REF:
//   docs/strategy/2026-08-11-unified-transcription-session-design.md §2-R4
//     (locally judged dead, locally spoken, zero protocol — the reason value
//      must NOT enter AudioAutoStoppedSchema's closed enum)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//     (the retention half may be stated; the 「待转录」("pending transcription")
//      half may not)
//
// The LOCAL reasons the phone itself ends a recording — values that ride the
// SAME in-process notice chain as the wire `audio:auto-stopped` reason
// (`PttSession.autoStopped` → ChatController → banner) but that NEVER ride the
// wire: the connection is dead at the only moment they can occur, so there is
// no frame they could honestly travel on.
//
// 🔴 THE `local:` PREFIX IS THE COLLISION GUARD, not a naming taste. The wire
// values (`AudioAutoStoppedSchema.reason`, protocol-schemas-audio.ts) are bare
// snake_case identifiers; a colon cannot appear in them, so a future wire
// reason can never alias one of these, and a grep for `local:` finds every
// value that must never be emitted on a transport.
//
// Consumers (grep the constant names):
//   · writer — `PttSession._onLinkLossEdge` (ptt/ptt_link_loss.dart);
//   · sentence — `AppStrings.recordingAutoStoppedMessage`
//     (settings/strings/recording_strings.dart).

/// The 3 s drop grace expired while the capture was live, AND the tail was
/// handed to a live retention layer: the notice may state the retention fact.
/// 🔴 The sentence for this value must never promise transcription — the
/// upload/re-transcription mechanism does not exist (design §6).
const String kLocalStopReasonLinkLossKept = 'local:link-loss-kept';

/// Same edge, but nothing was retained (no spill wired — e.g. the store failed
/// to open at boot — or the press produced zero audio). The notice may only
/// say the recording stopped; claiming 「已录的音频保留在这台手机上」("the recorded
/// audio has been kept on this phone") here would be an unbacked promise
/// (15 册 §2.0-b constraint 3's shape).
const String kLocalStopReasonLinkLoss = 'local:link-loss';

/// Card CR-6 — the recording reached this account's PER-SESSION ceiling
/// (`PLAN_LIMITS.continuous_minutes`: free 10 minutes, pro/max 30, owner
/// 2026-08-29). The phone enforced it, so the phone says it.
///
/// 🔴 IT MUST NOT BORROW THE WIRE'S `hard_limit`, AND THE REASON IS THAT THE
/// TWO SENTENCES LEAD SOMEWHERE OPPOSITE. This one means 「press it again and
/// keep going」 — the ceiling is per session and the next session gets a fresh
/// one. The server's quota exhaustion means 「this month's minutes are gone」,
/// and pressing again achieves nothing. Showing one sentence for both is the
/// W8-4 account verbatim, and it is the more expensive direction: a user told
/// to wait for next month when they could simply press again loses the
/// recording they were about to make.
///
/// ⚠️ ITS SENTENCE CARRIES NO NUMBER, for the same reason
/// `recordingAutoStoppedQuota` carries none: the minutes live in
/// `billing/plans.ts` and reach the phone at runtime, so a number written into
/// nine translations becomes nine lies on the day a tier is re-cut. The figure
/// belongs on the button that starts a recording (card CR-9), read from the
/// same value the enforcer used.
///
/// ⚠️ It is LOCAL even though the ceiling is the server's number, and that is
/// not a contradiction: the server supplies the figure, the phone performs the
/// stop. Nothing on the wire ends this recording, so nothing on the wire can
/// honestly report why it ended. The threat model is written out in the task
/// unit §4.B② — a modified client can ignore the ceiling, and what it burns is
/// its own monthly quota, which the server does enforce.
const String kLocalStopReasonContinuousCap = 'local:continuous-cap';
