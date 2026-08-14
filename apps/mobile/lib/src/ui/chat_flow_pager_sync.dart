// Keeping the owner-scoped pager pointed at the RIGHT SET OF ROWS.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason and same shape as chat_flow_exits.dart / chat_flow_composer.dart
// / chat_flow_entry_actions.dart / chat_flow_selection.dart: `chat_flow_page.dart`
// stood at exactly 800/800 against `verify/lint/file-size.mjs` SRC_MAX when
// REQ-12-02 needed to thread one more callback through the page, and the repo's
// standing move at that cap is a STRUCTURAL SPLIT, never deleting the evidence
// in the comments (CLAUDE.md, 0.2.52: "do a structural split per the repo's
// established precedent, rather than delete the evidence" 「按仓里成例做结构
// 拆分而不是删证据」).
//
// 🔴 DIFF DISCIPLINE: all three bodies below are the previous methods moved
// VERBATIM — not one comment reflowed, not one identifier renamed. The page
// keeps a one-line delegator for each, so every call site (initState listeners,
// dispose, build) is exactly where it was. **Any other difference in the diff
// is a bug.**
//
// ── WHY THESE THREE AND NOT SOME OTHER THREE ─────────────────────────────
// They are one family: every one of them answers 「does the pager still describe
// the rows this screen is supposed to show」. `_syncPagerOwners` widens the set
// when the identity does, `_syncPagerOwnersDeferred` is the same call made safe
// to issue from `build`, and `_onStoreChanged` catches the other direction —
// rows disappearing underneath a page that already loaded them. Move one
// without the others and the next reader has to find the remaining two before
// any of the three makes sense.

part of 'chat_flow_page.dart';

/// 🔴 Requirement ④ / F2 — the owner SET this screen shows.
///
/// Card F2 (2026-08-05) ruling ④: the set is now every pairing instance id of the
/// SAME physical computer, built once per connection by [SessionScope]
/// (session/machine_key.dart) and read from there — the pager, the SQL
/// predicate (`owner IN (…)`) and the scroll trigger already spoke in sets.
///
/// An empty scope is an EMPTY set, never "everyone": legacy/unowned rows
/// belong to no instance and stay in "all history" as "unknown instance".
///
/// Subscribed to [SessionScope] in [initState] because the set WIDENS
/// asynchronously (narrow first, then the pairing list); without the listener
/// the wider set would land only on the next unrelated rebuild.
void _syncPagerOwnersRouted(_ChatFlowPageState s) {
  unawaited(s._pager.setOwners(s.controller.session.scope.ownerIds));
}

/// Same intent as [_syncPagerOwnersRouted], safe to call from `build`.
///
/// 🔴 [OwnerTimelinePager.setOwners] notifies, and this page LISTENS to the
/// pager — calling it inside `build` would be `markNeedsBuild` during build.
/// The comparison is free, so the deferral only happens on the frame where
/// the connected identity actually changed.
void _syncPagerOwnersDeferredRouted(_ChatFlowPageState s) {
  final Set<String> want = s.controller.session.scope.ownerIds;
  if (setEquals(s._pager.owners, want)) return;
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (s.mounted) s._syncPagerOwners();
  });
}

void _onStoreChangedRouted(_ChatFlowPageState s) {
  final int now = s.controller.store.entries.length;
  final int was = s._lastStoreCount;
  s._lastStoreCount = now;
  if (now < was) unawaited(s._pager.resync());
}
