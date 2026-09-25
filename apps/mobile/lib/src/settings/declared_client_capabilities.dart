// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (c′) — `client_caps` on
//     `mobile:pair` / `mobile:reconnect`
//   packages/protocol/src/protocol-schemas-auth.ts
//     CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED (mirrored below; the mirror
//     is pinned by test/declared_client_capabilities_test.dart)
//
// card HANGUP-3 — what this build tells the server it understands.
//
// 🔴 THE DECLARATION IS DERIVED, NOT LISTED. A capability here is a promise that
// this phone has its own sentence for a code the server will then start sending.
// A hand-written list would drift from the copy table: someone deletes the
// sentence and not the declaration, and the server goes on sending a code the
// phone now renders raw (「Speech engine reported an error (CODE)」 — the
// measured fallback, recording_strings.dart `sttStallEngineErrorCoded`). So each
// capability names the code AND the phone's own getter for it, and is declared
// only when the very selector that paints the banner (`sttStallBannerMessage`)
// answers the code with THAT getter's sentence in EVERY locale. Delete the arm
// and the selector falls to a fallback, which differs from the getter in at
// least one locale (the registry fallback only speaks en / zh-CN), so the
// declaration disappears; delete the getter and this file stops compiling.
//
// ⚠️ Why not 「the answer differs from the fallbacks」: the registry's en / zh-CN
// sentence for this code is DELIBERATELY the phone's approved sentence (pinned by
// packages/protocol/test/segment-not-transcribed-copy.test.ts), so comparing
// against the registry fallback would call the phone's own sentence a fallback.

import '../signaling/state_machine.dart' show SttStall, SttStallReason;
import 'app_settings.dart' show AppLocale;
import 'app_strings.dart';

/// Capability name → (the wire code it promises, the phone's own sentence for it).
/// The name mirrors packages/protocol `CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED`.
final Map<String, (String, String Function(AppStrings))> kDeclarableCapabilities =
    <String, (String, String Function(AppStrings))>{
  'stt.segment_not_transcribed': (
    'STT_SEGMENT_NOT_TRANSCRIBED',
    (AppStrings s) => s.sttStallSegmentNotTranscribed,
  ),
};

/// True when, in every locale, the banner selector answers [code] with [own].
bool phoneSaysCodeInEveryLocale(String code, String Function(AppStrings) own) {
  for (final AppLocale locale in AppLocale.values) {
    final AppStrings s = AppStrings.of(locale);
    final String said = s.sttStallBannerMessage(SttStall(SttStallReason.engineError, code: code));
    if (said != own(s)) return false;
  }
  return true;
}

List<String>? _cache;

/// What rides `client_caps` on `mobile:pair` and `mobile:reconnect`. Computed
/// once per process: the answer is a property of the build, not of the moment.
List<String> declaredClientCapabilities() => _cache ??= <String>[
  for (final MapEntry<String, (String, String Function(AppStrings))> e in kDeclarableCapabilities.entries)
    if (phoneSaysCodeInEveryLocale(e.value.$1, e.value.$2)) e.key,
];
