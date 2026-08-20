# FlowMic mobile — build-flow entrypoints.
# The codegen MUST run before analyze/test/build so lib/generated/ is fresh
# (D3 lesson: protocol events are generated from @flowmic/protocol, never hand-
# written). `*.g.dart` is gitignored; regenerate on a clean checkout with `make gen`.

.PHONY: gen analyze test build release release-store release-ios

# Two generators, two different sources, both required before anything compiles:
#   · tool/gen_protocol.mjs      — event names, schema version, and the retired
#                                  relay list, from @flowmic/protocol (the last
#                                  one rides the generator so the address never
#                                  becomes a Dart literal — see its header)
#   · gen-mobile-dart.mjs        — the string catalogue's per-language classes,
#                                  from i18n/mobile/*.json + the locale registry
#                                  (0.2.67, architecture doc §4.1). Its output is
#                                  `*.g.dart` and therefore gitignored too, so a
#                                  clean checkout does not compile until this runs.
gen:
	node tool/gen_protocol.mjs
	node ../../scripts/i18n/gen-mobile-dart.mjs

analyze: gen
	flutter analyze

test: gen
	flutter test

build: gen
	flutter build apk --debug

# The RELEASE build — card UP-7.
#
# `flutter build apk --release` on its own is not the release action and must
# not be documented as one. The phone's self-update feature sits behind a
# build-time define that defaults to OFF (deliberately: a forgotten define has
# to cost us the feature, never ship a Play-policy-violating build — see
# lib/src/update/self_update_flag.dart). The bare command therefore drops the
# feature silently and exits 0. It is how 0.2.59 was published.
#
# ⚠️ THIS TARGET IS A CONVENIENCE, NOT THE GATE. Running it proves nothing about
# an APK someone built another way, and it is not what makes forgetting go red.
# The gate is a content check on the artifact itself: scripts/publish.mjs reads
# the APK's bytes and refuses to stage one whose update module was tree-shaken
# out (scripts/apk-self-update-marker.mjs, with the both-directions measurement
# in its header). Those are different claims — "the build went through our
# script" vs "the bytes contain the feature" — and only the second one is
# enforced.
release: gen
	flutter build apk --release --flavor direct --dart-define=FLOWMIC_SELF_UPDATE=1

# THE STORE ARTIFACT — Google Play (ST-1, 2026-08-19).
#
# Two differences from `release`, and each is a rule rather than a preference:
#   · `--flavor store` picks the source set WITHOUT REQUEST_INSTALL_PACKAGES
#     (android/app/src/store/AndroidManifest.xml explains why it is empty);
#   · no FLOWMIC_SELF_UPDATE define, so the Dart half is tree-shaken out too.
#     Belt and braces on purpose: the manifest half is what Play REVIEWS, the
#     Dart half is what could still try to run, and the third defence
#     (lib/src/update/install_source.dart) holds even in a mis-built artifact.
#
# Play takes an AAB, not an APK — `flutter build apk` here would produce
# something no store accepts, which is why this target does not offer one.
#
# ⚠️ NOT A PUBLISHABLE ARTIFACT FOR OUR OWN CHANNELS. scripts/publish.mjs
# refuses it by name: a store bundle carries no self-updater, and a user who
# downloaded it from our site would be stranded on that version forever.
# THE GATE IS PART OF THIS TARGET, not a step someone remembers (ST-1b,
# 2026-08-19). Until today the store gate existed and nothing ran it: submitting
# to Play is a manual action, so the only thing between a mis-built bundle and
# the Play console was a line in docs/RELEASE-IRONRULES.md. That is the same
# shape the `release` comment above names -- "the build went through our script"
# vs "the bytes contain the feature" -- and only the second one is worth
# anything. So the second line below reads the bundle the first line just wrote,
# and a refusal fails this target (make stops on a non-zero recipe line).
#
# WHAT IT PROVES: the .aab submitted to Play -- these exact bytes -- carries no
# self-update marker in any module entry, and declares no
# REQUEST_INSTALL_PACKAGES in any module manifest. The gate inflates the bundle
# and walks the protobuf manifest itself (no bundletool). The measurement, and
# the cross-check against aapt on the same flavour's APK, are in
# scripts/store-channel-gate.mjs section measurement-aab.
#
# WHAT IT DOES NOT PROVE, stated here and not only over there:
#   1. Play does not install these bytes. It generates and re-signs per-device
#      split APKs from this bundle. This gate reads what those are derived from.
#   2. It says nothing about which file a human later drags into the console.
#      Nothing in this repo can see that action; it stays in section 1 of the
#      release ironrules.
#   3. `flutter build appbundle` prints its own green "Built ..." line BEFORE
#      the gate runs. That line is not the verdict. The verdict is the OK/FAIL
#      line after it, and the exit code of this target.
release-store: gen
	flutter build appbundle --release --flavor store
	node ../../scripts/store-channel-gate.mjs build/app/outputs/bundle/storeRelease/app-store-release.aab

# THE iOS ARCHIVE — TestFlight / App Store (owner 2026-08-20: iOS gets a
# reminder too).
#
# iOS carries the NOTIFY-ONLY half of the update feature: check + a dot + a
# sentence pointing at the store page. It never downloads or installs — that
# is the Android direct channel's define (FLOWMIC_SELF_UPDATE), deliberately
# NOT passed here, and `UpdateController.canInstall` cannot come true without
# it. The reasoning for a second define instead of Platform.isIOS (the Android
# store artifact's marker-absence depends on it) is in
# lib/src/update/self_update_flag.dart's notify section.
#
# ⚠️ macOS ONLY — flutter build ipa needs Xcode; this target exists so the mac
# line runs a documented command instead of remembering a define. The Podfile
# is deliberately not in this repo (2026-08-10 ruling ⑦), so `pod install`
# state lives on that machine.
#
# 🔴 STATED DEBT, not an oversight: no byte-gate reads the IPA the way
# apk-self-update-marker reads the APK. iOS archives are produced and uploaded
# on the mac line outside scripts/publish.mjs, and this repo's own rule says a
# gate never verified against a real artifact is worse than a debt written
# down plainly. The day the mac line stages IPAs through a script, give it the
# same shape: feature string `/api/updates/latest` + a control string, read
# from the artifact's bytes. Until then: forgetting the define costs iOS the
# reminder silently (build green, exit 0) — UP-7's failure direction, unclosed
# on this platform.
release-ios: gen
	flutter build ipa --release --dart-define=FLOWMIC_UPDATE_NOTIFY=1
