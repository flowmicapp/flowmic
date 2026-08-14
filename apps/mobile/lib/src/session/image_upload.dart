// SPEC-REF:
//   apps/server-core/src/http/inject-routes.ts (POST /api/inject/image)
//   docs/decisions/2026-07-30-image-http-upload-and-socket-hardening.md
//   CLAUDE.md red line: no silent failures
//
// The LAN image delivery ingress (RCA-v3). Every image send rides through the
// system photo picker, which backgrounds the app; the owner's handset severs
// background TCP without the socket client noticing for up to 30 s, so a frame
// emitted right after returning vanished into a dead pipe with no receipt. An
// http POST makes a FRESH connection per attempt: a dead link is an immediate,
// visible error instead of a silent swallow, and the response body carries the
// PC's real inject verdict (owner 2026-07-30:「图片先传到PC保存到数据目录，
// 然后再复制->CTRL+V」("the picture is uploaded to the PC and saved to the data
// directory first, then copied → CTRL+V")).
//
// Same discipline as diag_upload.dart: every outcome is NAMED, and the body is
// streamed in chunks so the UI can show a REAL progress bar (owner 2026-07-30:
// 「图片传输要增加进度条在界面的TOP上」("image transfer needs a progress bar added
// at the TOP of the interface") — never an animation pretending to be
// one.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../signaling/http_endpoint.dart';
import '../signaling/lan_pinning.dart' show openPairingHttpClient;

/// What happened to one upload attempt. Mirrors the route's honest exits.
enum ImageUploadStatus {
  /// The PC answered: [ok]/[mode]/[error] carry its REAL verdict (which may be
  /// a failed paste — delivered-to-route ≠ pasted).
  verdict,

  /// The route accepted and relayed, but no inject:result arrived inside the
  /// server's wait window. A frame went out; whether it landed is unknown.
  noAnswer,

  /// The room has no PC right now.
  pcOffline,

  /// RV-05: the SERVER refused to take the delivery and says it may be tried
  /// again ([retryAfterMs]) — a hold-out window (PC_BUSY / PAIR_RELEASED) or a
  /// momentarily full inject table.
  ///
  /// Its own status because it is NOT the PC's verdict and must never be read as
  /// one: every code the phone did not recognise used to fall through to
  /// [verdict], which settled the row from a refusal — a delivery truth invented
  /// out of 「the server would not take it」.
  /// (The other half of RV-05's argument — 「and marked it synced, so the row was
  /// dropped from `pendingSync` and could never be reflushed」 — retired with the
  /// server-side row in 0.2.27; see image_send_controller's serverRefused arm.)
  serverRefused,

  /// The server refused the request for a reason retrying will not fix (auth /
  /// malformed / too large). [detail] carries its own words.
  refused,

  /// The PC could not be reached at all (connection error / timeout).
  unreachable,
}

class ImageUploadResult {
  const ImageUploadResult(
    this.status, {
    this.ok = false,
    this.mode,
    this.error,
    this.detail,
    this.savedToPc = false,
    this.verdictJson,
    this.retryAfterMs,
    this.replayed = false,
  });

  final ImageUploadStatus status;

  /// The PC's verdict when [status] == verdict.
  final bool ok;
  final String? mode;
  final String? error;
  final String? detail;

  /// How long the server said to wait before trying this delivery again
  /// ([ImageUploadStatus.serverRefused]). Carried rather than dropped so the
  /// banner can say 「约 N 秒后可重试」("retry available in about N seconds") — a
  /// refusal with a known duration that is
  /// shown as a bare failure throws away the only actionable part of it.
  final int? retryAfterMs;

  /// The server recognised this request_id as one it had already concluded and
  /// repeated that first answer instead of injecting again (RV-04). Forensics
  /// only: the verdict itself is the same truth either way.
  final bool replayed;

  /// Whether the PC persisted the image file to its data dir (saved:false is
  /// an honest half: delivery may still have succeeded).
  final bool savedToPc;

  /// The raw verdict body when [status] == verdict. Field names are inject:
  /// result's own (ok/mode/error/inject_target/entry_id/request_id — the route
  /// echoes them deliberately), so the caller can settle the row through the
  /// EXACT same InjectResult path the socket mirror uses — one write-back
  /// mechanism, not two.
  final Map<String, Object?>? verdictJson;
}

/// Byte-level progress of the request body write. [sent]==[total] means the
/// body is away and the PC's verdict is now being waited on.
typedef ImageUploadProgress = void Function(int sent, int total);

/// The HTTP seam. Production streams via `dart:io`; tests pass a fake.
typedef ImageUploadPoster =
    Future<({int status, String body})> Function(
      Uri url,
      String token,
      Uint8List body,
      ImageUploadProgress? onProgress,
    );

/// Streamed in slices so [onProgress] reports REAL bytes written — the flush
/// between slices is what makes the number truthful rather than a buffer fill.
const int _kUploadSliceBytes = 32 * 1024;

// Timeout budget for one upload attempt (RV-10).
//
// Root cause: connect had 5s and req.close() had 25s, but the body write loop
// (add + flush) had NONE. On EMUI, a background-killed TCP with no RST leaves
// flush() hung at the OS retransmit timer (minutes) → _sending stuck true,
// tile greyed, progress frozen, no banner.
//
// Sub-timeouts MUST sum to ≤ total. An outer shorter than a stage would make
// that stage's timeout unreachable (a lie). Write gets its own explicit slice;
// nothing else was shortened to pay for it:
//
//   connect:  5 s  — HttpClient.connectionTimeout (TCP handshake)
//   write:   10 s  — body slice flush loop (the EMUI hang this card closes)
//   close:   25 s  — await req.close(); MUST outlast the server's own wait
//   ─────────────────
//   total:   40 s  — outer wrap of the whole poster call in uploadImageInject
//
// Why close stays 25 s and is NOT trimmed to the server's 15 s: the route waits
// up to 15 s for the PC's inject:result and then answers honestly with
// INJECT_RESULT_TIMEOUT (= noAnswer, 「送到了路由，落地未知」("reached the route,
// whether it landed is unknown")). A client ceiling
// equal to that wait races its own answer — we would abandon the socket in the
// same instant the verdict arrives and report `unreachable` for a body the PC
// already has. The caller then auto-retries (image_send_controller) and the PC
// pastes the SAME image twice (RV-04, still open). Aborting a delivery that
// succeeded is worse than waiting 10 s longer, so the client ceiling stays
// strictly above the server's.
//
// The card's 「≤30 s」 acceptance is about DETECTING a dead write, which is
// connect+write = 15 s worst case — it was never a cap on a healthy request
// that is legitimately waiting for the PC to answer.
const Duration kImageUploadConnectTimeout = Duration(seconds: 5);
const Duration kImageUploadWriteTimeout = Duration(seconds: 10);
const Duration kImageUploadCloseTimeout = Duration(seconds: 25);
const Duration kImageUploadDeadline = Duration(seconds: 40);

/// The production poster (dart:io). Named + exported so the controller can
/// pass it explicitly while tests inject a fake.
///
/// D2LAN-B3 — [pin] is the pairing's `MobileSession.lanTlsFp`. This is the LAN
/// leg's biggest payload AND it carries the bearer token, so it pins whenever the
/// pairing has one. Optional + named so the function still satisfies
/// [ImageUploadPoster]; the pin is bound by `uploadImageInject` below, which is
/// where the pairing is known.
Future<({int status, String body})> httpImageUploadPoster(
  Uri url,
  String token,
  Uint8List body,
  ImageUploadProgress? onProgress, {
  String? pin,
}) async {
  final HttpClient client = openPairingHttpClient(
    url: url,
    pin: pin,
    connectionTimeout: kImageUploadConnectTimeout,
  ).client;
  try {
    final HttpClientRequest req = await client.postUrl(url);
    req.headers.contentType = ContentType(
      'application',
      'json',
      charset: 'utf-8',
    );
    req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    req.contentLength = body.length;
    int sent = 0;
    // Write has its own budget: flush() is where a silently-dead TCP hangs.
    // TimeoutException.message names the stage + byte offset so the caller
    // (and the banner) can distinguish "stuck writing" from connect/close.
    Future<void> writeBody() async {
      for (int off = 0; off < body.length; off += _kUploadSliceBytes) {
        final int end = (off + _kUploadSliceBytes > body.length)
            ? body.length
            : off + _kUploadSliceBytes;
        req.add(body.sublist(off, end));
        await req.flush();
        sent = end;
        onProgress?.call(sent, body.length);
      }
    }

    await writeBody().timeout(
      kImageUploadWriteTimeout,
      onTimeout: () => throw TimeoutException(
        'write timeout after $sent bytes',
        kImageUploadWriteTimeout,
      ),
    );
    final HttpClientResponse res = await req.close().timeout(
      kImageUploadCloseTimeout,
    );
    final String text = await res.transform(utf8.decoder).join();
    return (status: res.statusCode, body: text);
  } finally {
    // force:true so a timed-out write/close does not leave the socket open;
    // finally always runs when the timeout cancels the awaiting future.
    client.close(force: true);
  }
}

/// POST the delivery to the PC's sidecar. [item] and [request] are the exact
/// wire shapes history:create / inject:request carry — the route validates them
/// with the SAME protocol schemas, so this is an alternative ingress, never a
/// second contract.
///
/// [deadline] bounds the whole [poster] call (default [kImageUploadDeadline]).
/// Injectable for tests; production default is the real budget, never a short
/// test value.
Future<ImageUploadResult> uploadImageInject({
  required String endpoint,
  required String token,
  required Map<String, Object?> item,
  required Map<String, Object?> request,
  ImageUploadProgress? onProgress,
  // D2LAN-B3 — nullable now, and the default is built BELOW rather than here,
  // because a default value must be a compile-time constant and the pin is not.
  // Tests that inject a poster are untouched; production gets a poster that
  // carries this pairing's pin.
  ImageUploadPoster? poster,
  String? pin,
  Duration deadline = kImageUploadDeadline,
}) async {
  final ImageUploadPoster post =
      poster ??
      (Uri u, String t, Uint8List b, ImageUploadProgress? p) =>
          httpImageUploadPoster(u, t, b, p, pin: pin);
  final String base = endpoint.trim();
  if (base.isEmpty) {
    return const ImageUploadResult(
      ImageUploadStatus.unreachable,
      detail: 'no endpoint',
    );
  }
  // 🔴 RV-97 — THE SCHEME IS NORMALIZED HERE, AND THIS LINE IS THE WHOLE BUG.
  //
  // [endpoint] is `ReconnectCoordinator.url`, i.e. whatever the pairing DIALS
  // with — and a QR-paired PC dials `ws://host:port` because that is what the
  // desktop's QR carries (apps/desktop/src/lib/pairing.ts `toWsUrl()`). This used to
  // string-concatenate that verbatim, so `HttpClient.postUrl` was handed
  // `ws://10.0.0.78:41879/api/inject/image` and threw
  // `ArgumentError: Unsupported scheme 'ws'` — caught below as `unreachable`,
  // shown to owner as 「联系不上电脑（…），图片没有发出」("can't reach the computer
  // (…), the picture was not sent") while the picture went
  // out over the socket anyway.
  //
  // ⇒ RCA-v3's whole point (「LAN 图片改 HTTP 上载」/ "switch LAN images to HTTP
  // upload", 0.2.16) had never once
  // succeeded: before RV-89 `serverChannel` was permanently null, so
  // `sessionLanIngress` never produced an ingress and nothing ever reached this
  // line; RV-89 made the channel readable, this path ran for the first time, and
  // it was broken.
  //
  // [httpEndpointUri] is the repo's ONE answer to 「把这个端点当 HTTP 基址是什么」
  // ("what it means to treat this endpoint as an HTTP base URL")
  // (signaling/http_endpoint.dart) — the same one `healthUri` and
  // `uploadDiagnostics` ask. It also removes the `endsWith('/')` special case:
  // the route is absolute on the server root, so the endpoint's own path/query
  // is dropped rather than concatenated around.
  final Uri url;
  try {
    url = httpEndpointUri(base, '/api/inject/image');
  } on FormatException {
    return const ImageUploadResult(
      ImageUploadStatus.unreachable,
      detail: 'bad endpoint',
    );
  }
  final Uint8List body = Uint8List.fromList(
    utf8.encode(
      jsonEncode(<String, Object?>{'item': item, 'request': request}),
    ),
  );

  final ({int status, String body}) res;
  try {
    res = await post(url, token, body, onProgress).timeout(
      deadline,
      onTimeout: () =>
          throw TimeoutException('upload deadline exceeded', deadline),
    );
  } on TimeoutException catch (e) {
    return ImageUploadResult(
      ImageUploadStatus.unreachable,
      detail: e.message ?? 'upload deadline exceeded',
    );
  } on Object catch (e) {
    return ImageUploadResult(
      ImageUploadStatus.unreachable,
      detail: e.toString(),
    );
  }

  Map<String, Object?> parsed;
  try {
    parsed = (jsonDecode(res.body) as Map).cast<String, Object?>();
  } on Object {
    parsed = const <String, Object?>{};
  }
  final String? error = parsed['error'] as String?;
  final bool saved = parsed['saved'] == true;
  final bool replayed = parsed['replayed'] == true;
  final int? retryAfterMs = (parsed['retry_after_ms'] as num?)?.round();

  if (res.status == 200) {
    if (error == 'INJECT_PC_OFFLINE') {
      return ImageUploadResult(ImageUploadStatus.pcOffline, savedToPc: saved);
    }
    if (error == 'INJECT_RESULT_TIMEOUT') {
      return ImageUploadResult(
        ImageUploadStatus.noAnswer,
        savedToPc: saved,
        replayed: replayed,
      );
    }
    // RV-05. Read off `retryable`, not off a list of codes: the route marks
    // every hold-out / capacity refusal that way, so a code this build has never
    // heard of is still classified as a refusal instead of being mistaken for
    // the PC's verdict. The two codes are also matched by name so an older
    // server that omits the flag is still understood.
    if (parsed['retryable'] == true ||
        error == 'PC_BUSY' ||
        error == 'PAIR_RELEASED') {
      return ImageUploadResult(
        ImageUploadStatus.serverRefused,
        error: error,
        retryAfterMs: retryAfterMs,
        savedToPc: saved,
      );
    }
    return ImageUploadResult(
      ImageUploadStatus.verdict,
      ok: parsed['ok'] == true,
      mode: parsed['mode'] as String?,
      error: error,
      savedToPc: saved,
      verdictJson: parsed,
      replayed: replayed,
    );
  }
  return ImageUploadResult(
    ImageUploadStatus.refused,
    error: error,
    detail: '${res.status} ${res.body}',
    retryAfterMs: retryAfterMs,
  );
}
