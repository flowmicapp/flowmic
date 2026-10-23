// NR-224 (c) — the tail case of D6-CATCHUP-DUP.
//
// The relay disposed a long recording while the app was away, and its LAST
// live segment final had already covered every captured byte. Nothing is
// owed. Before this card `_accountOwedTail` (ptt_capture_pump.dart) returned
// on `capturedMs - prefixMs <= 0` without writing anything on the manifest,
// and the recovery scan reads a manifest with no owed range as "the whole
// recording" (retained_audio_journal_scan.dart `_Owed.of`, "Nothing was ever
// recorded as owed"): the catch-up fed the recording from byte 0 and appended
// it after the rows the user already had — billed again for the same audio
// (the relay's `recording_coverage` guard, NR-224 (a), stops the second charge
// on 0.3.109+ relays only) and printed twice.
//
// Same real chain as continuous_link_back_catchup_test.dart (rc3_rig).

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/app_lifecycle_edges.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _token = 'tok-test-abcdefghijklmnopqrstuvwxyz012';

void main() {
  testWidgets(
    '🔴 NR-224 (c): the last live row ends at the end of the recording and the '
    'relay is gone — the catch-up feeds nothing, never the whole recording',
    (WidgetTester t) async {
      await t.runAsync(() async {
        final Rc3Rig r = await Rc3Rig.open();
        try {
          r.relay.onStop = (Rc3Stop stop) {
            if (!stop.recovery) return;
            Future<void>.microtask(
              () => r.relay.pushIncoming(
                'stt:final',
                r.relay.terminal(
                  stop,
                  text: 'recovered',
                  durationMs: stop.fed * 200,
                ),
              ),
            );
          };
          await r.begin();
          await r.feedMs(10000);
          await r.interim(0, ackedMs: 10000);
          await r.segment('first part', 0, 10000);
          await r.feedMs(6000);
          await r.interim(1, ackedMs: 16000);
          // The last live final covers every byte captured so far.
          await r.segment('second part', 1, 6000);

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
          // Nothing spoken after the return: the recording ends where the
          // last live row ends.
          r.relay.failEmits = false;
          r.relay.connectSucceeds = true;
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
          // Give a (wrong) recovery every chance to start and land.
          await Future<void>.delayed(const Duration(seconds: 2));
          await r.until(
            () => !r.controller.backfill.isBusy,
            max: const Duration(seconds: 20),
          );

          final RecordingManifest? m = await r.manifest();
          final List<int> starts = <int>[
            for (final Map<String, Object?> s in r.relay.recoveryStarts)
              ((s['range_start_sample'] as int?) ?? 0) ~/ 16,
          ];
          expect(
            starts.where((int ms) => ms < 15800),
            isEmpty,
            reason:
                'a catch-up fed audio the live rows already carry '
                '(starts at $starts ms); owed=${m?.owedRanges}',
          );
          expect(
            r.rows.where((TimelineEntry e) => e.sourceText == 'recovered'),
            isEmpty,
            reason: 'nothing was owed, so nothing may be appended',
          );
          // Not owed, not deleted: the words are rows and no receipt came, so
          // the audio is kept as settled-unverified (delete only).
          expect(
            m?.recoveryState,
            RecoveryQueueState.settledUnverified,
            reason: 'owed=${m?.owedRanges}',
          );
          // Positive control: the live rows are there, once each.
          expect(
            r.rows.where((TimelineEntry e) => e.sourceText == 'first part'),
            hasLength(1),
          );
          expect(
            r.rows.where((TimelineEntry e) => e.sourceText == 'second part'),
            hasLength(1),
          );
        } finally {
          await r.dispose();
        }
      });
    },
  );

  testWidgets(
    '🔴 NR-214 review F1: the relay row clock runs 1 s ahead of the audio sent '
    'and 1 s more is spoken — that second is owed, not written off',
    (WidgetTester t) async {
      await t.runAsync(() async {
        final Rc3Rig r = await Rc3Rig.open();
        try {
          r.relay.onStop = (Rc3Stop stop) {
            if (!stop.recovery) return;
            Future<void>.microtask(
              () => r.relay.pushIncoming(
                'stt:final',
                r.relay.terminal(
                  stop,
                  text: 'recovered',
                  durationMs: stop.fed * 200,
                ),
              ),
            );
          };
          await r.begin();
          await r.feedMs(10000);
          await r.interim(0, ackedMs: 10000);
          await r.segment('first part', 0, 10000);
          await r.feedMs(6000);
          await r.interim(1, ackedMs: 16000);
          // The last live final covers every byte captured so far.
          await r.segment('second part', 1, 7000);
          // Spoken after the last final, before the relay is lost.
          await r.feedMs(1000);

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
          // Nothing spoken after the return: the recording ends where the
          // last live row ends.
          r.relay.failEmits = false;
          r.relay.connectSucceeds = true;
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
          // Give a (wrong) recovery every chance to start and land.
          await Future<void>.delayed(const Duration(seconds: 2));
          await r.until(
            () => !r.controller.backfill.isBusy,
            max: const Duration(seconds: 20),
          );

          final RecordingManifest? m = await r.manifest();
          final List<int> starts = <int>[
            for (final Map<String, Object?> s in r.relay.recoveryStarts)
              ((s['range_start_sample'] as int?) ?? 0) ~/ 16,
          ];
          expect(
            starts,
            isNotEmpty,
            reason:
                'the second captured after the last final is owed; '
                'owed=${m?.owedRanges} state=${m?.recoveryState}',
          );
          expect(
            starts.first,
            inInclusiveRange(15800, 16200),
            reason: 'owed from where the last final can be shown to end',
          );
          expect(
            r.rows.where((TimelineEntry e) => e.sourceText == 'recovered'),
            hasLength(1),
          );
          // Positive control: the live rows are there, once each.
          expect(
            r.rows.where((TimelineEntry e) => e.sourceText == 'first part'),
            hasLength(1),
          );
          expect(
            r.rows.where((TimelineEntry e) => e.sourceText == 'second part'),
            hasLength(1),
          );
        } finally {
          await r.dispose();
        }
      });
    },
  );
}
