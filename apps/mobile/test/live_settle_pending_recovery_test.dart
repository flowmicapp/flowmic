// Card LS-1b / UX2-1 — THE LIGHT-RECORD "AWAITING TRANSCRIPTION" ROW, DURING
// THE SETTLE WINDOW.
//
// Split out of `live_settle_test.dart` under the test-file size cap
// (`verify:lint file-size`) — this file holds only the UX2-1 widget group;
// every other LS-1b case is still in `live_settle_test.dart`. The two share
// the rig in `support/live_settle_rig.dart` (`Rig`, `EchoTransport`,
// `frameBytes`), moved out VERBATIM apart from the leading underscore each
// name lost so it is visible from both files (Dart privacy is per-library).
//
// SPEC-REF: see `live_settle_test.dart`'s own header for the card and the
// owner rulings this rig exists to prove against.

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/pending_recovery_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/live_settle_rig.dart';

void main() {
  late Rig r;

  tearDown(() => r.dispose());

  // ── Card UX2-1 — THE DOOR, DURING THE SETTLE WINDOW ────────────────────────
  //
  // 🔴 THE OBSERVED DEFECT (owner, 0.3.75, tablet on the cloud relay): 「录音等待
  // 转写」 appeared on the light-record screen after EVERY release, and opening it
  // showed 「没有等待转写的录音」. Between `pttUp` and the terminal final the
  // manifest says `settled:false` and nobody holds the recording open, so this
  // list called it a debt — while `RecoveryJournalLeg._scanCandidates`, reading
  // the same directory, skipped it on `RecordingScan.liveSettlePending`. One
  // fact, two answers; the user got the wrong one, and by the time they tapped,
  // the settle had landed and the page was honestly empty.
  //
  // WHY IT IS RENDERED AND RE-MOUNTED PER SAMPLE. The card this row belongs to
  // (RC-1b) already learned that asserting the model is half the job (anti-
  // façade ⑥). A fresh `PendingRecoveryEntry` per sample asks the product
  // question exactly: 「if the screen were built at THIS instant, would the row
  // be there?」 — which is what a user pressing again, or coming back to the
  // screen, actually does.
  //
  // ⚠️ `tester.runAsync` is unavoidable and `pump` may not be called inside it
  // (CLAUDE.md anti-façade ⑦ (a) records the same trap): the row's read and the
  // journal's writes are real file I/O, so the pattern is pump-outside,
  // await-inside.
  group('pending_recovery_entry (UX2-1) — the settle window', () {
    const AppStrings zh = AppStringsZh();
    final Finder row = find.byKey(const Key('pendingRecovery.entry'));

    /// One sample: 「if this screen were built RIGHT NOW, would the row be
    /// there?」 — a fresh `PendingRecoveryEntry` over the rows the PRODUCTION
    /// store answers with at this instant.
    ///
    /// ⚠️ WHY THE ROWS ARE READ THROUGH `runAsync` AND HANDED TO THE WIDGET,
    /// instead of letting its own `initState` read do it. MEASURED HERE: under
    /// the automated binding the widget's read never resolves at all — mounted
    /// directly over the store, the row stayed absent through ten
    /// runAsync/pump alternations WHILE `store.list()` returned one item in the
    /// same test. That is the harness's event loop, not the product's: real
    /// file I/O started outside `runAsync` does not complete, and `pump` may
    /// not be called inside it. So the READ happens in real time and the
    /// WIDGET is given exactly what the production source said at that moment
    /// — the filter under test (`rows.isNotEmpty`, and everything
    /// `PendingRecoveryStore.list` excluded to produce those rows) is
    /// unchanged; only the plumbing the binding cannot run is stood in for.
    Future<bool> sample(WidgetTester tester, PendingRecoveryStore src) async {
      final List<PendingRecoveryItem> rows =
          (await tester.runAsync(() => src.list()))!;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: PendingRecoveryEntry(
            key: UniqueKey(),
            source: _Snapshot(rows, src),
            strings: zh,
          ),
        ),
      ));
      await tester.pump();
      return row.evaluate().isNotEmpty;
    }

    testWidgets('🔴 it is never mounted between release and settle',
        (WidgetTester tester) async {
      late PendingRecoveryStore src;
      late String id;
      await tester.runAsync(() async {
        r = await Rig.open(capabilities: const <String>[]);
        // 0.3.71 in production sends no coverage receipt; leaving the rig's on
        // would model a server that does not exist.
        r.transport.withReceipt = false;
        // A cloud-relay press: the terminal final comes back over the network,
        // AFTER the stop path closed the journal and stamped it. That is the
        // interleaving owner reported this on, and the one SD-2's stamp
        // covers. (See [EchoTransport.finalDelay] for the other one, which
        // this case deliberately does not model.)
        r.transport.finalDelay = const Duration(milliseconds: 150);
        src = PendingRecoveryStore(
            runner: r.controller.backfill, sourceLang: () => 'zh');
      });

      expect(await sample(tester, src), isFalse,
          reason: 'nothing has been recorded yet');

      await tester.runAsync(() async {
        await r.session.pttDown();
        id = r.spill.liveAttempt!.recordingId;
        for (int i = 0; i < 3; i++) {
          r.recorder.feed(makePcm(frameBytes));
          await r.pump();
        }
        // 🔴 NOT `r.press()`: that waits for the settle, which is the very
        // window this case is about.
        await r.session.pttUp();
        // 🔴 `endRecording` IS UNAWAITED BY THE STOP PATH (it is enqueued on the
        // journal queue — `audio_capture_journal.dart`), so `pttUp` returning
        // does not mean the stamp is on disk. Draining that queue is what makes
        // this case sample the window rather than the moment before it.
        await r.spill.journalFlush();
      });
      // POSITIVE CONTROL ON THE WINDOW ITSELF: without this, 「the row never
      // appeared」 could mean 「there was no window」.
      await tester.runAsync(() async {
        final RecordingManifest? m = await r.manifestOf(id);
        expect(m?.settled, isFalse);
        expect(m?.liveSettlePendingAtMs, isNotNull,
            reason: 'the press really is inside the settle window');
      });

      bool settled = false;
      int samples = 0;
      for (int i = 0; i < 60 && !settled; i++) {
        expect(await sample(tester, src), isFalse,
            reason: 'sample $i, between release and settle');
        samples++;
        await tester.runAsync(() async {
          final RecordingManifest? m = await r.manifestOf(id);
          for (final JournalAttempt a
              in m?.attempts ?? const <JournalAttempt>[]) {
            if (a.kind == 'live' && a.outcome != null) settled = true;
          }
        });
      }
      // POSITIVE CONTROLS. Without the first, a settle that never happened
      // would make every sample above vacuously true; without the second, one
      // sample would be one coin toss.
      expect(settled, isTrue, reason: 'the settle really landed');
      expect(samples, greaterThanOrEqualTo(1),
          reason: 'the window was really sampled at least once');
      expect(await sample(tester, src), isFalse,
          reason: 'and it stays absent afterwards (card LK-1)');
    });

    testWidgets('a recording that really is owed a transcription DOES raise it',
        (WidgetTester tester) async {
      // THE REVERSE DIRECTION, and it is what stops the fix above from being
      // 「hide the row」. A link-loss stretch produced no row, carries no
      // `resultRef`, and is never stamped 「a settle is coming」 — the stamp is
      // written for ORDINARY stops only (retained_audio_live_settle.dart).
      late PendingRecoveryStore src;
      await tester.runAsync(() async {
        r = await Rig.open(capabilities: const <String>[]);
        r.transport.withReceipt = false;
        src = PendingRecoveryStore(
            runner: r.controller.backfill, sourceLang: () => 'zh');
        await r.session.pttDown();
        final String id = r.spill.liveAttempt!.recordingId;
        r.recorder.feed(makePcm(frameBytes));
        await r.pump();
        r.session.audio.stopForLinkLoss();
        await r.spill.journalFlush();
        await r.pump(4);
        final RecordingManifest? m = await r.manifestOf(id);
        expect(m?.resultRef, isNull,
            reason: 'positive control: nothing transcribed this stretch');
        expect(m?.liveSettlePendingAtMs, isNull,
            reason: 'an interrupted stop is never stamped 「a settle is coming」');
      });

      expect(await sample(tester, src), isTrue);
    });
  });
}

/// A [PendingRecoverySource] that answers with rows already read out of the
/// real store (see `sample`'s note), and forwards every ACTION to it — a fake
/// that could act on its own would be measuring itself.
class _Snapshot implements PendingRecoverySource {
  _Snapshot(this.rows, this.inner);

  final List<PendingRecoveryItem> rows;
  final PendingRecoveryStore inner;

  @override
  bool get recordingNow => inner.recordingNow;

  @override
  Future<List<PendingRecoveryItem>> list() async => rows;

  @override
  Future<PendingRetryOutcome> retryNow(PendingRecoveryItem item) =>
      inner.retryNow(item);

  @override
  Future<PendingDeleteOutcome> delete(PendingRecoveryItem item) =>
      inner.delete(item);
}
