// Part of ptt_session.dart — the server-channel probe (RV-89).
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_inbound.dart / ptt_wire_keepalive.dart / every sibling:
// ptt_session.dart sits at the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX=800), and card SEG-2 had to add two fields (`_reconnectAckAudioSeq`,
// `_linkLossSub`) plus the spill DI parameter — state that cannot live outside
// the class. This family was the smallest fully self-contained one left: one
// method, whose two fields (`serverChannel` / `_serverChannelEndpoint`) stay
// declared on the class.
//
// 🔴 DIFF DISCIPLINE: the doc comment and body below are moved
// **character-for-character**, with the one mechanical edit this family always
// makes — the method becomes an extension member so both call sites
// (`resumePairing`, `pair()` in ptt_pair.dart) are untouched.
// **Any other difference in the diff is a bug.**

part of 'ptt_session.dart';

extension PttSessionChannelProbe on PttSession {
  /// Ask the connected endpoint which channel it is. Best-effort and never
  /// blocking — knowing the label is not a precondition for talking.
  ///
  /// 🔴 Three criteria, none optional (RV-89 addendum, lead 2026-08-01):
  ///
  /// **③ The endpoint changed ⇒ clear first.** `connectTo(B)` does not go
  /// through `leaveRoom()` (that is only called on leaving the transcription
  /// page), so before this method runs the notifier is still sitting on
  /// **A**'s answer, and if this method's opening does not clear it ⇒ when
  /// A=LAN, B=relay, the 「original image」 would get offered over the relay
  /// during that window. **This is the ONE case in the whole repo that fails
  /// in the WRONG direction**, so it comes first: lose a chip rather than ever
  /// risk sending an original image to the cloud.
  ///
  /// **① The endpoint did NOT change ⇒ a failure keeps the previous answer.**
  /// It used to read `r.ok ? r.channel : null`: a single failure erased the
  /// answer to 「不知道」("unknown"), and `_onReconnected` never re-probes ⇒
  /// **one failure = this session never knows for its whole life** (RV-89's
  /// real symptom: the QR code stored `ws://`, `healthUri` fed it straight
  /// into `HttpClient.getUrl`, which threw `ArgumentError` — an `Error`, not
  /// an `Exception`, so `on Exception` could not catch it — and it escaped
  /// down to the `on Object` here, which wrote null, so every scanned-QR
  /// session came out grey). 🔴 And **the same fact already has an opposite
  /// written policy elsewhere in this repo**:
  /// `connections_controller.dart:206-211`'s `_probeOne` says
  /// 「**『这次没问到』不是『它变了』**」("'didn't get an answer this time' is
  /// not 'it changed'"). The same fact cannot support two policies ⇒ align
  /// with `_probeOne`: only write when the probe succeeded AND the `mode` is
  /// one we recognise.
  ///
  /// **② The in-flight gap** (between `connect` returning and this method
  /// answering — millisecond-scale on LAN): **it structurally still exists,
  /// but it now only fails in the safe direction**. During an endpoint
  /// change, the value in that gap is `null` (cleared by ③), and the
  /// fail-closed criterion treats that as cloud; during a same-endpoint
  /// reconnect, what is retained is the previous answer **about the same
  /// server**, exactly what ① means by "didn't get an answer isn't the same
  /// as it changed". ⇒ No need for a lock or another blocking probe.
  Future<void> _refreshServerChannel(String endpoint) async {
    if (endpoint.isEmpty) return;
    if (_serverChannelEndpoint != endpoint) {
      _serverChannelEndpoint = endpoint;
      serverChannel.value = null; // ③ fail-closed, before any await
    }
    try {
      final HealthReading r =
          await healthReader(healthUri(endpoint), const Duration(seconds: 3));
      final ServerChannel? measured = r.channel;
      if (r.ok && measured != null) serverChannel.value = measured; // ①
    } on Object {
      // ① 「这次没问到」不是「它变了」("'didn't get an answer this time' is
      // not 'it changed'") — keep the previous answer about **this
      // endpoint**. `_onReconnected` will probe again, so one failure is no
      // longer a life sentence.
    }
  }
}
