// SegmentBuffer contract test (WP-R3-1): same-idx REPLACE, cross-idx APPEND,
// finalized-slot lock against replay, and the CJK-aware joiner.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §3.

import 'package:flowmic/src/stt/segment_buffer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('same segment_idx interims REPLACE within the slot', () {
    final b = SegmentBuffer();
    b.put(idx: 0, text: '大');
    b.put(idx: 0, text: '大家');
    b.put(idx: 0, text: '大家好');
    expect(b.joined, '大家好');
  });

  test('different segment_idx values APPEND across slots', () {
    final b = SegmentBuffer();
    b.put(idx: 0, text: '你好。');
    b.put(idx: 1, text: '再见');
    expect(b.joined, '你好。\n再见'); // 。→ newline joiner
  });

  test('a finalized slot locks out late / replayed interims', () {
    final b = SegmentBuffer();
    b.put(idx: 0, text: 'final text', finalized: true);
    final changed = b.put(idx: 0, text: 'late replay interim');
    expect(changed, isFalse);
    expect(b.joined, 'final text');
    expect(b.finalizedSlots, contains(0));
  });

  test('finalized empty text keeps the accumulated online text (no wipe)', () {
    final b = SegmentBuffer();
    b.put(idx: 0, text: '累积的在线文本');
    b.put(idx: 0, text: '', finalized: true); // orchestrator empty fallback
    expect(b.joined, '累积的在线文本');
  });

  // ── W2.5 / FB-6 —— REVISION class: same segment_idx ────────────────────────
  // Ruling:
  // docs/decisions/2026-08-06-server-final-is-authoritative-over-phone-joined.md
  //
  // The slot's interims and the slot's final are two versions of ONE span, so
  // the processed one REPLACES. Exact equality on purpose: a 「lossless
  // concatenate」 implementation is also wrong here (it duplicates the span), and
  // `contains` would let it through.
  group('a finalized put REPLACES its slot (same span, two versions)', () {
    test('the processed final wins even though it is SHORTER', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '嗯 我 我觉得这个方案可以');
      b.put(idx: 0, text: '我觉得这个方案可行', finalized: true);
      expect(b.joined, '我觉得这个方案可行');
    });

    test('the processed final wins when it shares a long suffix with the raw '
        'interims (the old overlap branch kept the filler)', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '呃 那个 我们明天上午开会');
      b.put(idx: 0, text: '我们明天上午开会', finalized: true);
      expect(b.joined, '我们明天上午开会');
    });

    test('a LONGER final (punctuation added) also lands verbatim', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '明天下午三点开会');
      b.put(idx: 0, text: '明天下午三点开会。', finalized: true);
      expect(b.joined, '明天下午三点开会。');
    });
  });

  // ── W2.5 / FB-6 —— DISJOINT class: different segment_idx ───────────────────
  // Different slots are different spans: both survive, neither may be replaced
  // by the other. These go red on any 「keep the longer / keep the last one」
  // rule.
  group('different slots are disjoint spans — nothing is discarded', () {
    test('two segments of similar length and shape both survive', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '第一部分已经完成了', finalized: true);
      b.put(idx: 1, text: '第二部分正在进行', finalized: true);
      expect(b.joined, '第一部分已经完成了第二部分正在进行');
    });

    test('a SHORTER later segment is not swallowed by a longer earlier one', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '预算是三百万人民币', finalized: true);
      b.put(idx: 1, text: '好的', finalized: true);
      expect(b.joined, '预算是三百万人民币好的');
    });
  });

  // ── W5a / W2.5-H —— the cross-segment seam NEVER trims ─────────────────────
  // 🔴 THREE ASSERTIONS IN THIS GROUP WERE REVERSED (W5a). They used to pin the
  // seam trimmer, i.e. they pinned DELETION OF SPOKEN CONTENT as the acceptance
  // criterion, and they would have gone red on the day the fix landed and made
  // the fix look like a regression. Old assertions, quoted so the change is
  // auditable rather than silent:
  //
  //   「a genuine multi-character overlap IS still trimmed」
  //       expect(b.joined, '今天天气不错我们出去走走');
  //   「exactly TWO characters is at the floor, so it trims」
  //       expect(b.joined, '今天开会结束了');
  //   「a segment wholly contained at the tail of the assembly adds nothing
  //    (A-4: not a loss)」
  //       expect(b.joined, '我们明天开会');
  //
  // The last one is the one the ledger flagged (§4.3 原地更正块): the second
  // segment 「开会」 is not present twice in that expectation, it is present
  // once — the user said it twice and one copy was deleted. 0.2.52 §3 law,
  // literally re-run: a reverse control that picks the wrong direction is worse than no reverse control — it writes the defect into the acceptance criterion.
  //
  // The two ONE-character tests below are NOT reversed. They already pinned
  // 「concatenate, do not trim」, which is the behaviour we want; they were the
  // only two rows in this group that were right, and they now hold for the whole
  // range instead of just below a floor.
  //
  // ── 🔴 REVERSE CONTROLS: ONE PER LOSS CLASS, NOT ONE PER FILE ──────────────
  // Restoring the whole historical trimmer turns 12 of these tests red, but that
  // only proves 「that one implementation is caught」. To show a CLASS of error is
  // caught, the control has to be a REPRESENTATIVE OF THAT CLASS. Two were run
  // separately (2026-08-07, dev-pc-a【measured】), each reintroducing exactly
  // one loss shape, and each caught by a DISJOINT set of rows — which is the
  // part that matters, because it means neither class is riding on the other's
  // coverage:
  //
  //   CLASS A 「cross-segment overlap floor deletes real speech」 — trim a >=2-char shared run but never
  //     consume a whole segment.  ⇒ 5 red: the two ① rows in the W2.5-H group,
  //     the two REVERSED floor rows below, and 「partially overlapping」.
  //     Both ② rows stayed GREEN, confirming the control is isolated.
  //   CLASS B 「a wholly-contained segment is deleted」 — `if (out.endsWith(segText)) continue;`,
  //     no partial trimming at all.  ⇒ 7 red: the two ② rows, 「wholly contained
  //     at the tail」, 「wholly contained: 说三遍」, 「exact duplicate」, 「the old
  //     empty-tail case」 and the 3-segment length property.
  //     Both ① rows stayed GREEN.
  //
  // ⇒ If a future change reintroduces EITHER shape alone, something here fails.
  // That is the claim; the 12-red whole-trimmer run does not make it.
  group('the cross-segment seam concatenates and never deletes', () {
    test('a ONE-character coincidence must not delete a character of speech',
        () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '他说了算', finalized: true);
      b.put(idx: 1, text: '算了吧我们走', finalized: true);
      // Once this was 「他说了算了吧我们走」 — one 「算」 deleted, and the result
      // still reads as fluent Chinese so nothing downstream noticed.
      // Duplicating it instead is the visible error, which is the one to take.
      expect(b.joined, '他说了算算了吧我们走');
    });

    test('a second one-character coincidence, same shape', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '这次先到这里', finalized: true);
      b.put(idx: 1, text: '里面还有两个人', finalized: true);
      expect(b.joined, '这次先到这里里面还有两个人');
    });

    test('REVERSED: a multi-character shared run is kept, not trimmed', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '今天天气不错', finalized: true);
      b.put(idx: 1, text: '天气不错我们出去走走', finalized: true);
      // 4 shared characters is not evidence of anything: this layer holds two
      // strings and nothing else, so 「the engine re-transcribed the seam」 and
      // 「the speaker repeated themselves」 are indistinguishable here. Keep.
      expect(b.joined, '今天天气不错天气不错我们出去走走');
    });

    test('REVERSED: exactly two shared characters is kept too — that was the '
        'old floor and it is the shape that was measured losing speech', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '今天开会', finalized: true);
      b.put(idx: 1, text: '开会结束了', finalized: true);
      expect(b.joined, '今天开会开会结束了');
    });

    test('REVERSED: a segment wholly contained at the tail SURVIVES '
        '(was pinned as 「A-4: not a loss」)', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '我们明天开会', finalized: true);
      b.put(idx: 1, text: '开会', finalized: true);
      expect(b.joined, '我们明天开会开会');
    });
  });

  // ── W5a / W2.5-H —— property-style coverage of the seam ────────────────────
  // The invariant is mechanical, not statistical: `joined` is a pure
  // concatenation of the non-empty slots in index order, so for EVERY input the
  // characters of every slot appear in the output. These pin the five shapes the
  // old trimmer distinguished between — the point being that it no longer
  // distinguishes at all.
  group('seam shapes: every slot survives whatever it shares with its '
      'neighbour', () {
    test('non-overlapping: plain concatenation', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '预算大概三百万', finalized: true);
      b.put(idx: 1, text: '工期是六个月', finalized: true);
      expect(b.joined, '预算大概三百万工期是六个月');
    });

    test('partially overlapping: the shared run appears twice', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '我们讨论一下方案', finalized: true);
      b.put(idx: 1, text: '方案的第二部分', finalized: true);
      expect(b.joined, '我们讨论一下方案方案的第二部分');
    });

    test('wholly contained: the later segment is not swallowed', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '重要的事情说三遍', finalized: true);
      b.put(idx: 1, text: '说三遍', finalized: true);
      expect(b.joined, '重要的事情说三遍说三遍');
    });

    test('exact duplicate slots: BOTH appear (「好的」 twice is real speech)',
        () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '好的', finalized: true);
      b.put(idx: 1, text: '好的', finalized: true);
      expect(b.joined, '好的好的');
    });

    test('the old empty-tail case: an EMPTY slot is skipped, a contained one is '
        'not', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '第一段', finalized: true);
      b.put(idx: 1, text: '', finalized: true); // engine heard nothing here
      b.put(idx: 2, text: '第一段', finalized: true);
      // Empty text is the ONLY thing that contributes nothing. Under the old
      // rule idx 2 was ALSO dropped, because the trimmer computed an empty tail
      // for it — the two cases were conflated, and only one of them is real.
      expect(b.joined, '第一段第一段');
    });

    test('a three-segment assembly keeps every character of every slot', () {
      final b = SegmentBuffer();
      const List<String> segs = <String>[
        '我们明天开会',
        '开会',
        '会议地点在三楼',
      ];
      for (int i = 0; i < segs.length; i++) {
        b.put(idx: i, text: segs[i], finalized: true);
      }
      // Property: total length is the sum of the parts (every joiner here is
      // '' — all seams are CJK↔CJK), i.e. nothing was consumed at any seam.
      expect(b.joined.length,
          segs.fold<int>(0, (int acc, String s) => acc + s.length));
      expect(b.joined, '我们明天开会开会会议地点在三楼');

      // Same slots written in REVERSE arrival order must assemble identically —
      // `joined` orders by segment_idx, not by insertion. (Not a tautology: the
      // backing map iterates in insertion order.)
      final b2 = SegmentBuffer();
      for (int i = segs.length - 1; i >= 0; i--) {
        b2.put(idx: i, text: segs[i], finalized: true);
      }
      expect(b2.joined, b.joined);
    });
  });

  // ── W2.5-H —— REPRODUCTION of the four measured losses ─────────────────────
  // Source: docs/strategy/2026-08-06-w25-closing-the-two-red-lines-ledger.md
  // §4.3 原地更正块 (2026-08-07, controller re-ran【measured】, dev-pc-a). Written
  // BEFORE the fix and run red first — the four rows below are the ledger's four
  // rows verbatim, with the RIGHT-HAND side changed from 「what it did」 to
  // 「what it must do」.
  group('W2.5-H: the cross-segment seam must not delete spoken content', () {
    test('① two-character coincidence at the seam — 「可以」 was deleted', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '这个方案我觉得可以', finalized: true);
      b.put(idx: 1, text: '可以的话我们下周开始。', finalized: true);
      expect(b.joined, '这个方案我觉得可以可以的话我们下周开始。');
    });

    test('① second two-character coincidence — 「问题」 was deleted', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '我们先看第一个问题', finalized: true);
      b.put(idx: 1, text: '问题不大我来处理', finalized: true);
      expect(b.joined, '我们先看第一个问题问题不大我来处理');
    });

    test('② a wholly contained segment was deleted outright — 「再说」', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '这件事我们下周再说', finalized: true);
      b.put(idx: 1, text: '再说', finalized: true);
      expect(b.joined, '这件事我们下周再说再说');
    });

    test('② a wholly contained MIDDLE segment vanished — 「开会」', () {
      final b = SegmentBuffer();
      b.put(idx: 0, text: '我们明天开会', finalized: true);
      b.put(idx: 1, text: '开会', finalized: true);
      b.put(idx: 2, text: '地点在三楼', finalized: true);
      expect(b.joined, '我们明天开会开会地点在三楼');
    });
  });

  test('joiner: sentence-end → newline, pause punctuation / CJK → none, ASCII → space', () {
    expect(SegmentBuffer.joinerBetween('好。', '再'), '\n');
    expect(SegmentBuffer.joinerBetween('你，', '我'), '');
    expect(SegmentBuffer.joinerBetween('中', '文'), '');
    expect(SegmentBuffer.joinerBetween('hello', 'world'), ' ');
  });

  test('clear resets both text and finalized slots', () {
    final b = SegmentBuffer();
    b.put(idx: 0, text: 'x', finalized: true);
    b.clear();
    expect(b.isEmpty, isTrue);
    expect(b.finalizedSlots, isEmpty);
  });
}
