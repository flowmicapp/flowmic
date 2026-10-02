// NR-137 round 10b — NO WRITER LANDS BETWEEN A RELEASE'S FINAL PROOF AND ITS
// PCM DELETE; A ROW AN EARLIER ATTEMPT WITHDREW IS RE-PROVEN AT EVERY LATER
// RELEASE.
//
// SPEC-REF:
//   lib/src/timeline/timeline_write_gate.dart (who holds the gate, and why)
//   lib/src/session/recovery_leg_rows.dart (`_sealRelease`, was
//   `_authorizeRelease` in round 10b;
//   `_withdrawnEarlier`), lib/src/audio/retained_audio_withdrawn.dart
//
// Round 10 left two items open (`_dispatch/2026-10-02-nr137-r10.report.md`
// §7):
//   1. the final proof was taken before the commit, the journal close and the
//      PCM delete, and any writer could land in between;
//   2. a non-article recording's rows that an earlier attempt WITHDREW were
//      never re-proven at a later release (a proven withdrawal left no trace).
//
// Real chain (`Rc3Rig` / `LegacyRig` → `PendingRecoveryStore.retryNow`), the
// shipped opener's backends. The writers are the shipped cloud retry store
// and the shipped persistence; the only test hooks are the journal file
// system's write/delete notifications and one refused row write.
//
// REVERSE CONTROL (2026-10-02): this file on `8406ed3c`, unmodified product
// code — all eight attack cases red (the four `copyWaits=false` cases are
// positive controls and pass on both trees: a recorded withdrawal must not
// hold a recording forever). On the fix, each of these turns its own cases
// red: the release dropping the gate right after its proof (window ×4), the
// cloud retry merge not taking the gate (window/cloudRetry ×2), recorded
// withdrawals ignored (withdrawn journal ×2), the legacy record ignored
// (withdrawn legacy ×2). The two durable-first cases are red on `59da9c98`
// (the record was committed only with the attempt's close). See the round-10
// report, "Round 10b".
//
// ⚠️ CORRECTION (round 10c): the window cases now assert at the SEAL — the
// commit that settles the recording — not at the PCM delete, and the gate is
// held only for that seal (bounded; see timeline_write_gate.dart). After the
// seal the bytes are cleanup-eligible and nothing proves the release again,
// so a writer landing between the seal and the delete ends exactly where one
// landing after the delete does. The 10b text above is kept as written.
// This version was not run on `8406ed3c` (the file needs round-10b API to
// compile); its red evidence is on the fix: writers not waiting for a seal
// (window ×4), the cloud retry merge not taking the gate (window/cloudRetry
// ×2) — see the round-10 report, "Round 10c".

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/di.dart';
import 'support/legacy_backfill_rig.dart';
import 'support/nr137_rig.dart';
import 'support/rc3_rig.dart';

/// SQLite that will not open this session; whether its file exists is real.
class _NoSqliteFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path, {OpenDatabaseOptions? options}) =>
      Future<Database>.error(StateError('SQLite will not open this session'));
  @override
  Future<bool> databaseExists(String path) =>
      databaseFactoryFfi.databaseExists(path);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

enum _Backend { fallback, sqlite }

Future<TimelinePersistence> _backend(_Backend b, SharedPreferences prefs) async {
  final Directory dir = await Directory.systemTemp.createTemp('nr137-r10b-');
  addTearDown(() async {
    try { await dir.delete(recursive: true); } on Object { /* best effort */ }
  });
  final TimelineStorageOpen open = await openTimelinePersistence(
      prefs: prefs,
      factory: b == _Backend.sqlite ? databaseFactoryFfi : _NoSqliteFactory(),
      path: '${dir.path}/timeline.db');
  if (open.persistence is SqfliteTimelinePersistence) {
    addTearDown((open.persistence as SqfliteTimelinePersistence).close);
  }
  return open.persistence;
}

/// Refuses the write of every row whose text is [refusedText]; remembers them.
class _RefuseText extends Nr137BackendSlot {
  _RefuseText(super.current, this.refusedText);
  final String refusedText;
  final List<TimelineEntry> refused = <TimelineEntry>[];
  @override
  Future<void> upsert(TimelineEntry row) async {
    if (row.displayText == refusedText) {
      refused.add(row);
      throw StateError('row write refused');
    }
    await super.upsert(row);
  }
}

/// The shipped pull and merge bring back a copy of the row [slot] refused
/// first: it authenticates, decodes and states ANOTHER article, so nothing
/// but re-proving the withdrawn id can see it. Its local write is refused
/// like the original's, so the merge keeps it waiting as a retry.
Future<void> _copyOfWithdrawnWaits(_RefuseText slot, TimelineStore store,
    SharedPreferences prefs, String account) async {
  final TimelineEntry cloud = TimelineEntry.fromJson(
      Map<String, Object?>.from(slot.refused.first.toJson())
        ..['client_id'] = 'cloud-copy'
        ..['article_id'] = 'another-article')!;
  final BlindStoreKeyring keyring = await nr137Keyring();
  final Nr137CloudRelay relay = Nr137CloudRelay(<Map<String, Object?>>[
    nr137Blob(cloud,
        keyring.seal(entryId: cloud.id, plaintext: encodeBlindStorePayload(cloud))!,
        seq: 1, schemaVer: kBlindStoreBlobSchemaVer),
  ]);
  addTearDown(relay.close);
  final SharedPrefsBlindStoreCursorStore cursor =
      SharedPrefsBlindStoreCursorStore(prefs);
  await BlindStoreCloudSync(
          keyring: keyring,
          client: BlindStoreCloudClient(transport: relay),
          state: InMemoryBlindStoreCloudStateStore(),
          bridge: BlindStoreTimelineBridge(
              persistence: slot,
              store: store,
              reaper: newTestReaper(persistence: slot),
              reload: store.load),
          cursor: cursor,
          isCloudRelay: () => true,
          accountKey: () => account,
          keymetaConfirmed: () async => true)
      .syncNow();
  expect(await cursor.loadRetries(account), hasLength(1),
      reason: 'control: the copy waits as a retry');
}

BlindStoreRemoteBlob _opaqueRetry(String id) => BlindStoreRemoteBlob(
    id: id, seq: 1, ciphertext: 'opaque-envelope', createdAtMs: 0,
    schemaVer: kBlindStoreBlobSchemaVer + 1, deleted: false);

enum _Writer { cloudRetry, rowWrite }

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  for (final _Backend backend in _Backend.values) {
    for (final _Writer writer in _Writer.values) {
      test('window ${backend.name} / ${writer.name}: a writer started inside the '
          'seal lands only after the seal is on disk', () async {
        final SharedPreferences prefs = await nr137EmptyPrefs();
        final Nr137BackendSlot slot = Nr137BackendSlot(await _backend(backend, prefs));
        final Rc3Rig r = await nr137Article(slot);
        final TimelineEntry old = r.rows.first;
        const String account = 'nr137-r10b-window';
        final SharedPrefsBlindStoreCursorStore cursor =
            SharedPrefsBlindStoreCursorStore(prefs);
        Future<void>? write;
        bool landed = false;
        bool? landedWhenSealed;
        // The release's seal — the commit that settles the recording — comes
        // after its final proof: a writer started while it writes must not
        // land before that commit is published (round 10c: the seal, not the
        // PCM delete, is the point of no return — from it on the bytes are
        // cleanup-eligible and nothing proves the release again).
        r.fs.onWrite = (String path, List<int> bytes) {
          if (write != null ||
              !path.endsWith(RetainedAudioJournal.manifestTempSuffix)) {
            return;
          }
          final RecordingManifest m =
              RecordingManifest.decode(String.fromCharCodes(bytes));
          if (m.recoveryState != RecoveryQueueState.settled) return;
          write = (writer == _Writer.cloudRetry
                  // A cloud merge saving a pulled copy of a replaced member.
                  ? cursor.saveRetry(account, _opaqueRetry(old.id))
                  // A sync or an import landing a replaced member again.
                  : slot.current.upsert(old))
              .then((_) => landed = true);
        };
        r.fs.onRename = (String from, String to) async {
          if (write == null || landedWhenSealed != null ||
              !from.endsWith(RetainedAudioJournal.manifestTempSuffix)) {
            return;
          }
          // Give any writer that is not held off ample time to land.
          await Future<void>.delayed(const Duration(milliseconds: 100));
          landedWhenSealed = landed;
        };

        final PendingRetryOutcome out = await nr137Press(r);
        await write;

        // ignore: avoid_print
        print('R10b window ${backend.name}/${writer.name}: outcome=$out '
            'audioPresent=${r.pcmPresent} landedWhenSealed=$landedWhenSealed '
            'landedAfter=$landed');
        expect(write, isNotNull, reason: 'control: the writer was started');
        expect(out, PendingRetryOutcome.done, reason: 'control: proven, released');
        expect(r.pcmPresent, isFalse);
        expect(landed, isTrue, reason: 'the writer is held off, not lost');
        expect(landedWhenSealed, isFalse,
            reason: 'nothing lands between the final proof and the seal');
      });
    }

    for (final bool copyWaits in <bool>[true, false]) {
    test('withdrawn ${backend.name} copyWaits=$copyWaits: an ordinary recording '
        're-proves rows an earlier press withdrew', () async {
      const String earlier = 'Earlier ordinary words.';
      const String first = 'First answer that never lands.';
      const String second = 'Second answer.';
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _RefuseText slot = _RefuseText(await _backend(backend, prefs), first);
      final Rc3Rig r = await Rc3Rig.open(fixedRecordOnly: false, persistence: slot);
      addTearDown(r.dispose);
      int n = 0;
      r.relay.onStop = (Rc3Stop stop) {
        final bool recovery = stop.recovery;
        final String text = !recovery ? earlier : (++n == 1 ? first : second);
        Future<void>.delayed(const Duration(milliseconds: 20), () =>
            r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
                text: text, durationMs: 2000, endedNormally: recovery)));
      };
      await r.controller.pttDown();
      await r.feedMs(2000);
      await r.controller.pttUp();
      await r.untilAsync(() async =>
          (await r.manifest())?.recoveryState == RecoveryQueueState.settledUnverified);
      expect(r.articleId, isNull, reason: 'control: not an article');

      expect(await nr137Press(r), PendingRetryOutcome.failed,
          reason: 'control: the first answer could not be stored');
      expect(slot.refused, isNotEmpty);
      if (copyWaits) {
        await _copyOfWithdrawnWaits(slot, r.timeline, prefs, 'nr137-r10b-withdrawn');
      }
      final PendingRecoveryStore pending = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'zh');
      final PendingRetryOutcome out =
          await pending.retryNow((await pending.list()).single);
      await r.recoveries(2);

      // ignore: avoid_print
      print('R10b withdrawn journal ${backend.name} copyWaits=$copyWaits: '
          'outcome=$out audioPresent=${r.pcmPresent}');
      if (copyWaits) {
        expect(out, PendingRetryOutcome.failed,
            reason: 'the withdrawn row may come back: the release is not proven');
        expect(r.pcmPresent, isTrue);
        // The live words were kept, so the release is the kept-words one.
        expect((await r.manifest())?.attempts.last.failureCode,
            'keptWordsReleaseNotProven');
      } else {
        // Positive control: the record of the withdrawal does not hold the
        // recording forever — with the withdrawn row proven gone, it releases.
        expect(out, PendingRetryOutcome.done);
        expect(r.pcmPresent, isFalse);
      }
    });

    test('withdrawn legacy ${backend.name} copyWaits=$copyWaits: a legacy '
        'session re-proves rows an earlier press withdrew', () async {
      const String first = 'First answer that never lands.';
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _RefuseText slot = _RefuseText(await _backend(backend, prefs), first);
      final LegacyRig r = await LegacyRig.open(persistence: slot);
      addTearDown(r.dispose);
      const String session = 'nr137-r10b-legacy';
      await r.seed(session);
      await r.store.markUnverified(0, session: session);
      r.relay.replyWords(first);
      PendingRetryOutcome out =
          await r.pending.retryNow((await r.pending.list()).single);
      await r.idle();
      expect(out, PendingRetryOutcome.failed,
          reason: 'control: the first answer could not be stored');
      expect(slot.refused, isNotEmpty);
      if (copyWaits) {
        await _copyOfWithdrawnWaits(slot, r.timeline, prefs, 'nr137-r10b-legacy');
      }
      r.relay.replyWords('Second answer.');
      out = await r.pending.retryNow((await r.pending.list()).single);
      await r.idle();
      final int bytes = await r.store.bytesForSession(session);

      // ignore: avoid_print
      print('R10b withdrawn legacy ${backend.name} copyWaits=$copyWaits: '
          'outcome=$out audioBytes=$bytes');
      if (copyWaits) {
        expect(out, PendingRetryOutcome.failed,
            reason: 'the withdrawn row may come back: the release is not proven');
        expect(bytes, 6400);
      } else {
        // Positive control, as above.
        expect(out, PendingRetryOutcome.done);
        expect(bytes, 0);
      }
    });
    }

    test('withdrawn ${backend.name}: the record of a withdrawal is on disk '
        'when the withdrawal is made', () async {
      const String first = 'First answer that never lands.';
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _RefuseText slot = _RefuseText(await _backend(backend, prefs), first);
      final Rc3Rig r = await Rc3Rig.open(fixedRecordOnly: false, persistence: slot);
      addTearDown(r.dispose);
      r.relay.onStop = (Rc3Stop stop) {
        Future<void>.delayed(const Duration(milliseconds: 20), () =>
            r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
                text: stop.recovery ? first : 'Earlier ordinary words.',
                durationMs: 2000, endedNormally: stop.recovery)));
      };
      await r.controller.pttDown();
      await r.feedMs(2000);
      await r.controller.pttUp();
      await r.untilAsync(() async =>
          (await r.manifest())?.recoveryState == RecoveryQueueState.settledUnverified);
      // The product's own diagnostic trail takes one clock reading per event:
      // at each reading, snapshot the manifest ON DISK (the in-memory file
      // system copies the bytes when asked, before any await). A process
      // death right after the withdrawal — before the attempt's closing
      // commit — leaves exactly that file.
      final List<Future<Uint8List>?> onDisk = <Future<Uint8List>?>[];
      DiagLog.instance.clear();
      DiagLog.instance.clock = () {
        final String? path = r.fs.paths
            .where((String p) => p.endsWith(RetainedAudioJournal.manifestSuffix))
            .firstOrNull;
        onDisk.add(path == null ? null : r.fs.readBytes(path));
        return DateTime.now();
      };
      addTearDown(() => DiagLog.instance.clock = DateTime.now);

      final PendingRetryOutcome out = await nr137Press(r);
      DiagLog.instance.clock = DateTime.now;
      final List<String> trail = DiagLog.instance.snapshot();
      final int at = trail.indexWhere(
          (String l) => l.contains(' audio.recovery.kept_words_withdrawn'));
      final Future<Uint8List>? snap = at < 0 ? null : onDisk[at];
      final RecordingManifest? then = snap == null
          ? null
          : RecordingManifest.decode(String.fromCharCodes(await snap));
      final bool recorded = then?.attempts.any((JournalAttempt a) =>
              slot.refused.any((TimelineEntry e) => a.withdrawnRowIds.contains(e.id))) ??
          false;

      // ignore: avoid_print
      print('R10b durable-first ${backend.name}: outcome=$out at=$at '
          'recordOnDiskAtWithdrawal=$recorded');
      expect(out, PendingRetryOutcome.failed,
          reason: 'control: the answer was not stored');
      expect(trail.length, onDisk.length, reason: 'control: one reading per event');
      expect(at, greaterThanOrEqualTo(0), reason: 'control: the press withdrew');
      expect(recorded, isTrue,
          reason: 'the record must be on disk before the withdrawal is made');
    });
  }
}
