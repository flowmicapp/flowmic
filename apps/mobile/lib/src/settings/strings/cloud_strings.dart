// AppStrings copy-catalogue shard: account · light-record / login sheet / login
// and cloud errors.
// The one external entry point is still ../app_strings.dart (AppStrings composes
// this mixin via `with`; from 0.2.67 on, the copy leaves `_lf…` are implemented
// by generated classes under l10n/ — this shard keeps only logic and
// argumentative comments).
part of '../app_strings.dart';

mixin CloudStrings on AppStringsLeaves {
  // cloudError's default branch delegates to pairError (the transport/pair
  // family); the actual implementation is provided by PairingStrings — it
  // comes after this mixin in the `with` order.
  String pairError(String? code);
  // The one translation of the term 「仅记录」 ("record only") lives in
  // ChatStrings.recordOnly (it comes after this mixin in the `with` order) —
  // here we only declare the signature (the same cross-shard pattern as
  // pairError).
  String get recordOnly;

  // ── account / cloud notes ────────────────────────────────────────────
  String get notConnected => _lfNotConnected;
  /// Live transport: SocketStatus.connected → ConnectionState.connected.
  String get connConnected => _lfConnConnected;
  /// Live transport error (SocketStatus.error). Only true faults — never idle.
  String get connError => _lfConnError;
  String get connectedLan =>
      _lfConnectedLan;
  String get disconnect => _lfDisconnect;
  String get cloudInstance =>
      _lfCloudInstance;
  // Truthful product facts only. E2EE cloud sync has no client write path yet
  // (verify/lint/timeline-e2e-prefix.mjs is still a stub; RV-33 / D11 / E5), so
  // never claim "E2EE optional" here — that would sell a capability we did not
  // ship. Cloud-instance history is local-only on the phone anyway — as of
  // 0.2.27 that is true of EVERY session, not just this one: the server stores no
  // transcripts at all and the phone emits no `history:*` (owner's architecture
  // ruling, docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md). The gate this
  // sentence used to cite (CLOUD_SESSION_NO_HISTORY, which refused server-side
  // `history:create` for a cloud session) was swallowed by that retirement.
  String get cloudInstanceSub => _lfCloudInstanceSub;
  String get signInCloud => _lfSignInCloud;
  // 「仅记录」 ("record only") is always interpolated from recordOnly — the
  // term is translated exactly once (V2-07.7).
  String get enterCloudInstance => _lfEnterCloudInstance(recordOnly);
  String get exitCloudInstance => _lfExitCloudInstance;
  String get cloudFixedNote => _lfCloudFixedNote(recordOnly);

  // ── login sheet ─────────────────────────────────────────────────────────
  String get loginTitle => _lfLoginTitle;
  String get tabLogin => _lfTabLogin;
  String get emailHint => _lfEmailHint;
  String get passwordHint => _lfPasswordHint;
  String get forgotPassword => _lfForgotPassword;
  String get loginButton => _lfLoginButton;
  String get connecting => _lfConnecting;
  // Same red line as cloudInstanceSub: drop the unshipped E2EE-sync selling
  // point. Keep the true capability (record without a PC). Do not flip to
  // "unencrypted" either — that path never writes server ciphertext at all.
  String get loginFootnote => _lfLoginFootnote;
  // 2026-08-11 owner ruling (docs/decisions/2026-08-11-owner-mobile-register-
  // removed-guide-to-website.md): account creation lives on the official
  // website only. The old `registerNotAvailable` ("注册尚未开放（私域版）" —
  // "registration not yet open (private-domain edition)")
  // was an expired truth — the website DOES accept registration now — and left
  // with its only producer, the removed register tab.
  String get registerOnWebsite => _lfRegisterOnWebsite;
  String get registerCopyLink =>
      _lfRegisterCopyLink;
  String get registerLinkCopied => _lfRegisterLinkCopied;

  // ── cloud login / account (WP-R4-2 ①⑤) ───────────────────────────────────
  /// Fail-loud, DISTINCT copy for a login outcome. Codes come from
  /// LoginController (LoginErrorCodes) — a wrong credential, a per-IP throttle,
  /// and an expired session each read differently; unknown codes surface loudly.
  String loginError(String? code) {
    switch (code) {
      case 'INVALID_EMAIL':
        return _lfLoginError__1;
      case 'EMPTY_PASSWORD':
        return _lfLoginError__2;
      case 'NOT_CONNECTED':
        return _lfLoginError__3;
      case 'LOGIN_TIMEOUT':
        return _lfLoginError__4;
      case 'AUTH_LOGIN_FAILED':
        return _lfLoginError__5;
      case 'REGISTER_RATE_LIMITED':
        return _lfLoginError__6;
      case 'AUTH_TOKEN_EXPIRED':
        return _lfLoginError__7;
      case 'AUTH_TOKEN_INVALID':
        return _lfLoginError__8;
      default:
        return _lfLoginError__9;
    }
  }

  /// The second half of the logout truth (LogoutNoticeCodes, owner ruling
  /// A5-4). NOT an error message: every branch already signed the user out on
  /// this device, and no branch may say the cloud session was revoked — nothing
  /// revokes it, the token simply expires on its own (≤7 days, server
  /// auth/jwt.ts DEFAULT_TTL_MS). An unknown code degrades to the WEAKEST claim
  /// below, which is true in every case — never to an empty string, which would
  /// be a silent failure wearing a default branch.
  String logoutNotice(String? code) {
    switch (code) {
      case 'LOGOUT_LOCAL_CLEAR_FAILED':
        return _lfLogoutNotice__1;
      default:
        return _lfLogoutNotice__2;
    }
  }

  /// Fail-loud copy for a cloud-instance admission failure. Cloud-specific codes
  /// resolve here; the transport/pair families delegate to [pairError].
  String cloudError(String? code) {
    switch (code) {
      case 'NOT_LOGGED_IN':
        return _lfCloudError_NOT_LOGGED_IN;
      case 'AUTH_TOKEN_EXPIRED':
        return _lfCloudError_AUTH_TOKEN_EXPIRED;
      case 'AUTH_TOKEN_INVALID':
        return _lfCloudError_AUTH_TOKEN_INVALID;
      case 'AUTH_LOGIN_FAILED':
        return _lfCloudError_AUTH_LOGIN_FAILED;
      case 'REGISTER_RATE_LIMITED':
        return _lfCloudError_REGISTER_RATE_LIMITED;
      // ── 0.2.27: `CLOUD_SESSION_NO_HISTORY` was handled HERE ────────────────
      //
      // Its only producer was history.handler's 「云端实例会话不写服务端历史」
      // ("a cloud-instance session does not write server-side history") gate,
      // and this window's retirement swallowed that gate: no session writes server
      // history now. A user-visible string with no producer is a protocol-face
      // façade and goes with its producer (the rule this repo wrote down for
      // INJECT_NO_RECEIPT, packages/protocol/test/error-codes.test.ts header) —
      // the coordinator removed the code from error-codes.ts in the same round.
      //
      // ⚠️ AND NOTHING WAS ADDED IN ITS PLACE, including the new
      // `HISTORY_SYNC_RETIRED`. Not an oversight — a `case` here would be
      // unreachable, which is the same façade under a newer name. The reason is
      // structural, not a guess about old servers:
      //
      //   `cloudError` has exactly ONE feeder — `ConnectOutcome.error`
      //   (connections_page.dart `_toast(s.cloudError(outcome.error))`), which is
      //   `ConnectionsController.enterCloud` → `PttSession.pair`, whose `error` is
      //   the **`mobile:pair` ack** or one of four locally minted codes
      //   (CONNECT_FAILED / PAIR_TIMEOUT / PAIR_BAD_ACK / PAIR_NO_TOKEN). No
      //   `history:*` ack reaches this function on any code path, from any server
      //   version — and as of this version the phone emits no `history:*` frame at
      //   all, so there is no such ack to route. CLOUD_SESSION_NO_HISTORY sitting
      //   here was never rendered once; that is the evidence, not the assumption.
      //
      // Where a history refusal WOULD be rendered if one ever arrived: it is not
      // here. Reported to the coordinator rather than patched, because the
      // honest fix is to give the code a reader on the path it can actually
      // arrive by.
      default:
        return pairError(code);
    }
  }

  /// A short plan-tier label for the account pill. Unknown tiers show verbatim.
  String planLabel(String plan) {
    switch (plan) {
      case 'free':
        return _lfPlanLabel_free;
      case 'pro':
        return _lfPlanLabel_pro;
      case '':
        return '';
      default:
        return plan;
    }
  }

  /// Shown when a stored JWT expires — the fail-loud re-login prompt.
  String get reloginRequired => _lfReloginRequired;
}
