// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A (utterance = row;
//     cancel = no row), §4.0 C (noted withholding), §4.0 D (five-state truth)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (direct vs hold-then-send; terminal final
//     → compose → inject with the LLM product)
//   docs/rebuild/01-PRODUCT-SPEC.md §3.1 (the injected text for translate/organize
//     = the LLM output)
//   docs/archive/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-01
//
// The UTTERANCE LIFECYCLE: everything between "the terminal final landed" and
// "the row has settled". A `part of` chat_controller.dart rather than a separate
// class because this logic is inseparable from the controller's per-utterance
// snapshot state (_activeMode / _activeDelivery / _activeSendPolicy / the
// buffer). Routing all of that through a host interface would invent a seam
// where there is no real boundary; splitting the FILE keeps the 800-line source
// cap honest without inventing an architecture to satisfy it.
//
// Every function takes the controller explicitly ([c]) so a reader can see at
// each line that this is the controller's own state being moved, not a copy.
// Repaints go through [ChatController.ucNotify] because notifyListeners is
// @protected — same one-line hop the other collaborators already use.

part of 'chat_controller.dart';

/// realtime → null (nothing to transform); the other two modes name their task.
/// GA-01: this switch is what makes the mode a PRODUCT rather than a label —
/// before it, every mode injected the raw transcript.
ComposeTask? _composeTaskFor(FlowMode m) => switch (m) {
  FlowMode.realtime => null,
  FlowMode.translate => ComposeTask.translate,
  FlowMode.organize => ComposeTask.organize,
};

void _handleTerminalFinal(ChatController c, SttFinal f) {
  c.recording.observeSegment(f.segmentIdx);
  // 🔴 CARD RC-N — WHOSE FRAME IS THIS (chat_utterance_owner.dart). A failed
  // attempt whose range a newer attempt now owns writes nothing (MAIN ruling
  // 2, option B); a frame of another session than the one on the wire is
  // settled on its own, off its own words and clock.
  final _FinalOwner owner = _ownerOfFinal(c, f);
  if (owner.route == AttemptRoute.superseded) {
    diag('recovery.late_final_dropped', <String, Object?>{
      'attempt_id': owner.attemptId,
      'is_segment': f.isSegment,
    });
    return;
  }
  // 🔴 RC6 (F2 ③) — the live recording's own final, after its tail went to a
  // recovery without it (`_armLiveGrace`): that recovery covers these words
  // from the prefix on, so filing them too put the stretch in twice (re-check 5
  // yield drill: 92 s twice, head 3:32 for 2:00). Dropped, as RC-N drops a
  // result a newer attempt already covers. Keyed on the receipt's echo, else on
  // the live attempt still on the phone.
  final String? liveEcho = f.coverage?.attemptId ??
      (owner.live ? c.session.audio.retainedAudio?.liveAttempt?.attemptId : null);
  if (liveEcho != null && c.session.articles.attempts.isSupersededLive(liveEcho)) {
    diag('audio.continuous.late_live_final_dropped', <String, Object?>{
      'attempt_id': liveEcho,
      'chars': f.text.length,
    });
    return;
  }
  if (owner.foreign) {
    _settleForeignFinal(c, f, owner);
    return;
  }
  final SegmentBuffer segs = c.session.segments;
  // ── 🔴 J5 SEGMENT IDEMPOTENCY — A REPLAYED FINAL MUST NOT MINT A SECOND ROW ──
  // The reconnect ladder replays, and the server's own W2.5-B invariant (one
  // segment_idx is only ever allowed one server final) is what makes an index a usable
  // identity here. Measured before this guard existed: the SAME terminal final
  // arriving twice minted TWO rows carrying the same words — `SegmentBuffer.put`
  // locks the TEXT of a closed slot, which is a different question from 「has
  // this span already been settled」.
  //
  // 🔴 WHAT IS SUPPRESSED IS THE SETTLEMENT, NOT THE FRAME. `ptt_inbound.dart`
  // has already driven `fsm.onSttFinal()` by the time this runs, so the FSM
  // still leaves PROCESSING. A guard that dropped the whole frame instead would
  // strand the FSM in PROCESSING until GA-03's 15 s net — strictly worse than
  // the duplicate row it set out to prevent.
  //
  // ⚠️ `<`, not `<=`: a segment final and the terminal final legitimately share
  // an index when the release lands inside a rollover flush (the FB-6 shape).
  // The watermark only advances when a row was actually minted, so that pair is
  // judged on whether the span is settled — never on the index colliding.
  if (f.segmentIdx < segs.nextUnsettledIdx) return;
  // Card RC-N — a failed attempt's late result is settled as ONE row, on its
  // terminal final, and only if that final comes: its segment finals wait in
  // the buffer instead of minting rows a retry would then mint again.
  if (f.isSegment && owner.route == AttemptRoute.lateFailed) return;
  // Soft-segment final in a mode that settles per utterance: keep growing the
  // live draft, exactly as before N1-B2.
  if (f.isSegment && !_settlesPerSegment(c)) {
    c._liveText = segs.unsettledJoined;
    c.ucNotify();
    return;
  }
  // The span this settlement covers: everything not yet on a row, through the
  // index this final closes.
  final int fromIdx = segs.nextUnsettledIdx;
  final String assembled = segs.joinedFrom(fromIdx);
  if (f.isSegment) {
    // A soft-segment final that carried nothing settles nothing and does NOT
    // advance the watermark — its duration then rides on the next row, which is
    // honest (that row really does cover both spans) and keeps an empty span
    // from costing the user a number.
    if (assembled.trim().isEmpty) {
      c._liveText = '';
      c.ucNotify();
      return;
    }
    _settleSpan(c, f, fromIdx: fromIdx, text: assembled, owner: owner);
    return;
  }
  // Terminal final closes the utterance → build the row of truth (§4.0 A).
  final String clientId = c._activeClientId ?? c._mintClientId();
  c._activeClientId = null;
  // ── 🔴 W2.5 / FB-6 — WHY `joined` STAYS AHEAD OF `f.text` ────────────────────
  // Ruling:
  // docs/decisions/2026-08-06-server-final-is-authoritative-over-phone-joined.md
  //
  // Read literally, that ruling says 「prefer the server's final, fall back to
  // the phone's joined」, and this line looks like the thing it overrules. It is
  // not — the ruling's in-place-correction block moved the authority DOWN A LAYER, to the
  // individual `segment_idx`, and this line is the CROSS-SEGMENT layer:
  //
  //   · same span  → `SegmentBuffer.put(finalized: true)` already REPLACED that
  //     slot's raw interims with the server's processed text, before this
  //     function runs (ptt_inbound.dart writes the final into the buffer in the
  //     same dispatch arm that drives the FSM). So `joined` here is no longer a
  //     raw interim accumulation: it is an assembly OF the server's finals, and
  //     the whole processing chain — normalisation, dictionary, punctuation,
  //     polish — is already inside it.
  //   · different spans → only this device has them. The terminal final carries
  //     ONLY THE LAST SEGMENT: the orchestrator's `rolloverSegment()` clears its
  //     accumulators and increments the segment index every time it closes a
  //     soft segment, so earlier segments exist nowhere else. Preferring `f.text`
  //     here would silently truncate every recording longer than the
  //     soft-segment window down to its final segment. Pinned by the DISJOINT
  //     group in test/server_final_authority_test.dart, which goes red on
  //     exactly that implementation.
  //
  // `f.text` is therefore NOT dead code any more, and its remaining job is the
  // honest one: it answers when this device heard nothing at all (the assembly
  // is empty) — a terminal final that arrived before any interim did.
  // ⚠️ N1-B2 changed WHICH spans this assembles (`joinedFrom(fromIdx)`, i.e. the
  // ones not already on a row) — not the rule above, which is why 「the terminal
  // final carries only the last segment」 still decides it.
  final String text = assembled.isNotEmpty ? assembled : f.text;
  c._liveText = '';
  if (text.trim().isEmpty) {
    // owner 2026-07-27 (reproduced on a real device): the terminal final arrived
    // carrying no text —
    // the engine heard nothing. This used to just `return`, which dropped the
    // 「转录中」("transcribing") draft and said NOTHING, so a press-hold-speak-release
    // cycle ended
    // with the row quietly disappearing. That is exactly「松开提示成功但没有转录」
    // ("releasing shows success but there is no transcript"),
    // and it is a silent failure: the user cannot tell an empty room from a
    // broken mic from a dead engine. Raise the SAME fail-loud banner GA-03
    // already uses for a stalled utterance, carrying the honest reason.
    //
    // 🔴 N1-B2 — 「nothing was heard」 IS NOW A CLAIM ABOUT THE WHOLE UTTERANCE,
    // so it may only be made when NOTHING settled (`fromIdx == 0`). After ten
    // minutes of rows, a final tail span that happens to be silent means the
    // user let go during a pause — telling them 「没有听到语音」("no speech was
    // heard") there would be
    // the mirror of the bug this branch exists to fix: a false negative instead
    // of a silent one. The watermark still advances so a replay is inert.
    c.session.segments.markSettled(f.segmentIdx);
    _emptyTerminalBookkeeping(c, f, owner, fromIdx); // RC-N / ruling 5 / RC-P
    if (fromIdx == 0) {
      // ENG-3: no code/message — no wire ERROR frame is behind this stall, and a
      // NAMED one already stalling this utterance is kept by the routed handler.
      // EMPTY-1: the FINAL frame may say why it is empty — forwarded raw, never re-derived here; null keeps the pre-card sentence byte for byte.
      c._onSttStalled(SttStall(SttStallReason.emptyTranscript, emptyReason: f.emptyReason));
      return;
    }
    // 🔴 CARD RC-B — A RECORDING THAT ENDED IN SILENCE IS STILL FINISHED.
    // This branch used to return here, so its live settle never ran: the SD-2
    // stamp expired and the recovery queue took the WHOLE recording as owed
    // (CR-12-E rerun RB). Its result is its rows, not this empty tail; the
    // entry below says which four facts license the delete (MAIN ruling
    // 2026-09-24) and declines for anything that is not a live final. (RC-B
    // follow-up: ordinary presses too, not only long recordings.)
    unawaited(settleSilentTail(
      session: c.session,
      timeline: c.store,
      receipt: f.coverage,
      finalText: f.text,
      // RC-B follow-up — an ordinary press answers with its own rows.
      pressRecordingId: c._pressRowsRecordingId,
      pressRowIds: List<String>.of(c._pressRowIds),
    ));
    c.ucNotify();
    return;
  }
  final String rowId = _settleSpan(c, f,
      fromIdx: fromIdx, text: text, clientId: clientId, owner: owner);
  // RC-P — after the draft row is placed.
  if (owner.live) _afterLiveTerminal(c, draftLanded: true, draftRowId: rowId);
}

/// 08 §5 landing rule (F-2): a final ALWAYS appends — it never replaces.
/// An empty buffer takes the text as-is; a non-empty one gets `「buffer」 +
/// ' ' + 「text」`. Accumulating finals therefore chain naturally across a
/// multi-utterance manual send.
///
/// 🔴 NR-4-P1 (h) — anti-façade ④. This comment used to read 「if manually
/// typed → APPENDED …; if not manually typed → it REPLACES the buffer」,
/// describing a fork on 「did the user type this」 that has no counterpart in
/// the body below and no caller that could supply the distinction: there is
/// ONE expression here and it branches only on `_buffer.isEmpty`. The empty
/// case is what made the false half look true — assigning `text` into an
/// empty buffer is byte-identical to 「replacing」 it, so nobody reading a
/// trace could tell the two stories apart. What actually keeps a typed draft
/// safe is the append itself, not a branch: type into the box, speak, and the
/// spoken final lands AFTER what was typed.
void _foldIntoBuffer(ChatController c, String text) {
  c._buffer = c._buffer.isEmpty ? text : '${c._buffer} $text';
}

/// The explicit ➤ body (ChatController.sendBuffer). The UI greys ➤ out for the
/// guard reasons, so those are races; every failure also raises the banner.
///
/// RV-06 — everything below clears by SNAPSHOT, never wholesale.
///
/// `deliverText` became an await in 0.2.16: it now holds the RCA-v3 ack gate
/// (link probe → row landing → possible kick-and-recover), which is 1–20 s wide.
/// STT does not stop for it — a terminal final that arrives inside that window
/// keeps folding into the SAME `_buffer` and appending to `_bufferedEntryIds`,
/// and in organize mode that routinely happens 1–3 s after the press. Clearing
/// both unconditionally on completion therefore deleted sentences this send
/// never carried: the user said something, saw it in the box, and it vanished
/// with no row and no banner. Content loss, i.e. the reddest of the red lines.
///
/// Chosen over a second buffer (fold-during-send into buffer B, splice back
/// after) because `_buffer` is also the composer TextField's text: two of them
/// would need a merge rule for every edit path — typing, ✕, mode switch, the AI
/// row — while a snapshot needs none. The rule is simply 「this send owns exactly
/// what it was handed」.
Future<ComposeSendFailure?> _sendBuffer(ChatController c) async {
  final String sentText = c._buffer;
  final List<String> sentIds = List<String>.of(c._bufferedEntryIds);
  // 🔴 T-7 (owner supplement #6「发出去后也要关联的有最开始转录的原文」("even after
  // it's sent out, it still needs to stay linked to the very first transcribed
  // original text")): read in the
  // SAME synchronous breath as the text and the ids — this is one more thing
  // 「this send owns exactly what it was handed」 has to cover, and T-6 retires
  // it the moment the send succeeds, so re-reading it after the await would
  // sometimes find null.
  //
  // ⚠️ It is a FALLBACK, never an override: the covered row's own immutable
  // `source_text` still wins wherever it exists (delivery_source_text.dart says
  // why in full — in translate/organize this value is the previous LLM product,
  // not the spoken words).
  final String? aiOriginal = c.aiCompose.restorableOriginal;
  final ComposeSendFailure? failure = await c.delivery.deliverText(
    sentText.trim(),
    covered: sentIds,
    originalText: aiOriginal,
  );
  if (failure != null) {
    // A wire/link failure already settled the covered rows as ✗ failed inside
    // deliverText; the buffer list must not keep pointing at them. Only THOSE
    // rows, though: a row folded in during the window was never covered by this
    // send, so nothing settled it, and it is still waiting for its own ➤. Ending
    // it with a failure it was not part of is guilt by association.
    if (failure == ComposeSendFailure.wireFailed ||
        failure == ComposeSendFailure.linkDown) {
      _forgetBufferedRows(c, sentIds);
    }
    return failure;
  }
  _forgetBufferedRows(c, sentIds);
  c._buffer = _bufferAfterSend(c._buffer, sentText);
  // 🔴 T-6: delivered ⇒ 「恢复原文」("restore original text") retires. The original went WITH the delivery
  // (T-7 puts it on the frame as `source_text`), so from here on the place to
  // read it is the row, not a button over a buffer that no longer holds those
  // words. ⚠️ Only on SUCCESS: a failed send leaves the text in the box, and a
  // draft still sitting there must keep its way back.
  c.aiCompose.forgetRestorable();
  c.deliveryNotify();
  return null;
}

/// Drop exactly the rows [sent] covered, keeping any that were folded in while
/// the send sat in the ack gate (RV-06).
void _forgetBufferedRows(ChatController c, List<String> sent) {
  final Set<String> covered = sent.toSet();
  c._bufferedEntryIds.removeWhere(covered.contains);
}

/// What stays in the composer after [sent] was delivered (RV-06).
///
/// [_foldIntoBuffer] only ever APPENDS with a single space, so the delivered
/// text is a prefix of whatever the buffer grew into during the send — strip it
/// and keep the tail. Two deliberate non-prefix cases, both resolved by leaving
/// the buffer completely alone: the user re-edited the composer mid-send (their
/// text is theirs — half-erasing it on a guess is worse than leaving a
/// duplicate they can see and fix), and ✕ / a mode switch already blanked it
/// mid-send (blank stays blank; resurrecting the words the user just discarded
/// would undo an explicit action).
String _bufferAfterSend(String now, String sent) {
  if (now == sent) return ''; // the ordinary case: nothing arrived mid-send
  if (!now.startsWith(sent)) return now;
  return now.substring(sent.length).trimLeft();
}

// `_gateEntry` was here: `await c.syncGate.onEntryBuilt(entry)` (the §4.0 C
// room-sync gate) followed by the optional direct delivery. Removed in 0.2.27 —
// with the create gone it was a wrapper around one `if`, and the three call sites
// now say what they mean. The rows that used to reach it with `deliver: false`
// (a 「仅记录」("record only") utterance, a failed LLM run) now do nothing at all,
// which is the
// whole point: the record is already written, locally, by its owner.

/// direct-send (08 §5): the terminal final delivers the whole utterance in one
/// inject:request. Both correlation keys ride along so the PC's inject:result
/// lands back on exactly this row (A-58 echo).
///
/// [source] is `stt` for a realtime utterance and `llm` for a transformed one
/// (08 §5) — the PC is told what it is being handed, and the desktop's INJ-1
/// AUTO window already treats both alike.
///
/// A record-only utterance is NOT delivered (its row is already 📥 noted) and a
/// cloud record has no PC at all — neither is a failure, so neither is raised.
Future<void> _deliverDirect(
  ChatController c,
  TimelineEntry entry, {
  InjectSource source = InjectSource.stt,
}) async {
  if (entry.origin == 'cloud') return;
  if (entry.delivery == Delivery.none) return;

  // ── 🔴 PERSIST TO DISK BEFORE SENDING (design draft §3.1), window B3-2c ──────
  //
  // THE SNAPSHOT RULE, AND WHY IT IS ALREADY SATISFIED HERE. Every argument
  // below is read SYNCHRONOUSLY, at this call, and every one of them comes off
  // `entry` — an immutable row whose `mode`, `text` and `createdAt` were fixed
  // when it was built. Nothing is read from `c._activeMode` or from the clock,
  // so a mode switch or a new utterance landing inside the `await` cannot change
  // what was queued. (`_activeMode` is documented as 「the last spoken
  // utterance's snapshot … can be anything」 — reading it here is the bug this
  // note exists to keep out.) Pinned by a test that mutates both inside the
  // window and asserts the queued item byte-for-byte.
  //
  // ⚠️ THE EMIT BELOW IS DELIBERATELY **NOT** ROUTED THROUGH `outbox.drain()`,
  // and this is a decision rather than an omission. A drain opens with an ACKED
  // round-trip (design draft §3.3), and this is the direct-send path — the one that
  // exists so a spoken sentence reaches the PC without waiting for anything.
  // Putting a probe in front of every utterance is a product-level latency
  // change nobody asked for. What the queue buys HERE is durability only: the
  // delivery is on disk before the frame leaves, so if the process dies between
  // the emit and the receipt (RV-60's window) the next launch drains it. Success
  // still settles it through `inject:result` → `outbox.settle`, and a frame that
  // never leaves simply stays `queued` for the next reconnect drain.
  //
  // A null means the queue could not take it (blob/destination — it says which
  // in its own diag). That degrades DURABILITY, never delivery: refusing to
  // send a sentence because we could not also persist it would turn a weaker
  // retry story into a failed delivery the user can see.
  final OutboxItem? queued = await c.outbox.enqueueText(
    requestId: entry.clientId,
    entryId: entry.id,
    // A direct-send utterance always built its own row, so the frame names it —
    // exactly what the emit below has always stamped.
    wireEntryId: entry.id,
    source: source.name,
    text: entry.displayText,
    mode: entry.mode.name,
    createdAt: entry.createdAt,
    sourceText: entry.showsSourceLine ? entry.sourceText : null,
    deviceLabel: cachedDeviceLabel(),
    // owner 2026-08-02: the row's engine-reported duration rides the delivery
    // (and the queued retry — the item persists it) so the PC row can answer
    // 「说了多久」("how long did they speak"). Null on rows that never had one —
    // absence, not 0.
    durationMs: entry.durationMs,
  );
  diag('utterance.direct_enqueued', <String, Object?>{
    'request_id': entry.clientId,
    'durable': queued != null,
  });

  final bool ok = c.composeGate.emitInject(
    InjectRequestPayload(
      text: entry.displayText,
      source: source,
      // 🔴 L8 (owner 2026-08-02) — 现场话 (a live, in-the-moment utterance). This is
      // the direct-send path: the user
      // finished speaking a moment ago and is watching for the words to appear.
      // It is the FIRST row of owner's ruling table (照旧自动注入 / "auto-inject as
      // usual"), and it is a
      // literal rather than a call to `outboxInjectOrigin` because there is no
      // judgement to make — the whole existence of this call site is 「刚说完，
      // 马上投」("just finished speaking, deliver it right away"). If this delivery
      // does NOT get through, its queued retry is
      // judged by the rule (`DeliveryOutbox._attempt`) and becomes a deferred
      // delivery (补投) once it
      // is old, which is exactly right: by then nobody is waiting for it.
      //
      // ⚠️ card F3 — THIS FUNCTION NOW HAS A SECOND CALLER AND ITS PREMISE IS NOT
      // THE SAME ONE. [_deliverRerun] arrives here after a long-press re-run,
      // where 「刚说完」("just finished speaking") is false (the row can be days
      // old) but the SECOND row of
      // the same ruling table applies verbatim: 用户手动操作无条件算预期，不看时间
      // ("a user's manual action counts as expected unconditionally, regardless
      // of timing")
      // (volume 15 §2.5e-1 / §2.5e-3, which short-circuits the clock BEFORE the
      // window rather than `&&`-ing with it). Two premises, same value, and the
      // literal is still correct for both — spelled out because the sentence
      // above is a greppable claim (anti-façade ④) and a reader who stopped at it
      // would conclude a re-run must be judged `deferred`, which would make the
      // PC refuse to type something the user is standing there waiting for.
      injectOrigin: InjectOrigin.live,
      requestId: entry.clientId,
      entryId: entry.id,
      // RV-74 (owner real-device test, 2026-07-31). This was MISSING, and the
      // cost was not a
      // wrong label: the PC's row builder defaults an absent mode to 'realtime'
      // and says so (`gaps=[mode→realtime(guess)]`, socket/row_transit.rs), and
      // TimelinePage's `canExpandSource()` gates the 「原文」("original text") column on
      // mode==='translate'||'organize' — so every translated/organized row this
      // path delivered rendered ONE column on the PC while the phone showed two,
      // and the timeline's realtime/translate/organize (实时/翻译/整理) filter swept
      // them all into realtime (实时).
      //
      // `entry.mode`, NOT `c._activeMode`: they agree today (canPtt blocks a new
      // utterance while a compose run is in flight, so the snapshot cannot move
      // under an `_ucDone` that is still pending), but that is a non-local
      // invariant living in another file, and `_activeMode` is explicitly
      // documented as 「the last spoken utterance's snapshot … can be anything」
      // (chat_controller.dart, the GA-13 reprocess note). The ROW's own mode was
      // fixed when the row was built and is immutable — the same reason
      // `createdAt` below reads off the entry rather than off the clock. It is
      // also literally what this field means (schema: 「how the entry was
      // PRODUCED」) and what the phone's own timeline renders, which is the whole
      // point: two timelines showing one answer.
      //
      // ⚠️ NOT `inject:result.mode` (sendinput/clipboard/cached) — same key,
      // different question. Red line 「三模式锁定，永无第四模式」("three modes are
      // locked, there is never a fourth mode"): FlowMode has exactly
      // three members, so a fourth cannot be constructed here.
      mode: entry.mode,
      // card M row-transit fields (docs/decisions/2026-07-31-owner-two-channels-
      // transit-not-storage.md): this ONE frame is the PC's only way to build
      // this row, so it carries what the row is made of.
      // The row's own birth time (when it was SPOKEN), not now.
      createdAt: entry.createdAt,
      // Non-null only when a compose transform genuinely diverged the face
      // from the immutable original (translate/organize) — the SAME test the
      // 「原文」("original text") source line on this device already uses. Realtime and a
      // polish-skipped row have no distinguishable original, so this is the
      // explicit `null` the schema gives that exact meaning to.
      sourceText: entry.showsSourceLine ? entry.sourceText : null,
      // Same duration the enqueued item persists — one utterance, one number.
      durationMs: entry.durationMs,
      // A direct-send utterance is never a picture (the image path is a
      // SEPARATE call site, image_send_controller.dart) — omit, not 'transcript'.
      entryType: entry.isImage ? entry.entryType : null,
      thumbB64: entry.isImage ? entry.thumbB64 : null,
      deviceLabel: cachedDeviceLabel(),
      // 🔴 no-crosstalk red line. Null (⇒ omitted) is honest, not a guess —
      // see PttSession.pcId's doc for when that is still possible.
      targetPcId: c.targetPcId,
    ),
  );
  if (ok) return;
  // ── 🔴 card B2-H (P1-3) — A DIRECT-SEND WIRE FAILURE MUST NOT OUTRUN THE
  // QUEUE'S OWN VERDICT ──────────────────────────────────────────────────────
  //
  // The frame never left the device, but [queued] (persisted a few lines
  // above, BEFORE the emit) already answers the only question that matters
  // here: does something still owe this delivery? When it does
  // (`queued != null`), the item sits `queued` in the outbox exactly as it
  // would after `chat_outbox_host.dart`'s own `outboxSend` returns false on
  // the very same kind of emit failure — that call site never fail-settles
  // the row either, it just returns false and leaves the item `queued` for
  // the next drain. Fail-settling THIS row as well would run one failure
  // through two doors that do not know about each other: the row lands on ✗
  // `EntryStatus.failed` (owner ruling ⑩, docs/rebuild/15 §2.0.1-c — a
  // `failed` row's own status IS its own verdict, never overridden by the
  // queue's state) while the outbox is about to retry the SAME request on its
  // own schedule, and when that retry lands the row silently flips ✗ → ✓ with
  // no user action in between — the exact "flips to ✓ later" symptom this
  // card is named for.
  //
  // Only when the outbox itself refused the item at the door
  // (`queued == null` — `DeliveryOutbox._admit`'s one reason is
  // `NO_DESTINATION`, i.e. the user has since left the session) is there
  // truly nothing left to retry against; THIS emit was the delivery's only
  // chance, so the row must say so now.
  if (queued != null) {
    diag('utterance.direct_send_wire_failed_queued', <String, Object?>{
      'request_id': entry.clientId,
      'entry_id': entry.id,
    });
    return;
  }
  // The queue could not take this delivery either, so nothing will ever
  // retry it: say so on the row instead of leaving it stuck at ⏳ pretending a
  // delivery is still in flight (no silent failures). The banner is raised
  // through ManualDelivery so a direct-send wire failure and a ➤ wire failure
  // are ONE banner, not two competing truths.
  c.delivery.failSettled(<String>[entry.id], ComposeSendFailure.wireFailed);
}

