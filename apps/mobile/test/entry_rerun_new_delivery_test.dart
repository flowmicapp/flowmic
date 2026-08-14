// 🔴 Card F3 (0.3.0) — long-press re-run = re-run the **original text** under
// the **current mode**, then send it to the PC **as a new delivery**; the PC
// **adds a new row**, does not replace.
//
// owner 2026-08-04 ruling ③ + confirmation point A (docs/decisions/2026-08-04-owner-ten-rulings-
// 0.3.0.md:96-107): 「Re-send it as a new delivery to the PC; the PC receives a new
// row (not a replacement of the old one)」，「手机侧那一行原来已被结算成终态，所以
// 「重跑」不是改它，而是产出一条新的投递；两行都留在时间线上」.
//
// WHAT THIS FILE IS FOR THAT entry_reprocess_test.dart IS NOT. That file pins the
// GA-13 half of the action — the source is the IMMUTABLE original, a failed run
// leaves the row alone, realtime is refused up front — and those still hold. This
// file pins the half the ruling CHANGED: a re-run now produces a second row and a
// second DELIVERY, so every question "how did this one go out" has to be
// answerable for it exactly as for a spoken utterance — fresh request_id,
// persist-to-disk before send, addressed by `target_pc_id`, and the PC's own
// inject:result as the only proof.
//
// The session is PAIRED for real (a queued ack carrying pc_id), because
// 🔴「绝不许串号」 is one of the assertions: a new delivery must carry its own
// complete addressing rather than "who is current".
//
// Plain `test()`, not testWidgets: the PTT chain is genuinely async and awaiting
// it inside a FakeAsync zone deadlocks (a scar this repo already wears).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/utterance_compose.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

const String kRerunPc = 'pc-card-f3-0001';

Map<String, Object?> _payloadOf(EventEnvelope e) =>
    Map<String, Object?>.from(e.data! as Map);

/// A REAL, connected, paired session — `pcId` comes from a genuine pair() ack,
/// the production path (PttSession.pair → enrichFromAck). No test-only setter is
/// used: a backdoor would let this file pass on a value nothing populates.
Future<PttSession> _pairedSession(FakeSocketTransport t) async {
  final PttSession session = newTestSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
  );
  // RV-89: pin the channel probe, or the fixture reads whatever is listening on
  // the dev machine's port (see inject_target_pc_id_test.dart for the full note).
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  t.defaultAck = <String, Object?>{
    'token': 'tok-card-f3-abcdefghijklmnopqrstuvwxyz1',
    'pairing_id': 'pair-card-f3-1',
    'pc_id': kRerunPc,
    'pc_name': 'Card F3 Test PC',
  };
  final PairResult r = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://127.0.0.1:41881',
  );
  expect(r.ok, isTrue, reason: 'setup: pairing must succeed');
  expect(session.pcId, kRerunPc, reason: 'setup: pcId comes from the real ack');
  t.defaultAck = <String, Object?>{'ok': true};
  await pumpEventQueue();
  return session;
}

class _Rig {
  _Rig._(this.transport, this.session) {
    store = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  static Future<_Rig> paired() async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    return _Rig._(t, await _pairedSession(t));
  }

  final FakeSocketTransport transport;
  final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  List<EventEnvelope> get injects => transport.emittedWhere(FlowMicEvents.injectRequest);
  List<EventEnvelope> get starts => transport.emittedWhere(FlowMicEvents.composeStart);

  /// A finished translate utterance: spoken, transformed, delivered.
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
    return store.entries.first;
  }

  /// Answer the LATEST compose:start (whatever its fresh correlation id is).
  Future<void> answerLatestRun(String output) async {
    final Map<String, Object?> start = _payloadOf(starts.last);
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': output,
      'request_id': start['request_id'],
    });
    await pumpEventQueue();
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

// ── Defect ① harness: the controller ALONE, so the timer is observable ──────────
class _RecordingHost implements UtteranceComposeHost {
  final List<String> done = <String>[];
  final List<String> failed = <String>[];
  final List<AiComposeFailure> reasons = <AiComposeFailure>[];
  int notifies = 0;

  @override
  void ucDone(String entryId, String processedText) => done.add('$entryId=$processedText');

  @override
  void ucFailed(String entryId, AiComposeOutcome outcome) {
    failed.add(entryId);
    reasons.add(outcome.reason);
  }

  @override
  void ucNotify() => notifies += 1;
}

/// Double-press, at the controller ALONE — because the leak IS the timer, and a 45 s
/// Timer that outlives its run cannot be observed through the chat page. The
/// window is shortened so the test does not have to wait out the real one.
class _Doubled {
  _Doubled._(this.t, this.host, this.uc, this.second);

  factory _Doubled.press() {
    final FakeSocketTransport t = FakeSocketTransport();
    final _RecordingHost host = _RecordingHost();
    final UtteranceComposeController uc = UtteranceComposeController(
      host: host,
      gate: ComposeGate(transport: t),
      watchdog: const Duration(milliseconds: 40),
    );
    final AiComposeFailure? first = uc.start(
      entryId: 'row-A', requestId: 'req-A', task: ComposeTask.translate, sourceText: '甲',
    );
    expect(first, isNull, reason: 'setup: the first press really started');
    // The second press, on ANOTHER row — the shape that matters, because a
    // refusal here must not disturb run A in any way.
    final AiComposeFailure? second = uc.start(
      entryId: 'row-B', requestId: 'req-B', task: ComposeTask.translate, sourceText: '乙',
    );
    return _Doubled._(t, host, uc, second);
  }

  final FakeSocketTransport t;
  final _RecordingHost host;
  final UtteranceComposeController uc;
  final AiComposeFailure? second;

  Future<void> dispose() async {
    uc.dispose();
    await t.close();
  }
}

void main() {
  // ── Card F3 semantics ─────────────────────────────────────────────────────
  test('re-run produces a NEW row and a NEW delivery; the old row is not touched',
      () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry old = await rig.seedTranslatedRow();
    expect(rig.injects, hasLength(1), reason: 'setup: the original was delivered');

    expect(rig.controller.reprocessEntry(old), isNull);
    // The run re-reads the IMMUTABLE original and correlates on a FRESH id —
    // reusing the utterance's id would make the two runs indistinguishable.
    final Map<String, Object?> start = _payloadOf(rig.starts.last);
    expect(start['source_text'], '你好世界');
    expect(start['request_id'], isNot(old.clientId));
    await rig.answerLatestRun('HELLO WORLD');

    // ① the PC adds a new row ⇒ the phone also adds a new row. Both faces stay on the timeline.
    expect(rig.store.entries, hasLength(2));
    final TimelineEntry fresh = rig.store.entries.first;
    final TimelineEntry stale = rig.store.findById(old.id)!;
    expect(fresh.id, isNot(old.id));

    // ② the OLD row is untouched — every field, not just the face. It is a true
    // record of what was really delivered, and 06 §5「已注入 PC 的文本永不回改」
    // applies to the row that says so.
    expect(stale.outputText, 'hello world');
    expect(stale.sourceText, '你好世界');
    expect(stale.status, old.status);
    expect(stale.updatedAt, old.updatedAt);
    expect(stale.lastResentAt, isNull, reason: 'this is not a resend, the old row was not sent again');

    // ③ the NEW row is a full utterance row built from the ORIGINAL words.
    expect(fresh.sourceText, '你好世界', reason: 'R5: the original is what re-ran');
    expect(fresh.outputText, 'HELLO WORLD');
    expect(fresh.processedText, 'HELLO WORLD');
    expect(fresh.processMode, 'translate');
    expect(fresh.showsSourceLine, isTrue, reason: 'the 原文 line lights up');
    expect(fresh.clientId, isNot(old.clientId), reason: 'a new request_id');
    expect(fresh.durationMs, old.durationMs, reason: 'the same utterance, spoken for the same duration');
    // 15 册 §2.4 row 4: 「现在」 is the new row's birth time — this product did
    // not exist until this run finished.
    expect(
      fresh.createdAt.isBefore(old.createdAt),
      isFalse,
      reason: 'the new row\'s birth time cannot be earlier than the row it re-ran',
    );

    // ④ the full delivery chain. A SECOND inject:request, addressed on its own.
    expect(rig.injects, hasLength(2));
    final Map<String, Object?> p = _payloadOf(rig.injects.last);
    expect(p['text'], 'HELLO WORLD');
    expect(p['source'], 'llm', reason: '08 §5 provenance: this is an LLM product');
    expect(p['request_id'], fresh.clientId, reason: 'A-58 echo lands on the NEW row');
    expect(p['entry_id'], fresh.id);
    // 🔴 never mix IDs — the frame carries its OWN addressing, from the pairing ack.
    expect(p['target_pc_id'], kRerunPc);
    // RV-74: the ROW's mode, so the PC's row is not minted as realtime(guess).
    expect(p['mode'], 'translate');
    // 15 册 §2.5e-1 row 2: a user manual action is unconditionally expected — never `deferred`.
    expect(p['inject_origin'], 'live');
    expect(p['created_at'], fresh.createdAt.toUtc().toIso8601String(),
        reason: 'the same value on both ends: the phone new row\'s birth time');
    expect(p['source_text'], '你好世界');

    await rig.dispose();
  });

  test('re-run uses the mode captured AT THE PRESS, not the chip as it moved after',
      () async {
    // The LLM run is seconds wide and the mode chip is one tap away. Re-reading
    // `c.mode` in the terminal would deliver a row whose own `mode` field and
    // whose product disagree — the RV-74 shape, one row answering twice.
    final _Rig rig = await _Rig.paired();
    final TimelineEntry old = await rig.seedTranslatedRow();

    expect(rig.controller.reprocessEntry(old), isNull);
    expect(_payloadOf(rig.starts.last)['task'], 'translate');
    rig.controller.setMode(FlowMode.organize); // …mid-flight
    await rig.answerLatestRun('HELLO WORLD');

    final TimelineEntry fresh = rig.store.entries.first;
    expect(fresh.mode, FlowMode.translate);
    expect(fresh.processMode, 'translate');
    expect(_payloadOf(rig.injects.last)['mode'], 'translate');
    await rig.dispose();
  });

  test('a 「仅记录」 row re-runs and is STILL 仅记录 — 「对谁说的」 is inherited',
      () async {
    // §4.0 C: it was never meant for the PC. A re-run is a new delivery of the
    // same intent, not a change of mind about where the words go.
    final _Rig rig = await _Rig.paired();
    rig.controller.setMode(FlowMode.translate);
    rig.controller.destination.toggle(); // → 仅记录
    await rig.controller.pttDown();
    await rig.controller.pttUp();
    rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '留在手机上的翻译',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
    });
    await pumpEventQueue();
    await rig.answerLatestRun('Kept on the phone.');
    final TimelineEntry old = rig.store.entries.first;
    expect(rig.injects, isEmpty, reason: 'setup: 「留在手机」');

    expect(rig.controller.reprocessEntry(old), isNull);
    await rig.answerLatestRun('KEPT ON THE PHONE.');

    expect(rig.store.entries, hasLength(2));
    expect(rig.store.entries.first.outputText, 'KEPT ON THE PHONE.');
    expect(rig.store.entries.first.delivery, old.delivery);
    expect(rig.injects, isEmpty, reason: 'a 「仅记录」 re-run still does not leave the phone');
    await rig.dispose();
  });

  // ── Defect ① double-press ────────────────────────────────────────────────
  test('defect ①: a second press is REFUSED (busy) and the first run still lands',
      () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry old = await rig.seedTranslatedRow();
    final int startsBefore = rig.starts.length;

    expect(rig.controller.reprocessEntry(old), isNull);
    // The double press. Before this card it OVERWROTE the live run.
    expect(rig.controller.reprocessEntry(old), AiComposeFailure.busy);
    expect(rig.starts.length, startsBefore + 1,
        reason: 'the refusal happened BEFORE the wire — one frame, not two');

    // The FIRST press's result is not evicted: its reply still finds its run.
    await rig.answerLatestRun('FIRST PRESS RESULT');
    expect(rig.store.entries, hasLength(2));
    expect(rig.store.entries.first.outputText, 'FIRST PRESS RESULT');
    expect(rig.injects, hasLength(2));
    await rig.dispose();
  });

  test('defect ①: double-press — the FIRST press\'s result is not evicted by the second',
      () async {
    final _Doubled d = _Doubled.press();
    // Run A's terminal arrives. Without the guard `_requestId` is already
    // 'req-B', so A's own reply no longer matches it and [onEvent] DROPS it —
    // the press the user actually made produces nothing and row-A never settles.
    d.uc.onEvent(const AiComposeDone(outputText: '甲的结果', requestId: 'req-A'));
    expect(d.host.done, <String>['row-A=甲的结果']);
    expect(d.uc.isRunning, isFalse);
    // …and the refusal was TOLD to the caller: "pressed and nothing happened" is the mild half of
    // this defect, but a refusal nobody is told about is still a silent failure.
    expect(d.second, AiComposeFailure.busy,
        reason: 'the single slot is defended HERE, where the state is');
    await d.dispose();
  });

  test('defect ①: double-press — no watchdog is LEAKED (nothing fires after the terminal)',
      () async {
    // A SEPARATE test from the one above rather than two assertions in one: the
    // defect has two independent costs, and a single test would stop at the
    // first of them — so its red counter-check could only ever show one.
    final _Doubled d = _Doubled.press();
    d.uc.onEvent(const AiComposeDone(outputText: '甲的结果', requestId: 'req-A'));
    // Twice the (shortened) watchdog window. Without the guard, A's timer was
    // re-assigned rather than cancelled, so it survives its own run and fires —
    // aborting the SECOND run, i.e. a timer belonging to a run nobody is waiting
    // for settling a row it never started.
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(d.host.failed, isEmpty,
        reason: 'a leaked watchdog aborts a run it never started');
    expect(d.host.reasons, isEmpty);
    expect(d.host.done, hasLength(1), reason: 'exactly one press, exactly one result');
    await d.dispose();
  });

  // ── Defect ② a drop must abort ───────────────────────────────────────────
  test('defect ②: a link drop ABORTS the utterance run on the spot — no 45 s wait, '
      'and the microphone is released', () async {
    final _Rig rig = await _Rig.paired();
    rig.controller.setMode(FlowMode.translate);
    await rig.controller.pttDown();
    await rig.controller.pttUp();
    rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '断线的时候正在翻译',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1000,
    });
    await pumpEventQueue();
    expect(rig.controller.isProcessingUtterance, isTrue, reason: 'setup: processing');
    expect(rig.controller.canPtt, isFalse, reason: 'setup: the mic is held shut');

    rig.transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();

    // Settled IMMEDIATELY — the reply can only come back over the socket that
    // carried the request, so once the link is gone the run is already over.
    expect(rig.controller.isProcessingUtterance, isFalse);
    expect(rig.store.entries.first.status, EntryStatus.failed);
    // …and it says WHICH wall: 未连接, not the watchdog's 超时.
    expect(rig.controller.utteranceFailure?.reason, AiComposeFailure.notConnected);
    // Red line: an LLM run that did not finish injects NOTHING — least of all the
    // original words the user asked to have translated.
    expect(rig.injects, isEmpty);

    // 🔴 THE MICROPHONE — the user-visible half of this defect. `canPtt` is
    // three ANDs (connected · idle · !utteranceCompose.isRunning); the link
    // being down owns the first one, which is why the assertion is made on a
    // link that has come BACK. Before this card the third AND stayed false for
    // the full 45 s watchdog window, so the user could not speak on a healthy
    // link. Nothing here waits 45 s, and that is the whole point.
    rig.transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    expect(rig.controller.canPtt, isTrue);
    await rig.dispose();
  });
}
