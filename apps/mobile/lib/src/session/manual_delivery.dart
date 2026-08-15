// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request | M→S→PC),
//     §3.7 (control:key six-key whitelist)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (hold-then-send = explicit Send with
//     source 'manual'; QuickActions = four control keys, clear also wipes the
//     local buffer)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A/D (each utterance
//     keeps its own row; status = delivery truth only)
//   D10 (owner ruling 2026-07-24): a manual send that settles NO existing row
//     builds one — 「时间线为本体」("the timeline is the substrate") and
//     「每句话都有下落」("every sentence has a place it lands") cannot both hold
//     while a delivered piece of text has no record.
//
// The EXPLICIT delivery half of the chat flow — ➤ / tap-to-send a favorite
// phrase (常用点选即发) / long-press deferred re-delivery (长按补投) / the four
// remote control keys — split out of ChatController (R6 T-4) so that file
// stays under the size cap and so this contract is testable without a
// PttSession. The split is by responsibility, not by line count: everything
// here is a delivery the USER explicitly asked for, as opposed to the STT
// direct-send path (which is a consequence of speaking) that stays with the
// controller.
//
// It owns the delivery correlation state, because one ➤ can settle N rows and
// exactly one place must decide which inject:result belongs to it.
//
// RV-02 (2026-07-30) moved deferred re-delivery (补投) in here as the FOURTH
// path. It was the one delivery that lived outside this class, and
// consequently the one delivery with no watchdog, no emit-failure report and
// an optimistic markSynced — three lies in nine lines. See [reInject].
//
// 0.2.27 (owner's architecture ruling, docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md):
// all four paths now put the WORDS on the wire themselves. Deferred
// re-delivery used to name a row and let the server read its text out of
// `transcript_history`; that table is gone, so the row's owner supplies the
// text. Two mechanisms left with it — `landRow` (the acked `history:create`
// that doubled as the link probe, now [ensureLink]) and `forceCreate`
// (registering a 「仅记录」("record-only") row so the server could find it).

import 'dart:async';

import '../diag/diag_log.dart';
import '../signaling/inbound_payloads.dart' show InjectResult;
import '../signaling/wire_payloads.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';
import 'compose_gate.dart';
import 'delivery_outbox.dart';
import 'delivery_source_text.dart';
import 'outbox_item.dart';
import 'manual_delivery_host.dart';
import 'platform_device_info.dart';

// 800-line cap (verify:lint 8/9): `ManualDeliveryHost` + `LanImageIngress` moved
// VERBATIM to manual_delivery_host.dart when window-B3-2a's correction block
// pushed this file to 816. Re-exported so every existing `import 'manual_delivery.dart'`
// still sees both names — nothing else in the repo had to change. See that
// file's header: it is a move, not an edit.
export 'manual_delivery_host.dart';

part 'manual_delivery_reinject.dart'; // 800-line cap: `reInject` (header there).
part 'manual_delivery_noted.dart'; // P4: noPcTarget noted commit (header there).

/// ONE delivery awaiting the PC's `inject:result`: which send it was, which
/// rows its verdict settles, and the deadline that makes its SILENCE visible.
///
/// RV-02: this used to be two bare fields — a SINGLE slot for the whole app.
/// The banner's resend (重发) re-delivers every row a failed send covered, one
/// [ManualDelivery.reInject] call per row, so the second call overwrote the
/// first: its watchdog was cancelled and its claim forgotten, leaving row 1 at
/// ⏳ with nobody left to time it out. One record per in-flight delivery is what
/// lets N concurrent re-injects each keep their own deadline AND their own
/// answer — every claim is keyed by ids the PC echoes back verbatim, so there is
/// no ambiguity to resolve between them.
class _InFlightSend {
  _InFlightSend(this.requestId, this.covered, this.instanceId);

  /// 🔴 Card B4-18 — WHICH INSTANCE'S SCREEN this delivery's verdict is news for,
  /// read ONCE at arm time off `ManualDeliveryHost.deliveryInstanceId`.
  ///
  /// The watchdog below fires up to 20 s after the send, and by then this record
  /// is the only thing that still knows which screen the send was made on.
  /// Reading the LIVE value inside [_onResultTimeout] would stamp the failure
  /// with 「whichever instance the user happens to be looking at now」 — the
  /// RV-91/RV-97 leak in reverse: a banner about instance A's delivery raised
  /// onto instance B's screen, where nothing the user can see explains it.
  final String? instanceId;

  /// The key this delivery's verdict will come back under — NOT necessarily the
  /// frame's `request_id`. For ➤/picture the two coincide; for a deferred
  /// re-delivery it is the row's own ENTRY id, because
  /// `InjectResult.correlationId` prefers `entry_id` when the PC echoes both
  /// (A-58), and as of the RV-72 prerequisite a deferred re-delivery frame
  /// carries both.
  /// (It used to say 「which is what history:inject makes the PC echo」 — that
  /// event is retired; the PC echoes it because the frame carries it.)
  final String requestId;

  /// The rows this ONE verdict writes back to (§4.0 A: each utterance keeps its
  /// own row; the Send is one delivery action over them).
  final List<String> covered;

  Timer? watchdog;
}

class ManualDelivery {
  ManualDelivery({
    required ManualDeliveryHost host,
    required ComposeGate gate,
    Duration? resultTimeout,
  }) : _host = host,
       _gate = gate,
       _resultTimeout = resultTimeout ?? kInjectResultTimeout;

  final ManualDeliveryHost _host;
  final ComposeGate _gate;
  final Duration _resultTimeout;

  int _seq = 0;

  /// v0.2.8 — the local watchdog this path never had.
  ///
  /// owner 2026-07-29: 「在手机端选择了图片以后，手机端这边是能够正常看得到图片，
  /// 但是 PC 这端是没有接收到这个图片，也没有相应的消息」("after picking a picture
  /// on the phone, the phone side can see the picture just fine, but the PC
  /// side never received this picture, nor any corresponding message"). The
  /// image WAS on the phone, the PC had nothing, and NOTHING anywhere said so —
  /// because `armInFlight` waited for `inject:result` forever. `emitInject`
  /// returns true whenever the socket call did not throw, which for socket.io
  /// means 「the frame was handed over」, not 「it left」; so a frame that never
  /// made it onto the wire produced a row that sits at ⏳ for the rest of the
  /// session.
  ///
  /// Red line F2, verbatim: 任何「成功」回执要能回答「凭什么知道对方收到了」("any
  /// 'success' receipt must be able to answer 'on what grounds do we know the
  /// other side received it'"). This delivery's answer is the PC's own
  /// inject:result — so when it does not come, the honest state is FAILED, not
  /// still-waiting. The AI-compose path has had exactly this watchdog since day
  /// one (「远端 latch 必须有本地看门狗」 — "a latch that closes on a remote
  /// event must have a local watchdog"); this one was simply never given it.
  ///
  /// The timeout does NOT explain why a frame goes missing. It makes the missing
  /// frame VISIBLE, which is the difference between a bug someone can report and
  /// a session where three people take turns guessing.
  ///
  /// RV-02: one record per in-flight delivery (see [_InFlightSend]), not one
  /// slot for the app — the banner's resend (重发) puts N of them on the wire
  /// in a single press.
  final List<_InFlightSend> _inFlight = <_InFlightSend>[];

  /// The last ComposeBand failure, held until the user dismisses it. A delivery
  /// that did not happen must stay visible (no silent failure — 没有静默失败).
  ComposeSendFailure? _failure;

  /// 🔴 Card B4-18 — WHICH INSTANCE'S SCREEN [_failure] IS NEWS FOR.
  ///
  /// `main.dart:180` builds ONE ChatController for the whole app, so this object
  /// outlives any single instance and ANY state parked on it leaks across them.
  /// This is the THIRD instance of that defect, all three the same shape and all
  /// three now taking the same scope:
  ///   ① RV-91 「还有 N 条未投递」("N items still not delivered") →
  ///      `DeliveryOutbox.pendingCountFor`
  ///   ② RV-97 image-failure banner       → `ImageSendController._failureInstanceId`
  ///   ③ Card B4-18 text-send-failure banner → HERE
  /// Two banners on one screen answering 「这是谁的消息」("whose message is
  /// this") differently is the defect; one scope for all of them is the fix,
  /// not three near-misses.
  ///
  /// ⚠️ NOT [ManualDeliveryHost.targetPcId] — that answers 「这一帧投给哪台 PC」
  /// ("which PC this frame is delivered to"), and the same PC has two `pc_id`s
  /// across the two channels. Using it as a screen scope is this repo's #1
  /// shape (one value, two questions).
  String? _failureInstanceId;

  /// The last ComposeBand failure **for the instance whose screen is asking**.
  ///
  /// A parked failure is not discarded when the user switches instances; it is
  /// simply not this screen's news, and coming back to that instance shows it
  /// again. Discarding it would hide a failure nobody has seen — no silent
  /// failure (没有静默失败).
  ///
  /// ⚠️ `null == null` is a REAL match, not a wildcard: two cloud instances have
  /// no `connectedInstanceId` to tell apart, and the honest disposition there is
  /// to keep showing the failure rather than to swallow it. Same equality
  /// judgement as `ImageSendController.failure`, deliberately verbatim.
  ComposeSendFailure? get failure =>
      _failureIsParkedElsewhere ? null : _failure;

  /// True when a parked [_failure] belongs to an instance OTHER than the one on
  /// screen. Such a failure is invisible here, so nothing this screen does may
  /// sweep it away — see [_retireConclusion].
  bool get _failureIsParkedElsewhere =>
      _failure != null && _failureInstanceId != _host.deliveryInstanceId;

  /// RV-15 — the rows [failure] settled as ✗, in the order the failed send
  /// covered them. Empty whenever the current failure settled no rows at all.
  ///
  /// This class already knew the answer and never said it: one ➤ covers N rows
  /// (organize mode routinely produces several per press) and both settling
  /// paths mark EVERY one of them failed. Because nobody exposed the list, the
  /// banner's resend (重发) had to guess 「the newest failed row」 and re-sent 1
  /// of N — the other N-1 were silently dropped from the retry.
  ///
  /// LIFETIME, deliberately narrow — [_raise] is the single writer, so every
  /// new banner replaces the list, including the banners that settle nothing
  /// (a control-key wireFailed must not inherit an earlier send's rows).
  /// [_retireConclusion] empties it when a new send starts or reaches the wire,
  /// [dismissFailure] when the user clears the banner. It is never left to
  /// linger: a stale batch would make resend re-deliver rows that already carry
  /// their own delivery truth — the same class of lie as the guess it replaces.
  ///
  /// Card B4-18: deliberately NOT instance-scoped like [failure] is. 「这次失败
  /// 覆盖了哪些行」("which rows this failure covered") is a fact about the
  /// failure, not about a screen. Grep the name: two readers. The one that
  /// renders anything (`chat_flow_page._sendRetryTargets` → `sendRetryTargets`)
  /// already gates on the scoped [failure] AND narrows to
  /// `store.entriesForInstance`, so a parked batch can never grow a resend
  /// button on someone else's screen; the other
  /// (`image_send_controller.onInjectSettled`) is the RV-30 branch
  /// [_retireFailureContradictedBy] has since subsumed. Scoping it here as well
  /// would be a second answer to a question that already has one.
  List<String> _lastFailedCoveredIds = const <String>[];
  List<String> get lastFailedCoveredIds => _lastFailedCoveredIds;

  void dismissFailure() {
    if (_failure == null) return;
    _failure = null;
    _failureInstanceId = null;
    _lastFailedCoveredIds = const <String>[];
    _host.deliveryNotify();
  }

  /// 🔴 Card B4-18 ③ — RETIRE THE PREVIOUS CONCLUSION, BUT ONLY THIS SCREEN'S.
  ///
  /// Two callers, two reasons, one rule:
  ///   · [deliverText] at the top of a NEW send — same posture as RV-97 ③:
  ///     「上一次怎么样了」("how did the last one go") is about to be replaced,
  ///     and a red 「没发出去」("did not go out") standing next to a send in
  ///     flight makes the screen assert two contradictory things at once.
  ///   · [armInFlight] when a send reaches the wire — the words that failed are
  ///     the words now on their way.
  ///
  /// It refuses to touch a failure parked on ANOTHER instance. That banner is
  /// invisible on this screen, so clearing it would delete a failure the user
  /// never saw — the silent-failure direction of red line F2, reached by a path
  /// nobody would think to test.
  void _retireConclusion() {
    if (_failureIsParkedElsewhere) return;
    _failure = null;
    _failureInstanceId = null;
    // RV-15: the banner this batch belonged to is gone, so the batch goes with
    // it — a retry offered for rows a LATER send already re-covered would be a
    // second delivery of words that are on their way.
    _lastFailedCoveredIds = const <String>[];
  }

  /// Raise a fail-loud delivery failure. Public because the STT direct-send
  /// path (ChatController) surfaces its wire failures through the SAME banner —
  /// two banners for one kind of failure would be two truths to reconcile.
  ///
  /// A failure raised through here settled no rows, so it carries no retry
  /// batch (see [lastFailedCoveredIds]).
  ComposeSendFailure? raise(ComposeSendFailure reason) => _raise(
    reason,
    covered: const <String>[],
    instanceId: _host.deliveryInstanceId,
  );

  /// The ONE place a banner is raised, so 「失败原因是什么」("what was the reason
  /// for the failure"), 「这次失败覆盖了哪些行」("which rows this failure
  /// covered") and 「这是哪块屏幕的消息」("which screen's news is this") are
  /// decided in the same statement and can never drift apart — and so the
  /// notify below always fires with all three answers already in place.
  ///
  /// 🔴 Card B4-18: [instanceId] is REQUIRED and never defaulted. Every caller but
  /// one passes the live `_host.deliveryInstanceId`; the exception is
  /// [_onResultTimeout], which fires up to 20 s later and must stamp the instance
  /// the DELIVERY was made on. A default here would silently give that one caller
  /// the wrong answer, and it is the caller nobody re-reads.
  ComposeSendFailure? _raise(
    ComposeSendFailure reason, {
    required List<String> covered,
    required String? instanceId,
  }) {
    _failure = reason;
    _failureInstanceId = instanceId;
    _lastFailedCoveredIds = covered;
    _host.deliveryNotify();
    return reason;
  }

  /// The single manual-delivery path (➤ and favorite phrases / 常用). Emits
  /// `inject:request{text, source:'manual', mode}` — F-2361 reserves `mode` for
  /// exactly this frame so the server records the delivery row under the mode
  /// the user picked. P4 (0.3.1): a FIXED destination forks to [commitNotedLocal].
  ///
  /// **D10**: when the send settles NO existing rows — the plain typed-text
  /// (手打) case, which the T-3a real-device run found left the timeline with
  /// no trace at all — this builds one. It is an ORDINARY entry: no new schema,
  /// no new entry type, no new status; `source_text` is the typed text,
  /// written once and immutable, and the row rides the existing five-state
  /// (五态) cached→injected/failed write-back exactly like a spoken one. The
  /// only thing that differs is where the words came from.
  Future<ComposeSendFailure?> deliverText(
    String text, {
    required List<String> covered,
    String? originalText,
  }) async {
    if (_host.noPcTarget) return commitNotedLocal(this, text, covered: covered);
    if (!_host.canCompose) return raise(ComposeSendFailure.notConnected);
    if (text.isEmpty) return raise(ComposeSendFailure.emptyBuffer);
    // Card F4 — over the wire's ceiling. FOURTH gate, same mechanism as the three
    // above (a `raise` before anything is enqueued), not a new one.
    //
    // 🔴 WHAT IT REPLACES IS NOT A CRASH, IT IS A SILENCE. Without it the frame
    // travels all the way to `InjectRequestSchema` and dies there, and a zod
    // boundary rejection is ANONYMOUS: no code, no receipt, no row settled —
    // the swallow half of "no silent failure" (没有静默失败). The queue would
    // keep owing the item and every drain would re-offer it to the same
    // boundary.
    //
    // ⚠️ LAST of the wire gates on purpose. The two above answer 「这个会话能
    // 不能发」("can this session send at all") — and P4's fork above THEM
    // answers where the commit lands; this one answers 「这一段字能不能发」
    // ("can this particular chunk of text be sent"), which is only worth
    // saying once a wire send is otherwise possible.
    // ⚠️ Refuses the WHOLE text. Truncating to fit would deliver something the
    // user never wrote and report success for it (15 册 §2.0), and the desktop's
    // own cap says the same thing in its own words ('reject, never silently
    // truncate', inject/pipeline.rs).
    if (exceedsInjectTextCap(text)) return raise(ComposeSendFailure.tooLong);
    // Double-tap race guard: the first delivery owns the outcome (its banner /
    // result will land); a second tap while the ack gate is in flight must not
    // send the same words twice.
    if (_deliverInFlight) return null;
    _deliverInFlight = true;
    // 🔴 Card B4-18 ③ — ONE CONCLUSION ON SCREEN AT A TIME (same posture as
    // RV-97 ③).
    //
    // The user asked again, so the answer to 「上一次怎么样了」("how did the
    // last one go") is about to be replaced. Leaving the old red banner up
    // while this send is in flight is the
    // same defect owner's 0.2.35 screenshot caught on the picture path: a
    // progress indicator and a failure notice asserting opposite things about the
    // same action. The three gates above return BEFORE this line on purpose —
    // they raise their own conclusion and it must not be wiped by its successor.
    _retireConclusion();
    _host.deliveryNotify();
    try {
      final String requestId = mintRequestId('m');
      // D10. `covered` empty ⇒ nothing on the timeline can absorb this delivery's
      // outcome, so the delivery gets its own row. The row is built BEFORE the
      // emit so its id can ride along as entry_id and the truth has somewhere to
      // land the moment it returns.
      final List<String> settle = List<String>.of(covered);
      TimelineEntry? typedEntry;
      if (settle.isEmpty) {
        typedEntry = buildDeliveryRow(clientId: requestId, text: text);
        settle.add(typedEntry.id);
      }
      // RCA-v3 transport-truth gate: an acked round-trip within the last few
      // milliseconds is the ONLY proof this link is alive — after the photo
      // picker (or any backgrounding) the socket can be dead for up to 30 s
      // without the client knowing, and a frame emitted in that window vanishes
      // without receipt.
      //
      // 0.2.27: the D10 typed row used to be the probe — its own acked
      // `history:create` proved both the link AND that the row preceded the
      // inject. Neither half survives the owner ruling (there is no server row to
      // create, and no server row for the inject to be ordered against), so BOTH
      // branches now probe the same way. The link question is unchanged and still
      // asked; only its carrier moved (TimelineSyncGate.probeLink → `heartbeat`).
      // ── 🔴 SNAPSHOT BEFORE ANY `await` (lead's 2026-07-31 snapshot rule) ──
      //
      // Everything this delivery is made of is read HERE, synchronously, and the
      // await below only waits for the disk. Nothing after it re-reads mutable
      // state, so a mode switch or a new utterance arriving inside the enqueue
      // window cannot change what was queued.
      //
      // WHY THIS MATTERS MORE THAN IT LOOKS: it also RETIRES a non-local
      // invariant. The old code's correctness for `_host.mode` leaned on
      // 「`setMode` clears the buffer, so a covered row from another mode cannot
      // exist」 — an argument living in chat_controller.dart. The snapshot makes
      // the guarantee local: whatever happens next, this item is already fixed.
      // (RV-06 taught exactly this, in the buffer's own words.)
      final TimelineEntry? representative =
          typedEntry ?? _host.store.findById(settle.first);
      final FlowMode snapMode = _host.mode;
      final DateTime snapCreatedAt =
          representative?.createdAt ?? DateTime.now().toUtc();
      // 🔴 T-7: 「这一段字是从哪句原文来的」("which original sentence did this
      // chunk of text come from"). Precedence and the reason it cannot be
      // reversed live in delivery_source_text.dart — the short version is that
      // in translate/organize the pre-AI buffer is the PREVIOUS LLM product, so
      // the row's immutable original must win.
      final String? snapSourceText = originalForDelivery(
        representative: representative,
        deliveredText: text,
        aiOriginal: originalText,
      );
      final String? snapDeviceLabel = cachedDeviceLabel();
      final List<String> snapCovered = List<String>.unmodifiable(settle);

      // ⚠️ window-B3-2a — THIS CUT WAS WRITTEN, BACKED OUT ONCE, AND THEN MADE.
      // The doubt is kept because it is a real question and the next reader
      // will ask it again (a rejected concern is still worth recording — 被否掉
      // 的顾虑也是记录).
      //
      // THE DOUBT: this makes a RESOLVABLE DESTINATION a precondition of
      // delivery, so a CONNECTED BUT UNPAIRED session can no longer deliver —
      // which looked like the queue narrowing delivery. 17 tests went red.
      //
      // WHAT RESOLVED IT — it was not a new line, it was the existing one:
      //   · owner 2026-07-31: 「未配对的只有在云端轻记录中，不可能自动发向PC的」
      //     ("an unpaired session only ever lives in cloud light records; it
      //     can never auto-send to a PC"), and an unpairable PC cannot be
      //     entered at all — 「甚至都不应该让他去说」("the user should not even
      //     be allowed to speak there") ⇒ 「说了一句话但没有配对」("said
      //     something but is unpaired") is not a reachable state. Product rule.
      //   · ptt_session.dart:340-342 stamps all three identities from ONE
      //     enriched ack and clears them together 「fails CLOSED」 ⇒ same
      //     lifetime by construction. (Re-verified in source, not on trust.)
      //   · `noPcTarget` (`destination.isFixed`) forks OFF the wire path above
      //     (P4, 0.3.1 — was a hard refusal; now a local noted commit).
      // ⇒ The queue's refusal guards the SAME line that fork draws. The
      //   17 reds were fixtures connecting without pairing; giving them a real
      //   pairing makes them MORE like production — a fix, not a bypass.
      //
      // Persist-before-send (落盘先于发送, design doc §3.1): the emit is ONE
      // ATTEMPT. If the process dies between here and the receipt, this
      // delivery is already on disk and the next launch drains it —
      // 「失败了才入队」("only enqueue after it fails") cannot save that case
      // (RV-60).
      final OutboxItem? queued = await _host.outbox.enqueueText(
        requestId: requestId,
        entryId: settle.first,
        // 🔴 `typedEntry?.id`, VERBATIM from the pre-queue code — null when this
        // send covered rows it did not build. window-B3-2a used `settle.first`
        // and that shipped a regression; see OutboxItem.entryId. Not "just fill
        // one in while we're at it" (顺手补一个).
        wireEntryId: typedEntry?.id,
        coveredEntryIds: snapCovered,
        source: 'manual',
        text: text,
        mode: snapMode.name,
        createdAt: snapCreatedAt,
        sourceText: snapSourceText,
        deviceLabel: snapDeviceLabel,
      );
      // Refused at the door: there is no destination to redeem this at (the
      // session was left). Never a silent drop — no silent failure (没有静默失败).
      if (queued == null) {
        return failSettled(settle, ComposeSendFailure.noPcTarget);
      }
      // The queue owns the probe (§3.3 `heartbeat ok==true`) and the ordering
      // (§3.5 seed → probe → send), so `ensureLink` is not called here — one
      // funnel, one link answer. A drain also carries out anything OLDER that is
      // still waiting, which is the whole point of having a queue.
      // 🔴 L8 (owner 2026-08-02): the user PRESSED ➤ (or a favorite phrase / 常用)
      // — a user's manual action unconditionally counts as expected, regardless
      // of timing (用户手动操作无条件算预期，不看时间) — so these rows are a
      // `live` delivery and the PC types them. Named row by row rather than as
      // a flag on the drain, because this same pass also carries everything
      // OLDER that is still waiting, and that part is an automatic deferred
      // re-delivery (补投) which must NOT be injected.
      // ⚠️ `snapCovered`, not `settle.first`: one ➤ over N buffered utterances is
      // ONE delivery covering N rows, and naming only the representative would
      // leave the other N-1 judged as a deferred re-delivery (补投) inside the
      // very press that sent them.
      final OutboxDrainReport report =
          await _host.outbox.drain(userRequestedEntryIds: snapCovered.toSet());
      if (!report.linkOk) {
        return failSettled(settle, ComposeSendFailure.linkDown);
      }
      if (report.held.containsKey(requestId)) {
        return failSettled(settle, ComposeSendFailure.wireFailed);
      }
      return null;
    } finally {
      _deliverInFlight = false;
      _host.deliveryNotify();
    }
  }

  bool _deliverInFlight = false;

  /// True while a delivery is inside the ack gate (the UI greys ➤ / the image
  /// tile off this instead of double-sending).
  bool get sendPending => _deliverInFlight;

  /// How long the recovery path waits for the ladder to bring the link back.
  static const Duration _recoveryBudget = Duration(seconds: 8);

  /// After the socket's connected edge the rejoin (mobile:reconnect) still
  /// needs one round-trip before the server has a room for this socket; retry
  /// gaps bridge that window.
  static const Duration _rejoinGap = Duration(milliseconds: 700);

  /// The pre-delivery link gate: an acked round-trip proves the pipe, silence
  /// means dead-but-undetected → kick the link, wait for the ladder, re-probe.
  /// Public because the image path uses the SAME gate (one mechanism, not two).
  ///
  /// 0.2.27 — this replaced `landRow`, which proved the link by landing the row
  /// with an acked `history:create`. That create is retired (owner's
  /// architecture ruling: the cloud does not store transcripts — 云端不存转录),
  /// and it was never the point: what the delivery paths needed was
  /// PROOF OF A ROUND TRIP, and the create merely happened to be one. The retry
  /// ladder it carried is kept verbatim here, because the case it was built for
  /// (the rejoin needs one round-trip after the socket's connected edge before the
  /// server has a room for us) is unchanged.
  Future<bool> ensureLink() async {
    if (await _host.syncGate.probeLink()) return true;
    diag('deliver.probe_miss', const <String, Object?>{});
    if (!await _recoverLink()) return false;
    for (int attempt = 0; attempt < 3; attempt++) {
      await Future<void>.delayed(_rejoinGap); // let the rejoin round-trip land
      if (await _host.syncGate.probeLink()) {
        diag('deliver.probe_recovered', <String, Object?>{'attempt': attempt});
        return true;
      }
    }
    diag('deliver.probe_gave_up', const <String, Object?>{});
    return false;
  }

  Future<bool> _recoverLink() async {
    diag('deliver.link_kick', const <String, Object?>{});
    await _host.kickLink();
    final bool up = await _host.awaitLinkUp(_recoveryBudget);
    diag('deliver.link_recovered', <String, Object?>{'up': up});
    return up;
  }

  /// Mint a correlation id for an explicit delivery. `prefix` names the kind
  /// ('m' = ComposeBand/favorite phrase, 'i' = image, 'r' = deferred
  /// re-delivery/re-inject) so a forensic reader can tell one delivery kind
  /// from another without a second field.
  ///
  /// ⚠️ MINTED AT SEND TIME, and that is only correct while there is no queue.
  /// The id is `_seq` (in-memory, resets with the process) plus the instant of
  /// MINTING — so when window-B2's outbox lands, minting here would give one queued
  /// item a fresh id on every drain attempt. Two things break at once: the
  /// server's HTTP request_id ledger (inject-pending.ts — the thing that stops a
  /// picture being pasted twice) and the desktop's INJ-3 replay dedup both stop
  /// recognising a retry as the SAME delivery, so a reconnect flap types the same
  /// sentence twice. ⇒ B2 must mint AT ENQUEUE TIME and persist the id with the
  /// item; a drain then re-emits the id it was born with. Same rule as
  /// `target_pc_id`: a queue item carries its own identity, it is never re-derived
  /// from 「what is true right now」.
  String mintRequestId(String prefix) =>
      '$prefix${_seq++}-${DateTime.now().microsecondsSinceEpoch}';

  /// Build + register the LOCAL row a delivery settles onto (D10).
  ///
  /// It builds the row and does NOT put it on the wire. As of 0.2.27 there is no
  /// wire for a row to go on at all: this phone is the owner of its timeline, and
  /// the only thing that travels is the DELIVERY (`inject:request`), carrying the
  /// text and this row's id as the correlation key.
  TimelineEntry buildDeliveryRow({
    required String clientId,
    required String text,
    String entryType = TimelineEntry.kTranscript,
    String? thumbB64,
  }) {
    return _host.store.buildFromUtterance(
      // The request id doubles as the client id: one idempotency key for the
      // row, the correlation echo and the loc_ id lineage (F-2367).
      clientId: clientId,
      mode: _host.mode,
      // An explicit send IS the delivery act, so the intent is 'inject' — same
      // reason deferred re-delivery (补投) overrides a record-only default: the
      // user explicitly asked.
      delivery: Delivery.inject,
      text: text,
      origin: 'paired',
      entryType: entryType,
      thumbB64: thumbB64,
    );
  }

  /// Deferred re-delivery (补投) — body in manual_delivery_reinject.dart
  /// (800-line cap; the same `part` split chat_controller.dart uses). Not a
  /// behaviour change: the whole method moved verbatim, prose included.
  Future<ComposeSendFailure?> reInject(TimelineEntry entry) =>
      runReInject(this, entry);

  /// The frame never left the device: settle every row this send covered as ✗
  /// failed and raise the banner. Never leaves a row stuck at ⏳ pretending a
  /// delivery is still in flight (no silent failure — 没有静默失败).
  ///
  /// [code] is the NAMED reason written onto the row (rendered next to the ✗ by
  /// ChatMessageTile). It defaults to the emit-refused case every caller had
  /// until RV-02; deferred re-delivery (补投) uses it to say LINK_DOWN, because
  /// 「the link is known down」 and 「the socket refused the frame」 are
  /// different facts and the row is the only place the user reads either of
  /// them.
  ComposeSendFailure? failSettled(
    List<String> settle,
    ComposeSendFailure reason, {
    String code = 'WIRE_EMIT_FAILED',
  }) {
    for (final String id in settle) {
      _host.store.applyInjectResult(
        correlationId: id,
        ok: false,
        failureReason: code,
      );
    }
    // RV-15: hand the banner the rows it just marked ✗ — this list IS the
    // answer to 「重发要重发哪些行」("which rows a resend should resend"), and
    // copying it defends the batch against a caller that keeps mutating its
    // own `settle` list afterwards.
    //
    // Card B4-18: every caller of this method is INSIDE the send it is reporting on
    // (deliverText / runReInject), so the live instance IS the delivery's own —
    // unlike the watchdog, which fires long afterwards.
    return _raise(
      reason,
      covered: List<String>.unmodifiable(settle),
      instanceId: _host.deliveryInstanceId,
    );
  }

  /// Arm the in-flight claim so ONE inject:result settles every row this send
  /// covered (§4.0 A: each utterance keeps its own row; the Send is one
  /// delivery action over them).
  ///
  /// This is the COMPOSER/image entry point: it also retires the banner, because
  /// the words that failed are the words now on their way. Deferred
  /// re-delivery (补投) arms the same claim through [_armResultWatch] without
  /// touching the banner — it re-delivers a ROW, and an unrelated visible
  /// failure must not be swept away by it.
  void armInFlight(String requestId, List<String> settle) {
    // Card B4-18: same retirement as before, now refusing to reach across
    // instances — see [_retireConclusion].
    _retireConclusion();
    _armResultWatch(requestId, settle);
    _host.deliveryNotify();
  }

  /// Register one in-flight delivery and start ITS deadline.
  ///
  /// RV-02: per-delivery, not per-app. A newer delivery of the SAME rows takes
  /// them over (its verdict is the one that counts), and its predecessor is
  /// released WITHOUT being settled — settling it ✗ would mark a row failed
  /// while its re-delivery is still in flight. Claims over OTHER rows are left
  /// strictly alone; that is what makes N-row deferred re-delivery (补投) safe.
  void _armResultWatch(String requestId, List<String> settle) {
    _inFlight.removeWhere((_InFlightSend s) {
      final bool superseded =
          s.requestId == requestId || s.covered.any(settle.contains);
      if (superseded) s.watchdog?.cancel();
      return superseded;
    });
    // RV-15 lifetime, applied exactly: the rows THIS delivery re-covers leave
    // the banner's retry batch (their words are on their way — offering resend
    // (重发) again would deliver them twice), while the rows it does not touch
    // stay retryable. A deferred re-delivery (补投) of one row must not retire
    // the other N-1.
    if (_lastFailedCoveredIds.isNotEmpty) {
      _lastFailedCoveredIds = List<String>.unmodifiable(
        _lastFailedCoveredIds.where((String id) => !settle.contains(id)),
      );
    }
    // Card B4-18: the screen this delivery was made on, frozen with the claim —
    // read now, never re-derived when the deadline expires.
    final _InFlightSend send =
        _InFlightSend(requestId, settle, _host.deliveryInstanceId);
    _inFlight.add(send);
    // The PC's pipeline is slow by design (foreground switch, an 80 ms clipboard
    // settle, up to 700 ms of read-back verification), so the budget is generous
    // — it exists to catch a result that will NEVER arrive, not a slow one.
    send.watchdog = Timer(_resultTimeout, () => _onResultTimeout(send));
  }

  void _onResultTimeout(_InFlightSend send) {
    send.watchdog = null;
    // Already claimed (or superseded, or disposed): its rows carry a settled
    // truth now, and re-settling them would be the stale-timer lie.
    if (!_inFlight.remove(send)) return;
    diag('watchdog.no_result', <String, Object?>{
      'request_id': send.requestId,
      'covered_rows': send.covered.length,
      'budget_ms': _resultTimeout.inMilliseconds,
    });
    // Settle every row this send covered as ✗ with a NAMED reason. Leaving them
    // at ⏳ is the failure mode being fixed; inventing ✓ would be worse still.
    for (final String id in send.covered) {
      _host.store.applyInjectResult(
        correlationId: id,
        ok: false,
        failureReason: 'INJECT_NO_RESULT',
      );
    }
    // RV-15: same as the wire-failure path — the banner gets the whole batch,
    // not the newest row of it. With one record per delivery this batch is the
    // rows THAT delivery covered, never a merge of several.
    _raise(
      ComposeSendFailure.noResult,
      covered: List<String>.unmodifiable(send.covered),
      // 🔴 Card B4-18: the instance THIS DELIVERY was made on, not the one on
      // screen 20 s later. The rows it just settled as ✗ live on that instance's
      // timeline (`entriesForInstance`), so a banner about them belongs on that
      // instance's screen and nowhere else.
      instanceId: send.instanceId,
    );
  }

  /// Release every watchdog timer. Called from ChatController.dispose — a
  /// disposed controller that kept a live timer would later write an
  /// INJECT_NO_RESULT into a store nobody is reading any more.
  void dispose() {
    for (final _InFlightSend s in _inFlight) {
      s.watchdog?.cancel();
      s.watchdog = null;
    }
    _inFlight.clear();
  }

  /// Claim an inbound inject:result for the delivery it belongs to, returning
  /// the rows it settles (and disarming THAT delivery), or null when the result
  /// belongs to something else. Whichever correlation key the PC echoes back —
  /// entry_id (exact) or request_id — resolves: the id list catches the
  /// request_id echo, and the row's own id / clientId catch the entry_id echo.
  ///
  /// RV-02: the echo also decides WHICH in-flight delivery is being answered, so
  /// three concurrent deferred-re-delivery (补投) verdicts land on three rows
  /// without any of them disarming the others. Correlation was always exact —
  /// the single slot was
  /// the only thing making it ambiguous.
  List<String>? claimResult(String? correlation) {
    if (correlation == null || correlation.isEmpty) return null;
    final int i = _inFlight.indexWhere(
      (_InFlightSend s) =>
          s.requestId == correlation || s.covered.contains(correlation),
    );
    if (i < 0) return null;
    final _InFlightSend send = _inFlight.removeAt(i);
    // The result arrived — disarm, or the watchdog would later re-settle rows
    // the PC has already answered for.
    send.watchdog?.cancel();
    send.watchdog = null;
    return send.covered;
  }

  /// Route ONE inbound inject:result to the row(s) it settles — the five-state
  /// delivery-truth write-back. Lives here rather than in ChatController because
  /// the branch turns entirely on the in-flight claim this class owns.
  ///
  /// A manual send covers N rows with ONE request id; the single truth fans back
  /// onto each of them through the normal write-back (no new status, no schema
  /// change). A typed-only send covers zero rows and simply resolves. Either echo
  /// shape resolves: request_id (what the PC gets for a multi-row manual send) or
  /// the D10 row's own entry_id (stamped only when the send covers exactly one
  /// row, so settling the whole list is settling that row).
  void applyInjectResult(InjectResult r, TimelineStore store) {
    final String? correlation = r.correlationId;
    diag('recv.inject_result', <String, Object?>{
      'ok': r.ok,
      'correlation': correlation,
      'error': r.error,
    });
    final List<String>? covered = claimResult(correlation);
    final List<String?> settled = covered ?? <String?>[correlation];
    for (final String? id in settled) {
      store.applyInjectResult(
        correlationId: id,
        ok: r.ok,
        target: r.target,
        pcName: _host.pcDisplayName,
        failureReason: r.error,
        // N2 / RV-42: the verdict's OWN word for what happened. `ok:false` with
        // mode 'cached' means 「没投递，可补投」("not delivered, can be
        // deferred-re-delivered"), not 「注入失败」("injection failed") — the
        // field was parsed off the wire all along and dropped at this door,
        // which is why the phone and the PC capsule described the same event
        // differently.
        wireMode: r.mode,
      );
    }
    if (r.ok) _retireFailureContradictedBy(settled);
  }

  /// 🔴 Card B4-18 ③ — WORDS THAT LANDED MUST NOT LEAVE 「没发出去」("did not go
  /// out") STANDING.
  ///
  /// Red line F2's SECOND direction (must not describe something that
  /// succeeded as if it had not — 不许把做成的事说成没做成), for text, at the
  /// one place the PC's own verdict arrives. A failed send does NOT drop its
  /// delivery: `wireFailed` / `linkDown` / `noResult` all leave the queue item
  /// still owed, the next drain carries it, the PC types it, the row goes ✓ —
  /// and the red banner underneath keeps saying the opposite until someone
  /// taps ✕.
  ///
  /// Only `ok` retires it: a failed verdict is not a contradiction. And only a
  /// verdict for a row THIS banner is about ([lastFailedCoveredIds]) — a blanket
  /// clear on any success would swallow an unrelated failure.
  ///
  /// ⚠️ It is deliberately NOT scoped to the instance on screen. 「这次投递成功
  /// 了」("this delivery succeeded") is true wherever the user is standing, so
  /// a parked banner about it is false wherever it is parked.
  ///
  /// 📌 THIS SUBSUMES the narrower RV-30 block in `image_send_controller.dart`
  /// (`onInjectSettled`, the `delivery.failure == noResult` branch): that one
  /// handles the same contradiction for one reason only, and only on the socket
  /// route — `image_send_http.dart` calls [applyInjectResult] without ever
  /// reaching it. Reported for removal rather than deleted here: that file
  /// belongs to RV-97, which landed in the same window. It is now unreachable,
  /// not wrong — this runs first (`chat_outbox_host.onInjectResultRouted`).
  void _retireFailureContradictedBy(List<String?> deliveredIds) {
    if (_failure == null || _lastFailedCoveredIds.isEmpty) return;
    final bool contradicted = deliveredIds.any(
      (String? id) => id != null && _lastFailedCoveredIds.contains(id),
    );
    if (!contradicted) return;
    diag('deliver.banner_retired_by_delivery', <String, Object?>{
      'reason': _failure!.name,
      'covered_rows': _lastFailedCoveredIds.length,
    });
    dismissFailure();
  }

  /// One of the four QuickAction keys (⏎ ⌫ ↶ ✕). These act on the PC's FOCUSED
  /// window — they are not local editing. Returns whether the frame left the
  /// device, and that is the WHOLE of what a press does now: owner 2026-08-13
  /// supplement #3 struck the `clear`-also-wipes-the-local-buffer half that the
  /// caller used to own (08 §5 correction block; contract §4).
  bool sendControlKey(ControlKeyKind kind) {
    if (!_host.canCompose) {
      raise(ComposeSendFailure.notConnected);
      return false;
    }
    // REQ-12-13 — WHICH PHONE pressed it (04 册 F-3115). The SAME snapshot every
    // delivery frame already stamps (`cachedDeviceLabel()`), not a second source:
    // one answer to 「我是哪台手机」("which phone am I"), or the PC's rows would
    // disagree about it depending on which frame they were built from.
    if (!_gate.emitControlKey(kind, deviceLabel: cachedDeviceLabel())) {
      raise(ComposeSendFailure.wireFailed);
      return false;
    }
    return true;
  }
}
