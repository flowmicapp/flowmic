// SPEC-REF:
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-2 ① (real mobile:login ack:
//     persist JWT + public user in flutter_secure_storage, password NEVER
//     stored; account area shows email/plan; logout clears state; auth:expired /
//     AUTH_TOKEN_EXPIRED / AUTH_TOKEN_INVALID → clear JWT + fail-loud re-login;
//     REGISTER_RATE_LIMITED → distinct honest copy)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md frozen wire contract (login SUCCESS =
//     {ok:true, token:<JWT>, user:{id,email,display_name,plan}, mode:'saas'};
//     FAILURE = {error:'AUTH_LOGIN_FAILED'} | {error:'REGISTER_RATE_LIMITED',
//     retryable:true}; standalone = {ok:true, mode:'standalone'} no token)
//   packages/protocol/src/protocol-schemas-auth.ts (MobileLoginSchema =
//     {email,password}; MobileLogoutSchema = {})
//   CLAUDE.md red line: no silent failures; the password never lands in phone
//     storage (only the JWT is stored)
//
// SaaS login/logout over the socket, now a REAL admission (WP-R4-1 server is
// live and its wire is frozen). login() dials the SaaS endpoint (unauthenticated
// handshake), emits mobile:login and AWAITS the ack; ONLY an explicit ok ack
// enters success — there is no optimistic/faked path. On a saas success the JWT
// + PUBLIC user (id/email/display_name/plan) are persisted to the secure account
// store; the PASSWORD is a transient emit argument, never stored or logged. The
// error surface is a stable CODE (mapped to bilingual copy by AppStrings), so a
// wrong credential, a per-IP throttle, and an expired token each read distinctly.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../generated/flowmic_events.g.dart';
import '../signaling/socket_core.dart';
import 'account_store.dart';
import 'saas_endpoint.dart';

enum LoginPhase { idle, submitting, error, success }

/// Stable fail-loud codes surfaced to the UI (localized by AppStrings.loginError
/// so the copy follows the EXPLICIT app locale, never the OS locale).
class LoginErrorCodes {
  LoginErrorCodes._();
  static const String invalidEmail = 'INVALID_EMAIL';
  static const String emptyPassword = 'EMPTY_PASSWORD';
  static const String notConnected = 'NOT_CONNECTED';
  static const String timeout = 'LOGIN_TIMEOUT';
  static const String authLoginFailed = 'AUTH_LOGIN_FAILED';
  static const String rateLimited = 'REGISTER_RATE_LIMITED';
  static const String tokenExpired = 'AUTH_TOKEN_EXPIRED';
  static const String tokenInvalid = 'AUTH_TOKEN_INVALID';
  static const String failed = 'LOGIN_FAILED';
}

/// The second half of the logout truth (owner ruling A5-4 / E4). These are NOT
/// errors — the user IS signed out on this device in every branch, and no
/// branch may claim the cloud session was revoked (nothing revokes it: the JWT
/// is stateless and lives until its exp, at most 7 days; real revocation is
/// W4-4). They only say WHICH honest sentence to add. Localized copy:
/// AppStrings.logoutNotice.
class LogoutNoticeCodes {
  LogoutNoticeCodes._();

  /// Local state is cleared, but no account server confirmed it heard us — the
  /// link was down, the ack timed out, or the ack came from a standalone box
  /// that has no account authority at all.
  static const String serverUnconfirmed = 'LOGOUT_SERVER_UNCONFIRMED';

  /// The secure store REFUSED to delete the credential. The screen says signed
  /// out, the disk may disagree — the one branch the user must act on.
  static const String localClearFailed = 'LOGOUT_LOCAL_CLEAR_FAILED';
}

class LoginController extends ChangeNotifier {
  LoginController({
    required SocketTransport transport,
    // RV-20 / Book 13 §7 F1 ②: required — no InMemoryAccountStore default.
    // Forgetting SecureAccountStore would otherwise still construct, log in,
    // and lose the JWT on every relaunch. Compile-time required bites a
    // forgotten arg earlier than a runtime throw. Production:
    // SecureAccountStore(); tests: newTestLogin() / InMemoryAccountStore().
    required AccountStore accountStore,
    String? saasEndpoint,
  }) : _transport = transport,
       _accountStore = accountStore,
       _saasEndpoint = saasEndpoint ?? resolveSaasEndpoint();

  final SocketTransport _transport;
  final AccountStore _accountStore;
  final String _saasEndpoint;

  LoginPhase _phase = LoginPhase.idle;
  LoginPhase get phase => _phase;

  String? _errorCode;
  /// The stable fail-loud code (see [LoginErrorCodes]); null unless [phase] is
  /// error. The UI maps it to bilingual copy via AppStrings.loginError.
  String? get errorCode => _errorCode;

  String? _logoutNotice;
  /// What the LAST logout could honestly claim beyond「this device is signed out」, or null when
  /// there is nothing left to add (see [LogoutNoticeCodes]). Deliberately NOT
  /// folded into [errorCode]: a logout that the server never heard is not a
  /// failed logout — the local half really happened — so it must not put the
  /// controller into an error phase or offer a retry that would re-clear an
  /// already-empty store.
  String? get logoutNotice => _logoutNotice;

  CloudAccount? _account;

  /// The logged-in account email (null when logged out).
  String? get email => _account?.email;

  /// The account plan tier (empty when unknown / logged out).
  String get plan => _account?.plan ?? '';

  /// The SaaS bearer for a cloud-instance admission (null when logged out or on
  /// a tokenless standalone success — an empty jwt is normalized to null so a
  /// standalone session never presents a bogus '' bearer to cloud admission).
  String? get jwt {
    final String? j = _account?.jwt;
    return (j != null && j.isNotEmpty) ? j : null;
  }

  bool get isLoggedIn => _account != null && (_account!.jwt.isNotEmpty);
  bool get isBusy => _phase == LoginPhase.submitting;

  /// Rehydrate the logged-in resting state from secure storage on boot so the
  /// account area shows email/plan across launches (the JWT persists; the
  /// password never did).
  Future<void> hydrate() async {
    final CloudAccount? stored = await _accountStore.read();
    if (stored == null) return;
    _account = stored;
    _phase = LoginPhase.success;
    _errorCode = null;
    // Signed in again (across a relaunch) ⇒ the last sign-out has nothing left
    // to say. Note this is also the branch that would fire after a REFUSED
    // delete — the credential really did survive, and the resting state now
    // shows it honestly instead of a stale「signed out」.
    _logoutNotice = null;
    notifyListeners();
  }

  /// Attempt a login. Validates locally first (a bad email never leaves the
  /// device), then dials the SaaS endpoint and emits mobile:login, AWAITING the
  /// ack. Only an explicit ok ack enters success; every other outcome — error
  /// envelope, ack timeout, no connection — is surfaced loudly and distinctly.
  Future<void> login({required String email, required String password}) async {
    if (_phase == LoginPhase.submitting) return;
    final String trimmed = email.trim();
    if (!_looksLikeEmail(trimmed)) {
      _fail(LoginErrorCodes.invalidEmail);
      return;
    }
    if (password.isEmpty) {
      _fail(LoginErrorCodes.emptyPassword);
      return;
    }

    _phase = LoginPhase.submitting;
    _errorCode = null;
    // A new sign-in attempt retires whatever the PREVIOUS sign-out could claim.
    _logoutNotice = null;
    notifyListeners();

    try {
      // Unauthenticated handshake — we do not have a JWT yet; the credentials
      // are exchanged for one over mobile:login.
      await _transport.connect(url: _saasEndpoint);
    } on Object {
      _fail(LoginErrorCodes.notConnected);
      return;
    }

    try {
      final Object? ack = await _transport.emitWithAck<Object?>(
        FlowMicEvents.mobileLogin,
        <String, Object?>{'email': trimmed, 'password': password},
        timeout: const Duration(seconds: 8),
      );
      await _interpretAck(ack, trimmed);
    } on TimeoutException {
      _fail(LoginErrorCodes.timeout);
    } on StateError {
      _fail(LoginErrorCodes.notConnected);
    } on Object {
      _fail(LoginErrorCodes.failed);
    } finally {
      // Login is a stateless credential exchange; the persistent session is
      // established later by cloud admission (mobile:pair over a fresh
      // jwt-handshake socket). Drop the login socket so it never lingers.
      await _safeDisconnect();
    }
  }

  /// GA-31 QR-code sign-in — redeem a nonce scanned off the web console's QR.
  ///
  /// Deliberately the SAME wire event and the SAME ack interpretation as a typed
  /// password: `mobile:login` takes a union (04 §3.1), so success lands in the
  /// identical account-store write and every failure keeps its existing code. The
  /// nonce is a one-time credential — it is emitted and forgotten, never stored,
  /// exactly like the password it replaces.
  ///
  /// [endpoint] comes from the QR when the console is self-hosted; absent, the
  /// app's configured SaaS endpoint is used.
  Future<void> loginWithQr({required String nonce, String? endpoint}) async {
    if (_phase == LoginPhase.submitting) return;
    final String code = nonce.trim();
    if (code.isEmpty) {
      _fail(LoginErrorCodes.authLoginFailed);
      return;
    }
    _phase = LoginPhase.submitting;
    _errorCode = null;
    _logoutNotice = null;
    notifyListeners();

    final String url = (endpoint ?? '').trim().isEmpty ? _saasEndpoint : endpoint!.trim();
    try {
      await _transport.connect(url: url);
    } on Object {
      _fail(LoginErrorCodes.notConnected);
      return;
    }

    try {
      final Object? ack = await _transport.emitWithAck<Object?>(
        FlowMicEvents.mobileLogin,
        <String, Object?>{'qr_nonce': code},
        timeout: const Duration(seconds: 8),
      );
      // The email is not known to us here; the ack's own `user.email` is what the
      // account store keeps (fromLoginAck prefers the server's value).
      await _interpretAck(ack, '');
    } on TimeoutException {
      _fail(LoginErrorCodes.timeout);
    } on StateError {
      _fail(LoginErrorCodes.notConnected);
    } on Object {
      _fail(LoginErrorCodes.failed);
    } finally {
      await _safeDisconnect();
    }
  }

  Future<void> _interpretAck(Object? ack, String email) async {
    if (ack is Map && ack['ok'] == true) {
      final Object? token = ack['token'];
      if (token is String && token.isNotEmpty) {
        // saas success: persist JWT + PUBLIC user (never the password).
        final CloudAccount account = CloudAccount.fromLoginAck(
          jwt: token,
          typedEmail: email,
          user: ack['user'],
        );
        await _accountStore.write(account);
        _account = account;
      } else {
        // standalone success ({ok:true, mode:'standalone'} — no token): logged
        // in for display, but no JWT to persist and no cloud instance to enter.
        _account = CloudAccount(jwt: '', email: email);
      }
      _phase = LoginPhase.success;
      _errorCode = null;
      notifyListeners();
      return;
    }
    // Frozen wire: failure is a TOP-LEVEL string error code, e.g.
    // {error:'AUTH_LOGIN_FAILED'} / {error:'REGISTER_RATE_LIMITED'}.
    final Object? err = (ack is Map) ? ack['error'] : null;
    _fail(err is String && err.isNotEmpty ? err : LoginErrorCodes.failed);
  }

  /// Sign out. TWO SEPARATE TRUTHS, in this order, never traded against each
  /// other:
  ///  1. THIS DEVICE is signed out — first, and independent of any network.
  ///     The user pressed the button; an unreachable or slow server must never
  ///     be able to keep the credential on this phone.
  ///  2. WHETHER A SERVER HEARD IT — asked for explicitly and reported when the
  ///     answer does not arrive. This used to be a bare fire-and-forget emit
  ///     whose failure was swallowed, so「signed out」could not answer「how do
  ///     we know the other side received it」at all.
  ///
  /// What NEITHER half claims: that the cloud session was revoked. It is not —
  /// the JWT is stateless and stays valid until its own exp (≤7 days, server
  /// auth/jwt.ts DEFAULT_TTL_MS); a jti denylist is W4-4, deferred by owner
  /// ruling A5-4 pending the H5 security assessment. The copy says exactly that
  /// and nothing more.
  Future<void> logout() async {
    // ── 1. local, unconditional, and BEFORE any await ──────────────────────
    // In-memory first so nothing — not a wedged secure store, not a dead
    // socket — can leave the session alive behind a pending future. `jwt` (the
    // bearer cloud admission would present) is null from this line on.
    _account = null;
    _phase = LoginPhase.idle;
    _errorCode = null;
    _logoutNotice = null;
    notifyListeners();

    // ── 2. the credential on disk, then report a refusal ───────────────────
    final bool cleared = await _accountStore.clear();
    if (!cleared) {
      // Outranks an unheard server below: this is the only branch where the
      // phone itself may still hold the credential, i.e. the only one the user
      // has to act on.
      _logoutNotice = LogoutNoticeCodes.localClearFailed;
      _notifyIfAlive();
    }

    // ── 3. tell the server, then say whether it answered ───────────────────
    final bool confirmed = await _tellServerWeSignedOut();
    if (!confirmed && _logoutNotice == null) {
      _logoutNotice = LogoutNoticeCodes.serverUnconfirmed;
      _notifyIfAlive();
    }
  }

  /// Emit mobile:logout and AWAIT the ack. True only when an ACCOUNT server
  /// answered ok: a standalone LAN box acks the same event ({ok:true,
  /// mode:'standalone'}) while holding no account identity whatsoever, and
  /// reading its ok as「the cloud already knows」is precisely the「one value
  /// answering two questions」shape
  /// this repo keeps getting bitten by.
  Future<bool> _tellServerWeSignedOut() async {
    try {
      final Object? ack = await _transport.emitWithAck<Object?>(
        FlowMicEvents.mobileLogout,
        <String, Object?>{},
        timeout: const Duration(seconds: 5),
      );
      return ack is Map && ack['ok'] == true && ack['mode'] == 'saas';
    } on Object {
      // No socket at all, ack timeout, transport error — one answer for all of
      // them: we do not KNOW that anyone heard, so we must not say they did.
      return false;
    }
  }

  /// Auth authority is gone (auth:expired watchdog, or an AUTH_TOKEN_EXPIRED /
  /// AUTH_TOKEN_INVALID ack from a cloud op): clear the stored JWT and surface a
  /// fail-loud re-login prompt. NEVER a silent retry (red line).
  void handleAuthExpired({String code = LoginErrorCodes.tokenExpired}) {
    unawaited(
      _accountStore.clear().then((bool cleared) {
        // Same second-half truth as logout(): a refused delete leaves a dead
        // JWT on disk that hydrate() would resurrect into a signed-in-looking
        // session on the next launch. Never swallowed.
        if (cleared) return;
        _logoutNotice = LogoutNoticeCodes.localClearFailed;
        _notifyIfAlive();
      }),
    );
    _account = null;
    _phase = LoginPhase.error;
    _errorCode = code;
    notifyListeners();
  }

  /// Clear a fail-loud error when the user edits a field / reopens the sheet.
  void clearError() {
    if (_phase != LoginPhase.error) return;
    _phase = _account != null ? LoginPhase.success : LoginPhase.idle;
    _errorCode = null;
    notifyListeners();
  }

  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  /// notifyListeners for the LATE half of logout: that half lands up to 5 s
  /// after the tap, so the app may already be tearing down (notifying a
  /// disposed ChangeNotifier asserts in debug). Dropping the repaint costs
  /// nothing — the notice is a fact stored on the controller, and nothing was
  /// misreported in the meantime.
  void _notifyIfAlive() {
    if (_disposed) return;
    notifyListeners();
  }

  Future<void> _safeDisconnect() async {
    try {
      await _transport.disconnect();
    } on Object {
      /* no-op */
    }
  }

  void _fail(String code) {
    _phase = LoginPhase.error;
    _errorCode = code;
    notifyListeners();
  }

  static bool _looksLikeEmail(String s) =>
      RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(s);
}
