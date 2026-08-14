// Card F12 (M4-15) —— 🔴 **This card has been superseded by owner ruling ⑩; this file now pins the ruling, not the original card.**
//
// What the original card said (kept in the original wording, because its analysis
// was right — what was wrong was the conclusion it served): a picture the relay
// could not deliver (`INJECT_PC_OFFLINE`) rendered as the **terminal** face
// 「未投递 · 未成功」 with a 「重发」 button, while the queue put the same
// delivery back to `queued` and would re-send it on the next room join —
// 「two layers, giving opposite answers for the same message」.
//
// 🔴 Ruling ⑩ flipped this (`docs/rebuild/15` §2.0.1-c, owner 2026-08-04, original words 「我选未投递」):
//   「那张表的三个词回答的是**这一行现在是什么**，而行的 `EntryStatus` 就是这一行自己的判决。
//    **一条已经判了失败的行说『待投递』，等于让队列的状态去覆盖行自己的判决——两个不同的
//    问题共用一个答案，正是本仓的头号缺陷形状。** 用户在这一行上该做的动作也是『重发』，不是『等』。」
//   And it **names** this as not a contradiction: 「横幅数的是队列…所以这条投递**同时**出现在『未投递的行』
//   和『还有 N 条待投递』里**并不矛盾**，两句话各自都是真的。」
//
// ⇒ The timeline is the key: **M4-15 was opened on 2026-08-02, ruling ⑩ was issued on 2026-08-04; the ruling came later.**
//   In the task book, F7 (per ruling ⑩ 「the code as it stands is correct」) and F12 (per M4-15, change the display)
//   **contradict each other**, and nobody reconciled the pair before 2026-08-04. This file is that
//   reconciliation: **take the ruling, not the old card.**
//
// 🔴 The two 「how NOT to fix this」 analyses **still stand**, kept as-is (they
//   guard two other wrong fixes):
//   · NOT a `wireMode` on `image_send_http`: `INJECT_PC_OFFLINE` carries no
//     remote verdict at all, so its mode is honestly null. Passing `'cached'`
//     there is the same fabrication Card F11 ③ removed from `tryFromJson`.
//   · NOT a code table in `applyInjectResult`: that layer does not hold the fact
//     「does the queue still owe this」, and judging by code alone would promise 「待投递」 for
//     `LINK_DOWN` / `PC_UNREACHABLE` rows that have NO queue item behind them —
//     a wait with no mechanism to redeem it, the red line itself.
//
// ⚠️ THE ASSERTIONS ARE ON THE RENDERED ROW, not on `Text.data` of a widget we
// built ourselves and not on the enum alone: 0.2.53 was paid for exactly that
// (「1259 条全绿，而屏幕上是三个字母」). The enum check is kept as well, because it
// names WHICH face, but the load-bearing assertion is what the tile puts on the
// screen.

import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode, InjectOrigin;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

const AppStrings _zh = AppStringsZh();

const LiveConnection _live = LiveConnection(
  machineUid: 'machine-uid-AAAA',
  pairingIdentity: 'standalone|instance:inst-A-lan',
  pcId: 'pc-A-lan',
  channel: ServerChannel.lan,
);

class _FakeHost implements OutboxDrainHost {
  @override
  LiveConnection get liveConnection => _live;

  @override
  Future<bool> ensureLink() async => true;

  @override
  Future<void> reseedDestination() async {}

  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async => true;

  @override
  void onOutboxChanged() {}
}

Widget _tile(TimelineEntry e, {required bool queued}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: _zh,
      queued: queued,
      canResendImage: false,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

void main() {
  testWidgets(
      'INJECT_PC_OFFLINE: ruling ⑩ — the row speaks its OWN verdict (未投递) while '
      'the queue still owes it; both statements are true at once',
      (WidgetTester tester) async {
    // ── Both layers are REAL, and they are driven with the same code from the
    //    same place `image_send_http` drives them from (`applyInjectResult` at
    //    :129-135 and `settleQueued` three lines below it).
    final TimelineStore store = newTestStore();
    final TimelineEntry row = store.buildFromUtterance(
      clientId: 'u-offline',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: 'a picture caption',
    );
    final DeliveryOutbox box = DeliveryOutbox(
      store: InMemoryOutboxStore(),
      blobs: InMemoryOutboxBlobStore(),
      host: _FakeHost(),
    );
    await box.enqueueText(
      requestId: 'i0-1',
      entryId: row.id,
      wireEntryId: row.id,
      source: 'image',
      text: 'a picture caption',
      mode: 'realtime',
      createdAt: DateTime.utc(2026, 8, 4, 9, 15),
    );
    await box.drain();

    store.applyInjectResult(
      correlationId: row.id,
      ok: false,
      failureReason: 'INJECT_PC_OFFLINE',
    );
    await box.settle(
      correlationId: 'i0-1',
      ok: false,
      code: 'INJECT_PC_OFFLINE',
    );

    // The queue's own answer, read from the queue: still owed.
    expect(box.queuedEntryIds, contains(row.id));

    final TimelineEntry settled = store.findById(row.id)!;

    // 🔴🔴 2026-08-04 lead rewrite —— **this test originally wrote a behaviour owner had already overturned into an acceptance criterion.**
    //
    // It originally asserted: the queue still owes it ⇒ the row must say 「待投递」, must not say 「未投递 · 未成功」.
    // Owner ruling ⑩ (2026-08-04, `docs/rebuild/15` §2.0.1-c, original words 「我选未投递」) says the opposite:
    //   「一条已经判了失败的行说『待投递』，等于让**队列的状态**去覆盖**行自己的判决**——
    //    两个不同的问题共用一个答案，正是本仓的头号缺陷形状。
    //    用户在这一行上该做的动作也是『重发』，不是『等』。」
    // And it **names** this as not a contradiction: 「横幅数的是队列…所以这条投递**同时**出现在
    //  『未投递的行』和『还有 N 条待投递』里**并不矛盾**，两句话各自都是真的。」
    //
    // Timeline: M4-15 (the source of this card F12) was opened on 2026-08-02, ruling ⑩ was issued on 2026-08-04 —— **the ruling came later**,
    // so the 「row and queue each say their own thing」 that M4-15 described **is not a defect; it is the post-ruling target state**.
    // ⇒ The assertions flip entirely: pin the ruling, not the old card.
    //
    // 🔴 Why this is worth writing at this length in a test: 0.2.51 already paid once —
    // 「a reverse control pointed the wrong way is worse than no reverse control:
    //  it does not miss a defect, it **writes the defect as the acceptance criterion**,
    //  and the day the fix arrives the test goes red and people think the fix is wrong.」
    // This is the other face of the same shape: **writing a behaviour the ruling already overturned as an acceptance criterion**,
    // so the next person who implements the ruling gets redded by their own test.
    await tester.pumpWidget(
      _tile(settled, queued: box.queuedEntryIds.contains(row.id)),
    );
    expect(
      find.textContaining(_zh.statusFailed),
      findsOneWidget,
      reason: 'ruling ⑩: the row\'s EntryStatus is this row\'s own verdict; the queue must not override it',
    );
    expect(
      find.textContaining(_zh.statusQueued),
      findsNothing,
      reason: '「待投递」 is the queue\'s word (the banner says it), not this row\'s word',
    );
    // And WHICH face it is, so a future reader knows the word came from here.
    expect(
      deliveryFaceOf(settled, queued: box.queuedEntryIds.contains(row.id)),
      DeliveryFace.failed,
      reason: 'the row speaks its own verdict; the queue speaks in the banner',
    );
    // 🔴 Both statements are true at once — this is the pair of facts ruling ⑩ used to argue 「not a contradiction」.
    // Without this one, anyone who breaks `queuedEntryIds` would go unnoticed.
    expect(
      box.queuedEntryIds,
      contains(row.id),
      reason: 'at the same moment, the queue still owes it — that is what the banner counts',
    );
  });

  testWidgets(
      'a row with NO queue item behind it still reads ✗ — the wait must have a '
      'mechanism', (WidgetTester tester) async {
    // 🔴 THE NEGATIVE CONTROL, and it is the reason the fix reads the queue
    // instead of the code. `LINK_DOWN` is settled locally BEFORE any enqueue
    // (manual_delivery_reinject.dart returns `failSettled` above the enqueue),
    // so nothing owes this row anything. Calling it 「待投递」 would be a promise
    // with nobody to keep it — the exact wording the red line was written about.
    final TimelineStore store = newTestStore();
    final TimelineEntry row = store.buildFromUtterance(
      clientId: 'u-linkdown',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: 'never left the phone',
    );
    store.applyInjectResult(
      correlationId: row.id,
      ok: false,
      failureReason: 'LINK_DOWN',
    );
    final TimelineEntry settled = store.findById(row.id)!;

    expect(deliveryFaceOf(settled, queued: false), DeliveryFace.failed);
    await tester.pumpWidget(_tile(settled, queued: false));
    expect(find.textContaining(_zh.statusFailed), findsOneWidget);
    expect(find.textContaining(_zh.statusQueued), findsNothing);
  });

  testWidgets(
      'a terminal refusal outranks the queue reading — 「must not retry forever」 stays '
      'visible', (WidgetTester tester) async {
    // Order is the contract (docs/rebuild/15 §2.5): `refused` is tested before
    // anything else on this branch. Card F11 ① makes the queue agree by never
    // re-opening such an item, so the two can no longer disagree — but the face
    // must not depend on that, hence this row is fed `queued: true` on purpose.
    final TimelineStore store = newTestStore();
    final TimelineEntry row = store.buildFromUtterance(
      clientId: 'u-mismatch',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: 'crosstalk refusal',
    );
    store.applyInjectResult(
      correlationId: row.id,
      ok: false,
      failureReason: 'INJECT_PC_MISMATCH',
    );
    final TimelineEntry settled = store.findById(row.id)!;

    expect(deliveryFaceOf(settled, queued: true), DeliveryFace.refused);
    await tester.pumpWidget(_tile(settled, queued: true));
    expect(find.textContaining(_zh.statusQueued), findsNothing);
  });
}
