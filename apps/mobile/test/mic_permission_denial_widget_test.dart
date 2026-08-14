// card U2 — the talk surface's mic-permission banner, asserted on RENDERED
// results through the PRODUCTION wiring (gesture → ChatController.pttDown →
// PttSession gate → face → chat_banner_sources → BannerSlot), never on
// Text.data alone (0.2.53 law: 「用户能不能读到这句话」 acceptance must land on the rendered result).
//
// ⚠️ Measuring caveat (0.2.53): flutter_test renders with the Ahem font — every
// glyph a full em square — so 「renders un-clipped here」 is CONSERVATIVE
// one-way evidence (Ahem fits ⇒ real fonts fit). Nothing here claims 「正好放得下」.
//
// 🔴 REVERSE CONTROL — actually executed 2026-08-04 (`PttSession.pttDown`
// replaced by its pre-U2 body: no gate, the `on Object { return false; }`
// swallow; restored afterwards, residual-marker grep = 0). MEASURED red on both
// production-wiring cases, at `_expectReadable`'s first line:
//   Found 0 widgets with text "麦克风权限被拒绝，无法录音": []
//   Found 0 widgets with text "FlowMic 需要使用麦克风，才能把你说的话变成文字": []
// That IS the audit's finding: the press refused, the screen said nothing. The
// third case (pure face→banner layout) stays green under the revert, correctly
// — it does not touch pttDown.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/mic_permission.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/mic_permission_banner.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';
import 'support/legibility.dart' show ahemWidthFor;

final AppStrings _zh = AppStrings.of(AppLocale.zh);

// ── harness (same shape as v204_touch_feedback_widget_test) ────────────────

ChatController _controller(
  FakeSocketTransport transport, {
  required FakeMicPermissionPort port,
  bool askedBefore = true,
}) {
  final PttSession session = PttSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: InMemoryTokenStorage(),
    micPermission: MicPermissionFlow(
      port: port,
      asked: InMemoryMicAskedStore(asked: askedBefore),
    ),
  );
  final TimelineStore store = newTestStore();
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: store,
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
}

void _disposeController(ChatController controller) {
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
  });
}

/// The narrow-phone width band on a real device (dp). **The product-criterion number**, kept separate from the measuring stick.
const double kPhoneDp = 411;

/// Phone-sized viewport — the banner has to survive a NARROW screen.
///
/// 🔴 Nine-locale expansion (2026-08-14): width is computed by
/// `ahemWidthFor(kPhoneDp, locale)`, no longer a hard-coded 411. The hard-coded
/// 411 version went red on the spot for fr (the French sentence was squeezed to
/// **77.75px wide**, hitting the `box.width >= 120` floor), and what was red
/// was the measuring stick, not the product:
/// Ahem stretches Latin glyphs to about twice the width ⇒ 411 on Latin does
/// not represent a 411dp real-device screen at all.
/// zh/ja/zhTw have a scale factor of 1.0, so for those locales this line is
/// still 411 byte-for-byte.
void _phoneView(WidgetTester tester, {AppLocale locale = AppLocale.zh}) {
  tester.view.physicalSize = Size(ahemWidthFor(kPhoneDp, locale) * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

/// Holds the bar past the long-press timeout and lets the async gate settle.
Future<TestGesture> _pressAndHold(WidgetTester tester) async {
  final TestGesture g = await tester.startGesture(
    tester.getCenter(find.byType(PttBar)),
  );
  await tester.pump(const Duration(milliseconds: 600));
  await tester.pump();
  await tester.pump();
  return g;
}

/// End an ACCEPTED hold by SWIPING UP (上滑取消) rather than releasing.
///
/// 🔴 Why not `g.up()` — measured 2026-08-04, not a preference:
/// `PttSession.pttUp` awaits `AudioCapture.stop()` → `_detachRecorder()` →
/// `await _pcmSub.cancel()`, and inside `testWidgets`' FakeAsync zone that
/// cancel future NEVER completes (instrumented run: 「detach enter」 printed,
/// 「detach sub cancelled」 only arrived after the test body was over, through 20
/// idle+pump rounds). The FSM therefore stays RECORDING and the panel's 200 ms
/// ticker outlives the test → 「A Timer is still pending」. That is the exact
/// deadlock recording_panel_widget_test.dart's header already warns about
/// (「a widget test must never await the real PttSession async chain … that
/// deadlock has already bitten this repo」) — it is NOT a U2 defect and the
/// release path is unchanged by this card.
///
/// The swipe-up path is fully synchronous (`audio.fenceAndStop()` transitions
/// first and only then `unawaited`s the detach), so it returns the FSM to IDLE
/// on screen and cancels the ticker. RECORDING→PROCESSING on release is pinned
/// instead in mic_permission_flow_test.dart's 「a denied press does NOT poison
/// the next one」, which drives PttSession outside FakeAsync.
Future<void> _swipeUpCancel(WidgetTester tester, TestGesture g) async {
  await g.moveBy(const Offset(0, -120));
  await tester.pump();
  await tester.pump();
  await g.up();
  await tester.pump();
}

/// The rendered-result bundle for one banner sentence (0.2.53 law).
///
/// `find.text` is only the LOCATOR here — every assertion below reads the
/// laid-out render object, never `Text.data`:
///   · no `maxLines` / no ellipsis to truncate with, and `didExceedMaxLines`
///     false — the 0.2.53 defect class itself;
///   · **intrinsic vs. actual box**: the paragraph's actual height equals the
///     height it NEEDS at its actual width, so no ancestor clipped lines off;
///   · the box lies inside the phone width, and a `RenderFlex` overflow (which
///     Flutter reports as a caught exception, i.e. a half-reported failure)
///     would fail the test;
///   · the message keeps a readable column rather than being starved to a
///     one-glyph ribbon by the action button — the 0.2.51 top-bar defect shape.
///     Measured worst case at 411dp: 148.3dp (en permanently-denied, whose
///     「Open settings」 action label is the widest); the floor below leaves
///     that margin visible instead of pretending it is comfortable.
/// 🔴 Nine-locale expansion (2026-08-14): both hard-coded constants (right
/// edge 411.5, readable floor 120) now follow [locale]'s measuring stick. They
/// were always two marks on the same screen; that screen previously had only
/// one width. Leaving 411.5 in place while only widening the viewport would
/// make every Latin-locale assertion fail on the spot
/// (the box's right edge would legally exceed 411.5, and that is not a defect).
void _expectReadable(
  WidgetTester tester,
  String sentence, {
  AppLocale locale = AppLocale.zh,
}) {
  final double screen = ahemWidthFor(kPhoneDp, locale);
  // The floor scales on the same stick: 120 is the conversion of 「a body-copy
  // column width you can actually read」 on a 411dp Chinese screen. Under Ahem
  // every Latin glyph is twice as wide, so the column-width floor must also be
  // twice as wide — otherwise this floor is an always-true sentence for Latin.
  final double minColumn = 120 * (screen / kPhoneDp);
  final Finder f = find.text(sentence);
  expect(f, findsOneWidget, reason: 'the sentence must actually be on screen: $sentence');
  expect(tester.takeException(), isNull,
      reason: 'a RenderFlex overflow is a failure half-reported');
  final Text w = tester.widget<Text>(f);
  expect(w.maxLines, isNull,
      reason: 'the banner wraps — a maxLines here would reintroduce the '
          '0.2.53 ellipsis class');
  expect(w.overflow, isNot(TextOverflow.ellipsis));
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  expect(p.didExceedMaxLines, isFalse);
  final Rect box = tester.getRect(f);
  expect(box.left, greaterThanOrEqualTo(0));
  expect(box.right, lessThanOrEqualTo(screen + 0.5),
      reason: 'the sentence must lay out INSIDE the phone width, not off-screen');
  expect(box.width, greaterThanOrEqualTo(minColumn),
      reason: 'a sentence squeezed into a ribbon is technically un-clipped and '
          'still unreadable: $sentence');
  expect(
    box.height,
    greaterThanOrEqualTo(p.getMinIntrinsicHeight(box.width) - 0.5),
    reason: 'actual box shorter than the intrinsic height at this width ⇒ '
        'lines were clipped away: $sentence',
  );
}

void main() {
  testWidgets(
      '🔴 U2-②/③: a denied press renders the NAMED refusal on the talk '
      'surface, its action runs the REAL request, and permanently-denied '
      'offers the openAppSettings way out', (WidgetTester tester) async {
    _phoneView(tester);
    final FakeSocketTransport transport = FakeSocketTransport();
    final FakeMicPermissionPort port =
        FakeMicPermissionPort(MicPermissionProbe.denied);
    final ChatController controller = _controller(transport, port: port);
    _disposeController(controller);

    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller)),
    );
    transport.pushStatus(SocketStatus.connected);
    await tester.pump();

    // Before the press: nothing to say, nothing said.
    expect(find.text(_zh.micDenied), findsNothing);

    final TestGesture g = await _pressAndHold(tester);
    await g.up();
    await tester.pump();

    // The named denial is ON the page (the reverse control turns exactly this
    // red: the old path refused silently).
    _expectReadable(tester, _zh.micDenied);

    // Its action fires the REAL OS request — and the OS answers 「don't ask
    // again」, so the banner must swap to the settings way out.
    port.requestAnswer = MicPermissionProbe.permanentlyDenied;
    await tester.tap(find.text(_zh.micAllowAction));
    await tester.pump();
    await tester.pump();
    expect(port.requestCalls, 1);
    _expectReadable(tester, _zh.micPermanentlyDenied);

    // 去设置开启 — the openAppSettings call the repo never had (U2-③).
    await tester.tap(find.text(_zh.micOpenSettingsAction));
    await tester.pump();
    expect(port.openSettingsCalls, 1);

    // FSM sanity at the surface: the bar is back to (stays at) idle copy, not
    // wedged in a recording face.
    expect(find.text(_zh.pttHold), findsOneWidget);
  });

  testWidgets(
      'U2-①: the FIRST press ever explains BEFORE any OS request; granting '
      'from the rationale unblocks the SAME session', (
    WidgetTester tester,
  ) async {
    _phoneView(tester);
    final FakeSocketTransport transport = FakeSocketTransport();
    final FakeMicPermissionPort port =
        FakeMicPermissionPort(MicPermissionProbe.denied);
    final ChatController controller =
        _controller(transport, port: port, askedBefore: false);
    _disposeController(controller);

    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller)),
    );
    transport.pushStatus(SocketStatus.connected);
    await tester.pump();

    final TestGesture g = await _pressAndHold(tester);
    await g.up();
    await tester.pump();

    // The rationale rendered, and NO OS dialog has fired — the request is born
    // on this surface's button, never cold in mid-gesture (the audit bug).
    _expectReadable(tester, _zh.micRationale);
    expect(port.requestCalls, 0);

    // The user allows; the OS grants.
    port.requestAnswer = MicPermissionProbe.granted;
    await tester.tap(find.text(_zh.micAllowAction));
    await tester.pump();
    await tester.pump();
    expect(port.requestCalls, 1);
    expect(find.text(_zh.micRationale), findsNothing,
        reason: 'the notice dies with the fact it was about');

    // The SAME session now records — the earlier refusal never wedged anything
    // (U2 acceptance ④ read off the SURFACE: the bar walks IDLE → RECORDING and
    // back to IDLE, and no mic notice comes back).
    final TestGesture g2 = await _pressAndHold(tester);
    // WP8 VF-2: the recording face paints `● ` before the frozen sentence (a
    // layout glyph concatenated in ptt_bar.dart — the strings shard is
    // untouched, and the dot deliberately stays out of the a11y label). This
    // case is about the bar REACHING the recording face, so it follows what is
    // painted rather than pinning the pre-mock spelling.
    expect(find.text('● ${_zh.pttRecording}'), findsOneWidget,
        reason: 'subsequent uses do not re-explain — they just record');
    await _swipeUpCancel(tester, g2);
    expect(find.text(_zh.pttHold), findsOneWidget,
        reason: 'the bar must come back to a sane IDLE face, never stay red');
    expect(find.text(_zh.micRationale), findsNothing);
    expect(find.text(_zh.micDenied), findsNothing);
  });

  testWidgets(
      'every language × four faces all lay out un-clipped at phone width '
      '(Ahem-conservative)', (WidgetTester tester) async {
    for (final AppLocale locale in AppLocale.values) {
      // 🔴 Viewport moved inside the loop (2026-08-14): the stick is computed
      // per language, so it can only be set after we know which locale it is.
      // The original line sat outside the loop and measured nine scripts with
      // one hard-coded 411.
      _phoneView(tester, locale: locale);
      final AppStrings s = AppStrings.of(locale);
      for (final MicFlowFace face in <MicFlowFace>[
        MicFlowFace.rationale,
        MicFlowFace.denied,
        MicFlowFace.permanentlyDenied,
        MicFlowFace.captureStartFailed,
      ]) {
        final MicPermissionFlow flow = MicPermissionFlow(
          port: FakeMicPermissionPort(MicPermissionProbe.denied),
          asked: InMemoryMicAskedStore(),
        );
        flow.face.value = face;
        final BannerQueue queue = BannerQueue();
        pushMicPermissionBanner(queue, flow: flow, strings: s);
        expect(queue.top, isNotNull, reason: '$locale/$face must push');

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: BannerSlot(queue: queue, strings: s)),
          ),
        );
        _expectReadable(tester, queue.top!.message, locale: locale);
        flow.dispose();
      }
    }
  });
}
