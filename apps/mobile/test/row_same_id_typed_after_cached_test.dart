// NR-289 — A LATER VERDICT THAT SAYS THE SAME DELIVERY WAS TYPED MUST REACH THE
// ROW, EVEN AFTER THE PC FIRST SAID IT TYPED NOTHING.
//
// THE DEFECT (disclosed in doc 15 §2.6-a rule 4 by NR-288). The row write-back
// latched on the first PC-authored no-input verdict (`cached` +
// `cachedByVerdict` + a pc-injection code) and dropped every later receipt for
// that row. Its justification — 「every path that re-asks calls
// markReinjecting」 — holds only for the user's own resends. Automatic drains
// re-send the SAME request_id untouched, and the PC records only typed runs
// (`socket/inject_ops.rs`: `if outcome.mode != inject::InjectMode::Cached`), so
// the second frame is judged again and may be typed. The phone kept saying
// 「delivered · not injected」 with the first reason while the PC said
// injected; a Resend from that face mints a NEW id and the PC types the
// sentence a second time.
//
// THE RULE NOW (doc 15 receipt states §2.0.1-d, NR-289 correction):
//   · ok:true lifts a no-input pc-injection row to `injected`;
//   · ok:false on that row stays latched (IT-05, unchanged);
//   · `injected` is never downgraded;
//   · `INJECT_SUBMISSION_UNCERTAIN` is not lifted (the PC's own row and dedup
//     keep that answer too);
//   · a deferred verdict is ok:false and never lifts anything.
//
// SPEC-REF: docs/rebuild/15-RECEIPT-STATES.md §2.0.1-d;
//   lib/src/timeline/timeline_store_inject_writeback.dart
//   (`laterTypingSupersedesNoInput`).

import 'dart:async' show unawaited;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/outbox_inject_authorship.dart'
    show kPcInjectionVerdictCodes;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _kUncertain = 'INJECT_SUBMISSION_UNCERTAIN';
const String _kDeferred = 'INJECT_DEFERRED_NOT_AUTOINJECTED';

const InjectTarget _kTarget = InjectTarget(
  windowTitle: 'Untitled - Notepad',
  processName: 'notepad.exe',
  injectedAt: '2026-10-20T01:02:03.000Z',
);

/// A row the PC answered 「I typed nothing」 for, built through the REAL
/// write-back (the PC stamps `mode: Cached` on these verdicts).
TimelineEntry _noInputRow(TimelineStore store, String clientId, String code) {
  store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    text: '这句话到了电脑上，但这一次没打出来',
  );
  final bool applied = store.applyInjectResult(
    correlationId: clientId,
    ok: false,
    wireMode: TimelineStore.kWireModeCached,
    failureReason: code,
  );
  expect(applied, isTrue, reason: 'setup: the first PC verdict must land');
  final TimelineEntry e = store.findByClientId(clientId)!;
  expect(e.status, EntryStatus.cached, reason: 'setup ($code)');
  expect(e.cachedByVerdict, isTrue, reason: 'setup ($code)');
  expect(e.failureReason, code, reason: 'setup ($code)');
  return e;
}

bool _typed(TimelineStore store, String clientId) => store.applyInjectResult(
  correlationId: clientId,
  ok: true,
  wireMode: 'sendinput',
  pcName: 'dev-pc-a',
  target: _kTarget,
);

void main() {
  group('NR-289 store write-back precedence', () {
    test('(a) cached no-input, then ok:true for the SAME id ⇒ the row says injected '
        '(every no-input code in the registry except submission-uncertain)', () {
      final List<String> codes = kPcInjectionVerdictCodes
          .where((String c) => c != _kUncertain)
          .toList();
      expect(codes, contains('INJECT_SELF_WINDOW_NO_INPUT'), reason: 'registry sanity');
      expect(codes, contains('INJECT_SECURE_INPUT_ACTIVE'), reason: 'registry sanity');
      for (final String code in codes) {
        final TimelineStore store = newTestStore();
        final TimelineEntry row = _noInputRow(store, 'u-$code', code);
        expect(_typed(store, 'u-$code'), isTrue,
            reason: '$code: the later typed verdict must be written, not dropped');
        final TimelineEntry after = store.findById(row.id)!;
        expect(after.status, EntryStatus.injected, reason: code);
        expect(after.cachedByVerdict, isFalse, reason: code);
        expect(after.pcName, 'dev-pc-a', reason: code);
        expect(after.injectTarget?.processName, 'notepad.exe', reason: code);
        expect(deliveryFaceOf(after, queued: false), DeliveryFace.injected, reason: code);
        store.dispose();
      }
    });

    test('(b) injected, then a cached / failed / deferred verdict for the SAME id ⇒ stays injected', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry row = _noInputRow(store, 'u-b', 'INJECT_FOCUS_LOST');
      expect(_typed(store, 'u-b'), isTrue);
      for (final (String? mode, String code) late in <(String?, String)>[
        (TimelineStore.kWireModeCached, 'INJECT_FOCUS_LOST'),
        ('sendinput', 'INJECT_SENDINPUT_FAIL'),
        (TimelineStore.kWireModeCached, _kDeferred),
        (TimelineStore.kWireModeCached, _kUncertain),
      ]) {
        final bool applied = store.applyInjectResult(
          correlationId: 'u-b',
          ok: false,
          wireMode: late.$1,
          failureReason: late.$2,
        );
        expect(applied, isFalse, reason: '${late.$2}: never downgrade a typed row');
        expect(store.findById(row.id)!.status, EntryStatus.injected, reason: late.$2);
      }
      store.dispose();
    });

    test('(c) ok:true for a DIFFERENT id does not touch this row (no cross-talk)', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry a = _noInputRow(store, 'u-a', 'INJECT_SELF_WINDOW_NO_INPUT');
      final TimelineEntry b = _noInputRow(store, 'u-other', 'INJECT_SELF_WINDOW_NO_INPUT');
      expect(_typed(store, 'u-other'), isTrue);
      expect(store.findById(b.id)!.status, EntryStatus.injected, reason: 'positive control');
      final TimelineEntry aAfter = store.findById(a.id)!;
      expect(aAfter.status, EntryStatus.cached);
      expect(aAfter.cachedByVerdict, isTrue);
      expect(aAfter.failureReason, 'INJECT_SELF_WINDOW_NO_INPUT');
      // An id nothing is keyed by lands nowhere (Card F11 ②), it does not
      // fall back onto a waiting row.
      expect(_typed(store, 'u-nobody'), isFalse);
      expect(store.findById(a.id)!.status, EntryStatus.cached);
      store.dispose();
    });

    test('(d) a deferred verdict never lifts a row to injected', () {
      final TimelineStore store = newTestStore();
      // Waiting row ⇒ deferred: settles as not injected.
      store.buildFromUtterance(
        clientId: 'u-d1', mode: FlowMode.realtime, delivery: Delivery.inject, text: '延后',
      );
      store.applyInjectResult(
        correlationId: 'u-d1', ok: false,
        wireMode: TimelineStore.kWireModeCached, failureReason: _kDeferred,
      );
      expect(store.findByClientId('u-d1')!.status, isNot(EntryStatus.injected));
      // No-input row ⇒ deferred again: latched, still not injected.
      final TimelineEntry noInput = _noInputRow(store, 'u-d2', 'INJECT_SELF_WINDOW_NO_INPUT');
      expect(
        store.applyInjectResult(
          correlationId: 'u-d2', ok: false,
          wireMode: TimelineStore.kWireModeCached, failureReason: _kDeferred,
        ),
        isFalse,
      );
      final TimelineEntry d2 = store.findById(noInput.id)!;
      expect(d2.status, EntryStatus.cached);
      expect(d2.failureReason, 'INJECT_SELF_WINDOW_NO_INPUT');
      // Deferred row ⇒ deferred again: still not injected.
      _noInputRow(store, 'u-d3', _kDeferred);
      store.applyInjectResult(
        correlationId: 'u-d3', ok: false,
        wireMode: TimelineStore.kWireModeCached, failureReason: _kDeferred,
      );
      expect(store.findByClientId('u-d3')!.status, EntryStatus.cached);
      store.dispose();
    });

    test('submission-uncertain is NOT lifted by a later ok:true (both ends keep one answer), '
        'and the dropped receipt is readable in diag', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry row = _noInputRow(store, 'u-unc', _kUncertain);
      DiagLog.instance.clear();
      expect(_typed(store, 'u-unc'), isFalse);
      final TimelineEntry after = store.findById(row.id)!;
      expect(after.status, EntryStatus.cached);
      expect(deliveryFaceOf(after, queued: false), DeliveryFace.injectionUncertain);
      expect(
        DiagLog.instance.snapshot().where(
          (String l) => l.contains('timeline.inject_result_ignored_terminal'),
        ),
        hasLength(1),
      );
      store.dispose();
    });
  });

  testWidgets(
    '🔴 real chain on the mounted chat screen: a transient no-input verdict, the queue re-sends '
    'the SAME id on its own (no markReinjecting), the PC types it ⇒ the row says injected and '
    'offers no Resend',
    _realChain,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = newTestStore(owner: _SessionOwner(session));
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;

  List<Map<Object?, Object?>> get injectFrames => <Map<Object?, Object?>>[
    for (final EventEnvelope e in transport.emitted)
      if (e.name == FlowMicEvents.injectRequest && e.data is Map)
        e.data! as Map<Object?, Object?>,
  ];

  Future<void> dispose() async {
    await controller.dispose();
    await session.dispose();
    timeline.dispose();
    await transport.close();
  }
}

Future<void> _flush(WidgetTester tester) async {
  for (int i = 0; i < 12; i++) {
    await tester.pump();
  }
}

String _pill(TimelineEntry e, _Rig rig, AppStrings s) {
  final StatusMeta m = deliveryFaceMeta(
    deliveryFaceOf(
      e,
      queued: rig.controller.queuedEntryIds.contains(e.id),
      owed: rig.controller.owedEntryIds.contains(e.id),
    ),
    s,
  );
  return '${m.glyph} ${m.label}';
}

int _resendControls(String id) =>
    find.byKey(ValueKey<String>('entry.resend.$id')).evaluate().length +
    find.byKey(ValueKey<String>('entry.resend.icon.$id')).evaluate().length;

Future<void> _realChain(WidgetTester tester) async {
  final AppStrings zh = AppStrings.of(AppLocale.zh); // ChatFlowPage's default
  final _Rig rig = _Rig();
  await rig.controller.outbox.load();
  rig.transport.pushStatus(SocketStatus.connected);
  rig.session.noteRoomJoined(atHomeNode: true);
  await _flush(tester);

  unawaited(rig.controller.sendFavorite('电脑前台开着密码框'));
  await _flush(tester);
  expect(rig.injectFrames, hasLength(1), reason: 'premise: the first frame went out');
  final Map<Object?, Object?> first = rig.injectFrames.single;
  final Object? rid = first['request_id'];
  expect(rid, isA<String>());

  // ── the PC typed nothing this time (Secure Input) ───────────────────────
  rig.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
    'ok': false,
    'mode': 'cached',
    'error': 'INJECT_SECURE_INPUT_ACTIVE',
    'request_id': rid,
    'entry_id': first['entry_id'],
  });
  await _flush(tester);
  final TimelineEntry noInput = rig.timeline.entries.single;
  expect(noInput.status, EntryStatus.cached);
  expect(noInput.cachedByVerdict, isTrue);
  expect(noInput.failureReason, 'INJECT_SECURE_INPUT_ACTIVE');

  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: rig.controller)));
  await _flush(tester);
  final String noInputPill = _pill(noInput, rig, zh);
  expect(find.text(noInputPill), findsOneWidget,
      reason: 'premise: the mounted screen shows the no-input face');
  expect(_resendControls(noInput.id), greaterThan(0),
      reason: 'positive control: that face offers Resend');

  // ── the queue's own re-send: SAME request_id, no markReinjecting ────────
  final DateTime? resentBefore = rig.timeline.findById(noInput.id)!.lastResentAt;
  await rig.controller.outbox.drain();
  await _flush(tester);
  expect(rig.injectFrames, hasLength(2),
      reason: 'premise: the transient verdict was requeued and drained automatically');
  final Map<Object?, Object?> retry = rig.injectFrames.last;
  expect(retry['request_id'], rid, reason: 'the automatic re-send is the SAME delivery');
  final TimelineEntry beforeAnswer = rig.timeline.findById(noInput.id)!;
  expect(beforeAnswer.lastResentAt, resentBefore,
      reason: 'premise: the automatic path did not markReinjecting (the old latch argument)');
  expect(beforeAnswer.cachedByVerdict, isTrue,
      reason: 'premise: the row is still on the latched no-input face');

  // ── the PC judged the second frame again and typed it ───────────────────
  rig.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
    'ok': true,
    'mode': 'sendinput',
    'request_id': rid,
    'entry_id': retry['entry_id'],
    'inject_target': <String, Object?>{
      'window_title': 'Untitled - Notepad',
      'process_name': 'notepad.exe',
      'injected_at': 'now',
    },
  });
  await _flush(tester);
  final TimelineEntry done = rig.timeline.findById(noInput.id)!;
  expect(done.status, EntryStatus.injected,
      reason: 'the PC typed the words; the row must stop saying delivered-not-injected');

  final String injectedPill = _pill(done, rig, zh);
  final StatusMeta injectedMeta = deliveryFaceMeta(DeliveryFace.injected, zh);
  expect(injectedPill, '${injectedMeta.glyph} ${injectedMeta.label}');
  expect(find.text(injectedPill), findsOneWidget,
      reason: 'the mounted chat screen paints the injected face');
  expect(find.text(noInputPill), findsNothing,
      reason: 'the stale no-input face is gone from the screen');
  expect(_resendControls(done.id), 0,
      reason: 'no Resend on a typed row — pressing it would type the sentence a second time');

  await tester.pumpWidget(const SizedBox());
  await _flush(tester);
  rig.controller.session.debugStopIdlePresencePoll();
  bool disposed = false;
  unawaited(rig.dispose().then((_) => disposed = true));
  for (int i = 0; i < 200 && !disposed; i++) {
    await tester.pump(const Duration(seconds: 1));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
  expect(disposed, isTrue, reason: 'fixture: teardown finished');
}
