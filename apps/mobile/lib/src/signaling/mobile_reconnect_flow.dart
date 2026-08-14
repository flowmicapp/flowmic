// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (mobile:reconnect{token} on the connected
//     rising edge; AUTH_TOKEN_INVALID → stop reconnect + delete the local
//     session; ack enriches the stored pairing)
//   packages/protocol/src/protocol-schemas-auth.ts (MobileReconnectSchema)
//
// The mobile:reconnect round-trip: emit the stored token with ack, classify the
// result, and update local secure storage. Extracted so the reconnect
// coordinator's rejoin callback and the presence self-heal re-probe share one
// implementation.
//
// Ported from legacy signaling/mobile_reconnect_flow.dart. Event name is the
// generated FlowMicEvents.mobileReconnect constant.

import '../../generated/flowmic_events.g.dart';
import '../auth/token_storage.dart';
import '../session/platform_device_info.dart';
import 'socket_core.dart';
import 'wire_payloads.dart';

typedef ReconnectAccepted = void Function(dynamic ack);

/// 🔴 Card L7 (owner 2026-08-02, docs/rebuild/15 §2.5d) — [error] is the ack's OWN
/// `error` string, or null when there was no ack at all (timeout / throw).
///
/// It exists because 「另一台手机占着这台电脑」("another phone is holding this
/// PC") is a fact the server states BY NAME
/// (`PC_BUSY`, mobile.handler.ts) and the phone was throwing it on the floor: this
/// callback used to take only two booleans, so the one code that could explain a
/// whole session's worth of undelivered rows never reached any surface. Same shape
/// as Book 15 §1.4's 「`pc_online` 一直就在 ack 上，而手机把它扔在地上」("`pc_online`
/// has always been on the ack, and the phone threw it on the floor").
///
/// ⚠️ Passed as the RAW string, not a parsed enum: this seam has exactly one
/// consumer today and inventing a Dart enum for it would be a second name for a
/// wire identifier (the same reasoning `_isNoFocusReason` states in
/// status_badge.dart for `INJECT_NO_TEXT_TARGET`).
///
/// 🔴 L-② (2026-08-02) — [retryAfterMs] is the ack's own `retry_after_ms`, or
/// null when the ack did not carry one. It is the REAL REMAINING window the
/// server measured (`release-suppression.ts` `remainingMs`, handed over at
/// `mobile.handler.ts:232`), not a window LENGTH: the phone must never compute
/// 「还剩多久」("how much time is left") itself. Same shape as
/// `image_upload.dart:300`, which has been
/// reading this exact field off the image path's refusal since RV-05 — the
/// reconnect path simply threw it away.
typedef ReconnectRejected =
    void Function(bool surfaceBanner, bool invalid, String? error, int? retryAfterMs);

/// 🔴 L-② — what a refused `mobile:reconnect` actually said, kept together.
///
/// Two fields rather than two loose values because they are ONE answer: a code
/// without its budget cannot say 「等 47 秒」("wait 47 seconds"), and a budget
/// without its code
/// cannot say 「等着干什么」("waiting for what"). Splitting them is how the
/// budget got lost.
class ReconnectRefusal {
  const ReconnectRefusal({this.code, this.retryAfterMs});

  /// The server's OWN error string, or null when we never got an ack at all
  /// (timeout / throw). 🔴 **Never a fabricated one** — 「我们没问到」("we
  /// didn't get an answer") and
  /// 「服务器说了 X」("the server said X") must not read alike, and inventing a
  /// code here is exactly
  /// the defect this class exists to make impossible (see [encodeHoldOut]).
  final String? code;

  /// Milliseconds the server said are left, or null when it did not say.
  final int? retryAfterMs;
}

/// The two codes that travel WITH a millisecond budget on this path, because
/// they are the two the server's hold-out gate emits (`mobile.handler.ts:229-233`
/// reading `ReleaseSuppression`). Nothing else on this seam has a budget, so
/// nothing else may carry a `:ms` suffix.
const Set<String> kHoldOutCodes = <String>{'PAIR_RELEASED', 'PC_BUSY'};

/// Pack a hold-out refusal into the error-code channel as `CODE:ms`.
///
/// WHY AN ENCODING AND NOT A SECOND PARAMETER: the only string that reaches the
/// user on this path is `ConnectOutcome.error → AppStrings.pairError`, exactly
/// as it was for B4-15's 「这几个地址都试过了」("all of these addresses were
/// tried") — see the identical reasoning at
/// `endpoint_candidates.dart` `kCandidateFailurePrefix`. The decode lives right
/// below the encode so the two cannot drift.
///
/// A code with no budget (or a non-positive one) is returned UNCHANGED: an empty
/// suffix would make 「服务器没说」("the server didn't say") indistinguishable
/// from 「服务器说 0 秒」("the server said 0 seconds").
String encodeHoldOut(String? code, int? retryAfterMs) {
  if (code == null || code.isEmpty) return '';
  if (!kHoldOutCodes.contains(code)) return code;
  if (retryAfterMs == null || retryAfterMs <= 0) return code;
  return '$code:$retryAfterMs';
}

/// Read it back. Non-hold-out codes (and anything unparseable) come back with a
/// null budget and their string untouched, so `CONNECT_FAILED_CANDIDATES:…` and
/// `PAIR_TIMEOUT…` — which carry colons of their own — are never touched here.
ReconnectRefusal decodeHoldOut(String? code) {
  if (code == null || code.isEmpty) return const ReconnectRefusal();
  final int sep = code.indexOf(':');
  if (sep <= 0) return ReconnectRefusal(code: code);
  final String head = code.substring(0, sep);
  if (!kHoldOutCodes.contains(head)) return ReconnectRefusal(code: code);
  final int? ms = int.tryParse(code.substring(sep + 1));
  if (ms == null || ms <= 0) return ReconnectRefusal(code: head);
  return ReconnectRefusal(code: head, retryAfterMs: ms);
}

/// Q2 (owner 2026-08-12) — the ONE code that travels with an enumerated
/// RESTRICTION REASON beside it (`mobile.handler.ts` → `restrictionRefusalBody`,
/// which puts `{error:'ACCOUNT_RESTRICTED', reason:'<key>'}` on the ack).
///
/// A separate constant from [kHoldOutCodes] because the two payloads are
/// different kinds of thing — one is a millisecond budget this phone counts
/// down, the other is an identifier this phone renders from its own table — and
/// a set that held both would let a hold-out code acquire a reason, or a
/// restriction acquire a countdown, neither of which the server ever sends.
const String kRestrictionCode = 'ACCOUNT_RESTRICTED';

/// Pack a restriction refusal into the error-code channel as `CODE:reason_key`.
///
/// WHY AN ENCODING AND NOT A SECOND FIELD: identical reasoning to [encodeHoldOut]
/// directly above — the only string that reaches the user on this path is
/// `ConnectOutcome.error → AppStrings.pairError`, so a value that does not
/// travel in it does not reach the screen. The `reason` the server took the
/// trouble to send would otherwise be read off the ack and dropped one frame
/// later, which is the L-② shape this file already carries two scars from.
///
/// Anything that is not a restriction comes back UNCHANGED, and so does a
/// restriction with no reason (a pre-Q2 restriction genuinely has none, and an
/// empty suffix would make 「服务端没说」("the server side didn't say") look
/// like 「服务端说了空字符串」("the server side said an empty string")).
///
/// ⚠️ NULL IN, NULL OUT — deliberately unlike [encodeHoldOut], which collapses a
/// null code to `''`. This one sits on the path where a null means 「我们没问到」
/// ("we didn't get an answer")
/// (no ack at all), and that must not become an empty string one layer down: the
/// two are the distinction [ReconnectRefusal.code] exists to protect.
String? encodeRestrictionReason(String? code, String? reasonKey) {
  if (code == null || code.isEmpty) return code;
  if (code != kRestrictionCode) return code;
  if (reasonKey == null || reasonKey.isEmpty) return code;
  return '$kRestrictionCode:$reasonKey';
}

/// Read it back, splitting the bare code from the reason key.
///
/// Lives immediately below its encode so the two cannot drift — the same
/// arrangement, and the same reason, as [encodeHoldOut] / [decodeHoldOut].
/// Everything else passes through untouched, so `PAIR_TIMEOUT: …` and
/// `CONNECT_FAILED_CANDIDATES:…` keep their own colons.
({String? code, String? reasonKey}) decodeRestrictionReason(String? code) {
  if (code == null || !code.startsWith('$kRestrictionCode:')) {
    return (code: code, reasonKey: null);
  }
  final String key = code.substring(kRestrictionCode.length + 1);
  return (
    code: kRestrictionCode,
    reasonKey: key.isEmpty ? null : key,
  );
}

/// 「这个 ack 说了原因吗」("did this ack state a reason") — read exactly like
/// every other field on this seam:
/// only what the ack actually said, never a substituted default. A non-string,
/// absent or empty `reason` is null, and null means the notice renders without a
/// reason line, which is the honest degrade the server's own comment names.
String? restrictionReasonOfAck(Object? ack) {
  if (ack is! Map) return null;
  final Object? reason = ack['reason'];
  return (reason is String && reason.isNotEmpty) ? reason : null;
}

/// 🔴 When the handshake itself gets refused, where is the server's answer
/// (owner 2026-08-03, real device:「配对失败：未知错误」("Pairing failed: unknown
/// error")).
///
/// **On the PC, 「revoke pairing」 deletes the `mobile_pairings` row**
/// (`pc.handler.ts`'s
/// `registry.revokeMobile(...)` call),
/// so this phone's token gets refused right at **the handshake middleware**
/// (`auth/middleware.ts`'s
/// `AUTH_TOKEN_INVALID` branch),
/// **the `mobile:reconnect` frame never even gets a chance to go out** ⇒ no
/// ack, no `error` field.
/// The recovery path (`PttSession.resumePairing`'s `catch`) used to just
/// `return false`,
/// so the UI read a null and answered 「未知错误」("unknown error") — **while
/// the server had in fact answered by name**, the answer was sitting right on
/// `lastConnectError`, which [runMobileReconnect] itself reads exactly that
/// way further down at line 140.
/// Another instance of 「事实传下来了、被丢掉，然后编了一个」("the fact made it
/// down, got dropped, and then something was made up") (L-②), this time what
/// got made up was 「未知」("unknown").
///
/// ⚠️ **Only trust the codes we recognize**: `lastConnectError` can also be
/// raw transport-layer text like `xhr poll error` /
/// `timeout`, and those are **not** the server's verdict on this token ⇒
/// return null,
/// and let the UI honestly say 「没问到」("didn't get an answer"). **「我们没问到」
/// ("we didn't get an answer") and 「服务器说了 X」("the server said X") must
/// not read alike**
/// — this is the entire reason [ReconnectRefusal.code] exists.
ReconnectRefusal? handshakeRefusal(SocketTransport transport) {
  final String? raw = transport.lastConnectError;
  if (raw == null || !raw.contains('AUTH_TOKEN_INVALID')) return null;
  return const ReconnectRefusal(code: 'AUTH_TOKEN_INVALID');
}

Future<bool> runMobileReconnect({
  required SocketTransport transport,
  required TokenStorage tokenStorage,
  required String token,
  required Duration timeout,
  required bool surfaceTransientFailure,
  required ReconnectAccepted onAccepted,
  required ReconnectRejected onRejected,
}) async {
  if (token.isEmpty) {
    // No request was made, so there is no server code to report — null, never a
    // fabricated one (a guessed 'PC_BUSY' here would raise a banner about a
    // second phone that may not exist). Same for the budget: nobody measured one.
    onRejected(surfaceTransientFailure, false, null, null);
    return false;
  }
  dynamic ack;
  bool ok = false;
  try {
    ack = await transport.emitWithAck<dynamic>(
      FlowMicEvents.mobileReconnect,
      // v0.2.4 — carry this handset's uid so a pairing made before the field
      // existed gets it BACKFILLED on the very next reconnect, with no
      // migration that has to guess which row belongs to which phone. Pure
      // backfill: the server finds the row by token, never by this.
      MobileReconnectPayload(token, deviceUid: cachedDeviceUid()).toJson(),
      timeout: timeout,
    );
    if (ack is Map) {
      final Object? error = ack['error'];
      ok = error == null || (error is String && error.isEmpty);
    }
  } on Object {
    ok = false;
  }
  if (!ok) {
    final bool invalid =
        (ack is Map && ack['error'] == 'AUTH_TOKEN_INVALID') ||
        (transport.currentStatus == SocketStatus.error &&
            (transport.lastConnectError?.contains('AUTH_TOKEN_INVALID') ??
                false));
    if (invalid) await tokenStorage.removeByToken(token);
    // Card L7 — the ack's own `error`, verbatim. A throw / timeout leaves `ack`
    // non-Map ⇒ null: 「我们没问到」("we didn't get an answer") and 「服务器说了 X」
    // ("the server said X") must not read alike.
    final String? rawError = (ack is Map && ack['error'] is String)
        ? ack['error'] as String
        : null;
    // 🔴 Q2 (2026-08-12) — the enumerated restriction reason rides along with
    // its code, read the same way and with the same rule: only what the ack
    // actually said. Without this the server's `reason` is read off the wire and
    // dropped one frame later, and the user is told 「此账号已被限制使用」("this
    // account has been restricted from use") with the
    // 「为什么」("why") the Terms promise them sitting in a variable nobody
    // passes on.
    final String? error =
        encodeRestrictionReason(rawError, restrictionReasonOfAck(ack));
    // 🔴 L-② — the budget, read the same way and with the same rule: only what
    // the ack actually said. `image_upload.dart:300` parses this identical field
    // identically; the two must stay one reading of one wire name.
    final int? retryAfterMs =
        (ack is Map && ack['retry_after_ms'] is num) ? (ack['retry_after_ms'] as num).round() : null;
    onRejected(invalid || surfaceTransientFailure, invalid, error, retryAfterMs);
    return false;
  }
  if (ack is Map) await tokenStorage.enrichByToken(token, ack);
  onAccepted(ack);
  return true;
}
