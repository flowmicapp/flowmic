// Work package 2, card 4, case A-5 — nine-locale rendering assertions for
// the article surface.
//
// SCOPE: the two strings on `ChatArticleTile` that are actually
// locale-dependent — `articleBadge` (the 「长程」-style chip) and
// `articleCardMeta` (the duration + segment-count line). The card's TITLE is
// never translated: it is the user's own spoken words
// (`ArticleSummary.titleFrom`), independent of the UI language, so it is not
// this case's subject.
//
// 🔴 EVERY CASE MOUNTS THE REAL SCREEN (`ChatFlowPage` → `entriesForOwners`),
// with `appSettings` wired so the page really reads its locale from there —
// same reason as `wp5_rendered_copy_legibility_test.dart` group C, which
// this file's mounting shape is copied from.
//
// ⚠️ Readability assertions land on the RENDERED RESULT
// (`support/legibility.dart`'s `expectLegible`, the repo's one shared
// instrument for this), never on `Text.data` alone — that is the 0.2.53 law
// article_screen_test.dart's header also points at. The Ahem-ruler caveat is
// the same as everywhere else this instrument is used: "not clipped under
// Ahem" implies "not clipped on a real device", not the converse.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/article_rig.dart';
import 'support/legibility.dart' show ahemWidthBudget, expectLegible;
import 'support/locale_terms.dart' show expectPerLocaleDistinct;

void main() {
  group('A-5: nine-locale rendering — the article surface', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets(
          '🔴 ${locale.name}: the card\'s badge and meta line render in this '
          'language, unclipped', (WidgetTester tester) async {
        final double width = ahemWidthBudget(locale);
        tester.view.physicalSize = Size(width * 3, 2400 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        SharedPreferences.setMockInitialValues(<String, Object>{});
        final SharedPreferences prefs = await SharedPreferences.getInstance();
        final AppSettingsController settings = AppSettingsController(prefs: prefs);
        addTearDown(settings.dispose);
        await settings.load();
        settings.setLocale(locale);

        final ArticleRig r = ArticleRig();
        addTearDown(r.dispose);
        await tester.runAsync(r.recordThreeAndStop);

        await tester.pumpWidget(
          MaterialApp(
            home: ChatFlowPage(controller: r.controller, appSettings: settings),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(ChatArticleTile), findsOneWidget,
            reason: 'setup error: no card to read this language\'s copy off');
        final ChatArticleTile card =
            tester.widget<ChatArticleTile>(find.byType(ChatArticleTile));
        final AppStrings s = AppStrings.of(locale);

        // ① Content — the badge really is THIS language's word, not zh
        // (page locale comes from `appSettings`, the string from
        // `AppStrings` — one crossed wiring is a Chinese chip on any other
        // UI language).
        final Finder badge = find.byKey(
          ValueKey<String>('entry.article.badge.${card.entry.id}'),
        );
        expect(
          tester.widget<Text>(badge).data,
          s.articleBadge,
          reason: '${locale.name}: the article badge chip is not this '
              'language\'s word',
        );
        // ② Render. 🔴 `expectLegible`'s no-maxLines branch does NOT apply
        // here, and asserting it would be asserting the wrong thing: the
        // badge sits as a bare (non-`Expanded`) child of a `Row` beside the
        // title's `Expanded` (chat_article_tile.dart), so it is laid out at
        // an UNBOUNDED width by construction — `expectLegible` measured
        // while writing this case: "this text was laid out at infinite
        // width" on EVERY locale, zh included, which is the instrument
        // correctly refusing to answer a question this box structurally
        // cannot ask (support/legibility.dart's own guard against exactly
        // this). Same shape as `wp5_rendered_copy_legibility_test.dart`
        // group C's "恢复原文" button (also a bare Row/Align child) — that
        // file's fix is copied here: assert the box's RIGHT EDGE stays
        // inside the card, which is what a real overflow (a wide
        // translated word) would actually violate.
        final Rect cardRect = tester.getRect(find.byType(ChatArticleTile));
        final Rect badgeRect = tester.getRect(badge);
        expect(badgeRect.width, greaterThan(0),
            reason: '${locale.name}: the badge was never painted at all');
        expect(
          badgeRect.right,
          lessThanOrEqualTo(cardRect.right),
          reason: '${locale.name}: 「${s.articleBadge}」 was squeezed off the '
              'right of the card — the chip is the ONE signal that survives '
              'a user who cannot tell the card apart from a message by '
              'colour alone (chat_article_tile.dart\'s own header)',
        );

        // ③ The meta line (duration + segment count) — `maxLines: 1` +
        // ellipsis, so this is the real `didExceedMaxLines` reading.
        final Finder meta = find.byKey(
          ValueKey<String>('entry.article.meta.${card.entry.id}'),
        );
        expectLegible(tester, meta, reason: '${locale.name} article card meta line');

        // ④ The title — untranslated by design (it is the user's own
        // words), so only its RENDER is this case's business: it must not
        // overflow the card regardless of which language is chosen for the
        // chip beside it (a wide badge in a wide language could squeeze it).
        final Finder title = find.byKey(
          ValueKey<String>('entry.article.title.${card.entry.id}'),
        );
        expectLegible(tester, title, reason: '${locale.name} article title (untranslated)');

        expect(tester.takeException(), isNull,
            reason: '${locale.name}: the article card overflowed at this width');
      });
    }

    test('🔴 articleBadge is a real per-language translation across all nine '
        'locales, not a copy', () {
      // Same instrument as wp5_rendered_copy_legibility_test.dart's own
      // i18n-copy-paste guard — see support/locale_terms.dart for why a
      // named `mayShare` beats a bare pairwise-distinct count once there are
      // nine locales (legitimate collisions exist and are not failures).
      expectPerLocaleDistinct(
        (AppStrings s) => s.articleBadge,
        what: 'articleBadge',
      );
    });
  });
}
