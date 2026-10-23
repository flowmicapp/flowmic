// Card INC-1f — "polish while speaking": the per-session runner. While the user
// speaks it polishes the sentences the engine has COMMITTED (it will never change
// them), a piece at a time; when a final arrives (a soft-segment final or the
// terminal one) it assembles that final from those results by exact string and
// polishes only what is not covered yet. Design =
// docs/strategy/2026-10-13-realtime-polish-while-speaking-design.md §2.3, §3.1,
// §3.3, §9; contract = docs/rebuild/06-STT-ENGINE-LAYER.md §5 (INC-1a block and
// its 2026-10-14 addendum).
//
// 🔴 WHAT THIS MAY NEVER DO, and where each line is held:
//   · send anything to the phone or the PC — it returns a PolishResult to
//     `runPolishedFinal` (stt-session-polish.ts), which emits once, as today;
//   · deliver a mixed text — any span that still fails after its own
//     Smooth -> Strict fallback makes the WHOLE final un-polished with that
//     span's reason (contract: `applied` is all or nothing, design D5);
//   · meter twice — every request is metered once, when it answers, through the
//     session's one seam (`meter`); the composite result carries no usage, so
//     `runPolishedFinal`'s own meter call is a no-op for it;
//   · answer for a session that is not armed — the bridge builds this only when
//     `SttSessionDeps.polishSpeculative` is true (stt-factory.ts is its one
//     production writer, through `speculationArmed`).

import { log } from '../log';
import { observedPolishFinalText, type PolishPhase } from '../obs/terminal-polish-timing';
import { assemble, closedPieces, contextOf, planRelease, reconstructs, sentenceEnds, type PlanSpan } from '../stt/polish-spec-plan';
import { protectedTermDrift, type PolishResult } from '../stt/stt-polish';
import type { SttSessionDeps } from './stt-session-deps';
import type { MeterPolish } from './stt-session-detached-polish';
import type { SpecStats } from './stt-session-polish-timing';

/** Background requests one session may make (design §2.3: a runaway cap). */
export const SPEC_RUNAWAY_CAP = 60;
const SPEECH_INFLIGHT = 1;
const RELEASE_INFLIGHT = 4;
/** How long "only committed text, ending a sentence" must hold before the rest is kicked. */
export const IDLE_KICK_MS = 500;

interface Entry {
  input: string;
  context: string;
  ctrl: AbortController;
  promise: Promise<PolishResult>;
  result?: PolishResult;
}

interface Pending { input: string; context: string }

interface Segment {
  stableRaw: string;
  /** The pure (dictionary → normalizer, isSegment) form of the committed text. */
  s: string;
  /** Offset in `s` up to which pieces were planned. */
  plannedTo: number;
  /** The last interim text the phone was shown, to recognise "paused, then released". */
  shownRaw: string;
  entries: Entry[];
  queue: Pending[];
}

export interface SpeculationContext {
  polish: NonNullable<SttSessionDeps['polish']>;
  meter: MeterPolish;
  /** The session's pure final-text transform (deps.finalText), identity when absent. */
  pure: (raw: string, language: string) => string;
  utteranceId?: string;
}

export interface SpeculativeFinal { result: PolishResult; stats: SpecStats }

const accepted = (r: PolishResult | undefined): boolean => r !== undefined && r.reason === undefined;
const engaged = (seg: Segment): boolean => seg.entries.length > 0 || seg.queue.length > 0;
/** Everything shown is committed and the committed text ends a sentence. */
function pausedAtEnd(seg: Segment): boolean {
  const ends = sentenceEnds(seg.s, 0, true);
  return seg.s !== '' && seg.shownRaw === seg.stableRaw && ends.length > 0 && ends[ends.length - 1]! >= seg.s.trimEnd().length;
}

export class PolishSpeculation {
  private readonly segs = new Map<number, Segment>();
  private inflight = 0;
  private started = 0;
  private disabled = false;
  private releasing = false;
  private latest = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: SpeculationContext) {}

  /** Every interim, synchronously on arrival (never through the outbox). */
  onInterim(segment: number, shownRaw: string, stableRaw: string | undefined, language: string): void {
    this.latest = Math.max(this.latest, segment);
    const seg = this.segment(segment);
    seg.shownRaw = shownRaw;
    if (typeof stableRaw !== 'string' || stableRaw === seg.stableRaw) { this.armIdleKick(seg); return; }
    seg.stableRaw = stableRaw;
    const s = this.ctx.pure(stableRaw, language);
    if (!s.startsWith(seg.s.slice(0, seg.plannedTo))) {
      // The committed text was re-folded (a seam, a replay trim): re-plan from
      // the start and cancel what no longer occurs. Kept entries stay valid —
      // reuse is by exact string at release, never by position.
      seg.plannedTo = 0;
      seg.queue = seg.queue.filter((q) => s.includes(q.input));
      for (const e of seg.entries) if (e.result === undefined && !s.includes(e.input)) e.ctrl.abort();
    }
    seg.s = s;
    for (const p of closedPieces(s, seg.plannedTo)) this.enqueue(seg, s, p.start, p.end);
    this.pump();
    this.armIdleKick(seg);
  }

  /** The release (button up or auto-stop), BEFORE the engine's closing flush:
   *  kick every committed sentence not yet kicked, up to 4 in flight, so it runs
   *  during the second the engine needs to finish (design D7). */
  releaseKick(): void {
    this.releasing = true;
    const seg = this.segs.get(this.latest);
    if (seg === undefined || this.disabled) { this.pump(); return; }
    // "Paused, then released": everything shown is committed and ends a sentence.
    if (engaged(seg) || pausedAtEnd(seg)) this.kickClosedRest(seg);
    this.pump();
  }

  /** Every committed sentence not kicked yet, the last one regardless of size. */
  private kickClosedRest(seg: Segment): void {
    const ends = sentenceEnds(seg.s, seg.plannedTo, true);
    const lastEnd = ends.length > 0 ? ends[ends.length - 1]! : -1;
    let to = seg.plannedTo;
    for (const p of closedPieces(seg.s, seg.plannedTo, { final: true })) { this.enqueue(seg, seg.s, p.start, p.end); to = p.end; }
    if (lastEnd > to) this.enqueue(seg, seg.s, to, lastEnd);
  }

  /**
   * §9 addendum (measured 2026-10-14): a soft cut happens at a PAUSE, and the
   * sentence just before it never closes a piece (nothing follows it), so the
   * segment final waited for a release call on it. When an engaged segment has
   * shown only committed text ending a sentence for IDLE_KICK_MS, that is the
   * same "paused" fact the release kick uses: kick the rest now.
   */
  private armIdleKick(seg: Segment): void {
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
    if (this.disabled || !engaged(seg) || !pausedAtEnd(seg)) return;
    this.idle = setTimeout(() => { this.idle = null; if (this.segs.get(this.latest) === seg) { this.kickClosedRest(seg); this.pump(); } }, IDLE_KICK_MS);
    this.idle.unref?.();
  }

  /**
   * The final for `segment` arrived with pure text `p`. Returns null when the
   * one-span rule applies (nothing usable was requested for it ⇒ the caller
   * makes today's single call), else the assembled result. Takes the segment's
   * table SYNCHRONOUSLY, before its first await.
   */
  polishFinal(p: string, segment: number, isSegment: boolean): Promise<SpeculativeFinal | null> | null {
    const seg = this.segs.get(segment);
    this.segs.delete(segment);
    if (this.idle !== null) { clearTimeout(this.idle); this.idle = null; }
    for (const [k, old] of this.segs) if (k < segment) { this.segs.delete(k); this.abortAll(old); }
    if (seg === undefined || this.disabled) { if (seg) this.abortAll(seg); return null; }
    seg.queue = [];
    const live = seg.entries.filter((e) => e.result === undefined || accepted(e.result));
    const plan = planRelease(p, live);
    const hits = plan.filter((s) => s.kind === 'hit');
    for (const e of seg.entries) if (e.result === undefined && !hits.some((h) => h.kind === 'hit' && h.entry === e)) e.ctrl.abort();
    if (hits.length === 0) return null; // the one-span rule: today's call, byte for byte
    return this.assembleFinal(p, seg, plan, isSegment);
  }

  /** Session torn down without a finish: cancel everything, use nothing. */
  dispose(): void {
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
    for (const seg of this.segs.values()) this.abortAll(seg);
    this.segs.clear();
    this.disabled = true;
  }

  private async assembleFinal(p: string, seg: Segment, plan: PlanSpan<Entry>[], isSegment: boolean): Promise<SpeculativeFinal> {
    const stats: SpecStats = { hitChars: 0, releaseChars: 0, calls: seg.entries.length, unusedCalls: 0, rejectedCalls: 0 };
    const outputs = new Map<number, PolishResult>();
    // Gaps and the tail start NOW, beside the wait for in-flight hits — never
    // after it (measured 2026-10-14: serialising them made a cut's hold longer
    // than the single call it replaces). At most RELEASE_INFLIGHT at once.
    let free = RELEASE_INFLIGHT;
    const waiters: (() => void)[] = [];
    const polishNow = async (i: number, input: string, context: string): Promise<void> => {
      if (free === 0) await new Promise<void>((r) => waiters.push(r));
      free -= 1;
      stats.releaseChars += input.length;
      try { outputs.set(i, await this.request(input, context, isSegment, { phase: 'release', span_idx: i, ctx_chars: context.length })); }
      finally { free += 1; waiters.shift()?.(); }
    };
    await Promise.all(plan.map(async (span, i) => {
      if (span.kind === 'joint') return;
      if (span.kind === 'polish') return polishNow(i, span.input, span.context);
      const r = span.entry.result ?? await span.entry.promise;
      if (accepted(r)) { outputs.set(i, r); stats.hitChars += span.input.length; return; }
      return polishNow(i, span.input, span.entry.context); // failed in flight ⇒ polished now
    }));
    const used = new Set(plan.flatMap((s) => (s.kind === 'hit' ? [s.entry] : [])));
    for (const e of seg.entries) {
      if (e.result?.skipReason === 'guard_reject') stats.rejectedCalls += 1;
      if (!used.has(e) || !accepted(e.result)) stats.unusedCalls += 1;
    }
    const failed = plan.map((_, i) => outputs.get(i)).filter((r): r is PolishResult => r !== undefined && !accepted(r));
    if (failed.length > 0) {
      log.warn('stt.polish speculative assembly — a span failed, whole final kept un-polished', { reasons: failed.map((r) => r.reason ?? 'unknown') });
      return { result: { text: p, applied: false, reason: failed[0]!.reason!, skipReason: failed[0]!.skipReason ?? 'llm_error' }, stats };
    }
    const text = assemble(plan, (_s, i) => outputs.get(i)!.text).trim();
    const terms = this.ctx.polish.deps?.protectedTerms ?? [];
    if (!reconstructs(p, plan) || protectedTermDrift(p, text, terms) !== null) {
      // Design §9 item 2: an assertion, not a filter — this is OUR bug.
      log.error('stt.polish speculative assembly broke an invariant — whole final kept un-polished', { reconstructs: reconstructs(p, plan) });
      return { result: { text: p, applied: false, reason: 'spec-invariant', skipReason: 'guard_reject' }, stats };
    }
    return { result: { text, applied: text !== p }, stats };
  }

  private segment(idx: number): Segment {
    let seg = this.segs.get(idx);
    if (seg === undefined) {
      seg = { stableRaw: '', s: '', plannedTo: 0, shownRaw: '', entries: [], queue: [] };
      this.segs.set(idx, seg);
    }
    return seg;
  }

  private enqueue(seg: Segment, s: string, start: number, end: number): void {
    seg.plannedTo = Math.max(seg.plannedTo, end);
    const input = s.slice(start, end).trim();
    if (input === '') return;
    const context = contextOf(s, s.indexOf(input, start));
    if (seg.entries.some((e) => e.input === input && e.context === context) || seg.queue.some((q) => q.input === input && q.context === context)) return;
    seg.queue.push({ input, context });
  }

  private pump(): void {
    const cap = this.releasing ? RELEASE_INFLIGHT : SPEECH_INFLIGHT;
    for (const [, seg] of [...this.segs].sort(([a], [b]) => a - b)) {
      while (seg.queue.length > 0 && this.inflight < cap && !this.disabled && this.started < SPEC_RUNAWAY_CAP) {
        const next = seg.queue.shift()!;
        this.started += 1;
        this.inflight += 1;
        const ctrl = new AbortController();
        const entry: Entry = { ...next, ctrl, promise: Promise.resolve(undefined as unknown as PolishResult) };
        entry.promise = this.request(next.input, next.context, false, { phase: 'spec', span_idx: seg.entries.length, ctx_chars: next.context.length }, ctrl.signal)
          .then((r) => { entry.result = r; return r; })
          .finally(() => { this.inflight -= 1; this.pump(); });
        seg.entries.push(entry);
      }
    }
  }

  /** One request through the SAME polish call as today, metered once when it answers. */
  private async request(input: string, context: string, isSegment: boolean, phase: PolishPhase, signal?: AbortSignal): Promise<PolishResult> {
    const { polish } = this.ctx;
    let r: PolishResult;
    try {
      r = await observedPolishFinalText(input, polish.llm, { ...(polish.deps ?? {}), context, ...(signal ? { signal } : {}) }, this.ctx.utteranceId, isSegment, phase);
    } catch (err) {
      log.error('stt.polish speculative request threw', { error: err instanceof Error ? err.message : String(err) });
      return { text: input, applied: false, reason: 'exception', skipReason: 'llm_error' };
    }
    this.ctx.meter(polish, r);
    if (r.skipReason === 'model_rejected') this.disabled = true; // every further call would fail the same way
    return r;
  }

  private abortAll(seg: Segment): void {
    seg.queue = [];
    for (const e of seg.entries) if (e.result === undefined) e.ctrl.abort();
  }
}

