// NR-214 (review D7) — "the rest will be transcribed automatically" says what
// it is waiting for.
//
// The waiting line used to be one sentence whatever held the recovery back:
// a new recording that the recovery had yielded to (ptt_backfill.dart
// `yieldRecoveryForLive`), or a link that was down. Both resume by themselves
// (`_resumeHeldRecovery` / the link-up sweep), and neither was said. The
// reader is `BackfillRunner.waitReason`; the sentence choice is
// `articleRecoveryPresentation`. The offline arm is also pinned on the
// mounted article page (article_stop_finishing_test.dart, case iv).

import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/chat_controller.dart'
    show ArticleCompletion;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/ui/article_recovery_presentation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

void main() {
  testWidgets('waitReason follows the microphone and the link', (
    WidgetTester t,
  ) async {
    await t.runAsync(() async {
      final Rc3Rig r = await Rc3Rig.open();
      try {
        expect(
          r.controller.backfill.waitReason,
          BackfillWait.due,
          reason: 'online, nothing recording',
        );
        await r.begin();
        await r.feedMs(2000);
        expect(
          r.controller.backfill.waitReason,
          BackfillWait.recording,
          reason: 'a long recording holds the microphone',
        );
        r.relay.pushStatus(SocketStatus.disconnected);
        await Future<void>.delayed(const Duration(milliseconds: 3400));
        expect(
          r.controller.backfill.waitReason,
          BackfillWait.offline,
          reason: 'no link wins: nothing can be sent either way',
        );
      } finally {
        await r.dispose();
      }
    });
  });

  test('each wait has its own sentence; due keeps the original one', () {
    final AppStrings s = AppStrings.of(AppLocale.en);
    const ArticleBackfill owed = ArticleBackfill(
      waitingAuto: true,
      pendingMs: 4000,
      fromOutage: true,
    );
    String? line(BackfillWait w) =>
        articleRecoveryPresentation(owed, s, wait: w).sentence;
    expect(line(BackfillWait.due), s.articleTailOwedWaiting);
    expect(line(BackfillWait.recording), s.articleTailOwedPausedForRecording);
    expect(line(BackfillWait.offline), s.articleTailOwedOffline);
    expect(
      <String?>{for (final BackfillWait w in BackfillWait.values) line(w)},
      hasLength(BackfillWait.values.length),
      reason: 'two waits sharing a sentence would answer two questions',
    );
    expect(
      articleRecoveryPresentation(owed, s).completion,
      ArticleCompletion.recoveryPending,
    );
  });
}
