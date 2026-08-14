// PA-1 acceptance (band half) — the ComposeBand's visible contract after the
// Plan A′ dock restructure: the PC key group (four remote keys in an outlined,
// labelled container), the `[+][preview]` row, and the A8/A9 honesty faces.
//
// SPEC-REF: docs/ui-design/2026-08-13-plan-a-dock-and-edit-sheet-contract.md
//   §2 SUP-2 (no send button in the idle dock), SUP-4 (one visibility
//   predicate, keys hide during processing too), §4 A8/A9, §5-1 (group
//   geometry, per-key labels, 44dp russler).
//
// ── PA-1 rewrote a third of this file, by design (contract §7 fate table) ────
// The send-button family (➤/⚡ faces, long-press flip, corner tick, 800ms
// flash, empty-buffer inert) is GONE with the button itself (SUP-2). What each
// deleted case guarded moved:
//   · 「policy switch is visible and reachable」 → the row-1 chip's own cases in
//     compose_three_row_layout_test.dart (the chip is a PAGE surface now);
//   · 「the flash appears once and leaves no permanent UI」 → same file
//     (SendPolicyFlashChip carries the V2-04 mechanism verbatim);
//   · 「no send button in the idle dock」 → its own case BELOW, because absence
//     is now the contract (SUP-2) and needs a guard of its own.
//
// ── Reverse controls run for this file (seen red, then reverted) ────────────
// ① Re-adding a 44×44 send-button lookalike (key 'compose.send') to the plain
//    row turns 「SUP-2: no send button」 red by name — the run is quoted in the
//    WP7 return report.
// ② Setting the group's disabled branch back to `onTap: null` (A8) turns
//    「disconnected keys still answer」 red (spy.keys stays empty).
//
// Everything here runs on FAKE CALLBACKS — no PttSession, no socket. Driving
// the real async PTT chain inside testWidgets' FakeAsync zone deadlocks; that
// half of the contract is covered by compose_send_policy_test.dart.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/ui/compose_band.dart';
import 'package:flowmic/src/ui/ptt_bar.dart' show PttVisual;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'support/locale_terms.dart';

/// Records everything the band asks its owner to do.
class _Spy {
  final List<ControlKeyKind> keys = <ControlKeyKind>[];

  /// T-2/T-3: how many times the preview strip asked the PAGE to open the
  /// edit surface. "0 after a tap" is the affordance lie.
  int expands = 0;
  String buffer = '';
}

/// Hosts the band with owner-held buffer state, exactly like ChatFlowPage does.
class _Host extends StatefulWidget {
  const _Host({
    // ⚠️ Pass a DISTINCT key when a case pumps several hosts in a row: without
    // one Flutter reuses the same `_HostState`, `initialBuffer` is only read in
    // `initState`, and the second pump silently keeps the FIRST host's buffer.
    super.key,
    required this.spy,
    this.enabled = true,
    this.initialBuffer = '',
    this.visual = PttVisual.idle,
    this.locale = AppLocale.zh,
    this.controlKeyAnswer = true,
  });
  final _Spy spy;
  final bool enabled;
  final String initialBuffer;
  final AppLocale locale;

  /// What [ComposeBand.onControlKey] reports back ("did the frame leave this device").
  final bool controlKeyAnswer;

  /// The dock face the page computes and hands down (SUP-4's one author).
  final PttVisual visual;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  late final String _buffer = widget.initialBuffer;

  @override
  void initState() {
    super.initState();
    widget.spy.buffer = _buffer;
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: ComposeBand(
        buffer: _buffer,
        strings: AppStrings.of(widget.locale),
        enabled: widget.enabled,
        visual: widget.visual,
        onExpand: () => widget.spy.expands++,
        onControlKey: (ControlKeyKind k) {
          widget.spy.keys.add(k);
          return widget.controlKeyAnswer;
        },
      ),
    ),
  );
}

Finder _ctrl(ControlKeyKind k) =>
    find.byKey(ValueKey<String>('compose.ctrl.${k.name}'));
Finder _ctrlLabel(ControlKeyKind k) =>
    find.byKey(ValueKey<String>('compose.ctrl.${k.name}.label'));

final Finder _group = find.byKey(const ValueKey<String>('compose.keys.group'));
final Finder _groupLabel =
    find.byKey(const ValueKey<String>('compose.keys.groupLabel'));
final Finder _reason = find.byKey(const ValueKey<String>('compose.keys.reason'));
final Finder _preview = find.byKey(const ValueKey<String>('compose.preview'));

/// The six glyph keys T-1 deleted. Kept as a LIST OF KINDS rather than of
/// literal characters so this file cannot drift from `controlKeyGlyph`.
const List<ControlKeyKind> _deletedPunctuation = <ControlKeyKind>[
  ControlKeyKind.punctComma,
  ControlKeyKind.punctQuestion,
  ControlKeyKind.punctExclamation,
  ControlKeyKind.punctEnumeration,
  ControlKeyKind.punctColon,
  ControlKeyKind.punctPeriod,
];

void main() {
  final Finder send = find.byKey(const ValueKey<String>('compose.send'));
  final Finder field = find.byKey(const ValueKey<String>('compose.field'));

  testWidgets('🔴 SUP-2: there is NO send button in this band, under any '
      'buffer state', (WidgetTester tester) async {
    // REVERSE CONTROL ① (seen red, reverted): re-adding a 'compose.send'
    // control to the plain row fails this case by name.
    await tester.pumpWidget(
      _Host(key: const ValueKey<String>('e'), spy: _Spy()),
    );
    expect(send, findsNothing, reason: '🔴 the idle dock grew a send button '
        'back — delivering lives in the edit sheet footer (SUP-2)');
    await tester.pumpWidget(
      _Host(
        key: const ValueKey<String>('f'),
        spy: _Spy(),
        initialBuffer: '有内容也没有发送钮',
      ),
    );
    expect(send, findsNothing);
    // Positive control: the band did render (the absence above is not an
    // empty screen).
    expect(_preview, findsOneWidget);
    expect(_group, findsOneWidget);
  });

  testWidgets('🔴 PA-1: the four remote keys live in ONE outlined group with '
      'the PC edge label — no punctuation glyph, no chevron, anywhere', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_Host(spy: _Spy()));
    expect(_group, findsOneWidget);
    expect(_groupLabel, findsOneWidget, reason: 'PC label missing ⇒ the '
        '"container-layer split" between the key group and draft-class controls lost half');
    for (final ControlKeyKind k in kComposeControlKeys) {
      expect(
        find.descendant(of: _group, matching: _ctrl(k)),
        findsOneWidget,
        reason: '${k.name} button missing from the group',
      );
    }
    expect(kComposeControlKeys.length, 4);

    for (final ControlKeyKind k in _deletedPunctuation) {
      expect(
        find.byKey(ValueKey<String>('compose.punct.${controlKeyGlyph(k)}')),
        findsNothing,
        reason: '${k.name} button came back — the punctuation group was deleted as a whole (owner Q2㋐)',
      );
    }
    expect(
      find.byKey(const ValueKey<String>('compose.tools.toggle')),
      findsNothing,
      reason: 'chevron came back — the group it collapsed no longer exists',
    );
  });

  testWidgets('V2-03 owner ⑤, group form: the key group spans to the band\'s '
      'right edge and ⏎ keeps the rightmost slot', (WidgetTester tester) async {
    // owner ⑤:「⏎/⌫/↶/✕ 是高频常用键……应该放右边」. The group is full-width and
    // equal-flex now, so the assertion moves to what still CAN regress: the
    // group hugging the band's right edge, and ⏎ deepest in the thumb arc.
    await tester.pumpWidget(_Host(spy: _Spy()));

    final double bandRight = tester.getBottomRight(find.byType(ComposeBand)).dx;
    expect(
      tester.getTopRight(_group).dx,
      closeTo(bandRight, 0.5),
      reason: 'the key group does not hug the band\'s right edge ⇒ the owner\'s thumb-arc wording was moved by layout',
    );

    final double enterX = tester.getTopLeft(_ctrl(ControlKeyKind.enter)).dx;
    for (final ControlKeyKind k in kComposeControlKeys) {
      if (k == ControlKeyKind.enter) continue;
      expect(
        enterX,
        greaterThan(tester.getTopLeft(_ctrl(k)).dx),
        reason: '⏎ must sit right of ${k.name} (deepest in the thumb arc)',
      );
    }
    // ✕ takes the position furthest from ⏎.
    expect(
      tester.getTopLeft(_ctrl(ControlKeyKind.clear)).dx,
      lessThan(tester.getTopLeft(_ctrl(ControlKeyKind.backspace)).dx),
    );
  });

  testWidgets('🔴 contract §5-1: every key is a ≥44dp touch target and the '
      'four are the SAME size — measured, not read off the constant', (
    WidgetTester tester,
  ) async {
    // 360dp — the narrow width the ruler actually has to survive at.
    tester.view.physicalSize = const Size(360 * 3, 780 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_Host(spy: _Spy()));

    final Size first = tester.getSize(_ctrl(kComposeControlKeys.first));
    for (final ControlKeyKind k in kComposeControlKeys) {
      final Size size = tester.getSize(_ctrl(k));
      expect(size.width, greaterThanOrEqualTo(44), reason: '${k.name} too narrow');
      expect(size.height, greaterThanOrEqualTo(44), reason: '${k.name} too short');
      expect(size, first, reason: '${k.name} is a different size from the other keys ⇒ equal-flex broke');
    }
    expect(tester.takeException(), isNull, reason: 'the key group overflowed at 360dp');
  });

  testWidgets('🔴 SUP-4: the whole band is ZERO-height outside the three idle '
      'faces — recording, processing AND justDone', (WidgetTester tester) async {
    // SUP-4 closed compose-band contract §10-1 in the 「hide」 direction, so
    // processing now hides the keys too (the old S7 asserted the opposite —
    // red by design, contract §7).
    for (final (String tag, PttVisual v) in <(String, PttVisual)>[
      ('rec', PttVisual.recording),
      ('proc', PttVisual.processing),
      ('done', PttVisual.justDone),
    ]) {
      await tester.pumpWidget(
        _Host(key: ValueKey<String>(tag), spy: _Spy(), visual: v),
      );
      expect(_group, findsNothing, reason: '$tag: key group still present (SUP-4)');
      expect(_preview, findsNothing, reason: '$tag: row 2 still present');
      expect(
        tester.getSize(find.byType(ComposeBand)).height,
        0,
        reason: '$tag: the band is not zero-height ⇒ a silent strip is still sitting above the PTT',
      );
    }

    // Positive control + the recoverable side: idle / disabled keep the PC
    // keys. noted (light-record) keeps row 2 and HIDES the keys (REQ-14-01).
    for (final (String tag, PttVisual v) in <(String, PttVisual)>[
      ('idle', PttVisual.idle),
      ('noted', PttVisual.noted),
      ('dis', PttVisual.disabled),
    ]) {
      await tester.pumpWidget(
        _Host(
          key: ValueKey<String>(tag),
          spy: _Spy(),
          visual: v,
          enabled: v != PttVisual.disabled,
        ),
      );
      expect(_preview, findsOneWidget, reason: '$tag: row 2 not present');
      if (v == PttVisual.noted) {
        expect(_group, findsNothing, reason: '$tag: light-record still draws the PC keys');
      } else {
        expect(_group, findsOneWidget, reason: '$tag: key group not present');
      }
    }
  });

  testWidgets('a QuickAction key reports its kind and does NOT touch the '
      'buffer (it acts on the PC, not on this box)', (WidgetTester tester) async {
    final _Spy spy = _Spy();
    await tester.pumpWidget(_Host(spy: spy, initialBuffer: '不该被动'));
    await tester.tap(_ctrl(ControlKeyKind.enter));
    await tester.tap(_ctrl(ControlKeyKind.backspace));
    await tester.tap(_ctrl(ControlKeyKind.undo));
    await tester.tap(_ctrl(ControlKeyKind.clear));
    await tester.pump();
    expect(spy.keys, <ControlKeyKind>[
      ControlKeyKind.enter,
      ControlKeyKind.backspace,
      ControlKeyKind.undo,
      ControlKeyKind.clear,
    ]);
    expect(spy.buffer, '不该被动');
  });

  testWidgets('🔴 T-2 ④ (contract §9 ④): that cell on row 2 is **not** a TextField — it cannot '
      'take focus and cannot raise the keyboard, structurally', (
    WidgetTester tester,
  ) async {
    final _Spy spy = _Spy();
    await tester.pumpWidget(_Host(spy: spy));
    expect(_preview, findsOneWidget);
    expect(
      find.descendant(of: _preview, matching: find.byType(TextField)),
      findsNothing,
      reason: '🔴 row 2 grew a TextField again — the fake box is back (owner Q3㋐)',
    );
    expect(
      find.byType(EditableText),
      findsNothing,
      reason: '🔴 a readOnly TextField is still an EditableText and still raises the keyboard',
    );
    expect(field, findsNothing);

    // The strip's tap is a promise the page-level sheet pays for; the band's
    // whole share is reporting it upward.
    await tester.tap(_preview);
    await tester.pump();
    expect(
      spy.expands,
      1,
      reason: 'tapping the preview strip did nothing ⇒ 「点这里输入或查看」 became a sentence nobody pays for',
    );
    expect(spy.buffer, isEmpty);
  });

  testWidgets('🔴 A8: disconnected — the keys DIM but still ANSWER the tap '
      '(the refusal banner path), and the preview is inert and says why', (
    WidgetTester tester,
  ) async {
    // Contract §4 A8: 「keys dimmed AND still answering taps with the existing
    // ComposeSendFailure honesty path」. Until PA-1 a disconnected key played
    // dead (onTap: null) — the tap now reaches `sendControlKey`, whose refusal
    // raises the notConnected banner and the refused haptic.
    // REVERSE CONTROL ② (seen red, reverted): `onTap: null` on the disabled
    // branch leaves spy.keys empty here.
    final _Spy spy = _Spy();
    await tester.pumpWidget(
      _Host(spy: spy, enabled: false, controlKeyAnswer: false),
    );
    expect(find.text('未连接 · 无法发送'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('compose.preview.tap')),
      findsNothing,
      reason: 'S8\'s preview strip must not wrap an InkWell — a control that swallows taps is not "inert"',
    );

    await tester.tap(_ctrl(ControlKeyKind.enter));
    await tester.pump();
    expect(
      spy.keys,
      <ControlKeyKind>[ControlKeyKind.enter],
      reason: '🔴 a disconnected key is playing dead — A8 wants it to hand the tap to sendControlKey so the existing '
          'notConnected banner can explain, not a control that does nothing when tapped',
    );
    // The group wears the dim face while doing it.
    final Opacity dim = tester.widget<Opacity>(
      find.ancestor(of: _group, matching: find.byType(Opacity)).first,
    );
    expect(dim.opacity, lessThan(1));
    // No reason line in A8: the preview strip one centimetre up already says
    // 未连接, and the tap's own banner names it again — a third copy is noise.
    expect(_reason, findsNothing);
  });

  testWidgets('🔴 A9 / REQ-14-01: record-only HIDES the PC keys — they answer '
      'a PC-focus question this destination does not have', (
    WidgetTester tester,
  ) async {
    final _Spy spy = _Spy();
    await tester.pumpWidget(_Host(spy: spy, visual: PttVisual.noted));

    expect(_preview, findsOneWidget);
    expect(_group, findsNothing);
    expect(_reason, findsNothing);
    expect(_ctrl(ControlKeyKind.enter), findsNothing);
    expect(_ctrl(ControlKeyKind.clear), findsNothing);
    expect(spy.keys, isEmpty);
  });

  testWidgets('M3: a remote key long-press names what it does ON THE PC', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_Host(spy: _Spy()));
    await tester.longPress(_ctrl(ControlKeyKind.backspace));
    await tester.pump();
    expect(find.textContaining('删除电脑端一个字符'), findsOneWidget);
  });

  testWidgets('🔴 ✕ long-press explanation must no longer say it clears the local input box (owner supplement #3)', (
    WidgetTester tester,
  ) async {
    // `keyClearHint` is **the only explanation the user can read before
    // pressing ✕** — it must keep answering "will my draft disappear", and
    // the answer is no.
    await tester.pumpWidget(
      _Host(spy: _Spy(), key: const ValueKey<String>('hint')),
    );
    await tester.longPress(_ctrl(ControlKeyKind.clear));
    await tester.pump();

    expect(
      find.textContaining('清空电脑端文字'),
      findsOneWidget,
      reason: '✕ long-press explanation did not appear ⇒ the findsNothing below proves nothing',
    );
    expect(
      find.textContaining('并清空本地输入框'),
      findsNothing,
      reason: '🔴 ✕ is still promising to clear the local input box, and it no longer does — R11',
    );
    expect(find.textContaining('不影响本机草稿'), findsOneWidget);
  });

  // ── PA-6: the per-key labels + the group label are RENDERED copy ──────────
  // 0.2.53 law: the criterion is the layout result, never Text.data. zh is
  // asserted at the product width (CJK ≈ full-em in both Ahem and real fonts);
  // the four-locale loop runs at a MEASURING width because Ahem doubles latin
  // (compose_preview_strip_test.dart's documented ruler discipline).
  testWidgets('🔴 PA-6: zh per-key labels render un-clipped at 360dp', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(360 * 3, 780 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_Host(spy: _Spy()));
    for (final ControlKeyKind k in kComposeControlKeys) {
      expect(
        tester.renderObject<RenderParagraph>(_ctrlLabel(k)).didExceedMaxLines,
        isFalse,
        reason: '${k.name} per-key label was clipped at 360dp',
      );
    }
    expect(tester.takeException(), isNull);
  });

  for (final AppLocale locale in AppLocale.values) {
    testWidgets('🔴 PA-6 four locales: ${locale.name} key labels + group label render '
        'un-clipped at the measuring width', (WidgetTester tester) async {
      // 640 is the RULER's width, not a product width — the Ahem discipline
      // from compose_preview_strip_test.dart applies verbatim: this asserts
      // 「each locale has an un-clipped layout」, not 「it fits at 360」.
      tester.view.physicalSize = const Size(640 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(_Host(spy: _Spy(), locale: locale));
      final AppStrings s = AppStrings.of(locale);
      for (final ControlKeyKind k in kComposeControlKeys) {
        expect(
          tester.renderObject<RenderParagraph>(_ctrlLabel(k)).didExceedMaxLines,
          isFalse,
          reason: '${locale.name}/${k.name}: per-key label was clipped',
        );
      }
      expect(_groupLabel, findsOneWidget);
      expect(s.pcKeysGroupLabel, isNotEmpty);
      expect(tester.takeException(), isNull);
    });
  }

  test('REQ-14-01: composePcKeysVisible is idle/disabled only', () {
    expect(composePcKeysVisible(PttVisual.idle), isTrue);
    expect(composePcKeysVisible(PttVisual.disabled), isTrue);
    expect(composePcKeysVisible(PttVisual.noted), isFalse);
    expect(composePcKeysVisible(PttVisual.recording), isFalse);
    expect(composePcKeysVisible(PttVisual.processing), isFalse);
    expect(composePcKeysVisible(PttVisual.justDone), isFalse);
  });

  test('🔴 PA-6: the A9 reason line is a DISTINCT translation per locale', () {
    // Nine-locale expansion (2026-08-14): `hasLength(4)` under nine locales
    // is a sentence that says the opposite (see the comment on
    // `expectPerLocaleDistinct` in `support/locale_terms.dart`).
    // measured: pcKeysUnavailableNoted is distinct in all nine locales ⇒
    // no mayShare needed.
    expectPerLocaleDistinct(
      (AppStrings s) => s.pcKeysUnavailableNoted,
      what: 'pcKeysUnavailableNoted (A9 reason line)',
    );
  });

  // ── PA-1 deleted the send-button cases here, and no guarantee was dropped ──
  // ① faces / long-press flip / corner tick / flash → the chip in row 1 owns
  //   the toggle now; its cases live in compose_three_row_layout_test.dart
  //   (page level, where the chip actually renders).
  // ② 「empty buffer ⇒ ➤ inert」 → the deliver button in the edit sheet footer
  //   carries the same canSend gate; pinned in the sheet's own tests (PA-4).
  // ③ 「with content ➤ sends」 → same move (sheet footer = sendBuffer).
}
