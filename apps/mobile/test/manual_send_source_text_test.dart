// T-7 acceptance (0.2.63) — the frame sent after an AI rewrite must carry the
// very first original.
//
// Ruling = docs/decisions/2026-08-13-owner-0263-design-rulings.md §2 addendum #6
// (「发出去后也要关联的有最开始转录的原文」) + §3 row 6 (「通路已在 …
// **AI 改后文发送时原文是否真的落进该字段未证**」— this file is that "proof").
//
// ── 🔴 Measure first, then fix: the truth table this round measured (six cells
//    + two boundaries), before / after ──────────────────────────────────────
// Method = a real ChatController + fake transport, reading **the frame that
// actually left** (not reading the code).
//
//   mode        AI on the card?   before frame.source_text   after
//   realtime    no                null                       null      (the row face IS the original)
//   realtime    yes               **null** ✗                 original ✓  ← the missing half
//   translate   no                original ✓                 original ✓
//   translate   yes               original ✓                 original ✓  ← must not be overwritten
//   organize    no                original ✓                 original ✓
//   organize    yes               original ✓                 original ✓
//   typed D10   yes               **null** ✗                 typed original ✓
//
// 🔴 Rows 4/6 are where this card is easiest to get backwards: under
// translate/organize, the card AI transform's "pre-transform buffer" is an
// **earlier LLM product** (utterance-level organize/translate already ran), not
// what the user said. So the new branch can only **backfill**, never
// **overwrite** — overwriting would replace the real transcript original with
// an intermediate product, which is worse than leaving it empty. The "must not
// overwrite" case below is what nails this cell.
//
// ⚠️ The phone-row half **was already true**; this card did not change a word
// of it: a realtime row's face IS the original; a translate/organize row's
// `原文` line is lit by `TimelineEntry.showsSourceLine`. What was missing was
// always only the **frame** half (the PC original column), plus the PC display
// gate that judges by `mode` (apps/desktop/src/lib/source-line.ts, fixed in
// the same round).
//
// ⚠️ Still open (deliberately not this round; already registered in the
// report): when one ➤ covers N rows, the original on the frame is only the
// **first row**'s stretch (`representative` takes only `settle.first`). It is
// unrelated to AI and was already this way before the change; it belongs to
// another card.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/delivery_source_text.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

class _H {
  _H() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  Future<void> start() async {
    await controller.loadSendPolicy();
    transport.pushStatus(SocketStatus.connected);
  }

  /// One whole utterance: press, release, terminal final comes back.
  Future<void> speak(String text, int idx) async {
    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': false,
      'duration_ms': 900,
    });
    await pumpEventQueue();
  }

  String get _liveComposeId => Map<String, Object?>.from(
        transport.emittedWhere(FlowMicEvents.composeStart).last.data! as Map,
      )['request_id']! as String;

  void pushComposeDone(String out) =>
      transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
        'output_text': out,
        'request_id': _liveComposeId,
      });

  /// The card's AI pills — a transform over the BUFFER (never over a row).
  Future<void> cardTransform(String output) async {
    expect(controller.startAiCompose(ComposeTask.draftPolish), isNull,
        reason: 'precondition: the transform on the card actually started');
    pushComposeDone(output);
    await pumpEventQueue();
    expect(controller.buffer, output, reason: 'precondition: the transform result landed in the buffer');
  }

  Map<String, Object?> get lastInject => Map<String, Object?>.from(
        transport.emittedWhere(FlowMicEvents.injectRequest).last.data! as Map,
      );

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('🔴 realtime + card AI: the frame carries the very first transcript original (this cell was null before the change)', () async {
    // 🔴 Reverse control (really run this round): change the `originalText`
    // passed down from `_sendBuffer` to null (i.e. back to "only ask the
    // row"), and this case goes red on the spot:
    //   Expected: '我说的原话'
    //     Actual: <null>
    // Restored, then green again.
    final _H h = _H();
    await h.start();
    await h.speak('我说的原话', 0);
    await h.cardTransform('整理之后的话');
    await h.controller.sendBuffer();
    await pumpEventQueue();

    final Map<String, Object?> f = h.lastInject;
    expect(f['text'], '整理之后的话', reason: 'what left is the rewritten text (this card does not touch that half)');
    expect(
      f['source_text'],
      '我说的原话',
      reason: '🔴 owner addendum #6: after it is sent, the PC side must be able to look back at the very first transcript original',
    );
    expect(f['mode'], 'realtime');
    // The phone half already held: the row face IS the original; not a word was rewritten.
    expect(h.store.entries.first.displayText, '我说的原话');
    expect(h.store.entries.first.sourceText, '我说的原话');
    await h.dispose();
  });

  test('🔴 translate + card AI: the frame is still the transcript original, not that intermediate product', () async {
    final _H h = _H();
    await h.start();
    h.controller.setMode(FlowMode.translate);
    await h.speak('我说的原话', 0);
    // Utterance-level translate finishes first (this is the stretch folded into the buffer).
    h.pushComposeDone('the sentence I said');
    await pumpEventQueue();
    expect(h.controller.buffer, 'the sentence I said');

    await h.cardTransform('THE POLISHED SENTENCE');
    await h.controller.sendBuffer();
    await pumpEventQueue();

    expect(
      h.lastInject['source_text'],
      '我说的原话',
      reason: '🔴 the backfill branch overwrote the row\'s own original ⇒ the PC original column would show an LLM product, '
          'and what the user wants when they open 「原文」 is what they said',
    );
    expect(h.lastInject['text'], 'THE POLISHED SENTENCE');
    await h.dispose();
  });

  test('a delivery that never went through AI is byte-identical (same value before and after the change)', () async {
    final _H h = _H();
    await h.start();
    await h.speak('就这么发出去', 0);
    await h.controller.sendBuffer();
    await pumpEventQueue();
    // realtime and no second stretch of text ⇒ null is a **true answer**, not a
    // gap (RV-75: the PC side can tell "explicit null" from "this sender does
    // not speak this field").
    expect(h.lastInject['source_text'], isNull);
    await h.dispose();
  });

  test('typed + card AI (D10, no covering row): the frame carries the typed original', () async {
    final _H h = _H();
    await h.start();
    h.controller.setBuffer('我自己打的字');
    await h.cardTransform('润色之后的字');
    await h.controller.sendBuffer();
    await pumpEventQueue();
    expect(h.lastInject['source_text'], '我自己打的字');
    // ⚠️ Open ledger: that D10 **local row** still has only the rewritten text
    // (`buildDeliveryRow` is handed the delivery text, and `source_text` is
    // immutable once written — a red line). The two ends are asymmetric on
    // this cell; registered as an open item in the report, and this case does
    // not pretend they are symmetric.
    expect(h.store.entries.first.sourceText, '润色之后的字');
    await h.dispose();
  });

  test('send after restore original: there is no second stretch of text, so the frame no longer force-stuffs one', () async {
    // T-6 restore is used-once-then-gone ⇒ the body of this delivery **is** the
    // original; carrying another source_text would make the PC show an 「原文」
    // that, once expanded, is byte-identical to the body.
    final _H h = _H();
    await h.start();
    await h.speak('我说的原话', 0);
    await h.cardTransform('整理之后的话');
    expect(h.controller.restoreOriginal(), isTrue);
    await h.controller.sendBuffer();
    await pumpEventQueue();
    expect(h.lastInject['text'], '我说的原话');
    expect(h.lastInject['source_text'], isNull);
    await h.dispose();
  });

  // ── Pure-function layer: the priority itself (no session / socket / queue needed) ──
  group('originalForDelivery priority', () {
    TimelineEntry rowWithSource() {
      final TimelineStore s = newTestStore();
      final TimelineEntry built = s.buildFromUtterance(
        clientId: 'c1',
        mode: FlowMode.translate,
        delivery: Delivery.inject,
        text: '我说的原话',
      );
      final TimelineEntry? processed =
          s.applyProcessed(built.id, 'the sentence', FlowMode.translate);
      s.dispose();
      return processed!;
    }

    test('the row has its own original ⇒ use the row\'s (the AI copy must not overwrite)', () {
      expect(
        originalForDelivery(
          representative: rowWithSource(),
          deliveredText: 'POLISHED',
          aiOriginal: 'the sentence', // intermediate product
        ),
        '我说的原话',
      );
    });

    test('the row cannot answer ⇒ only then use the stretch this delivery itself knows', () {
      expect(
        originalForDelivery(
          representative: null,
          deliveredText: 'POLISHED',
          aiOriginal: '我打的字',
        ),
        '我打的字',
      );
    });

    test('neither side has one / blank / identical to the body ⇒ null (do not invent an original)', () {
      expect(
        originalForDelivery(
          representative: null,
          deliveredText: 'x',
          aiOriginal: null,
        ),
        isNull,
      );
      expect(
        originalForDelivery(
          representative: null,
          deliveredText: 'x',
          aiOriginal: '   ',
        ),
        isNull,
      );
      expect(
        originalForDelivery(
          representative: null,
          deliveredText: '一模一样',
          aiOriginal: '一模一样',
        ),
        isNull,
      );
    });
  });
}
