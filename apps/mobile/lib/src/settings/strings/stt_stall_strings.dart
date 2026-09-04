// AppStrings copy-catalogue shard: card EMPTY-1 (2026-09-04) — the sentences
// that answer 「this hold produced nothing, why」.
//
// Split out of `recording_strings.dart` for the file-size cap, the same way
// InjectNoteStrings was split out of ChatStrings; the mapping that CHOOSES
// between these sentences stayed behind in `sttStallBannerMessage`, because a
// second place that decides which banner to show is how two places come to
// disagree. This shard holds copy and its reasoning only.
part of '../app_strings.dart';

mixin SttStallStrings on AppStringsLeaves {
  // ── card EMPTY-1 (2026-09-04) — WHY an empty final was empty ─────────────
  //
  // owner intent: 「when a hold produces an empty result although there WAS
  // sound … the phone must show a safe, specific notice saying roughly why, so
  // the user can act」. Measured at 0.3.61 on real devices: silence already
  // raised [sttStallMessage]'s 「No speech detected」 correctly, and Chinese
  // spoken while the spoken-language setting said French produced
  // `voicedMs:1280`, `chars 0`, no error frame of any kind — and NOTHING on
  // screen. The 「Transcribing」 row simply vanished.

  /// `stt:final.empty_reason == 'heard_no_words'` — the feed gate accepted
  /// speech, no engine complained, and the transcript is empty.
  ///
  /// 🔴 IT NAMES TWO ACTIONS AND ASSERTS NO CAUSE, for the same reason
  /// [sttStallLanguageUnsupported] names two: the server cannot tell 「the mic
  /// was too far away」 from 「the spoken-language setting does not match what
  /// was said」 — the French/Chinese run above exited cleanly with the requested
  /// language echoed back. Picking one would be a guess dressed as a diagnosis,
  /// and a user sent to fix the wrong thing learns that the app lies.
  ///
  /// 🔴 AND IT IS NOT [sttStallMessage]'s 「No speech detected」. That sentence
  /// says we heard nothing, which is false here and sends someone to shout at a
  /// microphone that was working. Two sentences because the evidence differs.
  String get sttStallHeardNoWords => _lfSttStallHeardNoWords;

  /// An `empty_reason` this build does not recognise — a newer server, or a
  /// value added after this app was shipped.
  ///
  /// States only what the frame itself proves (nothing was transcribed, and the
  /// server did say why) and shows the raw token. Inventing a sentence for an
  /// unknown value is the 0.2.53 defect with the blame reversed: a confident
  /// cause nobody verified. Same restraint as [sttStallEngineErrorCoded].
  String sttStallEmptyReasonUnknown(String reason) =>
      _lfSttStallEmptyReasonUnknown(reason);

  // ── card EMPTY-1 — four registered codes that had no PHONE copy ───────────
  //
  // WP-8 routes these through [protocolErrorSentence], which is deliberately
  // bilingual (zh_CN + en) — the registry never spoke the other seven, and
  // putting words in its mouth was rightly refused there. But that leaves a
  // French, Korean or Russian user reading English at the exact moment a
  // recording was lost, and owner intent asks for a sentence 「so the user can
  // act」. A phone-side MIRROR is what the other six codes in this file already
  // use, so these four join them: nine languages, and an action.
  //
  // ⚠️ The registry fallback stays exactly where it is. It still answers for
  // every OTHER registered code, and removing it would trade a real sentence in
  // two languages for a raw identifier in nine.

  /// `STT_NETWORK_DROP` — a session that WAS open lost its connection
  /// mid-sentence (`unexpectedCloseError`, `stt/engines/base.ts`).
  ///
  /// ⚠️ Says 「the connection to the speech engine」, not 「your network」: on the
  /// LAN route the engine is a service on the computer, and telling someone
  /// their Wi-Fi is broken when it is not is the exact failure
  /// `STT_NO_ENGINE_REACHED` was minted to stop.
  String get sttStallNetworkDrop => _lfSttStallNetworkDrop;

  /// `STT_ENGINE_AUTH_FAIL` — the engine refused the credential it was handed.
  ///
  /// ⚠️ THE INSTRUCTION IS CONDITIONAL ON PURPOSE. On the managed cloud route
  /// the user has no key to check, so an unconditional 「check your API key」
  /// would send them hunting for a setting that does not exist — the mistake
  /// [sttStallNoEngineReached]'s own doc records being made once already.
  String get sttStallEngineAuthFail => _lfSttStallEngineAuthFail;

  /// `STT_ENGINE_RATE_LIMITED` — the engine is throttling us right now.
  ///
  /// ⚠️ 「in a moment」 is the honest span: this one really does clear on its
  /// own, which is what separates it from [sttStallQuotaExceeded] (a month) and
  /// from [sttStallPoolNoRoute] (never, on a timer).
  String get sttStallEngineRateLimited => _lfSttStallEngineRateLimited;

  /// `STT_ENGINE_TIMEOUT` — the engine was fed audio and did not answer inside
  /// its window (the L9 shape: `flush()` that never resolves).
  ///
  /// ⚠️ No cause is named. From the phone the difference between a slow engine,
  /// a slow link and a stuck adapter is invisible, and all three are answered
  /// by the same action.
  String get sttStallEngineTimeout => _lfSttStallEngineTimeout;
}
