// Part of ptt_session.dart — session teardown.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_wire_keepalive.dart / ptt_capture_pump.dart: ptt_session
// .dart sat at 799 of the 800-line cap (`verify/lint/file-size.mjs` SRC_MAX),
// and IT-10 must add `scope.dispose()` plus an ordering comment that cannot
// fit without deleting evidence elsewhere. Behaviour moves; fields stay.
//
// 🔴 DIFF DISCIPLINE: the body below is the previous `dispose()` moved
// character-for-character, plus the IT-10 `scope.dispose()` block (marked)
// and the SEG-2 `_linkLossSub` cancellation (marked).
// **Any other difference in the diff is a bug.**

part of 'ptt_session.dart';

extension PttSessionDispose on PttSession {
  Future<void> _disposeRouted() async {
    _stopHeartbeat();
    await _statusSub?.cancel();
    await _incomingSub?.cancel();
    await _chunkSub?.cancel();
    await _faultSub?.cancel();
    await _linkLossSub?.cancel(); // SEG-2: the dead-recording edge watcher.
    await reconnect.stop();
    await audio.dispose();
    await fsm.dispose();
    await stt.dispose();
    await _injectResultCtl.close();
    await _focusStateCtl.close();
    await _autoStoppedCtl.close();
    await _aiComposeCtl.close();
    await _refinedCtl.close();
    paired.dispose();
    connectedDeviceName.dispose();
    _pcPresence.dispose();
    // 49-2/49-3: `_holdOut` holds a timer ⇒ without cancelling it, it would
    // outlive this session.
    _holdOut.cancel(); roomJoins.dispose();
    _stopPresencePoll(); _pcBusy.dispose(); // G-15①
    micPermission.dispose(); // U2: the face notifier dies with its session.
    // IT-10 / F2: SessionScope is a ChangeNotifier — without dispose it outlives
    // the session (third named leak of this shape; same as `_pcBusy` above).
    // Dispose LAST among the notifiers in this method: nothing below this line
    // notifies it. Order alone cannot cancel an in-flight `_widen`; that path
    // is NO-OP'd by SessionScope.dispose() so a late resume cannot
    // notifyListeners after disposed.
    scope.dispose();
  }
}
