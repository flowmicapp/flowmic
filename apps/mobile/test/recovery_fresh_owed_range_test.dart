// NR-115 N3: deterministic version of acceptance-4's unheard-tail probe.
import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/session/recovery_journal_leg.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const _prefixMs = 36800;
const _unheardMs = 84000;
const _totalMs = 102400;
const _draft = 'draft-fixture';
const _tail = 'tail-fixture';

void main() {
  for (final covered in [false, true]) {
    testWidgets(
      'N3: parked publish uses ${covered ? "no longer owed" : "fresh 84s range"}',
      (t) async {
        late Rc3Rig r;
        await t.runAsync(() async {
          r = await Rc3Rig.open();
          // Leg-level test: disable competing automatic sweeps, keeping the
          // real capture, final placement and journal writers.
          r.controller.backfill.dispose();
          final leg = RecoveryJournalLeg(
            session: r.session,
            timeline: r.timeline,
            spill: r.spill,
            fs: r.fs,
            blockCadence: Duration.zero,
          );
          final liveStop = Completer<Rc3Stop>();
          final fed = <int>[];
          r.relay.onStop = (stop) {
            if (!stop.recovery) {
              liveStop.complete(stop);
            } else {
              fed.add(stop.fed);
              final text = stop.fromMs < _unheardMs ? '$_draft$_tail' : _tail;
              scheduleMicrotask(
                () => r.relay.pushIncoming(
                  FlowMicEvents.sttFinal,
                  r.relay.terminal(
                    stop,
                    text: text,
                    durationMs: stop.toMs - stop.fromMs,
                  ),
                ),
              );
            }
          };
          await r.begin();
          await r.feedMs(_prefixMs);
          await r.segment('prefix-fixture', 0, _prefixMs);
          await r.feedMs(50000 - _prefixMs);
          await r.interim(1, ackedMs: 50000);
          await r.engine('reconnecting');
          await r.feedMs(10000);
          await r.engine('ready', replayedMs: 14000);
          await r.feedMs(30000);
          await r.interim(1, ackedMs: 80000);
          await r.feedMs(_totalMs - 90000);
          await r.controller.pttUp();
          final stop = await liveStop.future;
          await r.push(FlowMicEvents.sttError, {
            'code': 'STT_SEGMENT_NOT_TRANSCRIBED',
            'message': 'fixture',
            'retryable': false,
            'unheard_from_ms': _unheardMs,
          });
          await r.untilAsync(
            () async =>
                (await r.manifest())?.transcribedPrefixBytes == _prefixMs * 32,
          );
          expect((await r.manifest())!.transcribedPrefixBytes, _prefixMs * 32);
          final parked = Completer<void>();
          final releaseWrite = Completer<void>();
          final pass = leg.run(
            fallbackSourceLang: 'zh',
            onScanned: (snapshot) async {
              expect(snapshot.pendingBytes, greaterThan(0));
              parked.complete();
              await releaseWrite.future;
            },
          );
          await parked.future;
          expect(r.relay.recoveryStarts, isEmpty);
          if (covered) {
            // The closing rung's coverage fact, before its final is placed.
            r.session.articles.markOwedTailCovered(r.articleId!);
            r.spill.noteTailHeardByClosingLeg(
              (await r.manifest())!.recordingId,
            );
          }
          await r.push(
            FlowMicEvents.sttFinal,
            r.relay.terminal(
              stop,
              text: _draft,
              durationMs: _totalMs - _prefixMs,
              segmentIdx: 1,
            ),
          );
          await r.until(
            () => !r.session.articles.owedTailPendingFor(r.articleId!),
          );
          expect(r.session.articles.owedTailPendingFor(r.articleId!), isFalse);
          final RecordingManifest current = (await r.manifest())!;
          if (covered) {
            final scans = await RetainedAudioJournalScan.scan(
              dirPath: r.store.dirPath,
              fs: r.fs,
            );
            expect(
              scans.single.verifiedRecoverableRange.isEmpty,
              isTrue,
              reason: current.encode(),
            );
          } else {
            expect(current.transcribedPrefixBytes, _unheardMs * 32);
          }
          releaseWrite.complete();
          await pass;
          final starts = r.relay.recoveryStarts;
          if (covered) {
            expect(
              starts,
              isEmpty,
              reason: 'the final settled all debt during the publish',
            );
            expect(fed, isEmpty);
          } else {
            expect(
              starts.map((s) => s['range_start_sample']).toList(),
              [_unheardMs * 16],
              reason:
                  'stale-start signature is 588800 (36.8s); fresh start is 1344000 (84s)',
            );
            expect(fed, [
              (_totalMs - _unheardMs) ~/ 200,
            ], reason: 'only the 92 unheard frames, no earlier audio');
          }
          final all = r.rows.map((e) => e.displayText).join('\n');
          expect(_draft.allMatches(all), hasLength(1));
          expect(_tail.allMatches(all), hasLength(covered ? 0 : 1));
        });
        await t.runAsync(r.dispose);
      },
    );
  }
}
