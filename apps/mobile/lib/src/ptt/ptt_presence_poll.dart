// Part of ptt_session.dart — G-15①: the periodic "is the PC still there"
// poll while idle.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.4① (gap) /
//     §1.4.1 (RV-98: the `GET /api/pc/presence` surface) / §6 G-15
//   docs/decisions/2026-08-01-idle-pc-presence-poll-interval.md
//     (owner ruling: every 10 seconds; five implementation constraints)
//   session/pc_presence.dart ([PcPresenceTracker], the ONE writer +
//     [kIdlePcPresencePollInterval])
//   session/pc_presence_probe.dart (the transport surface: [httpPcPresenceRead]
//     / [pcPresenceUri])
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_inbound.dart: ptt_session.dart hit the 800-line source-file
// ceiling (`verify/lint/file-size.mjs` SRC_MAX=800). The difference is that file
// was a **pure move** (RV-92's existing code relocated verbatim), while this one
// is a **newly written section** — G-15① had never been wired up before this
// window (the `GET /api/pc/presence` surface RV-98 already built existed, but
// only the instance-list domain `connections_controller.dart` used it; the
// session domain had never periodically asked this question before).
//
// Same as ptt_inbound.dart, this is a `part` file in the same library as
// ptt_session.dart, so the private members referenced below (`fsm`/`reconnect`/
// `_pcId`/`_channel`/`presenceReader`/`presencePollTimeout`/`_pcPresence`/
// `_presencePollInFlight`) are all this class's own fields — not a new,
// disconnected pile of state.
//
// ── WHERE EACH OF THE FIVE IMPLEMENTATION CONSTRAINTS LANDS ─────────────────
// ① Only ask while "idle AND connected" — the two predicates
//    `fsm.connection == connected` + `fsm.session == idle`; if either fails,
//    return immediately, no request sent.
// ② Unable to ask ⇒ [PcPresence.unknown], NEVER carry over the previous
//    answer — every tick that actually asked calls
//    [PcPresenceTracker.notePresencePoll] unconditionally (even when the
//    answer is unknown); the only "don't write" paths are the ①③④ cases that
//    should never have asked in the first place, which is not "carrying over
//    the previous answer" but "never asked this time at all" — the same logic
//    as the instance-list domain's `_probePresenceOne`, which does
//    `_presence.remove(key)` BEFORE deciding whether it can even ask (that
//    side clears early; this side never sends at all).
// ③ The `InstanceTarget.cloudNotes` row is never polled — predicate
//    `_channel == 'saas'`, see `pc_presence.dart`'s
//    `instanceTargetOfChannel` and the `_channel` field's own docs.
// ④ Single writer — this section calls `_pcPresence.notePresencePoll(...)`
//    exactly once; the whole decision table lives beside `PcPresenceTracker`
//    (pc_presence.dart), and nothing here redefines any of it.
// ⑤ The interval is named — `kIdlePcPresencePollInterval` (pc_presence.dart);
//    this file only references it, never writes a second literal `10`.
//
// ── RELATIONSHIP TO THE INSTANCE-LIST DOMAIN'S
//    `ConnectionsController._probePresenceOne` ───────────────────────────────
// Structurally the two sites ask the same question ("is this paired PC there")
// twice: once from the static instance-list page (no socket,
// `connections_controller.dart`), once from here (a live session). Doc 15 §1.4
// explicitly says this is **deliberate**: the two domains hold evidence of
// different strength (the session domain also has wire evidence like
// `focus:state`/`inject:result`; the instance-list domain has none), and
// merging them would let strong evidence be overridden by weak evidence — so
// this section does not reuse the instance-list domain's code, but reuses
// their shared **infrastructure** (the `PcPresence` vocabulary,
// `httpPcPresenceRead`, `pcPresenceUri`, the shape of the cross-wiring
// (identity mismatch) check). This is the kind of reuse R4 permits: different
// question, same answer-producing mechanism.

part of 'ptt_session.dart';

extension PttSessionPresencePoll on PttSession {
  /// 🔴 The timer's lifecycle is bound to "actually paired", **NOT** "the
  /// socket is connected", and **NOT** "this `PttSession` object was
  /// constructed". There are only two production call sites, both inside the
  /// same ack handler that writes [_pcId]/[_channel] (the `pair()` success
  /// path / `_emitMobileReconnect`'s `onAccepted`, the latter also covering
  /// `resumePairing()` and the reconnect ladder's self-healing edge) —
  /// [_stopPresencePoll] is the opposite: it hangs off `_statusSub` (the
  /// constructor) and closes on any non-CONNECTED edge. The `??=` guards
  /// against the same CONNECTED event being handled twice by the ack handler
  /// (theoretically shouldn't happen, but it's cheap insurance) stacking up a
  /// second `Timer`.
  ///
  /// ⚠️ **This version replaces "arm on the connected edge"**, and the reason
  /// is not constraint ① (that predicate is already inside the tick:
  /// `fsm.connection`/`fsm.session`) — it is **two deeper problems**:
  /// ① In product terms, a connection that has never paired has no PC to ask
  /// about at all; "connected" only answers "is this socket up", not "is
  /// there anything to ask" — arming the timer before pairing completes means
  /// polling an address that does not exist yet (`reconnect.url`/`.token` are
  /// still values `pair()`/`resumePairing()` have not written at that point);
  /// ② the whole repo has a large number of widget tests that merely
  /// construct a `PttSession` and `pushStatus(connected)` to render the UI
  /// (never actually calling `pair()`) — this was previously never a concern,
  /// because the constructor never created any timer. Arming it on
  /// "connected" would make **these tests** also start a real
  /// `Timer.periodic`, and they never call `dispose()` (there was previously
  /// no reason to: nothing needed collecting) — `flutter_test`'s
  /// pending-timer check fails right at test-tree teardown — 19 unrelated
  /// files, 22 test cases; patching them one by one with escape hatches would
  /// be papering over a mount point that was simply the wrong choice to begin
  /// with. Arming on "actually paired" means these tests' `Timer` is never
  /// created at all, and incidentally is also the literal implementation of
  /// owner's "conserve connections" ruling: a connection with no PC to ask
  /// about should not have a ticking timer running.
  void _startPresencePoll() {
    _presencePollTimer ??= Timer.periodic(kIdlePcPresencePollInterval, _pollPcPresenceTick);
  }

  void _stopPresencePoll() {
    _presencePollTimer?.cancel();
    _presencePollTimer = null;
  }

  /// Test-only escape hatch — same role as `debugCancelBannerAutoHideTimers`
  /// (`chat_transient_banner_timers.dart`) and `ManualDelivery.dispose` (used
  /// via each test file's own `releaseWatchdogs()`): a WIDGET test that runs a
  /// REAL `pair()`/`resumePairing()` correctly arms this Timer, and
  /// `AutomatedTestWidgetsFlutterBinding` checks for pending timers the
  /// instant the tree is torn down — BEFORE `addTearDown`'s (necessarily
  /// async) `PttSession.dispose()` runs. Simulating a disconnect instead
  /// (`transport.pushStatus(SocketStatus.disconnected)`) was tried and
  /// rejected: it also reaches `ChatController`'s OWN session-loss watchdog
  /// (`chat_utterance.dart` `_watchSessionLoss`, armed off the same FSM
  /// transition), trading this leak for a different, equally real one this
  /// file has no business reaching into. This stops ONLY the presence-poll
  /// Timer — no FSM edge, no socket status change, nothing for any other
  /// collaborator to react to. No production caller by design, same as its
  /// three siblings above.
  @visibleForTesting
  void debugStopIdlePresencePoll() => _stopPresencePoll();

  /// [Timer.periodic]'s callback signature requires a `Timer` parameter;
  /// placing it here rather than an inline lambda is purely a line-width/
  /// readability consideration (the constructor line is already right at the
  /// 800-line edge).
  void _pollPcPresenceTick(Timer _) => unawaited(_pollPcPresenceIfIdle());

  /// The periodic poll from owner's 2026-08-01 ruling: while the session is
  /// idle and connected, ask once "is that PC still there"
  /// (`GET /api/pc/presence`), through [PcPresenceTracker]'s sole writer. See
  /// the file header "where each of the five implementation constraints
  /// lands" — every return below is numbered.
  Future<void> _pollPcPresenceIfIdle() async {
    if (fsm.connection != ConnectionState.connected) return; // ①
    if (fsm.session != SessionState.idle) return; // ①
    if (_channel == 'saas') return; // ③ owner's exception: never poll cloudNotes
    final String? endpoint = reconnect.url;
    final String? token = reconnect.token;
    if (endpoint == null || endpoint.isEmpty) return; // no address to ask
    if (token == null || token.isEmpty) return; // no credential to present
    // G-15① concurrency gate: see `_presencePollInFlight`'s own doc (a slow/
    // stuck probe must not have a second one stacked on top before it returns).
    if (_presencePollInFlight) return;
    _presencePollInFlight = true;
    PcPresenceReading reading;
    try {
      final Uri url = pcPresenceUri(endpoint);
      // D2LAN-B3 — this poll carries the pairing token, so on a PINNED pairing it
      // must verify who it is talking to. `presenceReader` is null in production
      // (see its field doc) precisely so the pin can ride a named argument the
      // [PcPresenceReader] seam does not carry; an injected double is called
      // exactly as before, which is why the seam did not change and no existing
      // fake had to be touched.
      final PcPresenceReader? injected = presenceReader;
      reading = injected != null
          ? await injected(url, token, presencePollTimeout)
          : await httpPcPresenceRead(
              url,
              token,
              presencePollTimeout,
              pin: lanPin,
            );
    } on Object {
      // 🔴 The RV-89 shape: catch Object, not Exception. `httpPcPresenceRead`
      // itself already resolves every failure path (404/401/network flap/a
      // field that isn't bool/the `ArgumentError` thrown when `ws://` is
      // handed to `HttpClient.getUrl` — an Error, not an Exception) to
      // unknown; this `on Object` is double insurance: in case [presenceReader]
      // is ever swapped for a test/future implementation that genuinely
      // throws, an escaped throw must never become an uncaught exception
      // instead of "this ask failed".
      reading = PcPresenceReading.unknown;
    } finally {
      _presencePollInFlight = false;
    }
    // 🔴 NEVER cross-wire identities (the same check as
    // `connections_controller._probePresenceOne`, which checks "the PC this
    // row stores", while this checks "the PC this session is paired to" —
    // same shape of predicate, different field source, the kind of reuse R4
    // permits): if the server-echoed `pc_id` doesn't match the PC this
    // connection is actually paired to ([PttSession.pcId]), it does not count
    // as an answer to this poll. `expected == null` (a pre-0.2.4 old pairing)
    // or `answered == null` (an old server / no answer) means there's
    // nothing to check against ⇒ don't block, accept the measurement as-is.
    final String? expected = pcId;
    final String? answered = reading.pcId;
    final bool mismatched =
        expected != null && answered != null && expected != answered;
    // ② Write unconditionally — even when it's unknown, that is not "skip".
    _pcPresence.notePresencePoll(mismatched ? PcPresence.unknown : reading.presence);
  }
}
