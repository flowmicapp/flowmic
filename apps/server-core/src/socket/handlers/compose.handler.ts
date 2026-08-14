// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.4 (compose:start/chunk/done/error)
//   docs/strategy/2026-07-23-mock-billing-design.md §3/§5 (ensureQuota('llm') has
//     EXACTLY 1 entry point, compose:start; recordLlmUsage has EXACTLY 1
//     session-closing site)
//   docs/strategy/R1-TASK-CARDS.md WP-R1-4 (compose + scenario pipeline)
//   CLAUDE.md red line: LLM failure → explicit compose:error + status records the
//     truth, never silently falls back to injecting the raw STT text
//
// The compose MOUNT POINT. compose:start runs the single LLM quota gate, then
// hands off to the compose orchestrator seam (R1-4). Until a composeFactory is
// supplied the handoff FAILS LOUD (compose:error with a whitelisted code) —
// crucially it does NOT silently fall back to injecting the raw STT text. The
// two billing call sites are placed here, each exactly once.

import type { Server, Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import type { QuotaGuard } from '../../billing/quota-guard';
import type { UsageTracker } from '../../billing/usage-tracker';
import type { RoomStore } from '../../room/store';
import type { ComposeOrchestrator } from '../../engine/orchestrator';
import { EngineNotWiredError } from '../../engine/orchestrator';
import { type ComposeStartArgs, readComposeUsage, readComposeOutput, ComposeOutputRejectedError } from '../../compose';
import { errorPayload } from '../../errors';
import { getAuth, getRoomUuid, safeAck } from '../wire';

export type { ComposeStartArgs };

export interface ComposeHandlerDeps {
  io: Server;
  guard: QuotaGuard;
  usageTracker: UsageTracker;
  /** Room presence — the source of the room's latest focus process_name
   *  (§4.1 app-scenario source ②, mirrored from the focus:state relay). */
  store: RoomStore<Socket>;
  /** Compose engine seam (R1-4). Absent in R1-2 → the handler fails loud.
   *  Wired in bootstrap as createComposeFactory({ settings: db.settings,
   *  usage: usageTracker }). */
  composeFactory?: (args: ComposeStartArgs) => ComposeOrchestrator;
}

/** 🔴 Card F3 defect ③ — the echo for a frame we refused BEFORE parsing it.
 *
 * The happy path builds its echo from `parsed.data`; these two refusals have no
 * `parsed.data` by definition (one never authenticated, the other failed the
 * schema), so the correlation ids are read straight off the raw frame. Every
 * field is checked rather than asserted — an unauthenticated peer controls this
 * object, and ComposeErrorSchema types both ids as NonEmpty, so a wrong-typed or
 * empty id is dropped instead of forwarded.
 *
 * Dropping is not merely tidy: the ECHO IS WHAT MAKES THE REFUSAL LAND. Both
 * mobile consumers (`ai_compose_controller.dart` onEvent,
 * `utterance_compose.dart` onEvent) start with
 * `e.requestId == null || e.requestId != _requestId → return`, so a
 * compose:error with no usable request_id is received and then discarded by the
 * phone — the run would still end on the 45 s watchdog as `timeout`. Forwarding
 * `123` or `''` would be discarded one step earlier, at
 * `AiComposeError.tryFromJson`/`_echo`. Either way the user gets the wrong wall
 * named, so the id is carried through verbatim whenever the frame has a usable
 * one, and a frame that never carried one is a residual this card does NOT fix
 * (fixing it means letting the phone attribute an id-less error to its single
 * in-flight run — a mobile change with its own crosstalk question).
 */
function rawEcho(payload: unknown): { request_id?: string; entry_id?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const raw = payload as Record<string, unknown>;
  const requestId = raw['request_id'];
  const entryId = raw['entry_id'];
  return {
    ...(typeof requestId === 'string' && requestId.length > 0 ? { request_id: requestId } : {}),
    ...(typeof entryId === 'string' && entryId.length > 0 ? { entry_id: entryId } : {}),
  };
}

export function registerComposeHandlers(socket: Socket, deps: ComposeHandlerDeps): void {
  const { guard, usageTracker } = deps;

  // *** billing call site (LLM metering) — the ONE recordLlmUsage site ***
  function commitLlmUsage(userId: string, tokensIn: number, tokensOut: number, isByok: boolean): void {
    usageTracker.recordLlmUsage(userId, { is_byok: isByok }, tokensIn, tokensOut);
  }

  socket.on('compose:start', async (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    // 🔴 Card F3 defect ③ — A REFUSAL HAS TO REACH THE PHONE, NOT JUST THE ACK.
    //
    // These two returns used to be `safeAck` only. The phone emits compose:start
    // WITHOUT an ack callback (`compose_gate.dart` `_emit` — one `emit`, no
    // third argument), which is not an oversight there either: every compose
    // terminal is an EVENT (chunk/done/error), so the ack has no receiver. ⇒ a
    // refusal answered with `safeAck` alone was physically undeliverable, and
    // the phone's only terminal for these two cases was its 45 s watchdog, which
    // then reported `timeout` — naming the wrong wall for a run the server
    // refused in a millisecond. No silent failure, and R3's local watchdog is a net
    // for a frame that never comes, not a substitute for one the server chose
    // not to send.
    //
    // Same code on both channels (event + ack): one refusal, one name.
    if (!auth) {
      socket.emit('compose:error', {
        code: 'AUTH_TOKEN_INVALID',
        message: 'not authenticated',
        ...rawEcho(payload),
      });
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    const parsed = safeParseEvent('compose:start', payload);
    if (!parsed.success) {
      socket.emit('compose:error', {
        code: 'LLM_INVALID_MODEL',
        message: 'invalid compose:start payload',
        ...rawEcho(payload),
      });
      return safeAck(ack, { error: 'LLM_INVALID_MODEL', message: 'invalid compose:start payload' });
    }
    const requestId = parsed.data.request_id;
    const entryId = parsed.data.entry_id;
    const echo = {
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      ...(entryId !== undefined ? { entry_id: entryId } : {}),
    };

    // *** billing call site (LLM quota) — the ONE ensureQuota('llm') site ***
    try {
      guard.ensureQuota(auth.userId, 'llm');
    } catch (err) {
      const e = errorPayload(err);
      // A2-5 — the same refusal record as the STT leg (see audio.handler.ts for
      // the full argument), gated on the CODE rather than on 「it threw」: this
      // catch also covers a failure inside `effectiveLimits`, and a row saying
      // "blocked by quota" about a lookup that exploded would name the wrong cause.
      // ⚠️ Unlike the STT leg, this refusal IS rendered by the phone
      // (compose_strings.dart 'QUOTA_EXCEEDED'); the row is for the ops/user
      // usage view, not a substitute for the message.
      if (e.error === 'QUOTA_EXCEEDED') usageTracker.recordQuotaRefusal(auth.userId, 'llm');
      socket.emit('compose:error', { code: e.error, message: e.message ?? 'quota exceeded', ...echo });
      return safeAck(ack, e);
    }

    try {
      if (!deps.composeFactory) throw new EngineNotWiredError('compose');
      // §4.1 source ②: the room's latest PC focus process_name (from the
      // focus:state relay, tracked in the room store) → app-scenario descriptor.
      // Absent (no PC focus seen / PC gone) → undefined → no app-context line.
      const roomUuid = getRoomUuid(socket);
      const processName = roomUuid ? deps.store.getFocusProcess(roomUuid) : undefined;
      const orchestrator = deps.composeFactory({
        userId: auth.userId,
        task: parsed.data.task,
        sourceText: parsed.data.source_text,
        ...(parsed.data.source_lang !== undefined ? { sourceLang: parsed.data.source_lang } : {}),
        ...(parsed.data.target_lang !== undefined ? { targetLang: parsed.data.target_lang } : {}),
        ...(processName !== undefined ? { processName } : {}),
      });
      let output = '';
      for await (const delta of orchestrator.run({
        task: parsed.data.task,
        source_text: parsed.data.source_text,
        ...(parsed.data.source_lang !== undefined ? { source_lang: parsed.data.source_lang } : {}),
        ...(parsed.data.target_lang !== undefined ? { target_lang: parsed.data.target_lang } : {}),
      })) {
        output += delta;
        socket.emit('compose:chunk', { delta, ...echo });
      }
      // Real token counts + BYOK flag from the orchestrator (R1-4). BYOK usage
      // is NOOP-metered downstream (mock-billing §5); unknown counts stay 0.
      const usage = readComposeUsage(orchestrator);
      commitLlmUsage(auth.userId, usage.tokensIn, usage.tokensOut, usage.isByok);
      // W2-2: the guard may have stripped a wrapper the model added (a code
      // fence, quotes around the whole answer). That repair has to land on the
      // field the phone actually uses, or it repaired nothing — both consumers
      // take compose:done's output_text VERBATIM in preference to the chunks
      // they accumulated. Falls back to the accumulated text when the
      // orchestrator has nothing to say, so a non-ComposeRun seam is unaffected.
      const finalText = readComposeOutput(orchestrator) ?? output;
      socket.emit('compose:done', { output_text: finalText, task: parsed.data.task, ...echo });
      safeAck(ack, { ok: true });
    } catch (err) {
      // W2-2: the output guard's rejection gets its own branch because the error
      // carries the RULE that fired, which a bare `ServerError` has nowhere to
      // put — the wire `message` and the server log name the same rule because
      // both read it off this class.
      //
      // 🔴 IN-PLACE CORRECTION (2026-08-07): the reason originally written here
      // was "this code has not been registered as a protocol ErrorCode yet, so it
      // cannot go through ServerError". **That sentence became false a few hours
      // after it was written** — owner approved error code 62 that same day,
      // `08e79b2` completed the registration (dist measured to contain
      // `COMPOSE_OUTPUT_REJECTED`, catalog 62). The same round corrected the twin
      // paragraph in `output-guard.ts`, **but missed this one**, so it became a
      // comment that "defends a design whose premise no longer exists" (anti-façade
      // ④). The original text is not kept in the body, because it would now
      // mislead the reader into thinking the code is unregistered; its history is
      // recorded in the ledger §9.
      // ⇒ This window's third instance of "a comment's shelf life measured in hours".
      //
      // 🔴 Whatever changes here, two things must not: the frame goes out (a
      // refusal the phone never receives is a silent failure — it would sit on
      // its 45 s watchdog and then name the wrong wall), and NOTHING is
      // delivered. compose:done is not emitted, so no output_text exists, and
      // the source text is never put in its place.
      if (err instanceof ComposeOutputRejectedError) {
        // ComposeErrorSchema types `message` as NonEmpty: an empty string makes
        // the frame fail the phone's own parse, i.e. a silent failure dressed as
        // a send. The rule name is real developer context and is never empty.
        socket.emit('compose:error', {
          code: err.code,
          message: `${err.rule}: ${err.detail}`,
          ...echo,
        });
        return safeAck(ack, { error: err.code, message: err.rule });
      }
      const e = errorPayload(err);
      // Fail loud: explicit compose:error. NEVER silently reinject raw STT text.
      socket.emit('compose:error', { code: e.error, message: e.message ?? 'compose engine unavailable', ...echo });
      safeAck(ack, e);
    }
  });
}
