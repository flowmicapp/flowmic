// Test doubles for the settings cloud card's quota gauge (owner 2026-08-27).
//
// 🔴 THE DEFAULT DOUBLE ANSWERS 「COULD NOT ASK」, NOT 「HERE ARE SOME NUMBERS」.
// This is the same rule `update_fakes.dart` states for the update checker
// (13 册 §7 F1 ②): every settings-page test constructs one of these, and a
// double that quietly produced a plausible summary would make the whole suite
// agree that the gauge works — including on the day it stopped being wired to
// anything. A null answer is the truth about a controller with no network, and
// it renders as the product's real degrade: no gauge.
//
// ⚠️ It also keeps a settings-page test off the network: [CloudSummaryController]'s
// production default IS a real HTTP call, by design.

import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/auth/cloud_summary_controller.dart';
import 'package:flowmic/src/auth/login_controller.dart';

/// A controller wired to a fake fetcher.
///
/// [fetcher] defaults to 「unreachable」 — see the header. A test that is ABOUT
/// the gauge passes its own, and a test that only needs the settings page to
/// BUILD passes nothing.
CloudSummaryController newTestCloudSummary({
  required LoginController login,
  CloudSummaryFetcher? fetcher,
  String saasEndpoint = 'http://127.0.0.1:1',
  Duration timeout = const Duration(milliseconds: 50),
}) => CloudSummaryController(
  login: login,
  saasEndpoint: saasEndpoint,
  timeout: timeout,
  fetcher:
      fetcher ??
      ((Uri url, String bearer, Duration budget) async =>
          CloudSummaryRead.unreadable),
);

/// A fetcher that answers one fixed summary. Named rather than written inline
/// at each call site so a test reads 「this one succeeds」 at a glance.
CloudSummaryFetcher fixedCloudSummary(CloudSummary summary) =>
    (Uri url, String bearer, Duration budget) async =>
        CloudSummaryRead(summary: summary);

/// A fetcher that answers a NAMED account refusal and no numbers — the shape
/// `403 EMAIL_NOT_VERIFIED` produces. Named so a test reads 「the account is
/// barred, and we know why」 rather than 「something went wrong」, which is the
/// distinction this whole channel exists to keep.
CloudSummaryFetcher refusedCloudSummary(CloudSummaryRefusal refusal) =>
    (Uri url, String bearer, Duration budget) async =>
        CloudSummaryRead(refusal: refusal);

/// A summary with plain numbers, for the tests that only care about the shape.
///
/// ⚠️ Both ends readable. A test that wants the 「that end could not be read」
/// shape passes `null` for a side explicitly — that state is a MISSING side,
/// not an 「unlimited」 one (see [CloudMeter]).
CloudSummary testSummary({
  double usedMin = 12,
  double limitMin = 900,
  double usedTokens = 1000000,
  double limitTokens = 5000000,
  bool noMinutes = false,
  bool noTokens = false,
  /// Card CR-9 — the per-sitting ceiling. Defaults to a REAL tier's number
  /// rather than null, because null is the 「we could not read it」 state and a
  /// helper whose default sits in a failure state makes every caller that only
  /// wanted a working account opt out of one.
  ///
  /// ⚠️ Pass null explicitly for the case that matters: no ceiling ⇒ a
  /// continuous recording may not start (`CloudSummary.continuousMinutes`).
  int? continuousMinutes = 30,
}) => CloudSummary(
  minutes: noMinutes ? null : CloudMeter(used: usedMin, limit: limitMin),
  tokens: noTokens ? null : CloudMeter(used: usedTokens, limit: limitTokens),
  continuousMinutes: continuousMinutes,
);
