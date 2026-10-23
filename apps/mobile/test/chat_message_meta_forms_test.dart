// CARD-UI — the shorter forms keep the full words and the action.
//
// When a card's meta lines cannot hold a word, the polish mark switches to its
// short wording and Resend / the edited mark to their icon forms
// (chat_message_meta.dart). This file mounts the chat-page cards of one tight
// cell (ru, 360 dp, text size 1.15), finds a card where each short form is
// actually painted, and checks that nothing was lost with it: a screen reader
// reads the FULL polish label and the words for Resend / Edited, a tap on the
// short polish mark shows the full label, and the Resend icon still resends.
//
// Reverse control (2026-10-14): with the short mark's full-label semantics
// switched off (`when false` in status_badge_widgets.dart, marker
// RC-REVERT), `flutter test test/chat_message_meta_forms_test.dart` read
// `Expected: has semantics with label: Доводка не применена · сырой текст`
// and `+0 -1`; restored ⇒ `+1: All tests passed!`, RC-REVERT grep=0.

import 'package:flowmic/src/session/polish_badge.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
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

void main() {
  setUpAll(() async {
    await loadRealLatinFace();
    await loadSquareFallbackFace();
  });

  testWidgets('short polish label, Resend icon and edited icon keep their '
      'words and their action', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(360, 200000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final SemanticsHandle semantics = tester.ensureSemantics();
    const AppLocale locale = AppLocale.ru;
    final AppSettingsController settings = await metaSettings(
      locale,
      AppTextScale.xlarge,
    );
    addTearDown(settings.dispose);
    final AppStrings s = AppStrings.of(locale);
    final DateTime now = DateTime.now();
    final Map<String, int> resent = <String, int>{};
    final Map<String, PolishBadge> badges = <String, PolishBadge>{};
    final List<Widget> tiles = <Widget>[];
    for (final MetaRow row in metaRows(now)) {
      for (final PolishBadge badge in PolishBadge.values) {
        for (final bool extras in <bool>[false, true]) {
          final String id = '${row.id}-${badge.name}-$extras';
          badges[id] = badge;
          final TimelineEntry entry = row.build(
            id: id,
            createdAt: MetaStamp.thisYear.at(now),
            edited: true,
          );
          tiles.add(
            ChatMessageTile(
              entry: entry,
              strings: s,
              queued: row.queued,
              canResendImage: false,
              onRetry: (TimelineEntry e) =>
                  resent[e.id] = (resent[e.id] ?? 0) + 1,
              polishSkippedLabel: badge.label(s),
              polishSkippedShortLabel: badge.shortLabel(s),
              isFavorite: extras,
              selected: extras,
              onSelectToggle: extras ? () {} : null,
            ),
          );
        }
      }
    }
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

    // The painted form of the two-form item whose full child is [full].
    MetaForm? paintedForm(Finder within, Finder part) {
      final Finder f = find.descendant(of: within, matching: part);
      if (f.evaluate().isEmpty) return null;
      final RenderMetaLines block = tester.renderObject<RenderMetaLines>(
        find.descendant(of: within, matching: find.byType(MetaLines)),
      );
      RenderObject cur = tester.renderObject(f.first);
      while (!identical(cur.parent, block)) {
        cur = cur.parent!;
      }
      final RenderBox top = cur as RenderBox;
      return block.lineOf(top) >= 0 ? block.formOf(top) : null;
    }

    String? polishShortId;
    String? resendIconId;
    String? editedIconId;
    for (final String id in badges.keys) {
      final Finder card = find.byWidgetPredicate(
        (Widget w) => w is ChatMessageTile && w.entry.id == id,
      );
      final PolishBadge b = badges[id]!;
      polishShortId ??=
          find
                  .descendant(of: card, matching: find.text(b.shortLabel(s)))
                  .evaluate()
                  .isNotEmpty &&
              b.shortLabel(s) != b.label(s) &&
              paintedForm(card, find.text(b.shortLabel(s))) == MetaForm.compact
          ? id
          : null;
      resendIconId ??=
          paintedForm(
                card,
                find.byKey(ValueKey<String>('entry.resend.icon.$id')),
              ) ==
              MetaForm.compact
          ? id
          : null;
      editedIconId ??=
          paintedForm(
                card,
                find.byKey(ValueKey<String>('entry.edited.icon.$id')),
              ) ==
              MetaForm.compact
          ? id
          : null;
    }
    // Precondition: this tight cell does use all three short forms (if a
    // copy change makes room everywhere, pick a tighter cell).
    expect(polishShortId, isNotNull, reason: 'no card shows a short polish');
    expect(resendIconId, isNotNull, reason: 'no card shows the Resend icon');
    expect(editedIconId, isNotNull, reason: 'no card shows the edited icon');

    // A screen reader hears the full words.
    final PolishBadge b = badges[polishShortId]!;
    final Finder shortMark = find.descendant(
      of: find.byWidgetPredicate(
        (Widget w) => w is ChatMessageTile && w.entry.id == polishShortId,
      ),
      matching: find.text(b.shortLabel(s)),
    );
    expect(tester.getSemantics(shortMark), matchesSemantics(label: b.label(s)));
    final Finder resendIcon = find.byKey(
      ValueKey<String>('entry.resend.icon.$resendIconId'),
    );
    expect(
      tester.getSemantics(resendIcon),
      matchesSemantics(
        label: s.resendAction,
        isButton: true,
        hasTapAction: true,
      ),
    );
    expect(
      tester.getSemantics(
        find.byKey(ValueKey<String>('entry.edited.icon.$editedIconId')),
      ),
      matchesSemantics(label: s.editedMark),
    );
    // The face of the Resend card is one the row offers Resend on.
    expect(
      deliveryFaceOf(
        tester
            .widget<ChatMessageTile>(
              find.byWidgetPredicate(
                (Widget w) =>
                    w is ChatMessageTile && w.entry.id == resendIconId,
              ),
            )
            .entry,
        queued: false,
      ),
      isNot(DeliveryFace.injected),
    );

    // A tap on the short mark shows the full label.
    await tester.ensureVisible(shortMark);
    final int before = find.text(b.label(s)).evaluate().length;
    await tester.tap(shortMark);
    await tester.pump(const Duration(milliseconds: 300));
    // One more copy of the full label: the tooltip's.
    expect(find.text(b.label(s)).evaluate().length, before + 1);
    expect(
      find.descendant(
        of: find.byType(Overlay),
        matching: find.text(b.label(s)),
      ),
      findsWidgets,
    );
    await tester.pump(const Duration(seconds: 3));

    // The Resend icon resends.
    await tester.ensureVisible(resendIcon);
    await tester.tap(resendIcon);
    await tester.pump();
    expect(resent[resendIconId], 1);
    semantics.dispose();
  });
}
