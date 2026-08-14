// P-8 — [DiagnosticsEngineSection] **render** acceptance.
//
// 🔴 0.2.53's law: any acceptance of 「can the user actually read this sentence」
// must land the assertion on the **rendered result** (`didExceedMaxLines` /
// intrinsic width vs. the actual box), never on `Text.data`.
// The counter-example is `cloud_image_error_copy_test.dart` — it says in place
// that it knows Flexible+ellipsis will clip this sentence, but it asserts
// Text.data so it still matches; 1259 tests all green while the screen showed
// three letters. This file's 「凭什么这么说」 sentence is a candidate of the same
// shape: it is much longer than the status word, and the moment someone stuffs
// it back onto the status-word line it is the next `INJ…`.
//
// ⚠️ In this file `find.text` is used only to answer **「is this sentence
// present」** (content), never to answer 「can the user read it」
// (legibility) — the latter always goes through `_clipped` / `_intrinsicWidth`.
// Keeping those two questions apart is the entire content of this law.
//
// 🔴 **Calibrate the ruler first**: `_clipped` is this file's instrument, and
// an instrument that always reads false lets every assertion pass for free.
// So §③ is an **instrument self-check**: put the same sentence into that
// 「bad structure」 and assert it **must** report true. Without it, every
// 「not clipped」 below could just mean the instrument is blind.
//
// 🔴🔴 **In-place correction (2026-08-07, W5a adversarial review P1-1, [measured]) — the
// reasoning above is right, the conclusion is wrong, and the wrong step is
// hidden inside the three characters 「没有它」. Original kept verbatim; it is
// physical evidence of this defect.**
// §③ built its **own** `Text(maxLines: 1, overflow: ellipsis)` to check the
// instrument. What it proves is 「`didExceedMaxLines` on a thing that set
// `maxLines` can read true」 — and `connection_diagnostics_sheet.dart` **has
// not a single `maxLines` anywhere** (`grep -c maxLines` = 0, measured on this
// machine) ⇒ every `_clipped` §②④ calls on the product **always returns
// false**, and structurally cannot go red. §③ all green, §②④ spinning, both
// true at once.
// ⇒ **An instrument self-check must check 「is THIS reading a real reading」,
// not 「can this instrument move in the lab」.**
// ⇒ The product face now goes through `expectLegible` in `support/legibility.dart`:
//   **the criterion is decided by the structure of the text under test** —
//   if it set `maxLines`, read that; if not, assert 「why it cannot clip」.
// ⚠️ §③ is kept: it now only claims the one thing it can prove (I used this
//   API correctly), and no longer claims it endorses §②④.
//
// ⚠️ **The ruler is Ahem**: flutter_test's placeholder font makes every glyph
// a full em square ⇒ at fontSize 11 one character is 11px; a real font
// (Chinese roughly monospaced, Latin much narrower) is much looser. The
// direction is **conservative**: not clipped under Ahem ⇒ not clipped on a
// real device; **the converse does not hold**, and this file must not be used
// to argue 「it fits exactly on a real device」.
//
// Box width is **324**: 360dp narrow screen minus the sheet's own
// `EdgeInsets.fromLTRB(18,…,18,…)` 18 on each side ⇒ that is the width this
// section **actually gets** on the narrowest real handset, not a number picked
// to look good.

import 'package:flowmic/src/session/local_engine_status.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/connection_diagnostics_sheet.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart';

/// The width this section actually gets on a 360dp narrow screen (sheet
/// padding 18 on each side).
const double kBox = 324;

const List<AppLocale> kLocales = <AppLocale>[
  AppLocale.zh,
  AppLocale.en,
  AppLocale.ja,
  AppLocale.ko,
];

final DateTime kAt = DateTime.utc(2026, 8, 7, 6, 32);
final DateTime kNow = DateTime.utc(2026, 8, 7, 6, 40);

/// The HH:MM expected in the sentence, **computed independently** (do not reuse
/// `timelineTimeLabel`, or that would be using the function under test to
/// verify itself). Both the same-day and next-day branches contain this
/// fragment, so it is stable across timezones.
String get kHhmm {
  final DateTime t = kAt.toLocal();
  return '${t.hour.toString().padLeft(2, '0')}:'
      '${t.minute.toString().padLeft(2, '0')}';
}

LocalEngineObservation _obs(LocalEngineOutcome outcome) => LocalEngineObservation(
  provider: 'funasr-ws',
  outcome: outcome,
  atUtc: kAt,
  channelIsLan: true,
  endpoint: 'ws://192.168.1.5:41879',
  pcId: 'pc_abc',
);

Widget _host(AppStrings s, LocalEngineObservation? o, {double width = kBox}) =>
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: width,
            child: DiagnosticsEngineSection(
              strings: s,
              observation: o,
              now: kNow,
            ),
          ),
        ),
      ),
    );

/// After render, did this text overflow its own `maxLines` (＝ the user sees
/// an ellipsis).
///
/// 🔴 **Only use this on something that actually set `maxLines`** — in this
/// file that is only §③'s own fake. The product sentences did not set it;
/// calling this function on them **always returns false** (W5a P1-1). The
/// product face goes through `expectLegible`.
bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

/// How wide this text wants to be on one unconstrained line. Compared with the
/// actual box, it says whether it is genuinely under pressure.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

Text _textWidget(WidgetTester tester, String data) =>
    tester.widget<Text>(find.text(data));

void main() {
  group('① with an observation: status word + 「凭什么」 both present, four locales × three states', () {
    for (final AppLocale loc in kLocales) {
      final AppStrings s = AppStrings(loc);
      final Map<LocalEngineOutcome, String> words =
          <LocalEngineOutcome, String>{
            LocalEngineOutcome.ready: s.diagEngineConnected,
            LocalEngineOutcome.reconnecting: s.diagEngineReconnecting,
            LocalEngineOutcome.failed: s.diagEngineConnectFailed,
          };
      for (final MapEntry<LocalEngineOutcome, String> e in words.entries) {
        testWidgets('$loc / ${e.key.name}: status word, engine name, and time are all present', (
          WidgetTester tester,
        ) async {
          await tester.pumpWidget(_host(s, _obs(e.key)));
          expect(find.text(s.diagEngineSection), findsOneWidget);
          expect(find.text('${s.diagEngineStt} · funasr-ws'), findsOneWidget);
          expect(find.text(e.value), findsOneWidget);
          // R11: the status word must appear together with its source and time.
          // This pins 「the two must not be split」 — and in the implementation
          // they are two adjacent lines of the same widget, with no if between.
          expect(find.text(s.diagEngineObservedAt(kHhmm)), findsOneWidget);
        });
      }
    }
  });

  group('② legibility: those two sentences are not clipped at the narrowest real-device width', () {
    for (final AppLocale loc in kLocales) {
      final AppStrings s = AppStrings(loc);
      testWidgets('$loc: neither the status word nor 「凭什么」 overflowed', (WidgetTester tester) async {
        await tester.pumpWidget(_host(s, _obs(LocalEngineOutcome.failed)));
        expectLegible(
          tester,
          find.text(s.diagEngineConnectFailed),
          reason: 'status word unreadable ⇒ the user got half a verdict (0.2.53\'s `INJ…`)',
        );
        expectLegible(
          tester,
          find.text(s.diagEngineObservedAt(kHhmm)),
          reason: '「凭什么这么说」 unreadable ⇒ R11\'s answer equals no answer',
        );
      });
    }

    testWidgets('pressure control: the English sentence\'s intrinsic width really exceeds the box ⇒ it must wrap to fit', (
      WidgetTester tester,
    ) async {
      const AppStrings en = AppStringsEn();
      await tester.pumpWidget(_host(en, _obs(LocalEngineOutcome.ready)));
      final Text t = _textWidget(tester, en.diagEngineObservedAt(kHhmm));
      // Without this, 「not clipped」 could just mean the sentence was short to
      // begin with — then §② is blind to the regression.
      expect(
        _intrinsicWidth(t),
        greaterThan(kBox),
        reason: 'under Ahem this sentence should be wider than $kBox, otherwise this group has no pressure to measure',
      );
    });
  });

  testWidgets('③ instrument self-check: the same sentence in the 「bad structure」, _clipped must report true', (
    WidgetTester tester,
  ) async {
    // 🔴 This is not testing the product; it is **measuring the instrument**.
    // `didExceedMaxLines` is only true when `maxLines` was actually set AND
    // it actually overflowed; if every Text in this file leaves maxLines
    // unset, every §② case would pass for free because 「the instrument
    // always reads false」. This case rules that possibility out.
    // 「bad structure」 ＝ the 0.2.53 row shape: Row + Flexible + maxLines:1 + ellipsis.
    const AppStrings en = AppStringsEn();
    final String sentence = en.diagEngineObservedAt(kHhmm);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: kBox,
              child: Row(
                children: <Widget>[
                  Flexible(
                    child: Text(
                      sentence,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    expect(
      _clipped(tester, find.text(sentence)),
      isTrue,
      reason: 'instrument cannot read 「clipped」 ⇒ every §② case is a false green',
    );
  });

  group('④ no observation: say 「we do not know yet」, not a point that looks reasonable', () {
    for (final AppLocale loc in kLocales) {
      final AppStrings s = AppStrings(loc);
      testWidgets('$loc: only the hint sentence appears; not one status word, not one timestamp', (
        WidgetTester tester,
      ) async {
        await tester.pumpWidget(_host(s, null));
        expect(find.text(s.diagEngineSection), findsOneWidget);
        expect(find.text(s.diagEngineNoObservation), findsOneWidget);
        // 🔴 These three are this group's claim: 「not measured」 must never
        // look like 「measured and fine」.
        expect(find.text(s.diagEngineConnected), findsNothing);
        expect(find.text(s.diagEngineReconnecting), findsNothing);
        expect(find.text(s.diagEngineConnectFailed), findsNothing);
        expect(find.textContaining(kHhmm), findsNothing);
      });

      testWidgets('$loc: the hint sentence itself must not be clipped', (WidgetTester tester) async {
        await tester.pumpWidget(_host(s, null));
        expectLegible(tester, find.text(s.diagEngineNoObservation));
      });
    }
  });

  group('⑤ `ready` must not be painted as a green light', () {
    // 🔴 Source: `orchestrator-core`'s `status:'ready'` only proves **the
    // engine connection came up**. The same-repo `stt/pool-health.ts` file
    // header says verbatim: a handshake-shaped criterion still reports OK for
    // an account that 「connects but cannot produce words」. A green dot would
    // read a measurement about **connection** as a promise about **capability**
    // — exactly R11's 「the status word cannot answer why」.
    testWidgets('ready ⇒ neutral t1, never green', (WidgetTester tester) async {
      const AppStrings zh = AppStringsZh();
      await tester.pumpWidget(_host(zh, _obs(LocalEngineOutcome.ready)));
      final Text t = _textWidget(tester, zh.diagEngineConnected);
      expect(t.style!.color, FlowMicColors.t1);
      expect(t.style!.color, isNot(FlowMicColors.green));
    });

    testWidgets('reconnecting ⇒ amber, failed ⇒ red (positive control: the colouring itself is live)', (
      WidgetTester tester,
    ) async {
      const AppStrings zh = AppStringsZh();
      await tester.pumpWidget(_host(zh, _obs(LocalEngineOutcome.reconnecting)));
      expect(
        _textWidget(tester, zh.diagEngineReconnecting).style!.color,
        FlowMicColors.amber,
      );
      await tester.pumpWidget(_host(zh, _obs(LocalEngineOutcome.failed)));
      expect(
        _textWidget(tester, zh.diagEngineConnectFailed).style!.color,
        FlowMicColors.red,
      );
    });
  });
}
