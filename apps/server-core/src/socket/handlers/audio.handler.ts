// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3 (audio:start/chunk/pause/resume/stop;
//     stt:error; pause/resume are M→S AND S→PC)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (F-2135 mobile drop grace: the audio
//     session survives a brief socket drop and resumes on the new socket)
//   docs/strategy/2026-07-23-mock-billing-design.md §3/§5 (ensureQuota('stt') has
//     exactly 1 entry point, audio:start; recordSttUsage has exactly 1 session-end call site)
//   docs/strategy/R1-TASK-CARDS.md WP-R1-3 (audio/STT engine layer)
//   docs/strategy/2026-07-23-master... §4.0 (delivery:'none' = record-only: server
//     never initiates injection)
//   CLAUDE.md red line: no silent failure; no silent truncation
//
// The audio MOUNT POINT. audio:start runs the single STT quota gate, fixes the
// per-utterance delivery intent, then hands off to the STT orchestrator seam.
// The engine implementations are R1-3 — until an sttFactory is supplied the
// handoff FAILS LOUD (stt:error with a whitelisted code), never a swallowed
// promise or a silent truncation. The two billing call sites are placed here,
// each exactly once (mock-billing §5).
//
// GA-04: session state is NOT a per-socket closure any more. A paired mobile's
// session lives in the AudioSessionRegistry under `(roomUuid, pairingId)`, so a
// disconnect starts a grace window instead of disposing, and the reconnected
// socket resolves the SAME session by key. A socket without both halves of the
// key (unpaired / room-less) keeps the old socket-lifetime behaviour through the
// local slot below — never a crash, never a leaked engine.

import type { Server, Socket } from 'socket.io';
import { safeParseEvent, type Delivery } from '@flowmic/protocol';
import type { QuotaGuard } from '../../billing/quota-guard';
import type { UsageTracker } from '../../billing/usage-tracker';
import type { RoomStore } from '../../room/store';
import type { SttOrchestrator } from '../../engine/orchestrator';
import type { SttCharCounts } from '../../engine/stt-session-deps';
import { EngineNotWiredError } from '../../engine/orchestrator';
import {
  audioSessionKey, publishAudioSessions,
  type AudioSessionRegistry, type AudioSessionState, type AudioSessionEntry,
} from '../../engine/audio-registry';
import { SttConfigMissingError } from '../../stt/engine-router';
import { errorPayload, type ErrorPayload } from '../../errors';
import { getAuth, getRoomUuid, safeAck } from '../wire';
import { markAudioStop } from '../../obs/latency';
import { log } from '../../log';

export interface SttStartArgs {
  userId: string;
  mode: 'realtime' | 'translate' | 'organize';
  delivery: Delivery;
  sourceLang: string;
  targetLang?: string;
  /** GA-04: the stt:* emitter must follow the session across a reconnect, so the
   *  mobile leg is resolved PER FRAME instead of closing over the socket that
   *  happened to send audio:start. Absent → the factory falls back to that
   *  socket (unpaired/local sessions, and every pre-GA-04 call site). */
  resolveSocket?: () => Pick<Socket, 'emit'> | null;
  /** Called exactly once by the orchestrator (R1-3) at session finalize.
   *
   *  A2-5 — `chars` is the third argument the seam grew so the per-event usage
   *  log can answer "how many characters were spoken this time / how many were sent out". See [[SttCharCounts]] for why
   *  it had to travel here rather than be defaulted at the table. */
  onComplete(durationMs: number, isByok: boolean, chars: SttCharCounts): void;
  /** v0.2.3 — the polish LLM's usage, once per polished terminal-final and only
   *  when the model reported it. See the metering note on commitPolishUsage. */
  onPolishUsage?(tokensIn: number, tokensOut: number, isByok: boolean): void;
}

export interface AudioHandlerDeps {
  io: Server;
  guard: QuotaGuard;
  usageTracker: UsageTracker;
  /** Room presence — the S→PC audio fan-out target (WP-R2-1b, F-2375). */
  store: RoomStore<Socket>;
  /** GA-04 session ownership. Absent → sessions stay socket-scoped (old behaviour). */
  sessions?: AudioSessionRegistry;
  /** STT engine seam (R1-3). Absent in R1-2 → the handler fails loud. */
  sttFactory?: (args: SttStartArgs) => SttOrchestrator;
}

export function registerAudioHandlers(socket: Socket, deps: AudioHandlerDeps): void {
  const { guard, usageTracker, store, sessions } = deps;
  // The fallback slot for a socket that has no (roomUuid, pairingId) key: the
  // session lives and dies with the socket, exactly as before GA-04.
  const local: AudioSessionState = { orchestrator: null, paused: false, fannedOut: false };

  // Publish the registry on the socket so mobile.handler's reconnect path can
  // rebind with one call (adoptAudioSession) and no deps-interface change.
  if (sessions) publishAudioSessions(socket, sessions);

  /** The ownership key for THIS socket's pairing, or null (→ local slot). */
  function keyOf(): string | null {
    if (!sessions) return null;
    const auth = getAuth(socket);
    const roomUuid = getRoomUuid(socket);
    if (!auth || auth.kind !== 'mobile' || !auth.pairingId || roomUuid === null) return null;
    return audioSessionKey(roomUuid, auth.pairingId);
  }

  /** Resolve the live session for an inbound frame. A registry entry still bound
   *  to a dead socket is adopted here as well: a reconnected mobile that resumes
   *  streaming rebinds even if the explicit mobile:reconnect hook did not fire
   *  (belt-and-braces — it also re-points the stt:* emitter at this socket). */
  function current(): AudioSessionState | null {
    const key = keyOf();
    if (key === null || !sessions) return local;
    const entry = sessions.get(key);
    if (!entry) return null;
    if (entry.socket !== socket) sessions.adopt(key, socket);
    return entry;
  }

  // *** billing call site (STT metering) — the ONE recordSttUsage site ***
  // Effective once R1-3's orchestrator invokes onComplete; dormant under the
  // stub (no session is ever created), so nothing double-counts.
  function commitSttUsage(userId: string, durationMs: number, isByok: boolean, chars: SttCharCounts): void {
    usageTracker.recordSttUsage(userId, { is_byok: isByok }, durationMs, chars);
  }

  // *** billing call site (LLM metering) — the SECOND recordLlmUsage site ***
  //
  // v0.2.3. The mock-billing design says recordLlmUsage has EXACTLY ONE site, and
  // for 0.1.0 that was true and deliberate: polish was scoped out. The cost of
  // that scope-out only became visible in production — owner 2026-07-29 read
  // "LLM tokens 0 / 250000" while polish had been running on every utterance.
  // A meter that cannot move is not a conservative meter, it is a false one.
  //
  // So the invariant is now "exactly TWO sites", and it is asserted rather than
  // remembered (billing-call-sites.test.ts). Two is the number of things that
  // actually call an LLM: the compose turn and the polish pass.
  function commitPolishUsage(userId: string, tokensIn: number, tokensOut: number, isByok: boolean): void {
    usageTracker.recordLlmUsage(userId, { is_byok: isByok }, tokensIn, tokensOut);
  }

  /** Mirror an utterance-lifecycle edge to the paired PC — iff this utterance
   *  was fanned out at audio:start. Record-only (delivery:'none') never is, so
   *  the PC hears nothing at all about an utterance that stayed on the phone
   *  (GA-02 red line). The event literal stays at the call site (whitelist lint). */
  function mirrorToPc(state: AudioSessionState, send: (pc: Socket) => void): void {
    if (!state.fannedOut) return;
    const roomUuid = getRoomUuid(socket);
    if (!roomUuid) return;
    const pc = store.getPc(roomUuid);
    if (pc) send(pc);
  }

  /** Mirror a PHONE-lifecycle edge (pause/resume) to the paired PC. Two cases,
   *  deliberately different — and the second one is card F1's whole seam:
   *
   *  - an utterance IS in flight (`state !== null`) → ride [[mirrorToPc]], so a
   *    record-only (delivery:'none') utterance still tells the PC nothing at all
   *    (GA-02 red line, asserted by the zero-frames test below);
   *  - NO utterance in flight (`state === null`) → mirror anyway. `current()`
   *    answers null ONLY for an authenticated mobile that owns a pairing inside a
   *    room but has no live session — i.e. a paired phone BETWEEN utterances. That
   *    is exactly "the user just switched windows", and owner ruling ① says the PC must read it
   *    as "paused". Before this, the frame died here: the phone emitted it and the
   *    PC had nowhere to receive it, so both halves could look correct forever.
   *
   *  ⚠️ NOT a protocol change — same two whitelisted events, same schemas, same
   *  direction. The only thing that changed is which frames survive the trip. */
  function mirrorPhoneLifecycleToPc(state: AudioSessionState | null, send: (pc: Socket) => void): void {
    if (state !== null) return mirrorToPc(state, send);
    const roomUuid = getRoomUuid(socket);
    if (!roomUuid) return;
    const pc = store.getPc(roomUuid);
    if (pc) send(pc);
  }

  /**
   * 🔴 QTA-1 (2026-08-15) — SAY THE REFUSAL OUT LOUD, on the wire and in the log.
   *
   * MEASURED, tablet TB335ZC + relay journal, 2026-08-15 17:21:40Z+8:
   * held the talk button 4 s inside a cloud-relay PC instance. `AudioRecord ...
   * 16000 Hz packageName app.flowmic.android` in logcat (the mic really opened),
   * one live TLS socket to the relay (`/proc/net/tcp`, uid 10309 → :443), and
   * then: NOTHING. No route selection, no `audio intake`, no line of any kind in
   * the relay journal — and nothing on the phone either. The same gesture in the
   * record-only instance two minutes earlier logged the full trace.
   *
   * Cause: the two refusal arms below returned through `safeAck` ALONE, and
   * `quota-guard.ts`'s own header already records that nobody reads that ack —
   * the phone emits `audio:start` fire-and-forget (`ptt_session.dart` pttDown).
   * So an over-quota account got: no text, no error, no log. Both ends silent
   * about a user being turned away is the red line ("没有静默失败"), and it also
   * cost an afternoon of archaeology to attribute, which is the second reason
   * the `log.warn` is here and not only the frame.
   *
   * ⚠️ WHY `stt:error` AND NOT A NEW EVENT / A FIXED ACK READER: this arrives at
   * every phone ALREADY IN THE FIELD. `ptt_inbound.dart` has caught terminal
   * `stt:error` since ENG-3 and `onSttTerminalError` deliberately handles the
   * RECORDING case ("exactly when a cold-open failure on `audio:start` arrives"),
   * latching it until the press ends; `sttStallBannerMessage` then keys on the
   * WIRE CODE. So a 0.3.1 build that will never be updated still says something
   * true. Zero protocol change: same whitelisted event, same schema, same
   * direction — only which frames survive the trip.
   *
   * ⚠️ It does NOT cover the `AUTH_TOKEN_INVALID` arm above on purpose: that
   * socket is not an authenticated mobile, it has its own re-pair surface, and
   * dressing an auth failure as an engine fault would be the 0.2.53 shape again.
   */
  function refuseStart(e: ErrorPayload): void {
    log.warn('audio:start refused', {
      code: e.error,
      message: e.message ?? null,
      room: getRoomUuid(socket),
    });
    socket.emit('stt:error', {
      code: e.error,
      message: e.message ?? 'audio:start refused',
      retryable: false,
    });
  }

  socket.on('audio:start', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth || auth.kind !== 'mobile') return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const parsed = safeParseEvent('audio:start', payload);
    if (!parsed.success) {
      const e: ErrorPayload = { error: 'STT_CONFIG_MISSING', message: 'invalid audio:start payload' };
      refuseStart(e);
      return safeAck(ack, e);
    }

    // *** billing call site (STT quota) — the ONE ensureQuota('stt') site ***
    // Live now (standalone NOOP). Over-quota fails loud → QUOTA_EXCEEDED.
    try {
      guard.ensureQuota(auth.userId, 'stt');
    } catch (err) {
      const e = errorPayload(err);
      // A2-5 — record that this user was TURNED AWAY. Until this card a quota
      // refusal left nothing anywhere: the guard throws and writes no row, and
      // on THIS leg the phone emits `audio:start` fire-and-forget, so the ack
      // below has no reader either (quota-guard.ts's own header says so). Both
      // ends silent about a refusal is a violation of "no silent failure" in the storage face.
      //
      // 🔴 GATED ON THE CODE, not on "the try block threw". `ensureQuota` also
      // reaches `effectiveLimits`, which can fail for reasons that are not a
      // refusal at all — recording those as `quota_refused` would be a row that
      // confidently states the wrong cause, which is worse than no row.
      if (e.error === 'QUOTA_EXCEEDED') usageTracker.recordQuotaRefusal(auth.userId, 'stt');
      // QTA-1 — and SAY it. `recordQuotaRefusal` above writes a row that is
      // invisible in production anyway (`FLOWMIC_USAGE_EVENTS_ENABLED` is unset
      // on the relay — measured 2026-08-15, boot line "per-event usage log
      // DISABLED"), so until this line the refusal existed nowhere a human or a
      // phone could reach it.
      //
      // REVERSE CONTROL (2026-08-15, dev-pc-a): deleting this one line
      // turns `audio-start-refusal-is-spoken.test.ts` from 5 passed to
      // 「2 failed | 3 passed」, first message 「expected [] to have a length of
      // 1」 — i.e. the silence itself. The parse arm above was measured the same
      // way and fails its own row alone.
      refuseStart(e);
      return safeAck(ack, e);
    }

    const delivery: Delivery = parsed.data.delivery ?? 'inject';
    // NOTE (delivery red line): delivery:'none' entries are record-only — the
    // server must NOT initiate injection and the PC capsule must not surface.
    // That branch lives in the finalize path the R1-3 orchestrator drives; the
    // intent is fixed here and passed through immutably.

    // WP-R2-1b (F-2375): S→PC audio fan-out. The session is accepted (quota gate
    // passed), so additively re-emit the VALIDATED audio:start to the paired PC
    // — the desktop drives its SPEAKING lock (audio:start → lock the live
    // foreground) off this. Same event name: no new event, no whitelist/count-
    // guard/schema change (04 §3.3 doc rev only), mirroring relay.handler's
    // inject:request forward. Record-only (delivery:'none') is NEVER fanned out:
    // the PC must not surface/lock for an utterance the user keeps on the phone
    // (master-plan §4 / CLAUDE.md red line "stays on the phone"). Independent of STT engine
    // wiring — the lock is about focus capture at speak-start, not STT success.
    const roomUuid = getRoomUuid(socket);
    const fannedOut = delivery !== 'none' && roomUuid !== null;
    if (fannedOut && roomUuid) store.getPc(roomUuid)?.emit('audio:start', parsed.data);

    // Install the session slot BEFORE building the engine: a same-key survivor
    // (previous utterance, or a session still inside its grace window) is
    // disposed first — a new audio:start is a new utterance — and the fan-out
    // bookkeeping survives an engine build failure, so a later audio:stop still
    // mirrors the edge the PC did see begin.
    const key = keyOf();
    let state: AudioSessionState;
    if (key !== null && sessions && roomUuid !== null && auth.pairingId) {
      state = sessions.put({ key, roomUuid, pairingId: auth.pairingId, socket, fannedOut });
    } else {
      local.orchestrator?.dispose();
      local.orchestrator = null;
      local.paused = false;
      local.fannedOut = fannedOut;
      state = local;
    }

    try {
      if (!deps.sttFactory) throw new EngineNotWiredError('stt');
      state.orchestrator = deps.sttFactory({
        userId: auth.userId,
        mode: parsed.data.mode,
        delivery,
        sourceLang: parsed.data.source_lang,
        ...(parsed.data.target_lang !== undefined ? { targetLang: parsed.data.target_lang } : {}),
        // GA-04: the mobile leg follows the SESSION, not this socket. During a
        // grace window it resolves to null (nothing to emit to — the phone is
        // gone, not silently dropped); after a rebind it is the new socket.
        //
        // BUGFIX (owner real-chain UAT 2026-07-26): resolve against the captured
        // ENTRY, not a live `sessions.get(key)`. audio:stop DETACHES the entry
        // (deletes the map key) BEFORE finish() flushes the engine's terminal
        // final — so a map lookup returned null and the terminal stt:final was
        // emitted to NOTHING on every normal stop (interims survived because the
        // entry was still mapped during audio:chunk). detach() leaves
        // `entry.socket` intact, so the captured entry still points at the live
        // phone through the flush, while grace (socket=null) / rebind (new
        // socket) still resolve correctly because adopt/beginGrace mutate THIS
        // same object. `?? socket` covers the local (unpaired) fallthrough.
        resolveSocket:
          state !== local
            ? (): Pick<Socket, 'emit'> | null => (state as AudioSessionEntry).socket
            : (): Socket => socket,
        onComplete: (durationMs, isByok, chars) => commitSttUsage(auth.userId, durationMs, isByok, chars),
        onPolishUsage: (tIn, tOut, isByok) => commitPolishUsage(auth.userId, tIn, tOut, isByok),
      });
      safeAck(ack, { ok: true });
    } catch (err) {
      state.orchestrator = null;
      // #16 no-implicit-fallback: the router's SttConfigMissingError (not a
      // ServerError) maps to the whitelisted STT_CONFIG_MISSING; anything else
      // goes through errorPayload. Either way it is fail-loud, never swallowed.
      const e: ErrorPayload = err instanceof SttConfigMissingError
        ? { error: 'STT_CONFIG_MISSING', message: err.message }
        : errorPayload(err);
      socket.emit('stt:error', { code: e.error, message: e.message ?? 'STT engine unavailable', retryable: false });
      safeAck(ack, e);
    }
  });

  socket.on('audio:chunk', (payload: unknown) => {
    const parsed = safeParseEvent('audio:chunk', payload);
    if (!parsed.success) return;
    const state = current();
    if (!state?.orchestrator) return; // no live session → drop
    // NOT a silent discard: the user (or the OS lifecycle) explicitly asked for
    // this utterance to pause, so the engine must not be fed. The mobile keeps
    // its seq monotonic (08 §3) and audio:resume re-opens the feed.
    if (state.paused) return;
    state.orchestrator.pushChunk(parsed.data.seq, parsed.data.data_b64, parsed.data.ts_ms);
  });

  // 04 §3.3 M→S→PC. GA-04 fills in the server leg that was pure façade: the
  // mobile has emitted pause/resume since WP-R3-2 and nobody listened.
  // Card F1: `if (!state) return` used to drop every IDLE pause — see
  // [[mirrorPhoneLifecycleToPc]]. The engine-feed latch still needs a session, so
  // it stays conditional; the PC mirror does not, so it no longer is.
  socket.on('audio:pause', (payload: unknown) => {
    const parsed = safeParseEvent('audio:pause', payload);
    if (!parsed.success) return;
    const state = current();
    if (state) state.paused = true;
    mirrorPhoneLifecycleToPc(state, (pc) => pc.emit('audio:pause', parsed.data));
  });

  socket.on('audio:resume', (payload: unknown) => {
    const parsed = safeParseEvent('audio:resume', payload ?? {});
    if (!parsed.success) return;
    const state = current();
    if (state) state.paused = false;
    mirrorPhoneLifecycleToPc(state, (pc) => pc.emit('audio:resume', parsed.data));
  });

  socket.on('audio:stop', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('audio:stop', payload);
    if (!parsed.success) return safeAck(ack, { error: 'STT_CONFIG_MISSING' });
    // V2-05 (requirement ⑥) t0 — the user let go. Everything downstream is measured from
    // here, on this clock only; see obs/latency.ts for why no phone timestamp is
    // ever subtracted from a server one.
    const latencyRoom = getRoomUuid(socket);
    if (latencyRoom !== null) markAudioStop(latencyRoom);
    const key = keyOf();
    // Detach (not dispose): the orchestrator is handed to the finish → dispose
    // chain below, and the slot must be free for the next utterance.
    const state = key !== null && sessions ? sessions.detach(key) : local;
    if (state) {
      // WP-R2-1b (F-2375): mirror the speak-ended edge to the PC iff this
      // utterance's audio:start was fanned out (record-only was never mirrored).
      // The desktop does NOT release its lock here (ruling 2) — this is the
      // speak-ended signal only.
      mirrorToPc(state, (pc) => pc.emit('audio:stop', parsed.data));
      state.fannedOut = false;
      state.paused = false;
      if (state.orchestrator) {
        // finish() flushes the terminal final (+ the single recordSttUsage) THEN
        // dispose() tears down — never dispose mid-flush (would drop the final).
        const s = state.orchestrator;
        state.orchestrator = null;
        void s.finish().catch((err) => console.error('[audio.handler] finish error:', err)).finally(() => s.dispose());
      }
    }
    safeAck(ack, { ok: true });
  });

  socket.on('disconnect', () => {
    const key = keyOf();
    if (key !== null && sessions) {
      // GA-04: the session OUTLIVES the socket. A mobile that returns inside the
      // grace window resumes this very orchestrator (SeqTracker intact) and the
      // PC never learns it was away; only expiry disposes. bootstrap appends the
      // presence half (leaveMobile + pc:mobile-left) to the SAME window.
      sessions.beginGrace(key, undefined, socket.id);
      return;
    }
    local.orchestrator?.dispose();
    local.orchestrator = null;
  });
}
