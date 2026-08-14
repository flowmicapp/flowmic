// SPEC-REF: see ptt_session.dart — this file holds that library's one small
//   value type and nothing else.
//
// ── WHY THIS FILE EXISTS: THE 800-LINE CAP, AND NOTHING ELSE ─────────────────
//
// `verify:lint` 8/9 (`file-size.mjs`, SRC_MAX = 800) went red when Window
// B3-2a added `PttSession.pcMachineUid` (gate 2 needs the machine identity
// live, for the same reason `pcId` is live). ptt_session.dart was already at
// 779/800 — 21 lines of headroom for a feature that needs about that many —
// so something had to come out.
//
// WHY THIS AND NOT A BIGGER SPLIT. The natural seam in ptt_session.dart is the
// 142-line inbound-dispatch switch, and the repo's Dart idiom for that is a
// `part` file of top-level functions taking the instance explicitly (see
// chat_utterance.dart, which is `part of chat_controller.dart` and says why).
// That is a real refactor of code this card is only visiting, and 「只挪不改」
// ("move only, change nothing") is worth more here than tidiness: [PairResult]
// is a self-contained 6-line value type that moves with zero behavioural
// surface.
//
// 🔴 **NOTHING WAS CHANGED. THIS IS A MOVE.** The declaration is byte-for-byte
// what it was at ptt_session.dart:38-44, doc comment included. ptt_session.dart
// `export`s this file, so every existing `import 'ptt_session.dart'` — including
// the tests that construct and match on `PairResult` — resolves exactly as
// before. If a future reader diffs this against git history and finds a
// difference, that difference is a BUG, not an intention.

import '../auth/token_storage.dart';

/// A live/most-recent pairing, surfaced for the header + settings screens.
class PairResult {
  final bool ok;
  final String? error;
  final MobileSession? session;
  const PairResult({required this.ok, this.error, this.session});
}
