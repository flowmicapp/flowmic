// 800-line cap: the in-flight delivery claim registry + inject:result routing
// family moved VERBATIM out of manual_delivery.dart, the same `part` split
// manual_delivery_reinject.dart and manual_delivery_noted.dart already use for
// exactly this reason (that file's own header: "a part file cannot reopen the
// class — so this is a top-level function taking the receiver explicitly").
// `_InFlightSend` moved with its family rather than staying behind: its
// watchdog is Timer state only this file's `_armResultWatch` / `_onResultTimeout`
// write and read, so leaving the class in the old file would have split one
// topic across two files for no reason.
//
// Repayment, in the shape verify/lint/file-size.mjs's own TRANSLATION_BLOAT_BASELINE
// comment asks for: card B2-M's fix to `deliverText`'s held->failSettled shape
// needed a few more lines than the file's pinned 842 allowed, so this split
// pays the debt down instead of growing it — same move `image_send_controller.dart`
// / `ptt_session.dart` / `timeline_store.dart` / `orchestrator-core.ts` already
// made in that file's history. The file drops back under the real 800 cap, so
// its baseline entry is deleted (verify/lint/file-size.mjs, same commit).
//
// `armInFlight` / `dispose` / `applyInjectResult` keep their names and their
// PUBLIC instance-method shape in manual_delivery.dart (widely called as
// `c.delivery.armInFlight(...)` etc. — grep confirms external call sites in
// chat_outbox_host.dart, chat_transient_banner_timers.dart, image_send_http.dart
// and the test suite); each is now a one-line delegate to the top-level
// function here. `claimResult` had no external caller (grep: only this
// family's own `applyInjectResult` used it), so it moved with no stub left
// behind.

part of 'manual_delivery.dart';

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

/// Arm the in-flight claim so ONE inject:result settles every row this send
/// covered (§4.0 A: each utterance keeps its own row; the Send is one
/// delivery action over them).
///
/// This is the COMPOSER/image entry point: it also retires the banner, because
/// the words that failed are the words now on their way. Deferred
/// re-delivery (补投) arms the same claim through [_armResultWatch] without
/// touching the banner — it re-delivers a ROW, and an unrelated visible
/// failure must not be swept away by it.
void runArmInFlight(ManualDelivery d, String requestId, List<String> settle) {
  // Card B4-18: same retirement as before, now refusing to reach across
  // instances — see [ManualDelivery._retireConclusion].
  d._retireConclusion();
  _armResultWatch(d, requestId, settle);
  d._host.deliveryNotify();
}

/// Register one in-flight delivery and start ITS deadline.
///
/// RV-02: per-delivery, not per-app. A newer delivery of the SAME rows takes
/// them over (its verdict is the one that counts), and its predecessor is
/// released WITHOUT being settled — settling it ✗ would mark a row failed
/// while its re-delivery is still in flight. Claims over OTHER rows are left
/// strictly alone; that is what makes N-row deferred re-delivery (补投) safe.
void _armResultWatch(ManualDelivery d, String requestId, List<String> settle) {
  d._inFlight.removeWhere((_InFlightSend s) {
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
  if (d._lastFailedCoveredIds.isNotEmpty) {
    d._lastFailedCoveredIds = List<String>.unmodifiable(
      d._lastFailedCoveredIds.where((String id) => !settle.contains(id)),
    );
  }
  // Card B4-18: the screen this delivery was made on, frozen with the claim —
  // read now, never re-derived when the deadline expires.
  final _InFlightSend send =
      _InFlightSend(requestId, settle, d._host.deliveryInstanceId);
  d._inFlight.add(send);
  // The PC's pipeline is slow by design (foreground switch, an 80 ms clipboard
  // settle, up to 700 ms of read-back verification), so the budget is generous
  // — it exists to catch a result that will NEVER arrive, not a slow one.
  send.watchdog = Timer(d._resultTimeout, () => _onResultTimeout(d, send));
}

void _onResultTimeout(ManualDelivery d, _InFlightSend send) {
  send.watchdog = null;
  // Already claimed (or superseded, or disposed): its rows carry a settled
  // truth now, and re-settling them would be the stale-timer lie.
  if (!d._inFlight.remove(send)) return;
  diag('watchdog.no_result', <String, Object?>{
    'request_id': send.requestId,
    'covered_rows': send.covered.length,
    'budget_ms': d._resultTimeout.inMilliseconds,
  });
  // Settle every row this send covered as ✗ with a NAMED reason. Leaving them
  // at ⏳ is the failure mode being fixed; inventing ✓ would be worse still.
  for (final String id in send.covered) {
    d._host.store.applyInjectResult(
      correlationId: id,
      ok: false,
      failureReason: 'INJECT_NO_RESULT',
    );
  }
  // RV-15: same as the wire-failure path — the banner gets the whole batch,
  // not the newest row of it. With one record per delivery this batch is the
  // rows THAT delivery covered, never a merge of several.
  d._raise(
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
void disposeInFlightClaims(ManualDelivery d) {
  for (final _InFlightSend s in d._inFlight) {
    s.watchdog?.cancel();
    s.watchdog = null;
  }
  d._inFlight.clear();
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
List<String>? claimInFlightResult(ManualDelivery d, String? correlation) {
  if (correlation == null || correlation.isEmpty) return null;
  final int i = d._inFlight.indexWhere(
    (_InFlightSend s) =>
        s.requestId == correlation || s.covered.contains(correlation),
  );
  if (i < 0) return null;
  final _InFlightSend send = d._inFlight.removeAt(i);
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
void runApplyInjectResult(
  ManualDelivery d,
  InjectResult r,
  TimelineStore store,
) {
  final String? correlation = r.correlationId;
  diag('recv.inject_result', <String, Object?>{
    'ok': r.ok,
    'correlation': correlation,
    'error': r.error,
  });
  final List<String>? covered = claimInFlightResult(d, correlation);
  final List<String?> settled = covered ?? <String?>[correlation];
  for (final String? id in settled) {
    store.applyInjectResult(
      correlationId: id,
      ok: r.ok,
      target: r.target,
      pcName: d._host.pcDisplayName,
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
  if (r.ok) _retireFailureContradictedBy(d, settled);
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
/// verdict for a row THIS banner is about ([ManualDelivery.lastFailedCoveredIds])
/// — a blanket clear on any success would swallow an unrelated failure.
///
/// ⚠️ It is deliberately NOT scoped to the instance on screen. 「这次投递成功
/// 了」("this delivery succeeded") is true wherever the user is standing, so
/// a parked banner about it is false wherever it is parked.
///
/// 📌 THIS SUBSUMES the narrower RV-30 block in `image_send_controller.dart`
/// (`onInjectSettled`, the `delivery.failure == noResult` branch): that one
/// handles the same contradiction for one reason only, and only on the socket
/// route — `image_send_http.dart` calls [runApplyInjectResult] without ever
/// reaching it. Reported for removal rather than deleted here: that file
/// belongs to RV-97, which landed in the same window. It is now unreachable,
/// not wrong — this runs first (`chat_outbox_host.onInjectResultRouted`).
void _retireFailureContradictedBy(ManualDelivery d, List<String?> deliveredIds) {
  if (d._failure == null || d._lastFailedCoveredIds.isEmpty) return;
  final bool contradicted = deliveredIds.any(
    (String? id) => id != null && d._lastFailedCoveredIds.contains(id),
  );
  if (!contradicted) return;
  diag('deliver.banner_retired_by_delivery', <String, Object?>{
    'reason': d._failure!.name,
    'covered_rows': d._lastFailedCoveredIds.length,
  });
  d.dismissFailure();
}
