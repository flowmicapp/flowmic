// Official legal pages on the public website.
//
// 2026-08-14: https://flowmic.app/privacy and /terms are live (HTTP 200).
// The in-app copy that said they were unpublished is therefore false, and
// this file is the single origin the disclosure page reads so the path
// cannot drift from the site the app already names.
//
// Derived from [kDefaultSaasEndpoint] (not [resolveSaasEndpoint]): a private
// build may point the API at a LAN relay, but the legal documents live on
// the official site. Same shape as login_sheet.dart `kRegisterWebsiteUrl`.
//
// ⚠️ No locale suffix and no `?lang=`. The site's locale lives in
// localStorage, not in the path — a query the site does not read would be a
// guess dressed as a fact. Do not claim the linked page is in the user's
// language.
//
// 🔴 In-place correction (2026-08-19): this paragraph used to open with 「the
// site is a four-language SPA」, and that stopped being true on 2026-08-14 when
// the nine-locale catalogue became a pre-publication requirement. Measured
// today in the web repo: `src/i18n/site-locales.ts` has `NOT_SHIPPED = []`,
// i.e. the site ships every language the registry lists. The original sentence
// is kept above in substance — the ADVICE (do not append a locale) is
// unchanged and was never about how many languages exist — but the count is
// gone, because a number in a comment outlives the thing it counted. It was
// found by a reader who took it at face value and concluded the marketing URL
// would strand non-English visitors.
import '../auth/saas_endpoint.dart' show kDefaultSaasEndpoint;

const String kPrivacyPolicyUrl = '$kDefaultSaasEndpoint/privacy';
const String kTermsOfServiceUrl = '$kDefaultSaasEndpoint/terms';

/// The account page on the official site: where the signed-in user exports
/// their data or deletes the account (`GET /api/account/export`,
/// `POST /api/account/delete` behind it).
///
/// 🔴 ST-2 (2026-08-19) — WHY THE APP LINKS TO IT AT ALL. Both stores expect an
/// account-deletion path that can be found from inside the app, and this app
/// deliberately has no sign-up of its own (owner 2026-08-11: registration lives
/// on the website). A link is the honest shape of that: it does not duplicate a
/// destructive flow into a second place, and it does not pretend the app owns
/// something it does not.
///
/// ⚠️ Deleting is NOT done in the app, and the copy beside this link says so.
/// The repo's rule about destructive actions having exactly one landing point
/// (the sign-out ruling, `cloud_signout_row.dart`) is the same rule here.
const String kAccountPageUrl = '$kDefaultSaasEndpoint/console/account';
