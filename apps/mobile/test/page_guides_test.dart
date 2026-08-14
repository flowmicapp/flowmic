// P-7 ②③ — the two 「point to re-read」 guides (instance list + add-device).
//
// WHAT THIS FILE IS DEFENDING, in the order the defects would arrive:
//
//   ① THE ENTRY IS NOT MOUNTED. A guide nobody can reach is the same as no
//      guide, and this repo has been burned by exactly that: the reverse
//      control on data_flow_disclosure_test.dart found that asserting only the
//      import, the class and the ValueKey left the file GREEN while nothing
//      rendered — a lost call site has no new symbol to grep (13 册 §7 F1 ①).
//      So both entries are proved by TAPPING them on a real widget tree, not by
//      reading source for a builder method that may have no caller.
//
//   ② THE COPY IS A COPIED LITERAL. §6-1 of the design: every button name, tab
//      name and status word a guide quotes must be the getter the real UI
//      renders, so that re-wording the UI re-words the guide for free. A copy
//      looks identical the day it is written and drifts silently after. Pinned
//      two ways — same-source assertions (the guide really renders the live
//      getter, in all four locales) and a NO-COPY source scan.
//
//   ③ THE USER CANNOT READ IT. 0.2.53: a status word lost its reason to a
//      Flexible+ellipsis while 1259 tests stayed green, because they asserted
//      `Text.data` and the user reads what survived layout. Every legibility
//      assertion here lands on the RENDERED paragraph.
//      🔴 CORRECTED 2026-08-07 (W5a adversarial review P1-1, measured). The line
//      above used to end 「(`didExceedMaxLines`)」 and that was the whole defect:
//      neither guide body sets `maxLines` anywhere, and `didExceedMaxLines` is
//      ALWAYS false without one. This file's headline legibility assertion could
//      not fail. It now goes through `support/legibility.dart`, which reads the
//      instrument before it reads the product — the reasoning lives there.
//
//   ④ THE TOP BAR IS OVER-SUBSCRIBED. 0.2.51 was the third time that row ran
//      out of width. The "?" makes a third tap cell, so the arithmetic is
//      asserted rather than eyeballed.
//
// 🔴 WHAT THE RENDER MEASUREMENTS ARE MEASURED WITH — copied from
// inject_verdict_note_test.dart because it applies verbatim here:
// `flutter_test` uses the Ahem placeholder font, every glyph a full em square,
// so a 411dp line fits ~35 characters where a real font fits far more (CJK ~34,
// Latin 70+). The budget here is therefore CONSERVATIVE: not clipped under Ahem
// ⇒ not clipped on a device. **The converse does not hold** — nothing in this
// file may be cited as evidence that some sentence "just fits" on real
// hardware. It answers one direction only: can it be clipped.
//
// ⚠️ not device-verified. Everything below is 【unit-test】. No hardware ran in this window; the
// guides have never been opened on a phone.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/guide/instance_guide_sheet.dart';
import 'package:flowmic/src/ui/guide/pairing_guide_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart';

const List<AppLocale> kLocales = AppLocale.values;

// ── rig ─────────────────────────────────────────────────────────────────────
// Shaped after connections_page_widget_test.dart's `_rig`. 🔴 `healthReader`
// and `presenceReader` are faked and NOT optional: the production probes are
// real HttpClients, and a widget test that reached the network would hang on
// every pumpAndSettle in this file.
Future<HealthReading> _probeUnreachable(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;

Future<Widget> _rig(FakeSocketTransport t, {AppLocale locale = AppLocale.zh}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(locale);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: FakeSocketTransport.new,
  );
  final LoginController login = newTestLogin(transport: session.transport);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: _probeUnreachable,
    presenceReader: _presenceUnknown,
  );
  return MaterialApp(
    home: ConnectionsPage(
      connections: connections,
      appSettings: appSettings,
      login: login,
      destination: DestinationController(),
      chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
      settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
      historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
    ),
  );
}

/// Pump a guide body on its own, at a phone width, without a modal route.
Future<void> _pumpAt360(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child))),
  );
  await tester.pump();
}

/// Can the user read every paragraph of real prose on this screen? Returns how
/// many paragraphs were examined so the caller can prove it examined some — a
/// screen that rendered nothing satisfies a "none were clipped" loop without a
/// single character being looked at.
///
/// 🔴 REWRITTEN 2026-08-07 (W5a adversarial review P1-1, measured). The body was
/// one line — `expect(p.didExceedMaxLines, isFalse)` — and it could not fail:
/// neither `instance_guide_sheet.dart` nor `pairing_guide_view.dart` contains
/// the string `maxLines` at all, and without one that getter is always false.
/// The count returned below was real; the assertion it accompanied was not.
/// Every paragraph now goes through `support/legibility.dart`, which picks its
/// criterion from the paragraph's own structure instead of assuming one.
int _assertNothingClipped(WidgetTester tester) {
  final Iterable<RenderParagraph> paragraphs =
      tester.renderObjectList<RenderParagraph>(find.byType(RichText));
  int checked = 0;
  for (final RenderParagraph p in paragraphs) {
    final String plain = p.text.toPlainText();
    if (plain.length < 12) continue; // titles and labels, not prose
    checked += 1;
    expectParagraphLegible(p);
  }
  return checked;
}

/// Unconstrained width of a Text — compare against the box it actually got.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

/// Every string LITERAL in a Dart file, comments removed first.
///
/// Two false-alarm shapes made the cruder versions of this unusable, and both
/// are worth stating because the fix is what makes the check trustworthy:
///   · scanning raw source matches IDENTIFIERS — `InstanceLivenessFace.pcOnline`
///     contains "Online", so "the guide spells `s.online`" fired on the code
///     that correctly reads the getter;
///   · scanning for a substring matches PROSE — the English copy
///     「Scan a different code and it says…」 contains the tab name "Scan"
///     without being a copy of it.
/// Extracting literals kills the first. The second is handled at the call site:
/// widget files may hold no user-visible literal at all, while the copy shard
/// is only forbidden from having one EQUAL to a string the real UI owns.
///
/// ⚠️ The extractor is a regex, not a Dart parser: it does not understand raw
/// strings, escaped quotes or triple quotes. None of the three scanned files
/// uses any of those, and if one starts to, this check gets weaker rather than
/// wrong — worth knowing before trusting it somewhere else.
List<String> _stringLiterals(String path) {
  final String code = File(path)
      .readAsLinesSync()
      .map((String l) {
        final int i = l.indexOf('//');
        return i < 0 ? l : l.substring(0, i);
      })
      .join('\n');
  return <String>[
    for (final RegExp re in <RegExp>[
      RegExp("'([^'\\n]*)'"),
      RegExp('"([^"\\n]*)"'),
    ])
      for (final RegExpMatch m in re.allMatches(code)) m.group(1)!,
  ];
}

/// Any Han / Kana / Hangul codepoint — i.e. "this literal is user-visible copy"
/// for three of the four languages, which is enough to catch a paste.
final RegExp _cjk = RegExp(r'[぀-ヿ㐀-鿿가-힯]');

/// The spans a sentence QUOTES — 「…」 『…』 “…” ‘…’.
///
/// 🔴 WHY THIS SECOND EXTRACTOR HAD TO EXIST (W5a P1-5, 2026-08-07). The
/// equality scan below was the whole check, and it is blind by construction to
/// the shape that was already in the tree: `onboarding_strings.dart` spelled
/// 「添加设备」 / “Add device” / 「デバイスを追加」 / ‘기기 추가’ — word for word the
/// live `connection_strings.dart` `addDevice` button label — INSIDE a longer
/// sentence. A literal is only EQUAL to a UI string when the whole literal is
/// that string; copy quotes a control in the middle of a paragraph, so equality
/// never sees it. Adding the file and the getter to the two tables below (the
/// fix the audit prescribed) was measured and stayed GREEN.
///
/// Why quotes, and not a bare substring: the substring scan is unusable for the
/// documented reason above — the English 「Scan a different code and it says…」
/// contains the tab name "Scan" as prose. A QUOTED span is not prose. In this
/// product, wrapping a word in 「」/“”/‘’ IS the claim 「this is the name of a
/// control you will see」 — which is exactly the claim that has to come from the
/// control's own getter (反 façade ④: an assertion about behaviour elsewhere
/// needs a greppable anchor). So the rule is still an EQUALITY, just against the
/// quoted span rather than the whole literal, and it keeps the precision that
/// made the substring version unusable.
///
/// ⚠️ Same regex-not-a-parser caveat as [_stringLiterals], plus one of its own:
/// a quoted span split across two ADJACENT literal chunks (`'…「添加'` `'设备」…'`)
/// is invisible here. Weaker, not wrong.
final RegExp _quotedSpan = RegExp('「([^」]*)」|『([^』]*)』|“([^”]*)”|‘([^’]*)’');

Iterable<String> _quotedSpans(String literal) sync* {
  for (final RegExpMatch m in _quotedSpan.allMatches(literal)) {
    for (int g = 1; g <= m.groupCount; g++) {
      final String? s = m.group(g);
      if (s != null) yield s;
    }
  }
}

void main() {
  // ══ ② instance-list guide ════════════════════════════════════════════════
  group('② instance-list page guide', () {
    testWidgets('反 façade: the home screen really mounts the "?" and it opens the guide',
        (WidgetTester tester) async {
      // 🔴 This is the assertion the data_flow_disclosure reverse control says
      // to write. Not "the widget class exists", not "the page imports it" —
      // a real ConnectionsPage is built, the production key is tapped, and the
      // guide's own content is required to appear. Deleting
      // `InstanceGuideButton(strings: s)` from _appBar fails this at the tap.
      final FakeSocketTransport t = FakeSocketTransport();
      await tester.pumpWidget(await _rig(t));
      await tester.pumpAndSettle();

      const AppStrings s = AppStringsZh();
      expect(find.byType(InstanceGuideBody), findsNothing,
          reason: 'the guide must not appear unbidden (§3.3)');

      await tester.tap(find.byKey(const ValueKey<String>('connections.guide')));
      await tester.pumpAndSettle();

      expect(find.byType(InstanceGuideBody), findsOneWidget);
      expect(find.text(s.guideInstancesTitle), findsOneWidget);
      // And it really closes again — a sheet with no way out is its own defect.
      await tester.tap(find.byKey(const ValueKey<String>('guide.instances.close')));
      await tester.pumpAndSettle();
      expect(find.byType(InstanceGuideBody), findsNothing);
    });

    test('every liveness face is rendered — a seventh one cannot be silently dropped', () {
      // The exhaustive switches in instance_guide_sheet.dart already make a new
      // face a COMPILE error (no copy for it). This covers the other half: a
      // face that has copy but never reaches the reading-order list would be
      // invisible with everything still green.
      expect(
        kGuideStatusOrder.toSet(),
        InstanceLivenessFace.values.toSet(),
        reason: 'kGuideStatusOrder must hold every InstanceLivenessFace',
      );
      expect(kGuideStatusOrder.length, InstanceLivenessFace.values.length,
          reason: 'no duplicates');
    });

    testWidgets('§6-1 same-source: the status words shown are the LIVE getters, in all four languages',
        (WidgetTester tester) async {
      for (final AppLocale loc in kLocales) {
        final AppStrings s = AppStrings.of(loc);
        await _pumpAt360(tester, InstanceGuideBody(strings: s));
        for (final InstanceLivenessFace f in InstanceLivenessFace.values) {
          expect(
            find.text(guideStatusLabel(s, f)),
            findsWidgets,
            reason: '$loc/$f — the guide is not showing the real status word',
          );
        }
        // The footer sentence is reproduced VERBATIM, not re-phrased (§3.2-1),
        // and the cloud row's own label is interpolated rather than spelled.
        expect(find.text(s.startNoAutoConnect), findsOneWidget, reason: '$loc');
        expect(find.text(s.guideCloudTitle(s.cloudInstance)), findsOneWidget,
            reason: '$loc');
      }
    });

    testWidgets('0.2.53: every sentence survives layout at 360dp, in all four languages',
        (WidgetTester tester) async {
      for (final AppLocale loc in kLocales) {
        await _pumpAt360(tester, InstanceGuideBody(strings: AppStrings.of(loc)));
        expect(tester.takeException(), isNull, reason: '$loc overflowed');
        final int checked = _assertNothingClipped(tester);
        // Positive control: a body that rendered nothing would pass the loop
        // above having looked at zero characters.
        // 12 is MEASURED, not guessed: it is what this body renders today
        // (paragraphs of 12+ characters, so section titles are excluded). A
        // floor rather than an equality so a longer translation cannot fail it,
        // and a dropped card still can.
        expect(checked, greaterThanOrEqualTo(12),
            reason: '\$loc — too few paragraphs; did the guide render?');
      }
    });
  });

  // ══ ③ add-device (pairing) guide ═════════════════════════════════════════
  group('③ pairing guide', () {
    testWidgets('反 façade: the add-device sheet really mounts the "?" and it opens the guide',
        (WidgetTester tester) async {
      final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
      await tester.pumpWidget(await _rig(t));
      await tester.pumpAndSettle();

      const AppStrings s = AppStringsZh();
      await tester.tap(find.text(s.addDevice));
      await tester.pumpAndSettle();

      // The sheet opens on the scan tab and the guide is NOT up (§4.3).
      expect(find.text(s.pairTabScan), findsOneWidget);
      expect(find.byType(PairingGuideView), findsNothing);

      await tester.tap(find.byKey(const ValueKey<String>('pair.guide')));
      await tester.pumpAndSettle();
      expect(find.byType(PairingGuideView), findsOneWidget);
      // The sheet's title became the guide's, and the tabs are gone — this is a
      // push-over-the-tabs, not a second surface stacked on top.
      expect(find.text(s.guidePairingTitle), findsOneWidget);
      expect(find.text(s.pairTabScan), findsNothing);

      // Back returns to pairing, with the tabs intact.
      await tester.tap(find.byKey(const ValueKey<String>('pair.guide.back')));
      await tester.pumpAndSettle();
      expect(find.byType(PairingGuideView), findsNothing);
      expect(find.text(s.pairTabScan), findsOneWidget);
      expect(find.text(s.addPairingTitle), findsOneWidget);
    });

    testWidgets('§4.3: a pairing FAILURE must not raise the guide over the real reason',
        (WidgetTester tester) async {
      // 🔴 The negative assertion here is the point, so it carries its own
      // positive control: if the failure never happened, "no guide appeared"
      // would be true for an uninteresting reason. The banner must be on screen.
      final FakeSocketTransport t = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = <String, Object?>{'error': 'PAIR_INVALID_CODE'};
      await tester.pumpWidget(await _rig(t));
      await tester.pumpAndSettle();

      const AppStrings s = AppStringsZh();
      await tester.tap(find.text(s.addDevice));
      await tester.pumpAndSettle();
      await tester.tap(find.text(s.pairTabManual));
      await tester.pumpAndSettle();

      // 0.2.66 — BY KEY, not by index: the manual tab grows a third field (PCID)
      // when the address is the cloud relay, and this rig opens with the relay
      // pre-filled, so index 1 was the PCID box until the address was replaced.
      await tester.enterText(find.byType(TextField).at(0), '192.168.1.5:41879');
      await tester.enterText(find.byKey(const ValueKey<String>('pair.code')), '1234');
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      expect(find.text(s.pairError('PAIR_INVALID_CODE')), findsOneWidget,
          reason: 'positive control — the failure must actually be on screen');
      expect(find.byType(PairingGuideView), findsNothing,
          reason: 'the guide would cover the specific reason with a general one');
    });

    testWidgets('§6-1 same-source: tab names and field labels come from the real ones',
        (WidgetTester tester) async {
      for (final AppLocale loc in kLocales) {
        final AppStrings s = AppStrings.of(loc);
        await _pumpAt360(
          tester,
          PairingGuideView(strings: s, onBack: () {}),
        );
        expect(find.text(s.guidePairingScanTitle(s.pairTabScan)), findsOneWidget,
            reason: '$loc scan heading');
        expect(find.text(s.guidePairingManualTitle(s.pairTabManual)), findsOneWidget,
            reason: '$loc manual heading');
        expect(
          find.text(s.guidePairingManualBody(s.pcAddressLabel, s.pairCodeLabel, s.pcidLabel)),
          findsOneWidget,
          reason: '$loc manual body',
        );
      }
    });

    testWidgets('0.2.53: every sentence survives layout at 360dp, in all four languages',
        (WidgetTester tester) async {
      for (final AppLocale loc in kLocales) {
        await _pumpAt360(
          tester,
          PairingGuideView(strings: AppStrings.of(loc), onBack: () {}),
        );
        expect(tester.takeException(), isNull, reason: '$loc overflowed');
        final int checked = _assertNothingClipped(tester);
        // 8, measured the same way as the instance guide's 12 above.
        expect(checked, greaterThanOrEqualTo(8),
            reason: '\$loc — too few paragraphs; did the guide render?');
      }
    });

    test('the code TTL is never written down as a number of seconds', () {
      // Design §4.2: a hardcoded lifetime drifts the first time the PC side is
      // tuned, and nobody would notice. The copy has to tell the user what to
      // DO instead. This scans the four locales of the sentence that owns it.
      final RegExp digits = RegExp(r'\d');
      for (final AppLocale loc in kLocales) {
        expect(
          AppStrings.of(loc).guidePairingCodeExpires.contains(digits),
          isFalse,
          reason: '$loc — the expiry sentence must carry no number',
        );
      }
    });
  });

  // ══ §6-1, the source side ════════════════════════════════════════════════
  group('§6-1 anti-drift: no copied literals', () {
    test('the guide WIDGETS hold no user-visible text of their own', () {
      // 🔴 The rendered same-source tests above stay GREEN if someone pastes a
      // literal that happens to be equal today — which is exactly the drift
      // shape, invisible until the real UI is re-worded, i.e. precisely when
      // nobody is looking at the guide. So the source is scanned too.
      //
      // The rule for the two widget files is the strong one and the simple one:
      // they lay copy out, they do not own any. Every sentence arrives through
      // `s.`, so ANY literal carrying Han/Kana/Hangul is a paste, whatever it
      // happens to say. (Latin copy is covered by the equality scan below.)
      for (final String path in <String>[
        'lib/src/ui/guide/instance_guide_sheet.dart',
        'lib/src/ui/guide/pairing_guide_view.dart',
      ]) {
        for (final String lit in _stringLiterals(path)) {
          expect(
            _cjk.hasMatch(lit),
            isFalse,
            reason: '$path holds copy of its own ("$lit") — it must come from '
                'AppStrings, or re-wording the real UI leaves the guide behind',
          );
        }
      }
    });

    test('nothing in the guide re-spells a string the real UI owns', () {
      // Equality, not substring. Substring cannot tell a paste from prose: the
      // English 「Scan a different code and it says…」 legitimately contains the
      // tab name "Scan". A literal EQUAL to a real UI string is a copy of it.
      //
      // 🔴 TWO equalities, not one (W5a P1-5). A paste takes two shapes and the
      // first version of this test only saw one of them:
      //   · WHOLE LITERAL == the UI string ⇒ a second DEFINITION of that word.
      //   · a QUOTED SPAN inside a sentence == the UI string ⇒ copy that NAMES
      //     the control. This is the one that was live in the tree: the
      //     onboarding walkthrough spelled the 「添加设备」 button in all four
      //     languages. Only new users ever see that screen, so re-wording the
      //     button would have pointed the walkthrough at a control that does not
      //     exist, with nobody in a position to notice.
      // Both are checked against the same table below, so a getter added there
      // is protected against both shapes at once.
      //
      // ⚠️ THE TABLE IS HAND-MAINTAINED, AND THAT IS THE GAP THIS TEST STILL
      // HAS. A label that is pasted but not listed here is not protected — this
      // check answers "is one of THESE thirteen re-spelled", not "is anything
      // re-spelled". Dart has no reflection to enumerate the catalogue, so
      // there is no cheap way to close it; saying so is the honest half.
      final Map<String, List<String>> literals = <String, List<String>>{
        for (final String p in <String>[
          'lib/src/ui/guide/instance_guide_sheet.dart',
          'lib/src/ui/guide/pairing_guide_view.dart',
          'lib/src/settings/strings/guide_strings.dart',
          'lib/src/settings/strings/onboarding_strings.dart',
        ])
          p: _stringLiterals(p),
      };
      for (final AppLocale loc in kLocales) {
        final AppStrings s = AppStrings.of(loc);
        final Map<String, String> owned = <String, String>{
          'online': s.online,
          'offline': s.offline,
          'pcOfflineChip': s.pcOfflineChip,
          'relayUpPcUnknown': s.relayUpPcUnknown,
          'checkingReach': s.checkingReach,
          'tapToConnect': s.tapToConnect,
          'addDevice': s.addDevice,
          'pairTabScan': s.pairTabScan,
          'pairTabManual': s.pairTabManual,
          'pcAddressLabel': s.pcAddressLabel,
          'pairCodeLabel': s.pairCodeLabel,
          'startNoAutoConnect': s.startNoAutoConnect,
          'cloudInstance': s.cloudInstance,
        };
        owned.forEach((String name, String value) {
          literals.forEach((String path, List<String> lits) {
            expect(
              lits.contains(value),
              isFalse,
              reason: '$path re-spells $loc/$name ("$value") instead of reading '
                  'the getter — re-wording the real UI would leave the guide behind',
            );
            for (final String lit in lits) {
              expect(
                _quotedSpans(lit).contains(value),
                isFalse,
                reason: '$path quotes $loc/$name ("$value") as a literal instead '
                    'of interpolating the getter — re-wording the real UI would '
                    'leave this sentence pointing at a control that no longer '
                    'has that name. In: "$lit"',
              );
            }
          });
        });
      }
    });

    test('SPEC-REF header on every guide file (§6-3)', () {
      // Every sentence in a guide is an assertion about behaviour that lives
      // somewhere else — 反 façade ④. The header is the greppable anchor that
      // makes each one checkable.
      for (final String p in <String>[
        'lib/src/ui/guide/instance_guide_sheet.dart',
        'lib/src/ui/guide/pairing_guide_view.dart',
      ]) {
        final String src = File(p).readAsStringSync();
        expect(src, contains('SPEC-REF:'), reason: p);
        expect(src, contains('2026-08-06-p7-mobile-onboarding-design.md'), reason: p);
      }
      // The instance guide narrates connections_page.dart; the pairing guide
      // narrates add_pairing_sheet.dart. Named, so the anchor is real.
      expect(
        File('lib/src/ui/guide/instance_guide_sheet.dart').readAsStringSync(),
        contains('connections_page.dart'),
      );
      expect(
        File('lib/src/ui/guide/pairing_guide_view.dart').readAsStringSync(),
        contains('add_pairing_sheet.dart'),
      );
    });
  });

  // ══ ④ the top bar's width budget ═════════════════════════════════════════
  group('top-bar width budget', () {
    testWidgets('360dp: the trailing cluster is exactly three tap cells, and the title is not starved',
        (WidgetTester tester) async {
      // 🔴 Why measure at all: this row has run out of width three times
      // (0.2.51), every time because someone redistributed it without doing the
      // arithmetic first. Adding the "?" makes a third competitor, so the
      // budget is asserted instead of assumed.
      //
      // 360dp is the common narrowest Android width. Bar padding is 14 either
      // side ⇒ 332 of usable row. Each icon is an 18px glyph in an 8px pad ⇒
      // 34, with 2 between ⇒ 34+2+34+2+34 = 106.
      tester.view.physicalSize = const Size(360 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final FakeSocketTransport t = FakeSocketTransport();
      await tester.pumpWidget(await _rig(t));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: 'the top bar overflowed at 360dp');

      const double kCell = 34;
      const double kTrailing = kCell + 2 + kCell + 2 + kCell;

      final Finder row = find.byKey(const ValueKey<String>('connections.appBarRow'));
      final Finder guide = find.byKey(const ValueKey<String>('connections.guide'));
      final Finder history = find.byKey(const ValueKey<String>('connections.history'));
      final Finder settings = find.byKey(const ValueKey<String>('connections.settings'));

      // Named up front. Without this the reverse control for "the entry was
      // unmounted" failed here as a bare `Bad state: No element` out of
      // getSize — a red that does not say what is wrong costs the next person
      // the same ten minutes it cost this one.
      for (final Finder f in <Finder>[row, guide, history, settings]) {
        expect(f, findsOneWidget, reason: 'top-bar cell missing: $f');
      }
      expect(tester.getSize(row).width, closeTo(332, 0.5));
      for (final Finder f in <Finder>[guide, history, settings]) {
        expect(tester.getSize(f).width, closeTo(kCell, 0.5));
        expect(tester.getSize(f).height, greaterThanOrEqualTo(kCell - 0.5));
      }

      // 🔴 THE ONE THAT CATCHES A FOURTH COMPETITOR, and the reason it is
      // written as a distance rather than as a sum of the three cells I already
      // know about: measuring from the LEFT edge of the leftmost trailing
      // control to the RIGHT edge of the row covers everything in that cluster,
      // including a control this test has never heard of. Summing the three
      // named cells would stay green while a fourth icon squeezed the title.
      final double guideLeft = tester.getTopLeft(guide).dx;
      final double rowRight = tester.getTopRight(row).dx;
      expect(
        rowRight - guideLeft,
        closeTo(kTrailing, 0.5),
        reason: 'the trailing cluster is no longer exactly three 34dp tap cells '
            '— a fourth competitor appeared on this row',
      );

      // The title keeps its whole word. It is the literal 'FlowMic' in ALL four
      // locales (connection_strings.dart instancesTitle), so this does not move
      // under translation — which is the reason a third icon is affordable here
      // and would not have been on the chat header.
      final Finder title = find.byKey(const ValueKey<String>('connections.title'));
      final Text titleText = tester.widget<Text>(title);
      expect(
        tester.getSize(title).width,
        greaterThanOrEqualTo(_intrinsicWidth(titleText) - 0.5),
        reason: 'the page title got clipped by the icons',
      );
      // Positive control on that last one: it is only meaningful if the title
      // is actually competing for the same row. Ahem makes 'FlowMic' 7 full em
      // squares at 16px = 112, against 332-106 = 226 available. Assert the
      // headroom is real rather than assuming it.
      expect(_intrinsicWidth(titleText), lessThan(332 - kTrailing));
    });

    test('the title really is locale-invariant — the budget above depends on it', () {
      for (final AppLocale loc in kLocales) {
        expect(AppStrings.of(loc).instancesTitle, 'FlowMic', reason: '$loc');
      }
    });
  });
}
