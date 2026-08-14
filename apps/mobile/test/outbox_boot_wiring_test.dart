// 🔴 Window B3-2c G-2 — 「did anyone call it」, not 「does it itself work」.
//
// WHY THIS FILE EXISTS AS A SEPARATE TEST.
//
// `DeliveryOutbox.load()` was written, unit-tested and NEVER CALLED. Its own
// unit tests were green the whole time, because they called it themselves — and
// that is the precise definition of a façade in this repo (13 册 §7 F1 ③: unit
// tests all-green have zero proof of 「wiring」). The capability that was missing was not the method,
// it was the LINE IN `main.dart`, and no test that invokes `load()` directly can
// ever notice its absence.
//
// So this test does not call `load()`. It pumps the REAL [FlowMicApp] — the same
// widget `main()` builds, with the same injected storage — and asserts that
// booting the app, and nothing else, performed the boot revive. If someone
// deletes the call from `main.dart`, every existing outbox test stays green and
// this one goes red. That asymmetry is the whole point.
//
// WHAT IT PROVES CONCRETELY: an item left at `inflight` by a process that died
// between the emit and the receipt comes back as `queued`. That is the red line 「a
// latch closed by a remote event must have a local watchdog」 in its across-restarts form — the in-process
// watchdog cannot fire for a process that no longer exists.

import 'package:flowmic/main.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// One delivery that was on the wire when the previous process died.
OutboxItem _strandedInflight() => OutboxItem(
  requestId: 'boot-1',
  entryId: 'loc_boot-1',
  coveredEntryIds: const <String>['loc_boot-1'],
  kind: OutboxPayloadKind.text,
  source: 'manual',
  text: '进程死在 emit 与回执之间的那一句',
  mode: 'realtime',
  createdAt: DateTime.utc(2026, 7, 28, 9),
  enqueuedAt: DateTime.utc(2026, 7, 28, 9),
  destinationMachineUid: 'machine-boot',
  destinationPairingIdentity: 'standalone|instance:boot',
  enqueuedPcId: 'pc-boot',
  state: OutboxDeliveryState.inflight,
);

void main() {
  testWidgets(
    '🔴 G-2 booting the app loads the outbox: the item that died inflight is revived back to queued',
    (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();

      final InMemoryOutboxStore outboxStore = InMemoryOutboxStore();
      await outboxStore.upsert(_strandedInflight());
      expect(
        (await outboxStore.findByRequestId('boot-1'))!.state,
        OutboxDeliveryState.inflight,
        reason: 'precondition: it starts stranded',
      );

      await tester.pumpWidget(
        FlowMicApp(
          prefs: prefs,
          localPrefs: InMemoryLocalPrefs(),
          appSettings: AppSettingsController(prefs: prefs),
          storage: TimelineStorageOpen(
            persistence: InMemoryTimelinePersistence(),
            kind: TimelineStorageKind.sqlite,
            outbox: outboxStore,
          ),
          // SEG-2: the retained-audio layer. Null is the honest value here —
          // this harness never opens the store (main() does, via
          // path_provider, which a widget test has no platform channel for),
          // and null is exactly the documented degraded state: no retention,
          // and the link-loss notice refuses to claim any.
          retainedAudio: null,
          outboxBlobDir: '${tester.binding.hashCode}/outbox_blobs_test',
          // Window C: the scratch area an export assembles in. Never touched by
          // this test — it asserts the QUEUE's boot wiring — but the app now
          // requires the composition root to name it.
          portableWorkDir: '${tester.binding.hashCode}/portable_test',
        ),
      );
      // `load()` is fire-and-forget from initState, so let the microtasks run.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 10));

      final OutboxItem revived =
          (await outboxStore.findByRequestId('boot-1'))!;
      expect(
        revived.state,
        OutboxDeliveryState.queued,
        reason: 'booting the app must revive a stranded inflight item — if this '
            'is red, main.dart stopped calling DeliveryOutbox.load()',
      );
      expect(revived.lastRefusalNote, 'REVIVED_FROM_INFLIGHT_ON_BOOT');
    },
  );
}
