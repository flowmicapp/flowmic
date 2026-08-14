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
// ⚠️ No locale suffix and no `?lang=`. The site is a four-language SPA
// whose locale lives in localStorage, not in the path — a query the site
// does not read would be a guess dressed as a fact. Do not claim the
// linked page is in the user's language.
import '../auth/saas_endpoint.dart' show kDefaultSaasEndpoint;

const String kPrivacyPolicyUrl = '$kDefaultSaasEndpoint/privacy';
const String kTermsOfServiceUrl = '$kDefaultSaasEndpoint/terms';
