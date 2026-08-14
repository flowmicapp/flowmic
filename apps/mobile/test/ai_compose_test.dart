// R6 T-3b ④ acceptance — the AI action row (polish/organize/translate) over the compose buffer.
//
// WIRE CONTRACT VERIFIED BEFORE WIRING (apps/server-core, read-only):
//   compose.handler.ts registers on EVERY socket (bootstrap.ts, inside the
//   per-connection block) and its whole auth surface is `getAuth(socket)` —
//   no auth.kind check, no resolveActingUser, no room membership, no getPc.
//   It answers the ORIGINATING socket with compose:chunk* → compose:done, or
//   compose:error. Room focus process_name is an OPTIONAL scenario hint that is
//   simply absent when no PC is around. ⇒ a paired phone can run this today
//   with zero server change; server test compose-focus.test.ts already drives
//   it from a socket whose auth.kind == 'mobile'.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.4; REDESIGN §6.2 ④ + §2 F-3
//   (acts on the buffer, does not inject; on failure keep the pre-operation
//   buffer); CLAUDE.md red line 「没有静默失败 / LLM 失败
//   不得静默回退」 and 「远端事件闭合的 latch 必须有本地看门狗」.
//
// Plain `test()` for everything that touches the async PTT chain; the watchdog
// case uses fakeAsync WITHOUT awaiting that chain (see the repo scar note).

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/ai_compose_controller.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

class _FlakyTransport extends FakeSocketTransport {
  String? refuse;

  @override
  void emit(String event, Object? payload) {
    if (event == refuse) throw StateError('socket closed');
    super.emit(event, payload);
  }
}

class _Harness {
  late final _FlakyTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final ChatController controller;

  _Harness({bool cloudInstance = false}) {
    transport = _FlakyTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    store = newTestStore();
    destination = DestinationController(fixedRecordOnly: cloudInstance);
    prefs = InMemoryLocalPrefs();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: prefs,
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  List<EventEnvelope> get starts =>
      transport.emittedWhere(FlowMicEvents.composeStart);

  Map<String, Object?> get lastStart =>
      Map<String, Object?>.from(starts.last.data! as Map);

  String get liveRequestId => lastStart['request_id']! as String;

  void pushChunk(String delta, {String? requestId}) =>
      transport.pushIncoming(FlowMicEvents.composeChunk, <String, Object?>{
        'delta': delta,
        'request_id': requestId ?? liveRequestId,
      });

  void pushDone(String output, {String? requestId}) =>
      transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
        'output_text': output,
        'request_id': requestId ?? liveRequestId,
      });

  /// A compose:done with NO request_id echo at all.
  void pushUnattributedDone() =>
      transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
        'output_text': '无归属的结果',
      });

  void pushError(String code, String message, {String? requestId}) =>
      transport.pushIncoming(FlowMicEvents.composeError, <String, Object?>{
        'code': code,
        'message': message,
        'request_id': requestId ?? liveRequestId,
      });

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('the three buttons emit compose:start with the FROZEN task literals, the '
      'buffer as source_text, and draft:true (never the injecting variant)',
      () async {
    final _Harness h = _Harness();
    h.connect();

    for (final (ComposeTask task, String wire) in <(ComposeTask, String)>[
      (ComposeTask.draftPolish, 'draft_polish'),
      (ComposeTask.organize, 'organize'),
      (ComposeTask.translate, 'translate'),
    ]) {
      h.controller.setBuffer('帮我看看这段话');
      expect(h.controller.startAiCompose(task), isNull);
      final Map<String, Object?> p = h.lastStart;
      expect(p['task'], wire);
      expect(p['source_text'], '帮我看看这段话');
      // F-2137: draft:true means "only change the buffer, do not inject". Omitting it would declare the
      // Tier-1 auto-compose intent, which DOES inject.
      expect(p['draft'], isTrue);
      expect(p['request_id'], isNotEmpty);
      // The phone does not hardcode a language pair — the server defaults
      // translate to `en`.
      expect(p.containsKey('target_lang'), isFalse);
      // Settle the run so the next iteration is not blocked.
      h.pushDone('ok');
      await pumpEventQueue();
    }
    // The AI row NEVER delivers: not one inject:request came out of any of it.
    expect(h.transport.emittedWhere(FlowMicEvents.injectRequest), isEmpty);
    await h.dispose();
  });

  test('chunks stream into the buffer as visible progress and done replaces it '
      'with the authoritative output_text', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('原始的一段话');
    h.controller.startAiCompose(ComposeTask.draftPolish);
    expect(h.controller.isAiComposing, isTrue);
    expect(h.controller.aiTask, ComposeTask.draftPolish);

    h.pushChunk('润色');
    await pumpEventQueue();
    expect(h.controller.buffer, '润色');
    h.pushChunk('后的文本');
    await pumpEventQueue();
    expect(h.controller.buffer, '润色后的文本');

    h.pushDone('润色后的完整文本');
    await pumpEventQueue();
    expect(h.controller.buffer, '润色后的完整文本');
    expect(h.controller.isAiComposing, isFalse);
    expect(h.controller.aiFailure, isNull);
    // No inject: the result waits for an explicit ➤.
    expect(h.transport.emittedWhere(FlowMicEvents.injectRequest), isEmpty);
    await h.dispose();
  });

  test('FAIL-LOUD: compose:error restores the pre-operation buffer AND raises a '
      'named failure carrying the server code — never a silent fallback',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('操作前的原文');
    h.controller.startAiCompose(ComposeTask.organize);
    // Half a result had already streamed in before the failure.
    h.pushChunk('半截结果');
    await pumpEventQueue();
    expect(h.controller.buffer, '半截结果');

    h.pushError('QUOTA_EXCEEDED', 'monthly llm quota exhausted');
    await pumpEventQueue();

    // F-3: on failure keep the pre-operation buffer — byte for byte, not the half-streamed text.
    expect(h.controller.buffer, '操作前的原文');
    expect(h.controller.isAiComposing, isFalse);
    final AiComposeOutcome failure = h.controller.aiFailure!;
    expect(failure.reason, AiComposeFailure.serverError);
    expect(failure.code, 'QUOTA_EXCEEDED');
    expect(failure.message, 'monthly llm quota exhausted');
    // Red line: a failed LLM run must NOT quietly deliver the raw text instead.
    expect(h.transport.emittedWhere(FlowMicEvents.injectRequest), isEmpty);

    h.controller.dismissAiFailure();
    expect(h.controller.aiFailure, isNull);
    await h.dispose();
  });

  test('FAIL-LOUD: an empty output_text is a failure, not a silently wiped '
      'buffer', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('别把我清空');
    h.controller.startAiCompose(ComposeTask.translate);
    h.pushDone('   ');
    await pumpEventQueue();

    expect(h.controller.buffer, '别把我清空');
    expect(h.controller.aiFailure!.reason, AiComposeFailure.serverError);
    expect(h.controller.aiFailure!.code, 'COMPOSE_EMPTY_OUTPUT');
    await h.dispose();
  });

  test('FAIL-LOUD: an emit that never leaves the device ends the run at once '
      'and leaves the buffer exactly as it was', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('发不出去的文本');
    h.transport.refuse = FlowMicEvents.composeStart;

    expect(
      h.controller.startAiCompose(ComposeTask.draftPolish),
      AiComposeFailure.wireFailed,
    );
    expect(h.controller.isAiComposing, isFalse);
    expect(h.controller.buffer, '发不出去的文本');
    expect(h.controller.aiFailure!.reason, AiComposeFailure.wireFailed);
    await h.dispose();
  });

  test('a reply from a SUPERSEDED run is dropped — a stale request_id may never '
      'overwrite the buffer the user has moved on to', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('当前文本');
    h.controller.startAiCompose(ComposeTask.draftPolish);

    h.pushChunk('幽灵', requestId: 'c99-stale');
    h.pushDone('幽灵结果', requestId: 'c99-stale');
    h.pushError('LLM_TIMEOUT', 'ghost', requestId: 'c99-stale');
    await pumpEventQueue();

    expect(h.controller.buffer, '当前文本');
    expect(h.controller.isAiComposing, isTrue, reason: 'the live run continues');
    expect(h.controller.aiFailure, isNull);

    // The live run still settles normally.
    h.pushDone('真正的结果');
    await pumpEventQueue();
    expect(h.controller.buffer, '真正的结果');
    await h.dispose();
  });

  test('a reply with NO request_id echo is dropped rather than applied blind',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('当前文本');
    h.controller.startAiCompose(ComposeTask.organize);

    h.pushUnattributedDone();
    await pumpEventQueue();
    expect(h.controller.buffer, '当前文本');
    expect(h.controller.isAiComposing, isTrue);
    await h.dispose();
  });

  test('losing the link mid-run closes the latch immediately (the reply can '
      'only come back over that socket) and restores the buffer', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('断线前的文本');
    h.controller.startAiCompose(ComposeTask.translate);
    h.pushChunk('部分');
    await pumpEventQueue();

    h.transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();

    expect(h.controller.isAiComposing, isFalse);
    expect(h.controller.buffer, '断线前的文本');
    expect(h.controller.aiFailure!.reason, AiComposeFailure.notConnected);
    await h.dispose();
  });

  test('discarding the buffer mid-run (mode switch) voids the run and says so — '
      'a later compose:done must not resurrect cleared text', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('要被清掉的文本');
    h.controller.startAiCompose(ComposeTask.draftPolish);
    final String stale = h.liveRequestId;

    h.controller.setMode(FlowMode.translate); // clear-buffer red line
    expect(h.controller.buffer, isEmpty);
    expect(h.controller.isAiComposing, isFalse);
    expect(h.controller.aiFailure!.reason, AiComposeFailure.aborted);

    h.pushDone('迟到的结果', requestId: stale);
    await pumpEventQueue();
    expect(h.controller.buffer, isEmpty, reason: 'the run was void');
    await h.dispose();
  });

  test('canAiCompose gate: needs a link, needs buffer text, and refuses a '
      'second concurrent run', () async {
    final _Harness h = _Harness();
    h.controller.setBuffer('有文本');
    expect(h.controller.canAiCompose, isFalse, reason: 'not connected');
    expect(
      h.controller.startAiCompose(ComposeTask.organize),
      AiComposeFailure.notConnected,
    );

    h.connect();
    expect(h.controller.canAiCompose, isTrue);

    h.controller.setBuffer('   ');
    expect(h.controller.canAiCompose, isFalse, reason: 'whitespace is empty');
    expect(
      h.controller.startAiCompose(ComposeTask.organize),
      AiComposeFailure.emptyBuffer,
    );

    h.controller.setBuffer('有文本');
    h.controller.startAiCompose(ComposeTask.organize);
    expect(h.controller.canAiCompose, isFalse, reason: 'already running');
    h.controller.startAiCompose(ComposeTask.translate);
    expect(h.starts, hasLength(1), reason: 'no second concurrent frame');
    await h.dispose();
  });

  test('W2.5-1: ChatController.canSend is false while an AI compose run is in '
      'flight and returns true once it settles — pinned at the controller so a '
      'future re-layout of the composer widget cannot silently drop the guard',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('待发送文本');
    expect(h.controller.canSend, isTrue,
        reason: 'baseline: connected, buffer, real PC, no send in flight, no '
            'AI run — every OTHER canSend condition already holds');

    h.controller.startAiCompose(ComposeTask.draftPolish);
    expect(h.controller.isAiComposing, isTrue);
    expect(h.controller.canSend, isFalse,
        reason: '➤ must not deliver text an in-flight AI run is still '
            'overwriting, and this must hold with NOTHING from the widget '
            'tree involved');

    h.pushDone('润色后的文本');
    await pumpEventQueue();
    expect(h.controller.isAiComposing, isFalse);
    expect(h.controller.canSend, isTrue);
    await h.dispose();
  });

  test('a cloud instance CAN run AI on the buffer: compose is a text round trip '
      'to the server, not a delivery that needs a PC', () async {
    final _Harness h = _Harness(cloudInstance: true);
    h.connect();
    h.controller.setBuffer('云端也能润色');
    expect(h.controller.canAiCompose, isTrue);
    expect(h.controller.startAiCompose(ComposeTask.draftPolish), isNull);
    expect(h.starts, hasLength(1));
    await h.dispose();
  });

  test('WATCHDOG: a run whose terminal event never arrives is closed locally, '
      'fail-loud, with the buffer restored (远端 latch 必须有本地看门狗)', () {
    fakeAsync((FakeAsync async) {
      final _Harness h = _Harness();
      h.connect();
      h.controller.setBuffer('等不到回复的文本');
      h.controller.startAiCompose(ComposeTask.organize);
      h.pushChunk('半截');
      async.flushMicrotasks();
      expect(h.controller.isAiComposing, isTrue);

      // Past the server's own 30 s budget, still nothing: still waiting.
      async.elapse(const Duration(seconds: 31));
      expect(h.controller.isAiComposing, isTrue,
          reason: 'a legitimately slow run must not be cut short');

      // Land just past the watchdog's deadline — [kWatchdog] is measured from
      // compose:start (t=0), not from the 31 s mark above, so the remaining
      // elapse is `kWatchdog - 31s`. Window C-5: elapsing a further FULL
      // [kWatchdog] here would overshoot past this card's banner auto-hide
      // window too (`kBannerAutoHideAfter`, armed the instant `aiFailure`
      // becomes non-null) and null it back out before the assertion below
      // ever reads it — fake_async fires every due timer inside one `elapse`
      // call, auto-hide included.
      async.elapse(AiComposeController.kWatchdog - const Duration(seconds: 31));
      expect(h.controller.isAiComposing, isFalse);
      expect(h.controller.buffer, '等不到回复的文本');
      expect(h.controller.aiFailure!.reason, AiComposeFailure.timeout);

      h.controller.dispose();
      h.destination.dispose();
      h.store.dispose();
    });
  });
}
