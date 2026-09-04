// The utterance view — ONE model of "what is on screen while somebody is
// speaking", implemented twice (here for the PC capsule, and in
// apps/mobile/lib/src/stt/utterance_view.dart for the phone) and pinned to the
// SAME recorded frame sequence, verify/fixtures/utterance-view-parity.json.
//
// ── FRAME SEMANTICS, READ FROM THE SERVER (2026-09-04, this branch) ──────────
// Both ends receive byte-identical payloads: apps/server-core/src/engine/
// stt-factory.ts:180-183 emits to the phone socket and then to
// `store.getPc(roomUuid)` with the SAME `payload` object, so a divergence here
// is never the server's.
//
//  · `stt:interim.text` is CUMULATIVE FOR THE OPEN SEGMENT, never a delta.
//    orchestrator-core.ts:703-707 sends `this.offlineAccum + this.onlineDraft`
//    stamped with `segment_idx: this.currentSegmentIdx`. Both accumulators are
//    CLEARED at a rollover (orchestrator-core.ts:545-546), so the text restarts
//    from '' under the NEXT index. So: same idx REPLACES, a new idx APPENDS.
//
//  · A mid-hold `stt:final` with `is_segment: true` closes ONE segment
//    (orchestrator-core.ts:632-635) and is followed by `beginNextSegment()`
//    (:563), which spends the index. Its text is the SERVER-PROCESSED version
//    of the very same span the interims were describing — normalisation,
//    dictionary, punctuation all ran on it — so it REPLACES that slot and is
//    never merged into it (the merge rule was deleted: a correct final is
//    SHORTER, so a merge discarded the whole processing chain — see
//    segment_buffer.dart, "WHY A FINAL REPLACES ITS SLOT").
//
//  · The terminal `stt:final` (`is_segment: false`) carries ONLY THE LAST
//    SEGMENT, for the same reason: the accumulators were cleared at every
//    rollover. Nothing on the wire ever carries the whole utterance, so the
//    whole utterance exists ONLY as this assembly, on each end, separately.
//
//  · An empty final over a non-empty slot KEEPS the slot and locks it (the
//    flush-timeout fallback must not wipe accumulated text).
//
//  · A closed slot is LOCKED: the reconnect ladder replays old frames, and a
//    replayed interim must not re-open a segment the server has finalised.
//
// ── WHAT THE CAPSULE DID BEFORE THIS FILE (the reproduced divergence) ────────
// controller.ts kept two flat strings: `onFinal` did `state.finalText = text`
// and `onInterim` did `state.interim = text`, both ignoring `segment_idx` and
// `is_segment`. On the fixture's zh-translate scenario the capsule therefore
// showed 「我们下周开始。」 at the last step — segment 0 had been overwritten by
// segment 1's final and was silently gone — while the phone showed
// 「这个方案可以。\n我们下周开始。」. And because `state.interim` was never
// cleared by the final that closed its slot, the black final was followed by
// its own stale grey interim, which is the "mostly grey, not the whole
// utterance" the owner reported.
//
// ── THE MODEL ───────────────────────────────────────────────────────────────
//   committed = the finalised segments, in index order            -> BLACK
//   pending   = the still-open segment's latest interim           -> GREY
//   display   = committed + joiner + pending
// The joiner is the phone's CJK-aware one, ported character for character from
// SegmentBuffer._joinerBetween; a left fold over the slots gives the same string
// as splitting that fold at a slot boundary, which is why `committed + joiner +
// pending` IS the assembly rather than an approximation of it.
//
// ── WHY A SETTLED SPAN LEAVES THE VIEW, AND HOW BOTH ENDS AGREE WITHOUT A
//    NEW WIRE FIELD ─────────────────────────────────────────────────────────
// In realtime mode the phone mints a ROW per soft-segment final
// (chat_utterance_settle.dart `_settlesPerSegment` = "this mode has no compose
// task") and clears its draft, so that span is on screen as a row and must not
// also be in the draft. The capsule cannot observe row settlement — but it does
// not have to guess: it computes the SAME predicate from the SAME fact, the
// `mode` on `audio:start` (AudioStartSchema.mode, already forwarded verbatim by
// socket/client.rs:502). realtime => settles per segment; translate/organize =>
// the draft keeps growing to the terminal final.
//
// ⚠️ The TERMINAL final does NOT clear the view here. On the phone the same
// characters appear at that instant on the settled row; on the PC they stay in
// the capsule preview, all black, until `inject:result` swaps in the injected
// card. The characters on screen match; what differs is only which face carries
// them, which is each end's own settled presentation.

/** `mode` values that mint a row per soft-segment final — mirrors the phone's
 *  `_settlesPerSegment` (a mode with no compose task). Anything unknown is
 *  treated as NOT settling, i.e. the view keeps the text: showing a span twice
 *  is visible and recoverable, dropping one is neither. */
const SETTLES_PER_SEGMENT_MODES = new Set(['realtime']);

/** Ported VERBATIM from apps/mobile/lib/src/stt/segment_buffer.dart
 *  `_joinerBetween`. Any edit here is a parity break, and the fixture says so. */
export function joinerBetween(left: string, right: string): string {
  if (left === '' || right === '') return '';
  const last = left[left.length - 1]!;
  if ('。！？'.includes(last)) return '\n';
  if ('，；、：'.includes(last)) return '';
  if (last.charCodeAt(0) < 0x80) {
    const firstR = right[0]!;
    if (firstR === ' ' || firstR === '\n') return '';
    return ' ';
  }
  return '';
}

function joinSlots(texts: Map<number, string>, keys: number[]): string {
  let out = '';
  for (const k of keys) {
    const t = texts.get(k) ?? '';
    if (t === '') continue;
    if (out === '') {
      out = t;
      continue;
    }
    out = out + joinerBetween(out, t) + t;
  }
  return out;
}

export class UtteranceView {
  private texts = new Map<number, string>();
  private finalized = new Set<number>();
  /** Highest index already minted into a row; -1 => nothing settled this
   *  utterance. Monotonic, for the reason segment_buffer.dart gives: accepting
   *  a lower value would re-open spans that are already on screen. */
  private settledThrough = -1;
  private settlesPerSegment = false;

  /** `audio:start` — a new utterance. `mode` decides whether a soft-segment
   *  final settles a row (and therefore leaves this view). */
  reset(mode?: string): void {
    this.texts.clear();
    this.finalized.clear();
    this.settledThrough = -1;
    this.settlesPerSegment = SETTLES_PER_SEGMENT_MODES.has(mode ?? '');
  }

  /** `stt:interim`. Returns whether anything changed. */
  onInterim(idx: number, text: string): boolean {
    if (idx <= this.settledThrough) return false;
    if (this.finalized.has(idx)) return false;
    const prior = this.texts.get(idx) ?? '';
    if (text === '') return false;
    if (text === prior) return false;
    // A shorter reading the prior already contains is a retraction, not news.
    if (prior !== '' && prior.startsWith(text)) return false;
    this.texts.set(idx, text);
    return true;
  }

  /** `stt:final`. `isSegment` true = a soft-segment boundary mid-hold. */
  onFinal(idx: number, text: string, isSegment: boolean): boolean {
    if (idx <= this.settledThrough) return false;
    if (this.finalized.has(idx)) return false;
    const prior = this.texts.get(idx) ?? '';
    this.finalized.add(idx);
    if (text !== '') this.texts.set(idx, text);
    else if (prior === '') this.texts.delete(idx);
    if (isSegment && this.settlesPerSegment) this.settledThrough = idx;
    return true;
  }

  /** Live slot indices (not yet on a row), lowest first. */
  private liveKeys(): number[] {
    return [...this.texts.keys()]
      .filter((k) => k > this.settledThrough)
      .sort((a, b) => a - b);
  }

  /** The finalised PREFIX of the live slots. A gap (a lost final under a later
   *  closed one) stops the prefix rather than painting unconfirmed text black —
   *  grey is the honest colour for "we do not know yet". */
  private committedKeys(): number[] {
    const keys = this.liveKeys();
    let n = 0;
    while (n < keys.length && this.finalized.has(keys[n]!)) n += 1;
    return keys.slice(0, n);
  }

  /** BLACK — server-finalised segments, already through post-processing. */
  get committed(): string {
    return joinSlots(this.texts, this.committedKeys());
  }

  /** GREY — the open segment's latest interim (plus any slot behind a gap). */
  get pending(): string {
    const committed = this.committedKeys().length;
    return joinSlots(this.texts, this.liveKeys().slice(committed));
  }

  /** What the user reads. `committed + joiner + pending`, so the split point is
   *  `committed.length + joiner.length` and the two colours can never disagree
   *  about which characters exist. */
  get display(): string {
    const c = this.committed;
    const p = this.pending;
    return c + joinerBetween(c, p) + p;
  }

  /** The black run's length inside {@link display} — the ONE number a renderer
   *  needs to colour it without re-deriving either half. The joiner belongs to
   *  the black run: it is whitespace, and putting it in the grey run would make
   *  the grey text start with a character nobody spoke. */
  get committedChars(): number {
    const c = this.committed;
    return c === '' ? 0 : c.length + joinerBetween(c, this.pending).length;
  }
}
