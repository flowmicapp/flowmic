// Card RC-2 — THE RECOVERY FEED IS PACED BY THE ENGINE, NOT BY THE SOCKET.
//
// CR-12-E, root-cause doc §1.5: the recovery feed pushed 428 s of audio in
// 4.3 s. Its only bound, `kRecoveryInFlightWindowBytes`, was reset by every
// interim, and a healthy engine sends interims all the time, so the window never
// closed. Soniox took the whole burst and worked through it at about real time;
// the relay's 3 s flush cap fired first and the recording came back as its
// first 8 characters.
//
// What this file pins, through the real `BackfillRunner` → `RecoveryJournalLeg`
// path and a fake relay:
//   · an engine that keeps REPORTING the same processed position
//     (`stt:interim.acked_audio_ms`) holds the feed at about 10 s ahead of it
//     (RC-M, 2026-09-24: was 30 s);
//   · an engine whose position advances lets the feed run to the end;
//   · a relay that reports nothing gets at most 2x real time, never a burst;
//   · the arithmetic itself (`RecoveryPacing`) and the wire parse.
//
// Time is virtual: every `sleep` the leg asks for advances the clock by that
// much (plus a real millisecond so the fake relay's loop gets a turn), so the
// pacing's waits cost the test nothing while the leg still measures them.
//
// Reverse control (logs under .local/rc-backfill/ in the lane-d slot): with the
// `_awaitPace` call in `_streamRange` removed, the 「same position」 case hands
// over the whole file and the 「reports nothing」 case finishes in ~0 s of
// virtual time — both red.
//
// SPEC-REF:
//   apps/mobile/lib/src/session/recovery_leg_policy.dart (`RecoveryPacing`)
//   apps/mobile/lib/src/session/recovery_leg_wire.dart (`_streamRange`, `_awaitPace`)
//   packages/protocol/src/protocol-schemas-audio.ts (`acked_audio_ms`)

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_journal_leg.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/stt/stt_stream.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

/// 20 read blocks = 256 s of audio.
const int kFileBytes = 20 * kRecoveryReadBlockBytes;
const int kBytesPerMs = 32;
const int kFileMs = kFileBytes ~/ kBytesPerMs;
const int kBlockMs = kRecoveryReadBlockBytes ~/ kBytesPerMs;

const List<String> _tierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

class _CountingTransport extends FakeSocketTransport {
  int chunkFrames = 0;

  /// Card RC-M — the rig's virtual clock, and when each frame went out on it.
  int Function()? clock;
  final List<int> chunkAt = <int>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioChunk) {
      chunkFrames += 1;
      final int Function()? c = clock;
      if (c != null) chunkAt.add(c());
    }
  }

  int get chunkBytes => chunkFrames * kBackfillChunkBytes;
  int get sentMs => chunkBytes ~/ kBytesPerMs;
}

class _Rig {
  _Rig._(this.tmp, this.store, this.spill, this.transport, this.session,
      this.timeline, this.runner, this._skew);

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;
  final _CountingTransport transport;
  final PttSession session;
  final TimelineStore timeline;
  final BackfillRunner runner;
  final List<int> _skew;

  int now() => DateTime.now().millisecondsSinceEpoch + _skew[0];

  static Future<_Rig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-pace-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final RetainedAudioSpill spill =
        RetainedAudioSpill(store: store, retainFromFirstFrame: true);
    final _CountingTransport transport = _CountingTransport();
    final PttSession session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': _tierA});
    final TimelineStore timeline = newTestStore();
    final List<int> skew = <int>[0];
    final BackfillRunner runner = BackfillRunner(
      session: session,
      store: timeline,
      recoveryTimeouts: const RecoveryTimeouts(
        uploadProgress: Duration(seconds: 2),
        engineProgress: Duration(milliseconds: 300),
        noProgress: Duration(milliseconds: 400),
        totalBudgetBase: Duration(milliseconds: 600),
        totalBudgetPerAudioMinute: Duration.zero,
      ),
      clock: () => DateTime.now().millisecondsSinceEpoch + skew[0],
      sleep: (Duration d) async {
        skew[0] += d.inMilliseconds;
        await Future<void>.delayed(const Duration(milliseconds: 1));
      },
    );
    transport.pushStatus(SocketStatus.connected);
    while (runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return _Rig._(
        tmp, store, spill, transport, session, timeline, runner, skew);
  }

  Future<void> writeJournal(String id, {int bytes = kFileBytes}) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      configSnapshot: const <String, Object?>{
        kConfigSnapshotMode: 'realtime',
        kConfigSnapshotSourceLang: 'zh',
        kConfigSnapshotPrefsDigest: '',
      },
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(bytes));
    await j.close();
  }

  /// The fake relay: an interim every 5 ms of real time, carrying whatever
  /// [ackedMs] says (null = an older relay, no field).
  void Function() relayReports(int? Function() ackedMs) {
    bool on = true;
    unawaited(Future<void>.microtask(() async {
      while (on) {
        final int? a = ackedMs();
        transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
          'text': '…',
          'confidence': 0.5,
          'language': 'zh',
          'segment_idx': 0,
          'acked_audio_ms': ?a,
        });
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
    }));
    return () => on = false;
  }

  Future<void> dispose() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
    while (runner.isBusy && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    runner.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }
}

void main() {
  group('RecoveryPacing — the arithmetic', () {
    const RecoveryPacing p = RecoveryPacing();

    // ⚠️ 更正（Codex rc3 ⑧）：原为 「starts at 0」 (0 / 12800): the first send's
    // lead was then followed by a ~5 s wait. No report = an engine at 0.
    test('no report yet: the allowance starts at the 10 s lead and grows at 2x '
        'real time', () {
      expect(
          p.limitMs(
              ackedMs: null, reportedAtMs: 0, startedAtMs: 1000, nowMs: 1000),
          10000);
      expect(
          p.limitMs(
              ackedMs: null, reportedAtMs: 0, startedAtMs: 1000, nowMs: 7400),
          22800);
    });

    test('a report anchors the allowance 10 s past the reported position (RC-M; was 30 s)', () {
      expect(
          p.limitMs(
              ackedMs: 40000,
              reportedAtMs: 5000,
              startedAtMs: 0,
              nowMs: 5000),
          50000);
      expect(
          p.limitMs(
              ackedMs: 40000,
              reportedAtMs: 5000,
              startedAtMs: 0,
              nowMs: 6000),
          52000,
          reason: 'between reports it grows at the fallback rate');
    });

    test('the first block never waits; later ones wait out the shortfall at 2x',
        () {
      expect(p.waitMs(sentMs: 0, endMs: 12800, limitMs: 0), 0);
      expect(p.waitMs(sentMs: 12800, endMs: 25600, limitMs: 25600), 0);
      expect(p.waitMs(sentMs: 12800, endMs: 25600, limitMs: 12800), 6400);
    });
  });

  group('stt:interim.acked_audio_ms on the phone', () {
    Map<String, Object?> frame([Object? acked]) => <String, Object?>{
          'text': 'x',
          'confidence': 0.5,
          'language': 'zh',
          'segment_idx': 0,
          'acked_audio_ms': ?acked,
        };

    test('present ⇒ read; absent ⇒ null, never 0; garbage ⇒ null', () {
      expect(SttInterim.tryFromJson(frame(41240))!.ackedAudioMs, 41240);
      expect(SttInterim.tryFromJson(frame(0))!.ackedAudioMs, 0);
      expect(SttInterim.tryFromJson(frame())!.ackedAudioMs, isNull);
      expect(SttInterim.tryFromJson(frame(-5))!.ackedAudioMs, isNull);
      expect(SttInterim.tryFromJson(frame('12'))!.ackedAudioMs, isNull);
    });
  });

  group('RecoveryJournalLeg feed pacing', () {
    test(
        'an engine that keeps reporting the same position holds the feed at '
        'about 10 s ahead of it, and the bytes stay', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal('rec-stuck');
      final void Function() stop = rig.relayReports(() => 0);

      await rig.runner.sweep(sourceLang: 'zh');
      stop();

      // 10 s lead, plus the 2x fallback growth between two reports (frames now
      // go out as the allowance grows, and on a loaded machine a few polls can
      // pass between reports: 11.0–11.2 s measured). The old lead let 25.6 s out.
      expect(rig.transport.sentMs, lessThanOrEqualTo(13000),
          reason: 'the engine said it had processed nothing; the feed may run '
              'at most 10 s past that (RC-M)');
      expect(rig.transport.sentMs, greaterThan(0),
          reason: 'positive control: the feed did start');
      expect(
        File('${rig.tmp.path}${Platform.pathSeparator}rec-stuck.pcm')
            .existsSync(),
        isTrue,
        reason: 'stopping the feed is not a settle: a partial range has no '
            'matching receipt, so the recording stays owed',
      );
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('an engine that keeps up lets the whole range go out', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal('rec-live');
      // The engine is always 5 s behind whatever has been sent.
      final void Function() stop = rig.relayReports(
          () => (rig.transport.sentMs - 5000).clamp(0, kFileMs));

      await rig.runner.sweep(sourceLang: 'zh');
      stop();

      expect(rig.transport.chunkBytes, kFileBytes,
          reason: 'an engine that advances must never cost a healthy '
              'transfer a byte');
    }, timeout: const Timeout(Duration(seconds: 60)));

    test(
        '🔴 RC-M: an engine that keeps pace never leaves the wire silent for a '
        'second between two frames (the relay hangs a leg up after 3 s)',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      rig.transport.clock = rig.now;
      await rig.writeJournal('rec-gaps');
      // Soniox working through a burst at ~1.15× real time (root cause §5.1),
      // never past what it was handed: once the lead is full, the feed can
      // only go as fast as the engine does.
      final int t0 = rig.now();
      final void Function() stop = rig.relayReports(() =>
          ((rig.now() - t0) * 1.15).floor().clamp(0, rig.transport.sentMs));

      await rig.runner.sweep(sourceLang: 'zh');
      stop();

      expect(rig.transport.chunkBytes, kFileBytes,
          reason: 'positive control: the whole range went out');
      int maxGap = 0;
      for (int i = 1; i < rig.transport.chunkAt.length; i++) {
        final int g = rig.transport.chunkAt[i] - rig.transport.chunkAt[i - 1];
        if (g > maxGap) maxGap = g;
      }
      expect(maxGap, lessThanOrEqualTo(RecoveryPacing.maxGapMs),
          reason: 'a whole 12.8 s block used to wait until it fitted — up to '
              '6.4 s with nothing on the wire');
    }, timeout: const Timeout(Duration(seconds: 60)));

    test(
        '🔴 Codex rc3 ⑧: a relay that reports NO position never leaves the wire '
        'silent past maxGapMs either — the first 10 s burst used to be followed '
        'by a ~5 s wait while the fallback allowance grew from zero',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      rig.transport.clock = rig.now;
      await rig.writeJournal('rec-gaps-silent', bytes: 2 * kRecoveryReadBlockBytes);
      final void Function() stop = rig.relayReports(() => null);

      await rig.runner.sweep(sourceLang: 'zh');
      stop();

      expect(rig.transport.chunkBytes, 2 * kRecoveryReadBlockBytes,
          reason: 'positive control: the whole range went out');
      int maxGap = 0;
      for (int i = 1; i < rig.transport.chunkAt.length; i++) {
        final int g = rig.transport.chunkAt[i] - rig.transport.chunkAt[i - 1];
        if (g > maxGap) maxGap = g;
      }
      expect(maxGap, lessThanOrEqualTo(RecoveryPacing.maxGapMs),
          reason: 'the relay hangs a leg up after 3 s of nothing');
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('a relay that reports no position gets at most 2x real time', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal('rec-old-relay');
      final void Function() stop = rig.relayReports(() => null);

      final int t0 = rig.now();
      await rig.runner.sweep(sourceLang: 'zh');
      final int elapsed = rig.now() - t0;
      stop();

      expect(rig.transport.chunkBytes, kFileBytes,
          reason: 'positive control: the whole range still goes out');
      expect(elapsed, greaterThanOrEqualTo((kFileMs - kBlockMs) ~/ 2),
          reason: '256 s of audio may not leave faster than twice real time '
              '(the first block is free); CR-12-E sent 428 s in 4.3 s');
    }, timeout: const Timeout(Duration(seconds: 60)));
  });
}
