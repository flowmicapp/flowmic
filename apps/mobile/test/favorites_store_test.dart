// R6 T-3b ③ acceptance — F-5 Favorites (常用).
//
// SPEC-REF: docs/ui-design/REDESIGN-PLAN.md §2 F-5 (local ≤50 「最老裁剪」 /
//   save current buffer / history row → favorite / tap-to-send / exact match
//   with history shows ⭐), §6.4 (F-5's 50 and custom-terms' 100 are two
//   separate caps); docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-3 ③.
//
// Storage is shared_preferences (the repo's existing device-local pref family),
// NOT Hive as F-5's prose says — see local_prefs.dart kFavoritesKey for why.

import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('newest-first ordering: the most recently saved phrase is on top', () async {
    final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
    await f.add('一');
    await f.add('二');
    await f.add('三');
    expect(f.items, <String>['三', '二', '一']);
  });

  test('cap 50 with 「最老裁剪」: the 51st save drops the OLDEST, never the new one',
      () async {
    final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
    for (int i = 0; i < kFavoritesMax; i++) {
      await f.add('phrase-$i');
    }
    expect(f.length, kFavoritesMax);
    expect(f.items.last, 'phrase-0');

    await f.add('the-newest');
    expect(f.length, kFavoritesMax, reason: 'the cap is hard');
    expect(f.items.first, 'the-newest');
    expect(f.contains('phrase-0'), isFalse, reason: 'oldest is the one cut');
    expect(f.contains('phrase-1'), isTrue);
  });

  test('dedupe: re-adding an existing phrase refreshes its recency instead of '
      'stacking a second identical button', () async {
    final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
    await f.add('甲');
    await f.add('乙');
    expect(await f.add('甲'), FavoriteAddOutcome.refreshed);
    expect(f.items, <String>['甲', '乙']);
    expect(f.length, 2);
  });

  test('add trims once on the way in, and blank input is reported rather than '
      'silently stored', () async {
    final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
    expect(await f.add('  有空格  '), FavoriteAddOutcome.added);
    expect(f.items, <String>['有空格']);
    expect(await f.add('   '), FavoriteAddOutcome.empty);
    expect(await f.add(''), FavoriteAddOutcome.empty);
    expect(f.length, 1);
  });

  test('contains is an EXACT match — a merely similar history row gets no ⭐',
      () async {
    final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
    await f.add('收到，我稍后回复你');
    expect(f.contains('收到，我稍后回复你'), isTrue);
    expect(f.contains('收到，我稍后回复你。'), isFalse);
    expect(f.contains('收到'), isFalse);
    expect(f.contains(' 收到，我稍后回复你'), isFalse);
  });

  test('remove drops exactly one phrase; removing an absent one is a no-op',
      () async {
    final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
    await f.add('甲');
    await f.add('乙');
    expect(await f.remove('甲'), isTrue);
    expect(f.items, <String>['乙']);
    expect(await f.remove('不存在'), isFalse);
    expect(f.items, <String>['乙']);
  });

  test('round-trips through local prefs: what was saved is what loads back',
      () async {
    final InMemoryLocalPrefs prefs = InMemoryLocalPrefs();
    final FavoritesStore a = FavoritesStore(prefs: prefs);
    await a.add('第一条');
    await a.add('第二条');

    final FavoritesStore b = FavoritesStore(prefs: prefs);
    expect(b.isEmpty, isTrue, reason: 'un-hydrated store is simply empty');
    await b.load();
    expect(b.items, <String>['第二条', '第一条']);
  });

  test('a stored list written by another build cannot seed state the class '
      'forbids: blanks / duplicates / overflow are normalised on load', () async {
    final InMemoryLocalPrefs prefs = InMemoryLocalPrefs(
      favorites: <String>[
        '甲',
        '  ',
        '甲',
        ' 乙 ',
        for (int i = 0; i < 60; i++) 'filler-$i',
      ],
    );
    final FavoritesStore f = FavoritesStore(prefs: prefs);
    await f.load();
    expect(f.length, kFavoritesMax);
    expect(f.items.take(3), <String>['甲', '乙', 'filler-0']);
    expect(f.items.where((String s) => s == '甲').length, 1);
    expect(f.contains('  '), isFalse);
  });

  test('notifies listeners on every mutation (the ⭐ markers and the panel share '
      'one source)', () async {
    final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
    int notifications = 0;
    f.addListener(() => notifications++);
    await f.add('甲');
    await f.add('甲'); // refresh still moves the list
    await f.remove('甲');
    await f.load();
    expect(notifications, 4);
  });
}
