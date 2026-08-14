// REQ-12-09 09-B/09-C — the 「+」 panel's light-records tab: the three states and the
// search box.
//
// SPEC-REF: docs/strategy/2026-08-12-req1209-plus-panel-design.md
//   §3-3 (the three states kept separate, one state one sentence), §5-1
//   (typing queries storage directly, not an in-memory filter), §4-1 (read-only projection).
//
// ── ITS OWN FILE, AND WHY ────────────────────────────────────────────────────
// plus_panel.dart was 614 of the 800-line src cap before this card; the tab
// below is ~200 lines of state machine. Splitting now, rather than under the
// pressure of the edit after this one, follows the precedent already set twice
// in this tree (timeline_sqlite_schema.dart, ptt_wire_keepalive.dart). Nothing
// was moved — every line here is new.
//
// ⚠️ THE PARAGRAPH BELOW WAS TRUE WHEN IT WAS WRITTEN (09-A/B/C, 2026-08-12) AND
// IS KEPT VERBATIM. The rulings it was waiting for arrived the same day
// (docs/decisions/2026-08-12-owner-req1209-multiselect-and-image-rulings.md) and
// 09-D/F/G/J landed; the correction is under it. Kept rather than rewritten
// because the RULE it states is still the rule — what changed is only which side
// of it this tab is on.
//
//   「🔴 READ-ONLY, DELIBERATELY. This card ships 09-A/B/C only: a user can open
//    the tab, see their notes and search them. Multi-select and send-from-notes
//    are 09-D/09-F and wait on owner rulings that have not arrived (design §6,
//    §9-1). So the rows are NOT tappable — there is no InkWell, no ripple, no
//    selection affordance. A row that looks tappable and does nothing is the
//    single worst affordance this project keeps re-learning (plus_panel.dart's
//    own header), and the honest shape of 「not done yet」 is 「that control doesn't exist yet」, never a
//    dead one.」
//
// 🔴 THE CORRECTION (09-D/09-G). Rows are selectable NOW — but only when the
// panel handed this tab a [selection], and a PICTURE row only when its original
// bytes are actually on this phone. The rule above is what decides both:
//   · no selection wired ⇒ no tick box is drawn at all, exactly as before;
//   · a picture whose bytes were never written (every light-note picture from
//     before the 09-I fix) gets NO box either — it gets the REASON, standing in
//     the box's own place. That is the `_originalUnavailable` precedent from
//     plus_panel.dart, and the point is the same one this paragraph already
//     made: 「a box you can see but never tick」 is the affordance R8 forbids.

import 'dart:async';

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../timeline/cloud/light_record_query.dart';
import '../timeline/timeline_entry.dart';
import 'plus_panel_selection.dart';
import 'tokens.dart';

/// 09-C — how long the box waits after the last keystroke before asking the
/// disk. ASSUMPTION (design §5-1): owner specified no number. 250 ms is the
/// usual floor for「typing stopped」without making the list feel laggy; it is a
/// single constant precisely so a ruling can move it in one place.
const Duration kLightRecordSearchDebounce = Duration(milliseconds: 250);

class PlusPanelNotesTab extends StatefulWidget {
  const PlusPanelNotesTab({
    super.key,
    required this.strings,
    required this.query,
    required this.isSignedIn,
    this.onSignIn,
    this.selection,
    this.imageSendable,
  }) : assert(
         selection == null || imageSendable != null,
         'REQ-12-09 09-G: see PlusPanel\'s own assert — a tick box over a '
         'picture row whose bytes may not exist has to KNOW, not guess.',
       );

  final AppStrings strings;

  /// The read. Read-only by construction — see [LightRecordQuery].
  final LightRecordQuery query;

  /// 🔴 A GETTER, NOT A BOOL, and that is the one snapshot this card refused to
  /// inherit. Every other value the panel holds (`buffer` / `noPcTarget` /
  /// `aiComposing`) is frozen at open time because nothing inside the sheet can
  /// change it. This one CAN change inside the sheet — state A offers a sign-in
  /// entry point — so freezing it would leave the panel telling the user to sign
  /// in immediately after they did. Same shape as `bearer: () => _login.jwt` in
  /// main.dart: one source of truth, asked rather than copied.
  final bool Function() isSignedIn;

  /// Opens the sign-in sheet; resolves when it closes. Null ⇒ state A states the
  /// fact and offers no button, rather than drawing one that goes nowhere.
  final Future<void> Function()? onSignIn;

  /// 09-D — the panel's tick set, shared with the frequently-used list. Null ⇒ this tab is
  /// read-only (see the correction in the header).
  final PlusPanelSelection? selection;

  /// 09-G — 「are this row's original-image bytes still there」. Asked once per picture row when the list
  /// loads, never per frame.
  final Future<bool> Function(TimelineEntry entry)? imageSendable;

  @override
  State<PlusPanelNotesTab> createState() => _PlusPanelNotesTabState();
}

class _PlusPanelNotesTabState extends State<PlusPanelNotesTab> {
  final TextEditingController _search = TextEditingController();

  /// Everything on disk. The list shown when the box is empty.
  List<TimelineEntry> _notes = const <TimelineEntry>[];

  /// The current search's hits, or null when no search is running (the box is
  /// empty). 🔴 Null and empty are different answers — empty means 「searched,
  /// found nothing」
  /// and gets its own sentence.
  List<TimelineEntry>? _hits;

  bool _loading = true;
  Timer? _debounce;

  /// 09-G — row id → 「are the original-image bytes on this phone」, for picture rows only.
  ///
  /// 🔴 A MAP THAT IS FILLED ONCE PER ROW, not a `FutureBuilder` per frame. The
  /// probe is three `File.exists` calls (`OutboxBlobStore.pathFor`), which is
  /// nothing once and is a filesystem hit per repaint if it is asked from
  /// `build`. A row missing from this map has NOT been probed yet, which is a
  /// third state and is rendered as neither 「tickable」 nor 「no original image」 — see [_row].
  final Map<String, bool> _imageHasBytes = <String, bool>{};

  /// Guards a slow query resolving after a newer one. Without it, deleting the
  /// last character can leave the previous word's hits on screen — a list that
  /// disagrees with the box above it.
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _search.addListener(_onQueryChanged);
    unawaited(_reload());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    final int mine = ++_seq;
    if (!_loading) setState(() => _loading = true);
    final List<TimelineEntry> rows = await widget.query.all();
    if (!mounted || mine != _seq) return;
    setState(() {
      _notes = rows;
      _loading = false;
    });
    await _probeImages(rows);
    // A reload while a word is typed must not drop back to the full list.
    if (_search.text.trim().isNotEmpty) await _runSearch(_search.text);
  }

  /// 09-G — ask, once, which picture rows still have their bytes.
  ///
  /// Only picture rows are probed (a transcript row has no picture and asking
  /// would be three pointless `File.exists`), and only rows not already
  /// answered — so switching tabs or re-running a search re-asks nothing.
  Future<void> _probeImages(List<TimelineEntry> rows) async {
    final Future<bool> Function(TimelineEntry)? probe = widget.imageSendable;
    if (probe == null) return;
    final List<TimelineEntry> todo = <TimelineEntry>[
      for (final TimelineEntry e in rows)
        if (e.isImage && !_imageHasBytes.containsKey(e.id)) e,
    ];
    if (todo.isEmpty) return;
    for (final TimelineEntry e in todo) {
      _imageHasBytes[e.id] = await probe(e);
    }
    if (mounted) setState(() {});
  }

  void _onQueryChanged() {
    _debounce?.cancel();
    final String q = _search.text;
    if (q.trim().isEmpty) {
      // Clearing the box is not a search — it is 「back to everything」, and it is instant
      // because there is nothing to ask.
      setState(() => _hits = null);
      return;
    }
    _debounce = Timer(kLightRecordSearchDebounce, () => unawaited(_runSearch(q)));
  }

  /// 🔴 Asks STORAGE, never [_notes] and never the rendered list.
  ///
  /// `TimelineStore.search`'s own doc is the argument, verbatim: filtering a
  /// loaded list searches 「only the ones the user has scrolled to」 and silently misses everything above
  /// — 「a search box that finds less the less you have scrolled」. Here the list
  /// is not even paginated yet, so filtering [_notes] would be correct TODAY and
  /// would quietly become wrong the day paging arrives. Pinned by
  /// `plus_panel_notes_tab_test.dart`「a note deep in history is found without
  /// scrolling first」.
  Future<void> _runSearch(String q) async {
    final int mine = ++_seq;
    final List<TimelineEntry> hits = await widget.query.search(q);
    if (!mounted || mine != _seq) return;
    setState(() => _hits = hits);
    // Hits are a subset of [all] today, so this normally probes nothing. It is
    // here because that containment is a property of LightRecordQuery, not of
    // this widget — and a row rendered without a probe would draw the third
    // state (see [_row]) rather than silently guess.
    await _probeImages(hits);
  }

  Future<void> _signIn() async {
    final Future<void> Function()? open = widget.onSignIn;
    if (open == null) return;
    await open();
    if (!mounted) return;
    // Re-read the disk: a fresh sign-in can pull this account's rows down, and
    // `isSignedIn()` is asked again on the next build anyway.
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    if (_loading) return _line(s.lightRecordsLoading, FlowMicColors.t3);

    final bool signedIn = widget.isSignedIn();

    // ── State A: signed out AND nothing on this phone ────────────────────────
    if (!signedIn && _notes.isEmpty) {
      return Padding(
        key: const ValueKey<String>('plus.notes.state.signedOutEmpty'),
        padding: const EdgeInsets.symmetric(vertical: 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              s.lightRecordsSignedOutEmpty,
              style: TextStyle(color: FlowMicColors.t2, fontSize: 12.5),
            ),
            if (widget.onSignIn != null) ...<Widget>[
              const SizedBox(height: 12),
              _signInButton(s),
            ],
          ],
        ),
      );
    }

    // ── State B / C: there are rows, or there are none and we are signed in ──
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        // 🔴 State B's bound on what the list below claims. Signed in ⇒ nothing
        // extra is said (design §3-3 state C: 「list as usual, no extra words」).
        if (!signedIn)
          Padding(
            key: const ValueKey<String>('plus.notes.state.signedOutNotice'),
            padding: const EdgeInsets.only(bottom: 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(Icons.info_outline, size: 14, color: FlowMicColors.t3),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    s.lightRecordsSignedOutNotice,
                    style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
                  ),
                ),
              ],
            ),
          ),
        // A search box over zero rows is a control that cannot do anything, so
        // it is absent rather than inert.
        if (_notes.isNotEmpty) ...<Widget>[
          _searchBox(s),
          const SizedBox(height: 8),
        ],
        Flexible(child: _list(s)),
      ],
    );
  }

  Widget _signInButton(AppStrings s) => InkWell(
    key: const ValueKey<String>('plus.notes.signin'),
    onTap: () => unawaited(_signIn()),
    borderRadius: BorderRadius.circular(9),
    child: Container(
      height: 32,
      padding: const EdgeInsets.symmetric(horizontal: 13),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: FlowMicColors.brandSoft,
        borderRadius: BorderRadius.circular(9),
        // Same alpha over the TOKEN, following settings_widgets.dart:110 —
        // dark stays pixel-identical, light follows brand instead of freezing
        // at indigo-400.
        border: Border.all(color: FlowMicColors.brand.withValues(alpha: 0.4)),
      ),
      // The app's ONE spelling of this action (CloudStrings.signInCloud), not a
      // second sentence meaning the same thing.
      child: Text(
        s.signInCloud,
        style: TextStyle(
          color: FlowMicColors.brand,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
  );

  Widget _searchBox(AppStrings s) => SizedBox(
    height: 34,
    child: TextField(
      key: const ValueKey<String>('plus.notes.search'),
      controller: _search,
      style: TextStyle(color: FlowMicColors.t1, fontSize: 12.5),
      decoration: InputDecoration(
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        hintText: s.lightRecordsSearchHint,
        hintStyle: TextStyle(color: FlowMicColors.t3, fontSize: 12.5),
        prefixIcon: Icon(Icons.search, size: 16, color: FlowMicColors.t3),
        prefixIconConstraints: const BoxConstraints(minWidth: 30, minHeight: 30),
        filled: true,
        fillColor: FlowMicColors.surface2,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(9),
          borderSide: BorderSide(color: FlowMicColors.line),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(9),
          borderSide: BorderSide(color: FlowMicColors.line),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(9),
          borderSide: BorderSide(color: FlowMicColors.brand),
        ),
      ),
    ),
  );

  Widget _list(AppStrings s) {
    final List<TimelineEntry>? hits = _hits;
    final List<TimelineEntry> rows = hits ?? _notes;
    if (rows.isEmpty) {
      // Which emptiness this is matters: 「you have no light records」 and 「this word found nothing」 lead
      // to different next moves, so they are different sentences.
      return _line(
        hits == null ? s.lightRecordsEmpty : s.lightRecordsSearchNoMatch,
        FlowMicColors.t2,
        key: ValueKey<String>(
          hits == null ? 'plus.notes.empty' : 'plus.notes.noMatch',
        ),
      );
    }
    return ListView.builder(
      key: const ValueKey<String>('plus.notes.list'),
      shrinkWrap: true,
      itemCount: rows.length,
      itemBuilder: (BuildContext context, int i) => _row(rows[i]),
    );
  }

  /// One note.
  ///
  /// ⚠️ A picture note renders its LABEL (`🖼 PNG · 214 KB`), because that is
  /// what the row's text actually is: `image_send_controller.dart` writes the
  /// label as the row's text and keeps only a bounded thumbnail. This is
  /// existing behaviour surfaced, not introduced (design §5-3 note 2) — and it
  /// is why searching 「PNG」 finds pictures.
  ///
  /// 🔴 09-G — A PICTURE ROW HAS THREE STATES HERE, NOT TWO:
  ///   · bytes present  ⇒ a real tick box;
  ///   · bytes ABSENT   ⇒ no box, and [AppStrings.lightRecordImageNoOriginal]
  ///     under the label with a muted mark standing where the box would be.
  ///     Those bytes were never written (RV-93) — they are not late, so the
  ///     sentence says nothing about trying again;
  ///   · not probed yet ⇒ neither. Drawing the refusal before the answer is in
  ///     would state 「cannot be sent to the computer」 about a picture that
  ///     can perfectly well go;
  ///     drawing a box would offer a tick that might only fail. So the row
  ///     simply has no control for the instant the probe is in flight, which is
  ///     the same 「say nothing when unsure」 the loading line above uses.
  Widget _row(TimelineEntry e) {
    final PlusPanelSelection? sel = widget.selection;
    // Three states, and the third is 「hasn't been asked yet」 — see the doc above.
    final bool? hasBytes = e.isImage ? _imageHasBytes[e.id] : true;
    final bool tickable = sel != null && hasBytes == true;
    final bool refused = sel != null && e.isImage && hasBytes == false;
    final bool ticked = tickable && sel.contains(PlusPick.keyForNote(e));
    final Widget body = Padding(
          padding: const EdgeInsets.symmetric(vertical: 11),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (tickable) ...<Widget>[
                Icon(
                  ticked
                      ? Icons.check_box_outlined
                      : Icons.check_box_outline_blank,
                  size: 17,
                  color: ticked ? FlowMicColors.brand : FlowMicColors.t3,
                ),
                const SizedBox(width: 8),
              ] else if (refused) ...<Widget>[
                // The `_originalUnavailable` precedent (plus_panel.dart), fitted
                // to a list row: the mark takes the box's place and the sentence
                // goes directly under the label, because a full sentence does
                // not fit in a 17 px column at 360 dp. Both halves are still on
                // screen without a tap, which is what that precedent is for.
                Icon(Icons.info_outline, size: 15, color: FlowMicColors.t3),
                const SizedBox(width: 8),
              ],
              Icon(
                e.isImage ? Icons.image_outlined : Icons.sticky_note_2_outlined,
                size: 14,
                color: FlowMicColors.t3,
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      e.displayText,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: refused ? FlowMicColors.t2 : FlowMicColors.t1,
                        fontSize: 13,
                      ),
                    ),
                    if (refused) ...<Widget>[
                      const SizedBox(height: 3),
                      Text(
                        widget.strings.lightRecordImageNoOriginal,
                        key: ValueKey<String>('plus.notes.noOriginal.${e.id}'),
                        // Bounded so one refused row cannot push the list off
                        // screen — and bounded rather than unbounded so the
                        // 「can the user actually read it」 assertion has something to measure
                        // (`didExceedMaxLines`, 0.2.53's rule: never Text.data).
                        maxLines: 4,
                        style: TextStyle(
                          color: FlowMicColors.t3,
                          fontSize: 10.5,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        );
    return Container(
      key: ValueKey<String>('plus.notes.row.${e.id}'),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: FlowMicColors.line)),
      ),
      // 🔴 NO InkWell UNLESS THE ROW IS REALLY TICKABLE. An `InkWell(onTap:
      // null)` still ripples nothing but IS a control the tree contains, and the
      // header's own rule — 「the honest shape of 「not done yet」 is 「that
      // control doesn't exist yet」,
      // never a dead one」 — is asserted by
      // `plus_panel_notes_tab_test.dart`「a note row has no tap target」 in the
      // read-only build. Tapping the row IS ticking it; a note row has no other
      // action, so no existing meaning is being overloaded (unlike a
      // frequently-used
      // phrase, whose body still means tap-to-send).
      child: tickable
          ? InkWell(
              key: ValueKey<String>('plus.notes.tick.${e.id}'),
              // No `!`: `tickable` is a local bool holding a null check, and
              // Dart's flow analysis promotes `sel` through it.
              onTap: () => sel.toggle(PlusPick.note(e)),
              child: body,
            )
          : body,
    );
  }

  Widget _line(String text, Color color, {Key? key}) => Padding(
    key: key,
    padding: const EdgeInsets.symmetric(vertical: 18),
    child: Text(text, style: TextStyle(color: color, fontSize: 12.5)),
  );
}
