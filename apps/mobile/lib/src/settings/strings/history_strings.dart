// AppStrings copy-catalogue shard: the full-history page / record reprocess
// (GA-13).
// The one external entry point is still ../app_strings.dart (AppStrings composes
// this mixin via `with`; from 0.2.67 on, the copy leaves `_lf…` are implemented
// by generated classes under l10n/; `_t` is only still in use at the few spots
// that **refused** migration — see the comment above `_t` in app_strings.dart
// for why).
part of '../app_strings.dart';

mixin HistoryStrings on AppStringsLeaves {
  String _t({
    required String zh,
    required String en,
    required String ja,
    required String ko,
  });

  // ── the full-history page + chat-page instance narrowing (V2-06b, requirement ④) ─
  String get historyTitle => _lfHistoryTitle;
  String get unknownInstance =>
      _lfUnknownInstance;
  String get historyEmpty =>
      _lfHistoryEmpty;
  // Hard requirement ④: a page called 「全部历史」 ("all history") must tell the
  // truth about how many rows it actually has stored.
  //
  // Before V2-06a-2 this said 「仅保留最近 100 条」 ("only the most recent 100
  // are kept") — back then `SharedPrefsTimelinePersistence.maxPersistedEntries`
  // really was 100, so that sentence was honest. Once SQLite landed and the cap
  // was lifted, the same sentence became a stale lie, so it was changed in the
  // same commit that lifted the cap.
  //
  // Now this sentence is **conditional**: the footnote states 「此刻真正在用哪
  // 个库」 ("which store is genuinely in use right now"), not a compile-time
  // baked-in assumption. If SQLite fails to open or a one-time import fails, it
  // falls back to the old 100-row-cap version — and in that case, still saying
  // 「全部历史都在本机」 ("all history is on this device") would be a literal
  // violation of that red line.
  String get historyAllPersisted => _lfHistoryAllPersisted;

  /// The footnote shown when it has fallen back to the old store. **States the
  /// fallback itself out loud** — saying only 「仅保留最近 100 条」 ("only the
  /// most recent 100 are kept") would let the user believe this is the normal
  /// design, rather than an upgrade that did not succeed.
  String get historyFallbackNote => _lfHistoryFallbackNote;
  // The narrowed view's honest empty state when not connected to any instance
  // — never populate it with another instance's history.
  String get chatHistoryNoInstance => _lfChatHistoryNoInstance;

  // ── V2-06b search and pagination ──────────────────────────────────────────
  String get historySearchHint =>
      _lfHistorySearchHint;
  String get historySearchClear =>
      _lfHistorySearchClear;

  /// No search results. **Must be a DIFFERENT sentence from 「还没有历史记录」**
  /// ("there is no history yet") — displaying 「搜不到」 ("couldn't find it")
  /// as 「没有历史」 ("no history") would make the user think their records
  /// were lost, which is this repo's most classic kind of false alarm.
  String get historySearchNoHit => _lfHistorySearchNoHit;

  /// The hit count. Search **asks the store**, it does not filter the already-
  /// loaded page, so this number is the true count across the whole database.
  String historySearchHits(int n) => _t(
    zh: '$n 条匹配',
    en: '$n match${n == 1 ? '' : 'es'}',
    ja: '$n 件一致',
    ko: '$n개 일치',
  );

  String get historyLoadingMore => _lfHistoryLoadingMore;

  /// Reached the end. Says so instead of letting the list silently stop —
  /// 「没有了」 ("nothing more") and 「还没加载」 ("not loaded yet") look
  /// identical on screen, and the user would read the former as the latter and
  /// keep waiting.
  String get historyReachedEnd => _lfHistoryReachedEnd;

  /// GA-13: the reprocess could not start — realtime mode (no LLM stage), or a
  /// row with no original words.
  ///
  /// ⚠️ CORRECTION (card F3, 2026-08-05): this doc used to end 「, or a run already in
  /// flight」. That third case had **no guard behind it** — `start` overwrote the
  /// live run instead of refusing it — so the sentence was a façade ④ claim about
  /// a branch that could not be reached. The guard exists now, and it has its own
  /// copy ([reprocessBusy]) because 「这条重跑不了」 ("this one can't be
  /// reprocessed") and 「等上一次跑完」 ("wait for the previous run to finish")
  /// send the user to different actions.
  String get reprocessUnavailable => _lfReprocessUnavailable;

  /// Card F3 defect ①: the press was refused because a run is already in flight.
  /// Nothing was touched and the running one keeps its own outcome — so the copy
  /// says 「稍后再试」 ("try again later") rather than anything about this row.
  String get reprocessBusy => _lfReprocessBusy;
}
