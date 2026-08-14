// owner 2026-07-31 real device:「如果是重发，最好是在手机端也显示一下重发的时间，这样好识别
// 区分，但原时间也要保留，即在原消息上显示一个最后的重发时间」.
//
// TWO ENDS, TWO DIFFERENT ANSWERS — ON PURPOSE, and this file exists to keep the
// phone's answer from being 「casually unified」 into the PC's:
//   · PC timeline = delivery log ⇒ one re-delivery＝one new row, stamped with the RE-DELIVERY instant
//     and sorted to the top (RV-72 / reinject_created_at_test.dart).
//   · Phone timeline = owner of this utterance ⇒ the SAME row, the SAME `createdAt`, the SAME
//     position in the list, plus one extra instant: [TimelineEntry.lastResentAt].
//
// The three things a reader has to be able to trust, and why each is here:
//   ① it is stamped by the REAL catch-up path (ChatController.reInject → ManualDelivery
//      → TimelineStore.markReinjecting), not by a test poking the store;
//   ② a row nobody re-sent carries null AND THE TILE RENDERS NOTHING — the whole
//      point of the null (a field that always shows 「—」 is worse than no field);
//   ③ it comes back after a relaunch, through the real persistence round-trip.
//
// Plus the two boundaries the design actually turns on:
//   · a FAILED re-delivery still counts (the field records the ACT; `status`
//     records the delivery truth — two questions, two fields);
//   · a re-delivery that never left the device (link known down ⇒ `LINK_DOWN`,
//     stamped by no one) does NOT count, because 「上次重发 15:20」 on something
//     that provably never went out is red line F2's saying-something-undone-as-if-done.
//
// SPEC-REF: lib/src/timeline/timeline_store.dart (markReinjecting — the ONE
//   stamp point), lib/src/timeline/timeline_entry.dart (lastResentAt),
//   lib/src/ui/chat_message_tile.dart (the meta-row label).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Two days before the run — far enough that 「original time」 and 「resend time」 can never be
/// confused for one another by a tolerance, and far enough that the tile's dated
/// label (`M/D HH:mm`) differs from today's bare `HH:mm`.
final DateTime kSpokenAt = DateTime.now().toUtc().subtract(
  const Duration(days: 2),
);

/// A newer row that must stay ABOVE the re-sent one — the sort guard.
final DateTime kNewerSpokenAt = DateTime.now().toUtc().subtract(
  const Duration(hours: 1),
);

const String kOldId = 'loc_mobile_old-1';
const String kNewerId = 'loc_mobile_newer-1';

TimelineEntry _oldRow() => TimelineEntry(
  id: kOldId,
  clientId: 'old-1',
  mode: FlowMode.realtime,
  delivery: Delivery.inject,
  sourceText: '两天前说的那一句',
  outputText: '两天前说的那一句',
  status: EntryStatus.failed,
  failureReason: 'INJECT_NO_RESULT',
  createdAt: kSpokenAt,
  updatedAt: kSpokenAt,
);

TimelineEntry _newerRow() => TimelineEntry(
  id: kNewerId,
  clientId: 'newer-1',
  mode: FlowMode.realtime,
  delivery: Delivery.inject,
  sourceText: '一小时前说的那一句',
  outputText: '一小时前说的那一句',
  status: EntryStatus.injected,
  createdAt: kNewerSpokenAt,
  updatedAt: kNewerSpokenAt,
);

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    persistence = InMemoryTimelinePersistence();
    store = newTestStore(persistence: persistence);
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
  late final InMemoryTimelinePersistence persistence;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  /// Seed both rows through STORAGE and read them back, so the row under test
  /// carries a genuinely old `created_at` (no test-only setter).
  Future<TimelineEntry> seed({bool connected = true}) async {
    await persistence.saveAll(<TimelineEntry>[_newerRow(), _oldRow()]);
    await store.load();
    transport.pushStatus(
      connected ? SocketStatus.connected : SocketStatus.disconnected,
    );
    await pumpEventQueue();
    final TimelineEntry? e = store.findById(kOldId);
    expect(e, isNotNull, reason: 'setup: the seeded row must load');
    expect(
      e!.lastResentAt,
      isNull,
      reason: 'setup: a freshly loaded row has never been re-sent',
    );
    return e;
  }

  List<EventEnvelope> get injectFrames =>
      transport.emittedWhere(FlowMicEvents.injectRequest);

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

Widget _tile(TimelineEntry e, {AppLocale locale = AppLocale.zh}) =>
    _wrap(ChatMessageTile(
      entry: e,
      strings: AppStrings.of(locale),
      queued: false,
      canResendImage: false,
    ));

void main() {
  group('① the real catch-up path stamps 「最后一次重发」', () {
    test('after a resend the row carries the RESEND instant, keeps its original '
        'createdAt, and does NOT move in the list', () async {
      final _Harness h = _Harness();
      final TimelineEntry old = await h.seed();
      final List<String> orderBefore = h.store.entries
          .map((TimelineEntry e) => e.id)
          .toList();

      final DateTime before = DateTime.now().toUtc();
      h.controller.reInject(old);
      await pumpEventQueue();
      final DateTime after = DateTime.now().toUtc();

      // Positive control for every 「did not arrive」 assertion further down: the frame really
      // did go out on this path, so a zero elsewhere means the implementation
      // held its fire, not that the probe is blind.
      expect(
        h.injectFrames,
        hasLength(1),
        reason: 'positive control: this catch-up really reached the wire',
      );

      final TimelineEntry e = h.store.findById(kOldId)!;
      expect(e.lastResentAt, isNotNull);
      // Bracketed by the call rather than compared to a tolerance: it must be
      // THIS instant, and 「now」 vs 「two days ago」 are two days apart, so a stamp that
      // silently copied createdAt cannot squeak through.
      expect(
        !e.lastResentAt!.isBefore(before) && !e.lastResentAt!.isAfter(after),
        isTrue,
        reason: 'the stamp is the moment of the resend, not the spoken moment',
      );

      // 原时间也要保留 — the owner's other half, and the red line on createdAt.
      expect(e.createdAt.isAtSameMomentAs(kSpokenAt), isTrue);

      // Phone ≠ PC: the row does NOT jump to the top. _sort() reads createdAt and
      // nothing else, and adding this field must not change that.
      expect(
        h.store.entries.map((TimelineEntry x) => x.id).toList(),
        orderBefore,
        reason: 'a resend re-orders the PC timeline, never the phone one',
      );
      expect(h.store.entries.first.id, kNewerId);

      await h.dispose();
    });

    test('a re-delivery that FAILED still counts as 「already resent」 — the field records '
        'the act, `status` records the truth', () async {
      final _Harness h = _Harness();
      final TimelineEntry old = await h.seed();

      h.controller.reInject(old);
      await pumpEventQueue();
      final DateTime? stamped = h.store.findById(kOldId)!.lastResentAt;
      expect(stamped, isNotNull);

      // The PC answers ✗. This is the exact case owner needs to read: the row
      // shows a failure and the only open question is 「is this ✗ from the original
      // attempt, or from the resend I just did?」. Dropping the stamp here would delete the answer.
      h.store.applyInjectResult(
        correlationId: kOldId,
        ok: false,
        failureReason: 'INJECT_FOCUS_LOST',
      );
      final TimelineEntry e = h.store.findById(kOldId)!;
      expect(e.status, EntryStatus.failed, reason: 'delivery truth unchanged');
      expect(
        e.lastResentAt!.isAtSameMomentAs(stamped!),
        isTrue,
        reason: 'a failed verdict does not un-happen the resend',
      );

      await h.dispose();
    });

    test('a SECOND resend moves the stamp forward (it is 「last time」, not 「first time」)',
        () async {
      final _Harness h = _Harness();
      final TimelineEntry old = await h.seed();

      h.controller.reInject(old);
      await pumpEventQueue();
      final DateTime first = h.store.findById(kOldId)!.lastResentAt!;

      // A tick of real time, so 「moved forward」 is decidable at all.
      await Future<void>.delayed(const Duration(milliseconds: 12));
      h.controller.reInject(h.store.findById(kOldId)!);
      await pumpEventQueue();
      final DateTime second = h.store.findById(kOldId)!.lastResentAt!;

      expect(second.isAfter(first), isTrue);
      expect(h.injectFrames, hasLength(2), reason: 'positive control');

      await h.dispose();
    });

    test('a resend that never left the device (link known down) stamps NOTHING',
        () async {
      // The boundary. `reInject` bails before markReinjecting when the link is
      // known down: nothing is emitted, the row settles ✗ LINK_DOWN. Showing
      // 「上次重发 15:20」 there would be red line F2 — saying something undone as if it were done.
      final _Harness h = _Harness();
      final TimelineEntry old = await h.seed(connected: false);

      h.controller.reInject(old);
      await pumpEventQueue();

      final TimelineEntry e = h.store.findById(kOldId)!;
      expect(e.lastResentAt, isNull);
      expect(e.failureReason, 'LINK_DOWN', reason: 'it did fail out loud');
      // The negative assertion is written on the FRAMES, not on one event name:
      // nothing at all left this device.
      expect(
        h.transport.emitted,
        isEmpty,
        reason: 'not one frame — see the positive control in the first test',
      );

      await h.dispose();
    });
  });

  group('② a row nobody re-sent shows nothing at all', () {
    test('the field is null on a fresh row', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry born = store.buildFromUtterance(
        clientId: 'u1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '一句话',
      );
      expect(born.lastResentAt, isNull);
      store.dispose();
    });

    testWidgets('the tile renders NO resend line for it, and does render one '
        'once the row has been re-sent', (WidgetTester tester) async {
      // Negative + its positive control in one test, deliberately: a
      // findsNothing on its own cannot tell 「the UI held its fire」 from
      // 「the finder is looking for the wrong string」.
      await tester.pumpWidget(_tile(_oldRow()));
      expect(find.textContaining('上次重发'), findsNothing);
      // …and no placeholder took its place either.
      expect(find.textContaining('—'), findsNothing);

      final TimelineEntry resent = _oldRow().copyWith(
        lastResentAt: DateTime.now().toUtc(),
      );
      await tester.pumpWidget(_tile(resent));
      expect(find.textContaining('上次重发'), findsOneWidget);

      await tester.pumpWidget(_tile(resent, locale: AppLocale.en));
      expect(find.textContaining('Resent'), findsOneWidget);
    });

    testWidgets('原时间也要保留: both instants are on the row, and the label never '
        'collides with the tappable resend action', (WidgetTester tester) async {
      // owner's second half. The row must show the SPOKEN time (dated, because
      // it is two days old) AND the resend time — never one replacing the other.
      final TimelineEntry resent = _oldRow().copyWith(
        lastResentAt: DateTime.now().toUtc(),
      );
      TimelineEntry? retried;
      await tester.pumpWidget(
        _wrap(
          ChatMessageTile(
            queued: false,
            canResendImage: false,
            entry: resent,
            strings: AppStrings(AppLocale.zh),
            onRetry: (TimelineEntry e) => retried = e,
          ),
        ),
      );

      final String spoken =
          '${kSpokenAt.toLocal().month}/${kSpokenAt.toLocal().day}';
      expect(
        find.textContaining(spoken),
        findsOneWidget,
        reason: 'the original (dated) time survives the resend',
      );
      expect(find.textContaining('上次重发'), findsOneWidget);

      // The bare word is the BUTTON; the label is a different string, so a tap
      // on 「重发」 still fires the retry and cannot be shadowed by the label.
      expect(find.text('重发'), findsOneWidget);
      await tester.tap(find.text('重发'));
      expect(retried, isNotNull);
    });
  });

  group('③ it survives a relaunch', () {
    test('json round-trip keeps the instant; a legacy row without the key stays '
        'null (never epoch-0)', () {
      final DateTime at = DateTime.utc(2026, 7, 31, 15, 20, 7);
      final Map<String, Object?> j = _oldRow()
          .copyWith(lastResentAt: at)
          .toJson();
      expect(j['last_resent_at'], at.toIso8601String());
      expect(TimelineEntry.fromJson(j)!.lastResentAt!.isAtSameMomentAs(at),
          isTrue);

      // A row written by any build before this field existed. `_date()` would
      // have answered 1970-01-01 and the tile would confidently claim the user
      // re-sent it in 1970.
      final Map<String, Object?> legacy = _oldRow().toJson()
        ..remove('last_resent_at');
      expect(TimelineEntry.fromJson(legacy)!.lastResentAt, isNull);
    });

    test('through persistence + a fresh store.load() — i.e. after the app is '
        'killed and reopened', () async {
      final InMemoryTimelinePersistence disk = InMemoryTimelinePersistence();
      final TimelineStore first = newTestStore(persistence: disk);
      await disk.saveAll(<TimelineEntry>[_oldRow()]);
      await first.load();
      final TimelineEntry? marked = first.markReinjecting(kOldId);
      expect(marked!.lastResentAt, isNotNull);
      // markReinjecting persists fire-and-forget; let the upsert land.
      await pumpEventQueue();
      first.dispose();

      final TimelineStore relaunched = newTestStore(persistence: disk);
      await relaunched.load();
      final TimelineEntry reloaded = relaunched.findById(kOldId)!;
      expect(
        reloaded.lastResentAt!.isAtSameMomentAs(marked.lastResentAt!),
        isTrue,
        reason: 'the resend time is still there after a relaunch',
      );
      expect(reloaded.createdAt.isAtSameMomentAs(kSpokenAt), isTrue);
      relaunched.dispose();
    });
  });

  group('④ it is a phone-local display fact and never reaches the wire', () {
    test('toHistoryItem has no key for it', () {
      final Map<String, Object?> wire = _oldRow()
          .copyWith(lastResentAt: DateTime.utc(2026, 7, 31, 15, 20))
          .toHistoryItem(pcDeviceId: 'pc1', userId: 'u1');
      expect(wire.containsKey('last_resent_at'), isFalse);
      expect(
        wire.keys.where((String k) => k.contains('resent')),
        isEmpty,
        reason: 'not under another spelling either',
      );
    });

    test('the inject:request frame a resend emits carries no resend timestamp key',
        () async {
      final _Harness h = _Harness();
      final TimelineEntry old = await h.seed();
      h.controller.reInject(old);
      await pumpEventQueue();

      final Map<String, Object?> frame = Map<String, Object?>.from(
        h.injectFrames.single.data! as Map,
      );
      expect(
        frame.keys.where((String k) => k.contains('resent')),
        isEmpty,
        reason: 'this card is zero protocol change',
      );
      await h.dispose();
    });
  });
}
