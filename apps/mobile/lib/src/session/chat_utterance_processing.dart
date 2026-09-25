// D-14 structural split: compose/reprocess completion and refinement family.
// Everything after the part directive moved VERBATIM from chat_utterance.dart.
// No signature, comment, caller, or control flow changed.
// ⚠️ That sentence describes the split commit only. Card NR-89 (2026-09-23)
// later changed `_reprocessEntry` (new `mode` parameter, no `c.mode` read);
// its own doc comment carries the correction.
part of 'chat_controller.dart';

/// GA-13 / 🔴 card F3 / 🔴 card NR-89 — re-run the transform the user PICKED
/// (re-translate → [FlowMode.translate], re-organize → [FlowMode.organize]) over
/// an EXISTING row's original words, and deliver the product as a NEW delivery.
///
/// ⚠️ Correction (NR-89, 2026-09-23): this used to read 「re-run the CURRENT
/// mode's transform」 — the operation came from the session's mode (`c.mode`),
/// so a realtime session refused outright and a translate session could never
/// re-organize. The operation is now the caller's explicit [mode]
/// (`chat_flow_entry_actions.dart` maps `EntryAction.retranslate` /
/// `EntryAction.reorganize` onto it); volume 15 §2.3 carries the same correction.
///
/// The source is `source_text`, which is immutable, so a reprocess is always a
/// fresh run over the original words rather than a translation of a translation
/// — the long-pressed row may itself already be a translation or an organized
/// product, and that product is never what is sent.
/// Returns a fail-loud reason when the run could not even start; null once the
/// frame is away (the terminal arrives through the same uc* callbacks).
AiComposeFailure? _reprocessEntry(
  ChatController c,
  TimelineEntry entry,
  FlowMode mode,
) {
  // ⚠️ Correction (NR-89, 2026-09-23): this read the CURRENT session mode —
  // `final FlowMode mode = c.mode;` — under the comment 「The CURRENT mode, not
  // `_activeMode` … what the menu item promised («用当前模式重跑» / "re-run with
  // the current mode")」. The menu no longer promises that: it offers two
  // explicit operations, and the one pressed arrives here as [mode]. Nothing
  // below reads `c.mode`; switching the chip mid-run changes nothing about
  // this run (see the snapshot into `_reprocessingEntryIds`).
  final ComposeTask? task = _composeTaskFor(mode);
  // realtime has no LLM stage, and a row with no original words has nothing to
  // re-run. Both are 「按钮不该出现在这里」("the button shouldn't appear here")
  // races rather than server failures —
  // the menu only offers the action when neither holds (see the guard it shares).
  // CALLER CONTRACT (NR-89): the long-press menu only ever passes translate or
  // organize, so `mode == realtime` here is a caller bug, and it gets the same
  // fail-loud refusal rather than a quiet no-op.
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
  // NR-89: what is stored is the operation the user chose AT THE PRESS; the
  // terminal (`_ucDone` → `_deliverRerun`) births the new row with it and never
  // re-reads the session mode.
  c._reprocessingEntryIds[entry.id] = mode;
  final AiComposeFailure? failed = c.utteranceCompose.start(
    entryId: entry.id,
    // A FRESH correlation id: this run is not the original utterance, and
    // reusing that id would make the two indistinguishable in the echo.
    requestId: '${entry.clientId}-rp${DateTime.now().microsecondsSinceEpoch}',
    task: task,
    sourceText: source,
    sourceLang: entry.sourceLang,
    // The phone's persisted translate target — a setting of its own, independent
    // of which mode the session is in (a realtime session still has one).
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
      neverSent: _neverSentOf(c, null),
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
      neverSent: origin.neverSent,
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
    mcpContentReady: false,
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

/// Card RC-I — whether the utterance [entryId] names is never sent (the row's
/// own answer, `EntryNeverSent.neverSent`). A row that is already gone falls
/// back to the screen's destination switch, the only fact left.
bool _neverSentOf(ChatController c, String? entryId) {
  final TimelineEntry? row = entryId == null ? null : c.store.findById(entryId);
  return row?.neverSent ?? c.destination.isRecordOnly;
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
    c._raiseUtteranceFailure(outcome, neverSent: _neverSentOf(c, entryId));
    c.ucNotify();
    return;
  }
  c.store.applyInjectResult(
    correlationId: entryId,
    ok: false,
    failureReason: outcome.code ?? outcome.reason.name,
  );
  c._liveText = '';
  c._raiseUtteranceFailure(outcome, neverSent: _neverSentOf(c, entryId));
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
///
/// 🔴 D7 ③ (2026-09-03, owner ruling Q2 b) — THE CORRELATION EXISTS NOW; the
/// paragraph above is the record of why it had to. `stt:final` and `stt:refined`
/// carry the server-minted `utterance_id`, the settlement writes it onto the row
/// (`TimelineEntry.utteranceId`) and this function selects by it. The temporal
/// guess (`entries.first`) is GONE, not kept as a fallback: a refine whose utterance
/// is no longer on top lands on its own row; one that names none is dropped at the wire.
///
/// Four guards, each answering one question:
///   · `entryType == transcript` — a picture / control key / article head is
///     not an utterance even if an id somehow reached it;
///   · owner match — `spokenToInstanceId` ∈ this session's owner set: a refine
///     arrives on the live socket for one PC, and a row born to another is not
///     its business whatever id it carries;
///   · `edited` / `processedText` — unchanged from card D-2: a machine opinion
///     never overwrites a person, and refining a translation's SOURCE would put
///     raw words in the wrong language on the translated face;
///   · EXACTLY ONE row carries the id. A long realtime utterance settles as
///     several segment rows sharing one id, while the refine is a transcript of
///     the WHOLE utterance with no segment boundary to split on — dropped with a
///     diag line; an honest open item (the server would have to refine per segment).
void _applyRefined(ChatController c, SttRefined r) {
  if (c._reprocessingEntryIds.isNotEmpty) return; // a run is already rewriting a row
  // The SAME owner set the chat screen scopes its rows by (chat_flow_pager_sync
  // → `session.scope.ownerIds`), so 「the rows this screen shows」 and 「the rows
  // a refine may touch」 cannot disagree.
  final Set<String> owners = c.session.scope.ownerIds;
  final List<TimelineEntry> candidates = c.store.entries
      .where((TimelineEntry e) =>
          e.utteranceId == r.utteranceId &&
          e.entryType == TimelineEntry.kTranscript &&
          e.spokenToInstanceId != null &&
          owners.contains(e.spokenToInstanceId))
      .toList(growable: false);
  if (candidates.isEmpty) {
    diag('stt.refined.dropped', <String, Object?>{'reason': 'no_row'});
    return;
  }
  if (candidates.length > 1) {
    diag('stt.refined.dropped', <String, Object?>{
      'reason': 'multi_segment',
      'rows': candidates.length,
    });
    return;
  }
  final TimelineEntry row = candidates.single;
  if (row.edited || row.processedText != null) return;
  final String text = r.text;
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
