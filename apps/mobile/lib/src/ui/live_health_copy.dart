// AW-1b — maps one `AsrHealthSnapshot` (session/asr_health.dart) to the ONE
// sentence the live draft row shows in its place (`live_draft_tile.dart`).
//
// ── WHY A STANDALONE FILE, NOT A `part of 'chat_message_tile.dart'` ────────
// `chat_message_tile.dart` is PINNED at exactly 835 lines
// (verify/lint/file-size.mjs TRANSLATION_BLOAT_BASELINE — "a file listed here
// passes only while it stays AT OR BELOW its pinned count; one extra line
// makes it FAIL"). A `part of` file shares its library's IMPORTS, and this
// mapping needs two new ones (asr_health.dart's types, and
// `sttStallBannerMessage`'s `SttStall`) that `chat_message_tile.dart` does not
// already have — adding them there would be the "one extra line" the pin
// exists to refuse. A plain top-level function needs no import from the
// pinned file at all: `live_draft_tile.dart` (NOT pinned, 183/800 lines) calls
// it and only imports THIS file.
//
// ── WHY ONE FUNCTION AND NOT A SECOND COPY TABLE ────────────────────────────
// The terminal-error branch reuses `AppStrings.sttStallBannerMessage` — the
// SAME table `banner_queue.dart` already renders an engine stall with
// (recording_strings.dart) — instead of inventing new engine-error sentences.
// 0.2.53's own rule: a second table for the same fact is how two screens
// answer "which engine error" two different ways.
//
// ── WHAT THIS DELIBERATELY DOES NOT SAY ─────────────────────────────────────
// First-frame audio retention (N1-B3) is NOT enabled yet (asr_health.dart's
// own header only promises the FOUR signals, no cause) — none of the
// sentences below may claim the audio is being kept, saved, or queued for
// later. See i18n/mobile/*.json's five `liveHealth*` keys: none contains a
// number, and none uses "durable"/"已安全保存"/"不会丢"/"待转录" (copy-scent
// iron rule).
//
// Nor may a sentence name a CAUSE the tracker cannot see. Level 2 used to end
// "— check your connection", which is false on the LAN and on-device legs
// (there is no connection to check) and unknowable on the cloud leg: the
// tracker knows only that nothing came back. The escalation is now carried by
// weight of statement, not by an instruction.
//
// There is deliberately NO branch for `AsrHealthSnapshot.retryableBounces`.
// It is diag-only — see asr_health.dart's own field doc and the OUTPUTS block
// in chat_asr_health_wire.dart.

import '../session/asr_health.dart';
import '../settings/app_strings.dart';
import '../signaling/state_machine.dart' show SttStall, SttStallReason;

/// The ONE sentence the live draft row shows for [snapshot], or null when
/// every signal is clear.
///
/// 🔴 IT RETURNS null RATHER THAN A "NORMAL" SENTENCE, AND THAT IS A LAYOUT
/// FACT, NOT A STYLE ONE. These sentences are 26-39 characters and the status
/// pill they used to be poured into is a `Flexible` in a header row that also
/// carries the mode badge, "Now", the recording dot and the duration —
/// MEASURED at 360 dp: the pill gets 52-170 logical pixels, while the
/// sentences need 171-478. 40 of the 45 locale x signal combinations were
/// being ellipsed on screen, and the render test could not see it because it
/// only ever asserted `maxLines == 1`. That is 0.2.53 verbatim
/// (`INJECT_SELF_WINDOW_NO_INPUT` shown to the user as `INJ...`), and it has
/// 0.2.53's remedy: the sentence goes on its own full-width line under the
/// header row (`LiveDraftTile.healthNote`), and the pill keeps the short
/// word it was sized for. A caller that gets null shows no line at all.
///
/// Priority, most severe first (never collapsed into one sentence — §A8):
/// a named terminal engine error > audio having stopped arriving from the
/// recorder (byteStall) > the audio that IS arriving being all-zero samples
/// (digitalSilence) > no first result yet (level2, then level1) > a stall
/// after a first result already landed (noProgress) > normal.
///
/// byteStall outranks digitalSilence because the two cannot both be true and
/// the first is the coarser fact; both outrank the result-side signals
/// because a caller who can see the input side is broken does not need to be
/// told the output side is empty as well.
String? liveHealthNote(AsrHealthSnapshot snapshot, AppStrings strings) {
  final AsrTerminalError? err = snapshot.terminalError;
  if (err != null) {
    return strings.sttStallBannerMessage(
      SttStall(SttStallReason.engineError, code: err.code, message: err.message),
    );
  }
  if (snapshot.byteStall) return strings.liveHealthByteStall;
  if (snapshot.digitalSilence) return strings.liveHealthDigitalSilence;
  if (snapshot.noFirstResult == AsrHealthLevel.level2) {
    return strings.liveHealthNoFirstResultLevel2;
  }
  if (snapshot.noFirstResult == AsrHealthLevel.level1) {
    return strings.liveHealthNoFirstResultLevel1;
  }
  if (snapshot.noProgress) return strings.liveHealthNoProgress;
  return null;
}
