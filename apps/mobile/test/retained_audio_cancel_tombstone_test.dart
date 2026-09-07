// Card LS-4 (owner ruling O-5, 2026-09-06) — 「取消后已落盘音频保留但永不自动转」
// ("audio already on disk when the user cancels is KEPT, and is never
// auto-transcribed").
//
// 🔴 THE HEADLINE CASE IS `cancel_never_autobackfilled`, AND IT IS A LIVE
// DEFECT, NOT A FUTURE RISK (§A12 P1-5). With the journal face off — today's
// product — a continuous recording whose uplink dies spills real segment files
// under the article's session key. `BackfillRunner` takes its work from
// `RetainedAudioStore.pendingSessions()`, so before this card a swipe-up cancel
// left those bytes listed and the next recovery edge transcribed them into a
// timeline row.
//
// ⚠️ WHY THE FIRST CASE DRIVES THE REAL RUNNER AND A REAL DIRECTORY. The claim
// is 「nothing will ever feed these bytes back」, and only the production reader
// can support it. Asserting on the store alone would prove that the store
// filters a list; the row that appeared on screen came out of
// `BackfillRunner.sweep`, so the sweep is what has to be silent. Rig shape
// copied from `backfill_channel_test.dart` for that reason.
//
// 🔴 REVERSE CONTROL, RUN AND SEEN RED (twice, and the second run rewrote
// this case). Delete the tombstone filter from
// `RetainedAudioStore.pendingSessions()`:
//   Expected: not contains 'a0-1788657965970305'
//     Actual: ['a0-1788657965970305']
// then also skip that expectation, and the wire assertion fails too:
//   Expected: empty   Actual: [<the recovery's audio:start>]
//
// ⚠️ THE FIRST VERSION OF THIS CASE WAS GREEN WITH BOTH FILTERS DELETED, and
// finding out why is most of what this file is worth. It swept immediately
// after the swipe, with (a) the transport still disconnected and later (b) an
// FSM that refuses `beginBackfill` in the moments after a cancel. Both times
// the zero came from a runner that COULD NOT RUN, not from anything being
// filtered. The defect §A12 P1-5 describes happens on a LATER edge, so the case
// now hands the directory to a fresh run — which is also literally what the
// owner would experience — and a positive control shows that same next-run
// sweep DOES speak when the recording was not cancelled.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md (§Chose 4: O-5)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A4 (取消的语义), §A9 stage 1 (`fenceAndStop` row), §A10 card LS-4,
//     §A12 P1-5

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

/// 16 kHz mono PCM16.
const int kPcmBytesPerSecond = 32000;
const int kOutageBytes = 45 * kPcmBytesPerSecond;

Future<void> until(bool Function() done, {String? why}) async {
  final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
  while (!done()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('timed out waiting for: ${why ?? 'a condition'}');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

/// Answers `audio:stop` the way a server does. Only the positive control arms
/// it: a recovery whose stop is never answered holds the runner's latch for its
/// full settle timeout, and the teardown then times out waiting for a sweep
/// that cannot finish (measured — that is what a plain fake produced here).
class _ReplyingTransport extends FakeSocketTransport {
  List<Map<String, Object?>> replyToNextStop = <Map<String, Object?>>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event != FlowMicEvents.audioStop || replyToNextStop.isEmpty) return;
    final List<Map<String, Object?>> finals = replyToNextStop;
    replyToNextStop = <Map<String, Object?>>[];
    Future<void>(() async {
      for (final Map<String, Object?> f in finals) {
        pushIncoming(FlowMicEvents.sttFinal, f);
        await pumpEventQueue();
      }
    });
  }
}

String _tombPath(Directory dir, String session) =>
    '${dir.path}${Platform.pathSeparator}${session}__cancelled.tomb';

class _Rig {
  _Rig._(this.tmp, this.store, this.spill);

  /// [dir] reuses an existing retention directory — i.e. models THE NEXT RUN
  /// OF THE APP finding what a previous run left behind, which is the moment
  /// §A12 P1-5 describes.
  static Future<_Rig> open({Directory? dir}) async {
    final Directory tmp =
        dir ?? await Directory.systemTemp.createTemp('flowmic-tombstone-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _Rig r = _Rig._(tmp, store, RetainedAudioSpill(store: store));
    r._build();
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;

  late final _ReplyingTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;

  void _build() {
    transport = _ReplyingTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = newTestStore();
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
  }

  /// Start a continuous recording and spill 45 s of PCM with the uplink down —
  /// the measured P1-5 setup. Returns the article id, which is also the store
  /// session key those bytes are filed under.
  Future<String> recordThroughAnOutage() async {
    final String articleId = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    )!;
    await controller.pttDown();
    transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();
    spill.onEvicted(
      BufferedChunk(seq: 0, tsMs: 0, payload: Uint8List(kOutageBytes)),
    );
    await spill.flush();
    expect(await store.bytesForSession(articleId), kOutageBytes,
        reason: 'positive control: the outage really did reach the disk under '
            'this key, so a later empty read means "removed", not "never '
            'written"');
    expect(await store.pendingSessions(), contains(articleId),
        reason: 'positive control: BEFORE the cancel these bytes are pending — '
            'this is the state the defect handed to the recovery queue');
    return articleId;
  }

  /// Tear down without touching the directory — for a case that hands it to
  /// the next run.
  bool keepDir = false;

  Future<void> dispose() async {
    // Let the edge-triggered sweeps finish before the temp directory goes, or
    // one of them raises PathNotFoundException inside the NEXT test.
    //
    // ⚠️ BOUNDED AND NON-FAILING, unlike `backfill_channel_test`'s. The
    // positive control below never releases its press, so its recovery holds
    // the runner's latch until the settle timeout — that is the fixture, not a
    // product fault, and a teardown that FAILS on it reports a passing case as
    // broken (measured: it did).
    final DateTime stop = DateTime.now().add(const Duration(seconds: 3));
    while (controller.backfill.isBusy && DateTime.now().isBefore(stop)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    await controller.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
    if (keepDir) return;
      await removeTempDir(tmp);
  }
}

void main() {
  test(
      'cancel_never_autobackfilled: swiped-away audio is kept, and no sweep '
      'ever offers it', () async {
    final _Rig r = await _Rig.open();
    r.keepDir = true;
    final String articleId = await r.recordThroughAnOutage();

    // ── the user swipes up ─────────────────────────────────────────────────
    await r.session.pttCancel();
    await r.spill.flush();
    await pumpEventQueue();

    // ① The recovery reader no longer offers it. BOTH readers, because the
    //    inner one is reachable with a key held from before the cancel.
    expect(await r.store.pendingSessions(), isNot(contains(articleId)));
    expect(await r.store.pendingSegments(session: articleId), isEmpty);

    // ② THE BYTES ARE STILL THERE — half the ruling, and the half a
    //    "just delete it" implementation would pass ① without.
    expect(await r.store.bytesForSession(articleId), kOutageBytes);

    // ③ The marker is a real file, not an in-memory set a process death would
    //    forget. That is what 「持久 tombstone」 asks for.
    expect(File(_tombPath(r.tmp, articleId)).existsSync(), isTrue,
        reason: 'the tombstone must outlive the process, so it must be on disk');
    expect(await r.store.tombstonedSessions(), contains(articleId));

    // ④ 🔴 THE ACTUAL CLAIM, MEASURED ON THE EDGE THAT ACTUALLY BIT:
    //    THE NEXT RUN OF THE APP. §A12 P1-5's defect is not "the sweep fires
    //    one second after the swipe" — immediately after a cancel the FSM
    //    refuses a backfill anyway, so a sweep here proves nothing (measured:
    //    with BOTH tombstone filters deleted this assertion stayed green,
    //    because `beginBackfill` was refusing, not because anything was
    //    filtered). It is the LATER edge that transcribed the swiped words:
    //    a fresh run opens the same directory, finds orphan bytes, and feeds
    //    them back.
    await r.dispose();
    final _Rig next = await _Rig.open(dir: r.tmp);
    addTearDown(next.dispose);

    expect(await next.store.pendingSessions(), isNot(contains(articleId)),
        reason: 'the tombstone outlived the run that wrote it — that is what '
            'makes it 「持久」');
    next.transport.emitted.clear();
    await next.controller.backfill.sweep(sourceLang: 'zh');
    expect(next.transport.emittedWhere(FlowMicEvents.audioStart), isEmpty,
        reason: 'a recovery that opens a session for cancelled audio IS the '
            'defect: the user threw that sentence away and would get it back '
            'as a timeline row on a later run');
    expect(next.transport.emittedWhere(FlowMicEvents.audioChunk), isEmpty);
    expect(await next.store.bytesForSession(articleId), kOutageBytes,
        reason: 'and the bytes are still kept, on the next run too');
  });

  test('positive control: WITHOUT the cancel, the next run DOES feed the '
      'outage back', () async {
    // 🔴 THE CONTROL THE CASE ABOVE NEEDS. Its verdict is a zero, and a zero
    // is worth nothing until the same rig, on the same edge, is shown to
    // produce a non-zero. Identical setup, identical next-run sweep, no swipe.
    final _Rig r = await _Rig.open();
    await r.recordThroughAnOutage();
    await r.controller.pttUp();
    r.keepDir = true;
    await r.dispose();

    final _Rig next = await _Rig.open(dir: r.tmp);
    addTearDown(next.dispose);
    // Armed so the recovery can COMPLETE; an unanswered stop holds the
    // runner's latch for its whole settle timeout.
    next.transport.replyToNextStop = <Map<String, Object?>>[
      <String, Object?>{
        'text': '断网时说的话',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 45000,
      },
    ];
    await next.controller.backfill.sweep(sourceLang: 'zh');
    expect(next.transport.emittedWhere(FlowMicEvents.audioStart), isNotEmpty,
        reason: 'without a tombstone the next run picks the orphan up — which '
            'is the behaviour the cancel case must NOT show');
    expect(next.transport.emittedWhere(FlowMicEvents.audioChunk), isNotEmpty);
  });

  test('a capture fault is NOT a cancel: no tombstone, still pending',
      () async {
    final _Rig r = await _Rig.open();
    addTearDown(r.dispose);
    final String articleId = await r.recordThroughAnOutage();

    // The verb the pump calls, with the argument the pump passes (the call
    // site itself is pinned by the next case). Driving `_onCaptureFault`
    // end to end would need the recorder's no-audio watchdog to fire on a
    // timer, which measures the watchdog rather than this.
    r.session.audio.fenceAndStop(reason: JournalInterrupt.captureFault);
    await r.spill.flush();
    await pumpEventQueue();

    expect(File(_tombPath(r.tmp, articleId)).existsSync(), isFalse,
        reason: 'nobody threw these words away — a dead microphone must leave '
            'the recording recoverable');
    expect(await r.store.pendingSessions(), contains(articleId));
    expect(await r.store.pendingSegments(session: articleId), isNotEmpty);
  });

  test('each fenceAndStop caller names its own reason, and only one cancels',
      () async {
    // 🔴 A SOURCE-LEVEL ASSERTION, DELIBERATELY. Three of the four call sites
    // sit behind edges this suite cannot reach cheaply (a hardware fault, a
    // server frame, an expired token), and the property under test is not a
    // behaviour — it is 「no two callers share a reason」, which is a property of
    // the call sites themselves.
    String src(String p) => File(p).readAsStringSync();
    expect(src('lib/src/ptt/ptt_edges.dart'),
        contains('fenceAndStop(reason: JournalInterrupt.cancelled)'));
    expect(src('lib/src/ptt/ptt_capture_pump.dart'),
        contains('fenceAndStop(reason: JournalInterrupt.captureFault)'));
    expect(src('lib/src/signaling/auth_expired_handler.dart'),
        contains('fenceAndStop(reason: JournalInterrupt.authDrained)'));
    // ptt_inbound.dart's `audio:auto-stopped` arm is the one call site card
    // LS-4 was not allowed to edit (a concurrent lane owns that file), so it
    // takes the DEFAULT — which is why the default is `autoStopped` rather than
    // something neutral, and why that is load-bearing rather than a taste call.
    expect(
        src('lib/src/ptt/ptt_inbound.dart'), contains('audio.fenceAndStop();'),
        reason: 'if that line ever grows an argument the default stops being '
            'load-bearing, and this expectation should be updated rather than '
            'deleted');
    expect(
      <String>{
        JournalInterrupt.cancelled,
        JournalInterrupt.captureFault,
        JournalInterrupt.autoStopped,
        JournalInterrupt.authDrained,
      },
      hasLength(4),
      reason: 'four callers, four reasons — one shared reason is exactly what '
          'made the cancel disposition unrepresentable under LS-2',
    );
  });

  group('journal face (flag ON)', () {
    late Directory tmp;
    late RetainedAudioStore store;
    late RetainedAudioSpill spill;
    late AudioCapture audio;

    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('flowmic-tomb-journal-');
      store = RetainedAudioStore(dir: tmp, clock: () => 0);
      await store.open();
      store.beginSession('a-1');
      spill = RetainedAudioSpill(store: store, retainFromFirstFrame: true);
      audio = AudioCapture(recorder: FakeAudioRecorder(), spill: spill);
    });

    tearDown(() async {
      await spill.dispose();
      await store.dispose();
      await removeTempDir(tmp);
    });

    Future<RecordingScan> scanOne() async {
      final List<RecordingScan> all =
          await RetainedAudioJournalScan.scan(dirPath: tmp.path);
      expect(all, hasLength(1));
      return all.single;
    }

    test('a cancel writes cancelled:true, and the scan reports it', () async {
      await audio.start(permissionPreflighted: true);
      await spill.flush();
      spill.appendCaptured(makePcm(6400));
      await spill.flush();

      audio.fenceAndStop(reason: JournalInterrupt.cancelled);
      // ⚠️ `flush()` drains the SEGMENT write chain; the journal has its own
      // (`_journalOps`), and the close that publishes the manifest rides that
      // one. Awaiting only the first read the directory before the manifest
      // existed and reported `manifest: null` — a fixture racing the product.
      await spill.journalFlush();
      await pumpEventQueue();

      final RecordingScan s = await scanOne();
      expect(s.manifest?.cancelled, isTrue);
      expect(s.manifest?.interruptReason, JournalInterrupt.cancelled);
      // 🔴 The scan is what RC-1 reads, so the flag has to survive the trip
      // through it: a manifest field nobody surfaces skips no recording.
      expect(s.cancelled, isTrue);
      // Bytes kept (§A5-1). Only the disposition changed.
      expect(s.observedLength, greaterThan(0));
      expect(
        File('${tmp.path}${Platform.pathSeparator}${s.recordingId}.pcm')
            .existsSync(),
        isTrue,
      );
    });

    test('an auto-stop does NOT tombstone, and keeps its own reason', () async {
      await audio.start(permissionPreflighted: true);
      await spill.flush();
      spill.appendCaptured(makePcm(6400));
      await spill.flush();

      // The default — i.e. exactly what ptt_inbound.dart's untouched call site
      // produces.
      audio.fenceAndStop();
      await spill.journalFlush(); // see the cancel case for why not flush()
      await pumpEventQueue();

      final RecordingScan s = await scanOne();
      expect(s.manifest?.interruptReason, JournalInterrupt.autoStopped);
      expect(s.manifest?.cancelled, isFalse);
      expect(s.cancelled, isFalse,
          reason: 'the server ending a session is not the user discarding it — '
              'this recording stays recoverable');
    });

    test(
        'the TTL sweep never takes a tombstoned recording, even settled and '
        'long expired', () async {
      // The worst case, built by hand: a recording that passed the A5-3
      // clearing gate AND is older than the TTL AND is cancelled. Only the
      // tombstone stands between it and the sweep.
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: tmp.path,
        recordingId: 'r-tombstoned',
      );
      await j.appendPcm(makePcm(6400));
      j.markCancelled();
      j.markSettledForCleanup();
      await j.close();

      // A second recording, identical but NOT cancelled — the positive control
      // proving the sweep is awake and the clock really is past the TTL.
      final RetainedAudioJournal ok = await RetainedAudioJournal.open(
        dirPath: tmp.path,
        recordingId: 'r-settled',
      );
      await ok.appendPcm(makePcm(6400));
      ok.markSettledForCleanup();
      await ok.close();

      final RetainedAudioStore aged = RetainedAudioStore(
        dir: tmp,
        ttl: Duration.zero,
        clock: () => DateTime.now().millisecondsSinceEpoch + 86400000,
      );
      await aged.open();
      addTearDown(aged.dispose);
      await aged.sweep();

      expect(
        File('${tmp.path}${Platform.pathSeparator}r-tombstoned.pcm')
            .existsSync(),
        isTrue,
        reason: 'owner ruling O-5 keeps these bytes; a TTL that deletes them '
            'honours "never auto-transcribe" by destroying what it protected',
      );
      expect(
        File('${tmp.path}${Platform.pathSeparator}r-settled.pcm').existsSync(),
        isFalse,
        reason: 'positive control: the sweep did run and the clock is past the '
            'TTL, so the survival above is the tombstone and not a no-op',
      );
    });
  });

  test('the marker is invisible to every existing parser', () async {
    // 🔴 THE MARKER'S WHOLE DESIGN IS "no existing reader notices it", and an
    // unchecked claim of that shape is what anti-façade ④ warns about. Four
    // readers, four assertions.
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-tomb-parse-');
    addTearDown(() async {
      await removeTempDir(tmp);
    });
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp);
    addTearDown(store.dispose);
    await store.open();
    store.beginSession('sess-a');
    await store.append(segmentIdx: 0, bytes: makePcm(6400));
    final int before = store.retainedBytes;

    await store.tombstoneSession(session: 'sess-b'); // a DIFFERENT session
    await store.open(); // re-seed retainedBytes from the directory

    // ① not counted as retained audio (it is not a segment file)
    expect(store.retainedBytes, before);
    // ② a neighbour's marker does not touch the untombstoned session
    expect(await store.pendingSessions(), <String>['sess-a']);
    expect(await store.pendingSegments(session: 'sess-a'), <int>[0]);
    // ③ the startup scan does not mistake it for a recording.
    //    ⚠️ NOT `isEmpty`: the scan collects ids from `.pcm` and
    //    `.manifest.json`, so the LEGACY SEGMENT FILE is (correctly, and since
    //    long before this card) reported as an orphan PCM. What must be absent
    //    is the marker — measured by name, because an `isEmpty` here would
    //    have been red for a reason that has nothing to do with the tombstone.
    final List<String> scanned =
        (await RetainedAudioJournalScan.scan(dirPath: tmp.path))
            .map((RecordingScan e) => e.recordingId)
            .toList();
    expect(scanned, <String>['sess-a__seg-0'],
        reason: 'positive control: the scan DOES see the segment file, so its '
            'silence about the marker is a judgement and not an empty read');
    expect(scanned.any((String id) => id.contains('cancelled')), isFalse);
    // ④ dropAll deletes every segment file and leaves this one — it is not a
    //    segment, and a marker outliving its bytes is the safe direction
    await store.dropAll();
    expect(File(_tombPath(tmp, 'sess-b')).existsSync(), isTrue);
  });
}
