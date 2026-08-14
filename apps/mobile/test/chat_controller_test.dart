// WP-R3-2 acceptance — the orchestration hub end-to-end against the REAL R3-1
// data layer (PttSession) with a fake socket + fake recorder: utterance→row,
// cancel→no-row, fixed per-utterance delivery, emit-side noted filter, five-
// state write-back, mode-switch clears buffer, reconnect resets destination.
// SPEC-REF: master-plan §4.0 A-D; 08-MOBILE-SPEC §2-5.

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart' show ComposeSendFailure;
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The same shape as main.dart's `_SessionInstanceOwner` — reads on every call,
/// because the connection changes under the store's feet.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Harness {
  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  /// Steerable wall clock for the R6 T-5d recording timer.
  DateTime now = DateTime.utc(2026, 7, 25, 9);

  _Harness() {
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
    );
    // Mirror main.dart's wiring: rows are stamped with the instance they were
    // spoken to at BIRTH, and the chat view narrows on that. Without the probe
    // the harness's rows are all 未知实例, so anything reading
    // `entriesForInstance` would be silently testing the empty state.
    store = newTestStore(owner: _SessionOwner(session));
    destination = DestinationController();
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
      clock: () => now,
      // owner ② tests: collapse the give-up window so a disconnect edge can be
      // driven to its conclusion without sleeping through the real 10s.
      sessionLostAfter: const Duration(milliseconds: 40),
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  /// Connect AND pair for real, so `session.connectedInstanceId` is populated.
  /// The chat view (and therefore anything that acts on "the most recent row") reads rows
  /// through `entriesForInstance`, so an unpaired harness would be exercising the
  /// empty state rather than the behaviour under test (same reason
  /// history_page_widget_test pairs its session).
  Future<void> connectPaired() async {
    transport.connectSucceeds = true;
    transport.ackQueue.add(<String, Object?>{
      'token': 'tok-chatctl-000000000000000000000',
      'pc_name': '书房电脑',
      'pc_instance_id': 'inst-study',
    });
    await session.pair(PairEntry.parse('1234'), endpoint: 'ws://192.0.2.5:41879');
    transport.pushStatus(SocketStatus.connected);
  }

  /// Drive a full utterance: PTT down → up → terminal stt:final(text).
  Future<void> speak(
    String text, {
    String? polish,
    String? polishReason,
  }) async {
    // 🔴 N1-B2 — release the JUST_DONE latch so the NEXT `pttDown` really
    // succeeds. Without it the second `speak()` in a test is refused by `canPtt`
    // (still JUST_DONE), `session.pttDown` never runs and therefore never emits
    // `audio:start` — yet this helper pushes an `stt:final` anyway. That state
    // cannot occur on the wire: no `audio:start`, no engine, no final. It went
    // unnoticed because nothing checked that a final belongs to an utterance
    // that actually began.
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
      'polish': ?polish,
      'polish_reason': ?polishReason,
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

void main() {
  test('utterance-final builds a chat-flow row (§4.0 A)', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('明天下午三点开会');
    expect(h.store.entries.length, 1);
    expect(h.store.entries.first.displayText, '明天下午三点开会');
    // audio:start carried the fixed inject delivery.
    final EventEnvelope start = h.transport
        .emittedWhere(FlowMicEvents.audioStart)
        .single;
    expect((start.data as Map)['delivery'], 'inject');
    await h.dispose();
  });

  test('swipe-up cancel builds NO row (§4.0 A)', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttDown();
    await h.controller.pttCancel();
    await pumpEventQueue();
    expect(h.store.isEmpty, isTrue);
    await h.dispose();
  });

  test('record-only utterance → 📥 noted row + audio:start delivery:none + NO '
      'history:create (emit-side filter)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.destination.setRecordOnly();
    // Delivery is snapshotted at PTT-down; toggling back mid-utterance must NOT
    // change this utterance's delivery (§4.0 B).
    await h.controller.pttDown();
    h.destination.setInject();
    await h.controller.pttUp();
    h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '留在手机的一条',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
    });
    await pumpEventQueue();

    expect(h.store.entries.single.status, EntryStatus.noted);
    final EventEnvelope start = h.transport
        .emittedWhere(FlowMicEvents.audioStart)
        .single;
    expect((start.data as Map)['delivery'], 'none');
    // The whole point: the phone never forwarded it.
    expect(
      h.transport.emittedNames,
      isNot(contains(FlowMicEvents.historyCreate)),
    );
    await h.dispose();
  });

  test('inject utterance DELIVERS and uploads nothing (0.2.27)', () async {
    // Was: 'inject utterance emits history:create (gate open)'. The §4.0 C gate
    // and the room row are retired (owner architecture ruling: 云端不存转录), so what an
    // utterance bound for the PC does now is deliver — and only deliver.
    final _Harness h = _Harness();
    h.connect();
    await h.speak('这条要发到 PC');
    expect(h.transport.emittedNames, contains(FlowMicEvents.injectRequest));
    expect(h.transport.emittedNames, isNot(contains(FlowMicEvents.historyCreate)));
    await h.dispose();
  });

  test('inject:result flips the row ⏳ cached → ✓ injected (§4.0 D)', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('待投的一条');
    expect(h.store.entries.single.status, EntryStatus.cached);
    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': true,
      'mode': 'sendinput',
      'inject_target': <String, Object?>{
        'window_title': '记事本',
        'process_name': 'notepad',
        'injected_at': 'now',
      },
    });
    await pumpEventQueue();
    expect(h.store.entries.single.status, EntryStatus.injected);
    expect(h.store.entries.single.injectTarget!.processName, 'notepad');
    await h.dispose();
  });

  // N2 / RV-42 — this test used to assert `failed` for a `mode:'cached'` verdict,
  // which is precisely the defect: the wire said "not delivered, can re-deliver" and the phone
  // announced 「✗ 注入失败」 while the PC capsule said the other thing. 「Never
  // silent」 is unchanged and still asserted — the row leaves 投递中 and lands on
  // a settled truth; it is WHICH truth that was wrong.
  test(
    'inject:result ok:false + mode:cached → 📥 未投递, NOT ✗ (never silent)',
    () async {
      final _Harness h = _Harness();
      h.connect();
      await h.speak('没投递的一条');
      h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': false,
        'mode': 'cached',
        'error': 'target window closed',
      });
      await pumpEventQueue();
      final TimelineEntry row = h.store.entries.single;
      expect(row.status, isNot(EntryStatus.failed));
      expect(row.status, EntryStatus.cached);
      expect(row.undelivered, isTrue, reason: 'a verdict said so — not 投递中');
      expect(row.awaitingDelivery, isFalse);
      await h.dispose();
    },
  );

  // The reverse assertion, so the split cannot drift back into 「everything is
  // cached」: a verdict about the ACTION failing is still ✗, with its code.
  test('inject:result ok:false + mode:sendinput → ✗ failed with the code', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('会失败的一条');
    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': false,
      'mode': 'sendinput',
      'error': 'INJECT_SENDINPUT_FAIL',
    });
    await pumpEventQueue();
    final TimelineEntry row = h.store.entries.single;
    expect(row.status, EntryStatus.failed);
    expect(row.failureReason, 'INJECT_SENDINPUT_FAIL');
    expect(row.undelivered, isFalse);
    await h.dispose();
  });

  test(
    'mode switch clears the buffer (clear-buffer red line); ignored while recording',
    () async {
      final _Harness h = _Harness();
      h.connect();
      h.controller.setBuffer('半截缓冲');
      h.controller.setMode(FlowMode.translate);
      expect(h.controller.mode, FlowMode.translate);
      expect(h.controller.buffer, isEmpty);

      // Recording: a mode switch is a no-op (08 §2).
      await h.controller.pttDown();
      h.controller.setMode(FlowMode.organize);
      expect(h.controller.mode, FlowMode.translate);
      await h.dispose();
    },
  );

  test('focus:state feeds the header label', () async {
    final _Harness h = _Harness();
    h.connect();
    h.transport.pushIncoming(FlowMicEvents.focusState, <String, Object?>{
      'window_title': '和朋友的聊天',
      'process_name': 'WeChat',
    });
    await pumpEventQueue();
    expect(h.destination.headerLabel(AppStrings(AppLocale.zh)), 'WeChat');
    await h.dispose();
  });

  test(
    'reconnect resets a record-only destination to inject (§4.0 B)',
    () async {
      final _Harness h = _Harness();
      h.connect();
      h.destination.setRecordOnly();
      expect(h.destination.isRecordOnly, isTrue);
      // A blip: reconnecting → connected.
      h.transport.pushStatus(SocketStatus.reconnecting);
      h.transport.pushStatus(SocketStatus.connected);
      await pumpEventQueue();
      expect(h.destination.mode, DestinationMode.inject);
      await h.dispose();
    },
  );

  test(
    're-inject of a record-only row carries its own text — no registration step',
    () async {
      // Was: 'registers it then history:inject fires'. Registration existed only
      // so the server could look the text up; the owner supplies it now (0.2.27).
      final _Harness h = _Harness();
      h.connect();
      final TimelineEntry noted = h.store.buildFromUtterance(
        clientId: 'nr1',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: '补投这条',
      );
      h.controller.reInject(noted);
      await pumpEventQueue();
      final Map<String, Object?> frame = Map<String, Object?>.from(
        h.transport.emittedWhere(FlowMicEvents.injectRequest).single.data! as Map,
      );
      expect(frame['text'], '补投这条');
      expect(frame['source'], 'history');
      expect(frame['entry_id'], noted.id);
      expect(h.transport.emittedNames, isNot(contains(FlowMicEvents.historyCreate)));
      expect(h.transport.emittedNames, isNot(contains(FlowMicEvents.historyInject)));
      // And the badge is back to ⏳ while the PC's verdict is outstanding.
      expect(h.store.findById(noted.id)!.status, EntryStatus.cached);
      await h.dispose();
    },
  );

  test('re-inject is INERT for a cloud-origin row — never injects/syncs '
      '(WP-R4-2 ④ red line)', () async {
    final _Harness h = _Harness();
    h.connect();
    final TimelineEntry cloud = h.store.buildFromUtterance(
      clientId: 'cr1',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: '云端只留手机',
      origin: 'cloud',
    );
    h.controller.reInject(cloud);
    await pumpEventQueue();
    // Nothing at all leaves for a cloud record — not a delivery, not an upload.
    expect(h.transport.emitted, isEmpty);
    // The row is untouched (still noted, not bumped back to ⏳ cached).
    expect(h.store.findById(cloud.id)!.status, EntryStatus.noted);
    await h.dispose();
  });

  test('WP-R4-6 ⑦: polish:skipped marks the entry without touching '
      'timeline status; applied/absent finals are unmarked', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('润色失败仍投递', polish: 'skipped', polishReason: 'timeout');
    expect(h.store.entries, hasLength(1));
    final TimelineEntry marked = h.store.entries.first;
    // Delivery truth unchanged — polish is NOT a fifth status.
    expect(marked.status, EntryStatus.cached);
    expect(marked.edited, isFalse);
    expect(h.controller.polishSkippedEntryIds, contains(marked.id));

    // Applied / absent finals get NO mark — and (lead ruling: session-persistent)
    // they do NOT clear the earlier entry's mark.
    await h.speak('润色成功', polish: 'applied');
    await h.speak('未启用润色');
    expect(h.store.entries, hasLength(3));
    expect(h.controller.polishSkippedEntryIds, <String>{marked.id});
    await h.dispose();
  });

  test('WP-R4-6 ⑦: polish-skipped mark is session-persistent — no auto-dismiss '
      'timer may ever clear it (lead integration ruling)', () {
    fakeAsync((async) {
      final _Harness h = _Harness();
      h.connect();
      // Drive the utterance inside the fake clock (pttDown/Up are async).
      h.controller.pttDown();
      async.flushMicrotasks();
      h.controller.pttUp();
      async.flushMicrotasks();
      h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '驻留角标',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 1200,
        'polish': 'skipped',
        'polish_reason': 'llm_error',
      });
      async.flushMicrotasks();
      expect(h.controller.polishSkippedEntryIds, hasLength(1));
      // A fake-clock hour passes: the honest signal must still be there.
      async.elapse(const Duration(hours: 1));
      expect(h.controller.polishSkippedEntryIds, hasLength(1));
      expect(h.store.entries, hasLength(1));
      h.controller.dispose();
      h.destination.dispose();
      h.store.dispose();
    });
  });

  test(
    'R6 P0-R3: audio:auto-stopped raises a fail-loud notice + drops the live '
    'draft; dismiss clears it (a 5-min-cap stop is NEVER silent)',
    () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      expect(h.controller.autoStopped, isFalse);
      // Server hits the 5-min hard cap mid-utterance.
      h.transport.pushIncoming(
        FlowMicEvents.audioAutoStopped,
        const <String, Object?>{},
      );
      await pumpEventQueue();
      expect(h.controller.autoStopped, isTrue);
      // No stranded 「转录中」 row: the in-flight draft is dropped.
      expect(h.controller.liveText, isEmpty);
      // User dismisses the banner.
      h.controller.dismissAutoStopped();
      expect(h.controller.autoStopped, isFalse);
      await h.dispose();
    },
  );

  test(
    'R6 P0-R3: a fresh PTT-down supersedes a stale auto-stop notice',
    () async {
      final _Harness h = _Harness();
      h.connect();
      // The cap can fire on a disconnect edge too; here the FSM stays IDLE so a
      // new recording is admissible and must clear the stale banner.
      h.transport.pushIncoming(
        FlowMicEvents.audioAutoStopped,
        const <String, Object?>{},
      );
      await pumpEventQueue();
      expect(h.controller.autoStopped, isTrue);
      final bool ok = await h.controller.pttDown();
      expect(ok, isTrue);
      expect(h.controller.autoStopped, isFalse);
      await h.dispose();
    },
  );

  // ── GA-03: a PROCESSING stall reaches the page as a fail-loud banner ──────
  test(
    'GA-03: a terminal stt:error un-wedges PROCESSING, drops the live draft, '
    'builds NO row, and raises the named notice (dismiss + fresh PTT clear it)',
    () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      // Some interim text is on screen when the engine dies.
      h.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
        'text': '说到一半',
        'confidence': 0.5,
        'language': 'zh',
        'segment_idx': 0,
      });
      await pumpEventQueue();
      expect(h.controller.liveText, '说到一半');
      await h.controller.pttUp();
      expect(h.controller.canPtt, isFalse); // PROCESSING: the gate is shut
      h.transport.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
        'code': 'ENGINE_DEAD',
        'message': 'provider closed the stream',
        'retryable': false,
      });
      await pumpEventQueue();
      expect(h.controller.sttStalled?.reason, SttStallReason.engineError);
      expect(h.controller.liveText, isEmpty); // no stranded 「转录中」 row
      // 08 §2: final not arrived = utterance not complete → no timeline entry at all.
      expect(h.store.entries, isEmpty);
      expect(h.controller.canPtt, isTrue); // recovered without an app restart
      h.controller.dismissSttStalled();
      expect(h.controller.sttStalled, isNull);
      await h.dispose();
    },
  );

  test('GA-03: a fresh PTT-down supersedes a stale stall notice', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttDown();
    await h.controller.pttUp();
    h.transport.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
      'code': 'ENGINE_DEAD',
      'message': 'down',
      'retryable': false,
    });
    await pumpEventQueue();
    expect(h.controller.sttStalled, isNotNull);
    expect(await h.controller.pttDown(), isTrue);
    expect(h.controller.sttStalled, isNull);
    await h.dispose();
  });

  // ── ENG-3 (fix-030): the P0 LAN empty-transcript shape, end to end ─────────
  // Measured on the failing 0.2.61 runs (2026-08-11 reply doc): the server sent
  // an honest NAMED terminal stt:error on audio:start (`STT_CONFIG_MISSING` —
  // sherpa addon not shipped) AND an empty terminal final on stop; the owner
  // read 「没有听到语音」 then 「未收到转写结果」, and 「转写引擎报错」 never appeared.
  // Two breaks: the code died in ptt_inbound (only `retryable` survived, and
  // the `processing` clause swallowed RECORDING-time terminals entirely), and
  // the empty final repainted whatever stall did fire. Both are pinned here
  // against the REAL frames-to-banner chain.
  test('ENG-3: a named terminal stt:error during the press surfaces as the '
      'engineError stall CARRYING the code — and a trailing empty terminal '
      'final must NOT repaint it with 「没有听到语音」', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttDown();
    // The cold-open refusal arrives moments into the press (FSM: RECORDING).
    h.transport.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
      'code': 'STT_CONFIG_MISSING',
      'message': "sherpa-local open failed: Cannot find module 'sherpa-onnx-node'",
      'retryable': false,
    });
    await pumpEventQueue();
    expect(h.controller.sttStalled, isNull, reason: 'latched, press still live');
    await h.controller.pttUp();
    await pumpEventQueue();
    final SttStall? stall = h.controller.sttStalled;
    expect(stall?.reason, SttStallReason.engineError);
    expect(stall?.code, 'STT_CONFIG_MISSING',
        reason: 'the wire code must reach the banner layer (R11: the judging '
            'layer holds the fact it judges on)');
    // The stop path of a dead run flushes an empty terminal final AFTER the
    // named refusal. It must not repaint the honest banner with a sentence
    // that blames the room.
    h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '',
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 2000,
    });
    await pumpEventQueue();
    expect(h.controller.sttStalled?.reason, SttStallReason.engineError,
        reason: 'empty-final race: the named refusal holds the slot');
    expect(h.controller.sttStalled?.code, 'STT_CONFIG_MISSING');
    expect(h.store.entries, isEmpty, reason: 'nothing was transcribed — no row');
    // Scope check: the guard is per-utterance. A LATER utterance whose room
    // really was silent still reports emptyTranscript loudly.
    expect(await h.controller.pttDown(), isTrue);
    await h.controller.pttUp();
    h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '',
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 2000,
    });
    await pumpEventQueue();
    expect(h.controller.sttStalled,
        const SttStall(SttStallReason.emptyTranscript),
        reason: 'the guard must not permanently silence the empty-room banner');
    await h.dispose();
  });

  // ── 窗口C-5: banner lifecycle matches the lifecycle of the FACT it states ──
  // owner 2026-08-01 real-device: 「没有听到语音」 stayed up looking like a live block long
  // after the utterance that produced it had already ended. Principle (CLAUDE.md
  // memory flowmic-transient-notice-lifecycle.md): EVENT-type banners ("something
  // just happened") auto-hide after a few seconds AND stay re-triggerable (hiding is not discarding);
  // STATE-type banners ("what state we are in now") never do — see chat_transient_
  // banner_timers.dart for which six ids this applies to and why the other
  // three (link / outboxPending / outboxTerminal) are structurally excluded.
  group('窗口C-5: banner auto-hide (event-type) vs. stays put (state-type)', () {
    test(
      "owner's literal bug — 「没有听到语音」 auto-hides after "
      'kBannerAutoHideAfter, and a SECOND occurrence shows again (hiding is not discarding)',
      () {
        fakeAsync((FakeAsync async) {
          final _Harness h = _Harness();
          h.connect();

          // First empty-transcript utterance.
          h.controller.pttDown();
          async.flushMicrotasks();
          h.controller.pttUp();
          async.flushMicrotasks();
          h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
            'text': '',
            'language': 'zh',
            'segment_idx': 0,
            'is_segment': false,
            'duration_ms': 2000,
          });
          async.flushMicrotasks();

          // Positive control: it really showed up before this test claims it hides.
          expect(h.controller.sttStalled, const SttStall(SttStallReason.emptyTranscript));

          async.elapse(kBannerAutoHideAfter - const Duration(milliseconds: 1));
          expect(
            h.controller.sttStalled,
            isNotNull,
            reason: 'must not hide EARLY — owner asked for 3-5s, not instant',
          );

          async.elapse(const Duration(milliseconds: 2));
          expect(
            h.controller.sttStalled,
            isNull,
            reason: 'an event-type banner must not still be up long after the '
                'utterance it described already ended',
          );

          // Hiding is not discarding: the SAME fact happening again must be said again.
          // 🔴 N1-B2 —— this line was added this round; it patches a premise
          // **this harness never satisfied**: the un-awaited pttDown/pttUp pair
          // inside `fakeAsync` never actually finished, so by the time the test
          // reaches here the FSM is still RECORDING (measured `canPtt=false`) ⇒
          // the `pttDown` below is refused, and `segments.clear()` inside
          // `session.pttDown` never ran. The second frame was therefore pushed
          // in under a **state that cannot exist on the wire**: no second
          // `audio:start`, so the server would not rebuild the orchestrator and
          // segment numbers would not reset to zero. This case measures the
          // banner (hiding is not discarding), not the FSM, so only the thing
          // `audio:start` actually does is patched in — reset the segment numbers.
          h.session.segments.clear();
          h.controller.pttDown();
          async.flushMicrotasks();
          h.controller.pttUp();
          async.flushMicrotasks();
          h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
            'text': '',
            'language': 'zh',
            'segment_idx': 0,
            'is_segment': false,
            'duration_ms': 2000,
          });
          async.flushMicrotasks();
          expect(
            h.controller.sttStalled,
            const SttStall(SttStallReason.emptyTranscript),
            reason: 'hiding is not discarding — auto-hiding once must not permanently silence a '
                'real recurrence of the same fact',
          );

          h.controller.dispose();
          h.destination.dispose();
          h.store.dispose();
        });
      },
    );

    test(
      'auto-stop (R6 P0-R3) gets the SAME event-type treatment — this is a '
      'scan of the whole queue, not a one-off fix for stt-stall alone',
      () {
        fakeAsync((FakeAsync async) {
          final _Harness h = _Harness();
          h.connect();
          h.transport.pushIncoming(
            FlowMicEvents.audioAutoStopped,
            const <String, Object?>{},
          );
          async.flushMicrotasks();
          expect(h.controller.autoStopped, isTrue); // positive control
          async.elapse(kBannerAutoHideAfter + const Duration(milliseconds: 1));
          expect(h.controller.autoStopped, isFalse);
          h.controller.dispose();
          h.destination.dispose();
          h.store.dispose();
        });
      },
    );

    test(
      'a compose-send failure (blocking, WITH a 重发 action) also auto-hides '
      '— the retry stays reachable from the row itself (ChatMessageTile.'
      'onRetry), so the banner going quiet does not strand the user',
      () {
        fakeAsync((FakeAsync async) {
          final _Harness h = _Harness();
          h.connect();
          h.controller.delivery.raise(ComposeSendFailure.wireFailed);
          expect(
            h.controller.sendFailure,
            ComposeSendFailure.wireFailed,
          ); // positive control
          async.elapse(kBannerAutoHideAfter + const Duration(milliseconds: 1));
          expect(h.controller.sendFailure, isNull);
          h.controller.dispose();
          h.destination.dispose();
          h.store.dispose();
        });
      },
    );

    test(
      'unrelated notifyListeners noise (typing in the composer, same as the '
      'amplitude meter firing ~10x/s while recording) does NOT extend the '
      'window — only a FRESH occurrence of the SAME banner gets a fresh one',
      () {
        fakeAsync((FakeAsync async) {
          final _Harness h = _Harness();
          h.connect();
          h.controller.delivery.raise(ComposeSendFailure.wireFailed);
          expect(h.controller.sendFailure, isNotNull);

          // Three unrelated notifyListeners ticks, well inside the window.
          for (int i = 0; i < 3; i++) {
            async.elapse(const Duration(seconds: 1));
            h.controller.setBuffer('typing $i');
          }
          expect(
            h.controller.sendFailure,
            isNotNull,
            reason: 'still inside the ORIGINAL 4 s window (3 ticks x 1 s)',
          );

          async.elapse(const Duration(milliseconds: 1001));
          expect(
            h.controller.sendFailure,
            isNull,
            reason: 'the window was measured from the ORIGINAL occurrence, '
                'never reset by the unrelated ticks in between',
          );
          h.controller.dispose();
          h.destination.dispose();
          h.store.dispose();
        });
      },
    );

    test(
      'a STATE-type banner (还有 N 条未投递) is untouched by elapsed time — only '
      'the actual count, never a timer, ever changes it',
      () {
        fakeAsync((FakeAsync async) {
          final _Harness h = _Harness();
          // Paired, then dropped: identities SURVIVE a disconnect (documented
          // at DeliveryOutbox._hasRedeemableDestination — a dropped socket does
          // NOT call clearConnectedInstance), and offline is the one state
          // where nothing can quietly drain the count out from under this test
          // for a reason that has nothing to do with the banner timer.
          h.connectPaired();
          async.flushMicrotasks();
          h.transport.pushStatus(SocketStatus.disconnected);
          async.flushMicrotasks();

          h.controller.outbox.enqueueText(
            requestId: 'c5-req-1',
            entryId: 'c5-entry-1',
            wireEntryId: 'c5-entry-1',
            source: 'manual',
            text: '离线也要能看见还欠着',
            mode: 'realtime',
            createdAt: h.now,
          );
          async.flushMicrotasks();
          final int before = h.controller.outboxPending;
          expect(before, greaterThan(0)); // positive control

          async.elapse(kBannerAutoHideAfter * 10);
          expect(
            h.controller.outboxPending,
            before,
            reason: 'a STATE-type banner must never be touched by the '
                'auto-hide timer — nothing here dismisses it, only an actual '
                'delivery would ever move this number',
          );

          h.controller.dispose();
          h.destination.dispose();
          h.store.dispose();
        });
      },
    );

    test(
      'dispose() cancels every armed auto-hide timer — a torn-down controller '
      'must not go on firing dismiss callbacks into a dead store',
      () {
        fakeAsync((FakeAsync async) {
          final _Harness h = _Harness();
          h.connect();
          h.controller.delivery.raise(ComposeSendFailure.wireFailed);
          expect(h.controller.sendFailure, isNotNull);
          h.controller.dispose();
          h.destination.dispose();
          h.store.dispose();
          // If dispose failed to cancel the Timer, letting it fire here would
          // call notifyListeners on an already-disposed ChangeNotifier, which
          // asserts and throws.
          expect(() => async.elapse(kBannerAutoHideAfter * 2), returnsNormally);
        });
      },
    );
  });

  // ── R6 T-5d: recording-panel data sources (anti-façade: every indicator is
  // fed by a real source, or the panel omits it) ────────────────────────────

  test(
    'R6 T-5d: 📍 seg N counts only OBSERVED segment_idx values — it stays 0 '
    'until the wire actually carries one, and resets per utterance',
    () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      expect(h.controller.isRecording, isTrue);
      expect(
        h.controller.observedSegments,
        0,
        reason: 'nothing observed yet ⇒ the panel hides 📍 rather than '
            'guessing "seg 1"',
      );
      h.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
        'text': '第一段',
        'confidence': 0.9,
        'language': 'zh',
        'segment_idx': 0,
      });
      await pumpEventQueue();
      expect(h.controller.observedSegments, 1);
      // 30 s soft-segment rollover server-side → idx 1.
      h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '第一段',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': 1,
        'is_segment': true,
        'duration_ms': 30000,
      });
      await pumpEventQueue();
      expect(h.controller.observedSegments, 2);
      // A fresh utterance starts the count over.
      await h.controller.pttUp();
      h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '第一段第二段',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': 1,
        'is_segment': false,
        'duration_ms': 40000,
      });
      await pumpEventQueue();
      // JUST_DONE → IDLE (the 1500 ms window) before the gate reopens.
      h.session.fsm.onJustDoneTimeout();
      expect(await h.controller.pttDown(), isTrue);
      expect(h.controller.observedSegments, 0);
      await h.dispose();
    },
  );

  test(
    'R6 T-5d: ⏱ runs off audio:start on the injected clock and FREEZES when '
    'capture ends (never a free-running timer)',
    () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      expect(h.controller.recordingElapsed, Duration.zero);
      h.now = h.now.add(const Duration(seconds: 3));
      // Let the 200 ms panel ticker fire once.
      await Future<void>.delayed(const Duration(milliseconds: 260));
      expect(h.controller.recordingElapsed, const Duration(seconds: 3));

      await h.controller.pttUp(); // RECORDING → PROCESSING: panel collapses
      expect(h.controller.isRecording, isFalse);
      h.now = h.now.add(const Duration(seconds: 30));
      await Future<void>.delayed(const Duration(milliseconds: 260));
      expect(
        h.controller.recordingElapsed,
        const Duration(seconds: 3),
        reason: 'the readout must freeze with the capture, not keep counting',
      );
      await h.dispose();
    },
  );

  test(
    'R6 T-5d: 📊 the amplitude window is fed by the DEVICE-side dBFS meter '
    '(AudioCapture PCM RMS) and keeps the last 8 samples',
    () async {
      final _Harness h = _Harness();
      h.connect();
      expect(h.controller.amplitudeWindow, isEmpty);
      await h.controller.pttDown();
      // 10 full 200 ms chunks → 10 real dBFS samples off the captured PCM.
      for (int i = 0; i < 10; i++) {
        h.recorder.feed(makePcm(kChunkBytes));
        await pumpEventQueue();
      }
      expect(h.controller.amplitudeWindow, hasLength(8));
      for (final double db in h.controller.amplitudeWindow) {
        expect(db, greaterThan(-100.0)); // real signal, not the silence floor
        expect(db, lessThanOrEqualTo(0.0));
      }
      // A new utterance starts from a clean window (no stale bars).
      await h.controller.pttCancel();
      expect(h.controller.amplitudeWindow, isEmpty);
      await h.dispose();
    },
  );

  test(
    'R6 T-5d fix: audio:auto-stopped releases the FSM out of RECORDING — the '
    'server-flushed terminal final still builds its row and PTT recovers '
    '(it used to strand the session in RECORDING forever)',
    () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      expect(h.session.fsm.session, SessionState.recording);
      h.transport.pushIncoming(
        FlowMicEvents.audioAutoStopped,
        const <String, Object?>{'reason': 'hard_limit'},
      );
      await pumpEventQueue();
      expect(h.session.fsm.session, SessionState.processing);
      expect(h.controller.isRecording, isFalse); // panel collapsed
      expect(h.controller.autoStopped, isTrue); // ...but the notice is loud
      // orchestrator handleHardLimit() flushes a TERMINAL final right after.
      h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '五分钟上限前说的内容',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 300000,
      });
      await pumpEventQueue();
      expect(h.store.entries, hasLength(1));
      expect(h.store.entries.single.sourceText, '五分钟上限前说的内容');
      expect(h.session.fsm.session, SessionState.justDone);
      await h.dispose();
    },
  );

  group('owner ② sustained disconnect leaves the chat session', () {
    test('10s of dead link → sessionLost + the reconnect ladder is stopped', () async {
      final _Harness h = _Harness();
      h.connect();
      expect(h.controller.sessionLost, isFalse);

      h.transport.pushStatus(SocketStatus.disconnected);
      await pumpEventQueue();
      // Inside the window: still on the page, still retrying — a blip must be
      // allowed to heal in place (GA-04's grace rides those early rungs).
      expect(h.controller.sessionLost, isFalse);

      await Future<void>.delayed(const Duration(milliseconds: 80));
      // The window expired with the link still down: the page is told to leave.
      expect(h.controller.sessionLost, isTrue);
      await h.dispose();
    });

    test('a NEW session clears the latch — one loss must not poison every later visit', () async {
      // owner 2026-07-27, reproduced on the tablet: after the server had died
      // once, re-entering the chat page and pressing PTT threw the user straight
      // back to the instance list — and, since leaving the page also leaves the
      // room, disconnected them. The controller is a singleton and `sessionLost`
      // was set once and never cleared, so the page's post-frame exit fired on
      // the first notify of EVERY subsequent visit.
      final _Harness h = _Harness();
      h.connect();
      h.transport.pushStatus(SocketStatus.disconnected);
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(h.controller.sessionLost, isTrue); // a real loss, correctly latched

      h.transport.pushStatus(SocketStatus.connected); // the user taps the PC again
      await pumpEventQueue();

      expect(h.controller.sessionLost, isFalse);
      await h.dispose();
    });

    test('a reconnect INSIDE the window disarms the exit', () async {
      final _Harness h = _Harness();
      h.connect();
      h.transport.pushStatus(SocketStatus.disconnected);
      await pumpEventQueue();
      h.transport.pushStatus(SocketStatus.connected);
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 80));
      // Healed in time — the user stays exactly where they were.
      expect(h.controller.sessionLost, isFalse);
      await h.dispose();
    });

    // owner 2026-07-27, real-device reproduced: the terminal final arrived, but
    // not a single word. This path used to return immediately — the 「转录中」
    // draft vanished with no notice, indistinguishable from a crash, which is
    // exactly what owner reported: 「松开提示成功但没有转录」. An empty result
    // must also be said out loud (red line).
    test('an EMPTY terminal final raises the fail-loud banner, not silence', () async {
      final _Harness h = _Harness();
      await h.controller.pttDown();
      h.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
        'text': '', 'confidence': 0.1, 'language': 'zh', 'segment_idx': 0,
      });
      await pumpEventQueue();
      await h.controller.pttUp();
      // funasr answers a silent room with exactly this: is_final, empty text.
      h.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '', 'language': 'zh', 'segment_idx': 0, 'is_segment': false,
        'duration_ms': 2000,
      });
      await pumpEventQueue();
      expect(h.controller.sttStalled, const SttStall(SttStallReason.emptyTranscript));
      expect(h.controller.liveText, isEmpty);   // draft cleared…
      expect(h.store.entries, isEmpty);         // …and no row (nothing was said)
      // canPtt is false only because the FSM is inside the 1500 ms JUST_DONE
      // window — an empty terminal final still drives PROCESSING → JUST_DONE →
      // IDLE exactly like a non-empty one (ptt_session calls fsm.onSttFinal for
      // every terminal final). Verified on the real tablet: a second press a few
      // seconds later records normally. Pinned so a regression that DOES strand
      // the FSM here would fail this test.
      // (canPtt is false only because the FSM has not returned to IDLE yet in
      // this harness; not asserted here because the harness's link state, not
      // the empty final, decides it.)
      h.controller.dismissSttStalled();
      expect(h.controller.sttStalled, isNull);
      await h.dispose();
    });

  });

  // ── T-1 (2026-08-13): 「远程标点补全」 is written off ───────────────────────
  //
  // Three cases stood here and are DELETED, not re-pointed: 「a punctuation key
  // emits control:key AND appends the mark to the last row」, 「tapping the same
  // mark twice does not double it」 and 「punctuation with NO rows yet still
  // reaches the PC」. All three asserted `_appendPunctuation`, which owner Q2㋐
  // removed together with the buttons that were its only trigger. The wire-level
  // facts they also touched (the punct kinds are on the whitelist and serialise
  // SNAKE_CASE) were never theirs — wire_payloads_test.dart owns those, and the
  // protocol is unchanged.
  //
  // What replaces them is the case below: the same keys, asserted NEGATIVELY.

  test('🔴 control keys must not touch this device\'s rows or draft (owner 2026-08-13 补充 #3 + Q2㋐)',
      () async {
    // One case, two rules, because they are now the same rule: **a control key
    // is an independent delivery**.
    //   · 补充 #3 removed the coupling between ✕ and the local buffer;
    //   · Q2㋐ removed the coupling between punctuation keys and "the most
    //     recent row".
    // After the split, the only thing `runControlKey` does on this device is
    // mint that key row (REQ-12-13).
    //
    // ⚠️ The punctuation kind has **no sender** in production today (the
    // buttons are gone); this case still drives it once: it is still on the
    // `control:key` whitelist (deleting an event is an owner gate), and what
    // this case pins is "even if it is sent, this device must not move a
    // single character" — `_appendPunctuation` is really gone.
    final _Harness h = _Harness();
    await h.connectPaired();
    await h.speak('明天下午三点开会');
    h.controller.setBuffer('还没发出去的草稿');

    for (final ControlKeyKind k in <ControlKeyKind>[
      ControlKeyKind.enter,
      ControlKeyKind.clear,
      ControlKeyKind.punctPeriod,
    ]) {
      expect(
        h.controller.sendControlKey(k),
        isTrue,
        reason: 'positive control: ${k.name} must really have been sent, otherwise '
            'the "nothing moved" below is only true because nothing happened',
      );
    }
    await pumpEventQueue();

    final TimelineEntry said = h.store.entries.firstWhere(
      (TimelineEntry e) => !e.isControl,
    );
    expect(said.displayText, '明天下午三点开会', reason: 'the words on the row were changed');
    expect(said.edited, isFalse, reason: 'the row was marked "human-edited" and no human edited it');
    expect(said.sourceText, '明天下午三点开会');
    expect(
      h.controller.buffer,
      '还没发出去的草稿',
      reason: '🔴 the draft was moved by a control key — 补充 #3 forbids merging it in or clearing it',
    );
    await h.dispose();
  });

  // ── REQ-12-13 — wiring of remote four-key row minting (owner P0 2026-08-12, contract 15 册 §2.0-e) ──
  //
  // 🔴 This group is **wiring**, not logic: `buildControlRow`'s own properties
  // are pinned by control_key_history_test.dart; what is asked here is "does
  // the production path really call it". Reverse control ＝ strip
  // `_mintControlRow` out of `runControlKey` ⇒ this group goes red on the spot.
  test('every remote key leaves a row on the phone history, and the row can say which key it is', () async {
    final _Harness h = _Harness();
    await h.connectPaired();
    for (final ControlKeyKind k in <ControlKeyKind>[
      ControlKeyKind.clear,
      ControlKeyKind.backspace,
      ControlKeyKind.undo,
      ControlKeyKind.enter,
    ]) {
      expect(h.controller.sendControlKey(k), isTrue);
    }
    await pumpEventQueue();
    final List<TimelineEntry> keys = h.store.entries
        .where((TimelineEntry e) => e.isControl)
        .toList();
    expect(keys.length, 4);
    expect(
      keys.map((TimelineEntry e) => e.controlKind).toSet(),
      <String>{'clear', 'backspace', 'undo', 'enter'},
    );
    // 🔴 Addressing is attached at birth (not inferred from "who is current"
    // at drain time — this path has no drain at all).
    expect(keys.every((TimelineEntry e) => e.spokenToInstanceId != null), isTrue);
    await h.dispose();
  });

  test('🔴 the frame never left the device ⇒ not one row is minted, and the banner says so on the spot', () async {
    // An event that did not happen getting a receipt is the other half of
    // "no silent failure". The positive half of the reverse control: the case
    // above proves "sent ⇒ there is a row"; this one proves "not sent ⇒ there
    // is none". Without this case, "mint a row" and "unconditionally mint a
    // row" look identical.
    final _Harness h = _Harness();
    // Deliberately not connected: canCompose is false ⇒ sendControlKey takes
    // the notConnected branch.
    expect(h.controller.sendControlKey(ControlKeyKind.clear), isFalse);
    await pumpEventQueue();
    expect(h.store.entries.where((TimelineEntry e) => e.isControl), isEmpty);
    expect(h.controller.sendFailure, isNotNull);
    await h.dispose();
  });

  test('a punctuation kind still does not mint a row — 15 册 §2.0-e limits key rows to the four chord keys', () async {
    // ⚠️ T-1 changed this case's **reason**, not its assertion. Its previous
    // reason was "punctuation edits the most recent row, so minting a row
    // would count one keypress as two events"; that edit action no longer
    // exists. It stays because `_mintControlRow`'s "has a glyph ⇒ do not mint"
    // guard is still there, and what it guards is the contract sentence
    // "key row ＝ the four chord keys".
    final _Harness h = _Harness();
    await h.connectPaired();
    await h.speak('好的');
    h.controller.sendControlKey(ControlKeyKind.punctPeriod);
    await pumpEventQueue();
    expect(h.store.entries.where((TimelineEntry e) => e.isControl), isEmpty);
    // Positive control: this press really went out (otherwise "no row minted"
    // is only true because it was refused).
    expect(
      (h.transport.emittedWhere(FlowMicEvents.controlKey).last.data as Map)['kind'],
      'punct_period',
    );
    expect(h.store.entries.first.displayText, '好的');
    await h.dispose();
  });
}
