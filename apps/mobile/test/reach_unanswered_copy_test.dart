// owner 2026-08-30: 「暂时问不到」 → 「超时重试中」.
//
// 🔴 WHY A COPY CHANGE GETS A TEST. The new wording says two things where the
// old one said one: it TIMED OUT, and we ARE RETRYING. The second half is a
// promise about a mechanism, and this repo does not let copy make one on credit
// — that is the 「待投递」 red line, paid for once already: a word that promises
// something must have something behind it that delivers, or it is a sentence
// nobody keeps.
//
// So the two mechanisms behind the two halves are pinned here. If either is
// ever removed, this file goes red and the sentence has to change with it —
// which is the whole point. A copy string cannot outlive its mechanism quietly.

import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('🔴 「retrying」 is backed WITHIN a cycle: more than one attempt', () {
    // What makes 「timed out」 a considered verdict rather than one unlucky
    // packet. One attempt would make the word an overstatement in the other
    // direction.
    expect(kSessionPollPresenceBudget.attempts, greaterThan(1));
  });

  test('🔴 「retrying」 is backed BETWEEN cycles: the poll ticks again', () {
    // A fact about a timer that exists, not a hope. If the idle poll were ever
    // made one-shot, this row would be promising something nothing performs.
    expect(kIdlePcPresencePollInterval.inSeconds, greaterThan(0));
    // And it comes back soon enough for the word to be honest: telling someone
    // we are retrying and then waiting ten minutes is a different sentence.
    expect(kIdlePcPresencePollInterval.inSeconds, lessThanOrEqualTo(60));
  });

  test('it is still not [offline], in every language', () {
    // The reason this face exists at all: [offline] is a claim about the other
    // end, this is a claim about us. The rewording made the sentence more
    // specific about US; it must never drift into a claim about the PC.
    for (final AppLocale l in AppLocale.values) {
      final AppStrings s = AppStrings(l);
      expect(s.reachUnanswered, isNot(s.offline), reason: '$l');
      expect(s.reachUnanswered, isNot(s.pcOfflineChip), reason: '$l');
      expect(s.reachUnanswered.trim().isNotEmpty, isTrue, reason: '$l');
    }
  });

  test('and it still carries no imperative — nothing for the user to do', () {
    // Same rule INJECT_PC_MISMATCH's copy set: a sentence that tells someone to
    // act on a situation they cannot act on is worse than one that just says
    // what is true. The retry is OURS; there is no button.
    final AppStrings zh = AppStrings(AppLocale.zh);
    for (final String imperative in <String>['请', '点击', '重新连接']) {
      expect(zh.reachUnanswered.contains(imperative), isFalse,
          reason: 'the user is not being asked to do anything');
    }
  });
}
