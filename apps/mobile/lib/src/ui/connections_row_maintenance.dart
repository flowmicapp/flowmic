// Part of connections_page.dart — ROW MAINTENANCE: the two things the person
// does TO a remembered PC's row rather than WITH it. Delete it (swipe), and
// rename its local display alias (long-press).
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// The same trigger, and the same shape, as connections_row_faces.dart and
// connections_row_cards.dart: connections_page.dart was at 789 of
// `verify/lint/file-size.mjs`'s SRC_MAX=800 and card APPLINK-2 needed to wire
// an incoming-link listener into this page (connections_pair_link.dart). The
// gate refused the wiring, so a family moved out — the precedent's own
// sentence: 「debt is not only a number, it is the sentence you cannot add」.
//
// 🔴 The cut is along「which question it answers」, not along line count. These
// two are the only members of this page that CHANGE a stored pairing rather
// than read, probe or enter one, and they share the one rule that governs
// that: a local change always happens (the user asked for it, and an
// unreachable PC has to be cleanable), and when the server could not be told,
// the page SAYS SO instead of implying it was.
// ⚠️ Do not read this split as an architectural statement:
// `_ConnectionsPageState` is still one class and the fields are all still over
// there; only the behaviour moved.
//
// 🔴 DIFF DISCIPLINE: both bodies were moved character-for-character from
// connections_page.dart, with only the one mechanical change this family
// always needs — they go from being `_ConnectionsPageState`'s instance methods
// to top-level functions, so they gain one leading `_ConnectionsPageState
// page` parameter, `widget.`/`mounted`/`context`/`_toast` in the body become
// `page.widget.`/`page.mounted`/`page.context`/`page._toast`, and the call
// sites are renamed to `*Routed`. Any difference beyond that is a bug.

part of 'connections_page.dart';

/// Swipe-to-delete a remembered PC.
///
/// v0.2.4 — the controller has told us since v0.2.3 whether the server was
/// actually reached (`mobile:unpair`), and NOTHING rendered it. The local
/// entry always goes (the user asked for it, and an unreachable PC has to be
/// cleanable), but when the server could not be told, that PC's device page
/// still lists this phone — and 「没做成的事不许说成做成了」("a thing that
/// wasn't done must not be said as done") applies to a
/// deletion exactly as it does to a delivery. So say it.
Future<void> _removeRouted(_ConnectionsPageState page, MobileSession p) async {
  await page.widget.connections.remove(p);
  if (!page.mounted || page.widget.connections.lastRemoveReachedServer) return;
  page._toast(
    AppStrings.of(page.widget.appSettings.locale).removeDidNotReachServer,
  );
}

/// Long-press a remembered PC → rename its local display alias. Blank input
/// (or 「恢复默认」("restore default")) clears the alias — storage already
/// treats null/blank as clear.
Future<void> _renameAliasRouted(
  _ConnectionsPageState page,
  MobileSession pairing,
) async {
  final AppStrings s = AppStrings.of(page.widget.appSettings.locale);
  final String prefill = pairing.displayAlias?.isNotEmpty == true
      ? pairing.displayAlias!
      : pairingDisplayName(pairing, fallback: 'PC');
  final String? result = await showDialog<String>(
    context: page.context,
    builder: (BuildContext ctx) => RenameAliasDialog(strings: s, initial: prefill),
  );
  if (result == null || !page.mounted) return;
  await page.widget.connections.setAlias(pairing, result);
}
