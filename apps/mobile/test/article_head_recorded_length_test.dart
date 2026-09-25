// 🔴 RULING 5 (MAIN, 2026-09-24) — THE HEAD IS THE RECORDED LENGTH, SILENT
// TAIL INCLUDED. MOUNTED ON THE SCREEN THE RECORDING IS READ ON. (The S1 half
// of the header criterion; the S6 half is article_owed_tail_after_draft_test.)
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §1.3 and §11-5
//   `_dispatch/2026-09-24-codex-rootcause-r3.out.md` item 1 (the mechanism)
//   test/support/rc3_rig.dart (the rig)
//
// MEASURED (rerun 3): the clean run S1 read 396,040 ms against 413,440 captured
// — 17.4 s short, every word present. The recording ended in silence; the
// relay's empty terminal final carried that silence's span (S4: 18,084 ms) and
// the phone marked the span settled without recording its time
// (`chat_utterance.dart`'s empty-text branch), so the head — the sum of the
// rows — never saw it. Now the span goes onto the last row
// (chat_utterance_owner.dart `_recordSilentTail`).
//
// Reverse control: the `_recordSilentTail` call removed ⇒ the head reads 3:30
// (red) — log in the card report.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const List<int> _rowsMs = <int>[60000, 90000, 60000];
const int _silentTailMs = 17400;
const int _capturedMs = 227400; // 210 s of rows + 17.4 s of silence = 3:47
const List<String> _texts = <String>[
  '今天先把上周的数字过一遍。',
  '然后我们看新的排期，每个人说一下自己那部分。',
  '最后确认一下下周的发布时间。',
];

void main() {
  testWidgets(
      '🔴 ruling 5 (S1): a clean recording that ends in 17.4 s of silence reads '
      'its captured length (3:47), not the sum of its rows (3:30)',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: '', durationMs: _silentTailMs, segmentIdx: _rowsMs.length));
        });
      };
      await r.begin();
      for (int i = 0; i < _rowsMs.length; i++) {
        await r.feedMs(_rowsMs[i]);
        await r.segment(_texts[i], i, _rowsMs[i]);
      }
      await r.feedMs(_silentTailMs);
      await r.controller.pttUp();
      await r.untilAsync(() async => (await r.manifest())?.settled ?? false);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, isEmpty,
        reason: 'positive control: nothing was owed, nothing re-transcribed');
    expect(r.rows, hasLength(3));
    expect(r.rows.last.durationMs, _rowsMs.last + _silentTailMs,
        reason: 'the silence after the last words is on the last row');
    expect(r.rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, 60000, 150000], reason: 'no row moved');
    expect(r.rowsMs, _capturedMs);
    expect((await tester.runAsync<RecordingManifest?>(r.manifest))!.settled, isTrue,
        reason: 'RC-B still holds: the silent tail settles on its own rows');

    await rc3MountAndOpen(tester, r);
    expect(
      <String>[
        for (final int s in <int>[_capturedMs ~/ 1000 - 1, _capturedMs ~/ 1000, _capturedMs ~/ 1000 + 1])
          _zh.articleCardMeta(formatEntryDuration(s * 1000), 3),
      ],
      contains(rc3TextOf(tester, const Key('article.meta'))),
      reason: 'S1 read 17.4 s short with every word present',
    );
  });
}
