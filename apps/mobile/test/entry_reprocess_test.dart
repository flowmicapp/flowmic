import 'support/di.dart';
// GA-13 — entry-level re-translate/re-organize, against the REAL controller + store + sync
// gate over a fake socket.
//
// The three properties the card exists for:
//   ① the rewrite goes up as a MACHINE update, so the row does not claim a human
//      touched it (the `edited` bit is the whole reason this card was deferred
//      once — see docs/decisions/2026-07-25-ga-13-entry-reprocess-deferred.md);
//   ② it re-runs the IMMUTABLE source_text, never the current output, so a
//      reprocess is never a translation of a translation;
//   ③ it does NOT re-deliver. The user asked to re-translate, not to type into
//      whatever window happens to be focused.
//
// Plain `test()` on purpose: the PTT chain is genuinely async and awaiting it
// inside a testWidgets FakeAsync zone deadlocks (a scar this repo already wears).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    store = newTestStore();
    prefs = InMemoryLocalPrefs(sendPolicy: SendPolicy.direct);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: prefs,
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final InMemoryLocalPrefs prefs;
  late final ChatController controller;

  /// A finished translate utterance: spoken, transformed, delivered, synced.
  Future<TimelineEntry> seedTranslatedRow() async {
    controller.setMode(FlowMode.translate);
    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '你好世界',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': 'hello world',
      'request_id': store.entries.first.clientId,
    });
    await pumpEventQueue();
    // 0.2.27: `store.markSynced(...)` stood here to put the seeded row in the
    // 「the server has this row」 state the machine uplink needed. Both the flag and the
    // uplink are retired (owner architecture ruling: 云端不存转录).
    return store.entries.first;
  }

  /// 0.2.27: the `history:update` frames a reprocess/refine used to send. It is
  /// KEPT as an assertion target, and every assertion over it is now
  /// `isEmpty`: this file is where a re-added uplink would show up first.
  List<Map<String, Object?>> updatesSent() => transport
      .emittedWhere(FlowMicEvents.historyUpdate)
      .map((EventEnvelope e) => Map<String, Object?>.from(e.data! as Map))
      .toList();

  List<EventEnvelope> get composeStarts =>
      transport.emittedWhere(FlowMicEvents.composeStart);
  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
}

Future<void> main() async {
  test('GA-13: a reprocess re-runs the ORIGINAL words and syncs as a machine update', () async {
    final _Rig rig = _Rig();
    final TimelineEntry row = await rig.seedTranslatedRow();
    expect(row.outputText, 'hello world');
    final int injectsBefore = rig.injects.length;
    final int startsBefore = rig.composeStarts.length;

    expect(rig.controller.reprocessEntry(row), isNull);

    // ② the compose:start carries source_text, NOT the current output — a
    // reprocess of a translation must never be a translation of a translation.
    final Map<String, Object?> start =
        Map<String, Object?>.from(rig.composeStarts.last.data! as Map);
    expect(rig.composeStarts.length, startsBefore + 1);
    expect(start['source_text'], '你好世界');
    // A FRESH correlation id: this run is not the original utterance.
    expect(start['request_id'], isNot(row.clientId));

    rig.transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': 'HELLO WORLD',
      'request_id': start['request_id'],
    });
    await pumpEventQueue();

    // ⚠️⚠️ correction (Card F3, 2026-08-05) — THE THREE ASSERTIONS THAT USED TO STAND HERE
    // ARE KEPT VERBATIM, COMMENTED, because they were not wrong when written:
    // they encoded GA-13's own ruling (「rewrite the row in place, deliver nothing」)
    // and that ruling was OVERTURNED by owner confirmation point A on 2026-08-04
    // (docs/decisions/2026-08-04-owner-ten-rulings-0.3.0.md:96-107). Deleting them
    // silently would erase the only record that the behaviour CHANGED rather than
    // was fixed.
    //   expect(rig.store.findById(row.id)!.outputText, 'HELLO WORLD');   // ← old contract
    //   expect(rig.injects.length, injectsBefore);                       // ← old contract
    // What is true now: the OLD row is left alone and the product becomes a NEW
    // row with a NEW delivery. The full shape of that (fresh request_id,
    // target_pc_id addressing, inject_origin, created_at) is pinned in
    // entry_rerun_new_delivery_test.dart; here we assert only that this file's
    // subject — the OLD row — is untouched, and that the delivery really happened.
    expect(rig.store.findById(row.id)!.outputText, 'hello world');
    expect(rig.injects.length, injectsBefore + 1);
    expect(rig.store.entries.first.outputText, 'HELLO WORLD');
    // …the ORIGINAL is untouched (red line: source_text is immutable)…
    expect(rig.store.findById(row.id)!.sourceText, '你好世界');
    // ① …and NOTHING went up. Until 0.2.27 this asserted a machine
    // `history:update` carrying the rewrite (origin:'machine' so the `edited`
    // bit stayed clear). The server does not hold the row any more, so the
    // rewrite is complete when the local write is — and `edited` stays clear
    // for the original reason, which is asserted directly below.
    expect(rig.updatesSent(), isEmpty);
    expect(rig.store.findById(row.id)!.edited, isFalse);
    expect(rig.store.entries.first.edited, isFalse,
        reason: 'the machine wrote the new row too');
  });

  test('GA-13: a FAILED reprocess leaves the row exactly as it was', () async {
    final _Rig rig = _Rig();
    final TimelineEntry row = await rig.seedTranslatedRow();
    expect(rig.controller.reprocessEntry(row), isNull);
    final Map<String, Object?> start =
        Map<String, Object?>.from(rig.composeStarts.last.data! as Map);

    rig.transport.pushIncoming(FlowMicEvents.composeError, <String, Object?>{
      'code': 'LLM_TIMEOUT',
      'message': 'boom',
      'request_id': start['request_id'],
    });
    await pumpEventQueue();

    // The old text is still a TRUE record of what was delivered; overwriting it
    // — or its status — would rewrite delivery history that did not change.
    expect(rig.store.findById(row.id)!.outputText, 'hello world');
    expect(rig.updatesSent(), isEmpty);
    // …but the failure is LOUD.
    expect(rig.controller.utteranceFailure, isNotNull);
  });

  test('GA-13: realtime has no processing step, so a reprocess is refused up front', () async {
    final _Rig rig = _Rig();
    final TimelineEntry row = await rig.seedTranslatedRow();
    rig.controller.setMode(FlowMode.realtime);
    final int startsBefore = rig.composeStarts.length;

    expect(rig.controller.reprocessEntry(row), isNotNull);
    // Refused BEFORE the wire: no compose:start, no update, nothing to undo.
    expect(rig.composeStarts.length, startsBefore);
    expect(rig.updatesSent(), isEmpty);
    expect(rig.store.findById(row.id)!.outputText, 'hello world');
  });

  test('GA-13: a local-only 「notes-only」 row is reprocessed WITHOUT going to the server', () async {
    // red line 「notes-only entries are not synced to the PC by default」 does not stop applying because the user
    // re-ran the transform.
    final _Rig rig = _Rig();
    final TimelineEntry row = await rig.seedTranslatedRow();
    rig.store.applyEdit(row.id, 'hello world');
    rig.transport.emitted.clear();
    expect(rig.controller.reprocessEntry(rig.store.findById(row.id)!), isNull);
    final Map<String, Object?> start =
        Map<String, Object?>.from(rig.composeStarts.last.data! as Map);
    rig.transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': '本地重跑',
      'request_id': start['request_id'],
    });
    await pumpEventQueue();

    expect(rig.store.findById(row.id)!.outputText, 'hello world',
        reason: 'Card F3: a re-run leaves the old row alone (was: 本地重跑)');
    expect(rig.store.entries.first.outputText, '本地重跑',
        reason: 'the product is the NEW row');
    expect(rig.updatesSent(), isEmpty, reason: 'a phone-local row stays on the phone');
  });

  // ── GA-14: the late second-pass transcript ────────────────────────────────
  test('GA-14: a refine adopts the better text as a MACHINE update, never re-injects', () async {
    final _Rig rig = _Rig();
    rig.controller.setMode(FlowMode.realtime);
    await rig.controller.pttDown();
    await rig.controller.pttUp();
    rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '鹅鹅鹅曲项向天歌',
      'confidence': 0.8,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 20000,
    });
    await pumpEventQueue();
    final TimelineEntry row = rig.store.entries.first;
    final int injectsBefore = rig.injects.length;

    rig.transport.pushIncoming(FlowMicEvents.sttRefined, <String, Object?>{
      'text': '鹅鹅鹅，曲项向天歌。',
      'language': 'zh',
    });
    await pumpEventQueue();

    expect(rig.store.findById(row.id)!.outputText, '鹅鹅鹅，曲项向天歌。');
    expect(rig.store.findById(row.id)!.refinedAt, isNotNull);
    // NOT an edit: the bit means 「a person changed it」 and a second pass is not a person.
    expect(rig.store.findById(row.id)!.edited, isFalse);
    // 0.2.27: this asserted the machine `history:update` (origin:'machine').
    // Retired — an adopted refine is a local write on a row this phone owns.
    expect(rig.updatesSent(), isEmpty);
    // 06 §5 「text already injected into the PC is never rewritten」: the PC keeps the words it typed.
    expect(rig.injects.length, injectsBefore);
  });

  test('GA-14: a refine is DROPPED when the user already edited the row', () async {
    // Compare-and-set is the whole point: silently overwriting a person's edit
    // with a machine's opinion is worse than a slightly worse transcript.
    final _Rig rig = _Rig();
    rig.controller.setMode(FlowMode.realtime);
    await rig.controller.pttDown();
    await rig.controller.pttUp();
    rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '原始识别',
      'confidence': 0.8,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 20000,
    });
    await pumpEventQueue();
    final TimelineEntry row = rig.store.entries.first;
    rig.controller.editEntry(row, '我手改的');
    rig.transport.emitted.clear();

    rig.transport.pushIncoming(FlowMicEvents.sttRefined, <String, Object?>{
      'text': '机器的第二遍',
      'language': 'zh',
    });
    await pumpEventQueue();

    expect(rig.store.findById(row.id)!.outputText, '我手改的');
    expect(rig.updatesSent(), isEmpty);
  });

  test('GA-14: a refine never replaces a TRANSLATED face with raw source words', () async {
    // The row's face is the translation; the refine is a better transcript of
    // the ORIGINAL. Adopting it would swap in the wrong language entirely.
    final _Rig rig = _Rig();
    final TimelineEntry row = await rig.seedTranslatedRow();
    rig.transport.emitted.clear();
    rig.transport.pushIncoming(FlowMicEvents.sttRefined, <String, Object?>{
      'text': '你好世界（更准的中文）',
      'language': 'zh',
    });
    await pumpEventQueue();

    expect(rig.store.findById(row.id)!.outputText, 'hello world');
    expect(rig.updatesSent(), isEmpty);
  });
}
