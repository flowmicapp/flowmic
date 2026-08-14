// FIX-014 — `_open()` in update_download.dart must close its `HttpClient` on
// EVERY path out of `downloadAndVerify`, not only the one that reads
// `res.bytes` to completion. Before the fix, a non-200 response made
// `downloadAndVerify` return `serverRefused` without ever listening to the
// stream, so the `finally` that closed the client — living inside an
// `async*` generator, which never runs its body until something listens —
// never ran. The client (and its TCP connection) leaked until dart:io's own
// 15s `HttpClient.idleTimeout` eventually cleaned it up.
//
// ── why this drives the REAL `_open()`, not a fake `UpdateByteSource` ─────
//
// The bug lives inside `_open()` itself — the private function that
// constructs the `HttpClient`. Every test in `update_download_test.dart`
// passes its own `open:` override, which bypasses `_open()` completely and
// therefore cannot see this leak at all — that file proves the
// outcome-selection logic, not the transport underneath it. This file calls
// `downloadAndVerify` with NO `open:` argument, so it falls through to the
// real default and drives a real `HttpClient` against a real loopback
// `HttpServer`.
//
// ── why a seam is needed to observe "closed" at all ───────────────────────
//
// `HttpClient` has no public `isClosed` getter anywhere in `dart:io` — the
// SDK source (`_http/http_impl.dart`) keeps that flag as the private
// `_HttpClient._closing`. The only thing dart:io exposes is BEHAVIOUR: once
// `close()` has run, `getUrl()` throws `StateError('Client is closed')`
// synchronously, before it does anything else (`_HttpClient._openUrl`'s
// first statement is that very check). So "was it closed" has to be asked by
// trying to use the client again and reading what comes back: a `StateError`
// means yes; anything else (typically a `SocketException` from actually
// dialling a dead port, or nothing at all) means the client was still alive
// and usable — i.e. still leaking.
// `debugOnUpdateHttpClientOpened` (update_download.dart) is the narrow seam
// that hands this file the exact `HttpClient` instance `_open()` built, so
// what gets asserted is a fact about the real client, not a
// re-implementation of the close logic under test.
//
// ── the reverse control (run by hand while editing this fix) ──────────────
//
// With the `if (res.statusCode != 200) { client.close(force: true); ... }`
// branch in `_open()` removed (i.e. `_open()` back to unconditionally
// returning `body()` regardless of status), the first test below fails:
//
//   Expected: <Instance of 'StateError'> with `message`: contains 'closed'
//     Actual: TimeoutException:<TimeoutException after 0:00:02.000000:
//             Future not completed>
//      Which: is not an instance of 'StateError'
//
// (`afterClose` is a `TimeoutException`, not a `StateError`, because
// `client.getUrl()` on the still-open client does not throw at all — the
// request actually goes out and tries to dial 127.0.0.1:1, which on this
// host does not refuse fast enough to beat `probeAfterClose`'s own 2s
// timeout. Either way it proves the point: a closed client answers with
// `StateError('Client is closed')` synchronously, before touching the
// network at all — anything that reaches the network, including a
// timeout, means the client was still alive.) This is the actual output
// from a real run with the fix removed, captured while writing this card;
// the branch was restored immediately after and the suite went green
// again — see this card's final report for the full transcript.

import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flowmic/src/update/update_download.dart';
import 'package:flowmic/src/update/update_manifest.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory tmp;
  late Directory into;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-fix014-');
    into = Directory('${tmp.path}${Platform.pathSeparator}update');
  });

  tearDown(() async {
    // 🔴 Global test seam — must not leak into any other test file's run.
    debugOnUpdateHttpClientOpened = null;
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  /// Tries to use [client] again and reports what came back. `null` means
  /// the call did not throw at all — the client is still fully usable, i.e.
  /// still leaking. Bounded by its own short timeout so an unexpectedly-live
  /// client cannot make this hang anywhere near the suite's `--timeout 90s`.
  Future<Object?> probeAfterClose(HttpClient client) async {
    try {
      await client
          .getUrl(Uri.parse('http://127.0.0.1:1/fix-014-probe'))
          .timeout(const Duration(seconds: 2));
      return null;
    } on Object catch (e) {
      return e;
    }
  }

  final Matcher isClosedClientError = isA<StateError>().having(
    (StateError e) => e.message,
    'message',
    contains('closed'),
  );

  test(
    '🔴 FIX-014: a non-200 through the REAL _open() still closes the '
    'HttpClient — this is the bug. It used to leak because nothing ever '
    'listened to the (unused) response stream on this path',
    () async {
      final HttpServer server = await HttpServer.bind(
        InternetAddress.loopbackIPv4,
        0,
      );
      addTearDown(() => server.close(force: true));
      server.listen((HttpRequest request) async {
        request.response.statusCode = 404;
        request.response.headers.contentLength = 0;
        await request.response.close();
      });

      int opened = 0;
      HttpClient? captured;
      debugOnUpdateHttpClientOpened = (HttpClient c) {
        opened++;
        captured = c;
      };

      final UpdateArtifact artifact = UpdateArtifact(
        kind: 'apk',
        locale: null,
        filename: 'FlowMic-9.9.9-release.apk',
        url: 'http://127.0.0.1:${server.port}/missing.apk',
        sha256:
            'deadbeef00000000000000000000000000000000000000000000000000000000',
        size: 1,
      );

      final UpdateDownloadResult result = await downloadAndVerify(
        artifact: artifact,
        into: into,
        // 🔴 No `open:` override — this must exercise the real `_open()`.
      );

      expect(result.outcome, UpdateDownloadOutcome.serverRefused);
      expect(result.detail, 'http_404');
      expect(opened, 1, reason: '_open() must build exactly one HttpClient');

      final Object? afterClose = await probeAfterClose(captured!);
      expect(
        afterClose,
        isClosedClientError,
        reason:
            'the client _open() built for a 404 must already be closed by '
            'the time downloadAndVerify returns. Getting anything else back '
            'here (a SocketException from actually dialling out, or null '
            "because it didn't throw at all) means the client is still "
            'alive — the leak this card fixes.',
      );
    },
  );

  test(
    'the success path (download -> hash -> verified) still works through '
    'the REAL _open(), and still closes the client exactly once',
    () async {
      final List<int> bytes = List<int>.generate(
        4096,
        (int i) => (i * 17 + 3) % 251,
      );
      final String sha = sha256.convert(bytes).toString();

      final HttpServer server = await HttpServer.bind(
        InternetAddress.loopbackIPv4,
        0,
      );
      addTearDown(() => server.close(force: true));
      server.listen((HttpRequest request) async {
        request.response.statusCode = 200;
        request.response.headers.contentLength = bytes.length;
        request.response.add(bytes);
        await request.response.close();
      });

      int opened = 0;
      HttpClient? captured;
      debugOnUpdateHttpClientOpened = (HttpClient c) {
        opened++;
        captured = c;
      };

      final UpdateArtifact artifact = UpdateArtifact(
        kind: 'apk',
        locale: null,
        filename: 'FlowMic-9.9.9-release.apk',
        url: 'http://127.0.0.1:${server.port}/x.apk',
        sha256: sha,
        size: bytes.length,
      );

      final UpdateDownloadResult result = await downloadAndVerify(
        artifact: artifact,
        into: into,
      );

      // ── the success path still works end to end ───────────────────────
      expect(result.outcome, UpdateDownloadOutcome.verified);
      expect(result.file, isNotNull);
      expect(await result.file!.readAsBytes(), equals(bytes));

      // ── and it still closes the client, exactly once ──────────────────
      expect(opened, 1, reason: '_open() must build exactly one HttpClient');
      final Object? afterClose = await probeAfterClose(captured!);
      expect(
        afterClose,
        isClosedClientError,
        reason:
            'the success path must not regress: it closes via the async* '
            "generator's finally once the body stream drains — a different "
            'call site than the 404 branch above, but the same client, and '
            "it must still end up closed. This is also what rules out "
            "FIX-014's new early branch leaving the 200 path unclosed: if "
            'that branch had somehow fired here too and swallowed status '
            "200, this test's `verified` assertion above would already have "
            'failed.',
      );
    },
  );
}
