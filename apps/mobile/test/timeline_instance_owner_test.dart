// V2-06a-1 — requirement ④「once inside a PC instance, show only history related to that instance」.
//
// The cases that matter are the ones where the OBVIOUS implementation is wrong:
// filtering by `pcName` (which the row already had) instead of by a birth-time
// owner. That shortcut passes any test written around a delivered row and fails
// silently on exactly the rows the feature exists for.

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

TimelineStore _store(_FakeOwner owner) => newTestStore(deviceId: 'phone', owner: owner);

void main() {
  test('a row is stamped with the instance it was SPOKEN TO', () {
    final _FakeOwner owner = _FakeOwner('standalone|instance:pc-a', 'PC-A');
    final TimelineStore s = _store(owner);
    final TimelineEntry e = s.buildFromUtterance(
      clientId: 'u1',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: 'hello',
    );
    expect(e.spokenToInstanceId, 'standalone|instance:pc-a');
    expect(e.spokenToInstanceName, 'PC-A');
  });

  test('a NOTED row keeps its instance even though it never gets a pcName', () {
    // The load-bearing case. 「仅记录」 rows are never delivered, so pcName stays
    // null forever — narrowing by pcName would drop every one of them from the
    // instance the user actually spoke them to.
    final _FakeOwner owner = _FakeOwner('standalone|instance:pc-a', 'PC-A');
    final TimelineStore s = _store(owner);
    final TimelineEntry noted = s.buildFromUtterance(
      clientId: 'u1',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: 'keep this on the phone',
    );

    expect(noted.status, EntryStatus.noted);
    expect(noted.pcName, isNull, reason: 'a noted row is never delivered');
    expect(s.entriesForInstance('standalone|instance:pc-a'), hasLength(1));
  });

  test('a FAILED row also keeps its instance', () {
    final _FakeOwner owner = _FakeOwner('standalone|instance:pc-a', 'PC-A');
    final TimelineStore s = _store(owner);
    s.buildFromUtterance(
      clientId: 'u1',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: 'boom',
    );
    s.applyInjectResult(correlationId: 'u1', ok: false, pcName: 'PC-A');

    final TimelineEntry e = s.entries.single;
    expect(e.status, EntryStatus.failed);
    expect(e.pcName, isNull, reason: 'a failed delivery has no 「where it went」');
    expect(s.entriesForInstance('standalone|instance:pc-a'), hasLength(1));
  });

  test('rows said to a DIFFERENT instance do not show up', () {
    // The defect this card exists to fix: connected to PC-A you used to see
    // everything you had ever said to PC-B.
    final _FakeOwner owner = _FakeOwner('standalone|instance:pc-a', 'PC-A');
    final TimelineStore s = _store(owner);
    s.buildFromUtterance(clientId: 'a1', mode: FlowMode.realtime, delivery: Delivery.inject, text: 'to A');

    owner.instanceId = 'saas|instance:cloud-1';
    owner.instanceName = '云端';
    s.buildFromUtterance(clientId: 'c1', mode: FlowMode.realtime, delivery: Delivery.none, text: 'to cloud');

    expect(s.entries, hasLength(2));
    expect(s.entriesForInstance('standalone|instance:pc-a').single.outputText, 'to A');
    expect(s.entriesForInstance('saas|instance:cloud-1').single.outputText, 'to cloud');
  });

  test('legacy rows belong to NO instance and are never adopted by the open one', () {
    // Rows written before this field existed have no owner. Letting them fall
    // into whichever instance happens to be open would be a silent claim about
    // where they were spoken — the same lie requirement ③ banned when it refused to
    // back-fill `now` onto old pairings.
    final _FakeOwner none = _FakeOwner(null, null);
    final TimelineStore s = _store(none);
    s.buildFromUtterance(clientId: 'old', mode: FlowMode.realtime, delivery: Delivery.none, text: 'legacy');

    expect(s.entriesForInstance('standalone|instance:pc-a'), isEmpty);
    expect(s.entriesWithUnknownInstance, hasLength(1),
        reason: 'still visible in 全部历史, labelled 未知实例 — hidden nowhere');
  });

  test('the owner is read per row, not cached — a reconnect re-stamps', () {
    final _FakeOwner owner = _FakeOwner('standalone|instance:pc-a', 'PC-A');
    final TimelineStore s = _store(owner);
    s.buildFromUtterance(clientId: 'a1', mode: FlowMode.realtime, delivery: Delivery.none, text: 'first');
    owner.instanceId = 'standalone|instance:pc-b';
    owner.instanceName = 'PC-B';
    s.buildFromUtterance(clientId: 'b1', mode: FlowMode.realtime, delivery: Delivery.none, text: 'second');

    expect(s.entriesForInstance('standalone|instance:pc-a').single.outputText, 'first');
    expect(s.entriesForInstance('standalone|instance:pc-b').single.outputText, 'second');
  });

  test('the owner survives a JSON round-trip; a legacy blob reads back null', () {
    final _FakeOwner owner = _FakeOwner('standalone|instance:pc-a', 'PC-A');
    final TimelineStore s = _store(owner);
    final TimelineEntry e = s.buildFromUtterance(
      clientId: 'u1', mode: FlowMode.realtime, delivery: Delivery.none, text: 'x',
    );

    final TimelineEntry back = TimelineEntry.fromJson(e.toJson())!;
    expect(back.spokenToInstanceId, 'standalone|instance:pc-a');
    expect(back.spokenToInstanceName, 'PC-A');

    // A row persisted before this field existed simply lacks the keys.
    final Map<String, Object?> legacy = Map<String, Object?>.from(e.toJson())
      ..remove('spoken_to_instance_id')
      ..remove('spoken_to_instance_name');
    expect(TimelineEntry.fromJson(legacy)!.spokenToInstanceId, isNull);
  });
}
