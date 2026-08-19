// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A (utterance = row;
//     cancel = no row), §4.0 C (noted withholding), §4.0 D (five-state truth)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (direct vs hold-then-send; terminal final
//     → compose → inject with the LLM product)
//   docs/rebuild/01-PRODUCT-SPEC.md §3.1 (the injected text for translate/organize
//     = the LLM output)
//   docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-01
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
    _settleSpan(c, f, fromIdx: fromIdx, text: assembled);
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
    if (fromIdx == 0) {
      // ENG-3: no code/message — this stall has no wire error frame behind it,
      // and if a NAMED terminal stt:error already stalled this utterance the
      // routed handler keeps that one (see onSttStalledRouted's race guard).
      c._onSttStalled(const SttStall(SttStallReason.emptyTranscript));
      return;
    }
    c.ucNotify();
    return;
  }
  _settleSpan(c, f, fromIdx: fromIdx, text: text, clientId: clientId);
}

/// 08 §5 landing rule (F-2): if manually typed → the final is APPENDED after the
/// typed text with a single space; if not manually typed → it REPLACES the
/// buffer. Accumulating finals therefore chain naturally across a
/// multi-utterance manual send.
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
  // The frame never left the device. Say so on the row instead of leaving it
  // stuck at ⏳ pretending a delivery is still in flight (no silent failures).
  // The
  // banner is raised through ManualDelivery so a direct-send wire failure and
  // a ➤ wire failure are ONE banner, not two competing truths.
  c.delivery.failSettled(<String>[entry.id], ComposeSendFailure.wireFailed);
}

/// GA-13 / 🔴 card F3 — re-run the CURRENT mode's transform over an EXISTING row's
/// original words, and deliver the product as a NEW delivery.
///
/// The source is `source_text`, which is immutable, so a reprocess is always a
/// fresh run over the original words rather than a translation of a translation.
/// Returns a fail-loud reason when the run could not even start; null once the
/// frame is away (the terminal arrives through the same uc* callbacks).
AiComposeFailure? _reprocessEntry(ChatController c, TimelineEntry entry) {
  // The CURRENT mode, not `_activeMode`: that one is the last spoken utterance's
  // snapshot (§4.0 B), which after a mode switch is no longer what the menu item
  // promised («用当前模式重跑» / "re-run with the current mode").
  final FlowMode mode = c.mode;
  final ComposeTask? task = _composeTaskFor(mode);
  // realtime has no LLM stage, and a row with no original words has nothing to
  // re-run. Both are 「按钮不该出现在这里」("the button shouldn't appear here")
  // races rather than server failures —
  // the menu only offers the action when neither holds (see the guard it shares).
  if (task == null) return AiComposeFailure.emptyBuffer;
  final String source = entry.sourceText ?? '';
  if (source.trim().isEmpty) return AiComposeFailure.emptyBuffer;
  // 🔴 card F3 defect ① — ASKED HERE, BEFORE `_reprocessingEntryIds` IS TOUCHED, and
  // the order is the whole point rather than tidiness.
  //
  // `start` refuses a second run itself (that guard is the structural one), but
  // if this function had already written the map it would then take the
  // `failed != null` branch and `remove(entry.id)` — which, when both presses
  // name the SAME row, deletes the FIRST run's registration. That run's
  // `compose:done` would then miss the reprocess fork in `_ucDone` and fall
  // through to the ORDINARY utterance terminal: `applyProcessed` under
  // `_activeMode` (the last spoken utterance's mode, not this one's) plus a
  // delivery under the spoken-utterance rules. One press, two wrong answers.
  if (c.utteranceCompose.isRunning) return AiComposeFailure.busy;
  c._reprocessingEntryIds[entry.id] = mode;
  final AiComposeFailure? failed = c.utteranceCompose.start(
    entryId: entry.id,
    // A FRESH correlation id: this run is not the original utterance, and
    // reusing that id would make the two indistinguishable in the echo.
    requestId: '${entry.clientId}-rp${DateTime.now().microsecondsSinceEpoch}',
    task: task,
    sourceText: source,
    sourceLang: entry.sourceLang,
    targetLang: task == ComposeTask.translate ? c._translateTarget : null,
  );
  if (failed != null) c._reprocessingEntryIds.remove(entry.id);
  return failed;
}

/// 🔴 card F3 — the reprocess terminal: a NEW row and a NEW delivery.
///
/// owner 2026-08-04 ruling ③ + confirmation point A（`2026-08-04-owner-ten-rulings-0.3.0.md`）:
/// 「Re-send it as a new delivery to the PC; the PC receives a new row (not a
/// replacement of the old one)」，「手机侧那一行原来已被结算成终态，所以「重跑」不是
/// 改它，而是产出一条新的投递；两行都留在时间线上（一条原模式、一条新模式）」
/// ("the row on the phone side has already been settled into a terminal state,
/// so a 'rerun' does not modify it — it produces a new delivery instead; both
/// rows stay on the timeline, one in the original mode and one in the new
/// mode").
///
/// WHY THE OLD PATH WAS TRANSFORMED RATHER THAN LEFT BESIDE A NEW ONE. Until
/// this card the terminal was `store.applyProcessed(entryId, …)` and a comment
/// that read 「it does not re-deliver … Re-injecting on the user's behalf would
/// type into their window because they asked to re-translate」. That reading was
/// overruled — but the deeper reason not to keep it as a second path is that it
/// makes the SAME press answer 「这一行现在是什么」("what is this row right now")
/// two ways: the phone would show
/// the new product while the PC still holds the words it was actually sent, on a
/// row that was already settled ✓ injected. Two trigger edges for one action is
/// the shape `chat_outbox_host.dart` names as the F-1 hazard (「两个触发边会让
/// 「为什么这条投出去了」有两个答案，而其中一个答案是错的」("two trigger edges give
/// 'why did this get delivered' two answers, and one of the two answers is
/// wrong")), and R4 forbids the row
/// itself carrying two answers.
///
/// WHY A NEW ROW ON THIS END TOO, when resend (重发) deliberately keeps the old
/// one
/// (volume 15 §2.3): resend (重发) sends the SAME words again, so nothing new
/// was born here;
/// a re-run produces DIFFERENT words. Writing them onto the old row would
/// overwrite a settled record of what really was delivered — 「已注入 PC 的文本永
/// 不回改」("text already injected into the PC is never edited back") (06 §5)
/// applied to the row that says it.
///
/// The delivery itself is NOT a new send station: it is `_deliverDirect` with
/// `source: llm`, byte-for-byte the path a translate/organize utterance's own
/// product already takes. So the new row gets a fresh `request_id` (its
/// `clientId`), persisted to disk before sending (落盘先于发送) through the
/// outbox, `target_pc_id` addressing and
/// the PC's `inject:result` as its only proof — one implementation of 「一条加工
/// 产物怎么投」("how a processed product gets delivered"), not two.
void _deliverRerun(
  ChatController c,
  String sourceEntryId,
  String processedText,
  FlowMode mode,
) {
  // The row was deleted while the LLM was running. There is nothing to re-run
  // FROM (the original words live on that row), so nothing is built and nothing
  // is delivered — inventing a row here would put words on the PC that no
  // record on this phone accounts for.
  final TimelineEntry? origin = c.store.findById(sourceEntryId);
  if (origin == null) {
    diag('reprocess.row_gone', <String, Object?>{'entry_id': sourceEntryId});
    c._raiseUtteranceFailure(
      const AiComposeOutcome(reason: AiComposeFailure.emptyBuffer),
    );
    return;
  }
  final String source = origin.sourceText ?? '';
  if (source.trim().isEmpty) {
    // R5 (`source_text` write-once immutable) plus `_reprocessEntry`'s own guard
    // make this unreachable today. It is still said out loud rather than
    // returned quietly: a product the user waited for that lands nowhere is a
    // silent failure, and 「不可能发生」("can't possibly happen") is not a state
    // this repo gets to assume.
    diag('reprocess.source_gone', <String, Object?>{'entry_id': sourceEntryId});
    c._raiseUtteranceFailure(
      const AiComposeOutcome(reason: AiComposeFailure.emptyBuffer),
    );
    return;
  }
  // The new row is built from the ORIGINAL words, then the product is written
  // onto it — exactly the two steps a spoken translate/organize utterance takes
  // (`buildFromUtterance` then `applyProcessed`), so the 「原文」("original text")
  // line, the
  // `processMode` chip and `showsSourceLine` all come out identical. Nothing
  // about the old row is copied that would make this a duplicate of it: it gets
  // its own `clientId` (⇒ its own `request_id`, its own `loc_` id) and its own
  // `createdAt` (volume 15 §2.4, fourth line — this delivery is happening NOW).
  final TimelineEntry row = c.store.buildFromUtterance(
    clientId: c._mintClientId(),
    // The mode captured when the user pressed, NOT `c.mode` re-read here: the
    // LLM run is seconds wide and the mode chip can move inside it. Same rule
    // as RV-74 on the delivery frame — the row's own mode is fixed at birth.
    mode: mode,
    // 「对谁说的」("who it was said to") is inherited, not re-decided: a
    // 「仅记录」("record only") row's re-run is still
    // record-only (§4.0 C — it was never meant for the PC), and a cloud row's
    // re-run
    // is still cloud. `_deliverDirect` refuses both on its own, which is what
    // makes this line a statement of intent rather than a second gate.
    delivery: origin.delivery,
    text: source,
    sourceLang: origin.sourceLang,
    // The same utterance took the same time to say; a re-run adds no speech.
    durationMs: origin.durationMs,
    segmentsCount: origin.segmentsCount,
    origin: origin.origin,
  );
  final TimelineEntry? ready = c.store.applyProcessed(row.id, processedText, mode);
  if (ready == null) return;
  diag('reprocess.new_row', <String, Object?>{
    'from_entry_id': sourceEntryId,
    'entry_id': ready.id,
    'request_id': ready.clientId,
    'mode': mode.name,
  });
  unawaited(_deliverDirect(c, ready, source: InjectSource.llm));
}

/// GA-01 terminal success: the LLM product becomes the row's delivered face and
/// only THEN does the row go anywhere.
void _ucDone(ChatController c, String entryId, String processedText) {
  // 🔴 card F3: a REPROCESS of an existing row is a different terminal — see
  // [_deliverRerun]. It used to rewrite the row's face in place and deliver
  // NOTHING; owner confirmation point A (2026-08-04) replaced that with 「产出一条新的投递」
  // ("produce a new delivery"),
  // so the old row is now left completely untouched.
  final FlowMode? reprocessMode = c._reprocessingEntryIds.remove(entryId);
  if (reprocessMode != null) {
    c._liveText = '';
    _deliverRerun(c, entryId, processedText, reprocessMode);
    c.ucNotify();
    return;
  }
  final TimelineEntry? entry = c.store.applyProcessed(
    entryId,
    processedText,
    c._activeMode,
  );
  if (entry == null) return;
  c._liveText = '';
  // manual policy: the FINISHED text is what folds into the buffer. Folding the
  // raw transcript would hand the user back the very text the mode exists to
  // replace.
  if (c._activeSendPolicy == SendPolicy.manual &&
      entry.delivery != Delivery.none &&
      entry.origin != 'cloud') {
    _foldIntoBuffer(c, processedText);
    c._bufferedEntryIds.add(entry.id);
  }
  // 08 §5: a transformed utterance is injected as source:'llm'. The PC's INJ-1
  // AUTO window already accepts it on the same terms as 'stt', so this is honest
  // provenance, not a behaviour change on the desktop.
  if (c._activeSendPolicy == SendPolicy.direct) {
    unawaited(_deliverDirect(c, entry, source: InjectSource.llm));
  }
  c.ucNotify();
}

/// GA-01 terminal failure. Red line: the LLM failed, so NOTHING is injected — least
/// of all the original words, which the user would read as a successful
/// translation and never know otherwise. The row settles at ✗ failed (nothing
/// was delivered, and that IS the delivery truth), the banner names the wall
/// that was hit, and long-press-to-deferred-delivery (长按补投) stays available
/// as the deliberate way out.
void _ucFailed(ChatController c, String entryId, AiComposeOutcome outcome) {
  // GA-13: a failed REPROCESS must leave the row exactly as it was. The old text
  // is still a true record of what was delivered; overwriting its status with a
  // fresh ✗ would rewrite delivery history that did not change. The banner is
  // the whole report.
  if (c._reprocessingEntryIds.remove(entryId) != null) {
    c._liveText = '';
    c._raiseUtteranceFailure(outcome);
    c.ucNotify();
    return;
  }
  c.store.applyInjectResult(
    correlationId: entryId,
    ok: false,
    failureReason: outcome.code ?? outcome.reason.name,
  );
  c._liveText = '';
  c._raiseUtteranceFailure(outcome);
  // 0.2.27: the row used to be pushed up here too («a failed delivery is a truth
  // worth syncing»). It is still that truth — it is just already recorded, by its
  // owner, on this device. Nothing left to do.
  c.ucNotify();
}

/// GA-14 — adopt a second-pass transcript for the MOST RECENT utterance.
///
/// Compare-and-set, and the comparison is the whole point: the refine started
/// before the user could touch anything, but it lands after. If the row was
/// edited, reprocessed, or is no longer the newest one, the better transcript
/// is DROPPED — silently overwriting a person's edit with a machine's opinion
/// is worse than keeping a slightly worse transcript.
///
/// What it never does: re-inject. 06 §5「已注入 PC 的文本永不回改」("text already
/// injected into the PC is never edited back") — the PC
/// already typed those words and they are not being taken back.
///
/// ── 🔴 card D-2 (2026-08-07) — WHY 「the newest row」 WAS NOT AN ANSWER ──────────
///
/// This function used to take `store.entries.first` and check only `edited` /
/// `processedText`. That is a TEMPORAL answer to an IDENTITY question, and it
/// was safe exactly once: when GA-14 was written, every row in that store came
/// from a microphone. It does not any more. `buildFromUtterance` has five
/// callers and FOUR of them are not utterances —
///
///   · a picture sent to the PC        (image_send_controller → buildDeliveryRow)
///   · a light-record (轻记录) picture  (image_send_controller, origin:'cloud')
///   · a typed ➤ note                  (manual_delivery.deliverText, D10)
///   · a favorite-phrase (常用语) tap    (sendFavorite → the same deliverText)
///
/// — and every one of them lands at index 0 with `edited == false` and
/// `processedText == null`, i.e. with BOTH of the old guards wide open. So a
/// refine that arrived one moment late rewrote a picture's descriptor or the
/// words the user had just typed, through `applyRefined` → `_persistOne`: on
/// disk, with no `edited` bit to show a human it happened and no undo.
///
/// THE FIX IS A FACT, NOT A HEURISTIC (R11: 作出判断的那一层手上要有它需要的事实
/// / "the layer making the judgement call must have the facts it needs in hand").
/// The row's own fields cannot tell speech from typing — `entry_type` is
/// 'transcript' for a favorite-phrase (常用语) tap, `duration_ms`/`segments_count` are engine
/// readings that a re-run inherits — so no test on `row` could have been
/// written. The controller HAS the fact and was throwing it away: it built that
/// row itself, in `_handleTerminalFinal`. `_lastUtteranceEntryId` keeps it.
///
/// ⚠️ AND IT IS STILL NOT A CORRELATION. `stt:refined` carries `{text}`; there is
/// no utterance id on it or on `stt:final` to match (`SttRefinedSchema`'s
/// 2026-08-07 correction block measured all three legs). The temporal guess is
/// therefore KEPT VERBATIM — the row must still be `entries.first` — and this
/// card only stops non-speech rows from absorbing it. Dropping the 「still the
/// newest」 leg would silently widen the function into 「find my last utterance
/// wherever it is」, which is a different product decision (a refine landing on a
/// row the user has already scrolled past) and needs the real id, not this one.
///
/// ⚠️ card F2's `entriesForOwners` narrowing is deliberately NOT copied here.
/// That call site had to PICK a row out of a list and owner was the only handle
/// it had; this one names its row, and the named row carries its own
/// `spokenToInstanceId` because this controller built it. Narrowing the list as
/// well would be a second answer to a question that already has one.
void _applyRefined(ChatController c, String text) {
  if (c._reprocessingEntryIds.isNotEmpty) return; // a run is already rewriting a row
  // card D-2: null until this session's first terminal final. A refine with no
  // utterance behind it has nothing to be about — dropping beats guessing.
  final String? spoken = c._lastUtteranceEntryId;
  if (spoken == null) return;
  final TimelineEntry? row = c.store.entries.isEmpty ? null : c.store.entries.first;
  if (row == null) return;
  // Only the utterance this refine belongs to: the newest row must BE the row
  // this device's last utterance built (card D-2), untouched by a human, and not
  // already carrying a processed (translate/organize) product — refining a
  // translation's SOURCE would replace the translated face with raw words in the
  // wrong language.
  if (row.id != spoken) return;
  if (row.edited || row.processedText != null) return;
  final String current = row.outputText;
  if (current.trim() == text.trim()) return;
  // 0.2.27: an adopted refine used to ride up as a machine `history:update` when
  // the row was already server-synced. There is no server row (owner architecture
  // ruling), so the local write is the whole adoption. Unchanged: `edited` stays
  // clear (a second pass is not a person) and nothing is re-injected — 06 §5
  // 「已注入 PC 的文本永不回改」("text already injected into the PC is never
  // edited back").
  if (c.store.applyRefined(row.id, text) == null) return;
  c.ucNotify();
}

// ── the session-loss watch moved out ────────────────────────────────────────
// [_watchSessionLoss] and its family now live in chat_link_watch.dart (same
// library, bodies verbatim): owner 2026-08-19 turned one function into four and
// this file crossed the 800-line cap. Call sites are unchanged — they are
// library-level functions either way.
