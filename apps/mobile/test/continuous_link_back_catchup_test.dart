// D6-CATCHUP-DUP — the relay disposed a long recording while the app was away;
// the link comes back; the recording ends honestly and the rest is caught up.
//
// 【measured 2026-10-10, HUAWEI / Android 10, build from main 3b27a242】 a long
// recording, Home, Wi-Fi off 76 s, Wi-Fi on, back to the app. The stop was
// honest, but the automatic catch-up re-transcribed the WHOLE recording from
// its first byte and appended it after the parts already on the article: the
// head read 15:55 · 12 parts for about 8 minutes of wall time, and the first
// live row read 1:10 for four words.
//
// Two facts produce it, and each case below pins one:
//   ① the live rows' `duration_ms` is the relay's WALL time (server-core
//     `orchestrator-rollover.ts`: `boundaryMs - host.segmentStartMs`,
//     `boundaryMs = host.now()`), and a paused session keeps that clock running
//     while it drops chunks (`audio.handler.ts`). The article clock therefore
//     ran past every captured byte;
//   ② `_accountOwedTail` (ptt_capture_pump.dart) cut the owed range on that
//     clock, found nothing past it, and returned without writing any owed
//     range — which the recovery scan reads as 「the whole recording」
//     (retained_audio_journal_scan.dart `_Owed.of`).
//
// This drives the REAL chain (rc3_rig: PttSession → ChatController →
// BackfillRunner → RecoveryJournalLeg, the real state machine and its drop
// grace, the journal on an in-memory disk, the ReconnectCoordinator ladder and
// the `mobile:reconnect` accept path) and replaces only the recorder and the
// socket. The rig's chunk clock IS its capture clock (frame k = k × 200 ms), so
// an `acked_audio_ms` below names a capture position directly.


import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/app_lifecycle_edges.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _token = 'tok-test-abcdefghijklmnopqrstuvwxyz012';

/// The relay answers every recovery `audio:stop` with one terminal final
/// covering the range it was fed.
void _answerRecoveries(Rc3Rig r) {
  r.relay.onStop = (Rc3Stop stop) {
    if (!stop.recovery) return;
    final int ms = stop.toMs > stop.fromMs
        ? stop.toMs - stop.fromMs
        : stop.fed * 200;
    Future<void>.microtask(
      () => r.relay.pushIncoming(
        'stt:final',
        r.relay.terminal(stop, text: 'recovered', durationMs: ms),
      ),
    );
  };
}

/// Leave the app, lose the link past the drop grace, come back to a relay that
/// no longer holds the recording; [spokenAfterReturn] ms are captured after
/// the return and before the ack.
Future<void> _leaveAndReturnToAGoneRelay(
  Rc3Rig r, {
  int spokenAfterReturn = 2000,
}) async {
  r.session.reconnect.configure(
    url: 'ws://x',
    token: _token,
    replaceToken: true,
  );
  r.session.reconnect.start();
  await onAppBackground(r.session);
  r.relay.failEmits = true;
  r.relay.pushStatus(SocketStatus.disconnected);
  await Future<void>.delayed(const Duration(milliseconds: 3400));
  expect(
    r.session.fsm.session,
    isNot(SessionState.recording),
    reason: 'positive control: the drop grace expired',
  );
  await r.session.resumeCapture();
  await r.feedMs(spokenAfterReturn);
  r.relay.failEmits = false;
  r.relay.connectSucceeds = true;
  // No `audio_last_contiguous_seq`: the relay no longer holds the session.
  r.relay.ackQueue.add(<String, Object?>{
    'pairing_id': 'pair-test-1',
    'pc_name': 'Test PC',
    'pc_online': true,
  });
  r.session.reconnect.kickNow(reason: 'foreground');
  await r.until(
    () => !r.session.continuous.isActive,
    max: const Duration(seconds: 10),
  );
  expect(
    r.session.continuous.isActive,
    isFalse,
    reason: 'positive control: the D6 arm ended the recording',
  );
  r.session.reconnect.noteServerCapabilities(<String, Object?>{
    'capabilities': <String>[
      kCapabilityCoverageReceipt,
      kCapabilityDeliveryNoneSafe,
      kCapabilityIdempotentOperation,
    ],
  });
  await r.controller.backfill.sweep(sourceLang: 'zh');
  // Well under the 45 s live-final wait: the relay said no final is coming.
  await r.recoveries(1, max: const Duration(seconds: 20));
}

int _endOf(List<TimelineEntry> rows) {
  int end = 0;
  for (final TimelineEntry e in rows) {
    final int x = (e.articleOffsetMs ?? 0) + (e.durationMs ?? 0);
    if (x > end) end = x;
  }
  return end;
}

String _describe(List<TimelineEntry> rows) => <String>[
  for (final TimelineEntry e in rows)
    '${e.articleOffsetMs}+${e.durationMs} ${e.sourceText}',
].join(' | ');

void main() {
  testWidgets(
    '🔴 rows longer than the audio (relay wall time): the catch-up feeds only '
    'what follows the last live row, never the recording again',
    (WidgetTester t) async {
      await t.runAsync(() async {
        final Rc3Rig r = await Rc3Rig.open();
        try {
          _answerRecoveries(r);
          await r.begin();
          // Two rows of 10 s of audio each, reported as 14 s each: the relay's
          // wall time with pauses in it that this phone did not see end (a pause
          // under a dead link, an earlier relay session).
          await r.feedMs(10000);
          await r.interim(0, ackedMs: 9800);
          await r.segment('first part', 0, 14000);
          await r.feedMs(10000);
          await r.interim(1, ackedMs: 19800);
          await r.segment('second part', 1, 14000);
          // 4 s more, answered as a draft whose final died with the session.
          await r.feedMs(4000);
          await r.interim(2, ackedMs: 23800);
          await _leaveAndReturnToAGoneRelay(r);

          expect(
            r.relay.recoveryStarts,
            isNotEmpty,
            reason: 'positive control: the catch-up ran',
          );
          final RecordingManifest? m = await r.manifest();
          final int fromMs =
              ((r.relay.recoveryStarts.first['range_start_sample'] as int?) ??
                  0) ~/
              16;
          expect(
            fromMs,
            inInclusiveRange(19000, 20000),
            reason:
                'the catch-up starts where the last live row can be shown '
                'to end (answered 19.8 s when its final landed), not at 0 and '
                'not past the draft; owed=${m?.owedRanges}',
          );
          expect(
            r.rows.where((TimelineEntry e) => e.sourceText == 'first part'),
            hasLength(1),
          );
        } finally {
          await r.dispose();
        }
      });
    },
  );

  testWidgets(
    '🔴 a pause inside a live row is not article time: with the relay gone '
    'the article ends where the recording ends',
    (WidgetTester t) async {
      await t.runAsync(() async {
        final Rc3Rig r = await Rc3Rig.open();
        try {
          _answerRecoveries(r);
          await r.begin();
          await r.feedMs(10000);
          await r.interim(0, ackedMs: 9800);
          await r.segment('first part', 0, 10000);
          await r.feedMs(5000);
          // Home and back with the link up: the relay's open row keeps counting.
          final Stopwatch paused = Stopwatch()..start();
          await onAppBackground(r.session);
          await Future<void>.delayed(const Duration(milliseconds: 1500));
          await r.session.resumeCapture();
          paused.stop();
          await r.feedMs(5000);
          await r.interim(1, ackedMs: 19800);
          await r.segment('second part', 1, 10000 + paused.elapsedMilliseconds);
          await r.feedMs(4000);
          await _leaveAndReturnToAGoneRelay(r);

          expect(
            r.relay.recoveryStarts,
            isNotEmpty,
            reason: 'positive control: the catch-up ran',
          );
          // 10 + 5 + 5 + 4 + 2 = 26 s captured.
          expect(
            _endOf(r.rows),
            lessThanOrEqualTo(26000 + 300),
            reason: 'the article ran past the recording: ${_describe(r.rows)}',
          );
          expect(
            _endOf(r.rows),
            greaterThanOrEqualTo(26000 - 300),
            reason:
                'positive control, every captured second is on a row: '
                '${_describe(r.rows)}',
          );
        } finally {
          await r.dispose();
        }
      });
    },
  );
}
