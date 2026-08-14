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
