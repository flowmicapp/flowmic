// owner 2026-08-30 — 「长程的历史转录无法选择，此处需要支持」.
//
// SPEC-REF: the CR-D demo's cell E-2 (「导出 / 转到电脑」) and ruling ⑥
//   (「整篇与单段都要」).
//
// 🔴 WHY IT WAS MISSING, WHICH IS THE PART WORTH KEEPING. The article card was
// deliberately not tickable, and the comment that made it so read:
//
//   「NOT TICKABLE, and that is not an oversight. The panel's tick set sends
//    things to a PC, and a continuous recording exists only where nothing is
//    delivered (ruling ⑨). A checkbox here would offer an action whose whole
//    premise the feature excludes.」
//
// Ruling ⑨ is about the moment of RECORDING: you cannot run a long recording
// while delivering live. It says nothing about later. Ruling ⑥ is the one that
// governs sending a finished piece, and it says both the whole piece and a
// single segment must be sendable — CR-0 even measured the wire limit for it
// (INJECT_TEXT_MAX_CHARS = 100,000; thirty minutes of speech is 5–8k).
//
// ⇒ two moments were collapsed into one rule, and a feature the owner had
// already ruled for went missing behind an argument that sounded principled.
// The lesson is not 「read the rulings」 — it is that a confident comment
// explaining why something is ABSENT is the hardest kind of defect to find,
// because it answers the question before anyone asks it.

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/ui/plus_panel_selection.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();
const String kArt = 'a0-1788000000000000';

TimelineEntry _member(String id, String text, int offsetMs) => TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      articleId: kArt,
      articleOffsetMs: offsetMs,
      createdAt: DateTime.utc(2026, 8, 30, 9),
      updatedAt: DateTime.utc(2026, 8, 30, 9),
    );

TimelineEntry _head() => TimelineEntry(
      id: 'loc_$kArt',
      clientId: kArt,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: null,
      outputText: '会议记录',
      status: EntryStatus.noted,
      entryType: TimelineEntry.kArticle,
      articleId: kArt,
      origin: 'cloud',
      durationMs: 75_000,
      segmentsCount: 3,
      createdAt: DateTime.utc(2026, 8, 30, 9),
      updatedAt: DateTime.utc(2026, 8, 30, 9),
    );

Future<LightRecordQuery> _seeded() async {
  final TimelinePersistence p = InMemoryTimelinePersistence();
  await p.saveAll(<TimelineEntry>[
    _head(),
    // Deliberately out of order on disk: a backfilled segment is written long
    // after the live ones that follow it inside the recording, so storage order
    // is the order we HEARD them and the piece is the order they were SAID.
    _member('s3', '第三段', 60_000),
    _member('s1', '第一段', 0),
    _member('s2', '第二段', 30_000),
  ]);
  return LightRecordQuery(persistence: p);
}

void main() {
  test('🔴 a whole recording composes into ONE message, in spoken order',
      () async {
    final LightRecordQuery q = await _seeded();
    final String words = await q.transcriptOf(kArt);
    expect(words, '第一段\n第二段\n第三段');
  });

  test('the join is the SAME rule a multi-row tick uses', () {
    // owner 2026-08-12 ruling 3: a single newline, no numbering, no separator
    // lines, no decoration. A second joining rule for articles would mean a
    // piece sent alone and the same piece sent beside a note arrive punctuated
    // differently, with nothing on any screen to explain why.
    expect(joinSelectedTexts(<String>['a', 'b']), 'a\nb');
  });

  test('the pick carries the WORDS, not the cover', () async {
    final LightRecordQuery q = await _seeded();
    final PlusPick pick = PlusPick.article(_head(), await q.transcriptOf(kArt));

    // 🔴 NOT the title. `PlusPick.note` would have taken `displayText`, which
    // on a head is 「会议记录」 — sending that would deliver the name of the
    // recording instead of the recording, and it would look like it worked.
    expect(pick.text, '第一段\n第二段\n第三段');
    expect(pick.text, isNot(contains('会议记录')));
    expect(pick.kind, PlusPickKind.note);
    // Keyed like any other light record, so ticking twice untick s it and the
    // list can ask 「is this row ticked」 with the key it already uses.
    expect(pick.key, PlusPick.keyForNote(_head()));
  });

  test('it delivers as one message beside other picks, oldest first', () async {
    final LightRecordQuery q = await _seeded();
    final PlusPanelSelection sel = PlusPanelSelection();
    addTearDown(sel.dispose);
    sel.toggle(PlusPick.article(_head(), await q.transcriptOf(kArt)));

    expect(sel.texts, <String>['第一段\n第二段\n第三段']);
    expect(sel.composedText, '第一段\n第二段\n第三段');
    // A recording is text, not a picture: it must not land in the image lane,
    // which delivers one row per item.
    expect(sel.images, isEmpty);
  });

  test('an empty recording composes to nothing, and says so by being empty',
      () async {
    // A recording nobody spoke into leaves a head and no members. The tick is
    // withheld by the tab in that case (an empty message would "send" and
    // deliver nothing); here the composer's own answer is pinned so the tab's
    // predicate has something true to read.
    final TimelinePersistence p = InMemoryTimelinePersistence();
    await p.saveAll(<TimelineEntry>[_head()]);
    expect(await LightRecordQuery(persistence: p).transcriptOf(kArt), '');
  });

  test('the strings this row shows still exist', () {
    expect(_zh.articleNoTitle.isNotEmpty, isTrue);
  });
}
