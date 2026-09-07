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
  //
  // 🔴 2026-08-27 owner ruling (docs/decisions/2026-08-27-owner-no-password-
  // login-on-clients.md): the clients carry NO username/password login at all.
  // `emailHint`, `passwordHint`, `forgotPassword` and `loginButton` are GONE
  // with the form that produced them — `forgotPassword` was the worst of the
  // four, a line of static text with no tap handler that had been promising a
  // recovery flow this app never had. A user-visible string outliving its only
  // producer is how this repo grows sentences nobody can reach (the
  // INJECT_NO_RECEIPT precedent), so they left in the same commit.
  String get loginTitle => _lfLoginTitle;
  String get tabLogin => _lfTabLogin;
  String get connecting => _lfConnecting;

  // ── browser sign-in (card NR-2b) ────────────────────────────────────────
  /// The first of the sheet's two entries: hand the whole account business —
  /// signing in, registering, Google, password recovery — to the browser, and
  /// take a one-time code back through the deep link.
  String get browserLoginTitle => _lfBrowserLoginTitle;

  /// The explainer under it. This is ALSO where the old 「accounts are created
  /// on the website」 footer went: registration now happens inside this very
  /// flow, so a separate footer pointing at the same page would be a second
  /// answer to a question this sentence already answers.
  String get browserLoginHint => _lfBrowserLoginHint;

  /// Shown while the browser has the flow. It says what the user should do
  /// next, because nothing on this screen can happen without them.
  String get browserLoginWaiting => _lfBrowserLoginWaiting;

  /// 🔴 THE ONE REFUSAL THIS APP CANNOT SEE, SAID BEFORE IT HAPPENS.
  ///
  /// owner 2026-08-27 UAT ①, measured on a Lenovo tablet: its STOCK browser is
  /// the phone's default, and Google's sign-in page refuses that browser
  /// outright (「this browser is not secure」). Chrome on the same tablet works.
  ///
  /// From inside this app the refusal is INVISIBLE: it happens on a page in
  /// another process, and what arrives here is silence — i.e. exactly the
  /// [BrowserLoginCodes.timedOut] a user who closed the tab produces. No code
  /// can be minted for it and none is invented (that would be a cause we do not
  /// know). What is left is to say the thing in advance, where a user who just
  /// hit it will look: in the explainer that already carries the address, so the
  /// sentence and the address the user must re-open sit together.
  ///
  /// ⚠️ NO PROGRAMMATIC「open in Chrome」 GOES WITH IT (owner: a note only).
  /// Picking a browser for the user is a choice this app has no basis to make,
  /// and a launch aimed at a package that may not be installed would add a
  /// second failure to a screen that is already explaining one.
  String get browserLoginBrowserRefused => _lfBrowserLoginBrowserRefused;

  /// Back out of the wait. Not a failure — see BrowserLoginController.cancel.
  String get browserLoginCancel => _lfBrowserLoginCancel;
  String get browserLoginRetry => _lfBrowserLoginRetry;
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
  //
  // 🔴 2026-08-27 (NR-2b): `registerOnWebsite` — the sentence that footer led
  // with — is GONE, folded into [browserLoginHint], because the browser flow IS
  // the registration route now and two sentences pointing at one page is two
  // answers to one question. The two below did NOT go with it: the address is
  // still shown and still copyable, which is the route left when this phone
  // cannot open a browser at all (BROWSER_LOGIN_OPEN_FAILED).
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

  /// What went wrong with the ROUND TRIP THROUGH THE BROWSER — codes from
  /// [BrowserLoginCodes], never from the account server. The two are separate
  /// surfaces on purpose: 「the browser never came back」 and 「the server
  /// rejected the code」 are different problems with opposite next actions, and
  /// one field answering both is this repo's number-one defect shape.
  ///
  /// 🔴 AN UNKNOWN CODE GETS THE BARE IDENTIFIER, NOT AN INVENTED SENTENCE.
  /// That is the 0.2.53 rule, and it is the only default that cannot lie:
  /// making one up would state a cause we do not know. `browser_login_test.dart`
  /// asserts every member of [BrowserLoginCodes.all] maps to a real sentence in
  /// every language, so the bare identifier can only ever appear for a code
  /// that was added without its copy — and that test goes red the moment one is.
  String browserLoginError(String? code) {
    switch (code) {
      case 'BROWSER_LOGIN_OPEN_FAILED':
        return _lfBrowserLoginError__1;
      case 'BROWSER_LOGIN_TIMED_OUT':
        return _lfBrowserLoginError__2;
      case 'BROWSER_LOGIN_NO_REQUEST':
        return _lfBrowserLoginError__3;
      case 'BROWSER_LOGIN_STATE_MISMATCH':
        return _lfBrowserLoginError__4;
      case 'BROWSER_LOGIN_EXPIRED':
        return _lfBrowserLoginError__5;
      case 'BROWSER_LOGIN_NO_CODE':
        return _lfBrowserLoginError__6;
      case 'BROWSER_LOGIN_ENDPOINT_MISMATCH':
        return _lfBrowserLoginError__7;
      default:
        return code ?? '';
    }
  }

  /// The second half of the logout truth (LogoutNoticeCodes, owner ruling
  /// A5-4). NOT an error message: every branch already signed the user out on
  /// this device, and no branch may say the cloud session was revoked — nothing
  /// revokes it, and — since owner ruling 2026-08-27 §R1 made the server default
  /// TTL 100 years — it no longer expires on its own in any useful sense either
  /// (auth/jwt.ts DEFAULT_TTL_MS). That is why [_lfLogoutNotice__2] was
  /// rewritten: it used to promise the session would lapse「within 7 days」, and
  /// that promise now has nothing behind it. An unknown code degrades to the WEAKEST claim
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
  ///
  /// 🔴 `max` JOINED THE LADDER ON 2026-08-27 AND HAD NO SENTENCE HERE. Until
  /// then this switch answered 「free」and「pro」 and let everything else through
  /// as the raw wire value, so an account on the top tier wore a pill reading
  /// the bare identifier `max` next to two properly translated neighbours —
  /// the 0.2.53 shape (an identifier reaching the screen because a table was
  /// not updated with the code that produced the new value), in its cheapest
  /// form. `PLAN_LADDER` in `apps/server-core/src/billing/plans.ts` is the list
  /// this switch owes an arm to; there are three names on it and there are now
  /// three arms.
  ///
  /// ⚠️ THE DEFAULT STAYS 「show it verbatim」 and must. An invented sentence
  /// for a tier we do not know would state a product fact we do not have.
  String planLabel(String plan) {
    switch (plan) {
      case 'free':
        return _lfPlanLabel_free;
      case 'pro':
        return _lfPlanLabel_pro;
      case 'max':
        return _lfPlanLabel_max;
      case '':
        return '';
      default:
        return plan;
    }
  }

  // ── the two-way quota gauge (owner 2026-08-27) ───────────────────────────
  //
  // 🔴 TWO LEAVES, AND THERE IS DELIBERATELY NO 「UNLIMITED」 THIRD. The ruling's
  // own wording asks for one (「`limit` 为 null（豁免/∞）⇒ 该侧文字「不限」」), and
  // its parenthesis names the premise the server retired on 2026-08-07: ∞ no
  // longer crosses the wire as `null`, an exempt account gets the MAX tier's
  // finite ceiling, and a `null` can now ONLY mean 「we failed to compute it」
  // (`billing/billing-service.ts`, QuotaView, verbatim). A sentence saying
  // 「unlimited」 under a live gate that is in fact enforcing a number is the R11
  // red line ⇒ that end of the gauge is absent instead, and there is no string
  // for it to render. The desktop card made the same call on the same day; if
  // an unbounded meter ever returns it needs a POSITIVE signal on the wire, and
  // a new leaf then.
  //
  // ⚠️ THE NUMBERS ARRIVE PRE-FORMATTED (ui/quota_gauge.dart), never as raw
  // doubles: 「≤1 decimal」 and 「tokens are counted in millions」 are product
  // rules, and a rule spelled out in nine translations is a rule with nine
  // chances to drift.

  /// Left half: speech minutes spent against the month's allowance.
  String quotaVoiceUsed(Object? used, Object? limit) =>
      _lfQuotaVoiceUsed(used, limit);

  /// Right half: context tokens, in millions, against the month's allowance.
  String quotaContextUsed(Object? used, Object? limit) =>
      _lfQuotaContextUsed(used, limit);

  // ── when the allowance starts over (owner 2026-09-07) ────────────────────
  //
  // 🔴 A GAUGE WITHOUT THIS LINE ANSWERS HALF A QUESTION. 「17 / 20 min」 tells
  // somebody they are nearly out and says nothing about whether that matters
  // for another hour or another month. The cycle stopped being the calendar
  // month on 2026-09-05 (owner's option 乙 — it is anchored to the account's own
  // anniversary), so the user cannot derive it either: two accounts looking at
  // the same screen on the same day reset on different dates.
  //
  // 🔴 THE SWITCH IS LANGUAGE-INDEPENDENT AND ONLY ITS LEAVES ARE TRANSLATED —
  // the shape `lastConnectedAt` above already uses, for the same reason. What
  // varies by language is the sentence, not 「is it today, tomorrow, or N days
  // out」.
  //
  // ⚠️ THE COUNT IS A DIFFERENCE OF LOCAL CALENDAR DAYS, NOT OF ELAPSED HOURS.
  // A reset 20 hours away can be either 「today」 or 「tomorrow」 depending on
  // which side of local midnight it falls, and the user reads a calendar, not a
  // stopwatch. Rounding the duration instead would put 「in 1 day」 on a reset
  // that happens this evening.
  //
  // ⚠️ NO PLURAL AGREEMENT IS ASKED OF ANY TRANSLATION. `n == 1` never reaches
  // the counted leaf — it has its own — so no language needs a second form for
  // it, and Russian's few/many split is avoided the way this catalogue already
  // avoids it elsewhere (`мин`, `ч`): an invariant unit.

  /// The line under the gauge, or `null` when there is nothing true to put
  /// there.
  ///
  /// 🔴 TWO REASONS FOR `null`, AND BOTH MUST STAY SILENT. The server did not
  /// send the field (an older relay), or the boundary it sent has already
  /// passed — which means the summary on screen is stale, and a stale boundary
  /// printed as a future one would be a confident lie about an account's
  /// allowance. A dash or 「unknown」 is refused for the reason the rest of this
  /// card refuses them: an answer we do not have gets no row.
  String? quotaResetsAt(DateTime resetsAt, {DateTime? now}) {
    final DateTime t = resetsAt.toLocal();
    final DateTime ref = (now ?? DateTime.now()).toLocal();
    // 🔴 The two local days are compared as UTC midnights, and that is not a
    // contradiction: they are already the LOCAL calendar days (`t`/`ref` are
    // local), re-pinned to a clock with no daylight-saving jumps. Subtracting
    // two LOCAL midnights across a DST change gives 23 or 25 hours, and
    // `inDays` truncates that into an off-by-one on the two weekends a year
    // when a European or American user would notice most.
    final int days = DateTime.utc(t.year, t.month, t.day)
        .difference(DateTime.utc(ref.year, ref.month, ref.day))
        .inDays;
    if (days < 0) return null;
    final String relative = days == 0
        ? _lfQuotaResetsAt__1
        : days == 1
        ? _lfQuotaResetsAt__2
        : _lfQuotaResetsAt__3(days);
    final String hhmm =
        '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    // No year variant, unlike `lastConnectedAt`: a monthly cycle ends at most
    // about five weeks out, so a bare month and day cannot be ambiguous here.
    return _lfQuotaResetsAt__4(t.month, t.day, hhmm, relative);
  }

}
