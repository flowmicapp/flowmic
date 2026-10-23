// NR-297 (2026-10-20) — does a STORE artifact still carry the in-app link to the
// web billing page?
//
// ── the question, and why it is read from bytes ─────────────────────────────
//
// The phone's quota-rules guide has a card that opens the web billing page
// (prices + checkout). Google Play's Payments policy and App Store 3.1.1/3.1.3
// forbid a store-distributed app from steering its user there 【secondhand: the
// 2026-10-20 read-only store-payment audit, not a re-read of the policy text】.
// The store builds turn the card off with a build-time define
// (`--dart-define=FLOWMIC_STORE_CHANNEL=1`, apps/mobile/lib/src/support/
// store_channel_flag.dart), whose default is 「not a store build」 — so a store
// build that forgets the define still carries the link. This file is the reason
// that is not silent: the store gates read the compiled Dart payload and refuse
// it while the billing path is in there. Same shape as UP-7
// (`apk-self-update-marker.mjs`): 「the build went through our script」 and 「the
// bytes do not contain it」 are two claims, and only the second is enforced.
//
// ── the markers ─────────────────────────────────────────────────────────────
//
//   feature  `/console/billing` — the path of `kBillingPageUrl`
//            (apps/mobile/lib/src/support/legal_urls.dart), i.e. the page the
//            card actually OPENS, not a label describing it. Its only Dart
//            consumer is `_BillingLink` in quota_rules_page.dart (grep
//            `kBillingPageUrl` under apps/mobile/lib); with the define on, that
//            widget is never constructed and the AOT compiler drops the string.
//   control  `mobile:reconnect` — APK_CONTROL_MARKER, present in every build.
//            Control 0 ⇒ BLIND: the scan saw nothing, which proves nothing.
//
// ⚠️ If some other screen ever needs `kBillingPageUrl` legitimately in a store
// build, this gate goes red on a compliant package. The fix then is to
// re-measure and pick a marker that belongs only to the steering card — never
// to weaken the gate into one that cannot fail.
//
// ── §measurement (2026-10-20, on artifacts built from this tree) ────────────
//
//   artifact                                    /console/billing  control  gate
//   ------------------------------------------  ----------------  -------  -------
//   store AAB 0.3.117 (main tree), no define    3 (1 per ABI)     3        refused
//   store AAB, this change, WITH the define     0                 3        OK
//   IPA 0.3.117 build 1 (Mac line), no define   1                 >0       refused
//
// The two 0.3.117 readings are the audit finding confirmed at byte level: the
// bundle and the IPA prepared for the stores carry the billing URL. The second
// row is the tree-shaking claim measured, not assumed: with the define on, the
// URL is gone from every libapp.so while the control marker is still seen, and
// `/console/account` (the account-deletion link, which must stay) is still
// there, 3 hits. ⚠️ The with-define IPA has NOT been measured (needs the Mac);
// its first `make release-ios` run is that measurement.

import { APK_CONTROL_MARKER, countMarker } from './apk-self-update-marker.mjs';

export const STORE_BILLING_LINK_MARKER = '/console/billing';

/** The define a store build must carry. Quoted in refusals and pinned by the
 *  drill against the Dart flag file and the Makefile, so the three cannot drift. */
export const STORE_CHANNEL_DEFINE = '--dart-define=FLOWMIC_STORE_CHANNEL=1';

/**
 * Billing-link scan over already-inflated payload bytes.
 * @param {Buffer[]} payloads
 * @returns {{control:number, billing:number, verdict:'ok'|'carries-billing-link'|'blind'}}
 */
export function scanBillingLink(payloads) {
  let control = 0;
  let billing = 0;
  for (const b of payloads) {
    control += countMarker(b, APK_CONTROL_MARKER);
    billing += countMarker(b, STORE_BILLING_LINK_MARKER);
  }
  // Blind first, as in every sibling gate: this one asserts an ABSENCE, so a
  // scan that saw nothing would otherwise be its most confident pass.
  if (control === 0) return { control, billing, verdict: 'blind' };
  if (billing > 0) return { control, billing, verdict: 'carries-billing-link' };
  return { control, billing, verdict: 'ok' };
}

/** The refusal an operator reads. Names the fix. */
export function billingLinkRefusal(hits, rebuild) {
  return (
    `it CARRIES the in-app link to the web billing page (${hits} hit(s) of ` +
    `'${STORE_BILLING_LINK_MARKER}'). Store rules forbid steering to an outside ` +
    `purchase page. Rebuild with ${STORE_CHANNEL_DEFINE} — see apps/mobile/Makefile ` +
    `\`${rebuild}\`.`
  );
}
