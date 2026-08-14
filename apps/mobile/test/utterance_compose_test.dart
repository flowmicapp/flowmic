// GA-01 acceptance — translate / organize as PRODUCT modes, against the REAL
// data layer (PttSession + ChatController + TimelineStore) with a fake socket.
//
// Before GA-01 the mode was metadata: whatever the user picked, the terminal
// final injected the raw STT text and the LLM never ran. These tests pin the
// four things that must now be true, and the last two are the red lines:
//   ① translate/organize emit compose:start with the right shape;
//   ② compose:done → the PRODUCT is injected and the row carries both faces;
//   ③ compose:error → the row fails, a banner is raised, and NOTHING is injected
//      (an LLM failure must never quietly become "we sent the original");
//   ④ the target language is a per-utterance snapshot, persisted device-locally.
//
// SPEC-REF: docs/rebuild/01-PRODUCT-SPEC.md §3.1; docs/rebuild/08-MOBILE-SPEC.md
//   §5; docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-01 (裁定 1-7).
//
// Plain `test()`, not testWidgets: the PTT chain is genuinely async and awaiting
// it inside a FakeAsync zone deadlocks (a scar this repo already wears).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

class _Harness {
  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  _Harness({bool cloudInstance = false}) {
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    store = newTestStore();
    destination = DestinationController(fixedRecordOnly: cloudInstance);
    prefs = InMemoryLocalPrefs();
    gate = TimelineSyncGate(transport: transport);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: prefs,
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  Future<void> speak(String text) async {
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

  String get echo => store.entries.first.clientId;

  Future<void> composeChunk(String delta) async {
    transport.pushIncoming(FlowMicEvents.composeChunk, <String, Object?>{
      'delta': delta,
      'request_id': echo,
    });
    await pumpEventQueue();
  }

  Future<void> composeDone(String output, {String? requestId}) async {
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': output,
      'request_id': requestId ?? echo,
    });
    await pumpEventQueue();
  }

  Future<void> composeError({String code = 'LLM_TIMEOUT'}) async {
    transport.pushIncoming(FlowMicEvents.composeError, <String, Object?>{
      'code': code,
      'message': 'model unreachable',
      'request_id': echo,
    });
    await pumpEventQueue();
  }

  List<EventEnvelope> get starts =>
      transport.emittedWhere(FlowMicEvents.composeStart);
  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
  /// 0.2.27: kept as an assertion target and now always EMPTY — the room row is
  /// retired (owner 架构裁定: 云端不存转录) and this is one of the places a
  /// re-added upload would surface first.
  List<EventEnvelope> get creates =>
      transport.emittedWhere(FlowMicEvents.historyCreate);

  Map<String, Object?> payloadOf(EventEnvelope e) =>
      Map<String, Object?>.from(e.data! as Map);

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    await session.dispose();
  }
}

void main() {
  test('translate: the terminal final starts a compose run instead of injecting '
      'the transcript', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('今天天气不错');

    expect(h.starts.length, 1, reason: 'the LLM leg really runs');
    final Map<String, Object?> p = h.payloadOf(h.starts.single);
    expect(p['task'], 'translate');
    expect(p['source_text'], '今天天气不错');
    expect(p['source_lang'], 'zh', reason: 'the STT language rides along');
    expect(p['target_lang'], 'en', reason: 'device-local default');
    expect(p['request_id'], h.echo, reason: 'A-58 correlation, not FIFO');
    expect(p['entry_id'], h.store.entries.first.id);
    expect(p['draft'], true, reason: 'the server never commits or injects');

    // Nothing has been delivered or synced yet: the product does not exist.
    expect(h.injects, isEmpty, reason: 'the raw transcript must NOT go out');
    expect(h.creates, isEmpty, reason: 'one-shot uplink — one create, after done');
    // The button is held so a second utterance cannot overtake this one.
    expect(h.controller.canPtt, isFalse);
    await h.dispose();
  });

  test('organize: same chain, organize task, no target language', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.organize);
    await h.speak('嗯就是那个 我们明天开会吧');
    final Map<String, Object?> p = h.payloadOf(h.starts.single);
    expect(p['task'], 'organize');
    expect(p.containsKey('target_lang'), isFalse,
        reason: 'organize rewrites in place — there is no language pair');
    await h.dispose();
  });

  test('realtime is untouched: no compose run, transcript injected as before',
      () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('直接上屏');
    expect(h.starts, isEmpty);
    expect(h.payloadOf(h.injects.single)['text'], '直接上屏');
    expect(h.payloadOf(h.injects.single)['source'], 'stt');
    await h.dispose();
  });

  test('compose:done → the PRODUCT is injected (source llm) and the row keeps '
      'both faces; exactly one history:create', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('今天天气不错');
    await h.composeChunk('The weather');
    // The live face is the REAL partial output, never the source text.
    expect(h.controller.liveText, 'The weather');
    await h.composeDone('The weather is nice today.');

    final Map<String, Object?> inj = h.payloadOf(h.injects.single);
    expect(inj['text'], 'The weather is nice today.');
    expect(inj['source'], 'llm', reason: '08 §5 provenance');
    final TimelineEntry row = h.store.entries.first;
    expect(row.sourceText, '今天天气不错', reason: 'immutable original');
    expect(row.outputText, 'The weather is nice today.');
    expect(row.processedText, 'The weather is nice today.');
    expect(row.processMode, 'translate');
    expect(row.showsSourceLine, isTrue, reason: 'the 原文 line lights up');
    expect(row.edited, isFalse, reason: 'the machine wrote it, not the user');
    // 0.2.27: this asserted the ONE create carrying the finished product
    // (one-shot uplink — output_text + source_text + mode on the wire item). Nothing
    // is uploaded any more; the same three facts are asserted on the LOCAL row
    // directly above, which is where they now live for good.
    expect(h.creates, isEmpty);
    // The gate reopens once the utterance has settled.
    expect(h.controller.canPtt, isTrue);
    await h.dispose();
  });

  test('RED LINE — compose:error fails the row, raises the banner, and injects '
      'NOTHING (never the original text)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('这句要翻译');
    await h.composeError(code: 'LLM_AUTH_FAIL');

    expect(h.injects, isEmpty,
        reason: 'CLAUDE.md 红线: LLM 失败不得静默回退注入原始 STT 文本');
    final TimelineEntry row = h.store.entries.first;
    expect(row.status, EntryStatus.failed);
    expect(row.sourceText, '这句要翻译', reason: 'the record survives');
    expect(row.processedText, isNull, reason: 'no half-product is kept');
    expect(h.controller.utteranceFailure?.code, 'LLM_AUTH_FAIL',
        reason: 'the user is told WHICH wall was hit');
    // The failure is still a record — it is just already recorded here, by its
    // owner. (Was: 'still a record worth syncing', asserting one create.)
    expect(h.creates, isEmpty);
    expect(h.store.entries, hasLength(1));
    expect(h.controller.canPtt, isTrue);
    h.controller.dismissUtteranceFailure();
    expect(h.controller.utteranceFailure, isNull);
    await h.dispose();
  });

  test('an empty compose:done is a failure, not a silent pass-through',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('这句要翻译');
    await h.composeDone('   ');
    expect(h.injects, isEmpty);
    expect(h.store.entries.first.status, EntryStatus.failed);
    expect(h.controller.utteranceFailure?.code, 'COMPOSE_EMPTY_OUTPUT');
    await h.dispose();
  });

  test('a reply for a different run is dropped, not written onto this row',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('这句要翻译');
    await h.composeDone('从别的运行来的', requestId: 'c99-someone-else');
    expect(h.injects, isEmpty);
    expect(h.store.entries.first.processedText, isNull);
    expect(h.controller.isProcessingUtterance, isTrue, reason: 'still waiting');
    await h.dispose();
  });

  test('a record-only translate utterance is still PROCESSED, just never '
      'delivered (裁定 3)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    h.controller.destination.toggle();
    await h.speak('留在手机上的翻译');
    expect(h.starts.length, 1, reason: 'the mode is the product, always');
    await h.composeDone('Kept on the phone.');
    expect(h.injects, isEmpty, reason: '「留在手机」');
    final TimelineEntry row = h.store.entries.first;
    expect(row.status, EntryStatus.noted);
    expect(row.processedText, 'Kept on the phone.');
    expect(h.creates, isEmpty,
        reason: '0.2.27: 「仅记录」 stays here structurally — nothing joins room '
            'sync, by default or otherwise');
    await h.dispose();
  });

  test('the target language is device-local, persisted, and snapshotted per '
      'utterance (裁定 2)', () async {
    final _Harness h = _Harness();
    h.connect();
    expect(h.controller.translateTarget, kTranslateTargetDefault);
    await h.controller.setTranslateTarget('zh');
    expect(await h.prefs.translateTarget(), 'zh');

    h.controller.setMode(FlowMode.translate);
    await h.speak('translate me');
    // Flipping it mid-flight must not re-aim the sentence already spoken.
    await h.controller.setTranslateTarget('en');
    expect(h.payloadOf(h.starts.single)['target_lang'], 'zh');
    await h.dispose();
  });

  test('a wire failure at compose:start settles the row instead of stranding it',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.controller.pttDown();
    await h.controller.pttUp();
    h.transport.failEmits = true; // the socket dies between PTT-up and the final
    h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '发不出去的一句',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
    });
    await pumpEventQueue();
    expect(h.store.entries.first.status, EntryStatus.failed);
    expect(h.controller.utteranceFailure, isNotNull);
    expect(h.injects, isEmpty);
    await h.dispose();
  });
}
