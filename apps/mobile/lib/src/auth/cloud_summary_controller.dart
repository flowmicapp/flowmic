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

import '../signaling/inbound_payloads.dart' show BillingBudget;
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
    /// Card S2-02 — the relay's live `billing:budget` readings
    /// (`PttSession.billingBudget`). Present ⇒ this controller keeps itself in
    /// step with what the relay just said, instead of being a snapshot of the
    /// last time the settings page was opened.
    ///
    /// 🔴 THE SUBSCRIPTION IS OWNED HERE, not at the composition root, and that
    /// is the point of taking a stream rather than being fed from outside: the
    /// cancel then travels with [dispose] and cannot be forgotten by a caller.
    /// This controller has already paid for the other shape once — its own
    /// dispose comment records that a notifier torn down while something is
    /// still subscribed is the `_pcBusy` leak (0.2.51).
    ///
    /// Absent ⇒ no live updates, exactly the pre-card behaviour. Not a friendly
    /// default that pretends to work: an absent feed is a wiring fact a test can
    /// drive (13 册 §7 F1 ②).
    Stream<BillingBudget>? budgetFeed,
    this.timeout = kCloudSummaryTimeout,
  }) : _login = login,
       _fetch = fetcher ?? httpCloudSummaryFetch,
       _endpoint = saasEndpoint ?? resolveSaasEndpoint() {
    _wasSignedIn = _login.isLoggedIn;
    _login.addListener(_onLoginChanged);
    _budgetSub = budgetFeed?.listen(applyBudget);
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
  /// Card S2-02 - the live feed subscription, cancelled in [dispose]. Null when
  /// no feed was supplied.
  StreamSubscription<BillingBudget>? _budgetSub;

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

  /// Card S2-02 — fold a live `billing:budget` frame into the numbers already
  /// on screen. The relay pushes one at pairing, at every press, while audio is
  /// streaming and the moment the allowance runs out, so the settings gauge
  /// stops being a snapshot taken the last time this page was opened.
  ///
  /// 🔴 IT ONLY EVER MOVES `used`, AND ONLY WHEN THERE IS ALREADY A CEILING TO
  /// MOVE IT AGAINST. The frame carries what is LEFT; the gauge is drawn from
  /// `used / limit` — so with no prior summary there is no `limit`, and
  /// inventing one to make the arithmetic work would draw a bar against a
  /// number nobody read. Absent stays absent, which is `quota_gauge.dart`'s own
  /// rule for an end it could not read.
  ///
  /// 🔴 `remainingMs == null` IS NOT ZERO AND NOT A MISS. It means the relay
  /// does not meter (standalone / self-hosted), and this card is only ever shown
  /// to a signed-in cloud account — so the honest response is to change nothing
  /// rather than to blank a gauge that is about a different deployment.
  ///
  /// ⚠️ THE TOKEN METER IS UNTOUCHED, deliberately. This frame says nothing
  /// about LLM tokens, and carrying the old value forward is exactly right:
  /// re-stating a number is not the same as re-measuring it, and the two halves
  /// of this gauge have always been independently nullable for that reason.
  void applyBudget(BillingBudget budget) {
    if (_disposed) return;
    final CloudSummary? had = _summary;
    final CloudMeter? meter = had?.minutes;
    // No ceiling on screen ⇒ nothing to place this reading against. Not a
    // failure and not worth a diagnostic: the very next `refresh()` brings both
    // numbers at once.
    if (had == null || meter == null) return;
    final int? remaining = budget.remainingMs;
    if (remaining == null) return; // "this relay does not meter" — see above
    // 🔴 CARD G-2c — A READING ABOUT SOMEBODY ELSE'S LEDGER MAY NOT MOVE THIS
    // CARD. Owner 2026-09-11 (「只要有对端，就扣对端」) made the far end the payer
    // whenever one exists, so a phone paired to another account's computer is
    // sent that account's remainder — and folding it in here drew a plausible
    // number against the wrong ledger: the reader's own minutes appeared to
    // drain while their plan was untouched, and stopped the moment they
    // unpaired. That is R11 in its purest form, on the one screen whose whole
    // job is to answer 「how much have I got left」.
    //
    // 🔴 `'trial'` IS REFUSED FOR THE SAME SENTENCE, NOT AS A BONUS. A
    // `mode:'trial'` view is the site demo's per-device grant (two minutes),
    // and arithmetic against a monthly ceiling would report this account as
    // hundreds of minutes over. Same defect, different far end.
    //
    // ⚠️ `null` STILL MEANS 「the relay did not say」 AND STILL APPLIES. A build
    // that read absence as 「somebody else is paying」 would blank the meter for
    // every relay that predates the field — refusing to answer a question we
    // can answer. `'self'` is byte-for-byte the pre-card path.
    //
    // ⚠️ THE REFUSAL IS SILENT ON THIS CARD BY DESIGN, because it is not this
    // card's sentence to say. It was said by a standing chat-page banner until
    // owner removed that on 2026-09-12 (the 09-12 batch ruling, item 5); it is
    // now said by the quota-rules guide under the connections list
    // (`ui/quota_rules_page.dart`, copy in
    // `settings/strings/metering_strings.dart`), which states every case rather
    // than the one a live frame happens to name. What must never happen is this
    // meter moving on somebody else's remainder — that half is right here, and
    // it does not depend on any sentence existing anywhere.
    if (budget.payer == 'far_end' || budget.payer == 'trial') return;
    final double usedMin = meter.limit - remaining / 60000.0;
    // Clamped for the same reason `CloudMeter.used` is NOT clamped in the
    // parser: this value is DERIVED here rather than reported, so a negative
    // would be our arithmetic showing through rather than a server saying
    // something strange, and a gauge is the wrong place to display it.
    final double clamped = usedMin < 0 ? 0 : usedMin;
    // `resets_at` rides the same frame, so a cycle that rolled over between two
    // openings of this page is picked up with the number it explains — never
    // one without the other.
    final DateTime? resets = budget.resetsAt ?? had.resetsAt;
    if (clamped == meter.used && resets == had.resetsAt) return; // no repaint for no change
    _summary = CloudSummary(
      minutes: CloudMeter(used: clamped, limit: meter.limit),
      tokens: had.tokens,
      continuousMinutes: had.continuousMinutes,
      resetsAt: resets,
    );
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
    unawaited(_budgetSub?.cancel());
    _login.removeListener(_onLoginChanged);
    super.dispose();
  }
}
