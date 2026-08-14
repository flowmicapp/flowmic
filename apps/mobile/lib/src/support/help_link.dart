// 卡 U7 (mobile half) —— repo-wide the app had ZERO help/FAQ/support/contact
// entry and ZERO external links (`grep -rn 'https\?://' lib/src` before this
// card turned up exactly two hits, both unrelated: `saas_endpoint.dart`'s
// `kDefaultSaasEndpoint` — the cloud API base, not a help destination — and
// `http_endpoint.dart`'s ws→http scheme rewriter, a pure string function with
// no literal address in it).
//
// Mirrors the desktop agent's `PAIR_APP_URL` pattern
// (`apps/desktop/src/lib/strings/pairing.ts`, `export const PAIR_APP_URL =
// '';`) exactly, for the same reason: ONE named constant is the single place
// a future change fills in, and while it is empty the façade guard
// (`test/help_link_facade_test.dart`) proves no half-built "Help" affordance
// renders — a link to nowhere is worse than no link (same ruling the desktop
// test states verbatim).
//
// 🔴 WHY IT IS EMPTY RIGHT NOW, NOT `https://flowmic.app/help`:
// `https://flowmic.app` itself is a real, deployed domain — confirmed live
// in code (`apps/server-core/src/config.ts`,
// `DEFAULT_CORS_ORIGIN = 'https://flowmic.app'`) and confirmed reachable by
// a real device tester on THREE paths: `/console`, `/console/changelog`,
// `/console/billing` (docs/strategy/2026-08-02-a2-real-device-sheet.md:344-
// 351,508 — [measured]). All three are the SaaS account/billing console — none of
// them is a help/FAQ/support page, and no such page has EVER been opened and
// confirmed to exist. `/help` would be a guess dressed as a fact — exactly the
// FAÇADE TRAP this card warns against (inventing an address that does not
// exist is worse than admitting there is nowhere to point yet).
//
// Filling this in later requires the SAME evidentiary bar the three verified
// paths above already cleared: open the URL in a browser on a real device and
// record that it actually rendered help content, then cite that record here
// (not "it should exist" — [measured], not [secondhand]).
const String kHelpUrl = '';
