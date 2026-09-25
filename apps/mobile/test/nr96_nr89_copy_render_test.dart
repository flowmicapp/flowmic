// NR-96 / NR-89 copy landing (2026-09-24) — the landed sentences, rendered in
// all nine locales on a 360 dp phone (D-15).
//
// WHY THIS FILE EXISTS: the surfaces below already had tests, but only in zh
// and mostly on `Text.data` or at a wide canvas:
//   · `reconnect_banners_test.dart` mounts the banners at 800 px, zh only;
//   · `article_backfill_placement_test.dart` checks the continuous-engine
//     banner's presence, zh only;
//   · `engine_reconnect_face_test.dart` mounts the dock bar and the article
//     page's status line in zh only; its nine-locale case measures the push-
//     to-talk strip at 296 dp with `didExceedMaxLines`, which is vacuous there
//     (that Text has no `maxLines`, `recording_panel.dart`);
//   · `rerun_copy_render_test.dart` measures the long-press sheet at 411 dp.
// The pending-recovery card already has a nine-locale 360 dp case
// (`recovery_copy_matches_capability_test.dart`) and is not repeated here.
//
// THE RULER: `support/legibility.dart` `ahemWidthBudget` (a 360 dp real screen,
// converted per script for the Ahem test font) and `expectLegible` (the
// repo's one instrument for 「can the user read it」). None of these Text
// widgets carries `maxLines`, so an ellipsis is impossible by construction;
// what can go wrong is a RenderFlex overflow (the harness throws) or a line
// that was laid out wider than its box without wrapping (`expectLegible` ④).
//
// Strings are compared against the getters, never quoted, so this file holds
// for whatever wording the copy pipeline lands next.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart' show PttSessionContinuous;
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/engine_reconnect_state.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart' show ConnectionState;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flowmic/src/ui/entry_context_menu.dart';
import 'package:flowmic/src/ui/recording_panel.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/article_rig.dart';
import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart' show makePcm;
import 'support/legibility.dart' show ahemWidthBudget, ahemWidthFor, expectLegible, neededWidthOf;

/// The Text widget whose painted string is [text].
Finder _textOf(String text) => find.byWidgetPredicate((Widget w) => w is Text && w.data == text);

/// Painted, legible, and nothing overflowed. Returns whether the sentence was
/// under pressure (it needed more width than its box, so it had to wrap), and
/// prints one line per sentence so a run can say which locale wrapped where.
bool _expectRendered(WidgetTester tester, Finder f, String want, String why) {
  expect(f, findsOneWidget, reason: '$why: not on screen');
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  expect(p.text.toPlainText(), want, reason: why);
  expectLegible(tester, f, reason: why);
  expect(tester.takeException(), isNull, reason: '$why: overflow');
  final double need = neededWidthOf(p);
  final bool pressured = need > p.size.width;
  // ignore: avoid_print
  print('RENDER $why box=${p.size.width.toStringAsFixed(0)} need=${need.toStringAsFixed(0)}'
      '${pressured ? ' WRAPPED' : ''}');
  return pressured;
}

void main() {
  // ── ① chat-page banners (link ladder, re-ask notice, continuous engine) ─────
  group('banners, nine locales, 360 dp', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: every NR-96 banner sentence renders whole', (WidgetTester tester) async {
        final double width = ahemWidthBudget(locale);
        await tester.binding.setSurfaceSize(Size(width, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final AppStrings s = AppStrings.of(locale);
        final Map<String, (BannerQueue, String)> cases = <String, (BannerQueue, String)>{
          'bannerReconnectingN': (
            buildChatBanners(
              connection: ConnectionState.reconnecting,
              autoStopped: false,
              strings: s,
              ladderReconnecting: true,
              ladderAttempt: 12,
              onReconnectNow: () {},
            ),
            s.bannerReconnectingN(12),
          ),
          'bannerReconnectingNOf': (
            buildChatBanners(
              connection: ConnectionState.reconnecting,
              autoStopped: false,
              strings: s,
              ladderReconnecting: true,
              ladderAttempt: 4,
              ladderMaxAttempts: 5,
              onReconnectNow: () {},
            ),
            s.bannerReconnectingNOf(4, 5),
          ),
          'reconnectAckLostNotice': (
            buildChatBanners(
              connection: ConnectionState.connected,
              autoStopped: false,
              strings: s,
              reconnectAckLost: true,
              onReconnectAckLostRetry: () {},
              onDismissReconnectAckLost: () {},
            ),
            s.reconnectAckLostNotice,
          ),
          'bannerContinuousEngineDown': (
            buildChatBanners(
              connection: ConnectionState.connected,
              autoStopped: false,
              strings: s,
              continuousEngineDown: true,
            ),
            s.bannerContinuousEngineDown,
          ),
          'bannerContinuousEngineDownKept': (
            buildChatBanners(
              connection: ConnectionState.connected,
              autoStopped: false,
              strings: s,
              continuousEngineDown: true,
              continuousEngineKept: true,
            ),
            s.bannerContinuousEngineDownKept,
          ),
        };
        int wrapped = 0;
        for (final MapEntry<String, (BannerQueue, String)> c in cases.entries) {
          final (BannerQueue q, String want) = c.value;
          expect(q.top?.message, want, reason: '${locale.name} ${c.key}: production picked another sentence');
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topCenter,
                  child: BannerSlot(queue: q, strings: s),
                ),
              ),
            ),
          );
          if (_expectRendered(tester, _textOf(want), want, '${locale.name} ${c.key}')) wrapped++;
        }
        // Positive control: the re-ask notice is two sentences, so at least one
        // banner here must have needed a second line. If none did, the
        // legibility assertions above were never under load.
        expect(wrapped, greaterThan(0), reason: '${locale.name}: no banner was under pressure — this case is blind');
      });
    }
  });

  // ── ② push-to-talk strip engine chip (the dock over the hold key) ───────────
  group('recording strip engine chip, nine locales', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: both chip forms render whole in a 360 dp dock', (WidgetTester tester) async {
        final AppStrings s = AppStrings.of(locale);
        // The dock is the phone width minus its own 24 dp of margin
        // (recording_panel.dart P3 note: a 320 dp phone gives a 296 dp dock).
        final double dock = ahemWidthFor(336, locale);
        for (final int? max in <int?>[null, 5]) {
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topLeft,
                  child: SizedBox(
                    width: dock,
                    child: RecordingPanel(
                      elapsed: const Duration(seconds: 12),
                      amplitudeWindow: const <double>[-20, -18, -22],
                      segmentCount: 0,
                      link: RecordingLink.ok,
                      strings: s,
                      engineReconnect: EngineReconnectFace(attempt: 3, max: max, provider: 'soniox'),
                    ),
                  ),
                ),
              ),
            ),
          );
          final String want = max == null ? s.recEngineReconnecting(3) : s.recEngineReconnectingOf(3, max);
          _expectRendered(tester, find.byKey(RecordingPanel.engineChipKey), want, '${locale.name} max=$max');
        }
      });
    }
  });

  // ── ③ long recording: the dock bar chip ─────────────────────────────────────
  group('continuous live bar engine chip, nine locales, 360 dp', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: the chip renders whole', (WidgetTester tester) async {
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: SizedBox(
                  width: ahemWidthBudget(locale),
                  child: ContinuousLiveBar(
                    remaining: const Duration(minutes: 29),
                    amplitudeWindow: const <double>[-20, -18, -22],
                    segmentCount: 2,
                    screenHeld: true,
                    engineReconnect: const EngineReconnectFace(attempt: 3, provider: 'soniox'),
                    strings: s,
                    onStop: () {},
                  ),
                ),
              ),
            ),
          ),
        );
        final Finder chip = find.descendant(
          of: find.byKey(ContinuousLiveKeys.engine),
          matching: find.byType(Text),
        );
        _expectRendered(tester, chip, s.articleLiveEngineReconnecting(3), locale.name);
      });
    }
  });

  // ── ④ long recording: the in-progress article page's status line ────────────
  //
  // The REAL page (anti-façade ⑥): ChatFlowPage with `appSettings` carrying the
  // locale, the two taps that start a long recording, and one
  // `stt:engine-status` frame on the fake socket. Only the plain sentence is
  // reachable on this rig: the kept form needs a journal-face spill, which the
  // rig does not build (`ptt_link_loss.dart` `continuousOffline`). The kept
  // form renders through the same `_line` (`article_page_live.dart`), a Text
  // with no `maxLines` in a full-width box.
  group('article page status line, nine locales, 360 dp', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: the engine line renders whole on the real page', (WidgetTester tester) async {
        tester.view.physicalSize = Size(ahemWidthBudget(locale) * 3, 900 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        SharedPreferences.setMockInitialValues(<String, Object>{});
        final SharedPreferences prefs = await SharedPreferences.getInstance();
        final AppSettingsController settings = AppSettingsController(prefs: prefs);
        addTearDown(settings.dispose);
        await settings.load();
        settings.setLocale(locale);

        final ArticleRig r = ArticleRig();
        final login = newTestLogin(
          transport: r.transport,
          accountStore: InMemoryAccountStore(
            const CloudAccount(jwt: 'jwt-copy-landing', email: 'x@example.com', plan: 'pro'),
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
              appSettings: settings,
              cloudSummary: account,
              isSignedIn: () => login.isLoggedIn,
            ),
          ),
        );
        await tester.pump();
        await tester.tap(find.byKey(ContinuousEntryKeys.row));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(ContinuousSheetKeys.start));
        for (int i = 0; i < 4; i++) {
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
          await tester.pump(const Duration(milliseconds: 100));
        }
        await tester.pump(const Duration(milliseconds: 400));
        r.recorder.feed(makePcm(6400));
        expect(find.byType(ArticlePage), findsOneWidget, reason: 'setup: Start opened the article page');

        r.transport.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
          'provider': 'soniox',
          'status': 'reconnecting',
          'retry_count': 3,
        });
        await tester.pump();
        final AppStrings s = AppStrings.of(locale);
        final Finder line = find.descendant(
          of: find.descendant(
            of: find.byType(ArticlePage),
            matching: find.byKey(const Key('article.live.engineReconnecting')),
          ),
          matching: find.byType(Text),
        );
        _expectRendered(tester, line, s.articleLiveEngineReconnecting(3), locale.name);

        await tester.runAsync(() async {
          await r.controller.pttUp();
          await r.say('end', 99, isSegment: false, durationMs: 1000);
        });
        r.session.endContinuous();
        await tester.pump(const Duration(seconds: 5));
        await tester.pump(const Duration(seconds: 5));
      });
    }
  });

  // ── ⑤ NR-89 long-press sheet at 360 dp (the existing case is 411 dp) ────────
  group('NR-89 long-press sheet, nine locales, 360 dp', () {
    final DateTime now = DateTime.utc(2026, 9, 24, 11);
    final TimelineEntry row = TimelineEntry(
      id: 'loc_copy_landing',
      clientId: 'c-copy-landing',
      mode: FlowMode.translate,
      delivery: Delivery.inject,
      sourceText: '你好世界',
      outputText: 'hello world',
      processMode: 'translate',
      status: EntryStatus.injected,
      origin: 'paired',
      entryType: TimelineEntry.kTranscript,
      createdAt: now,
      updatedAt: now,
    );
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: both titles and both sub-lines render whole', (WidgetTester tester) async {
        tester.view.physicalSize = Size(ahemWidthBudget(locale) * 3, 1400 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (BuildContext context) => Center(
                  child: TextButton(
                    onPressed: () => showEntryContextMenu(context, row, strings: s, translateTarget: 'ja'),
                    child: const Text('open'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: '${locale.name}: the sheet overflowed');
        for (final String t in <String>[s.entryRetranslate, s.entryReorganize, s.entryReorganizeSub]) {
          _expectRendered(tester, _textOf(t), t, '${locale.name} 「$t」');
        }
        // The re-translate sub-line carries the rendered target name, so it is
        // found by its fixed prefix/suffix rather than by guessing the name.
        final Finder sub = find.byWidgetPredicate(
          (Widget w) => w is Text && w.data != null && w.data != s.entryRetranslate && _isRetranslateSub(w.data!, s),
        );
        expect(sub, findsOneWidget, reason: '${locale.name}: re-translate sub-line not found');
        expectLegible(tester, sub, reason: '${locale.name} entryRetranslateSub');
      });
    }
  });
}

/// Whether [text] is `entryRetranslateSub` with some target filled in: the
/// sentence around the placeholder, both halves present.
bool _isRetranslateSub(String text, AppStrings s) {
  const String marker = '\u0000TARGET\u0000';
  final String template = s.entryRetranslateSub(marker);
  final int at = template.indexOf(marker);
  if (at < 0) return false;
  return text.startsWith(template.substring(0, at)) &&
      text.endsWith(template.substring(at + marker.length)) &&
      text.length > template.length - marker.length;
}
