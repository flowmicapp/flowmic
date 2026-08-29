// 0.3.43 Q5-③ — THE IN-SHEET APPEND BUTTON GETS A DISABLED FACE.
//
// Ruling:
//   docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md Q5-③
//
// The button presses `ChatController.canPtt` (`pttDown` opens with
// `if (!canPtt) return false;`). That gate is false whenever the link is down,
// a previous utterance is still in PROCESSING, or an AI compose run is in
// flight — and in every one of those cases the button kept its full live face,
// accepted the hold and did nothing at all. A control that looks alive and
// changes nothing is this repo's oldest red line, and the PTT bar has had
// [PttVisual.disabled] since it was written: the sheet button runs the SAME
// GESTURE CHAIN and was simply missing that half, exactly like the accessible
// cancel NR-4 (g) found here for the same reason.
//
// ⚠️ WHAT THIS FILE DOES NOT OWN. Which SENTENCE a disabled tap produces is the
// SHEET's decision, not the button's — `canPtt` is a conjunction whose terms
// call for different actions, so the widget takes a callback and the call site
// (chat_flow_edit_sheet.dart) picks between the link-down copy and the
// still-busy copy. Pinning that choice here would give one rule two homes.

import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart' show SheetAppendButton;
import 'package:flowmic/src/ui/hold_to_talk_surface.dart';
import 'package:flowmic/src/ui/mic_glyph.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _appendBtn = find.byType(SheetAppendButton);

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 360,
      child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[child]),
    ),
  ),
);

BoxDecoration? _faceDecoration(WidgetTester tester) {
  final Iterable<Container> boxes = tester.widgetList<Container>(
    find.descendant(of: _appendBtn, matching: find.byType(Container)),
  );
  for (final Container c in boxes) {
    if (c.decoration != null) return c.decoration as BoxDecoration?;
  }
  return null;
}

void main() {
  testWidgets('disabled wears the dock\'s own OFF vocabulary, not the live face',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      _host(
        SheetAppendButton(
          appending: false,
          strings: _zh,
          enabled: true,
          onDown: () async => true,
          onUp: () async {},
          onCancel: () async {},
        ),
      ),
    );
    final BoxDecoration live = _faceDecoration(tester)!;
    expect(live.color, FlowMicDockColors.pri);
    expect(find.descendant(of: _appendBtn, matching: find.byType(MicGlyph)),
        findsOneWidget);

    await tester.pumpWidget(
      _host(
        SheetAppendButton(
          appending: false,
          strings: _zh,
          enabled: false,
          onDown: () async => true,
          onUp: () async {},
          onCancel: () async {},
        ),
      ),
    );
    final BoxDecoration off = _faceDecoration(tester)!;
    // The SAME two tokens `PttVisual.disabled` uses on the bar
    // (`.ptt.dis{background:var(--chipbg);color:var(--sub)}`) — this control
    // must not invent a second 「off」 colour.
    expect(off.color, FlowMicDockColors.chipbg);
    // And it must not merely be a tint of the live face: the whole complaint is
    // that the two were indistinguishable.
    expect(off.color, isNot(live.color));
    // Label-only, exactly like the bar's disabled frame. Dropping the glyph is
    // most of what makes 「cannot be pressed」 readable at a glance.
    expect(find.descendant(of: _appendBtn, matching: find.byType(MicGlyph)),
        findsNothing);
  });

  testWidgets('a press on the disabled face explains itself instead of doing '
      'nothing', (WidgetTester tester) async {
    int explained = 0;
    int downs = 0;

    await tester.pumpWidget(
      _host(
        SheetAppendButton(
          appending: false,
          strings: _zh,
          enabled: false,
          onDown: () async {
            downs++;
            return true;
          },
          onUp: () async {},
          onCancel: () async {},
          onDisabledTap: () => explained++,
        ),
      ),
    );

    await tester.tap(_appendBtn);
    await tester.pump();
    expect(explained, 1);

    // 🔴 AND THE HOLD RECOGNIZER IS GONE, not merely inert. A long press must
    // not silently start a recording behind a face that says it cannot.
    final TestGesture g = await tester.startGesture(
      tester.getCenter(_appendBtn),
    );
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();
    await g.up();
    await tester.pump();
    expect(downs, 0);
    expect(
      find.byKey(const ValueKey<String>('compose.sheet.append')),
      findsNothing,
    );
  });

  testWidgets('a11y: the disabled face reports disabled but still answers an '
      'activation', (WidgetTester tester) async {
    int explained = 0;
    final SemanticsHandle handle = tester.ensureSemantics();

    await tester.pumpWidget(
      _host(
        SheetAppendButton(
          appending: false,
          strings: _zh,
          enabled: false,
          onDown: () async => true,
          onUp: () async {},
          onCancel: () async {},
          onDisabledTap: () => explained++,
        ),
      ),
    );

    final SemanticsData data =
        tester.getSemantics(_appendBtn).getSemanticsData();
    // Tristate.isFalse = the node HAS an enabled state and it is off — the same
    // reading `ptt_bar_a11y_test.dart` pins on the bar's disabled faces.
    expect(data.flagsCollection.isEnabled, Tristate.isFalse);

    // 🔴 AND THE TAP ACTION STAYS. This is where this control DIVERGES from the
    // bar, deliberately: the bar's disabled face drops `onTap` because it has
    // nothing to say, while this one has a reason to give. A silent refusal
    // reads as a broken control to an AT user exactly as it does to a sighted
    // one, and 「disabled」 without 「why」 is half the fix.
    expect(data.hasAction(SemanticsAction.tap), isTrue);
    await tester.tap(_appendBtn);
    await tester.pump();
    expect(explained, 1);

    handle.dispose();
  });

  testWidgets('🔴 the gate is read AT REST ONLY — it must not steal a live hold',
      (WidgetTester tester) async {
    // The reason `_activating` exists. `canPtt` goes false the instant the FSM
    // enters RECORDING, which is roughly two seconds BEFORE `onDown` returns and
    // the parent sets `appending: true`. A naive `widget.enabled` read would
    // repaint this control as disabled in the middle of the user's own hold and
    // hand the pointer to the tap handler instead of the release — i.e. the fix
    // for a dead control would have broken the live one.
    int ups = 0;
    bool gate = true;
    final Completer<bool> down = Completer<bool>();
    late StateSetter setOuter;

    await tester.pumpWidget(
      _host(
        StatefulBuilder(
          builder: (BuildContext context, StateSetter setState) {
            setOuter = setState;
            return SheetAppendButton(
              appending: false,
              strings: _zh,
              enabled: gate,
              onDown: () => down.future,
              onUp: () async => ups++,
              onCancel: () async {},
              onDisabledTap: () {},
            );
          },
        ),
      ),
    );

    final TestGesture g = await tester.startGesture(
      tester.getCenter(_appendBtn),
    );
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();
    // The parent flips the gate mid-await, exactly as the real controller does
    // the moment the FSM enters RECORDING — ~2 s before `onDown` returns.
    setOuter(() => gate = false);
    await tester.pump();
    down.complete(true);
    await tester.pump();
    await tester.pump();
    // Still a hold surface, not a tap target, even though the gate is now false.
    expect(
      find.byKey(const ValueKey<String>('compose.sheet.append')),
      findsOneWidget,
    );

    await g.up();
    await tester.pump();
    expect(ups, 1);
  });
}
