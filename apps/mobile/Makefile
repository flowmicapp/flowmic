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
	node ../../scripts/i18n/gen-protocol-error-sentences-dart.mjs

analyze: gen
	flutter analyze

test: gen
	flutter test

# 🔴 THE GATE'S ENTRY POINT (2026-08-25). `verify:mobile-tests` used to call
# `flutter test --timeout 90s --reporter compact` directly from the repo root,
# which skipped `gen` — so whether the delivery gate passed depended on what
# happened to be on that machine's disk.
#
# MEASURED: the LLM-NOTICE card added a reference to a constant this Makefile
# generates. On the machine that wrote it (codegen fresh) the suite was 2894
# green; on a machine that had only pulled, the SAME commit failed to compile
# — 「Member not found: 'capabilityLlm'」. Both machines were telling the truth
# about their own disk, which is the problem: a gate that reads generated,
# gitignored sources it does not generate can go red on correct code and green
# on stale code. CLAUDE.md already records the same shape for the protocol
# `dist` ("陈旧的 dist 会双向骗人").
#
# The flags live here rather than at the call site because they are not
# cosmetic: a hung widget test makes a bare `flutter test` run for twenty
# minutes printing nothing (flowmic-realdevice-playbook). One target, both
# requirements, one place to change either.
# ── WHY THERE IS NO -j HERE, AND NO SHARDING (measured 2026-09-13, lane L2) ──
#
# Machine dev-pc-a (Ryzen 9 7945HX, 16C/32T), tree at 0c445861.
# Method: three runs per row, `flutter test --reporter compact --timeout 90s`,
# nothing else on the box (a machine lock kept the concurrent golden lane off
# it), medians in ms. EVERY row finished with the same total, 4071
# (+4070 ~1), so these compare like with like. "pre" is 0c445861 as it stood;
# "post" also carries the three injected-seam fixes in
# test/connections_controller_test.dart (that one file: 42121 ms -> 2177 ms).
#
#   variant                        runs (ms)                    median
#   default -j (16 here)   pre     115810 / 118549 / 114157 /   117429 (n=5)
#                                  117819 / 117429
#   default -j (16 here)   post    117690 / 111487 / 111316     111487
#   -j 8                   pre     135788 / 126653 / 119614     126653
#   -j 16                  pre     113096 / 120597 / 114480     114480
#   -j 32                  pre     117609 / 106081 / 100486     106081
#   -j 32                  post    114357 / 117656 / 112214     114357  1 RED
#   --experimental-faster-testing   DOES NOT RUN — see below
#
# (A sixth default run, 160792 ms, is excluded from every median: it was the
# first ever build in a fresh worktree and measured the cold kernel cache.)
#
# 🔴 -j 32 IS NOT LANDED, AND THE REASON IS A RED, NOT A NUMBER. Its medians
# straddle the default's (100.5 s to 117.7 s across six runs), and the sixth
# run FAILED: at 32 concurrent Dart VMs the ephemeral-port churn crossed two
# suites — `blind_store_payload_test.dart` could not load at all ("Unable to
# connect to flutter_tester process: WebSocketException: Invalid WebSocket
# upgrade request") and `blind_store_keymeta_client_test.dart`'s "nobody
# listening ⇒ UNREACHABLE" case got `HTTP_400` from whatever had taken the
# port it had just released. That test's whole point is that an unanswered
# request is not a server verdict, and oversubscription turns it into one.
# This is hazard 5 in verify/run-delivery-fast.mjs ("lanes that assert on time
# can lose to a lane that eats the CPU") reproduced from inside one lane.
# A knob is deliberately NOT added either: a control nothing sets is the shape
# CLAUDE.md bans. If a future card wants the concurrency raised, it owes a
# measurement of the six-lane interaction, not just a solo wall clock.
#
# 🔴 --experimental-faster-testing (the hidden flag that would actually remove
# the per-file cost) CANNOT RUN FROM THIS REPO'S PATH. flutter_tools builds
# `build/isolate_spawning_tester/child_test_isolate_spawner.dart` by turning
# each test file's absolute path into a Dart import prefix, and its sanitizer
# replaces only `.` `:` `/` `\` — NOT `-`
# (packages/flutter_tools/lib/src/test/runner.dart, `String pathToImport`).
# Every path here contains hyphens (`nerss-corp`, `flowmic-app`), so the
# generated file does not parse and all 393 suites fail to load in ~11 s.
# Measured both ways: entering through a hyphen-free junction does not help,
# because the tool canonicalises to the real path first. This is an upstream
# bug, not a test-isolation problem in this suite — nothing of ours ran.
#
# 🔴 SHARDING WOULD NOT HAVE HELPED ANYWAY, and the reason is measured. The
# 2026-09-13 cost ledger attributes 78 % of the summed per-file time to
# per-file VM loading (avg 3.15 s x 393). Probed here with throwaway one-test
# files: a file importing nothing but `flutter_test` loads in 2217 ms (median
# of 3); one importing `test/support/di.dart` — the 261-line helper 184 files
# pull, with its 21 `package:flowmic/...` imports — loads in 2032 ms. Also
# measured: fakes.dart 2113, ptt_session.dart 2164, material.dart 2092,
# app_strings.dart 1939, timeline_store.dart 1871. The delta is noise, and
# some of it is negative. **The tax is Dart VM + engine start, not our import
# graph**, so N shard processes pay it N times over; only running many suites
# in one process removes it, which is the flag above.
#
# ── fixed temp paths / fixed ports (grepped 2026-09-13, whole apps/mobile) ──
# `grep -rn systemTemp test lib` — 47 hits, 46 of them `createTemp`/
# `createTempSync` with a prefix. The one fixed name
# (`update_card_widget_test.dart`, `flowmic-up2b-fake.apk`) is now a
# `createTempSync` directory + `removeTempDir` teardown. Three files hold
# `/tmp/...` string literals (`outbox_stations_test.dart`,
# `outbox_test_sqlite.dart`, `update_download_test.dart`) and nothing opens
# them: they are record fields and an argument to a fake platform port.
# `grep -rnE "(HttpServer|ServerSocket|SecureServerSocket)\.bind"` — 20 hits,
# every one binds port 0. So: zero fixed ports, zero remaining fixed paths.
.PHONY: gate-test
gate-test: gen
	flutter test --timeout 90s --reporter compact

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
