// Shared rig for the LS-1b live-settle test files -- split out of
// `live_settle_test.dart` under the test-file size cap (`verify:lint
// file-size`), VERBATIM apart from dropping the leading underscore off each
// name so it is visible across files (Dart privacy is per-library).
//
// SPEC-REF: see `live_settle_test.dart`'s own header for the card and the
// owner rulings this rig exists to prove against.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';

import 'di.dart';
import 'fakes.dart';
import 'temp_teardown.dart';

/// 🔴 THE RIG USED TO BREAK THE WRITE IT WAS WAITING FOR. This class is the fix,
/// and the measurement that produced it is worth keeping because the failure
/// looked exactly like a product defect.
///
/// [Rig.awaitSettleOf] polls `<id>.manifest.json` every 2 ms. The settle
/// PUBLISHES that manifest by renaming `<id>.manifest.json.tmp` over it, and on
/// Windows a reader that holds the target open makes that rename fail with
/// `PathAccessException … (OS Error: access denied, errno = 5)`. The journal's
/// `_commitLocked` catches a failed publish, keeps the facts in memory and
/// RETURNS NORMALLY (A9 P1-1 ③ — a commit failure must not stop capture), and
/// the settle's own journal handle is opened without a [ManifestRepublishQueue]
/// and without a notices listener, so nothing retried it and nothing said so.
/// The rig then waited out its whole budget and reported
/// 「state=pending attempts=[]」 — a sentence about the product, produced by the
/// observer.
///
/// MEASURED 2026-09-07 (dev-pc-a, 12 concurrent runs of
/// `live_settle_test.dart`): with the instrumented commit, the failing case
/// always showed the rename throwing errno 5 between `precommit` and the
/// handle's close, on the path the poll was reading. A standalone drill on the
/// same machine renamed onto a path 4,135 times with nobody reading it (273
/// failures, 6.6%) and 4,087 times with a `readAsString` loop on the target
/// (2,458 failures, 60%).
///
/// ⚠️ SO THE MUTEX IS THE POINT, NOT THE RETRY. Serialising the rig's reads
/// against the product's publishes removes the interference the rig itself
/// introduced; it does not paper over a publish that failed for any other
/// reason, and [publishFailures] is reported when the wait expires precisely so
/// that case cannot be read as this one.
class RigJournalFs implements JournalFileSystem {
  RigJournalFs([this._inner = const IoJournalFileSystem()]);

  final JournalFileSystem _inner;

  /// Publishes that threw anyway — environment, not product. Surfaced by
  /// [Rig.awaitSettleOf] when it gives up, so a hang has a named cause.
  final List<String> publishFailures = <String>[];

  Future<void> _lock = Future<void>.value();

  /// One at a time, in the order asked. The rig's own reads take this too, so a
  /// poll can never sit on the path a rename is about to land on.
  Future<T> guard<T>(Future<T> Function() body) {
    final Completer<T> out = Completer<T>();
    _lock = _lock.then((_) async {
      try {
        out.complete(await body());
      } on Object catch (e, st) {
        out.completeError(e, st);
      }
    });
    return out.future;
  }

  @override
  Future<void> rename(String from, String to) => guard(() async {
        try {
          await _inner.rename(from, to);
        } on Object catch (e) {
          publishFailures.add('rename $from -> $to: $e');
          rethrow;
        }
      });

  @override
  Future<void> deleteFile(String path) => guard(() => _inner.deleteFile(path));

  @override
  Future<void> ensureDirectory(String path) => _inner.ensureDirectory(path);

  @override
  Future<bool> exists(String path) => _inner.exists(path);

  @override
  Future<int> lengthOf(String path) => _inner.lengthOf(path);

  @override
  Future<Uint8List> readBytes(String path) => _inner.readBytes(path);

  @override
  Future<Uint8List> readRange(String path, int start, int end) =>
      _inner.readRange(path, start, end);

  @override
  Future<void> writeBytes(String path, Uint8List bytes, {bool flush = true}) =>
      _inner.writeBytes(path, bytes, flush: flush);

  @override
  Future<JournalFileHandle> openAppend(String path) => _inner.openAppend(path);

  @override
  Future<List<String>> listNames(String dirPath) => _inner.listNames(dirPath);
}

/// The three bits a metered server must advertise for tier A (A7-3). The rig's
/// channel probe has not run, so the connection reads as metered — the
/// fail-closed direction, and the one production takes until it answers.
const List<String> tierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

/// One 200 ms frame at 16 kHz mono s16le.
const int frameBytes = 6400;

/// Answers `audio:stop` with a terminal `stt:final`, carrying a coverage
/// receipt built from the counters this transport itself observed and the
/// identifiers the phone put on `audio:start`.
class EchoTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunkFrames = 0;

  /// false ⇒ behave like a relay that predates card CV-1: a terminal final with
  /// no receipt on it at all.
  bool withReceipt = true;

  /// Added to the frame count the receipt reports. -1 is 「the server accepted
  /// one fewer frame than we sent」, which is the L2 hole the threshold exists
  /// to catch.
  int fedFramesDelta = 0;

  bool endedNormally = true;

  /// Echo something OTHER than what the phone sent, to reproduce a final that
  /// belongs to a different attempt (drill B-2).
  String? overrideAttemptId;

  /// What the TERMINAL final carries. '' is the server's silence gate:
  /// `stt:final {"text":"","empty_reason":"heard_no_words"}` - drill B-7.
  String finalText = 'the last thing said';

  /// SD-2 — the `empty_reason` an EMPTY terminal final carries, or null.
  ///
  /// 🔴 THE TWO EMPTY FINALS ARE DIFFERENT FRAMES AND THE PHONE NOW TREATS
  /// THEM DIFFERENTLY (card SD-1). WITH the stamp it is the server saying 「this
  /// recording had no words」 and `SegmentBuffer.put` drops the slot's stale
  /// interim; WITHOUT it, it is the flush-cap placeholder
  /// (`apps/server-core/src/stt/flush-final.ts`) and the interims are the only
  /// transcript there is, so they survive and mint the row. Both are real
  /// server behaviour, so the rig has to be able to send either.
  String? finalEmptyReason = 'heard_no_words';

  /// true ⇒ the terminal final does NOT come back on its own; it waits for
  /// [releaseTerminalFinal]. That is the cloud-relay interleaving — the final
  /// arrives after the stop path has closed the journal and stamped it.
  ///
  /// 🔴 THIS REPLACED `Duration? finalDelay` (card D3, 2026-09-15), and the
  /// difference is the whole fix. That field said 「the final comes back in
  /// 150 ms」, and 150 ms is not a fact about the product — it was a bet that
  /// the test would reach its next assertion first. MEASURED on dev-pc-a
  /// (16 cores) with 24 CPU + 8 IO load workers running alongside:
  /// `live_settle_pending_recovery_test.dart` went red 19 times in 20 runs,
  /// every one of them
  ///     Expected: not null
  ///       Actual: <null>
  /// at 「the press really is inside the settle window」 — i.e. the final had
  /// already landed and the settle had already cleared the stamp the case was
  /// about to assert. 0 red in 20 runs on a quiet machine. Two hardcoded time
  /// constants racing, CLAUDE.md's CE-6b shape, and the rule there is to wait
  /// on the event rather than pick a bigger number.
  ///
  /// The ORDERING this models is unchanged and is now guaranteed instead of
  /// hoped for: nothing schedules the final, so it provably cannot arrive
  /// before the test says so.
  bool holdTerminalFinal = false;
  bool _terminalFinalHeld = false;

  /// Let the held terminal final go. Safe to call when nothing is held.
  void releaseTerminalFinal() {
    if (!_terminalFinalHeld) return;
    _terminalFinalHeld = false;
    _pushTerminalFinal();
  }

  /// Segment index the next final will carry. Bumped by [pushSoftSegment] so a
  /// continuous recording's terminal final closes the LAST span.
  int segmentIdx = 0;

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
      chunkFrames = 0;
      segmentIdx = 0;
    }
    if (event == FlowMicEvents.audioChunk) chunkFrames += 1;
    if (event == FlowMicEvents.audioStop && starts.isNotEmpty) {
      // ⚠️ Card UX2-1 — WHEN the terminal final lands decides which of two
      // interleavings the rig models, and they are BOTH real. A microtask puts
      // it inside `AudioCapture.stop()` (a local engine; the settle path closes
      // the journal itself, see `retained_audio_live_settle.dart`); HOLDING it
      // puts it after the stop path finished, which is every cloud-relay press
      // — the shape owner reported UX2-1 on. See [holdTerminalFinal] for why
      // the second arm is a held frame and no longer a delay.
      if (holdTerminalFinal) {
        _terminalFinalHeld = true;
      } else {
        Future<void>.microtask(_pushTerminalFinal);
      }
    }
  }

  /// A soft-segment final: the engine cut the transcript, the recording keeps
  /// going. 🔴 NO RECEIPT — a segment boundary is not a conclusion about a
  /// recording, and the server only puts one on the terminal final.
  void pushSoftSegment(String text) {
    pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': segmentIdx,
      'is_segment': true,
      'duration_ms': 1000,
    });
    segmentIdx += 1;
  }

  /// One interim, the frame the engine emits while it is still guessing.
  void pushInterim(String text) {
    pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': text,
      'confidence': 1,
      'language': 'zh',
      'segment_idx': segmentIdx,
    });
  }

  void _pushTerminalFinal() {
    final Map<String, Object?> s = starts.last;
    pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': finalText,
      if (finalText.isEmpty) 'empty_reason': ?finalEmptyReason,
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': segmentIdx,
      'is_segment': false,
      'duration_ms': 1000,
      if (withReceipt) ...<String, Object?>{
        'coverage_receipt_version': 1,
        'fed_frames': chunkFrames + fedFramesDelta,
        'seq_gaps': 0,
        'drops': 0,
        'engine_leg_rollovers': 0,
        'ended_normally': endedNormally,
        // Echoed, never invented — see the header.
        'recording_id': s['recording_id'],
        'attempt_id': overrideAttemptId ?? s['attempt_id'],
        'range_start_sample': s['range_start_sample'],
        'range_end_sample': s['range_end_sample'],
      },
    });
  }
}

/// A store whose write COMPLETES and whose read never finds anything — the E48
/// shape, and the only one the third condition can actually distinguish.
///
/// ⚠️ 「the commit never completes」 in the literal sense (a future that never
/// resolves) is NOT this class, and is deliberately not the primary case: the
/// settle then simply never runs, nothing is deleted, and no assertion can tell
/// that apart from a hang. It is covered by its own case below, which asserts
/// the only thing observable — that nothing went.
class FailingPersistence extends InMemoryTimelinePersistence {
  @override
  Future<void> upsert(TimelineEntry entry) async =>
      throw StateError('disk is gone');
}

/// A store whose write never returns at all.
class StallingPersistence extends InMemoryTimelinePersistence {
  final Completer<void> released = Completer<void>();

  @override
  Future<void> upsert(TimelineEntry entry) => released.future;
}

class Rig {
  Rig._(this.tmp, this.store, this.spill, this.recorder, this.journalFs);

  static Future<Rig> open({
    List<String> capabilities = tierA,
    TimelinePersistence? persistence,
    bool keepBackfill = false,
  }) async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-ls1b-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    // See [RigJournalFs]: the rig's manifest poll and the product's manifest
    // publish are the same file, and on Windows they are mutually exclusive.
    final RigJournalFs journalFs = RigJournalFs();
    final Rig r = Rig._(
      tmp,
      store,
      RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: true,
        journalFs: journalFs,
      ),
      FakeAudioRecorder(),
      journalFs,
    );
    r._build(capabilities, persistence, keepBackfill);
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;
  final FakeAudioRecorder recorder;

  /// The product's journal filesystem, wrapped so this rig's reads and the
  /// product's publishes take turns. See [RigJournalFs].
  final RigJournalFs journalFs;

  late final EchoTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;

  void _build(List<String> capabilities, TimelinePersistence? persistence,
      bool keepBackfill) {
    transport = EchoTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder, spill: spill),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': capabilities});
    timeline = newTestStore(persistence: persistence);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
    // 🔴 THE RECOVERY LEG IS KEPT OUT OF THIS RIG, DELIBERATELY.
    //
    // Every case here measures the LIVE path. The controller's CR-5 edge 2 (a
    // recording ended) fires an unawaited sweep at `pttUp`, and in the window
    // between the live journal closing and its manifest being committed that
    // sweep can pick the same recording up, open a recovery attempt, and get a
    // terminal final of its OWN back - at which point the live settle correctly
    // declines to settle a final that names another attempt (see
    // `live_settle_foreign_final_test`) and the assertions here fail on a
    // property neither test is about. It was 1 run in 4 on a loaded machine.
    //
    // ⚠️ Silencing the runner, NOT deleting the edge: the edge is production
    // and stays wired. `recovery_queue_core_test.dart` is where the leg is
    // measured, and its own rig says the mirror image of this - one runner
    // only, because two verdicts over one journal is a different program.
    //
    // ⚠️ [keepBackfill] IS THE ONE EXCEPTION, AND IT EXISTS BECAUSE OF THE
    // PARAGRAPH ABOVE. Card SD-2 is about that very window, so the case that
    // measures it has to run the leg the other cases silence — and it makes
    // the window deterministic with [_GatedPersistence] instead of hoping for
    // it.
    if (!keepBackfill) controller.backfill.dispose();
  }

  /// One press: down, [frames] whole frames of PCM, up. Returns the recording
  /// id the phone stamped on `audio:start` — read BEFORE the settle, because a
  /// later press would replace the stamp.
  ///
  /// 🔴 IT WAITS FOR THE JOURNAL, NOT FOR A CLOCK. This used to end on
  /// `pump(20)` — 40 ms — with real file I/O on the other side of it, and on a
  /// loaded machine the settle had not landed yet (3 of 12 oversubscribed
  /// runs). A longer sleep would only move the number: what the caller needs to
  /// know is that the manifest has been written, so that is what is awaited.
  /// [settled] false is for the cases whose whole point is that nothing ever
  /// settles — they must not hang here waiting for a write that is not coming.
  Future<String> press({int frames = 3, bool settled = true}) async {
    await session.pttDown();
    final String? id = spill.liveAttempt?.recordingId;
    for (int i = 0; i < frames; i++) {
      recorder.feed(makePcm(frameBytes));
      await pump();
    }
    await session.pttUp();
    await pump(4);
    if (settled) await awaitSettleOf(id!);
    await quiesce();
    return id!;
  }

  /// Wait until the live settle has committed this recording's manifest.
  ///
  /// The observable it waits on is the one the settle writes LAST for its own
  /// outcome: a `live` attempt carrying an `outcome`. Bounded, because a test
  /// that hangs reports nothing at all.
  /// 🔴 IT FAILS ON EXPIRY, IT DOES NOT RETURN. This used to run out its
  /// budget and fall out of the loop silently, so a settle that was merely
  /// SLOW came back to the caller as a settle that had HAPPENED — and the
  /// case then failed on whatever the stop path had left on disk. MEASURED
  /// 2026-09-07: `live_kept_audio_test (LK-1) a receipt that was PROMISED and
  /// did not arrive` reported `Expected: 'settled_unverified'  Actual:
  /// 'pending'` in a full-suite run (2 minutes of parallel isolates), which
  /// reads as a product defect and is a fixture giving up. The budget is also
  /// no longer 5 s: the whole suite is the load this rig actually runs under.
  Future<void> awaitSettleOf(String id, {int budgetMs = 20000}) async {
    final DateTime end =
        DateTime.now().add(Duration(milliseconds: budgetMs));
    while (DateTime.now().isBefore(end)) {
      final RecordingManifest? m = await manifestOf(id);
      JournalAttempt? live;
      for (final JournalAttempt a in m?.attempts ?? const <JournalAttempt>[]) {
        if (a.kind == 'live') live = a;
      }
      if (live != null && live.outcome != null) {
        // ⚠️ THE MANIFEST IS COMMITTED BEFORE THE BYTES GO, on purpose
        // (A6-3: a crash between the two leaves audio that is merely eligible).
        // So the outcome alone is not the end of the story - a caller that
        // stopped here would read the PCM in the window between the two, which
        // is what made this rig's healthy cases flaky under load.
        if (live.outcome != JournalAttempt.outcomeSettled) return;
        if (!pcmOf(id).existsSync()) return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    final RecordingManifest? m = await manifestOf(id);
    throw StateError('awaitSettleOf($id) gave up after ${budgetMs}ms. '
        'Last manifest: ${m == null ? 'absent' : 'state=${m.recoveryState} '
            'attempts=${m.attempts.map((JournalAttempt a) =>
                '${a.kind}/${a.outcome}').toList()}'}. '
        'This is the rig running out of patience, NOT a product verdict. '
        // 🔴 NAMED, BECAUSE THE TWO CAUSES LOOK IDENTICAL FROM HERE AND CALL
        // FOR OPPOSITE ACTIONS. An empty list means the settle never wrote —
        // look at the product. A non-empty one means the manifest publish
        // THREW: the journal swallows that by design (A9 P1-1 ③) and the
        // settle's handle has no republish queue, so the state on disk stays
        // one commit behind for reasons that are nothing to do with the card
        // under test.
        'Manifest publishes that failed: '
        '${journalFs.publishFailures.isEmpty ? 'none' :
            journalFs.publishFailures.join(' ; ')}');
  }

  /// 🔴 KEEP THE RECOVERY LEG OUT OF THE LIVE LEG'S ASSERTIONS. The controller's
  /// CR-5 edge 2 (a recording ended) fires an unawaited sweep, and between the
  /// live journal closing and its manifest being committed that sweep can pick
  /// the same recording up and append an `auto_retry` attempt — which is a real
  /// window in production (reported), and here it made `attempts` assertions
  /// fail on a test about neither. Waiting for the sweep to finish before
  /// asserting makes the outcome deterministic instead of load-dependent.
  ///
  /// ⚠️ Same rule as [awaitSettleOf]: expiry is reported, not swallowed.
  Future<void> quiesce({int budgetMs = 20000}) async {
    final DateTime end =
        DateTime.now().add(Duration(milliseconds: budgetMs));
    while (controller.backfill.isBusy && DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    if (controller.backfill.isBusy) {
      throw StateError('quiesce gave up after ${budgetMs}ms with the '
          'backfill runner still busy.');
    }
  }

  Future<void> pump([int turns = 4]) async {
    for (int i = 0; i < turns; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
  }

  File pcmOf(String id) => File(
      '${tmp.path}${Platform.pathSeparator}$id${RetainedAudioJournal.pcmSuffix}');

  /// 🔴 THE READ RETRIES, BECAUSE A COMMIT PUBLISHES BY RENAME. Every
  /// `_commitLocked` writes `<id>.manifest.json.tmp` and renames it over
  /// `<id>.manifest.json`; on Windows that rename and a reader's open on the
  /// same path are mutually exclusive, so [awaitSettleOf]'s 2 ms poll could
  /// land inside the swap and throw `PathAccessException … errno = 32`
  /// (MEASURED 2026-09-07 under an 8-way oversubscribed run of this file).
  /// The file is not corrupt and the product is not wrong — the observer is
  /// simply not allowed to look at that instant, so it looks again.
  ///
  /// ⚠️ BOUNDED, AND IT RETHROWS AT THE END: a path we can never read is a
  /// real failure and must not be reported as 「no manifest」, which is a
  /// different fact and one several cases assert.
  Future<RecordingManifest?> manifestOf(String id) async {
    final File m = File('${tmp.path}${Platform.pathSeparator}$id'
        '${RetainedAudioJournal.manifestSuffix}');
    for (int i = 0;; i++) {
      // 🔴 THROUGH THE SAME GATE THE PRODUCT'S PUBLISH TAKES. Reading this path
      // while a rename is landing on it is what used to make the publish fail
      // (see [RigJournalFs]); `guard` makes the two take turns instead. The
      // retry below stays: it covers a collision with anything else on the
      // machine, which this rig does not get to serialise.
      final String? body = await journalFs.guard<String?>(() async {
        if (!m.existsSync()) return null;
        return m.readAsString();
      }).catchError((Object e) {
        if (e is FileSystemException && i < 40) return null;
        throw e;
      });
      if (body == null) {
        if (!m.existsSync()) return null;
        await Future<void>.delayed(const Duration(milliseconds: 5));
        continue;
      }
      return RecordingManifest.decode(body);
    }
  }

  /// 🔴 THE SPILL OUTLIVES ALL THREE OBJECTS ABOVE, AND THAT IS WHAT MADE
  /// THIS RIG FLAKY ON WINDOWS. `session.dispose()` reaches `AudioCapture
  /// .dispose()`, which closes the capture's streams and does NOT touch the
  /// spill; the live settle rides the spill's own journal queue and releases
  /// its PCM handle in a `finally` AFTER the manifest commit that
  /// [awaitSettleOf] waits on. So the rig used to delete [tmp] with a handle
  /// still open inside it: `PathAccessException … errno = 32`, on a different
  /// test each run (7 of 8 oversubscribed runs of this file reproduced it,
  /// 2026-09-07, dev-pc-a).
  ///
  /// ⚠️ The awaits are the fix; [removeTempDir]'s retry is only a net for
  /// handles no product object owns.
  Future<void> dispose() async {
    await controller.dispose();
    await session.dispose();
    timeline.dispose();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }
}

