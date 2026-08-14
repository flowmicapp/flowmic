// R6 T-3a acceptance — the manual/direct send-policy full chain against the REAL
// data layer (PttSession) with a fake socket + fake recorder.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §5 + its 2026-08-13 correction block
//   (direct-send vs hold-then-send; final append/replace landing rule; 🔴 control
//   keys NEVER touch the local draft — 「clear wipes the local buffer」 was struck
//   by owner supplement #3, and the punctuation row is deleted outright);
//   master-plan §4.0 A (utterance = row; a DISCARD → already-final entries stay noted)
//   / §4.0 B (per-utterance snapshot) / §4.0 D (five-state = delivery truth
//   only); docs/strategy/R6-BACKLOG-AND-PLAN wave 2 T-3 ①②③;
//   docs/ui-design/2026-08-13-compose-band-redesign.md §4.
//
// Deliberately plain `test()` — the PTT chain is genuinely async, and awaiting it
// inside a testWidgets FakeAsync zone deadlocks (a scar this repo already wears).
// The widget-side contract lives in compose_band_widget_test.dart on fake
// callbacks instead.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
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

class _Harness {
  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  _Harness({
    SendPolicy policy = SendPolicy.direct,
    bool cloudInstance = false,
  }) {
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
      // Collapse the 1.5 s JUST_DONE dwell so a test can chain two utterances
      // (manual-send accumulation) without sleeping through it. The transition
      // itself is unchanged — only its duration.
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // Window B3-2c — identity, not handshake. A queued delivery is addressed to a MACHINE,
    // so a fixture with a live socket but no pairing has no destination and every
    // send is correctly refused `noPcTarget` (owner:「未配对的…不可能自动发向PC
    // 的」). This stamps the identities through the PRODUCTION method; it dials
    // nothing and emits nothing, so no assertion about emitted frames moves.
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    destination = DestinationController(fixedRecordOnly: cloudInstance);
    prefs = InMemoryLocalPrefs(sendPolicy: policy);
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

  /// Drive a full utterance: PTT down → up → terminal stt:final(text).
  /// [midFlip] runs AFTER audio:start, to prove the policy snapshot holds.
  Future<void> speak(String text, {void Function()? midFlip}) async {
    await controller.pttDown();
    midFlip?.call();
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

  /// GA-01: complete the LLM leg of a translate/organize utterance. The echo is
  /// the row's clientId, exactly what the phone sent as request_id — a wrong
  /// echo is DROPPED by design, so getting this right is part of the contract.
  Future<void> completeCompose(String output) async {
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': output,
      'request_id': store.entries.first.clientId,
    });
    await pumpEventQueue();
  }

  /// GA-01: fail the LLM leg the way the server does.
  Future<void> failCompose({String code = 'LLM_TIMEOUT'}) async {
    transport.pushIncoming(FlowMicEvents.composeError, <String, Object?>{
      'code': code,
      'message': 'boom',
      'request_id': store.entries.first.clientId,
    });
    await pumpEventQueue();
  }

  List<EventEnvelope> get composeStarts =>
      transport.emittedWhere(FlowMicEvents.composeStart);

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
  List<EventEnvelope> get controlKeys =>
      transport.emittedWhere(FlowMicEvents.controlKey);

  Map<String, Object?> payloadOf(EventEnvelope e) =>
      Map<String, Object?>.from(e.data! as Map);

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  // ── ② manual policy: the final does NOT deliver ────────────────────────
  test('manual: the terminal final lands in the buffer and injects NOTHING', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('明天下午三点开会');

    expect(h.controller.buffer, '明天下午三点开会');
    expect(h.injects, isEmpty, reason: 'manual must not auto-deliver');
    // §4.0 A: the utterance still built its row — the record exists, only the
    // DELIVERY is withheld, and it reads ⏳ awaiting the explicit send.
    expect(h.store.entries.length, 1);
    expect(h.store.entries.first.status, EntryStatus.cached);
    await h.dispose();
  });

  // RV-74 flipped this assertion. It used to read 「…and NO mode field (this call
  // site never supplies one)」, which described the code accurately and was
  // nevertheless pinning a bug: an absent mode makes the PC's row builder guess
  // 'realtime' and the desktop then hides the 「原文」 column on every translated
  // row and files them all under 实时. A test that pins 「the field is missing」 is
  // only as good as the reason the field is missing.
  test('direct: the terminal final delivers inject:request{source:stt} with both '
      'correlation keys AND the mode the row was produced under — realtime is '
      "sent as 'realtime', never omitted (RV-74)", () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('明天下午三点开会');

    expect(h.controller.buffer, isEmpty, reason: 'direct never buffers');
    expect(h.injects.length, 1);
    final Map<String, Object?> p = h.payloadOf(h.injects.single);
    expect(p['text'], '明天下午三点开会');
    expect(p['source'], 'stt');
    expect(p['request_id'], h.store.entries.first.clientId);
    expect(p['entry_id'], h.store.entries.first.id);
    // PRESENT and equal to the row's own snapshot. Asserted against the entry
    // rather than against the literal 'realtime' so the frame and the phone's own
    // timeline can never be shown to disagree by this test passing.
    expect(p['mode'], 'realtime');
    expect(p['mode'], h.store.entries.first.mode.name);
    // 卡 M: the row-transit fields ride this exact frame too (created_at is
    // always present; device_label needs the process-lifetime cache warmed,
    // which this harness does not do — see inject_target_pc_id_test.dart for
    // the full field-by-field proof, including a warmed device_label).
    expect(p.containsKey('created_at'), isTrue);
    expect(p.containsKey('source_text'), isTrue);
    await h.dispose();
  });

  test('audio:start carries the send_policy, and history:create is emitted '
      'BEFORE the direct inject:request', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('你好');
    final Map<String, Object?> start = h.payloadOf(
      h.transport.emittedWhere(FlowMicEvents.audioStart).single,
    );
    expect(start['send_policy'], 'direct');
    final List<String> names = h.transport.emittedNames;
    expect(
      names.indexOf(FlowMicEvents.historyCreate) <
          names.indexOf(FlowMicEvents.injectRequest),
      isTrue,
      reason: 'the PC result keys back onto the stored row — create must land first',
    );
    await h.dispose();
  });

  // ── policy is SNAPSHOTTED at PTT-down (§4.0 B rhythm) ──────────────────
  test('flipping to manual mid-utterance does NOT change the in-flight one', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak(
      '这句仍然直发',
      midFlip: () => h.controller.setSendPolicy(SendPolicy.manual),
    );
    expect(h.controller.activeSendPolicy, SendPolicy.direct);
    expect(h.injects.length, 1, reason: 'the snapshot said direct');
    expect(h.controller.buffer, isEmpty);
    // …and the NEXT utterance honours the new policy.
    await h.speak('这句进缓冲');
    expect(h.controller.activeSendPolicy, SendPolicy.manual);
    expect(h.injects.length, 1, reason: 'no second auto-delivery');
    expect(h.controller.buffer, '这句进缓冲');
    await h.dispose();
  });

  test('flipping to direct mid-utterance does NOT deliver the in-flight one', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak(
      '这句仍进缓冲',
      midFlip: () => h.controller.setSendPolicy(SendPolicy.direct),
    );
    expect(h.controller.activeSendPolicy, SendPolicy.manual);
    expect(h.injects, isEmpty);
    expect(h.controller.buffer, '这句仍进缓冲');
    await h.dispose();
  });

  test('audio:start carries send_policy manual when the policy is manual', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.controller.pttDown();
    final Map<String, Object?> start = h.payloadOf(
      h.transport.emittedWhere(FlowMicEvents.audioStart).single,
    );
    expect(start['send_policy'], 'manual');
    await h.dispose();
  });

  // ── ② the explicit ➤ ───────────────────────────────────────────────────
  test('➤ emits inject:request{source:manual, mode} and clears the buffer', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('要发的内容');
    // GA-01: in translate mode the LLM leg runs first, and it is the PRODUCT
    // that folds into the buffer. (Pre-GA-01 the raw transcript folded straight
    // in — which is the bug, not the baseline.)
    await h.completeCompose('要发的内容');

    expect(await h.controller.sendBuffer(), isNull);
    expect(h.injects.length, 1);
    final Map<String, Object?> p = h.payloadOf(h.injects.single);
    expect(p['text'], '要发的内容');
    expect(p['source'], 'manual');
    expect(p['mode'], 'translate', reason: 'F-2361: mode rides the manual frame');
    expect(h.controller.buffer, isEmpty);
    await h.dispose();
  });

  test('➤ after a user edit sends the EDITED text, not the raw transcript', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('原始转写');
    h.controller.setBuffer('改过的文本');
    await h.controller.sendBuffer();
    expect(h.payloadOf(h.injects.single)['text'], '改过的文本');
    // The row's source_text is untouched — the immutable original stands.
    expect(h.store.entries.first.sourceText, '原始转写');
    await h.dispose();
  });

  test('manual accumulates multiple utterances (F-2: append, single space) and '
      'ONE inject:result settles every row the send covered', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一段');
    await h.speak('第二段');
    expect(h.controller.buffer, '第一段 第二段');
    expect(h.store.entries.length, 2, reason: 'each utterance is its own entry');

    await h.controller.sendBuffer();
    final String requestId =
        h.payloadOf(h.injects.single)['request_id']! as String;
    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': true,
      'mode': 'sendinput',
      'request_id': requestId,
      'inject_target': <String, Object?>{
        'window_title': '微信',
        'process_name': 'WeChat.exe',
        'injected_at': '2026-07-25T09:00:00Z',
      },
    });
    await pumpEventQueue();
    expect(
      h.store.entries.every((TimelineEntry e) => e.status == EntryStatus.injected),
      isTrue,
      reason: 'one delivery action settles all the rows it covered',
    );
    await h.dispose();
  });

  // ── ① toolbar: the four remote control keys (the local punctuation half was
  //    deleted by T-1, owner Q2㋐) ──────────────────────────────────────────
  test('the four QuickAction keys emit control:key with the whitelisted kind', () async {
    final _Harness h = _Harness();
    h.connect();
    for (final ControlKeyKind k in <ControlKeyKind>[
      ControlKeyKind.enter,
      ControlKeyKind.backspace,
      ControlKeyKind.undo,
    ]) {
      expect(h.controller.sendControlKey(k), isTrue);
    }
    expect(
      h.controlKeys.map((EventEnvelope e) => h.payloadOf(e)['kind']).toList(),
      <String>['enter', 'backspace', 'undo'],
    );
    // Control keys are NOT injections — nothing leaks onto the inject path.
    expect(h.injects, isEmpty);
    await h.dispose();
  });

  test('🔴 ✕ clear: emits control:key{clear} and mints its row — and LEAVES THE '
      'LOCAL DRAFT ALONE (owner 2026-08-13 supplement #3)', () async {
    // 🔴 THIS CASE WAS INVERTED BY T-1, and its old title is the whole story:
    // 「✕ clear: emits control:key{clear}, **wipes the local buffer**, and the
    // already-final rows **settle at 📥 noted**」. Both of those middle clauses
    // are now forbidden.
    //
    // ⚠️ The contract §8 test-fate table **did not list this one** (it only
    // named the four places in send_buffer_race_test). It is the fifth of
    // the same family, and it is the **only** case written whole from the
    // angle "what happened locally after the user pressed ✕" ⇒ miss it, and
    // the decoupling cut goes red here, looking like "the fix was written
    // wrong".
    //
    // owner's original words:「在没点发送转录内容的按钮前，点控制键按钮也是独立投递，不会
    // 并入当前的未发送转录消息中」. ✕ clears the **PC** focus window.
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('要丢掉的内容');
    expect(h.store.entries.first.status, EntryStatus.cached);

    h.controller.sendControlKey(ControlKeyKind.clear);
    // ① The frame still goes out as usual — what was split is the local
    // half, not this key.
    expect(h.payloadOf(h.controlKeys.single)['kind'], 'clear');
    // ② 🔴 The draft is still there as-is.
    expect(
      h.controller.buffer,
      '要丢掉的内容',
      reason: '✕ cleared the local draft ⇒ the old coupling is still there (08 §5 correction block)',
    );
    // ③ 🔴 The rows it covered were not settled either — settling them to
    //    📥 noted equals saying "this utterance will not be delivered",
    //    while it is sitting in the buffer waiting for ➤.
    final List<TimelineEntry> said = h.store.entries
        .where((TimelineEntry e) => !e.isControl)
        .toList();
    expect(said.length, 1, reason: 'the record is the ontology — the row survives');
    expect(
      said.first.status,
      EntryStatus.cached,
      reason: '✕ settled a still-buffered row to noted ⇒ the other half of the old coupling is still there',
    );
    // ④ REQ-12-13 did not move a word: the frame left this device ⇒ mint a key row.
    expect(
      h.store.entries.where((TimelineEntry e) => e.isControl).single.controlKind,
      'clear',
    );
    await h.dispose();
  });

  test('🔴 discard ≠ clear-the-screen: a local discard still clears the buffer and settles the rows it covered to noted', () async {
    // After splitting the coupling, the "discard" path must still be complete
    // — contract §4-3 "not one fewer entry point for discarding a draft".
    // Without this case, the case above read alone would read as "after ✕
    // nobody can clear the buffer".
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('要丢掉的内容');

    h.controller.discardBuffer();
    expect(h.controller.buffer, isEmpty);
    expect(h.store.entries.first.status, EntryStatus.noted);
    // …and it **did not** casually send anything to the PC: the two ✕
    // outcomes are opposite; this is the reverse half of that distinction.
    expect(h.controlKeys, isEmpty);
    await h.dispose();
  });

  test('mode switch clears the buffer and settles its rows at noted too', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('切模式前说的');
    h.controller.setMode(FlowMode.translate);
    expect(h.controller.buffer, isEmpty);
    expect(h.store.entries.first.status, EntryStatus.noted);
    await h.dispose();
  });

  // ── ③ guards ───────────────────────────────────────────────────────────
  test('empty buffer: canSend false and ➤ fails loud without emitting', () async {
    final _Harness h = _Harness();
    h.connect();
    expect(h.controller.canSend, isFalse);
    expect(await h.controller.sendBuffer(), ComposeSendFailure.emptyBuffer);
    expect(h.controller.sendFailure, ComposeSendFailure.emptyBuffer);
    expect(h.injects, isEmpty);
    await h.dispose();
  });

  test('a whitespace-only buffer counts as empty', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('   ');
    expect(h.controller.canSend, isFalse);
    expect(await h.controller.sendBuffer(), ComposeSendFailure.emptyBuffer);
    await h.dispose();
  });

  test('disconnected: canCompose/canSend false, ➤ and control keys fail loud', () async {
    final _Harness h = _Harness();
    h.controller.setBuffer('有内容');
    expect(h.controller.canCompose, isFalse);
    expect(h.controller.canSend, isFalse);
    expect(await h.controller.sendBuffer(), ComposeSendFailure.notConnected);
    expect(h.controller.sendControlKey(ControlKeyKind.enter), isFalse);
    expect(h.injects, isEmpty);
    expect(h.controlKeys, isEmpty);
    expect(h.controller.sendFailure, ComposeSendFailure.notConnected);
    h.controller.dismissSendFailure();
    expect(h.controller.sendFailure, isNull);
    await h.dispose();
  });

  test('cloud instance: ➤ is dead (no PC focus window) and says so', () async {
    final _Harness h = _Harness(cloudInstance: true);
    h.connect();
    h.controller.setBuffer('给云端实例的内容');
    expect(h.controller.canSend, isFalse);
    expect(await h.controller.sendBuffer(), ComposeSendFailure.noPcTarget);
    expect(h.injects, isEmpty);
    await h.dispose();
  });

  test('record-only under MANUAL does not pre-load the send box either — 「留在'
      '手机」 must not be staged for accidental delivery (§4.0 C)', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    h.destination.setRecordOnly();
    await h.speak('留在手机的话');
    expect(h.controller.buffer, isEmpty);
    expect(h.injects, isEmpty);
    expect(h.store.entries.single.status, EntryStatus.noted);
    await h.dispose();
  });

  test('record-only utterance under direct is NOT injected (its row is noted)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.destination.setRecordOnly();
    await h.speak('留在手机的话');
    expect(h.injects, isEmpty);
    expect(h.store.entries.first.status, EntryStatus.noted);
    await h.dispose();
  });

  // ── policy persistence (device-local, D4: never a settings section) ─────
  test('the policy round-trips through local prefs', () async {
    final _Harness h = _Harness();
    expect(h.controller.sendPolicy, SendPolicy.direct);
    await h.controller.toggleSendPolicy();
    expect(h.controller.sendPolicy, SendPolicy.manual);
    expect(await h.prefs.sendPolicy(), SendPolicy.manual);
    await h.controller.toggleSendPolicy();
    expect(await h.prefs.sendPolicy(), SendPolicy.direct);
    await h.dispose();
  });

  test('an unset / unrecognised stored policy falls back to direct', () {
    expect(sendPolicyFromWire(null), SendPolicy.direct);
    expect(sendPolicyFromWire('nonsense'), SendPolicy.direct);
    expect(sendPolicyFromWire('manual'), SendPolicy.manual);
    expect(sendPolicyFromWire('direct'), SendPolicy.direct);
  });
}
