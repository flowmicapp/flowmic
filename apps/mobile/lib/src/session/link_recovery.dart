// SPEC-REF:
//   docs/decisions/2026-07-30-image-http-upload-and-socket-hardening.md
//
// RCA-v3 link-recovery helpers — the bodies behind ChatController's
// ManualDeliveryHost seams (kickLink / awaitLinkUp / lanImageIngress). A file
// of their own because chat_controller.dart sits at the source cap; the
// controller keeps one-line delegations so the host contract stays readable
// in one place there.

import '../ptt/ptt_session.dart';
import '../signaling/socket_core.dart';
import 'instance_probe.dart' show ServerChannel;
import 'manual_delivery.dart' show LanImageIngress;

/// Wait for [transport] to report connected again, bounded. False = the
/// reconnect ladder could not bring it back inside [timeout].
Future<bool> transportLinkUp(SocketTransport transport, Duration timeout) async {
  if (transport.currentStatus == SocketStatus.connected) return true;
  try {
    await transport.status
        .firstWhere((SocketStatus s) => s == SocketStatus.connected)
        .timeout(timeout);
    return true;
  } on Object {
    return false;
  }
}

/// The LAN http image ingress for [session], or null when the live channel is
/// not a MEASURED-standalone server (`/api/health.mode`) or the session holds
/// no dialable endpoint + token. The cloud relay keeps the socket path — it
/// deliberately does not mount the route (see inject-routes.ts header).
LanImageIngress? sessionLanIngress(PttSession session) {
  if (session.serverChannel.value != ServerChannel.lan) return null;
  final String? url = session.reconnect.url;
  final String? token = session.reconnect.token;
  if (url == null || url.isEmpty || token == null || token.isEmpty) return null;
  return LanImageIngress(endpoint: url, token: token, pin: session.lanPin);
}
