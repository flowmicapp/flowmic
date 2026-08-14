// fix-026 — WHY the recording stopped, from the wire to the glyphs on screen.
//
// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §B-5 (a recording that stops must never
//     silently vanish) / CLAUDE.md red line: no silent failure (both directions)
//   packages/protocol/src/protocol-schemas-audio.ts `AudioAutoStoppedSchema`
//   apps/server-core/src/engine/stt-session-autostop.ts (fix-020's emitter table)
//   apps/mobile/lib/src/settings/strings/recording_strings.dart (the copy)
//
// ── WHAT WAS WRONG, STATED SO THE TEST'S SHAPE FOLLOWS FROM IT ───────────────
//
// fix-020 made the server say WHY: `audio:auto-stopped` carries a `reason`
// mapped through a compile-checked table, and the four-language copy plus a
// selector keyed on the WIRE STRING (`recordingAutoStoppedMessage`) landed with
// it. None of it reached a user. `PttSession` exposed `Stream<void>`,
// `ptt_inbound.dart` pushed `null` into it, and `banner_queue.dart` therefore
// asked for the bare five-minute sentence unconditionally — so every auto-stop
// of every cause told the user they had hit a five-minute limit, including the
// one cause that actually fires in production today (quota exhaustion), for
// which "press once and keep talking" is simply false.
//
// 🔴 THE SUITE WAS GREEN THROUGHOUT. It could not have been otherwise: the
// selector was unit-tested against its own table, and the banner was tested by
// handing `buildChatBanners` a bool a human typed in. Nothing ran a FRAME
// through the real seam. So this file starts at a frame on the socket and ends
// at the laid-out text — one hop before the user's eyes, which is as far as any
// Flutter test can go.
//
// ⚠️ THE ASSERTIONS ARE ON THE RENDERED RESULT, NOT ON `Text.data`. 0.2.53
// shipped a fully green suite next to three letters on a screen because
// `cloud_image_error_copy_test.dart` knew the row clipped and asserted around
// the clipping (`inject_verdict_note_test.dart`'s header records the whole
// account). Every visible-copy claim below is made against the `RenderParagraph`
// the framework actually laid out: its span, its `didExceedMaxLines`, and its
// on-screen rectangle inside the banner's.
//
// 🔴 WHAT A GREEN RUN HERE DOES **NOT** PROVE: that a user who records until
// their quota runs out reads the right sentence. It proves the phone renders
// what it is TOLD — not that it is being told the truth yet. The origin feeding
// `reason` is still wrong in production (carded as fix-025), so today a real
// quota stop would arrive here labelled `hard_limit` and this whole path would
// faithfully render the five-minute sentence. That half is device-line.
//
// ⚠️ THE FONT IS AHEM, so every glyph is a full em square: at 12 px a 360 dp
// banner fits ~20 characters per line where a real font fits far more. The
// direction is conservative for "will it be clipped" (not clipped under Ahem ⇒ not
// clipped on a device) and it does NOT run backwards — nothing here may be read
// as "it happens to fit on a real device".

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_banner_sources.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const AppStrings _zh = AppStringsZh();
const AppStrings _en = AppStringsEn();

/// The two reasons `stt-session-autostop.ts` can actually emit today.
const String kHardLimit = 'hard_limit';
const String kQuota = 'quota_exhausted';

/// In `AudioAutoStoppedSchema` and emitted by nobody (measured by fix-020 and
/// restated at `recordingAutoStoppedUnknown`). They must reach the unknown
/// branch — inventing copy for a frame nobody sends is a façade with a
/// translation budget, and lending them the five-minute sentence is worse.
const List<String> kUnemittedSchemaReasons = <String>[
  'mobile_disconnect',
  'engine_failed',
  'auth_expired',
];

/// A value no build knows: a phone that has fallen behind the protocol.
const String kFutureReason = 'thermal_shutdown';

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

/// The real data layer + the real orchestration hub + the real banner adapter.
/// Only the socket and the recorder are doubles, so every hop between the frame
/// and the sentence is production code — that seam is the whole subject.
class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create() {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.store = newTestStore(owner: _FakeOwner('inst-026', '书房电脑'));
    r.destination = DestinationController();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    r.transport.pushStatus(SocketStatus.connected);
    return r;
  }

  /// The server ended the recording, byte-shaped as `AudioAutoStoppedSchema`
  /// emits it (`stt-session.ts` `onAutoStopped` → fix-020's table).
  void cap(String reason) => transport.pushIncoming(
    FlowMicEvents.audioAutoStopped,
    <String, Object?>{'reason': reason},
  );

  /// An OFF-CONTRACT frame: `reason` is required on the wire, so this is either
  /// a relay that stripped it or a server older than fix-020. The phone reads
  /// inbound frames as plain JSON and never re-validates, so this really can
  /// arrive — and it must NOT be smoothed into the five-minute sentence.
  void capWithNoReason() => transport.pushIncoming(
    FlowMicEvents.audioAutoStopped,
    const <String, Object?>{},
  );

  BannerQueue banners(AppStrings strings) => chatBannerSources(
    controller: controller,
    strings: strings,
    onRetrySendFailure: null,
  );

  void teardownSync() {
    debugCancelBannerAutoHideTimers(controller);
    controller.dispose();
    destination.dispose();
    store.dispose();
  }
}

/// The one banner slot, fed by the PRODUCTION adapter and rebuilt on every
/// controller notify — the same two things `ChatFlowPage` does.
Widget _slotApp(ChatController c, AppStrings strings) => MaterialApp(
  home: Scaffold(
    body: Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        AnimatedBuilder(
          animation: c,
          builder: (BuildContext context, Widget? child) => BannerSlot(
            queue: chatBannerSources(
              controller: c,
              strings: strings,
              onRetrySendFailure: null,
            ),
            strings: strings,
          ),
        ),
      ],
    ),
  ),
);

/// The sentence's text as the framework LAID IT OUT — one step past the widget's
/// own `data`, which is the step 0.2.53 was lost on.
final Finder _bannerText = find.descendant(
  of: find.byType(BannerSlot),
  matching: find.byType(Text),
);

RenderParagraph _paragraph(WidgetTester tester) {
  expect(
    _bannerText,
    findsOneWidget,
    reason: 'the slot is showing exactly one sentence — more than one would '
        'mean this helper is measuring an action label or an overflow chip '
        'instead of the banner copy',
  );
  return tester.renderObject<RenderParagraph>(_bannerText);
}

String _renderedSentence(WidgetTester tester) =>
    _paragraph(tester).text.toPlainText();

/// How wide this exact span would want to be on ONE line. Compared against the
/// box it actually got, it says whether the sentence is under any layout
/// pressure at all — without that control, "was not clipped" may only mean "this
/// sentence was short to begin with" and the test is blind to the regression it exists for.
double _singleLineWidth(RenderParagraph p) => (TextPainter(
  text: p.text,
  textDirection: TextDirection.ltr,
  maxLines: 1,
)..layout()).width;

/// The whole sentence is inside the banner it belongs to — the check that
/// catches a wrapped line rendered outside a fixed-height container, which
/// `didExceedMaxLines` alone cannot see.
void _expectFullyInsideBanner(WidgetTester tester) {
  final Rect banner = tester.getRect(find.byType(BannerSlot));
  final Rect text = tester.getRect(_bannerText);
  expect(banner.contains(text.topLeft), isTrue, reason: 'text starts outside');
  expect(
    banner.contains(text.bottomRight - const Offset(0.01, 0.01)),
    isTrue,
    reason: 'the last line is rendered outside the banner box (clipped)',
  );
  expect(
    _paragraph(tester).didExceedMaxLines,
    isFalse,
    reason: 'the sentence overflowed its maxLines — the 0.2.53 shape exactly',
  );
}

/// A 360 dp Android phone, the narrowest common width. The default 800x600
/// surface is a tablet and would hide every layout question this file asks.
void _narrowPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

/// A rig whose teardown runs in the HARNESS, never in the test body.
///
/// ⚠️ Measured, not stylistic: an earlier draft disposed the rig inline at the
/// end of a `testWidgets` body so one test could loop over several reasons.
/// That await chain never completed and the case died on the 10-minute test
/// timeout. `addTearDown` is the shape every other widget test in this repo
/// uses, so each reason gets its own case instead of a loop inside one.
_Rig _rig() {
  final _Rig r = _Rig.create();
  addTearDown(() async {
    await r.controller.dispose();
    r.destination.dispose();
    r.store.dispose();
    await r.session.dispose();
    await r.transport.close();
  });
  return r;
}

/// Deliver the frame's consequences AND repaint. Two pumps, not one.
///
/// 🔴 MEASURED, AND THE FIRST DRAFT GOT IT WRONG. `audio:auto-stopped` travels
/// on an ASYNC broadcast stream, so the controller's listener — the thing that
/// sets the flag and calls `notifyListeners` — has not run yet when `pump()` is
/// entered. `pump()` only builds `if (hasScheduledFrame)`, and at that instant
/// nothing has scheduled one; it then flushes the microtask on its way out, so
/// the state changes and the repaint is left for the NEXT pump.
///
/// ⚠️ A single pump nonetheless passes whenever something else happens to have
/// scheduled a frame first — which is exactly what hid this: the sibling test
/// `w83_autostop_banner_test.dart` holds PTT down, so the cap's `fsm.onPttUp()`
/// succeeds, and the FSM's `sync: true` change stream notifies the controller
/// SYNCHRONOUSLY during the push. Its one pump is load-bearing for a reason it
/// never states. Two pumps make the assertion about the product instead of
/// about who else happened to schedule a frame.
///
/// ⚠️ NOT `pumpAndSettle()`: that advances the clock and would fire the 4 s
/// banner auto-hide, dismissing the very sentence under assertion.
Future<void> _deliverAndPaint(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

/// `AutomatedTestWidgetsFlutterBinding` asserts no Timer is pending the instant
/// the tree is torn down — which is BEFORE `addTearDown` runs. A test that
/// leaves the auto-stop banner up (never dismissed, never elapsed) has the 4 s
/// auto-hide timer armed, exactly the case `debugCancelBannerAutoHideTimers`
/// exists for (see its doc).
void _releaseTimers(_Rig r) {
  debugCancelBannerAutoHideTimers(r.controller);
  r.session.debugStopIdlePresencePoll();
}

void main() {
  setUp(DiagLog.instance.clear);

  // ── ① the wire value survives the data layer ──────────────────────────────
  group('the stream carries the reason VERBATIM (it used to carry null)', () {
    test('every schema reason, plus one this build has never heard of', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        final List<String> seen = <String>[];
        final sub = r.session.autoStopped.listen(seen.add);
        for (final String reason in <String>[
          kHardLimit,
          kQuota,
          ...kUnemittedSchemaReasons,
          kFutureReason,
        ]) {
          r.cap(reason);
          async.flushMicrotasks();
        }
        expect(seen, <String>[
          kHardLimit,
          kQuota,
          ...kUnemittedSchemaReasons,
          kFutureReason,
        ]);
        sub.cancel();
        r.teardownSync();
        async.flushTimers();
      });
    });

    test('a frame with no reason yields "" — never a substituted default', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        final List<String> seen = <String>[];
        final sub = r.session.autoStopped.listen(seen.add);
        r.capWithNoReason();
        async.flushMicrotasks();
        // 🔴 The assertion that matters is the NEGATIVE one: an off-contract
        // frame must not be handed a plausible cause, because the resulting
        // sentence would look perfectly normal and nobody would ever question it.
        expect(seen, <String>['']);
        expect(seen.single, isNot(kHardLimit));
        sub.cancel();
        r.teardownSync();
        async.flushTimers();
      });
    });

    test('the controller holds the reason only while the banner is up', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        expect(r.controller.autoStopReason, isNull, reason: 'positive control');
        r.cap(kQuota);
        async.flushMicrotasks();
        expect(r.controller.autoStopReason, kQuota);
        r.controller.dismissAutoStopped();
        // A reason that outlives the banner it explains describes a fact that
        // is no longer true — gated on the flag, so this holds by construction.
        expect(r.controller.autoStopReason, isNull);
        r.teardownSync();
        async.flushTimers();
      });
    });
  });

  // ── ② the rendered sentence, one wire reason at a time ────────────────────
  group('a frame arrives → the matching sentence is on screen', () {
    testWidgets('hard_limit renders the five-minute sentence, byte-for-byte',
        (WidgetTester tester) async {
      _narrowPhone(tester);
      final _Rig r = _rig();
      await tester.pumpWidget(_slotApp(r.controller, _zh));
      expect(_bannerText, findsNothing, reason: 'positive control: the slot is '
          'empty before the frame, so a hit below is the frame talking');

      r.cap(kHardLimit);

      await _deliverAndPaint(tester);

      // 🔴 The constraint this card must not break: the sentence written for a
      // real time ceiling is still exactly that sentence for that ceiling.
      expect(_renderedSentence(tester), _zh.recordingAutoStopped);
      _expectFullyInsideBanner(tester);
      _releaseTimers(r);
    });

    testWidgets('quota_exhausted renders the quota sentence, not the ceiling one',
        (WidgetTester tester) async {
      _narrowPhone(tester);
      final _Rig r = _rig();
      await tester.pumpWidget(_slotApp(r.controller, _zh));
      r.cap(kQuota);
      await _deliverAndPaint(tester);

      final String shown = _renderedSentence(tester);
      expect(shown, _zh.recordingAutoStoppedQuota);
      // 🔴 The defect, stated as an assertion. This is the ONE reason that
      // actually ends a recording in production (N1-B4 turned the five-minute
      // wall into an invisible engine rollover), so before this card the phone
      // was wrong at the exact moment it spoke.
      expect(shown, isNot(_zh.recordingAutoStopped));
      _expectFullyInsideBanner(tester);
      _releaseTimers(r);
    });

    // One case per reason rather than one case with a loop — see [_rig].
    for (final String reason in kUnemittedSchemaReasons) {
      testWidgets('$reason (in the schema, emitted by nobody) reaches the '
          'unknown branch', (WidgetTester tester) async {
        _narrowPhone(tester);
        final _Rig r = _rig();
        await tester.pumpWidget(_slotApp(r.controller, _zh));
        r.cap(reason);
        await _deliverAndPaint(tester);

        final String shown = _renderedSentence(tester);
        expect(shown, _zh.recordingAutoStoppedUnknown(reason));
        expect(shown, isNot(_zh.recordingAutoStopped));
        // The raw identifier is deliberately VISIBLE: a build that has fallen
        // behind the protocol should look like it has, rather than reading as
        // a confident sentence about something nobody verified.
        expect(shown, contains(reason));
        _expectFullyInsideBanner(tester);
        _releaseTimers(r);
      });
    }

    testWidgets('🔴 an UNKNOWN reason never renders the five-minute sentence',
        (WidgetTester tester) async {
      _narrowPhone(tester);
      final _Rig r = _rig();
      await tester.pumpWidget(_slotApp(r.controller, _zh));
      r.cap(kFutureReason);
      await _deliverAndPaint(tester);

      final String shown = _renderedSentence(tester);
      expect(shown, isNot(_zh.recordingAutoStopped));
      expect(shown, isNot(_zh.recordingAutoStoppedQuota));
      expect(shown, _zh.recordingAutoStoppedUnknown(kFutureReason));
      expect(shown, contains(kFutureReason));
      _expectFullyInsideBanner(tester);
      _releaseTimers(r);
    });

    testWidgets('an off-contract frame with no reason does not get the ceiling '
        'sentence either', (WidgetTester tester) async {
      _narrowPhone(tester);
      final _Rig r = _rig();
      await tester.pumpWidget(_slotApp(r.controller, _zh));
      r.capWithNoReason();
      await _deliverAndPaint(tester);

      final String shown = _renderedSentence(tester);
      // It still says the recording stopped — 08 §B-5 is not waived by a bad
      // frame — and it still does not claim a cause it was never told.
      expect(shown, isNotEmpty);
      expect(shown, isNot(_zh.recordingAutoStopped));
      expect(shown, _zh.recordingAutoStoppedUnknown(''));
      _expectFullyInsideBanner(tester);
      _releaseTimers(r);
    });
  });

  // ── ③ the measurement, where the sentence is actually under pressure ──────
  testWidgets('🔴 the English quota sentence is readable IN FULL at 360 dp',
      (WidgetTester tester) async {
    _narrowPhone(tester);
    final _Rig r = _Rig.create();
    addTearDown(() async {
      await r.controller.dispose();
      r.destination.dispose();
      r.store.dispose();
      await r.session.dispose();
      await r.transport.close();
    });
    await tester.pumpWidget(_slotApp(r.controller, _en));
    r.cap(kQuota);
    await _deliverAndPaint(tester);

    final RenderParagraph p = _paragraph(tester);
    expect(p.text.toPlainText(), _en.recordingAutoStoppedQuota);
    // positive control — the sentence really is longer than one line of this box, so
    // "was not clipped" below is a statement about the layout and not about the
    // sentence happening to be short. (Ahem: every glyph is a full em square,
    // so this is the conservative direction — see the file header.)
    expect(
      _singleLineWidth(p),
      greaterThan(p.size.width),
      reason: 'this sentence fits on one line here, so the clipping assertion '
          'below proves nothing — pick a narrower box or a longer string',
    );
    _expectFullyInsideBanner(tester);
    debugCancelBannerAutoHideTimers(r.controller);
    r.session.debugStopIdlePresencePoll();
  });

  // ── ④ the whole page, not just the slot ───────────────────────────────────
  testWidgets('the sentence reaches the CHAT PAGE, not only a hand-built slot',
      (WidgetTester tester) async {
    // ⚠️ THE DEFAULT SURFACE, and the reason is written down because I first
    // wrote down a WRONG one. This case failed twice with 「Found 0 widgets …
    // descending from BannerSlot」 and my first diagnosis — that the page does
    // not fit a 360 dp Ahem layout — was a guess. A probe said otherwise:
    // `slots=1 flag=true reason=quota_exhausted top=auto_stop msg=本月的…` with
    // the sentence still absent from the tree ⇒ nothing was wrong with the
    // width or with the queue; the tree had simply not been rebuilt yet (see
    // [_deliverAndPaint]). The default surface is kept only because it is the
    // one `w83_autostop_banner_test.dart` uses for the same page, and the
    // narrow-screen question is asked of the slot above where it is answerable.
    final _Rig r = _rig();
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();
    // The cap can arrive with the FSM out of RECORDING (a disconnect edge does
    // exactly that), and `w83_autostop_banner_test.dart` pins that the notice
    // is raised anyway — so this exercises the page WITHOUT arming the 15 s
    // stall net that a PTT-down would leave pending at teardown.
    r.cap(kQuota);
    await _deliverAndPaint(tester);

    expect(
      find.descendant(
        of: find.byType(BannerSlot),
        matching: find.text(_zh.recordingAutoStoppedQuota),
      ),
      findsOneWidget,
      reason: 'the page builds its queue through chatBannerSources — if the '
          'reason stops there, the whole chain ends at the five-minute sentence',
    );
    r.controller.delivery.dispose();
    _releaseTimers(r);
  });

  // ── ⑤ the copy contract, in all four languages ────────────────────────────
  group('the selector, four languages', () {
    test('hard_limit maps to the UNCHANGED five-minute sentence everywhere', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(
          s.recordingAutoStoppedMessage(kHardLimit),
          s.recordingAutoStopped,
          reason: '$locale',
        );
      }
    });

    test('quota_exhausted says something ELSE in every language', () {
      // Two ceilings that lead somewhere different must not read the same:
      // pressing the button again works after a time wall and changes nothing
      // after this one.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String quota = s.recordingAutoStoppedMessage(kQuota);
        expect(quota, s.recordingAutoStoppedQuota, reason: '$locale');
        expect(quota, isNot(s.recordingAutoStopped), reason: '$locale');
        expect(quota, isNotEmpty, reason: '$locale');
      }
    });

    test('🔴 no unknown reason may reach the five-minute sentence, any language',
        () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String reason in <String>[
          ...kUnemittedSchemaReasons,
          kFutureReason,
          '',
          'HARD_LIMIT', // case matters: the wire value is lower-case
          'hard_limit_v2',
        ]) {
          expect(
            s.recordingAutoStoppedMessage(reason),
            isNot(s.recordingAutoStopped),
            reason: '$locale/$reason',
          );
        }
      }
    });
  });

  // ── ⑥ fix-016's instrument, carried across ────────────────────────────────
  test('W8-3: emit + receipt are still both recorded, and now name the reason',
      () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      r.cap(kQuota);
      async.flushMicrotasks();

      final List<String> trail = DiagLog.instance.snapshot();
      final Iterable<String> emitted =
          trail.where((String l) => l.contains('audio.auto_stopped.emitted'));
      final Iterable<String> received =
          trail.where((String l) => l.contains('audio.auto_stopped.received'));
      expect(emitted, hasLength(1));
      expect(received, hasLength(1));
      // 🔴 UNCHANGED FROM fix-016 AND LOAD-BEARING: a broadcast controller with
      // no listener DISCARDS the event, an outcome byte-identical — in every
      // log, test and screenshot — to an arm that never ran. This is the fact
      // that separates the two surviving W8-3 hypotheses, and widening the
      // stream must not have cost us it.
      expect(emitted.first, contains('has_listener=true'));
      expect(emitted.first, contains('closed=false'));
      // NEW: the pair can now be checked to be about the same auto-stop, and a
      // device round can read WHICH ceiling fired without a second instrument.
      expect(emitted.first, contains('reason=$kQuota'));
      expect(received.first, contains('reason=$kQuota'));
      r.teardownSync();
      async.flushTimers();
    });
  });
}
