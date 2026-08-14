// Part of ptt_session.dart — the wire keep-alive plumbing.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_inbound.dart / ptt_presence_poll.dart / ptt_reconnect_ack
// .dart: ptt_session.dart sits at the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX=800), and F-1/49-3 added two fields (`_holdOut`, `roomJoins`) that
// cannot live anywhere else — Dart has no partial classes, so state stays with
// the class and only BEHAVIOUR can move out.
//
// This family was chosen because it is the largest fully self-contained one left:
// three methods, one field (`_heartbeatTimer`, still declared on the class),
// and no caller outside this library.
//
// 🔴 DIFF DISCIPLINE: all three bodies are moved **character-for-character**,
// with the one mechanical edit this family always makes — they become extension
// members so every existing call site (`_startHeartbeat()`, `_safeEmit(...)`)
// is untouched. **Any other difference in the diff is a bug.**

part of 'ptt_session.dart';

extension PttSessionWireKeepAlive on PttSession {
  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(heartbeatInterval, (_) {
      final int now = DateTime.now().millisecondsSinceEpoch;
      // ONE beat per tick since 2026-07-31. This timer used to fire a second,
      // recording-only `audio:heartbeat` carrying last_chunk_seq — deleted with
      // that event: no server has ever listened for it, and the gap-replay loop
      // its payload was meant to drive was never built. `heartbeat` below is
      // the one that is actually handled (heartbeat.handler.ts).
      _safeEmit(FlowMicEvents.heartbeat, HeartbeatPayload(now).toJson());
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
  }

  void _safeEmit(String event, Object? payload) {
    try {
      transport.emit(event, payload);
    } on Object {
      // Best-effort; a closed transport is recovered by the reconnect ladder.
    }
  }
}
