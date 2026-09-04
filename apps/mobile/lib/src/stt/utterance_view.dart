// The utterance view — the phone half of ONE model shared with the PC capsule.
//
// 🔴 THE CONTRACT AND THE FRAME SEMANTICS ARE WRITTEN OUT ONCE, in
// apps/desktop/src/capsule/utterance-view.ts (file header). Read that before
// touching this: it records, with file:line, whether `stt:interim.text` is
// cumulative or a delta, what a mid-hold `is_segment` final means, and why the
// terminal final carries only the last segment. Duplicating it here is how the
// two copies would drift; this file states only what is specific to the phone.
//
// Both ends are pinned to the SAME recorded frame sequence,
// verify/fixtures/utterance-view-parity.json, read verbatim by
//   · apps/desktop/src/capsule/utterance-view.test.ts   (vitest)
//   · apps/mobile/test/utterance_view_parity_test.dart  (flutter test)
// If they ever disagree about one character, one of those two goes red.
//
// ── WHY THIS IS A VIEW OVER SegmentBuffer AND NOT A SECOND ACCUMULATOR ───────
// The phone already assembles the utterance in [SegmentBuffer] — same-idx
// replaces, new idx appends, a closed slot is locked, and the CJK-aware joiner
// lives there. A second accumulator answering the same question is this repo's
// #1 defect shape, so this type stores nothing: it reads the buffer's own slots
// and only decides WHERE the black run ends. `display` is therefore literally
// [SegmentBuffer.unsettledJoined], and the parity test asserts that at every
// step rather than trusting the sentence.
//
// ── WHAT THIS FIXES ON THE PHONE ────────────────────────────────────────────
// `LiveDraftTile` painted the entire draft in `FlowMicColors.t3` (grey), so a
// finalised segment and a half-heard interim were the same colour — while the
// capsule painted its (wrong) final black. Colour now means the same thing on
// both screens: black = the server has finalised this span and it has been
// through post-processing; grey = still being transcribed.

import 'segment_buffer.dart';

/// The two-colour split of the live draft.
///
/// [committed] is BLACK (finalised segments), [pending] is GREY (the open
/// segment's latest interim). [display] is what the user reads and is the
/// string both ends must agree on character for character.
class UtteranceView {
  const UtteranceView({required this.committed, required this.pending});

  /// BLACK — server-finalised segments, in index order.
  final String committed;

  /// GREY — the still-open segment's latest interim.
  final String pending;

  /// The finalised PREFIX of the live slots is what counts as committed. A gap
  /// (a lost final sitting under a later closed slot) STOPS the prefix instead
  /// of painting unconfirmed text black — grey is the honest colour for "we do
  /// not know yet", and the alternative would claim post-processing that never
  /// ran.
  factory UtteranceView.of(SegmentBuffer buf) {
    final List<int> live = buf.liveSlots;
    final Set<int> finalized = buf.finalizedSlots.toSet();
    int n = 0;
    while (n < live.length && finalized.contains(live[n])) {
      n += 1;
    }
    return UtteranceView(
      committed: _join(buf, live.sublist(0, n)),
      pending: _join(buf, live.sublist(n)),
    );
  }

  static String _join(SegmentBuffer buf, List<int> keys) {
    String out = '';
    for (final int k in keys) {
      final String t = buf.textAt(k);
      if (t.isEmpty) continue;
      if (out.isEmpty) {
        out = t;
        continue;
      }
      out = out + SegmentBuffer.joinerBetween(out, t) + t;
    }
    return out;
  }

  /// `committed + joiner + pending` — equal to [SegmentBuffer.unsettledJoined]
  /// by construction: a left fold over the slots gives the same string as
  /// splitting that same fold at a slot boundary.
  String get display =>
      committed + SegmentBuffer.joinerBetween(committed, pending) + pending;

  /// How many characters at the head of [display] are black. The joiner belongs
  /// to the black run: it is whitespace, and putting it in the grey run would
  /// make the grey text start with a character nobody spoke.
  int get committedChars => committed.isEmpty
      ? 0
      : committed.length + SegmentBuffer.joinerBetween(committed, pending).length;
}
