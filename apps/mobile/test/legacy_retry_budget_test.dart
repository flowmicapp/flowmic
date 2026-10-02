// NR-138 ①② — THE LEGACY LEG'S AUTOMATIC ATTEMPTS ARE COUNTED, SPACED AND
// CAPPED, THROUGH THE PRODUCTION CONTROLLER.
//
// Root cause (`_dispatch/2026-10-01-nr138-rootcause.md.out` §1): a stalled
// legacy segment stayed eligible, every sweep tried it again, the recovery's
// own RECORDING → PROCESSING edge queued the next sweep, and every attempt was
// billed. These cases drive `controller.backfill` — the runner production
// builds — with the two seams production exposes for exactly this (the
// recovery clock and the RC-O timer factory), not a hand-built runner.
//
// REVERSE CONTROLS (run 2026-10-01; each red on this file, then restored
// green, file hash identical after restore):
//   ① the send-time due/cap check in `backfill_legacy_leg.dart`
//     `_replaySession` disabled ⇒ 5 of 8 red (first case: extra starts on
//     queued passes; unreadable records: `Expected: empty`);
//   ② every reservation read as in flight (`LegacyRetryStatus.of`) ⇒ the
//     killed case and the count-to-five case red (`Expected: empty`);
//   ③ the recovery-end exclusion removed from `chat_outbox_host.dart` edge 2
//     ⇒ the first case red on the self-queued pass (`Expected: <0> Actual:
//     <1>` held lines);
//   ④ the record read as fresh after every restart
//     (`retained_audio_legacy_retry.dart`) ⇒ 6 of 9 red;
//   ⑤ an unverified result whose marker never reached disk released instead
//     of counted ⇒ that case red (`Expected: <1> Actual: <0>`).
//   ⑥ (round 2, review B1) a concluded start not counted
//     (`LegacyRetryStatus.concluded` leaving `starts` as it was) ⇒ the
//     six-segment case red at `Actual: <6>`, the reviewer's reading;
//   ⑦ (round 2, review B3, billing) the six-day window left out of
//     `LegacyRetryStatus.stoppedAt` ⇒ 4 red (the retention case and the
//     three clock-safety cases: `Expected: empty`, a start went out);
//   ⑧ (round 2, billing) the two clock-rollback checks in `windowClosedAt`
//     removed ⇒ the future-first-start and earlier-than-last-start cases red.
//   ⑨ (round 3, review B4) the stop never written down (`_latchStopped` in
//     `backfill_legacy_leg.dart` returning at once) ⇒ the two B4 cases red,
//     each on a start that went out after the stop was shown: the rollback
//     case on the review's second start (`Expected: an object with length of
//     <1>`), the restart case on a first start after reopening (`Expected:
//     empty`).
// ⚠️ Round 3 (review B5, MAIN decision): the six-day window is a cost / UX
// bound from now on, not the billing guarantee — the relay keeps a recovery
// operation's metering claim for 90 days (book 22 §4.11, branch
// `lane/nr138-nocharge`), which covers a clock set back by up to 84 days. The case that pinned the window a day inside
// the relay's seven-day claim retention, by reading `schema-recovery.ts`, is
// retired: the number it compared against no longer decides a second debit.
// `backfill_channel_test.dart` 「legacy killed before results…」 pins the
// reservation being written at all: with it skipped that case went red
// (`Expected: empty`, the fresh application started at once).

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/legacy_retry_budget.dart'
    show kLegacyAutoWindow;
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/legacy_backfill_rig.dart';

const Duration kMin = Duration(minutes: 1);

/// Every timeline write fails, so a replay's rows never pass readback.
class _RefusingWrites extends InMemoryTimelinePersistence {
  @override
  Future<void> upsert(TimelineEntry entry) async =>
      throw StateError('injected persistence failure');
}

int heldLines() => DiagLog.instance
    .snapshot()
    .where((String l) => l.contains('audio.recovery.legacy_held'))
    .length;

Future<PendingRecoveryItem> itemOf(LegacyRig rig, String key) async =>
    (await rig.pending.list()).singleWhere((PendingRecoveryItem i) => i.id == key);

void main() {
  test(
      '🔴 a stalled legacy segment: five starts 1/2/4/8 minutes apart, then '
      'it stops — queued passes cannot bypass it and later recordings still '
      'run', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-a');
    rig.relay.stallEveryStart = true;
    DiagLog.instance.clear();

    // Every start below is run-a's except the one run-b gets; counted on the
    // wire, whatever the frame carries.
    int starts() => rig.relay.starts.length;

    await rig.sweep();
    expect(starts(), 1);
    // ③ — the recovery's own RECORDING → PROCESSING edge queued no pass. A
    // queued pass would have reached the session and found it not yet due.
    expect(heldLines(), 0,
        reason: 'a recovery may not enqueue its own successor (root cause §1)');

    // ① — passes queued before the deadline (link edges, recording ends)
    // reach the send-time check and send nothing.
    for (int i = 0; i < 3; i++) {
      await rig.sweep();
    }
    expect(starts(), 1);
    expect(heldLines(), 3, reason: 'positive control: the passes did run');
    expect(rig.armed?.wait, kMin, reason: 'the RC-O timer waits the backoff');

    // ② — a later recording is not blocked by one that is waiting.
    await rig.seed('run-b');
    rig.relay.stallEveryStart = false;
    rig.relay.replyWords('Later words');
    await rig.sweep();
    expect(starts(), 2, reason: 'run-b ran; run-a was skipped, not retried');
    expect(await rig.store.bytesForSession('run-b'), 0);
    expect(await rig.store.bytesForSession('run-a'), 6400);

    // The remaining four starts, each when its wait has run out.
    rig.relay.stallEveryStart = true;
    for (final (int waitMin, Duration? next) in <(int, Duration?)>[
      (1, const Duration(minutes: 2)),
      (2, const Duration(minutes: 4)),
      (4, const Duration(minutes: 8)),
      (8, null),
    ]) {
      rig.nowMs += Duration(minutes: waitMin).inMilliseconds - 1;
      await rig.sweep();
      final int before = starts();
      rig.nowMs += 1;
      await rig.fireRetry();
      expect(starts(), before + 1,
          reason: 'due after $waitMin min, and not one millisecond earlier');
      if (next != null) expect(rig.armed?.wait, next);
    }
    expect(starts(), 6, reason: 'five for run-a, one for run-b');
    expect(rig.armed?.isActive ?? false, isFalse,
        reason: 'nothing left to wake up for');

    // The cap: half an hour later, every edge, still five.
    rig.nowMs += const Duration(minutes: 30).inMilliseconds;
    await rig.sweep();
    await rig.fireRetry();
    expect(starts(), 6);
    expect(await rig.store.bytesForSession('run-a'), 6400,
        reason: 'the audio stays; only the automatic route stopped');

    final PendingRecoveryItem a = await itemOf(rig, 'run-a');
    expect(a.state, PendingRecoveryState.needsManual);
    expect(a.awaitingTranscription, isTrue);
    expect(rig.runner.progress.value.needsManual, 1);
    expect(rig.runner.progress.value.forArticle('run-a').waitingAuto, isFalse,
        reason: '「waiting for the next automatic attempt」 would now be false');

    // 🔴 DURABLE: a fresh application on the same disk, a day later.
    final LegacyRig after = await LegacyRig.open(
        directory: rig.tmp, startMs: rig.nowMs + const Duration(days: 1).inMilliseconds);
    addTearDown(after.dispose);
    after.relay.replyWords('would be a sixth start');
    await after.sweep();
    expect(after.relay.starts, isEmpty);
    expect((await itemOf(after, 'run-a')).state, PendingRecoveryState.needsManual);
  });

  // Round 2 — the independent review's repro (B1), kept verbatim in shape:
  // round 1 counted failed starts only, and this recording made SIX automatic
  // starts. MAIN ruling: five automatic metered starts per recording, of any
  // outcome; what is left is the person's.
  test('🔴 REVIEW lifetime cap includes successful starts across six segments',
      () async {
    final LegacyRig r = await LegacyRig.open();
    addTearDown(r.dispose);
    for (int i = 0; i < 6; i++) {
      await r.seed('run-six', idx: i);
      r.relay.replyWords('Words for segment $i');
    }
    await r.sweep();
    expect(r.autoStarts, lessThanOrEqualTo(5),
        reason: 'at most five automatic starts per recording, including '
            'successful ones');
    expect(r.autoStarts, 5, reason: 'positive control: five did go out');
    expect(await r.store.pendingSegments(session: 'run-six'), <int>[5],
        reason: 'the sixth segment is still on the phone');
    final PendingRecoveryItem six = await itemOf(r, 'run-six');
    expect(six.state, PendingRecoveryState.needsManual,
        reason: '「the automatic attempts have stopped」 is now true');
    expect(six.actions, contains(PendingRecoveryAction.retryNow));
    final LegacyRetryRecord rec =
        (await r.store.readLegacyRetry('run-six')).record!;
    expect(rec.starts, 5);
    expect(rec.failedStarts, 0);
    // Later edges send nothing more.
    r.nowMs += const Duration(days: 1).inMilliseconds;
    await r.sweep();
    expect(r.autoStarts, 5);
  });

  // ── Round 2, billing (review B2 / B3) ───────────────────────────────────

  // The review's retention probe drove the relay: one automatic job billed,
  // the real pruners run at +8 days, the same job re-sent ⇒ billed again
  // (400/60,000 minutes). MAIN ruling: no relay change; the phone makes no
  // automatic start once six days have passed since the first one.
  test('🔴 REVIEW retention: no automatic start once six days have passed '
      'since the first one', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-old');
    rig.relay.stallEveryStart = true;
    final int t0 = rig.nowMs;
    await rig.sweep();
    expect(rig.relay.starts, hasLength(1));
    final LegacyRetryRecord first =
        (await rig.store.readLegacyRetry('run-old')).record!;
    expect(first.firstAutoStartAtMs, t0);
    expect(first.lastAutoStartAtMs, t0);

    // Control: one millisecond inside the window the second start goes out.
    rig.nowMs = t0 + kLegacyAutoWindow.inMilliseconds - 1;
    await rig.sweep();
    expect(rig.relay.starts, hasLength(2),
        reason: 'positive control: still inside the six-day window');
    expect(rig.armed?.wait, const Duration(milliseconds: 1),
        reason: 'the next due time is past the window, so the timer wakes at '
            'its end and the row stops saying 「waiting」');

    // At the window's end, and at the relay's +8 days: nothing, from any edge.
    for (final Duration at in <Duration>[
      kLegacyAutoWindow + const Duration(minutes: 10),
      const Duration(days: 8),
    ]) {
      rig.nowMs = t0 + at.inMilliseconds;
      await rig.fireRetry();
      await rig.sweep();
      expect(rig.relay.starts, hasLength(2),
          reason: "the automatic window is closed (a cost / UX bound; the "
              "relay's claim keeps the job billed once, book 22 §4.11)");
    }
    expect((await itemOf(rig, 'run-old')).state, PendingRecoveryState.needsManual);
    expect(rig.runner.progress.value.forArticle('run-old').waitingAuto, isFalse);
    expect(await rig.store.bytesForSession('run-old'), 6400);
  });

  for (final String shape in <String>[
    'a first start stored in the future',
    'a clock that now reads earlier than the last start',
    'starts recorded with no first time',
  ]) {
    test('🔴 clock safety: $shape closes the window, never reopens it',
        () async {
      final LegacyRig rig = await LegacyRig.open();
      addTearDown(rig.dispose);
      await rig.seed('run-c');
      final int now = rig.nowMs;
      final LegacyRetryRecord rec = switch (shape) {
        'a first start stored in the future' => LegacyRetryRecord(
            starts: 1, failedStarts: 1, nextEligibleAtMs: now - 1,
            firstAutoStartAtMs: now + 86400000,
            lastAutoStartAtMs: now + 86400000),
        'a clock that now reads earlier than the last start' => LegacyRetryRecord(
            starts: 1, failedStarts: 1, nextEligibleAtMs: now - 1,
            firstAutoStartAtMs: now - 3600000,
            lastAutoStartAtMs: now + 60000),
        _ => LegacyRetryRecord(starts: 1, failedStarts: 1, nextEligibleAtMs: now - 1),
      };
      expect(await rig.store.writeLegacyRetry('run-c', rec), isTrue);
      rig.relay.replyWords('must not be sent');
      await rig.sweep();
      expect(rig.relay.starts, isEmpty);
      expect((await itemOf(rig, 'run-c')).state, PendingRecoveryState.needsManual);
    });
  }

  test('🔴 an automatic pass asks the gate before every segment (review B2)',
      () async {
    final GateChangePersistence persistence = GateChangePersistence();
    final LegacyRig rig = await LegacyRig.open(persistence: persistence);
    addTearDown(rig.dispose);
    await rig.seed('run-g', idx: 0);
    await rig.seed('run-g', idx: 1);
    persistence.change = () => rig.session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': <String>[]});
    rig.relay.replyWords('First segment');
    rig.relay.replyWords('Second segment');
    await rig.sweep();
    expect(rig.relay.starts, hasLength(1));
    final LegacyRetryRecord rec =
        (await rig.store.readLegacyRetry('run-g')).record!;
    expect(rec.starts, 1, reason: 'the refused second segment spent nothing');
    expect(rec.reservedAtMs, isNull);
    expect((await itemOf(rig, 'run-g')).state,
        PendingRecoveryState.serverUnsupported);
  });

  // ── round 3, review B4: `needsManual` is persisted and one-way ──────────
  const int day = 86400000;

  test('🔴 REVIEW B4 observing needsManual at day six cannot be undone by a '
      'later clock rollback', () async {
    final int firstAt = DateTime.utc(2026, 10, 1).millisecondsSinceEpoch;
    final LegacyRig r = await LegacyRig.open(startMs: firstAt);
    addTearDown(r.dispose);
    await r.seed('run-reopen');
    r.relay.stallEveryStart = true;
    await r.sweep();
    r.nowMs = firstAt + 6 * day + 1;
    await r.sweep();
    expect(r.relay.starts, hasLength(1));
    expect((await itemOf(r, 'run-reopen')).state, PendingRecoveryState.needsManual);
    // The clock goes back to day five — still later than the last start.
    r.nowMs = firstAt + 5 * day;
    await r.fireRetry();
    await r.sweep();
    expect(r.relay.starts, hasLength(1),
        reason: 'a stop already shown cannot be reopened by the clock');
    expect((await r.store.readLegacyRetry('run-reopen')).record!.autoStoppedAtMs,
        firstAt + 6 * day + 1,
        reason: 'the stop was written down when it was observed');
    expect((await itemOf(r, 'run-reopen')).state, PendingRecoveryState.needsManual);
    expect((await itemOf(r, 'run-reopen')).actions,
        contains(PendingRecoveryAction.retryNow),
        reason: 'Re-transcribe is still the way forward');
    expect(await r.store.bytesForSession('run-reopen'), 6400);
  });

  test('🔴 REVIEW B4 the written stop survives a restart onto a rolled-back '
      'clock', () async {
    final int firstAt = DateTime.utc(2026, 10, 1).millisecondsSinceEpoch;
    final LegacyRig r = await LegacyRig.open(startMs: firstAt);
    await r.seed('run-restart');
    r.relay.stallEveryStart = true;
    await r.sweep();
    r.nowMs = firstAt + 6 * day + 1;
    expect((await itemOf(r, 'run-restart')).state,
        PendingRecoveryState.needsManual,
        reason: 'the list is where a person sees 「stopped」 — that is enough');
    final Directory kept = await Directory.systemTemp.createTemp('nr138-b4-');
    for (final FileSystemEntity e in r.tmp.listSync()) {
      if (e is File) await e.copy('${kept.path}/${e.uri.pathSegments.last}');
    }
    await r.dispose();
    final LegacyRig reopened =
        await LegacyRig.open(directory: kept, startMs: firstAt + 5 * day);
    addTearDown(reopened.dispose);
    reopened.relay.replyWords('must never leave');
    await reopened.sweep();
    await reopened.fireRetry();
    expect(reopened.relay.starts, isEmpty);
    expect((await itemOf(reopened, 'run-restart')).state,
        PendingRecoveryState.needsManual);
  });

  test('🔴 a stop marker this build cannot read keeps the route stopped', () async {
    final LegacyRig r = await LegacyRig.open();
    addTearDown(r.dispose);
    await r.seed('run-mark');
    await r.budgetFile('run-mark').writeAsString(
        '{"v":1,"starts":1,"failed_starts":1,"auto_stopped_at_ms":"later"}');
    r.relay.replyWords('must not be sent');
    await r.sweep();
    expect(r.relay.starts, isEmpty);
    expect((await itemOf(r, 'run-mark')).state, PendingRecoveryState.needsManual);
  });

  test('🔴 killed with the attempt out: the reservation counts as a failed '
      'start after restart', () async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-nr138k-');
    final RetainedAudioStore seeder = RetainedAudioStore(dir: tmp);
    await seeder.open();
    seeder.beginSession('run-k');
    await seeder.append(segmentIdx: 0, bytes: Uint8List(6400));
    seeder.endSession();
    // What a process killed between `audio:start` and its ending leaves.
    expect(await seeder.writeLegacyRetry('run-k', const LegacyRetryRecord(
        failedStarts: 0, reservedAtMs: 5000000, reservedBy: 'r-dead')), isTrue);
    await seeder.dispose();

    final LegacyRig rig = await LegacyRig.open(directory: tmp, startMs: 5000000);
    addTearDown(rig.dispose);
    rig.relay.replyWords('Recovered after the wait');
    await rig.sweep();
    expect(rig.relay.starts, isEmpty,
        reason: 'the interrupted start was spent and waits its backoff');
    rig.nowMs += kMin.inMilliseconds;
    await rig.fireRetry();
    expect(rig.relay.starts, hasLength(1));
    expect(await rig.store.bytesForSession('run-k'), 0);
    expect(rig.budgetFile('run-k').existsSync(), isFalse,
        reason: 'no audio left ⇒ no record left');
  });

  test('a reservation that brings the count to five stops the route', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-x');
    expect(await rig.store.writeLegacyRetry('run-x', LegacyRetryRecord(
        starts: 4, failedStarts: 4, reservedAtMs: rig.nowMs, reservedBy: 'r-dead')), isTrue);
    rig.nowMs += const Duration(days: 1).inMilliseconds;
    await rig.sweep();
    expect(rig.relay.starts, isEmpty);
    expect((await itemOf(rig, 'run-x')).state, PendingRecoveryState.needsManual);
  });

  for (final String shape in <String>['garbage', 'directory', 'newer version']) {
    test('🔴 an unreadable record ($shape) blocks the route; it is never read '
        'as zero', () async {
      final LegacyRig rig = await LegacyRig.open();
      addTearDown(rig.dispose);
      await rig.seed('run-u');
      final File f = rig.budgetFile('run-u');
      switch (shape) {
        case 'garbage':
          f.writeAsStringSync('{not json');
        case 'directory':
          Directory(f.path).createSync();
        default:
          f.writeAsStringSync('{"v":2,"failed_starts":0}');
      }
      rig.relay.replyWords('must not be sent');
      await rig.sweep();
      expect(rig.relay.starts, isEmpty);
      expect(await rig.store.bytesForSession('run-u'), 6400);
      expect((await itemOf(rig, 'run-u')).state, PendingRecoveryState.needsManual);
    });
  }

  test('🔴 a reservation that cannot be written means no attempt, and the row '
      'says the route stopped', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-w');
    // The temp file's path is taken by a directory: every write refuses.
    Directory('${rig.budgetFile('run-w').path}.tmp').createSync();
    rig.relay.replyWords('must not be sent');
    await rig.sweep();
    await rig.sweep();
    expect(rig.relay.starts, isEmpty);
    expect((await itemOf(rig, 'run-w')).state, PendingRecoveryState.needsManual,
        reason: 'not 「waiting」: no pass in this process can account for one');
  });

  test('🔴 a kept-unverified result whose marker never reached disk spends a '
      'start (restarts cannot reopen an unbounded loop)', () async {
    final LegacyRig rig = await LegacyRig.open(persistence: _RefusingWrites());
    addTearDown(rig.dispose);
    await rig.seed('run-t');
    // A real filesystem refusal: the marker's path is taken by a directory.
    Directory('${rig.tmp.path}${Platform.pathSeparator}'
            'run-t__seg-0.pcm.unverified.tomb')
        .createSync();
    rig.relay.replyWords('words that never persist');
    await rig.sweep();
    expect(rig.relay.starts, hasLength(1));
    final LegacyRetryRecord rec =
        (await rig.store.readLegacyRetry('run-t')).record!;
    expect(rec.failedStarts, 1,
        reason: 'only the in-memory skip stands between this segment and the '
            'next process; the budget is what bounds that');
    expect(rec.nextEligibleAtMs, rig.nowMs + kMin.inMilliseconds);
    expect(rec.reservedAtMs, isNull);
  });

  test('the record is invisible to the store, the cap and the journal scan',
      () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-v');
    rig.relay.stallEveryStart = true;
    await rig.sweep();
    expect(rig.budgetFile('run-v').existsSync(), isTrue,
        reason: 'positive control: the failed start was recorded');
    expect(await rig.store.pendingSessions(), <String>['run-v']);
    expect(await rig.store.pendingSegments(session: 'run-v'), <int>[0]);
    final RetainedAudioStore reopened = RetainedAudioStore(dir: rig.tmp);
    await reopened.open();
    expect(reopened.retainedBytes, 6400, reason: 'not counted against the cap');
    await reopened.dispose();
    final List<RecordingScan> scans =
        await RetainedAudioJournalScan.scan(dirPath: rig.tmp.path);
    expect(scans.map((RecordingScan s) => s.recordingId),
        isNot(contains(contains('legacy-retry'))));
    expect((await rig.pending.list()).map((PendingRecoveryItem i) => i.id),
        <String>['run-v'], reason: 'one row, the session itself');
  });
}
