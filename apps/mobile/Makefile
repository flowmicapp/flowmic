# FlowMic mobile — build-flow entrypoints.
# The codegen MUST run before analyze/test/build so lib/generated/ is fresh
# (D3 lesson: protocol events are generated from @flowmic/protocol, never hand-
# written). `*.g.dart` is gitignored; regenerate on a clean checkout with `make gen`.

.PHONY: gen analyze test build release

# Two generators, two different sources, both required before anything compiles:
#   · tool/gen_protocol.mjs      — event names + schema version, from @flowmic/protocol
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
	flutter build apk --release --dart-define=FLOWMIC_SELF_UPDATE=1
