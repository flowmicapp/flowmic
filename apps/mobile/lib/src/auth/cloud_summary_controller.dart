// SPEC-REF:
//   docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md
//   apps/mobile/lib/src/auth/cloud_summary.dart (the wire half)
//   CLAUDE.md red line: no silent failure / a DI default must not be a friendly
//     empty implementation (13 册 §7 F1 ②)
//
// The STATE half of the quota read-out: when to ask, and what to keep.
//
// ── 🔴 TWO TRIGGERS, AND THEY ANSWER TWO DIFFERENT QUESTIONS ─────────────────
//
//   · [refresh] — 「the card the gauge lives on just became visible」. Called
//     from the widget's initState (ui/quota_gauge.dart), i.e. once per opening
//     of the settings page, never per rebuild;
//   · the [LoginController] subscription — 「this phone just became signed in」.
//     Without it, a user who signs in FROM the settings page would sit in front
//     of a card that has an account, a tier and no gauge until they navigated
//     away and back. The transition is watched here rather than being wired
//     into the sign-in flow because sign-in has three entrances (browser, QR,
//     and a rehydrate on launch) and one watcher covers all three — the same
//     reason `PttSession.roomJoins` exists rather than a drain call at each
//     site (0.2.52 F-1).
//
// ── 🔴 WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
//
// No timer, no poll, no retry ladder. A quota number is not a live signal: it
// moves when the user speaks, and the next opening of this page is soon enough.
// A retry ladder would also be the wrong shape for the dominant miss on this
// path — an old server (404) and a rejected bearer (401) both answer instantly
// and identically forever.
//
// ── 🔴 THE CACHE IS WHAT THE 「NO FLICKER」 REQUIREMENT BUYS ─────────────────
//
// A refresh that fails leaves the LAST GOOD numbers on screen rather than
// blanking the gauge. Those numbers were true when they were measured and are
// never re-labelled as current — the card states no timestamp, which is the
// honest shape here: it is a monthly meter, not a clock. The cache is cleared
// on sign-OUT, because at that point they are somebody's numbers and nobody is
// signed in to own them.

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'cloud_summary.dart';
import 'login_controller.dart';
import 'saas_endpoint.dart';

class CloudSummaryController extends ChangeNotifier {
  CloudSummaryController({
    required LoginController login,
    // 🔴 NO FRIENDLY DEFAULT. Null routes to the REAL http read, exactly like
    // UpdateController's checker: a double that quietly answered「here are some
    // numbers」would make every settings test agree the gauge works while it
    // never read a byte. Tests pass `newTestCloudSummary()`'s fetcher, which
    // answers 「unreachable」 — the truth about a controller with no network.
    CloudSummaryFetcher? fetcher,
    String? saasEndpoint,
    this.timeout = kCloudSummaryTimeout,
  }) : _login = login,
       _fetch = fetcher ?? httpCloudSummaryFetch,
       _endpoint = saasEndpoint ?? resolveSaasEndpoint() {
    _wasSignedIn = _login.isLoggedIn;
    _login.addListener(_onLoginChanged);
  }

  final LoginController _login;
  final CloudSummaryFetcher _fetch;
  final String _endpoint;

  /// The budget for one read. Injectable so a test can prove the deadline is
  /// the FIELD's value and not a constant read somewhere else (the 2026-08-16
  /// `presencePollTimeout` lesson: a knob that changes nothing is worse than no
  /// knob).
  final Duration timeout;

  CloudSummary? _summary;

  /// The last summary that was BELIEVED, or null when there has never been one
  /// this session. Null is what the card renders as 「no gauge」.
  CloudSummary? get summary => _summary;

  CloudSummaryRefusal? _refusal;

  /// The last NAMED account-level refusal the summary route answered with, or
  /// null when the last read did not name one.
  ///
  /// 🔴 IT DOES NOT FOLLOW `summary`'S 「A MISS CHANGES NOTHING」 RULE, and the
  /// asymmetry is the point. Keeping stale NUMBERS on screen is the no-flicker
  /// requirement; keeping a stale REASON would be answering 「why can't I」 with
  /// something that stopped being true. So a successful read clears it, and a
  /// transient miss leaves it alone (a socket timeout is not evidence the
  /// account stopped being restricted).
  CloudSummaryRefusal? get refusal => _refusal;

  bool _inFlight = false;

  /// Is a read outstanding right now? Read by tests; the UI deliberately does
  /// NOT render a spinner for it — a gauge that is absent and a gauge that is
  /// loading look the same on purpose, because the difference is not something
  /// the user can act on.
  bool get inFlight => _inFlight;

  late bool _wasSignedIn;
  bool _disposed = false;

  /// Ask, unless we are already asking. The single in-flight guard is the whole
  /// concurrency story: a second call while one is outstanding is DROPPED, not
  /// queued — two answers to one question, one of them stale, is the shape this
  /// repo names first.
  void refresh() => unawaited(_run());

  Future<void> _run() async {
    if (_inFlight || _disposed) return;
    // Not signed in ⇒ there is nothing to ask ABOUT, and no bearer to ask with.
    // This is not a failure and writes no diagnostic line.
    if (!_login.isLoggedIn) return;
    final String? bearer = _login.jwt;
    if (bearer == null) return;

    _inFlight = true;
    CloudSummaryRead got = CloudSummaryRead.unreadable;
    try {
      got = await _fetch(cloudSummaryUri(_endpoint), bearer, timeout);
    } on Object {
      // Only an injected fetcher can get here — [httpCloudSummaryFetch]
      // resolves every throw itself and returns null. `on Object`, not
      // `on Exception`, is RV-89's shape. The outcome is identical to a miss:
      // keep whatever we had.
      got = CloudSummaryRead.unreadable;
    } finally {
      _inFlight = false;
    }
    if (_disposed) return;
    // The reason is settled BEFORE the early return below: a refusal is exactly
    // the case where there are no numbers, so folding it in after 「a miss
    // changes nothing」 would mean it never landed at all.
    final CloudSummaryRefusal? named = got.refusal;
    if (named != _refusal && (named != null || got.summary != null)) {
      _refusal = named;
      notifyListeners();
    }
    // 🔴 A MISS CHANGES NOTHING — it does not blank the gauge and it does not
    // notify. That is the 「no flicker」 requirement in one line.
    if (got.summary == null) return;
    // Signed out while the answer was in the air ⇒ throw it away. Rendering it
    // would put one account's numbers on a card that no longer has an account.
    if (!_login.isLoggedIn) return;
    _summary = got.summary;
    notifyListeners();
  }

  void _onLoginChanged() {
    final bool now = _login.isLoggedIn;
    if (now == _wasSignedIn) return;
    _wasSignedIn = now;
    if (now) {
      refresh();
      return;
    }
    // Signed out: the numbers AND the reason belonged to the account that just
    // left. A refusal outliving its account would explain a block the next
    // account is not under.
    if (_summary == null && _refusal == null) return;
    _summary = null;
    _refusal = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _login.removeListener(_onLoginChanged);
    super.dispose();
  }
}
