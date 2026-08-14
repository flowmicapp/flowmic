// AppStrings copy-catalogue shard: the 「+」 panel / favourite phrases.
// The one external entry point is still ../app_strings.dart (AppStrings composes
// this mixin via `with`; from 0.2.67 on, the copy leaves `_lf…` are implemented
// by generated classes under l10n/ — this shard keeps only logic and
// argumentative comments).
part of '../app_strings.dart';

mixin FavoritesStrings on AppStringsLeaves {

  // ── the 「+」 panel + Favorites (R6 T-3b ②③ / §6.1 / F-5) ──────────────────
  String get plusPanelTitle => _lfPlusPanelTitle;
  String get favorites => _lfFavorites;

  /// The cap is F-5's own 50 — deliberately not the 100 of custom terminology
  /// (自定义术语, D6).
  String favoritesCounter(int n, int max) => '$n / $max';
  String get favoritesSaveBuffer =>
      _lfFavoritesSaveBuffer;

  /// W2.5-E: why 「存入当前缓冲」 ("save current buffer") is inert while an AI compose run is streaming into
  /// the buffer. A favourite is PERMANENT and its later tap-to-send
  /// (点选即发) runs through
  /// `ChatController.sendFavorite` → `ManualDelivery.deliverText`, which does
  /// NOT re-check compose state — so a half-written model output saved here is
  /// deliverable forever. The button therefore states the wait rather than
  /// going quietly grey.
  ///
  /// 🔴 Names no task (polish/organize/translate — 润色/整理/翻译): the panel
  /// is handed one bool, not the
  /// live [ComposeTask], and copy that named a task would be a second answer to
  /// 「哪个操作在跑」 ("which operation is running") whose only source is a
  /// value this widget does not hold.
  String get favoritesSaveBlockedAiComposing => _lfFavoritesSaveBlockedAiComposing;
  String get favoritesEmpty => _lfFavoritesEmpty;
  String get favoritesEmptyHint => _lfFavoritesEmptyHint;
  String get favoritesTapToSend => _lfFavoritesTapToSend;
  String get favoritesRemove => _lfFavoritesRemove;
  String get favoriteAdd => _lfFavoriteAdd;

  /// Feedback for 「存入当前缓冲」 ("save current buffer") / 「转常用」 ("turn
  /// into a favourite") — never a silent no-op.
  String favoriteAddResult(FavoriteAddOutcome outcome) {
    switch (outcome) {
      case FavoriteAddOutcome.added:
        return _lfFavoriteAddResult__1;
      case FavoriteAddOutcome.refreshed:
        return _lfFavoriteAddResult__2;
      case FavoriteAddOutcome.empty:
        return _lfFavoriteAddResult__3;
    }
  }

  /// §6.2-6: Notes has no PC focus window, so the panel offers no
  /// injection-type action there. It says why instead of showing a live-looking
  /// button that could only fail.
  String get favoritesNoPcTarget => _lfFavoritesNoPcTarget;
}
