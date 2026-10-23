// NR-297 (2026-10-20) — the STORE-CHANNEL build flag.
//
// SPEC-REF:
//   Google Play Payments policy, App Store Review Guidelines 3.1.1 / 3.1.3
//     【secondhand: the read-only audit that found this, not a re-read of the
//     policy text】 — an app distributed through a store may not steer its user
//     to a purchase page outside the store.
//   apps/mobile/lib/src/ui/quota_rules_page.dart — the one consumer today: the
//     guide's link card to the web billing page (prices + checkout).
//   scripts/store-channel-gate.mjs (AAB) and scripts/ios-store-billing-gate.mjs
//     (IPA) — the byte gates that enforce it.
//
// ── WHY A FLAG OF ITS OWN, NOT `kSelfUpdateEnabled` ─────────────────────────
//
// 「Is this a store build」 and 「does this build carry the self-updater」 have
// the same answer on Android and opposite answers nowhere today — but iOS is a
// store build that does NOT carry the self-updater and DOES carry update
// notifications, and the Android direct APK is a non-store build. One value
// answering two questions is this repo's headline defect shape; the day a
// third channel appears, a reused flag would answer one of them wrong without
// any line changing. So: one define, one question.
//
// ── 🔴 THE DEFAULT IS 「NOT A STORE BUILD」, AND WHY THAT IS NOT THE UNSAFE SIDE ─
//
// `self_update_flag.dart` argues 「the failure direction decides the default」.
// Applied here, both directions were weighed:
//   · default ON (store) ⇒ every build that forgets the define is a store build:
//     `make release` (the direct APK), `flutter run`, the test suite. The direct
//     APK would lose the link SILENTLY — no gate reads the direct APK for it,
//     and nothing would ever go red. A bare `flutter build` would land on the
//     store side, which sounds safe but is a loss nobody is told about.
//   · default OFF (direct) ⇒ a store build that forgets the define still carries
//     the link — but that is NOT silent: `make release-store` ends in
//     scripts/store-channel-gate.mjs and `make release-ios` in
//     scripts/ios-store-billing-gate.mjs, and both read the ARTIFACT's bytes
//     and refuse it while the billing-page path is in there.
// ⇒ OFF. A bare `flutter build` (no defines) is a direct-channel build, as it
//   already is for the self-updater. The store side is protected by what the
//   bytes say, not by what a default hopes for — the same split UP-7 made.
//
// ⚠️ What that protection does NOT cover: an IPA or AAB built by a command that
// does not end in one of those two gates. The Mac line's own iOS scripts copied
// the release-ios recipe instead of calling it (NR-297 report); a copy that
// does not carry the define AND does not call the IPA gate ships the link.
//
// ── THE CONST IS LOAD-BEARING ───────────────────────────────────────────────
//
// It must stay `const`, for the reason `self_update_flag.dart` states for its
// own: with the flag const-true, the guarded widget is never constructed, the
// AOT compiler drops it, and the billing URL string is not in the binary at all
// — which is what the byte gates measure. Switching to `final` or a runtime
// check would leave the link's code (and its URL) in a store package.

/// The build-time define's name. Set by `make -C apps/mobile release-store`
/// and `make -C apps/mobile release-ios`; deliberately NOT by `make release`.
const String kStoreChannelDefineKey = 'FLOWMIC_STORE_CHANNEL';

// Both spellings, same reason as `kSelfUpdateEnabled`: the documented command
// says `=1`, and `bool.fromEnvironment` silently defaults on anything but the
// literal `true`.
const bool _storeChannelBoolForm = bool.fromEnvironment(kStoreChannelDefineKey);
const String _storeChannelRawForm = String.fromEnvironment(
  kStoreChannelDefineKey,
);

/// Whether this build is distributed through an app store (Google Play, App
/// Store / TestFlight). **Default false.** In a store build the app shows no
/// link to a purchase page outside the store.
const bool kStoreChannelBuild =
    _storeChannelBoolForm || _storeChannelRawForm == '1';
