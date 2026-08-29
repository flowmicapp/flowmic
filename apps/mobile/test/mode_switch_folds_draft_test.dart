// NR-4-P1 (f) acceptance — switching mode no longer silently destroys a draft.
//
// SPEC-REF: docs/strategy/2026-08-27-next-release-feature-and-optimization-
//   ledger.md §4 row f (「模式切换清空缓冲无确认……有真实丢稿路径」) + §4 P1 ③;
//   master-plan §4.0 A (記錄是本體 — the record IS the substrate);
//   docs/decisions D1 2026-08-06 (the confirm dialog was cancelled on purpose).
//
// THE MEASURED DEFECT AND ITS EXACT EDGE. `discardBufferedRowsRouted` already
// settled every row that FED the buffer at 📥 noted, and `ComposeModeSwitchHint`
// leaned on that to say 「this box will be cleared」 rather than 「what you said
// is gone」. True — for spoken text nobody edited. False for the two things that
// have no row behind them:
//   · TYPED text (`_bufferedEntryIds` empty ⇒ nothing settles, nothing kept);
//   · an EDITED draft or an AI translate/organize product (the rows keep the
//     ORIGINAL wording; the version about to be sent is the one that vanishes).
// The guard standing in front of that was a hint strip, i.e. a sentence — and a
// sentence stops nothing.
//
// 🔴 WHY A ROW AND NOT A DIALOG (the card allowed either): a noted row is
// structurally possible from this site — `TimelineStore.buildFromUtterance`
// with `Delivery.none`, the SAME call `commitNotedLocal` and a record-only
// spoken utterance already make. So the fold was taken and D1's ruling is not
// reopened: the tap still does what it looks like, in one step, uninterrupted.
//
// ── REVERSE CONTROLS (each ACTUALLY run red on 2026-08-27, then reverted;
//    residual grep 0, file re-greened) ────────────────────────────────────────
// ① The `foldDraftToNotedOnModeSwitch(c)` call removed from `setModeRouted`:
//      「a TYPED draft survives the switch as a record-only row」
//        Expected: <1>  Actual: <0>   (the words ceased to exist)
//      「an AI/edited draft survives …」   Expected: <2>  Actual: <1>
//      「the row is filed under the mode it was composed in」 (no row at all)
//      → 3 red / 5 green.
// ② The de-duplication guard (`if (draft == _coveredRowsText(c)) return;`)
//    removed, i.e. fold unconditionally:
//      「an UNEDITED spoken draft does NOT mint a second row」
//        Expected: <1>  Actual: <2>   (the same sentence, twice, adjacent)
//      「multi-utterance: … already-carried」  Expected: <2>  Actual: <3>
//      → 2 red / 6 green. These are the cases that make the fold safe to keep
//        at all; without the guard the ordinary manual flow doubles every
//        sentence, which is a worse product than the bug being fixed.
//    ⇒ The two controls are DISJOINT: ① proves the fold does something, ②
//      proves it does not do it everywhere. Either one alone would let the
//      other implementation through.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    giveSessionAPairedIdentity(session);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: newTestStore(),
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final ChatController controller;

  /// The send policy is a stored preference: without this the controller sits
  /// on its `direct` default, a spoken utterance is DELIVERED instead of
  /// folding into the buffer, and every case below would be exercising the
  /// wrong flow while still looking plausible.
  Future<void> loadManualPolicy() => controller.loadSendPolicy();

  /// One manual utterance: it mints its own ⏳ row AND folds into the buffer.
  Future<void> speak(String text) async {
    session.fsm.onJustDoneTimeout();
    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();
  }

  Future<void> dispose() async {
    controller.session.debugStopIdlePresencePoll();
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('🔴 a TYPED draft survives the switch as a record-only row', () async {
    // The purest loss path: no utterance ever ran, so `_bufferedEntryIds` is
    // empty and the old 「their rows settle at noted」 answer had no rows to
    // settle. The words simply ceased to exist.
    final _Harness h = _Harness();
    await h.loadManualPolicy();
    h.controller.setBuffer('明天下午三点开会，记得带合同');
    expect(h.controller.store.entries, isEmpty);

    h.controller.setMode(FlowMode.organize);

    expect(
      h.controller.buffer,
      isEmpty,
      reason: '08 §2 red line untouched: the box still comes out empty',
    );
    expect(
      h.controller.store.entries.length,
      1,
      reason: '🔴 the draft was destroyed by a mode tap with nothing said — '
          'the loss path the hint strip could only describe',
    );
    final TimelineEntry row = h.controller.store.entries.single;
    expect(row.displayText, '明天下午三点开会，记得带合同');
    expect(
      row.status,
      EntryStatus.noted,
      reason: 'nothing was ever delivered ⇒ 📥 noted is the only honest status; '
          'anything else would be a delivery claim with no delivery behind it',
    );
    expect(
      row.delivery,
      Delivery.none,
      reason: 'the row must not claim it is bound for a PC',
    );
    expect(
      h.transport.emittedWhere(FlowMicEvents.injectRequest),
      isEmpty,
      reason: '🔴 the fold put a frame on the wire — this is a LOCAL record, '
          'not a delivery the user never asked for',
    );
    await h.dispose();
  });

  test('🔴 the row is filed under the mode it was composed in, not the new one',
      () async {
    final _Harness h = _Harness();
    await h.loadManualPolicy();
    expect(h.controller.mode, FlowMode.realtime);
    h.controller.setBuffer('实时模式下写的草稿');

    h.controller.setMode(FlowMode.translate);

    expect(
      h.controller.store.entries.single.mode,
      FlowMode.realtime,
      reason: '🔴 a realtime draft filed under 「translate」 — and nothing on '
          'screen or in the store could contradict it',
    );
    await h.dispose();
  });

  test('🔴 an AI/edited draft survives even though its source rows do not '
      'carry it', () async {
    // The subtler half. The spoken row exists and settles at noted with the
    // ORIGINAL wording; the buffer holds what the user (or the LLM) made of it,
    // and that version had nowhere to go.
    final _Harness h = _Harness();
    await h.loadManualPolicy();
    await h.speak('明天开会');
    expect(h.controller.store.entries.length, 1);
    expect(h.controller.buffer, '明天开会');
    // What an AI result / a manual edit does to the buffer.
    h.controller.setBuffer('The meeting is tomorrow.');

    h.controller.setMode(FlowMode.organize);

    expect(
      h.controller.store.entries.length,
      2,
      reason: '🔴 the edited/translated version was thrown away; only the '
          'original survives, and the user is not told which one they lost',
    );
    // Newest first (the store sorts on insert).
    expect(h.controller.store.entries.first.displayText, 'The meeting is tomorrow.');
    expect(h.controller.store.entries.first.status, EntryStatus.noted);
    // The source row kept its own truth and its own wording.
    expect(h.controller.store.entries.last.displayText, '明天开会');
    expect(
      h.controller.store.entries.last.status,
      EntryStatus.noted,
      reason: 'the pre-existing mechanism (discardBufferedRowsRouted) still '
          'settles the rows that fed the buffer',
    );
    await h.dispose();
  });

  test('🔴 an UNEDITED spoken draft does NOT mint a second row', () async {
    // The case that makes the fold safe to keep at all. In the ordinary manual
    // flow the buffer IS the covered rows' text, joined the way
    // `_foldIntoBuffer` joins it; minting here would print the same sentence
    // twice, one line above itself.
    final _Harness h = _Harness();
    await h.loadManualPolicy();
    await h.speak('只说了这一句');
    expect(h.controller.buffer, '只说了这一句');

    h.controller.setMode(FlowMode.translate);

    expect(
      h.controller.store.entries.length,
      1,
      reason: '🔴 the same sentence was minted twice — the fold ran on a '
          'buffer the rows already carried',
    );
    expect(h.controller.store.entries.single.status, EntryStatus.noted);
    await h.dispose();
  });

  test('multi-utterance: the space-joined fold is recognised as already-carried',
      () async {
    // `_foldIntoBuffer` chains finals with a single space, so two utterances
    // produce `「a」 「b」` in the buffer and two rows in the store. The
    // comparison has to reassemble them the same way or every multi-utterance
    // manual draft gets a duplicate.
    final _Harness h = _Harness();
    await h.loadManualPolicy();
    await h.speak('第一句');
    await h.speak('第二句');
    expect(h.controller.buffer, '第一句 第二句');
    expect(h.controller.store.entries.length, 2);

    h.controller.setMode(FlowMode.organize);

    expect(
      h.controller.store.entries.length,
      2,
      reason: '🔴 a third row appeared — the join rule used by the comparison '
          'has drifted from the one used by the fold',
    );
    await h.dispose();
  });

  test('an EMPTY (or whitespace-only) buffer mints nothing', () async {
    final _Harness h = _Harness();
    await h.loadManualPolicy();
    h.controller.setBuffer('   ');
    h.controller.setMode(FlowMode.translate);
    expect(h.controller.store.entries, isEmpty);
    await h.dispose();
  });

  test('🔴 THE BOUNDARY: the explicit ✕ / discard still destroys the draft',
      () async {
    // Deliberately NOT changed. That button is labelled, deliberate
    // destruction; quietly keeping a copy of what somebody explicitly threw
    // away is its own red line, and it would make 「discard」 a word with
    // nothing behind it.
    final _Harness h = _Harness();
    await h.loadManualPolicy();
    h.controller.setBuffer('明确要丢掉的草稿');

    h.controller.discardBuffer();

    expect(h.controller.buffer, isEmpty);
    expect(
      h.controller.store.entries,
      isEmpty,
      reason: '🔴 the fold leaked onto the explicit discard path — 「丢弃」 now '
          'keeps what it says it throws away',
    );
    await h.dispose();
  });

  test('the hint strip names where the words go, in every locale', () {
    // 0.2.53 law says a render assertion belongs on the rendered result, and
    // compose_three_row_layout_test.dart owns that one (didExceedMaxLines).
    // What belongs HERE is the promise: after this card the sentence claims a
    // mechanism, so if the fold is ever removed this assertion is the thing
    // that says the copy became a promise nothing keeps (15 §2.0).
    for (final AppLocale locale in AppLocale.values) {
      final String hint = AppStrings.of(locale).composeModeSwitchClearsHint;
      expect(
        hint,
        contains(AppStrings.of(locale).recordOnly),
        reason: 'the $locale hint does not name the record-only destination — '
            'it still only says what disappears',
      );
    }
  });
}
