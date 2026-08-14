// Card F10 — the composition root must hand the chat page real storage.
//
// 🔴 Why a source-level assertion and not a behaviour one. `ChatFlowPage`'s
// `historySource` is optional: making it required would have forced an edit
// into 26 call sites across 11 test files owned by other cards, and a
// non-optional parameter is not what protects this — WIRING is. A null source
// degrades the page to the pre-F10 behaviour (filtering the store's global
// page), which is exactly the defect this card removed and which no widget
// test would notice, because every widget test passes its own source.
//
// So the thing at risk is a one-line omission in `main.dart`, and this is the
// cheapest honest guard against it. It asserts nothing about how the argument
// behaves — `chat_narrowed_history_widget_test.dart` does that.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('main.dart wires ChatFlowPage.historySource to the opened storage', () {
    final File main = File('lib/main.dart');
    expect(main.existsSync(), isTrue,
        reason: 'run from apps/mobile; this test reads the composition root');
    // 🔴 Comments stripped FIRST. The initial version of this guard searched the
    // raw source and stayed green while the argument was commented out — a
    // guard that reads a comment as if it were code is not a guard. (Caught by
    // running this test red on purpose, which is the only reason it is known.)
    final String src = main
        .readAsLinesSync()
        .where((String l) => !l.trimLeft().startsWith('//'))
        .join('\n');

    final int chat = src.indexOf('ChatFlowPage(');
    expect(chat, isNot(-1), reason: 'the composition root builds the chat page');
    // The argument list of that one construction, bounded by the next builder.
    final String args = src.substring(chat, chat + 900);

    expect(
      args.contains('historySource:'),
      isTrue,
      reason: 'without it the chat list silently falls back to filtering the '
          'store\'s GLOBAL newest page — the F10 defect, restored',
    );
    expect(
      args.contains('historySource: widget.storage.persistence'),
      isTrue,
      reason: 'must be the SAME persistence TimelineStore was built on, or the '
          'chat list and 全部历史 would page two different tables',
    );
  });
}
