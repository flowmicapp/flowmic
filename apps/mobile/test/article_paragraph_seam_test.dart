// Card POL-3 (2026-10-14): an article paragraph's row seams follow the ONE
// row-seam rule, SegmentBuffer.joinerBetween (apps/mobile/lib/src/stt/
// segment_buffer.dart), pinned on both ends by the shared fixture
// verify/fixtures/seam-join-cases.json, except that a paragraph
// never draws that rule's newline (one run, cell E-2′). Before this,
// paragraphText spaced a seam only when both neighbours were ASCII. Kept out of
// article_paragraphs_test.dart, which sits at the 1200-line test cap.

import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/article_paragraphs.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

final DateTime _t0 = DateTime.utc(2026, 10, 14, 9);

ArticleParagraph _para(List<String> texts) => ArticleParagraph(<TimelineEntry>[
      for (int i = 0; i < texts.length; i++)
        TimelineEntry(
          id: 'p$i',
          clientId: 'p$i',
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          sourceText: texts[i],
          outputText: texts[i],
          status: EntryStatus.noted,
          origin: 'cloud',
          articleId: 'a0-1790000000000000',
          articleOffsetMs: i * 30000,
          durationMs: 30000,
          createdAt: _t0,
          updatedAt: _t0,
        ),
    ], closed: true);

void main() {
  test('a row ending in an accented Latin letter gets a space (was "cafénoir")', () {
    expect(paragraphText(_para(<String>['un café', 'noir'])), 'un café noir');
  });
  test('an ASCII row before an accented row gets a space (was "helloécole")', () {
    expect(paragraphText(_para(<String>['hello', 'école'])), 'hello école');
  });
  test('Hangul rows get a space: Korean writes spaces between words', () {
    expect(paragraphText(_para(<String>['안녕하세요', '저는 민수입니다'])), '안녕하세요 저는 민수입니다');
  });
  test("CJK then Latin joins directly; Latin then CJK gets the live view's space", () {
    expect(paragraphText(_para(<String>['我们用', 'Redis'])), '我们用Redis');
    expect(paragraphText(_para(<String>['we use Redis', '来缓存'])), 'we use Redis 来缓存');
  });
  test('the right row never decides (the PC types the space either way); a CJK sentence end draws no newline', () {
    expect(paragraphText(_para(<String>['migrate to', '.NET 8'])), 'migrate to .NET 8');
    expect(paragraphText(_para(<String>['abc', '，def'])), 'abc ，def');
    expect(paragraphText(_para(<String>['好的。', '下一件'])), '好的。下一件');
  });
  test('Japanese long vowel and Thai join directly', () {
    expect(paragraphText(_para(<String>['コーヒー', 'を飲みます'])), 'コーヒーを飲みます');
    expect(paragraphText(_para(<String>['ภาษาไทย', 'ดี'])), 'ภาษาไทยดี');
  });
}
