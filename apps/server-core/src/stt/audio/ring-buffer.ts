// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 (server_replay_buffer_ms = 5000),
//     §2.3 (engine auto-reconnect → replay the 5s server-side replay buffer)
//   Ported from legacy audio/ring-buffer.ts (mechanism unchanged).
//
// Bounded FIFO of (seq, ts_ms, recv_ms, payload) entries. The server keeps a 5s
// tail so an engine reconnect can replay it transparently. The mobile client
// keeps its own 30s ring buffer — a separate structure with the same shape.
//
// 🔴 RETENTION IS MEASURED BY `recv_ms`, NEVER BY `ts_ms` (card M3-4b, 2026-08-02).
// The two fields answer two different questions and they are stamped by TWO
// DIFFERENT MACHINES' WALL CLOCKS:
//   · ts_ms   = "when the phone says this chunk was captured" — the PHONE's clock
//               (`apps/mobile/lib/src/audio/audio_capture.dart:126 _wallClock()`
//               = DateTime.now().millisecondsSinceEpoch). The server only
//               forwards it; the engine wants it because it is capture ORDER.
//   · recv_ms = "when we received it" — THIS process's clock, stamped at ingest
//               by `AudioSession.pushChunk`. Retention (prune / since) is a
//               question about OUR OWN buffer, so only this one may answer it.
// Until 0.2.48 the cutoff came from the server clock while the entries carried
// the phone's, so a phone whose wall clock was off by more than windowMs (5 s —
// an un-NTP'd Android drifts that far routinely) broke replay in BOTH
// directions and in COMPLETE SILENCE:
//   · phone slow  ⇒ every chunk is already older than the cutoff at push time ⇒
//     the ring is permanently EMPTY ⇒ an engine reconnect replays NOTHING and
//     the audio spoken during the blip is lost for good, with no error anywhere;
//   · phone fast  ⇒ nothing is ever pruned ⇒ the ring grows without bound and a
//     reconnect re-feeds audio far older than the window (duplicate transcript).
// Reverse control: `test/stt-replay-clock.test.ts` (0 / −10 s / +10 s skew, all
// three must produce the byte-identical replay).

export interface BufferedChunk {
  seq: number;
  /** The PHONE's capture timestamp. Passed through to the engine; NEVER a
   *  retention input — see the file header. */
  ts_ms: number;
  /** THIS process's clock at ingest. The ONLY value prune/since may compare. */
  recv_ms: number;
  payload: Buffer;
}

export class RingBuffer {
  private entries: BufferedChunk[] = [];
  private fedThroughSeq = Number.POSITIVE_INFINITY;
  private unfedGraceMs = 0;

  constructor(private windowMs: number) {
    if (windowMs <= 0) throw new RangeError('windowMs must be > 0');
  }

  /**
   * 🔴 RETENTION PIN (card RT-3, 2026-08-07). A chunk whose `seq` is ABOVE
   * `fedThroughSeq` has never been handed to ANY engine, so it is still OWED:
   * evicting it on a time window is losing content by construction — no engine can
   * transcribe audio it was never given, and nothing anywhere reports it.
   *
   * WHY A PIN AND NOT A BIGGER WINDOW. The window answers "how much
   * already-transcribed audio should a new engine get for context". Whether
   * unheard audio may be dropped is a different question, and the previous
   * answer to it was an accident of the first question's constant. Measured:
   * the ladder's own schedule (1+2+4 s) outruns its own 5 s ring, so a recovery
   * that needs the third rung silently loses 2.2 s of speech
   * (`test/stt-outage-loss.test.ts` CASE 1). Enlarging 5_000 would move that
   * cliff, not remove it — and picking the new number would be exactly the
   * "tuning a new number with no measurement behind it" this repo has already paid for once
   * (`text-merge.ts` OVERLAP_MIN_CHARS).
   *
   * ⚠️ `graceMs` IS THE MEMORY BOUND AND IT IS DERIVED, NOT CHOSEN: the caller
   * passes the ladder's total backoff budget, i.e. the longest a reconnect can
   * possibly take before it either succeeds or gives up. Past that point the
   * audio is owed to nobody, so it is evicted unconditionally. Worst case the
   * ring therefore holds `windowMs + graceMs` of audio instead of `windowMs`.
   *
   * 📌 THE DEFAULT (+∞ / 0) IS EXACTLY THE PRE-RT-3 BEHAVIOUR, so any holder
   * that never calls this — including every existing test — is unaffected.
   */
  setRetentionPin(fedThroughSeq: number, graceMs: number): void {
    this.fedThroughSeq = fedThroughSeq;
    this.unfedGraceMs = Math.max(0, graceMs);
  }

  /** Append and prune anything received longer ago than windowMs vs `now`.
   *  `now` MUST come from the same clock that stamped `recv_ms`; the default is
   *  the entry's own `recv_ms`, i.e. self-comparison. */
  push(chunk: BufferedChunk, now: number = chunk.recv_ms): void {
    this.entries.push(chunk);
    this.prune(now);
  }

  /** Return all chunks RECEIVED after `cutoff_recv_ms`, in seq order. The cutoff
   *  is on our own receive clock (`recv_ms`), not on the phone's `ts_ms`. */
  since(cutoff_recv_ms: number): BufferedChunk[] {
    return this.entries.filter((c) => c.recv_ms > cutoff_recv_ms);
  }

  /** card RT-3 — the READ half of the pin. Everything {@link since} would return,
   *  PLUS every chunk above `fedThroughSeq` no matter how old.
   *
   *  🔴 BOTH HALVES ARE REQUIRED and neither is worth anything alone. Keeping
   *  unheard audio in the ring while the replay still reads a 5 s window feeds
   *  the new engine nothing extra; reading past the window while pruning still
   *  evicts leaves nothing to read. That is the same "fixing one side = not fixed" shape
   *  columns ② and ③ of the card M3-4b table recorded (see stt-replay-clock.test.ts
   *  header) — and this file's own reverse control re-measures it per half. */
  sinceOrUnfed(cutoff_recv_ms: number, fedThroughSeq: number): BufferedChunk[] {
    return this.entries.filter((c) => c.recv_ms > cutoff_recv_ms || c.seq > fedThroughSeq);
  }

  /** Return all buffered chunks with seq in [from, to] inclusive. */
  range(from_seq: number, to_seq: number): BufferedChunk[] {
    return this.entries.filter((c) => c.seq >= from_seq && c.seq <= to_seq);
  }

  /** Drop entries RECEIVED longer ago than windowMs vs `now` (same clock as
   *  `recv_ms` — see the file header for why it may not be `ts_ms`). */
  prune(now: number): void {
    const cutoff = now - this.windowMs;
    const hardCutoff = cutoff - this.unfedGraceMs;
    while (this.entries.length) {
      const head = this.entries[0]!;
      if (head.recv_ms >= cutoff) break;
      // card RT-3: still owed to an engine that has not been given it yet — unless
      // it is older than even the grace budget, at which point no reconnect can
      // still be coming for it.
      if (head.seq > this.fedThroughSeq && head.recv_ms >= hardCutoff) break;
      this.entries.shift();
    }
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
