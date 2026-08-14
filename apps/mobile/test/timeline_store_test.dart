// WP-R3-2 acceptance — build-line semantics + five-state write-back + edit
// (edited bit; source_text immutable) + local persistence round-trip.
// SPEC-REF: master-plan §4.0 A/D; 08-MOBILE-SPEC §7.

import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';

void main() {
  group('build-line semantics (§4.0 A)', () {
    test('an inject-delivery utterance builds a ⏳ cached row', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'u0-1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '你好世界',
      );
      expect(e.status, EntryStatus.cached);
      expect(e.sourceText, '你好世界');
      expect(e.outputText, '你好世界');
      expect(TimelineEntry.isLocId(e.id), isTrue);
      expect(store.entries.length, 1);
    });

    test('a record-only utterance builds a 📥 noted row', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'u0-2',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: '留在手机',
      );
      expect(e.status, EntryStatus.noted);
    });

    test('build is idempotent on clientId (a replayed final does not dup)', () {
      final TimelineStore store = newTestStore();
      store.buildFromUtterance(
        clientId: 'u0-3',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'first',
      );
      store.buildFromUtterance(
        clientId: 'u0-3',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'second',
      );
      expect(store.entries.length, 1);
      expect(store.entries.first.outputText, 'first');
    });
  });

  group('five-state write-back (§4.0 D)', () {
    test('inject:result ok → ✓ injected + provenance', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'u1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'hi',
      );
      final bool applied = store.applyInjectResult(
        correlationId: e.clientId,
        ok: true,
        target: const InjectTarget(
          windowTitle: 'WeChat',
          processName: 'WeChat',
          injectedAt: 'now',
        ),
      );
      expect(applied, isTrue);
      expect(store.findById(e.id)!.status, EntryStatus.injected);
      expect(store.findById(e.id)!.injectTarget!.processName, 'WeChat');
    });

    test('inject:result fail → ✗ failed (never silent)', () {
      final TimelineStore store = newTestStore();
      store.buildFromUtterance(
        clientId: 'u2',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'hi',
      );
      store.applyInjectResult(correlationId: 'u2', ok: false);
      expect(store.entries.first.status, EntryStatus.failed);
    });

    // RV-14 / C4: failureReason must land on the row — anti-façade proof that
    // the named codes callers mint are not evaporated at the store door.
    test('inject:result fail keeps the named failureReason on the row', () {
      final TimelineStore store = newTestStore();
      store.buildFromUtterance(
        clientId: 'u2fr',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'hi',
      );
      store.applyInjectResult(
        correlationId: 'u2fr',
        ok: false,
        failureReason: 'INJECT_NO_RESULT',
      );
      expect(store.entries.first.status, EntryStatus.failed);
      expect(store.entries.first.failureReason, 'INJECT_NO_RESULT');
    });

    test('failure_reason survives toJson/fromJson; legacy JSON stays null', () {
      final TimelineStore store = newTestStore();
      store.buildFromUtterance(
        clientId: 'u2rt',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'hi',
      );
      store.applyInjectResult(
        correlationId: 'u2rt',
        ok: false,
        failureReason: 'LINK_DOWN',
      );
      final Map<String, Object?> json = store.entries.first.toJson();
      expect(json['failure_reason'], 'LINK_DOWN');
      final TimelineEntry back = TimelineEntry.fromJson(json)!;
      expect(back.failureReason, 'LINK_DOWN');

      final Map<String, Object?> legacy = Map<String, Object?>.from(json)
        ..remove('failure_reason');
      expect(TimelineEntry.fromJson(legacy)!.failureReason, isNull);
    });

    test('inject:result with no id → temporal fallback (single in-flight)', () {
      final TimelineStore store = newTestStore();
      store.buildFromUtterance(
        clientId: 'u3',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'hi',
      );
      store.applyInjectResult(ok: true); // STT path echoes no id
      expect(store.entries.first.status, EntryStatus.injected);
    });

    test('a stray inject:result never touches a noted row', () {
      final TimelineStore store = newTestStore();
      store.buildFromUtterance(
        clientId: 'n1',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: 'note',
      );
      final bool applied = store.applyInjectResult(ok: true);
      expect(applied, isFalse);
      expect(store.entries.first.status, EntryStatus.noted);
    });

    test('re-inject by entry id resolves the exact row', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'r1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'hi',
      );
      store.applyInjectResult(correlationId: e.id, ok: false);
      expect(store.findById(e.id)!.status, EntryStatus.failed);
    });
  });

  group('edit — edited bit + source_text immutable (§4.0 A)', () {
    test('edit moves the display face and sets edited; source untouched', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'e1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '原始文本',
      );
      final TimelineEntry? updated = store.applyEdit(e.id, '修改后的展示文本');
      expect(updated, isNotNull);
      expect(updated!.edited, isTrue);
      expect(updated.outputText, '修改后的展示文本');
      expect(updated.displayText, '修改后的展示文本');
      // The immutable original survives verbatim.
      expect(updated.sourceText, '原始文本');
    });

    test('editing does NOT change delivery status colour', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'e2',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: 'x',
      );
      store.applyInjectResult(correlationId: e.clientId, ok: true);
      final TimelineEntry? updated = store.applyEdit(e.id, 'y');
      expect(updated!.status, EntryStatus.injected); // unchanged
      expect(updated.edited, isTrue); // overlay is orthogonal
    });
  });

  group('local persistence round-trip (§7)', () {
    test('a built row survives a reload through the same backing store', () async {
      final InMemoryTimelinePersistence backing = InMemoryTimelinePersistence();
      final TimelineStore store = TimelineStore(persistence: backing, reaper: newTestReaper(persistence: backing));
      store.buildFromUtterance(
        clientId: 'p1',
        mode: FlowMode.translate,
        delivery: Delivery.inject,
        text: 'persist me',
      );
      await Future<void>.delayed(Duration.zero); // let the async save land
      final TimelineStore reopened = TimelineStore(persistence: backing, reaper: newTestReaper(persistence: backing));
      await reopened.load();
      expect(reopened.entries.length, 1);
      expect(reopened.entries.first.clientId, 'p1');
      expect(reopened.entries.first.mode, FlowMode.translate);
    });
  });
}
