// Card LS-1b — WHAT HAPPENS TO A HEALTHY LIVE RECORDING'S AUDIO.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md §Chose 3 (the threshold) / §Chose 4 O-1 (success ⇒ delete)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A5-3, §A6-3, §A9 E25
//
// 🔴 THE RIG DRIVES A REAL PRESS, NOT THE PREDICATE. `recovery_queue_core_test
// .dart` already covers `evaluateRecoverySettle` as a function; what is
// unproven until here is that the LIVE path reaches it with the right inputs and
// that the file on disk actually goes. Every case below starts at
// `session.pttDown()`, feeds PCM through the real capture, releases, and lets
// the server's own terminal final come back.
//
// 🔴 THE TRANSPORT ECHOES WHAT THE PHONE SENT — it never invents an id. A
// fixture that made up a `recording_id` would make `receiptMismatch`
// unreachable and every case here would pass for the wrong reason (the same
// note the RC-1a rig carries, and for the same reason).
//
// This file holds every case except the UX2-1 widget group, which lives in
// `live_settle_pending_recovery_test.dart` (split under the test-file size
// cap — `verify:lint file-size`). The shared rig both files drive is
// `support/live_settle_rig.dart`.

import 'dart:io';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/live_settle_rig.dart';
import 'support/temp_teardown.dart';

void main() {
  late Rig r;

  tearDown(() => r.dispose());

  group('live_settle_healthy_recording_test', () {
    test('a healthy press releases its bytes and leaves a settled manifest',
        () async {
      r = await Rig.open();
      final String id = await r.press();

      expect(r.timeline.entries, isNotEmpty,
          reason: 'positive control: the terminal final minted a row');
      expect(r.pcmOf(id).existsSync(), isFalse,
          reason: 'all three conditions held, so the audio goes (ruling O-1)');
      final RecordingManifest? m = await r.manifestOf(id);
      expect(m, isNotNull,
          reason: 'the manifest STAYS - it is the record of where the words '
              'went, and the TTL sweep takes it later');
      expect(m!.settled, isTrue);
      expect(m.recoveryState, RecoveryQueueState.settled);
      expect(m.resultRef, r.timeline.entries.first.id);
      expect(m.attempts, hasLength(1));
      expect(m.attempts.single.kind, 'live');
      expect(m.attempts.single.outcome, JournalAttempt.outcomeSettled);
    });

    test('the frame count compared is the CAPTURE\'s, not a byte division',
        () async {
      r = await Rig.open();
      final String id = await r.press(frames: 5);
      // 5 frames in, 5 accepted, settled. The number is only interesting
      // because the next case moves it by one.
      expect(r.transport.chunkFrames, 5);
      expect(r.pcmOf(id).existsSync(), isFalse);
    });
  });

  group('live_settle_refusals_keep_the_bytes_test', () {
    test('an old server sends no receipt: kept, settled_unverified, no_receipt',
        () async {
      r = await Rig.open();
      r.transport.withReceipt = false;
      final String id = await r.press();

      expect(r.pcmOf(id).existsSync(), isTrue,
          reason: 'no proof of coverage ⇒ the bytes stay');
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.settled, isFalse);
      expect(m.recoveryState, RecoveryQueueState.settledUnverified);
      expect(m.attempts.single.outcome,
          JournalAttempt.outcomeSettledUnverified);
      expect(m.attempts.single.failureCode, contains('noReceipt'));
      expect(m.resultRef, isNotNull,
          reason: 'a row exists either way; settled_unverified means 「cannot '
              'prove it」, not 「nothing came of it」');
    });

    test('fed_frames one short of what we sent keeps the bytes', () async {
      r = await Rig.open();
      r.transport.fedFramesDelta = -1;
      final String id = await r.press(frames: 4);

      expect(r.pcmOf(id).existsSync(), isTrue);
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.settled, isFalse);
      expect(m.attempts.single.failureCode, contains('frameCountMismatch'));
    });

    test('a server that advertises nothing (tier C) deletes nothing', () async {
      r = await Rig.open(capabilities: const <String>[]);
      final String id = await r.press();

      expect(r.pcmOf(id).existsSync(), isTrue);
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.attempts.single.failureCode, contains('serverTierKeepsBytes'));
    });

    test('the row was written and cannot be read back: kept', () async {
      // 🔴 THE REVERSE CONTROL LIVES ON THIS CASE. Condition (iii) is two facts
      // and only the READ-BACK is load-bearing here: the write threw, so
      // `awaitPersisted` completes (its own doc says it completes on failure
      // too) and a settle that trusted the handle alone would delete the only
      // other copy of these words.
      //
      // MEASURED 2026-09-06 (reverse control, really run): replacing the two
      // lines of condition (iii) in session/live_settle.dart with
      // `const bool persisted = true;` turns THIS case and the stalled one
      // below into
      //   Expected: true  Actual: <false>
      // on the `pcmOf(id).existsSync()` assertion — i.e. the only remaining
      // copy of the words was deleted on the strength of 「a row object
      // exists」. Reverted; both green again; grep for the marker used
      // (REVERSE-CONTROL-LS1B) finds nothing outside build caches.
      r = await Rig.open(persistence: FailingPersistence());
      final String id = await r.press();

      expect(r.pcmOf(id).existsSync(), isTrue);
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.settled, isFalse);
      expect(m.attempts.single.failureCode, contains('rowNotPersisted'));
    });

    test('a persisted commit that never returns deletes nothing', () async {
      // The literal 「stalls」 case. There is no verdict to assert — the settle
      // is parked on the handle — so what is asserted is the only observable
      // fact, and it is the one that matters: the audio is still there.
      final StallingPersistence p = StallingPersistence();
      r = await Rig.open(persistence: p);
      // ⚠️ `settled: false` - this case's whole premise is that no verdict
      // is ever written, so the rig must not wait for one.
      final String id = await r.press(settled: false);
      await r.pump(20);

      expect(r.pcmOf(id).existsSync(), isTrue);
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.settled, isFalse,
          reason: 'nothing was decided, so nothing was claimed');
      p.released.complete();
    });
  });

  group('live_settle_empty_result_test (drill B-7 / B-1 / D-7)', () {
    test('an interim survives an empty final, and the audio is KEPT anyway',
        () async {
      // 🔴 WHAT THIS CASE IS ABOUT: a row exists, the FINAL carried no
      // words, and A5-4 says an empty result may never license a delete. The
      // settle path reads the FINAL's own text (`resultText`), not the row's,
      // and that distinction is the whole card.
      //
      // ⚠️ THE FRAMES ARE NO LONGER DRILL B-7's, AND THE REASON MATTERS. B-7
      // was `stt:interim {"text":"."}` + an empty final stamped
      // `empty_reason:"heard_no_words"`, and the row it minted said "." — which
      // card SD-1 then established was itself a defect (that "." was also
      // injected into the user's PC). Under SD-1 that sequence mints NO row, so
      // it can no longer set this case up: with no row there is no settle to
      // refuse. What is used instead is the OTHER empty final that production
      // really emits — the flush-cap placeholder, which carries no
      // `empty_reason` — behind a real word. Row minted, final empty, same
      // `emptyResult` refusal, same A5-4 question. The 40 s (B-1 run 2) and
      // 18.4 MiB (D-7) measurements were on this same settle path.
      r = await Rig.open();
      r.transport.finalText = '';
      r.transport.finalEmptyReason = null;
      await r.session.pttDown();
      final String id = r.spill.liveAttempt!.recordingId;
      for (int i = 0; i < 3; i++) {
        r.recorder.feed(makePcm(frameBytes));
        await r.pump();
      }
      r.transport.pushInterim('喂');
      await r.pump();
      await r.session.pttUp();
      await r.pump(4);
      await r.awaitSettleOf(id);
      await r.quiesce();

      expect(r.timeline.entries, isNotEmpty,
          reason: 'positive control: the interim really did mint a row, '
              'which is why the ROW text cannot be the input');
      expect(r.pcmOf(id).existsSync(), isTrue,
          reason: 'A5-4: an empty result may never license a delete');
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.settled, isFalse);
      expect(m.recoveryState, RecoveryQueueState.settledUnverified);
      final JournalAttempt live =
          m.attempts.firstWhere((JournalAttempt a) => a.kind == 'live');
      expect(live.failureCode, 'emptyResult',
          reason: 'the ONLY refusal - everything else about this attempt was '
              'perfect, which is exactly why it deleted the audio before');
    });

    test('the pending screen calls it out in its own words', () async {
      // The manifest above, read back through the production store's routing.
      // `recovery_copy_matches_capability_test.dart` owns the sentence itself
      // (all nine languages); what is unproven without this is that a manifest
      // in this state reaches that sentence at all.
      // Same frame choice as the case above, for the same SD-1 reason.
      r = await Rig.open();
      r.transport.finalText = '';
      r.transport.finalEmptyReason = null;
      await r.session.pttDown();
      final String id = r.spill.liveAttempt!.recordingId;
      r.recorder.feed(makePcm(frameBytes));
      await r.pump();
      r.transport.pushInterim('喂');
      await r.pump();
      await r.session.pttUp();
      await r.pump(4);
      await r.awaitSettleOf(id);
      await r.quiesce();

      final PendingRecoveryStore store = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'zh');
      final List<PendingRecoveryItem> items = await store.list();
      final PendingRecoveryItem it =
          items.firstWhere((PendingRecoveryItem i) => i.id == id);
      expect(it.state, PendingRecoveryState.emptyResult);
      expect(it.actions, contains(PendingRecoveryAction.retryNow),
          reason: 'no words were produced, so a retry against a working '
              'engine still has something to do - unlike settled_unverified');
      expect(it.actions, contains(PendingRecoveryAction.delete));
    });
  });

  group('live_settle_foreign_final_test (drill B-2)', () {
    test('a final that names another attempt settles nothing here', () async {
      // 🔴 MEASURED 2026-09-06: a 3 s link loss mid-press left the
      // recording to the recovery leg, whose re-transcription produced a
      // terminal final through the SAME inbound path. This leg settled the live
      // attempt against that receipt - `receiptMismatch` on frames that in fact
      // matched (36 == 36) - and its own journal handle then wrote
      // `settled_unverified` over the recovery leg's `settled`, taking the
      // auto_retry attempt's `outcome` with it.
      r = await Rig.open();
      r.transport.overrideAttemptId = 'a-somebody-elses-attempt-0';
      final String id = await r.press(settled: false);
      await r.pump(20);
      await r.quiesce();

      expect(r.timeline.entries, isNotEmpty,
          reason: 'positive control: the final was delivered and made a row');
      final RecordingManifest? m = await r.manifestOf(id);
      final Iterable<JournalAttempt> live =
          (m?.attempts ?? const <JournalAttempt>[])
              .where((JournalAttempt a) => a.kind == 'live');
      expect(live, isEmpty,
          reason: 'this press wrote no verdict at all: the conclusion belongs '
              'to the leg that opened that attempt');
      expect(r.pcmOf(id).existsSync(), isTrue,
          reason: 'and nothing was deleted on the strength of it');
    });
  });

  group('live_settle_continuous_recording_test', () {
    test('three soft segments and one terminal final settle exactly once',
        () async {
      r = await Rig.open();
      await r.session.pttDown();
      final String id = r.spill.liveAttempt!.recordingId;
      for (int i = 0; i < 3; i++) {
        r.recorder.feed(makePcm(frameBytes));
        await r.pump();
        // 🔴 A SEGMENT IS THE SERVER'S UNIT. Each of these mints a row and
        // settles nothing on disk: the journal is per RECORDING, and deleting
        // after segment 1 would take the audio segments 2 and 3 are still
        // being written into.
        r.transport.pushSoftSegment('span $i');
        await r.pump();
        expect(r.pcmOf(id).existsSync(), isTrue,
            reason: 'segment $i must not settle the recording');
        expect(await r.manifestOf(id), isNull,
            reason: 'segment $i must not publish a settle verdict');
      }
      r.recorder.feed(makePcm(frameBytes));
      await r.pump();
      await r.session.pttUp();
      await r.pump(4);
      await r.awaitSettleOf(id);
      await r.quiesce();

      expect(r.timeline.entries.length, greaterThanOrEqualTo(4),
          reason: 'positive control: every span became a row');
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.attempts, hasLength(1),
          reason: 'ONE settle for the whole recording, on the terminal final');
      expect(m.settled, isTrue);
      expect(r.pcmOf(id).existsSync(), isFalse);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 🔴 SD-2 — A RECOVERY ATTEMPT MUST NOT OPEN ON A RECORDING BEING SETTLED.
  //
  // THE WINDOW: `AudioCapture.stop()` closes the journal, and the terminal
  // final that settles the recording arrives afterwards. In between,
  // `RetainedAudioSpill.currentRecordingId` is already null and the manifest
  // still says `settled:false` — the two facts
  // `RecoveryJournalLeg._scanCandidates` judges on — while the CR-5 edge-2
  // sweep (`chat_outbox_host.onFsmChangeRouted`, 「a recording just ended」)
  // fires on exactly that transition. The cost to the user is a SECOND,
  // BILLABLE transcription of one press and a second row.
  //
  // ⚠️ THE ASSERTION IS ON `audio:start` FRAMES, not on the manifest. A
  // recovery attempt that opened and then failed still spent the money and
  // still sent the audio; the manifest would only show it if it got far
  // enough to write one.
  //
  // 🔴 REVERSE CONTROL, MEASURED RED (2026-09-06). Deleting the one line
  // `if (s.liveSettlePending) continue;` from
  // `session/recovery_journal_leg.dart` `_scanCandidates` turns the first case
  // into `Expected: empty` against a list holding an `audio:start` whose
  // `attempt_kind` is `auto_retry`, over the recording the live press just
  // finished — the defect itself, on the wire. Restored; the four files of
  // this area green four runs out of four.
  //
  // 🔴 AND A SECOND ONE, MEASURED THE HARD WAY. Stamping with the SPILL's
  // clock (microseconds) instead of a millisecond one leaves this case red in
  // EXACTLY THE SAME WAY as deleting the skip: every stamp reads as already
  // expired, so the guard is present, compiles, and does nothing. The two
  // failures are indistinguishable from the assertion, which is why the reason
  // is written down at the write site rather than here.
  group('live_settle_pending_sweep_test (SD-2)', () {
    test('a sweep between the journal close and the settle starts nothing',
        () async {
      r = await Rig.open(keepBackfill: true);
      // 🔴 THE SPILL'S OWN VERBS, IN THE ORDER `AudioCapture` CALLS THEM.
      // `endRecording(interruptReason: null)` IS the ordinary stop's journal
      // half (audio/audio_capture_journal.dart `_journalEndRecording`), and
      // awaiting it is what makes this deterministic: the close and its commit
      // are on the spill's serial queue, so when it returns the window is open
      // and stays open — no terminal final has arrived to close it.
      //
      // ⚠️ AN EARLIER VERSION DROVE A REAL PRESS AND HELD THE SETTLE INSIDE
      // `awaitPersisted` WITH A GATED STORE. It failed about half the time
      // under load: blocking the timeline write also stalls the stop path that
      // has to run BEFORE the window exists, so the test was racing its own
      // fixture. A test that is flaky about the thing it measures cannot say
      // anything about it.
      await r.spill.beginRecording();
      final String id = r.spill.currentRecordingId!;
      r.spill.appendCaptured(makePcm(frameBytes));
      await r.spill.journalFlush();
      await r.spill.endRecording();

      final RecordingManifest held = (await r.manifestOf(id))!;
      expect(held.liveSettlePendingAtMs, isNotNull,
          reason: 'positive control: the stamp is on disk the moment the '
              'journal closes — without it the sweep below proves nothing');
      expect(held.settled, isFalse,
          reason: 'positive control: from a directory listing this recording '
              'is indistinguishable from an orphan, which is the whole '
              'problem');

      // The CR-5 edge-2 sweep, at the same entry point production uses
      // (`chat_outbox_host.onFsmChangeRouted` → `backfill.sweep`).
      await r.controller.backfill.sweep(sourceLang: 'zh');
      await r.quiesce();

      expect(r.transport.starts, isEmpty,
          reason: 'a recording whose settle is in flight owes nobody a second '
              'transcription');

      // … and the hold ends when the settle publishes, on either outcome.
      await r.spill.publishLiveSettle(
        attempt: r.spill.liveAttempt!,
        rowId: 'row-1',
        reasonCode: 'emptyResult',
        mayDelete: false,
        attemptKindWire: 'live',
        recoveryState: RecoveryQueueState.settledUnverified,
      );
      final RecordingManifest done = (await r.manifestOf(id))!;
      expect(done.liveSettlePendingAtMs, isNull);
      expect(done.settled, isFalse,
          reason: 'settled_unverified is a finished decision, not a delete '
              'licence — and the hold is over either way');
      // ⚠️ AND IT IS STILL NOT SWEPT AFTERWARDS — by a DIFFERENT rule.
      // `settled_unverified` is a finished decision the automatic queue may not
      // re-litigate (`RecoveryJobStatus.mayAutoAttemptAt`), so 「the hold is
      // over」 cannot be demonstrated on this recording. That the hold EXPIRES
      // rather than excludes is measured where it can be measured on its own:
      // `live_settle_pending_expiry_test.dart`.
    });

    test('an interrupted stop is NOT held — no settle is coming for it',
        () async {
      // The narrowing, from the other side. A link loss / fault / cancel ends
      // the recording with a named reason and no terminal final, so nothing
      // will ever settle it; stamping those would delay the recovery queue on
      // exactly the recordings that need it.
      r = await Rig.open(keepBackfill: true);
      await r.session.pttDown();
      final String id = r.spill.liveAttempt!.recordingId;
      r.recorder.feed(makePcm(frameBytes));
      await r.pump();
      r.session.audio.stopForLinkLoss();
      await r.spill.journalFlush();
      await r.pump(4);

      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.liveSettlePendingAtMs, isNull);
    });
  });

  group('live_settle_flag_off_test', () {
    test('with the journal face off nothing is written and nothing settles',
        () async {
      final Directory tmp =
          await Directory.systemTemp.createTemp('flowmic-ls1b-off-');
      final RetainedAudioStore store =
          RetainedAudioStore(dir: tmp, clock: () => 0);
      await store.open();
      final RetainedAudioSpill off = RetainedAudioSpill(store: store);
      addTearDown(() async {
        await off.dispose();
        await store.dispose();
        await removeTempDir(tmp);
      });
      expect(off.retainFromFirstFrame, isFalse,
          reason: 'positive control: this constructor still defaults to the '
              'segment face. ⚠️ NOT the shipped configuration any more - '
              'retained_audio_boot.dart passes '
              'kRetainFromFirstFrameDefault, which is true.');
      expect(off.liveAttempt, isNull);
      await off.beginRecording();
      expect(off.liveAttempt, isNull,
          reason: 'no journal, no stamp, and therefore no audio:start fields');
      r = await Rig.open();
    });
  });

  // ── CARDS LK-1 / LK-2 / LK-4 (2026-09-07) ─────────────────────────────────
  //
  // 🔴 WHAT THE OWNER SAW, AND WHY EVERY ASSERTION BELOW IS ABOUT AN ORDINARY
  // PRESS. Phone 0.3.74 against production relay 0.3.71, which advertises no
  // capabilities at all: four presses of 4 / 5 / 9 / 7 s, every one
  // transcribed and delivered (one honestly 「Delivered · not injected」), and
  // after every one of them the light-record screen grew a 「Recordings waiting
  // to be transcribed」 row leading to a card saying this server cannot recover
  // audio safely. Nothing was waiting and nothing needed recovering.
  //
  // The fail-closed recovery tier was being applied to LIVE recordings. It is
  // the right answer to 「may we re-send this audio to be transcribed again」
  // and the wrong answer to 「did this press work」.
  group('live_kept_audio_test (LK-1)', () {
    test('a receiptless server leaves the press FINISHED, not pending',
        () async {
      r = await Rig.open(capabilities: const <String>[]);
      // A relay that advertises nothing also SENDS nothing: production 0.3.71
      // puts no coverage receipt on the terminal final. Leaving the rig's
      // receipt on would model a server that does not exist and would make
      // this case pass (or fail) for a reason the product never meets.
      r.transport.withReceipt = false;
      final String id = await r.press();

      expect(r.timeline.entries, isNotEmpty,
          reason: 'positive control: the press really did transcribe');
      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.recoveryState, RecoveryQueueState.transcribedUnverified);
      expect(m.settled, isFalse,
          reason: 'not the A5-3 cleared state - the bytes are still here, '
              'they are merely allowed to age out');
      expect(m.resultRef, r.timeline.entries.first.id,
          reason: 'the manifest names where the words went, which is what '
              'makes this state different from a debt');
      expect(r.pcmOf(id).existsSync(), isTrue,
          reason: 'nothing is deleted at settle time on this tier');
      final JournalAttempt live =
          m.attempts.firstWhere((JournalAttempt a) => a.kind == 'live');
      expect(live.failureCode, contains('serverTierKeepsBytes'),
          reason: 'the attempt record still says exactly why - the state is a '
              'routing decision, not a rewriting of what happened');
    });

    test('and it is NOT on the pending list, so no entry row is raised',
        () async {
      // 🔴 THIS IS THE OBSERVED DEFECT, MEASURED THROUGH THE PRODUCTION
      // SOURCE. PendingRecoveryEntry (ui/pending_recovery_entry.dart) draws
      // itself from exactly this call - `rows.isNotEmpty` and nothing else -
      // so an empty list here IS the absent row.
      //
      // REVERSE CONTROL, REALLY RUN 2026-09-07: deleting the
      // `transcribedUnverified` skip in pending_recovery_store.dart's
      // `_addJournal` turns this case red, with the ordinary successful press
      // back on the waiting list. Reverted; green again.
      r = await Rig.open(capabilities: const <String>[]);
      r.transport.withReceipt = false; // as above: 0.3.71 sends none
      final String id = await r.press();

      final PendingRecoveryStore store = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'zh');
      final List<PendingRecoveryItem> items = await store.list();
      expect(items.where((PendingRecoveryItem i) => i.id == id), isEmpty);
      expect(items, isEmpty, reason: 'nothing else is waiting either');
    });

    test('a capability server still deletes at settle, unchanged', () async {
      // The control for the case above: the new state is reachable ONLY when
      // the server says it cannot issue receipts. Everything about tier A is
      // as it was.
      r = await Rig.open();
      final String id = await r.press();

      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.recoveryState, RecoveryQueueState.settled);
      expect(r.pcmOf(id).existsSync(), isFalse);
    });

    test('a receipt that was PROMISED and did not arrive stays unverified',
        () async {
      // 🔴 THE NARROWING. `noReceipt` alone is not enough: a server that
      // advertises the coverage-receipt capability and then sends a final
      // without one is an anomaly about that exchange, and the user keeps the
      // sentence that says we could not confirm it.
      r = await Rig.open();
      r.transport.withReceipt = false;
      final String id = await r.press();

      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.recoveryState, RecoveryQueueState.settledUnverified);
      final PendingRecoveryStore store = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'zh');
      final PendingRecoveryItem it = (await store.list())
          .firstWhere((PendingRecoveryItem i) => i.id == id);
      expect(it.state, PendingRecoveryState.settledUnverified);
    });
  });

  group('live_kept_audio_test (LK-2)', () {
    test(
        'a link-loss stretch on the same server IS listed, with the tier-C '
        'sentence', () async {
      // The other half of LK-2: nothing here is softened for audio that really
      // is owed a transcription. Same receiptless server, same phone; the
      // difference is that this recording never produced a row.
      r = await Rig.open(capabilities: const <String>[], keepBackfill: true);
      await r.session.pttDown();
      final String id = r.spill.liveAttempt!.recordingId;
      r.recorder.feed(makePcm(frameBytes));
      await r.pump();
      r.session.audio.stopForLinkLoss();
      await r.spill.journalFlush();
      await r.pump(4);

      final RecordingManifest m = (await r.manifestOf(id))!;
      expect(m.resultRef, isNull,
          reason: 'positive control: nothing transcribed this stretch');
      expect(m.interruptReason, JournalInterrupt.linkLoss);

      // The tier verdict is the SWEEP's, and the screen reads what it wrote:
      // without a pass having run, nobody has asked this server anything.
      await r.controller.backfill.sweep(sourceLang: 'zh');
      final PendingRecoveryStore store = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'zh');
      final PendingRecoveryItem it = (await store.list())
          .firstWhere((PendingRecoveryItem i) => i.id == id);
      expect(it.state, PendingRecoveryState.serverUnsupported,
          reason: 'this one really cannot be recovered against this server, '
              'and saying so is the whole point of the sentence');
    });
  });

  group('live_kept_audio_test (LK-4)', () {
    test('a press too short to fill one chunk leaves nothing behind',
        () async {
      // Owner saw 「0.6s · this recording cannot be read」 from a stray tap. A
      // press that captured nothing has no words, no recoverable interval and
      // nothing to delete - so it must not become a card offering to delete
      // it.
      //
      // REVERSE CONTROL, REALLY RUN 2026-09-07: removing the
      // `_dropEmptyRecording` branch from `_endRecordingLocked`
      // (audio/retained_audio_live_settle.dart) turns this case red - the
      // empty journal is back on disk. Reverted; green again.
      r = await Rig.open(capabilities: const <String>[]);
      await r.session.pttDown();
      final String id = r.spill.liveAttempt!.recordingId;
      // No `recorder.feed` at all: not one 200 ms chunk, no residual tail.
      await r.session.pttUp();
      await r.pump(8);
      // 🔴 WAIT FOR THE QUEUE, NOT FOR A CLOCK — the same rule
      // [awaitSettleOf] carries. The drop rides `_enqueueJournal` inside
      // `_endRecordingLocked`, and `journalFlush()` is the one verb that is
      // behind everything already queued. With only the 16 ms of `pump(8)`
      // this case read the manifest before the drop ran and failed with
      // `Expected: null  Actual: <Instance of 'RecordingManifest'>` on a
      // loaded machine (MEASURED 2026-09-07, 1 of 8 oversubscribed runs).
      await r.spill.journalFlush();

      expect(await r.manifestOf(id), isNull);
      expect(r.pcmOf(id).existsSync(), isFalse);
      final PendingRecoveryStore store = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'zh');
      expect(await store.list(), isEmpty);
    });

    test('a press that DID capture audio keeps its journal', () async {
      // The reverse direction, and it is the one that matters: the rule is
      // 「nothing was captured」, never 「it was short」. A recording whose bytes
      // exist stays visible and deletable (owner ruling O-2), even when it
      // ends up unreadable later.
      r = await Rig.open(capabilities: const <String>[]);
      final String id = await r.press(frames: 1);

      expect(await r.manifestOf(id), isNotNull);
      expect(r.pcmOf(id).existsSync(), isTrue);
    });
  });
}
