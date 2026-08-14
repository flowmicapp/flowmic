// Part of chat_controller.dart — THE SETTLEMENT OF ONE SPAN (N1-B2).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_utterance.dart went to 820 against `verify/lint/file-size.mjs`'s
// SRC_MAX = 800 when N1-B2 turned 「一次说话＝一行」("one utterance = one row")
// into 「一段＝一行」("one segment = one row") (docs/rebuild/15 §2.0-c). This
// repo's established practice is **structural splitting, not deleting
// evidence**: what needs cutting is 「内容不该在这里」("content that does not
// belong here"), not 「内容太长」("content that is too long").
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR —— [_settlesPerSegment] and [_settleSpan]
// were moved out of chat_utterance.dart character-for-character, not one
// character changed. They are one self-contained unit: **"how an already
// finalized span becomes a row, and starts its delivery"**.
// What chat_utterance.dart kept is its **upstream** — which frame should
// trigger a settlement.
// **Any diff beyond the move is a bug.**

part of 'chat_controller.dart';

/// True when THIS utterance settles segment-by-segment (15 册 §2.0-c).
///
/// ── 🔴 N1-B2 — WHY realtime ONLY (RULED: owner 2026-08-11 deferred-batch #3) ──
/// 15 册 §2.0-c writes the new cardinality (one segment = one row) without
/// saying a word about translate/organize, and the code answers for it:
/// [UtteranceComposeController.start]
/// is STRICTLY SINGLE-FLIGHT (`if (isRunning) return busy`, one `_entryId`, one
/// `_requestId`, one watchdog `_timer`). Settling per segment there would hand
/// segment 2 onward a `busy` failure each — i.e. every segment after the first
/// would render as a failed transform.
///
/// ✅ This began life as an interim default awaiting owner approval item #9.
/// **The owner ruled on 2026-08-11: whole-utterance settle for
/// translate/organize is the TERMINAL state, and the widen-to-per-segment
/// option is dead, not deferred**
/// (docs/decisions/2026-08-11-owner-deferred-batch-explanations-and-rulings.md
/// §2 #3; 15 册 §2.0-c carries the same verdict). The pin in
/// `chat_segment_settlement_test.dart` 「translate/organize 维持整次结算」
/// ("translate/organize keep whole-utterance settlement") now guards a
/// ruling, not a placeholder.
/// ⚠️ The same batch mandated the unified segment/session package; until its
/// §2-R2 question returns (the doc-15 ruling-request book #15), the realtime
/// half of this predicate is frozen too — in BOTH directions.
bool _settlesPerSegment(ChatController c) => _composeTaskFor(c._activeMode) == null;

/// Turn the spans `[fromIdx, f.segmentIdx]` into ONE row and start its delivery.
///
/// The single settlement path: a soft-segment final in realtime and the terminal
/// final in every mode both land here. 🔴 **There must never be a second one** —
/// the 15 册 §2.0-c cardinality change was accepted on the basis that a segment
/// row is the SAME KIND of row, and a copy of this fork would give 「what happens
/// to a settled span」 two answers (this repo's #1 defect shape).
void _settleSpan(
  ChatController c,
  SttFinal f, {
  required int fromIdx,
  required String text,
  String? clientId,
}) {
  final SegmentBuffer segs = c.session.segments;
  // 🔴 REG-D1 — Σ over the spans THIS row covers, never `f.durationMs`. For the
  // whole-utterance settlement that sum IS the whole recording; for a segment
  // row it is that span. `f.durationMs` answers 「这一段有多长」("how long is
  // this segment") on both exits since `24b75cc`, so copying it onto a
  // whole-utterance row reported the last segment only. 0 ⇒ nothing in range
  // reported one ⇒ NULL (absence, not 0 — entry_metrics.dart).
  final int spanMs = segs.durationBetween(fromIdx, f.segmentIdx);
  final TimelineEntry entry = c.store.buildFromUtterance(
    clientId: clientId ?? c._mintClientId(),
    mode: c._activeMode,
    delivery: c._activeDelivery,
    text: text,
    sourceLang: f.language.isNotEmpty ? f.language : null,
    durationMs: spanMs > 0 ? spanMs : null,
    // How many engine spans stand behind THIS row — not how many the utterance
    // has had. They coincide exactly when the row is the whole utterance.
    segmentsCount: f.segmentIdx - fromIdx + 1,
    origin: c.destination.isFixed ? 'cloud' : 'paired',
  );
  // 🔴 J5 — the row exists, so the span is spoken for. Advance BEFORE any
  // `await`-carrying delivery so a replay landing inside that window is judged
  // against a watermark that already includes this row.
  segs.markSettled(f.segmentIdx);
  c._liveText = '';
  // Card D-2 — the ONE place that knows a row was made out of speech. Written
  // here rather than derived later because nothing on the row records it:
  // `entry_type` is 'transcript' for a typed note and a favorite-phrase (常用语)
  // tap too, and `segments_count` / `duration_ms` are engine readings, not
  // provenance. See [ChatController._lastUtteranceEntryId] for why this is not
  // a wire key.
  c._lastUtteranceEntryId = entry.id;
  // Honest signal only — does not touch entry.status / timeline schema. The
  // mark is per-entry and session-persistent (lead's ruling): once an utterance
  // reports polish:skipped its bubble keeps the mark; later utterances never
  // clear earlier marks.
  if (f.polish == SttPolish.skipped) {
    c._polishSkippedEntryIds.add(entry.id);
  }
  // GA-01: translate / organize are PRODUCT modes, not metadata. The row is
  // built (the utterance happened) but nothing is delivered or synced yet — the
  // LLM runs first and the finished text goes up in ONE history:create. The
  // row's face meanwhile is the STT text: honest, and never delivered.
  // realtime falls through to the direct/manual fork below, unchanged.
  //
  // ⚠️ N1-B2: this arm is reachable ONLY from the terminal final, because
  // [_settlesPerSegment] is exactly `task == null`. That is not a coincidence to
  // be tidied away — it is the whole reason translate/organize still settle once
  // per utterance (see that predicate for the single-flight measurement).
  final ComposeTask? task = _composeTaskFor(c._activeMode);
  if (task != null) {
    final AiComposeFailure? failed = c.utteranceCompose.start(
      entryId: entry.id,
      requestId: entry.clientId,
      task: task,
      sourceText: text,
      sourceLang: entry.sourceLang,
      // The target language rides along ONLY for translate; organize rewrites
      // in place and has no target pair.
      targetLang: task == ComposeTask.translate ? c._translateTarget : null,
    );
    if (failed != null) c.ucFailed(entry.id, AiComposeOutcome(reason: failed));
    c.ucNotify();
    return;
  }
  // 08 §5 send policy fork. The ROW is built either way (§4.0 A: the utterance
  // completed, so the record exists) — only the DELIVERY differs.
  if (c._activeSendPolicy == SendPolicy.manual &&
      entry.delivery != Delivery.none &&
      entry.origin != 'cloud') {
    // hold-then-send: nothing is delivered now. The text lands in the editable
    // buffer and the row stays ⏳ until the explicit ➤ (or settles at 📥 noted
    // if the user discards the buffer).
    //
    // A 「仅记录」("record-only")/cloud utterance is deliberately NOT folded
    // in: it was never meant for the PC (「留在手机」 — "stays on the phone"),
    // so pre-loading it into the send box would stage exactly the accidental
    // delivery §4.0 C exists to prevent. Its row is already 📥 noted, and a
    // long-press deferred re-delivery (长按补投) remains the explicit way to
    // send it.
    _foldIntoBuffer(c, text);
    c._bufferedEntryIds.add(entry.id);
  }
  // 0.2.27: the §4.0 C emit-side gate (`_gateEntry` -> `history:create`) used to
  // run here before the delivery. There is no room row to create any more (owner
  // architecture ruling), and the ordering it bought — 「the stored row provably
  // precedes the inject」 — is moot now that the phone owns the row. §4.0 C itself
  // still holds and is now STRUCTURAL: a 「仅记录」("record-only") row is not delivered, so it
  // never leaves this device.
  if (c._activeSendPolicy == SendPolicy.direct) {
    unawaited(_deliverDirect(c, entry));
  }
  c.ucNotify();
}
