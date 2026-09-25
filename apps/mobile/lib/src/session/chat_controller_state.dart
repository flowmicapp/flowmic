part of 'chat_controller.dart';

// Lane S4 — pulled out of chat_controller.dart VERBATIM to bring the mother
// file under the audio-durability plan's 700-line cap. Pure state, no
// methods and no getters: the per-utterance delivery snapshot and the
// five fail-loud notice fields it neighbours. `on ChangeNotifier` is not
// load-bearing here — nothing below calls a superclass member — but it is
// what `class ChatController extends ChangeNotifier with _ChatControllerState`
// already satisfies, so there is no reason to widen the constraint.
mixin _ChatControllerState on ChangeNotifier {
  // Per-utterance snapshot: delivery + mode are FIXED at audio:start and must
  // NOT follow a later destination/mode toggle (§4.0 B).
  String? _activeClientId;
  Delivery _activeDelivery = Delivery.inject;
  FlowMode _activeMode = FlowMode.realtime;
  int _utteranceSeq = 0;

  // Card RC-B follow-up — the rows THIS live press has settled so far, and the
  // `recording_id` of the live attempt they belong to. Written in `_settleSpan`
  // for live sessions only (a recovery's rows are not the press's); read by the
  // terminal final's empty-text branch, which hands them to `settleSilentTail`.
  String? _pressRowsRecordingId;
  final List<String> _pressRowIds = <String>[];

  // Card RC-P — the wait for a live terminal final that an owed tail's
  // placement is held for; see `chat_outbox_host.dart` `maybeSweepOwedTailRouted`.
  Timer? _owedTailGrace;

  // Card D-2's `_lastUtteranceEntryId` — 「the row the most recent terminal
  // final built」, the temporal guess a late `stt:refined` used to land on —
  // was DELETED on 2026-09-03 (design D7 ③). Its own doc said it 「must not
  // grow into a correlation key」 because no wire key existed; one exists now
  // (`utterance_id` on `stt:final` and `stt:refined`, stored on the row as
  // `TimelineEntry.utteranceId`), and `_applyRefined` matches on that key
  // alone. Keeping the guess beside the key would have given 「which row is
  // this refine for」 two answers.

  // WP-R4-6 ⑦: polish-skipped honest signal. Held here (NOT on TimelineEntry)
  // so the five-state status face stays delivery-truth only. The lead's ruling
  // (integration, 2026-07-24): the mark is SESSION-PERSISTENT — it stays on the
  // affected bubble for the whole app session (in-memory only, never persisted),
  // NOT a few-seconds toast; an honest failure signal must not quietly vanish.
  final Set<String> _polishSkippedEntryIds = <String>{};
  /// GA-13: rows whose CURRENT compose run is a reprocess, mapped to the mode
  /// the run was started with. The terminal takes the rewrite fork instead of
  /// the deliver fork — and it must stamp THAT mode, not `_activeMode`, which is
  /// still the last spoken utterance's snapshot (§4.0 B) and can be anything.
  final Map<String, FlowMode> _reprocessingEntryIds = <String, FlowMode>{};
  // `_reprocessWasSynced` lived here: of the in-flight reprocesses, the ones that
  // were already server-synced, because only those got the machine
  // `history:update`. Removed in 0.2.27 with that uplink — a reprocess is now a
  // purely local rewrite of a row this phone owns.

  // R6 P0-R3: fail-loud auto-stop notice. When the server hits the 5-min hard
  // cap (audio:auto-stopped) the recording ends without the user's release —
  // 08 §B-5 forbids this vanishing silently, so we raise a transient page banner.
  // Held here (NOT on TimelineEntry) so the five-state status face stays
  // delivery-truth only; a fresh PTT-down or an explicit dismiss clears it.
  bool _autoStopped = false;

  /// 🔴 G-20 ① — WHICH INSTANCE'S SCREEN [_autoStopped] is news for. Stamped by
  /// the ONE writer (`onAutoStoppedRouted`) at the moment the fact is produced
  /// (§2.5.1 fourth rule), compared through [_noticeOnScreen]. Same scope, same
  /// `null == null` judgement as `ManualDelivery._failureInstanceId` — one scope
  /// for the whole family, not six near-misses (ruling G-20, 2026-08-05).
  String? _autoStoppedInstanceId;

  // [_noticeOnScreen] (G-20's ONE equality judgement) and [_autoStoppedOnScreen]
  // moved VERBATIM to chat_notice_scope.dart — the fields stay, see its header.

  // 🔴 fix-026 — WHY it stopped, in the server's own wire vocabulary
  // (`AudioAutoStoppedSchema.reason`). A SECOND value beside [_autoStopped]
  // because it answers a SECOND question: that one says 「the recording stopped
  // on its own」, this one
  // says 「because of what」. Collapsing them (e.g. a nullable reason doubling as the
  // flag) is the repo's #1 bug shape, and the flag has three writers this value
  // must not inherit (`pttDown` / the ✕ / the auto-hide timer).
  //
  // Sole writer: the `session.autoStopped` subscription above, which writes it
  // immediately before raising the flag. `''` = the frame did not say — never a
  // stand-in for a real reason.
  String _autoStopReason = '';

  // [autoStopReason] moved VERBATIM to chat_notice_scope.dart, with the gate it reads.

  // GA-03: fail-loud "PTT produced nothing" notice. The FSM closed PROCESSING
  // without a terminal stt:final (15 s safety net, or a terminal stt:error).
  // Same shape as [_autoStopped]: transient page state, never a timeline field —
  // the utterance built no row at all (the final never arrived = the utterance
  // never completed), so there
  // is nowhere on the five-state face to put it, and the banner IS the truth.
  // ENG-3: an [SttStall] (reason + wire code/message), not the bare enum, so a
  // NAMED engine refusal reaches the banner instead of dying in this field.
  SttStall? _sttStalled;

  /// 🔴 G-20 ② — WHICH INSTANCE'S SCREEN [_sttStalled] is news for. Stamped by
  /// the ONE writer (`onSttStalledRouted`); see [_autoStoppedInstanceId].
  String? _sttStalledInstanceId;

  // Card MP-14 — the most recent `control:key-result` that said `ok:false`, or
  // null. A TICKET-carrying value rather than a flag: see [ControlKeyRefusal].
  //
  // 🔴 NOT ON THE ROW, and that is the whole shape of this card. The keypress
  // row says 「the frame left this device」 (`buildControlRowOf`) and stays true;
  // what the far end then did with the key is a different fact with a different
  // lifetime, and writing it onto the row would give one value two questions to
  // answer.
  ControlKeyRefusal? _controlKeyRefusal;

  /// 🔴 G-20 — WHICH INSTANCE'S SCREEN [_controlKeyRefusal] is news for, stamped
  /// at the moment the fact is produced (§2.5.1 fourth rule). The press was made
  /// on one instance's screen and the refusal is about that instance's computer;
  /// unscoped, it would surface on a screen showing a different PC entirely.
  String? _controlKeyRefusalInstanceId;

  /// The ticket generator for [_controlKeyRefusal]. Monotonic per controller —
  /// two refusals of the same key for the same cause are two pieces of news.
  int _controlKeyRefusalTicket = 0;

  // AUD-D F6 / P1-6 (2026-09-02) — `RetainedAudioStore` gave up or aged out
  // unclaimed capture audio. Deliberately NOT instance-scoped like the three
  // notices above: it describes a FILE on this phone's disk, produced by the
  // retention layer independently of which PC this screen happens to be
  // showing (unlike [_autoStopped]/[_sttStalled]/[_utteranceFailure], which
  // are all about a delivery this phone tried to make TO a specific
  // instance). The raw [RetainedAudioNotice.code] string, not the model
  // type, so this class never has to import audio/retained_audio_store.dart —
  // the same shape [_autoStopReason] already uses for the same reason.
  String? _retainedAudioNoticeCode;
}
