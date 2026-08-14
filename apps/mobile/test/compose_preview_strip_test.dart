// 🔴 T-2 (0.2.63) acceptance — the idle row-2 preview strip (owner Q3㋐
// "idle row 2 must not draw a 38px fake input box").
//
// Contract = docs/ui-design/2026-08-13-compose-band-redesign.md §3 S1/S2/S3/S8
// and §9 ④; task book = docs/strategy/2026-08-13-0263-design-task-book.md
// §2-6 T-2.
//
// ── Reverse control (measured red, then restored) ─────────────────────────
// Draw S1 back as an empty `TextField` (i.e. `_previewStrip()` swapped back
// to the shape of `_bufferField()`) ⇒ this file's "the preview strip is not
// a TextField" case and compose_band_widget_test.dart's T-2 ④ go red
// together. Verbatim in this round's return report; restored and re-greened.
//
// 🔴 The three-state cases run on the **real ChatFlowPage** (0.2.51 law: a
// case that only tests the widget stays green after the production wiring
// is deleted). The four-locale measurement case deliberately runs at the
// ComposeBand layer; the reason is on its own header (must swap AppStrings
// by locale, and the page's language comes from AppSettings).
//
// ⚠️ Ahem ruler (0.2.53 draft): flutter_test uses a placeholder font; every
// glyph is a full em square. **"Not clipped under Ahem" ⇒ "will not be
// clipped on a real device" holds** (conservative direction); the reverse
// does not. So the 360dp case asserts only on zh copy; the four-locale loop
// is relaxed to 640dp — this is a product of the font, not product slack,
// **and must not be cited as proof that "it fits exactly on a real device"**.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/compose_band.dart';
import 'package:flowmic/src/ui/ptt_bar.dart' show PttVisual;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/locale_terms.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _strip = find.byKey(const ValueKey<String>('compose.preview'));
final Finder _stripText =
    find.byKey(const ValueKey<String>('compose.preview.text'));
final Finder _stripCount =
    find.byKey(const ValueKey<String>('compose.preview.count'));
final Finder _stripTap =
    find.byKey(const ValueKey<String>('compose.preview.tap'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));

Future<ChatController> _pumpPage(
  WidgetTester tester, {
  double width = 360,
  double height = 780,
  SendPolicy policy = SendPolicy.direct,
  bool connected = true,
}) async {
  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  giveSessionAPairedIdentity(session);
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: policy),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await controller.session.dispose();
  });
  await controller.loadSendPolicy();
  if (connected) transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return controller;
}

/// The band alone, at a chosen width and locale — the four-locale measurement's
/// harness. `leading` carries a 38+8 stand-in for the production 「+」 button so
/// the strip is squeezed by the SAME fixed occupancy row 2 really has; without it
/// the measurement would be taken in a row that does not exist.
Future<void> _pumpBand(
  WidgetTester tester, {
  required AppLocale locale,
  required double width,
  double height = 780,
  String buffer = '',
}) async {
  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Padding(
          // The composer's own 10dp page padding (chat_flow_composer.dart).
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: ComposeBand(
            buffer: buffer,
            strings: AppStrings.of(locale),
            enabled: true,
            visual: PttVisual.idle,
            onExpand: () {},
            onControlKey: (_) => true,
            // PA-1: the production leading is the 44dp `+` (SUP-8); the row's
            // other fixed occupants (chip + send) are gone, so this stand-in
            // is the row's WHOLE fixed occupancy now.
            leading: const <Widget>[SizedBox(width: 44, height: 44), SizedBox(width: 8)],
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('🔴 S1 (contract §3): empty buffer ⇒ one line of entry small-print, and this cell is **not** an input box', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await _pumpPage(tester);

    expect(_strip, findsOneWidget);
    expect(tester.widget<Text>(_stripText).data, _zh.composeEntryStrip);
    // Empty state has no word-count cell — "0 words" is noise, not information
    // (same judgement as LiveDraftTile).
    expect(_stripCount, findsNothing);

    // 🔴 The contract §9 ④ criterion is **type**: a `readOnly` TextField still
    // steals focus and still pops the system keyboard. This cell being unable
    // to do that must be structural.
    expect(
      _field,
      findsNothing,
      reason: '🔴 row 2 has compose.field again — the fake box is back (owner Q3㋐)',
    );
    expect(
      find.descendant(of: _strip, matching: find.byType(EditableText)),
      findsNothing,
      reason: '🔴 the preview strip contains EditableText ⇒ it can steal focus and pop the keyboard',
    );

    // Positive control: this cell is actually painted on screen and has
    // height — the findsNothing above is not because the whole row was not
    // drawn.
    expect(tester.getSize(_strip).height, greaterThanOrEqualTo(38));
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 S2 (contract §3): non-empty buffer ⇒ single-line preview + word count, and the count uses the repo\'s only algorithm', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await _pumpPage(tester);
    // 🔴 Mixed script is deliberate: `textWordCount` judges 你(1)+好(1)+world(1)+123(1) = 4,
    // while `buffer.length` = 13. Asserting "it prints 4, not 13" proves this
    // cell **did not** count again on its own — the second implementation
    // the `entry_metrics.dart` file header forbids verbatim.
    controller.setBuffer('你好 world 123');
    await tester.pump();

    expect(tester.widget<Text>(_stripText).data, '你好 world 123');
    expect(_stripCount, findsOneWidget);
    final String count = tester.widget<Text>(_stripCount).data!;
    expect(
      count,
      contains('4'),
      reason: '🔴 the count is not textWordCount\'s answer ⇒ the live-draft row and this cell will each say their own number',
    );
    expect(
      count,
      isNot(contains('13')),
      reason: '🔴 it printed `buffer.length` ⇒ on CJK+Latin mix it will not match the number on the timeline',
    );
    // Under the direct policy a non-empty buffer is **not** edit mode
    // (the predicate is manual ∧ non-empty) ⇒ the floating card must not appear.
    expect(find.byKey(const ValueKey<String>('compose.card')), findsNothing);
    expect(_field, findsNothing);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 S3 (contract §3): manual + empty buffer ⇒ the same face as S1 (not the floating card)', (
    WidgetTester tester,
  ) async {
    final ChatController controller =
        await _pumpPage(tester, policy: SendPolicy.manual);
    expect(controller.sendPolicy, SendPolicy.manual);
    expect(_strip, findsOneWidget);
    expect(tester.widget<Text>(_stripText).data, _zh.composeEntryStrip);
    expect(
      find.byKey(const ValueKey<String>('compose.card')),
      findsNothing,
      reason: 'manual but empty buffer is **not** composeEditHold — the predicate did not move a word',
    );
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 S8 (contract §3): disconnected ⇒ grey strip + the existing sentence, and it accepts not a single tap', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await _pumpPage(tester, connected: false);

    expect(_strip, findsOneWidget);
    expect(
      tester.widget<Text>(_stripText).data,
      _zh.composeDisabled,
      reason: 'S8 must be able to say why, not merely look idle',
    );
    // 🔴 "inert" is not "has an InkWell but onTap: null" — the latter is
    // still a control that swallows taps. Under S8 this cell does not even
    // build an InkWell.
    expect(
      _stripTap,
      findsNothing,
      reason: '🔴 S8\'s preview strip wrapped an InkWell ⇒ it will swallow taps that should land elsewhere',
    );
    // Tap it: neither the expanded face nor any compose.field appears.
    await tester.tap(_strip, warnIfMissed: false);
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('compose.expanded')), findsNothing);
    expect(_field, findsNothing);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 T-2 ③ (0.2.53 law): the entry sentence reads in full on a 360dp zh page', (
    WidgetTester tester,
  ) async {
    // The criterion lands on the **render result** (didExceedMaxLines), not
    // on Text.data — that is exactly the shape of the defect where 1259
    // tests were green and the screen showed three letters.
    // ⚠️ zh only: CJK glyphs are already near a full em ⇒ Ahem and the real
    // font go the same way on this one; Latin under Ahem is inflated to
    // about twice as wide, so asserting en at 360dp would be a false red.
    final ChatController controller = await _pumpPage(tester);
    final RenderParagraph p = tester.renderObject<RenderParagraph>(_stripText);
    expect(
      p.didExceedMaxLines,
      isFalse,
      reason: '🔴 the entry sentence was clipped — the user cannot read 「${_zh.composeEntryStrip}」 in full, '
          'and this cell is now the only place row 2 speaks',
    );
    expect(tester.takeException(), isNull, reason: 'row 2 overflowed at 360dp');
    controller.session.debugStopIdlePresencePoll();
  });

  for (final AppLocale locale in AppLocale.values) {
    testWidgets('🔴 T-2 ③ four locales: ${locale.name} entry sentence is not clipped at 640dp', (
      WidgetTester tester,
    ) async {
      // ⚠️ 640 is not a product width; it is the **ruler's width** (the Ahem
      // discipline in the file header): en's 「Speak, or tap to type…」 is
      // full-em squares under Ahem and will necessarily overflow row 2 at
      // 360dp, while in a real font it is only half that. So this case asks
      // "does each of the four languages have an unclipped layout", **not**
      // "do all four languages fit in 360dp" — the latter this repo cannot
      // give.
      await _pumpBand(tester, locale: locale, width: 640);
      expect(_strip, findsOneWidget);
      final AppStrings s = AppStrings.of(locale);
      expect(tester.widget<Text>(_stripText).data, s.composeEntryStrip);
      expect(
        tester.renderObject<RenderParagraph>(_stripText).didExceedMaxLines,
        isFalse,
        reason: '${locale.name}: 「${s.composeEntryStrip}」 was clipped',
      );
      expect(tester.takeException(), isNull);
      // Each of the four locales is a real sentence, not zh copied four times.
      expect(s.composeEntryStrip, isNotEmpty);
    });
  }

  test('🔴 the entry sentence is distinct in every locale (i18n: the failure where one locale forgot to translate and just copied)', () {
    // Nine-locale expansion (2026-08-14): `hasLength(4)` under nine locales
    // would require "exactly 4 distinct" = require five to be copies; see
    // `support/locale_terms.dart`.
    expectPerLocaleDistinct(
      (AppStrings s) => s.composeEntryStrip,
      what: 'composeEntryStrip',
    );
    expectPerLocaleDistinct(
      (AppStrings s) => s.composeCollapse,
      what: 'composeCollapse',
      // 🔴 Simplified and Traditional are byte-identical on this sentence:
      // 「收起」 is the same writing in both glyph sets.
      // **measured** (678 cases × 9 locales full sweep) zh/zhTw have 43 such
      // coincidences; it is the Simplified/Traditional norm, not a missed
      // translation. Named rather than relaxed: an fr-copied-from-es
      // coincidence still goes red on the spot.
      mayShare: const <Set<AppLocale>>[<AppLocale>{AppLocale.zh, AppLocale.zhTw}],
    );
    expectPerLocaleDistinct(
      (AppStrings s) => s.composeExpandHint,
      what: 'composeExpandHint',
    );
  });

  test('🔴 the entry sentence is deliberately not composeHint — the latter promises "type right here"', () {
    // Reusing the old string would leave a sentence whose mechanism no
    // longer exists hanging on the screen (the second direction of red
    // line F2).
    for (final AppLocale l in AppLocale.values) {
      final AppStrings s = AppStrings.of(l);
      expect(
        s.composeEntryStrip,
        isNot(s.composeHint),
        reason: '${l.name}: the preview strip borrowed the in-box placeholder wording',
      );
    }
  });
}
