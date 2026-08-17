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
  /**
   * card QTA-2 (owner 2026-08-15: 「计费在 PC 和手机端都进行检查，两边有一方
   * 不满足都不能继续」) — resolve the PC OWNER's account for this socket's
   * paired PC. `auth.userId` is the acting account (`mobile.user_id ??
   * pc.user_id` — the phone's own when it has one); when the desktop is signed
   * into a DIFFERENT account, that second account's quota must also admit the
   * session. Absent (old wiring, tests that predate the card) ⇒ single-account
   * behaviour, which is also correct whenever the two ids are equal.
   */
  pcOwnerUserId?: (pc_device_id: string) => string | null;
}

/**
 * card K-5 — WHICH of `audio:start`'s four gates turned this press away.
 *
 * Before QTA-2 the log line "audio:start refused" + a code was enough, because
 * there was exactly one account and exactly one thing that could refuse. There
 * are now TWO accounts (acting phone / PC owner) and the same `QUOTA_EXCEEDED`
 * string comes out of both, so the line could name the failure without naming
 * WHOSE ledger produced it — and telling those two apart is precisely what cost
 * an afternoon of archaeology in the QTA-1 diagnosis.
 *
 * Ids, codes and the delivery intent only; never payload text (error-handling.ts
 * PRIVACY: audio frames carry user speech, the log file must not).
 */
type StartRefusalGate = 'payload' | 'acting' | 'pc_owner' | 'engine';

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
  function refuseStart(e: ErrorPayload, at: {
    gate: StartRefusalGate;
    /** The account this gate JUDGED — not always the acting one (see K-5). */
    userId: string | null;
    /** null only on the payload arm, where there is no parsed frame to read it from. */
    delivery: Delivery | null;
  }): void {
    log.warn('audio:start refused', {
      code: e.error,
      message: e.message ?? null,
      room: getRoomUuid(socket),
      gate: at.gate,
      user_id: at.userId,
      delivery: at.delivery,
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
      refuseStart(e, { gate: 'payload', userId: auth.userId, delivery: null });
      return safeAck(ack, e);
    }

    // 🔴 card K-1 — READ THE DELIVERY INTENT BEFORE THE GATE THAT DEPENDS ON IT.
    //
    // This const used to live ~30 lines below, immediately before the fan-out.
    // Everything above it therefore ran WITHOUT KNOWING whether this utterance
    // targets a PC at all — including the QTA-2 PC-owner quota check, which is
    // only meaningful when it does. That is this repo's canonical structural
    // bug (CLAUDE.md R11): the layer making the judgement did not have the fact
    // it needed, and the fact was sitting two statements away in `parsed.data`.
    //
    // NOTE (delivery red line): delivery:'none' entries are record-only — the
    // server must NOT initiate injection and the PC capsule must not surface.
    // That branch lives in the finalize path the R1-3 orchestrator drives; the
    // intent is fixed here and passed through immutably.
    const delivery: Delivery = parsed.data.delivery ?? 'inject';

    // *** billing call site (STT quota) — the ONE ensureQuota('stt') site ***
    // Live now (standalone NOOP). Over-quota fails loud → QUOTA_EXCEEDED.
    //
    // card QTA-2 — BOTH accounts must admit the session (owner 2026-08-15,
    // correcting his own earlier one-side ruling in the same conversation:
    // 「两边有一方不满足都不能继续」). `auth.userId` is who the minutes are
    // METERED to (the acting account — the phone's own when the pairing has
    // one); the PC owner's account is checked as a GATE only, never billed —
    // one recording must not decrement two ledgers for the same seconds.
    //
    // 🔴 card K-1 — and the SECOND account is asked only when the utterance is
    // actually going to that account's machine. A record-only press is one the
    // PC is contractually forbidden to hear anything at all about (the GA-02 red
    // line enforced by `mirrorToPc` above); judging it against that PC's ledger
    // would let a desktop's exhausted minutes silence a recording that never
    // leaves the phone — a refusal whose stated reason ("quota") is true of an
    // account this utterance does not touch.
    // ⚠️ The FIRST check stays unconditional: the acting account's own minutes
    // are spent transcribing either way, whoever the words end up in front of.
    let gate: StartRefusalGate = 'acting';
    let judged = auth.userId;
    try {
      guard.ensureQuota(auth.userId, 'stt');
      if (delivery !== 'none') {
        const pcUserId = deps.pcOwnerUserId?.(auth.deviceId ?? '') ?? null;
        if (pcUserId !== null && pcUserId !== auth.userId) {
          gate = 'pc_owner';
          judged = pcUserId;
          guard.ensureQuota(pcUserId, 'stt');
        }
      }
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
      //
      // 🔴 2026-08-17 (owner ruling) — AND SAY WHOSE QUOTA REFUSED. `auth.userId`
      // is whose attempt this was; `judged` is whose ceiling was hit, and since
      // QTA-2 they are two different accounts whenever the desktop is signed
      // into another one. The row used to carry only the first, so it asserted
      // that the phone's account was out of minutes in exactly the case where
      // its account was fine — the row's SUBJECT was wrong. `judged` is the same
      // value K-5 puts in the log line below (`gate` + `user_id`); this makes it
      // durable, because the journal rotates and the ledger is what a billing
      // question gets answered from months later. `user_id`'s meaning is
      // untouched, so rows written before today still mean what they meant.
      if (e.error === 'QUOTA_EXCEEDED') usageTracker.recordQuotaRefusal(auth.userId, 'stt', judged);
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
      refuseStart(e, { gate, userId: judged, delivery });
      return safeAck(ack, e);
    }

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

    // 🔴 card K-3 — THE INVARIANT THIS BLOCK EXISTS TO HOLD:
    //   no statement between the auth check and the ack may sit outside a block
    //   that ends in a NAMED FRAME.
    //
    // The fan-out emit and the session install used to sit BETWEEN the quota
    // catch and the engine try — guarded by neither. Both can throw: `put()`
    // disposes a same-key survivor, and `SttSessionBridge.dispose()` runs
    // `orchestrator.close()`, `session.finalize()` and `vad.finish()` with only
    // the middle one wrapped. A throw there was caught by `wrapSocketHandlers`,
    // which rate-gate logs it and DROPS the event: no ack, no `stt:error` — the
    // phone holds the button down against a server that has already given up.
    // A dead mic and total silence is the exact shape QTA-1 was about, one
    // window over. Reaching the ack is not the same as reaching an answer.
    //
    // `state` is nullable ONLY so the catch can tell "we never got a slot" from
    // "we got one and the engine failed"; it is non-null for every line that
    // reads it below.
    let state: AudioSessionState | null = null;
    try {
      if (fannedOut && roomUuid) store.getPc(roomUuid)?.emit('audio:start', parsed.data);

      // Install the session slot BEFORE building the engine: a same-key survivor
      // (previous utterance, or a session still inside its grace window) is
      // disposed first — a new audio:start is a new utterance — and the fan-out
      // bookkeeping survives an engine build failure, so a later audio:stop still
      // mirrors the edge the PC did see begin.
      const key = keyOf();
      if (key !== null && sessions && roomUuid !== null && auth.pairingId) {
        state = sessions.put({ key, roomUuid, pairingId: auth.pairingId, socket, fannedOut });
      } else {
        local.orchestrator?.dispose();
        local.orchestrator = null;
        local.paused = false;
        local.fannedOut = fannedOut;
        state = local;
      }
      const slot: AudioSessionState = state;

      if (!deps.sttFactory) throw new EngineNotWiredError('stt');
      slot.orchestrator = deps.sttFactory({
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
          slot !== local
            ? (): Pick<Socket, 'emit'> | null => (slot as AudioSessionEntry).socket
            : (): Socket => socket,
        onComplete: (durationMs, isByok, chars) => commitSttUsage(auth.userId, durationMs, isByok, chars),
        onPolishUsage: (tIn, tOut, isByok) => commitPolishUsage(auth.userId, tIn, tOut, isByok),
      });
      safeAck(ack, { ok: true });
    } catch (err) {
      // K-3: null when the throw happened at the fan-out, i.e. before any slot
      // was installed. There is then nothing to clear, and clearing `local`
      // regardless would tear down a session this press never created.
      if (state) state.orchestrator = null;
      // #16 no-implicit-fallback: the router's SttConfigMissingError (not a
      // ServerError) carries its own whitelisted code; anything else goes
      // through errorPayload. Either way it is fail-loud, never swallowed.
      // ⚠️ That first sentence used to read 「maps to the whitelisted
      // STT_CONFIG_MISSING」 and card C1 made it false in the same edit that
      // fixed the line below — corrected here rather than left as an expired
      // truth, which is the anti-façade ④ rule (a comment asserting behaviour
      // elsewhere goes stale silently, because nothing recompiles a sentence).
      // 🔴 card C1 (2026-08-17): `err.code`, NEVER the literal. Selection ending
      // in nothing has two causes and two registered sentences — 「你没配引擎」 and
      // 「我们的池子没有可用线路」 — and the thrower is the only layer that holds
      // the fact that separates them (engine-factory.ts). Hard-coding one here is
      // what made the relay tell users to go configure engines that were already
      // configured. Both codes are whitelisted registry entries.
      const e: ErrorPayload = err instanceof SttConfigMissingError
        ? { error: err.code, message: err.message }
        : errorPayload(err);
      // 🔴 card K-4 — through `refuseStart`, not a bare emit. This arm used to
      // emit `stt:error` by hand, which meant it produced the FRAME but not the
      // LOG LINE the other three arms write. QTA-1's diagnosis rested on the
      // relay journal being able to say a press was turned away; on this arm —
      // the engine arm, the one that fires when STT is misconfigured — the
      // journal stayed empty, so half of QTA-1 never reached the failure most
      // likely to need it. The wire message is preserved verbatim by filling the
      // fallback here rather than letting refuseStart's generic one apply.
      refuseStart(
        { ...e, message: e.message ?? 'STT engine unavailable' },
        { gate: 'engine', userId: auth.userId, delivery },
      );
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
