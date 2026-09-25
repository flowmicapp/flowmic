// Card NR-96-B — 「reconnecting the speech engine · attempt n[/N]」 on the two
// screens a recording is made on.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-reconnect-visibility-design.md §3.1 (five rules),
//     §3.3 (where each client draws it), §3.4 (single writer), §3.5 (optional
//     wire fields), §4 card B (this file is its acceptance)
//   apps/mobile/lib/src/session/engine_reconnect_state.dart (every edge)
//
// ── WHICH SCREENS, AND WHY THEY ARE MOUNTED ─────────────────────────────────
// Anti-façade ⑥: the deliverable is 「what the user sees while recording」, so
// every case mounts `ChatFlowPage` and lets production build the strip, the
// dock bar and the in-progress article page. Frames go in on the fake socket
// and come out as pixels; nothing between is stubbed. The one hand-built widget
// here is the nine-locale layout check at the bottom, which asks a question the
// page cannot (「does the chip fit a 296 dp dock」) and is labelled as such.
//
// ⚠️ Texts are compared against the GETTERS, never the words: the values are
// DEV placeholders until the copy lane writes them (D-47), and an assertion on
// the wording would break the day the real sentence lands.
//
// ⚠️ Three habits from article_screen_test.dart's header apply here:
// production futures are driven under `tester.runAsync`; the light-record
// screen is mounted tall (`mountLightRecordScreen`); and 「would a correct
// product also match this?」 — every absence below has a presence it follows.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart' show PttSessionContinuous;
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/engine_reconnect_state.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flowmic/src/ui/recording_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';
import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart' show makePcm;

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const Key _articleEngineLine = Key('article.live.engineReconnecting');

/// One `stt:engine-status` frame, through the real dispatch loop.
void _engine(
  ArticleRig r,
  String status, {
  int? count,
  int? max,
  int? waitMs,
  int? timeoutMs,
}) {
  r.transport.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
    'provider': 'soniox',
    'status': status,
    'retry_count': ?count,
    'retry_max': ?max,
    'retry_in_ms': ?waitMs,
    'attempt_timeout_ms': ?timeoutMs,
  });
}

void _interim(ArticleRig r, String text) =>
    r.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': text,
      'confidence': 0.5,
      'language': 'zh',
      'segment_idx': 0,
    });

String? _chipText(WidgetTester tester) {
  final Finder f = find.byKey(RecordingPanel.engineChipKey);
  if (f.evaluate().isEmpty) return null;
  return tester.widget<Text>(f).data;
}

// ── push-to-talk: the strip over the hold key ──────────────────────────────

/// A press that is being held, on the real light-record screen.
Future<ArticleRig> _holding(WidgetTester tester) async {
  final ArticleRig r = ArticleRig();
  addTearDown(r.dispose);
  await tester.runAsync(() async {
    await r.controller.pttDown();
    // Real PCM, so the dead-capture watchdog (1.5 s) cannot end the press
    // under a slow machine and take the chip with it for the wrong reason.
    r.recorder.feed(makePcm(6400));
    await pumpEventQueue();
  });
  await mountLightRecordScreen(tester, r);
  expect(
    find.byType(RecordingPanel),
    findsOneWidget,
    reason: 'positive control: the strip is on screen, so its absence of a '
        'chip below is about the chip',
  );
  return r;
}

/// Release, settle the terminal final, and let no timer outlive the case.
Future<void> _release(WidgetTester tester, ArticleRig r) async {
  await tester.runAsync(() async {
    await r.controller.pttUp();
    await r.say('收尾', 0, isSegment: false, durationMs: 1000);
  });
  await tester.pump(const Duration(seconds: 5));
  await tester.pump(const Duration(seconds: 5));
  debugCancelAsrHealthTicker(r.controller);
}

// ── long recording: the dock bar and the in-progress article page ──────────

Future<ArticleRig> _longRecording(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  final ArticleRig r = ArticleRig();
  final login = newTestLogin(
    transport: r.transport,
    accountStore: InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-nr96b', email: 'x@example.com', plan: 'pro'),
    ),
  );
  await tester.runAsync(login.hydrate);
  final account = newTestCloudSummary(
    login: login,
    fetcher: fixedCloudSummary(testSummary(continuousMinutes: 30)),
  );
  addTearDown(() async {
    account.dispose();
    login.dispose();
    await r.dispose();
  });
  await tester.runAsync(() async {
    account.refresh();
    await Future<void>.delayed(Duration.zero);
  });
  await tester.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(
        controller: r.controller,
        cloudSummary: account,
        isSignedIn: () => login.isLoggedIn,
      ),
    ),
  );
  await tester.pump();
  // The user's two taps: entry row, then Start on the briefing sheet.
  await tester.tap(find.byKey(ContinuousEntryKeys.row));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ContinuousSheetKeys.start));
  await _settle(tester);
  r.recorder.feed(makePcm(6400));
  expect(
    find.byType(ArticlePage),
    findsOneWidget,
    reason: 'positive control: Start opened the in-progress article page',
  );
  return r;
}

Future<void> _settle(WidgetTester tester) async {
  for (int i = 0; i < 4; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _stopLong(WidgetTester tester, ArticleRig r) async {
  await tester.runAsync(() async {
    await r.controller.pttUp();
    await r.say('收尾', 99, isSegment: false, durationMs: 1000);
  });
  r.session.endContinuous();
  await tester.pump(const Duration(seconds: 5));
  await tester.pump(const Duration(seconds: 5));
}

Finder _onPage(Finder f) =>
    find.descendant(of: find.byType(ArticlePage), matching: f);

String? _textAt(WidgetTester tester, Finder f) {
  if (f.evaluate().isEmpty) return null;
  final Finder text = find.descendant(of: f, matching: find.byType(Text));
  return tester.widget<Text>(text.first).data;
}

void main() {
  group('push-to-talk strip (the dock over the hold key)', () {
    testWidgets('🔴 attempt n of N while the relay re-dials, gone on the next '
        'interim', (WidgetTester tester) async {
      final ArticleRig r = await _holding(tester);
      expect(_chipText(tester), isNull, reason: 'nothing is being re-dialled');

      _engine(r, 'reconnecting', count: 2, max: 3, waitMs: 2000, timeoutMs: 10000);
      await tester.pump();
      expect(
        _chipText(tester),
        _zh.recEngineReconnectingOf(2, 3),
        reason: 'the relay named the budget, so the chip says n of N',
      );

      _interim(r, '又听见了');
      await tester.pump();
      expect(
        _chipText(tester),
        isNull,
        reason: 'an interim only comes from a live engine: still showing '
            '「reconnecting」 after it is the rule-5 lie',
      );
      expect(find.byType(RecordingPanel), findsOneWidget,
          reason: 'the chip went, not the strip');
      await _release(tester, r);
    });

    testWidgets('an old relay (no retry_max, no timing) ⇒ 「attempt n」, no '
        'total, no watchdog', (WidgetTester tester) async {
      final ArticleRig r = await _holding(tester);
      _engine(r, 'reconnecting', count: 1);
      await tester.pump();
      expect(_chipText(tester), _zh.recEngineReconnecting(1));
      expect(r.session.engineReconnect.value?.expiresAt, isNull,
          reason: 'no fact on the frame ⇒ no deadline invented locally');
      // Far past any deadline a new relay would give: the chip stays, because
      // only the four other edges may clear it now.
      await tester.pump(const Duration(seconds: 30));
      expect(_chipText(tester), _zh.recEngineReconnecting(1));
      await _release(tester, r);
    });

    testWidgets('ready ⇒ gone', (WidgetTester tester) async {
      final ArticleRig r = await _holding(tester);
      _engine(r, 'reconnecting', count: 1, max: 3);
      await tester.pump();
      expect(_chipText(tester), isNotNull);
      _engine(r, 'ready');
      await tester.pump();
      expect(_chipText(tester), isNull);
      await _release(tester, r);
    });

    testWidgets('🔴 failed ⇒ withdrawn, and the stt:error that follows does not '
        'bring it back', (WidgetTester tester) async {
      final ArticleRig r = await _holding(tester);
      _engine(r, 'reconnecting', count: 3, max: 3, waitMs: 4000, timeoutMs: 10000);
      await tester.pump();
      expect(_chipText(tester), _zh.recEngineReconnectingOf(3, 3));

      // The relay's own order (`failTerminal`): status first, then the error.
      _engine(r, 'failed', count: 3);
      expect(r.session.engineReconnect.value, isNull,
          reason: 'withdrawn on the failed frame itself, before the error lands');
      r.transport.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
        'code': 'STT_NETWORK_DROP',
        'message': 'Engine reconnect exhausted',
        'retryable': false,
      });
      await tester.pump();
      expect(_chipText(tester), isNull,
          reason: 'after the give-up no screen may say 「reconnecting」');
      await _release(tester, r);
    });

    testWidgets('🔴 the frame-derived watchdog clears it, and says nothing',
        (WidgetTester tester) async {
      final ArticleRig r = await _holding(tester);
      _engine(r, 'reconnecting', count: 1, max: 3, waitMs: 1000, timeoutMs: 10000);
      await tester.pump();
      expect(_chipText(tester), _zh.recEngineReconnectingOf(1, 3));

      await tester.pump(const Duration(milliseconds: 10500));
      expect(_chipText(tester), isNotNull,
          reason: 'inside retry_in_ms + attempt_timeout_ms the relay is not late');
      await tester.pump(const Duration(milliseconds: 1000));
      expect(_chipText(tester), isNull,
          reason: 'past it the relay stopped reporting progress ⇒ the chip goes');
      expect(r.controller.sttStalled, isNull,
          reason: 'expiry is neither success nor failure: no sentence replaces it');
      await _release(tester, r);
    });

    testWidgets('two objects, two chips: the link face and the engine face '
        'stand together', (WidgetTester tester) async {
      final ArticleRig r = await _holding(tester);
      r.transport.pushStatus(SocketStatus.reconnecting);
      await tester.pump();
      _engine(r, 'reconnecting', count: 2, max: 3);
      await tester.pump();
      expect(find.text(_zh.recLinkDegraded), findsOneWidget);
      expect(_chipText(tester), _zh.recEngineReconnectingOf(2, 3));
      r.transport.pushStatus(SocketStatus.connected);
      await tester.pump();
      await _release(tester, r);
    });
  });

  group('long recording (the dock bar and the in-progress article page)', () {
    testWidgets('🔴 the status line and the bar chip appear together and go '
        'together', (WidgetTester tester) async {
      final ArticleRig r = await _longRecording(tester);
      expect(_onPage(find.byKey(_articleEngineLine)), findsNothing);
      expect(_onPage(find.byKey(ContinuousLiveKeys.engine)), findsNothing);

      _engine(r, 'reconnecting', count: 2, max: 3, waitMs: 2000, timeoutMs: 10000);
      await tester.pump();
      final String want = _zh.articleLiveEngineReconnecting(2);
      expect(_textAt(tester, _onPage(find.byKey(_articleEngineLine))), want,
          reason: 'the page is the screen the user is reading');
      expect(_textAt(tester, _onPage(find.byKey(ContinuousLiveKeys.engine))),
          want,
          reason: 'the bar at its foot says the same, from the same value');

      await tester.runAsync(
        () => r.say('引擎回来了', 0, isSegment: true, durationMs: 30000),
      );
      await tester.pump();
      expect(_onPage(find.byKey(_articleEngineLine)), findsNothing);
      expect(_onPage(find.byKey(ContinuousLiveKeys.engine)), findsNothing);
      await _stopLong(tester, r);
    });

    testWidgets('back on the list, the dock bar carries the chip; ready clears '
        'it', (WidgetTester tester) async {
      final ArticleRig r = await _longRecording(tester);
      await tester.pageBack();
      await _settle(tester);
      expect(find.byType(ArticlePage), findsNothing);
      expect(find.byKey(ContinuousLiveKeys.bar), findsOneWidget,
          reason: 'positive control: the dock bar is on screen');

      _engine(r, 'reconnecting', count: 1);
      await tester.pump();
      expect(_textAt(tester, find.byKey(ContinuousLiveKeys.engine)),
          _zh.articleLiveEngineReconnecting(1));
      _engine(r, 'ready');
      await tester.pump();
      expect(find.byKey(ContinuousLiveKeys.engine), findsNothing);
      await _stopLong(tester, r);
    });
  });

  // ── the one hand-built widget: does the chip fit a narrow dock? ───────────
  //
  // D-15: 「can the user read it」 is asserted on the rendered paragraph, not
  // on `Text.data`. 296 dp is a 320 dp phone's dock (recording_panel.dart's
  // own P3 note). Only the engine chip is on trial: the link and segment chips
  // share a row this card did not touch, and under Ahem that row is already
  // wider than 296 dp on its own — measured on the first run of this file,
  // which is why the engine chip was given a line of its own.
  for (final AppLocale locale in AppLocale.values) {
    testWidgets('296 dp, ${locale.name}: the engine chip wraps rather than '
        'losing words', (WidgetTester tester) async {
      final AppStrings s = AppStrings.of(locale);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 296,
                child: RecordingPanel(
                  elapsed: const Duration(seconds: 12),
                  amplitudeWindow: const <double>[-20, -18, -22],
                  segmentCount: 0,
                  link: RecordingLink.ok,
                  strings: s,
                  engineReconnect: const EngineReconnectFace(
                    attempt: 2,
                    max: 3,
                    provider: 'soniox',
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull, reason: 'no overflow');
      final RenderParagraph p = tester.renderObject<RenderParagraph>(
        find.byKey(RecordingPanel.engineChipKey),
      );
      expect(p.text.toPlainText(), s.recEngineReconnectingOf(2, 3));
      expect(p.didExceedMaxLines, isFalse,
          reason: 'an ellipsis would cut the words the user needs');
    });
  }
}
