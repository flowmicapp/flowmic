// REQ-12-13 800-line cap — minting the row for a remote key press moved out
// of timeline_store.dart
// (803/800) into a `part` of the same library, exactly as `卡 F11` did for the
// inject:result write-back beside it.
//
// 🔴 SAME SHAPE, SAME REASON: the method became a library-private top-level
// function taking the store explicitly, which works because a `part` shares the
// library (`store._entries` is still in scope). `TimelineStore.buildControlRow`
// stays on the class as a one-line delegate, so **no caller and no test double
// had to be edited**.
//
// WHY THIS IS THE RIGHT CUT: timeline_store.dart answers 「what does this
// phone remember」 about
// UTTERANCES — build / find / edit / delete / purge, all of them about words that
// were said. This file answers a different question that happens to share the
// storage: 「what does one key press leave behind」 (docs/rebuild/15 §2.0-e,
// the ⌨ segment), a row with no
// text, no mode and no delivery.

part of 'timeline_store.dart';

/// 🔴 REQ-12-13 (owner P0 2026-08-12) — the row for ONE remote key press.
/// Contract: docs/rebuild/15 §2.0-e.
///
/// **CALLED ONLY AFTER THE FRAME REALLY LEFT THE DEVICE.** That is the entire
/// claim this row makes, and it is the only one this end can make: `control:key`
/// has no receipt, so 「did the computer receive it / did the computer
/// execute it」 has no evidence here at all —
/// the answer to those lives on the PC's own row (doc 15 §2.0-e / §6 G-24).
/// A press that never left the device mints NOTHING and raises the compose
/// banner instead: a receipt for a non-event is the other direction of no silent failure.
///
/// **NOT [buildFromUtterance] with a different `entryType`**, and the difference is
/// not cosmetic: that one requires a `mode`, a `delivery` and a `text`, and this row
/// has none of the three. Passing 「whatever value」 for each is exactly how a
/// filler value
/// becomes a judgement downstream (0.2.49 F2b: a 「randomly picked」 placeholder was
/// treated downstream as a verdict).
///
/// Addressing: `spokenToInstanceId` / `spokenToInstanceName` are stamped from the
/// SAME owner probe every other row uses, at birth — the instant of the press. There
/// is no queue and no drain on this path, so nothing is ever re-derived later from
/// 「who is currently connected」, which is the shape the cross-wired-ID red line forbids.
///
/// [kind] is the wire kind (`clear` / `backspace` / `undo` / `enter`), not a label:
/// the four-language face is composed at render time.
TimelineEntry buildControlRowOf(
TimelineStore store, {
required String clientId,
required String kind,
}) {
  final TimelineEntry? existing = store.findByClientId(clientId);
  if (existing != null) return existing;
  final DateTime now = DateTime.now().toUtc();
  final TimelineEntry entry = TimelineEntry(
    id: TimelineEntry.mintLocId(store._deviceId, clientId),
    clientId: clientId,
    // Structural fillers, every one of them named in the field docs rather than
    // hidden: a keypress has no mode, no delivery intent and no words.
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: null,
    outputText: '',
    // See TimelineEntry.controlKind: NOT this row's answer to anything, chosen so
    // that a mis-render is a low claim (「stayed on the phone」) rather than 「delivered」.
    status: EntryStatus.noted,
    entryType: TimelineEntry.kControl,
    controlKind: kind,
    spokenToInstanceId: store._owner.instanceId,
    spokenToInstanceName: store._owner.instanceName,
    createdAt: now,
    updatedAt: now,
  );
  // `_insertNew` rather than the four steps inline: `notifyListeners` is
  // `@protected`, and a `part` shares the library but not the class, so the
  // notify has to stay on an instance member. Same constraint (and the same
  // resolution) `chat_explicit_delivery.dart` records for `notifyUi`.
  store._insertNew(entry);
  return entry;
}
