// 🔴 The `liveText` render-site gate — rewritten by PA-5 (Plan A′), NOT
// deleted and NOT loosened (the WP7 prompt names both traps).
//
// T-4 (0.2.63) cut the render sites down to ONE (the timeline's live draft
// row) and this gate held that number. PA-5 legitimately adds a SECOND site:
// the edit sheet's append highlight (`_sheetAppendLiveView`,
// chat_flow_edit_sheet.dart) — while an in-sheet append is live the timeline
// row is BEHIND the scrim, and the growing words must be visible where they
// will land. So the gate now enumerates EXACTLY TWO NAMED sites, each pinned
// to its file and its expression; anything else — a third site, a site that
// moved, a site whose expression changed — still fails.
//
// ── Why the gate survives the count change ──────────────────────────────────
// The thing it guards did not change: 「one fact, one face per surface」. The
// interim-as-placeholder branch T-4 killed was a WORSE face of the same fact
// drawn NEXT TO the good one; these two sites are never both visible (the
// scrim separates them). The next person adding a "might as well also show the words being spoken"
// spot is exactly who this stays red for.
//
// ── CR-12-C (2026-09-23): a THIRD named site, by the same rule ──────────────
// Design 2026-09-22-cr12 §4.4 puts `LiveDraftTile` under the open paragraph of
// the in-progress article page (`_ArticleLiveHost._draft`,
// article_page_live.dart). That page is a route pushed OVER the light-record
// screen, so it and site ① are never both visible — the same property that
// admitted site ②. Pinned like the other two: its file and its expression.
// A fourth site, or this one moving, still fails.
//
// Shape: scan lib/, strip line comments first (a comment is not a render
// site). Same family as ka_chat_controller_no_subtype_gate_test.dart.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Strip `//` line comments so the guard reads CODE.
String _stripLineComments(String src) => src
    .split('\n')
    .map((String l) {
      final int at = l.indexOf('//');
      return at < 0 ? l : l.substring(0, at);
    })
    .join('\n');

Iterable<File> _dartFiles(String root) => Directory(root)
    .listSync(recursive: true)
    .whereType<File>()
    .where((File f) => f.path.endsWith('.dart'));

void main() {
  test('🔴 PA-5 + CR-12-C: lib/src/ui has exactly three liveText render sites — the live draft row, the edit-sheet append highlight, the live article page\'s draft', () {
    final List<String> hits = <String>[];
    for (final File f in _dartFiles('lib/src/ui')) {
      final List<String> lines =
          _stripLineComments(f.readAsStringSync()).split('\n');
      for (int i = 0; i < lines.length; i++) {
        if (RegExp(r'\bliveText\b').hasMatch(lines[i])) {
          hits.add('${f.path}:${i + 1}: ${lines[i].trim()}');
        }
      }
    }
    expect(
      hits,
      hasLength(3),
      reason: '🔴 `liveText` has ${hits.length} render sites in the UI layer; '
          'the Plan A′ contract (§7 gate rewrite) plus CR-12-C allow **exactly '
          'three named sites**. Hits:\n${hits.join('\n')}\n'
          '⚠️ If the new one is "might as well also show the words being '
          'spoken somewhere else", that is exactly the face T-4 deleted: '
          'one fact, two faces, and one of them is worse.',
    );
    // Named site ①: the timeline's live draft row — visible whenever the dock
    // is (the sheet is closed).
    final String tile = hits.firstWhere(
      (String h) => h.contains('chat_flow_scroll.dart'),
      orElse: () => '',
    );
    expect(
      tile,
      contains('text: controller.liveText'),
      reason: 'the live-draft-row site is no longer LiveDraftTile\'s body ⇒ '
          '"two named sites" is no longer talking about the same thing',
    );
    // Named site ②: the sheet's append highlight — visible only while the
    // sheet covers the timeline (A7), i.e. exactly when site ① is not.
    // (It lives in the sheet's 800-cap split-out append part file.)
    final String sheet = hits.firstWhere(
      (String h) => h.contains('chat_flow_edit_sheet_append.dart'),
      orElse: () => '',
    );
    expect(
      sheet,
      contains('s.controller.liveText'),
      reason: 'the edit-sheet site no longer reads the controller\'s liveText ⇒ '
          'the append highlight is painting something else',
    );
    // Named site ③ (CR-12-C): the in-progress article page's draft — a route
    // over the light-record screen, so never visible together with site ①.
    final String livePage = hits.firstWhere(
      (String h) => h.contains('article_page_live.dart'),
      orElse: () => '',
    );
    expect(
      livePage,
      contains('text: c.liveText'),
      reason: 'the live article page site is no longer LiveDraftTile\'s body ⇒ '
          '"three named sites" is no longer talking about the same thing',
    );
  });

  test('🔴 T-4 ②: the `interimText` parameter is gone from lib/ entirely (R8: leave no dead content)', () {
    final List<String> hits = <String>[];
    for (final File f in _dartFiles('lib')) {
      final List<String> lines =
          _stripLineComments(f.readAsStringSync()).split('\n');
      for (int i = 0; i < lines.length; i++) {
        if (RegExp(r'\binterimText\b').hasMatch(lines[i])) {
          hits.add('${f.path}:${i + 1}: ${lines[i].trim()}');
        }
      }
    }
    expect(
      hits,
      isEmpty,
      reason: '🔴 `interimText` is back: ${hits.join('\n')}\n'
          '⚠️ A parameter no branch reads is the door through which that '
          'face quietly comes back next time.',
    );
  });
}
