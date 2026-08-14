// SPEC-REF:
//   apps/server-core/src/http/diag-routes.ts (POST /api/diag/mobile)
//   apps/mobile/lib/src/diag/diag_log.dart (what is in the trail, and what is not)
//
// Ship the phone's diagnostic trail to the PC it is paired with. The endpoint is
// the SAME base URL the socket is already talking to, so there is no new address
// to configure and nothing to point at a third party.
//
// Every outcome is NAMED. An upload that quietly did nothing would be worse than
// no feature at all here: the whole point is to be able to trust what the log
// says, and 「我传了但没看到」("I sent it but didn't see it") is precisely the kind
// of half-truth this window has been paying for all day.

import 'dart:convert';
import 'dart:io';

import '../signaling/http_endpoint.dart';
import '../signaling/lan_pinning.dart' show openPairingHttpClient;
import 'diag_log.dart';

/// What happened to an upload attempt. The UI shows a different sentence for
/// each — there is no generic 「失败了」("it failed").
enum DiagUploadOutcome {
  /// Written to the PC's log file. [DiagUploadResult.lines] says how many.
  delivered,

  /// Nothing to send yet.
  empty,

  /// No PC endpoint known (not paired / cloud-only session).
  noEndpoint,

  /// The PC answered, but said it has nowhere to write (server started without
  /// a log path — the cloud relay, for instance, never accepts these).
  noSink,

  /// The PC could not be reached at all.
  unreachable,

  /// The PC refused the body (too large / malformed).
  refused,
}

class DiagUploadResult {
  const DiagUploadResult(this.outcome, {this.lines = 0, this.detail});
  final DiagUploadOutcome outcome;
  final int lines;

  /// The server's own words when it refused, so an unknown reason is shown
  /// rather than collapsed.
  final String? detail;
}

/// The HTTP seam. Production uses `dart:io`; tests pass a fake.
/// [token] is the pairing Bearer (nullable — diagnosis must still upload when
/// unpaired; an empty Authorization header would conflate 「no token」 with
/// 「bad token」 on the server, so the poster must omit the header then).
typedef DiagPoster = Future<({int status, String body})> Function(
  Uri url,
  String jsonBody,
  String? token,
);

Future<({int status, String body})> _post(
  Uri url,
  String jsonBody,
  String? token, {
  // D2LAN-B3 — the pairing's pinned fingerprint. The diagnostics body is this
  // phone's trail (endpoints, pc ids, error codes) and it goes out under the
  // pairing token, so it pins whenever the pairing does.
  String? pin,
}) async {
  final HttpClient client = openPairingHttpClient(
    url: url,
    pin: pin,
    connectionTimeout: const Duration(seconds: 5),
  ).client;
  try {
    final HttpClientRequest req = await client.postUrl(url);
    req.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
    // Only a non-empty token may set Authorization. A blank Bearer makes the
    // server treat 「missing」 and 「forged」 as the same thing (both UNVERIFIED);
    // omitting the header keeps that distinction honest.
    final String? bearer = token?.trim();
    if (bearer != null && bearer.isNotEmpty) {
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
    }
    req.write(jsonBody);
    final HttpClientResponse res = await req.close().timeout(const Duration(seconds: 10));
    final String body = await res.transform(utf8.decoder).join();
    return (status: res.statusCode, body: body);
  } finally {
    client.close(force: true);
  }
}

/// Upload the current trail to [endpoint] (the PC's base URL, e.g.
/// `http://192.168.1.5:41879`). [deviceLabel] names the phone in the PC's log.
///
/// [token] is the current pairing token when one exists. Absence must NOT block
/// the upload — the valuable case is often exactly when pairing is broken; the
/// PC then marks the block `[phone-unverified]` instead of `[phone]`.
Future<DiagUploadResult> uploadDiagnostics({
  required String? endpoint,
  required String deviceLabel,
  required String? token,
  // D2LAN-B3 — nullable so the production poster can be built WITH [pin]; a
  // default value has to be a constant and the pin is not. Tests inject their
  // own poster and are untouched.
  DiagPoster? poster,
  String? pin,
  DiagLog? log,
}) async {
  final DiagPoster post =
      poster ?? (Uri u, String b, String? t) => _post(u, b, t, pin: pin);
  final DiagLog trail = log ?? DiagLog.instance;
  final String base = (endpoint ?? '').trim();
  if (base.isEmpty) return const DiagUploadResult(DiagUploadOutcome.noEndpoint);
  final List<String> lines = trail.snapshot();
  if (lines.isEmpty) return const DiagUploadResult(DiagUploadOutcome.empty);

  // 🔴 RV-97 — THE SAME BUG AS THE IMAGE INGRESS, FOUND BY GREPPING FOR IT.
  //
  // The caller is `connection_diagnostics_sheet.dart:25`, which passes
  // `session.reconnect.url` — the DIAL string, `ws://host:port` for every
  // QR-paired PC. `HttpClient.postUrl` throws `ArgumentError: Unsupported scheme
  // 'ws'` on that, which the blanket `on Object` below reports as
  // [DiagUploadOutcome.unreachable] ⇒ 「把手机诊断日志发到电脑」("send the phone's
  // diagnostic log to the PC") has been answering 「联系不上电脑」("can't reach the
  // PC") for every QR-paired session since it shipped, on a PC that was
  // right there. Nobody reported it because the sentence was plausible.
  //
  // One rule, one place: signaling/http_endpoint.dart.
  final Uri url;
  try {
    url = httpEndpointUri(base, '/api/diag/mobile');
  } on FormatException {
    return const DiagUploadResult(DiagUploadOutcome.noEndpoint);
  }
  final String payload = jsonEncode(<String, Object?>{
    'device': deviceLabel,
    'lines': lines,
  });

  try {
    final ({int status, String body}) res = await post(url, payload, token);
    if (res.status == 200) {
      return DiagUploadResult(DiagUploadOutcome.delivered, lines: lines.length);
    }
    if (res.status == 503) {
      return DiagUploadResult(DiagUploadOutcome.noSink, detail: res.body);
    }
    return DiagUploadResult(DiagUploadOutcome.refused, detail: '${res.status} ${res.body}');
  } on Object catch (e) {
    return DiagUploadResult(DiagUploadOutcome.unreachable, detail: e.toString());
  }
}
