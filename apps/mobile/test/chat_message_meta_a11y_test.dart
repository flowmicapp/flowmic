// CARD-UI review fixes (MAIN 2026-10-14) — what the meta lines owe a reader
// and a finger, on the cards where it is hardest: ru, 360 dp, text size 1.15.
//
//   C1  a PC name with no room left is not painted, but a screen reader
//       still reads it (its node has a real rect), after the delivery state;
//   C3  in selection mode a tap on the short polish chip or the edited icon
//       toggles the selection (no tap tooltip takes it);
//   C4  the Resend and edited icons report a 48 × 48 dp rect to
//       accessibility; a tap on the meta block's EMPTY space within 24 dp of
//       the Resend icon resends, a tap on any neighbouring item or on the
//       transcript text does not (a resend re-types text on the computer);
//       a long press on the icon opens the row's menu (no tooltip takes it);
//   C7  in selection mode the reason sentence still keys on whether the row
//       CAN be resent, not on whether the inline link is drawn.
//
// Each case first proves its card is the one it means (the precondition)
// and reads the render / semantics tree, not `Text.data`.
//
// Reverse controls (2026-10-15; each `flutter test test/chat_message_meta_
// a11y_test.dart --plain-name <case>` read `+0 -1`, then `+1` restored,
// RC-REVERT grep=0):
//   C1  hidden PC laid out at width 0 (chat_message_meta_layout.dart) →
//       `Expected: a value greater than <0>  Actual: <0.0>` (the node's rect);
//       2026-10-15, hidden PC placed at x 0 instead of line 1's end → the
//       reading order: `Expected: a value greater than <1>  Actual: <0>`;
//   C3  `tapShowsFull: true` in selection mode → `Expected: <1> Actual: <null>`;
//   C4  2026-10-15, the target's area tried BEFORE the exact boxes (the
//       shape of the card-wide scope that sent neighbour taps to Resend) →
//       `Expected: null  Actual: <1>` with `a tap on the neighbour at …`;
//       a long-press Tooltip back on the Resend icon → the row menu:
//       `Expected: <1> Actual: <null>`;
//   C7  `hasResendAffordance: resendShown` → the two sentences differ
//       (`Which: is different.`).

import 'package:flowmic/src/session/polish_badge.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_meta.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/meta_fit_rows.dart';
import 'support/real_latin_font.dart';
import 'support/square_fallback_font.dart';

const AppLocale _kLocale = AppLocale.ru;

void main() {
  setUpAll(() async {
    await loadRealLatinFace();
    await loadSquareFallbackFace();
  });
  final AppStrings s = AppStrings.of(_kLocale);

  Future<void> mount(WidgetTester tester, List<Widget> tiles) async {
    tester.view.physicalSize = const Size(360, 100000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final AppSettingsController settings = await metaSettings(
      _kLocale,
      AppTextScale.xlarge,
    );
    addTearDown(settings.dispose);
    await tester.pumpWidget(
      metaApp(
        settings,
        Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
            child: Column(
              children: <Widget>[
                for (final Widget t in tiles) ...<Widget>[
                  t,
                  const SizedBox(height: 10),
                ],
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
  }

  Finder cardOf(String id) => find.byWidgetPredicate(
    (Widget w) => w is ChatMessageTile && w.entry.id == id,
  );

  // The direct child of the card's meta block that [part] sits under, and
  // that block.
  (RenderMetaLines, RenderBox) topOf(
    WidgetTester tester,
    String id,
    Finder part,
  ) {
    final RenderMetaLines block = tester.renderObject<RenderMetaLines>(
      find.descendant(of: cardOf(id), matching: find.byType(MetaLines)),
    );
    RenderObject cur = tester.renderObject(
      find.descendant(of: cardOf(id), matching: part).first,
    );
    while (!identical(cur.parent, block)) {
      cur = cur.parent!;
    }
    return (block, cur as RenderBox);
  }

  testWidgets('C1: a hidden PC name is still read by a screen reader', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle semantics = tester.ensureSemantics();
    final DateTime now = DateTime.now();
    final MetaRow row = metaRows(
      now,
    ).firstWhere((MetaRow r) => r.id == 'noFocus');
    await mount(tester, <Widget>[
      ChatMessageTile(
        entry: row.build(createdAt: MetaStamp.today.at(now), edited: false),
        strings: s,
        queued: row.queued,
        canResendImage: false,
        onRetry: (_) {},
      ),
    ]);
    final Finder pc = find.textContaining(kMetaPc, findRichText: true);
    final (RenderMetaLines block, RenderBox top) = topOf(tester, row.id, pc);
    // Precondition: on this card the PC name has no room and is not painted.
    expect(block.isFlexible(top), isTrue);
    expect(block.lineOf(top), -1);
    // …and yet it is in the semantics tree with a real rect.
    final SemanticsNode node = tester.getSemantics(pc.first);
    expect(node.label, contains(kMetaPc));
    expect(node.rect.width, greaterThan(0));
    expect(node.rect.height, greaterThan(0));
    expect(find.bySemanticsLabel(RegExp(RegExp.escape(kMetaPc))), findsWidgets);
    // …read after the delivery state, not before it.
    final List<String> order = <String>[];
    void collect(SemanticsNode n) {
      if (n.label.isNotEmpty) order.add(n.label);
      for (final SemanticsNode c in n.debugListChildrenInOrder(
        DebugSemanticsDumpOrder.traversalOrder,
      )) {
        collect(c);
      }
    }

    collect(
      tester
          .binding
          .renderViews
          .first
          .owner!
          .semanticsOwner!
          .rootSemanticsNode!,
    );
    final String state = deliveryFaceMeta(DeliveryFace.noFocus, s).label;
    final int stateAt = order.indexWhere((String l) => l.contains(state));
    final int pcAt = order.indexWhere((String l) => l.contains(kMetaPc));
    expect(stateAt, greaterThanOrEqualTo(0), reason: order.join(' | '));
    expect(pcAt, greaterThan(stateAt), reason: order.join(' | '));
    semantics.dispose();
  });

  testWidgets('C3: in selection mode a tap on the short polish chip and on '
      'the edited icon toggles the row', (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    final Map<String, int> toggled = <String, int>{};
    final Map<String, PolishBadge> badges = <String, PolishBadge>{};
    final List<Widget> tiles = <Widget>[];
    for (final MetaRow row in metaRows(now)) {
      for (final PolishBadge badge in PolishBadge.values) {
        final String id = '${row.id}-${badge.name}';
        badges[id] = badge;
        tiles.add(
          ChatMessageTile(
            entry: row.build(
              id: id,
              createdAt: MetaStamp.thisYear.at(now),
              edited: true,
            ),
            strings: s,
            queued: row.queued,
            canResendImage: false,
            onRetry: (_) {},
            polishSkippedLabel: badge.label(s),
            polishSkippedShortLabel: badge.shortLabel(s),
            isFavorite: true,
            selected: false,
            onSelectToggle: () => toggled[id] = (toggled[id] ?? 0) + 1,
          ),
        );
      }
    }
    await mount(tester, tiles);
    String? shortId;
    String? editedId;
    for (final String id in badges.keys) {
      final PolishBadge b = badges[id]!;
      final Finder short = find.text(b.shortLabel(s));
      if (shortId == null &&
          b.shortLabel(s) != b.label(s) &&
          find
              .descendant(of: cardOf(id), matching: short)
              .evaluate()
              .isNotEmpty) {
        final (RenderMetaLines block, RenderBox top) = topOf(tester, id, short);
        if (block.lineOf(top) >= 0 && block.formOf(top) == MetaForm.compact) {
          shortId = id;
        }
      }
      final Finder icon = find.byKey(ValueKey<String>('entry.edited.icon.$id'));
      if (editedId == null &&
          find
              .descendant(of: cardOf(id), matching: icon)
              .evaluate()
              .isNotEmpty) {
        final (RenderMetaLines block, RenderBox top) = topOf(tester, id, icon);
        if (block.lineOf(top) >= 0) editedId = id;
      }
    }
    expect(shortId, isNotNull, reason: 'no card paints a short polish chip');
    expect(editedId, isNotNull, reason: 'no card paints the edited icon');

    final Finder shortChip = find.descendant(
      of: cardOf(shortId!),
      matching: find.text(badges[shortId]!.shortLabel(s)),
    );
    await tester.ensureVisible(shortChip);
    await tester.tap(shortChip);
    await tester.pump(const Duration(milliseconds: 300));
    expect(toggled[shortId], 1);
    final Finder editedIcon = find.byKey(
      ValueKey<String>('entry.edited.icon.$editedId'),
    );
    await tester.ensureVisible(editedIcon);
    await tester.tap(editedIcon);
    await tester.pump(const Duration(milliseconds: 300));
    expect(toggled[editedId], 1);
  });

  testWidgets('C4: the Resend icon takes taps on empty space near it, never '
      'on a neighbour or the text, and a long press opens the row menu', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle semantics = tester.ensureSemantics();
    final DateTime now = DateTime.now();
    final Map<String, int> resent = <String, int>{};
    final Map<String, int> menus = <String, int>{};
    final List<String> ids = <String>[];
    final List<Widget> tiles = <Widget>[];
    for (final MetaRow row in metaRows(now)) {
      for (final PolishBadge? badge in <PolishBadge?>[
        null,
        ...PolishBadge.values,
      ]) {
        for (final MetaStamp stamp in MetaStamp.values) {
          for (final bool marks in <bool>[false, true]) {
            final String id = '${row.id}-${badge?.name}-${stamp.name}-$marks';
            ids.add(id);
            tiles.add(
              ChatMessageTile(
                entry: row.build(
                  id: id,
                  createdAt: stamp.at(now),
                  edited: marks,
                  resentAt: marks ? stamp.at(now) : null,
                ),
                strings: s,
                queued: row.queued,
                canResendImage: false,
                onRetry: (TimelineEntry e) =>
                    resent[e.id] = (resent[e.id] ?? 0) + 1,
                onLongPress: (TimelineEntry e) =>
                    menus[e.id] = (menus[e.id] ?? 0) + 1,
                polishSkippedLabel: badge?.label(s),
                polishSkippedShortLabel: badge?.shortLabel(s),
                isFavorite: marks,
              ),
            );
          }
        }
      }
    }
    await mount(tester, tiles);
    String? id;
    for (final String candidate in ids) {
      final Finder icon = find.byKey(
        ValueKey<String>('entry.resend.icon.$candidate'),
      );
      if (find
          .descendant(of: cardOf(candidate), matching: icon)
          .evaluate()
          .isEmpty) {
        continue;
      }
      final (RenderMetaLines block, RenderBox top) = topOf(
        tester,
        candidate,
        icon,
      );
      // On the block's last line, so the transcript text is right below.
      if (block.lineOf(top) >= 0 && block.lineOf(top) == block.lineCount - 1) {
        id = candidate;
        break;
      }
    }
    expect(id, isNotNull, reason: 'no card paints the Resend icon last');
    final Finder icon = find.byKey(ValueKey<String>('entry.resend.icon.$id'));
    // Mid-screen, so every probe point below is on the screen.
    await Scrollable.ensureVisible(tester.element(icon), alignment: 0.5);
    await tester.pump();

    // Accessibility sees a 48 × 48 target.
    final Rect target = tester.getSemantics(icon).rect;
    expect(target.width, greaterThanOrEqualTo(48));
    expect(target.height, greaterThanOrEqualTo(48));

    // A tap on any painted neighbour inside the icon's 48 dp area, and on the
    // transcript text just below the meta block, does NOT resend: a Resend
    // re-types text on the computer. A tap on the block's empty space inside
    // that area does.
    final Rect drawn = tester.getRect(icon);
    expect(drawn.height, lessThan(40), reason: 'the icon itself stays small');
    final Rect area = Rect.fromCenter(
      center: drawn.center,
      width: 48,
      height: 48,
    );
    final (RenderMetaLines block, RenderBox iconTop) = topOf(tester, id!, icon);
    final Offset blockOrigin = block.localToGlobal(Offset.zero);
    final Rect blockRect = blockOrigin & block.size;
    final List<Rect> neighbours = <Rect>[];
    block.visitChildren((RenderObject o) {
      final RenderBox c = o as RenderBox;
      if (identical(c, iconTop) || block.lineOf(c) < 0) return;
      final Rect r =
          ((c.parentData! as BoxParentData).offset + blockOrigin) & c.size;
      if (r.overlaps(area)) neighbours.add(r);
    });
    expect(neighbours, isNotEmpty, reason: 'no neighbour inside the area');
    for (final Rect r in neighbours) {
      // Inside both the neighbour and the icon's area.
      await tester.tapAt(r.intersect(area).center);
      await tester.pump(const Duration(milliseconds: 300));
      expect(resent[id], isNull, reason: 'a tap on the neighbour at $r');
    }
    final Offset below = Offset(drawn.center.dx, blockRect.bottom + 8);
    expect(area.contains(below), isTrue, reason: 'pick a point in the area');
    await tester.tapAt(below);
    await tester.pump(const Duration(milliseconds: 300));
    expect(resent[id], isNull, reason: 'a tap on the transcript text');

    Offset? empty;
    for (double dy = -23; dy <= 23 && empty == null; dy += 1) {
      for (double dx = -23; dx <= 23; dx += 1) {
        final Offset p = drawn.center + Offset(dx, dy);
        if (!blockRect.contains(p) || drawn.contains(p)) continue;
        if (neighbours.any((Rect r) => r.contains(p))) continue;
        empty = p;
        break;
      }
    }
    expect(empty, isNotNull, reason: 'no empty space near the icon');
    await tester.tapAt(empty!);
    await tester.pump();
    expect(resent[id], 1, reason: 'a tap on empty space at $empty');

    // A long press on the icon opens the row's menu, and does not resend.
    await tester.longPress(icon);
    await tester.pump(const Duration(milliseconds: 300));
    expect(menus[id], 1);
    expect(resent[id], 1);
    semantics.dispose();
  });

  testWidgets('C7: in selection mode the reason sentence still says the row '
      'can be resent', (WidgetTester tester) async {
    final DateTime now = DateTime.now();
    TimelineEntry picture(String id) => TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      sourceText: 'photo.png',
      outputText: 'photo.png',
      status: EntryStatus.cached,
      createdAt: now.toUtc(),
      updatedAt: now.toUtc(),
      entryType: TimelineEntry.kImage,
      failureReason: 'INJECT_SECURE_INPUT_ACTIVE',
      cachedByVerdict: true,
      spokenToInstanceId: 'inst-1',
      spokenToInstanceName: kMetaPc,
    );
    await mount(tester, <Widget>[
      ChatMessageTile(
        entry: picture('free'),
        strings: s,
        queued: false,
        canResendImage: true,
        onRetry: (_) {},
      ),
      ChatMessageTile(
        entry: picture('selecting'),
        strings: s,
        queued: false,
        canResendImage: true,
        onRetry: (_) {},
        selected: false,
        onSelectToggle: () {},
      ),
    ]);
    String note(String id) => tester
        .widget<Text>(find.byKey(ValueKey<String>('entry.reasonNote.$id')))
        .data!;
    // Precondition: the free row offers Resend, the selecting one draws none.
    expect(
      find.byKey(const ValueKey<String>('entry.resend.free')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('entry.resend.selecting')),
      findsNothing,
    );
    expect(note('selecting'), note('free'));
  });
}
