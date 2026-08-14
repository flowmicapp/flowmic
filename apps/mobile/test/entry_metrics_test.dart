// §4b-8 (docs/strategy/2026-08-01-data-asset-lifecycle-design.md) — pins the
// ONE word-count algorithm and the duration formatter behind the per-row
// 「时长 + 字数」 display. See entry_metrics.dart's header for the judgement
// calls this file locks down (mixed CJK/Latin counting rule; duration
// sub-second branch).

import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEntry _entry({
  String source = '',
  String? output,
  String? processMode,
  String? processedText,
  int? durationMs,
  String entryType = TimelineEntry.kTranscript,
}) {
  final DateTime now = DateTime.utc(2026, 8, 1, 10, 0);
  return TimelineEntry(
    id: 'loc_mobile_c',
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: source,
    outputText: output ?? source,
    processMode: processMode,
    processedText: processedText,
    status: EntryStatus.injected,
    durationMs: durationMs,
    entryType: entryType,
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  group('textWordCount — the one mixed CJK/Latin algorithm', () {
    test('empty string is zero', () {
      expect(textWordCount(''), 0);
    });

    test('pure CJK counts one per character', () {
      expect(textWordCount('你好世界'), 4);
    });

    test('pure Latin counts one per whitespace-delimited word', () {
      expect(textWordCount('hello world'), 2);
    });

    test('mixed CJK + Latin + digits sums both rules', () {
      // 你(1) 好(1) + world(1) + 123(1) = 4.
      expect(textWordCount('你好 world 123'), 4);
    });

    test('CJK punctuation contributes nothing', () {
      expect(textWordCount('你好，世界！'), 4);
    });

    test('ASCII punctuation does not split or inflate a Latin run', () {
      // "sent." is one word — the period is not counted, and does not start
      // a second word.
      expect(textWordCount('The report has been sent.'), 5);
    });

    test('a run of digits counts as one word, not one per digit', () {
      expect(textWordCount('room 1234'), 2);
    });

    // ── 2026-08-14: the nine-locale rule (entry_metrics.dart header §A–§F) ──
    // Every number below is MEASURED on this machine, not predicted, and the
    // 「was」 column is the pre-2026-08-14 mobile algorithm measured by running
    // a verbatim copy of it — not by reading it.
    //
    // 🔴 THE ONE THAT WAS A SHIPPING DEFECT, not a convention change:
    // `i18n/mobile/ru.json` went out with 「$n слов」 hours before this test
    // existed, so a Russian user read `0 слов` on every row, a live draft
    // counter frozen at 0, and 0 in the statistics page — the permanently-zero
    // cell CLAUDE.md and 16 册 §6.1 forbid by name.
    test('🔴 Cyrillic counts its words — it used to return ZERO', () {
      expect(textWordCount('привет мир'), 2); // was 0
      expect(textWordCount('Проверка'), 1); // was 0
      // The reason the old rule hit zero: NOTHING in the string was admitted,
      // so there was no partial credit to notice. A single Latin word next to
      // it would have made the row look plausible while still undercounting.
      expect(textWordCount('привет world'), 2); // was 1
    });

    test('accented Latin is one word, not one word per accent', () {
      // `ü` used to fall out of the run and split the word in two.
      expect(textWordCount('Grüße aus München'), 3); // was 5
      expect(textWordCount("Ça va, l'été"), 3); // was 4
      expect(textWordCount('Ñandú español'), 2); // was 3
    });

    // 🔴 A CONVENTION CHANGE, not a repair — it changes a number the user sees.
    // Korean is written with spaces between words; that is exactly what
    // separates it from Chinese and Japanese, and the translation industry
    // counts it space-delimited, in 어절 (eojeol). Counting each Hangul
    // syllable is the Korean equivalent of counting English letters.
    test('Korean counts 어절 (space-delimited), not syllables', () {
      expect(textWordCount('한국어 단어 세기'), 3); // was 7
      expect(textWordCount('안녕하세요'), 1); // was 5 — one run, one word
    });

    test('Chinese and Japanese are UNCHANGED — they have no word spaces', () {
      expect(textWordCount('你好世界'), 4);
      expect(textWordCount('日本語のテキスト'), 8);
    });

    test('a run with no letter or digit scores nothing', () {
      // ⚠️ Already true of the old mobile rule (measured: all three were 0
      // before as well). It is pinned here because mobile now runs the DESKTOP
      // algorithm, where this WAS a real change (「！！！」 scored 1 there), and
      // the shared rule needs the case held down on both ends.
      expect(textWordCount('！！！'), 0);
      expect(textWordCount('...'), 0);
      expect(textWordCount('---'), 0);
      // Knowingly accepted, same as the desktop twin: an emoji-only utterance
      // counts 0. 「0」 is the honest answer for a length estimate whose unit is
      // 字/词 — neither is present — and the row still renders its text.
      expect(textWordCount('🙂🙂'), 0);
    });

    test('punctuation ABSORBED into a lettered run still scores that run once',
        () {
      // The run 「，world」 has letters, so it scores 1 — the comma rides along
      // rather than being counted or splitting the word.
      expect(textWordCount('你好，world'), 3);
      expect(textWordCount('你好， world'), 3);
      expect(textWordCount('好!'), 1);
      expect(textWordCount('v0.2.36, 好的!'), 3); // was 5
    });
  });

  group('entryWordCount — reads the MODE\'S FINAL RESULT (owner §4-2)', () {
    test('realtime row (no processMode): counts the plain transcript', () {
      final TimelineEntry e = _entry(source: '你好世界');
      expect(entryWordCount(e), 4);
    });

    // 🔴 THE POINT OF THIS TEST — source and output are deliberately
    // different LENGTHS (12 CJK chars vs. 2 English words) so a function
    // that accidentally reads sourceText instead of the final result cannot
    // pass by coincidence. This is the assertion the reverse-control run
    // (delivery report) breaks on purpose.
    test('translate row: counts the TRANSLATED text, not the 原文', () {
      final TimelineEntry e = _entry(
        source: '这是一段比较长的原始文字内容',
        output: 'Short translation.',
        processMode: 'translate',
        processedText: 'Short translation.',
      );
      expect(entryWordCount(e), 2, reason: '"Short translation." = 2 words');
      expect(entryWordCount(e), isNot(textWordCount(e.sourceText!)));
    });

    test('organize row: counts the ORGANIZED text, not the 原文', () {
      final TimelineEntry e = _entry(
        source: '嗯那个我们今天开会主要是想讨论一下这个事情',
        output: '今天开会讨论此事。',
        processMode: 'organize',
        processedText: '今天开会讨论此事。',
      );
      expect(entryWordCount(e), 8, reason: '今天开会讨论此事 = 8 CJK chars');
      expect(entryWordCount(e), isNot(textWordCount(e.sourceText!)));
    });

    test('a picture row has no transcript — null, not a fabricated zero', () {
      final TimelineEntry e = _entry(
        source: '🖼 PNG · 78 KB',
        entryType: TimelineEntry.kImage,
      );
      expect(entryWordCount(e), isNull);
    });
  });

  group('formatEntryDuration — boundaries', () {
    test('zero', () {
      expect(formatEntryDuration(0), '0.0s');
    });

    test('under one second keeps one decimal', () {
      expect(formatEntryDuration(500), '0.5s');
      expect(formatEntryDuration(999), '1.0s'); // rounds, still the <1s branch
    });

    test('exactly one second and up to 59s are whole seconds', () {
      expect(formatEntryDuration(1000), '1s');
      expect(formatEntryDuration(1999), '1s'); // floors, matches recording
      //  panel's whole-second convention above the sub-second branch
      expect(formatEntryDuration(59999), '59s');
    });

    test('one minute and above switches to m:ss', () {
      expect(formatEntryDuration(60000), '1:00');
      expect(formatEntryDuration(61000), '1:01');
      expect(formatEntryDuration(125000), '2:05');
    });

    test('defensive floor on a negative input (never expected from a caller)', () {
      expect(formatEntryDuration(-500), '0.0s');
    });
  });
}
