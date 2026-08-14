// AppStrings copy catalogue shard: the local-engine status in the connection
// diagnostics sheet (P-8).
//
// SPEC-REF:
//   docs/decisions/2026-08-06-owner-requirement-p8-engine-status-in-diagnostics.md
//   docs/decisions/2026-08-06-p-wave-choices-by-first-responsible.md P-8 (answers to the four questions)
//   apps/mobile/lib/src/ui/connection_diagnostics_sheet.dart (the host sheet)
//
// The sole external entry point is still ../app_strings.dart. Since 0.2.67 the
// copy leaves `_lf…` are implemented by generated classes under l10n/.
//
// 🔴 The wording discipline on this face is one notch stricter than elsewhere,
// because the sheet it lives on says, in its own header,
// 「Only REAL fields are shown; missing values omit the row (no placeholders)」:
//   ① **Answer two questions separately** (owner's ruling P-8 question 2) —
//      「the result of the most recent use」 and
//      「the result of probing right now」 are two different things, each
//      labeled with its own source and instant, never sharing one word;
//   ② **Not yet tested ≠ broken**. Whatever cannot be probed always falls
//      through to a **spoken-out-loud** 「don't know」,
//      never painted as a green dot that merely looks plausible (precedent:
//      pc_presence_probe.dart's
//      「not being able to probe IS an answer, not a swallowed failure」);
//   ③ A status word with **no instant attached** must never appear on this
//      sheet — R11:
//      every status word must be able to answer 「what grounds do you have for
//      saying that」.
part of '../app_strings.dart';

mixin EngineStatusStrings on AppStringsLeaves {

  /// The subheading for the local-engine section on the diagnostics sheet.
  String get diagEngineSection => _lfDiagEngineSection;

  /// The field label for the transcription-engine row. Uses the SAME word as
  /// `recording_strings.dart`'s
  /// `SttStallReason.engineError` (「转写引擎报错」("the transcription engine
  /// reported an error") / "Speech engine reported an
  /// error") — calling the same thing by two different names on two screens is
  /// the copy variant of this repo's #1 structural defect.
  String get diagEngineStt => _lfDiagEngineStt;

  // ── The engine's own self-reported three states ───────────────────────────
  // 🔴 All three sentences deliberately **only talk about the connection** —
  // not one of 「normal / available / ready」 may appear.
  // The source, `orchestrator-core.ts`'s `status:'ready'`, only proves **the
  // engine connection came up**;
  // the same repo's `stt/pool-health.ts` file header has recorded this cut
  // verbatim: a handshake-style criterion still reports OK for an account that
  // 「connects fine but can't transcribe a single character」. Writing `ready`
  // as 「引擎正常」("the engine is normal") is taking a measurement about
  // **connectivity**
  // and using it to answer a question about **capability** — a literal
  // violation of R11.
  //
  // ⚠️ These three sentences must always appear together with
  // [diagEngineObservedAt], never alone: a status word with no instant, no
  // source attached is banned on this sheet (file header ③). Structurally
  // guaranteed by the same widget in
  // connection_diagnostics_sheet.dart, and pinned by a test.
  //
  // 🔴 **Every sentence must carry its own subject, 「引擎」("the engine") —
  // this is not verbosity, it is a defect a real-device test caught.**
  // The first version wrote 「已连接 / 重连中 / 连接失败」("Connected / Reconnecting
  // / Connection failed"), while `cloud_strings.dart`'s
  // `connConnected` is `zh:'已连接', en:'Connected', ja:'接続済み', ko:'연결됨'`
  // — **identical, character for character, across all four languages** — and
  // it is painted right on the same sheet's top 「Status」 row.
  // ⇒ Two 「已连接」("Connected")s on the same screen, one answering 「is the
  // phone talking to the server」, the other answering
  // 「is the server talking to the transcription engine」, **the user has no
  // way to tell which sentence is about which thing**.
  // This is the copy variant of this repo's #1 bug shape (one value answering
  // two questions).
  // ⚠️ What caught it was **the wiring test that drives the real sheet**
  // (`p8_engine_status_wire_test.dart`'s
  // `findsOneWidget` turned into `Found 2 widgets`); the render test that only
  // mounts this one section was
  // all green at the time — **a word collision like this is invisible on a
  // screen that has only the one section**.
  String get diagEngineConnected => _lfDiagEngineConnected;

  String get diagEngineReconnecting => _lfDiagEngineReconnecting;

  String get diagEngineConnectFailed => _lfDiagEngineConnectFailed;

  /// The 「凭什么这么说」("what grounds do you have for saying that") sentence.
  /// [when] is **the instant this phone received that frame**, formatted by
  /// `ui/time_label.dart`'s `timelineTimeLabel` (the same ruler across the
  /// whole repo, and it does not follow the
  /// OS locale).
  ///
  /// 🔴 The wording 「引擎自报」("self-reported by the engine") is the key
  /// phrase: it states both the **source** (we did not probe it, the engine
  /// said it itself) and the **timing** (when transcription last started, not
  /// right now). owner's ruling P-8 question 2 requires these two
  /// questions to be answered separately, and today this sheet can only
  /// answer the 「most recent use」 half — the 「probe right now」
  /// half has no exit, so this round **draws no button at all**, rather than
  /// drawing one that does nothing when pressed.
  String diagEngineObservedAt(String when) => _lfDiagEngineObservedAt(when);

  /// The sentence for when there has not yet been a single observation on the
  /// local channel.
  ///
  /// It **is not a status word**, so it owes no instant — it says 「我还没有可
  /// 说的」("I have nothing to say yet") and tells the user
  /// how to make it have something to say. This is the opposite direction
  /// from 「painting a green dot that merely looks plausible」.
  /// ⚠️ An observation only lives for the current App run
  /// ([LocalEngineStatusStore] does not persist it), so after a restart
  /// this sentence will appear again — that is a true statement, not a
  /// regression.
  String get diagEngineNoObservation => _lfDiagEngineNoObservation;
}
