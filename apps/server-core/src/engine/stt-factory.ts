// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (one orchestrator per recording; FLOWMIC_STT_*
//     env an illegal value fails loud at startup), §4 (managed-default env gating), §2 (stt:* fan-out)
//   docs/strategy/2026-07-23-mock-billing-design.md §5 (recordSttUsage exactly once —
//     driven from the bridge's onComplete seam), §3 (Free remaining-quota clamp hard cap)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 C (delivery:'none' =
//     record-only: "at this point the content never went to the PC at all")
//   CLAUDE.md red line: no silent failure; record-only really does stay on the phone; IPs only go into presets
//
// Bootstrap glue: builds the per-socket sttFactory the audio handler consumes.
// The STT tuning env is asserted ONCE at construction (all knobs touched →
// bad values abort start, never a silent fallback). Each audio:start builds a
// fresh SttSessionBridge whose emitter fans stt:* out to the originating mobile
// AND — only when this utterance is actually bound for the PC — the paired PC
// (via the room store). See makeSttEmitter for the delivery gate.

import type { Socket } from 'socket.io';
import type { Delivery, ServerMode } from '@flowmic/protocol';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { QuotaGuard } from '../billing/quota-guard';
import type { RoomStore } from '../room/store';
import { markSttFinal } from '../obs/latency';
import { getRoomUuid } from '../socket/wire';
import type { SttStartArgs } from '../socket/handlers/audio.handler';
import type { SttOrchestrator } from './orchestrator';
import { SttSessionBridge, type SttEmitter, type SttSessionDeps } from './stt-session';
import { loadRoutings, makeSttOrchestratorFactory } from '../stt/engine-factory';
import { configFromRouting, selectRouting } from '../stt/engine-router';
import type { SttRefine } from '@flowmic/protocol';
import { log } from '../log';
import { readOrchestratorTuningFromEnv, assertSttTuningEnv } from '../stt/tuning-env';
import { makeFinalTextPipeline } from '../stt/final-text-pipeline';
import { readSttPolish } from '../stt/stt-polish-settings';
import { readSttRefine } from '../stt/stt-refine-settings';
import { batchEngineIdFor, transcribeBatch } from '../stt/batch-transcribe';
import { buildDictionaryReplacer } from '../compose/dictionary-replace';
import { resolveReplacementRules } from '../compose/scenario-context';
import { resolveLlmConfigWithSource, type SelectedLlmConfig } from '../compose/llm-config';
import type { PolishDeps, PolishSkipReason } from '../stt/stt-polish';
import { ServerError } from '../errors';

export interface SttFactoryDeps {
  settings: SettingsRepo;
  mode: ServerMode;
  /** Room presence so stt:* also reaches the paired PC (injection target). */
  store: RoomStore<Socket>;
  /** Remaining monthly STT budget → this session's QUOTA ceiling (see
   *  withQuotaBudget), and the llm_tokens valve for the polish leg. Not a
   *  "clamp" since fix-025: it is a ceiling of its own with its own action, not a
   *  smaller value written over the engine-session one. */
  quota: QuotaGuard;
}

/**
 * The stt:* fan-out gate (GA-02, P0 privacy red line).
 *
 * The originating mobile ALWAYS receives every stt:* frame — it is the device
 * that is speaking and the timeline entry lives there. The paired PC leg is
 * gated on this utterance's delivery intent, fixed at audio:start and passed
 * through immutably (audio.handler):
 *
 *   delivery 'inject' → the utterance is bound for the PC, fan out.
 *   delivery 'none' (record-only) → "at this point the content never went to the PC at all" (master-plan §4.0 C).
 *
 * Before this gate, audio:start was correctly withheld from the PC (F-2375)
 * but every stt:interim / stt:final / stt:level still reached it, and with a
 * persistent capsule up (a phone IS present) controller.ts onInterim painted
 * record-only text straight into the preview band. The whole content leg is
 * withheld here, not just the injectable ones:
 *   - stt:error / stt:engine-status: a record-only utterance's engine trouble
 *     is not the PC's business; forwarding it only manufactures an alarm on a
 *     device that has no stake in the session (and no way to act on it);
 *   - audio:auto-stopped (hard cap, emitted through this same emitter): the PC
 *     never saw this utterance BEGIN, so it must not be told that it ended —
 *     mirroring audio:stop's `fannedOut` discipline in audio.handler.
 * Net contract: for delivery:'none', the PC socket receives NOTHING about this
 * utterance from the STT layer. Withholding is not a silent failure — the
 * mobile still gets the full truth, including errors.
 *
 * GA-04: the mobile leg is resolved PER FRAME through `resolveSocket`, not
 * closed over at audio:start. A session that survives a socket drop (audio
 * registry grace) rebinds to the phone's NEW socket, and stt:final must land
 * there — a captured socket would emit into a dead transport forever. While the
 * session is inside its grace window the resolver returns null: the phone is
 * simply absent (not a swallowed error — it gets the timeline entry on the next
 * sync), and the PC leg, when this utterance is bound for it, keeps flowing.
 */
export function makeSttEmitter(args: {
  resolveSocket: () => Pick<Socket, 'emit'> | null;
  store: Pick<RoomStore<Socket>, 'getPc'>;
  roomUuid: string | null;
  delivery: Delivery;
}): SttEmitter {
  const fanOutToPc = args.delivery !== 'none' && args.roomUuid !== null;
  // 🔴 REQ-12-05 INSTRUMENT — see the two blocks below. Per-utterance state; the
  // emitter is built per audio:start, so its lifetime IS the utterance's.
  let interims = 0;
  let lastInterimChars = 0;
  return {
    emit(event, payload): void {
      // V2-05 (requirement ⑥) t1. This is the ONE seam every stt:* event passes through
      // and it already holds the room, so the mark costs nothing and cannot be
      // bypassed by a future emit path. Marked before delivery: t1 is "the engine
      // produced a result", not "who received it" — fanning out to a PC that is not there must not
      // change the STT segment.
      if (event === 'stt:final' && args.roomUuid !== null) markSttFinal(args.roomUuid);
      // Forensic only: Soniox (and peers) already put `[error_type] …` on the
      // wire message, but nothing wrote it to server.log — so a phone banner
      // reading STT_CONFIG_MISSING could sit next to `stt.pool selected
      // soniox` with zero greppable refusal. Log BEFORE emit so a dead socket
      // still leaves the fact.
      if (event === 'stt:error') {
        const p = payload as { code?: unknown; message?: unknown; retryable?: unknown };
        log.warn('stt.error emitted', {
          code: p.code,
          message: p.message,
          retryable: p.retryable,
          room: args.roomUuid,
        });
      }
      // 🔴 REQ-12-05 — THE ONE FACT NOBODY COULD READ.
      //
      // Device-line measured (2026-08-12, frozen 0.2.61) that the phone shows an
      // EMPTY "Transcribing…" row for the whole hold on BOTH the LAN leg and the cloud
      // leg. On LAN the cause is settled and structural (sherpa-local was batch
      // final-only). On the CLOUD leg the two surviving explanations —"the
      // engine produced no interim at all" and "interims flowed and the phone
      // did not paint them"— are indistinguishable from every artefact we have:
      // no log line, no counter, and nothing on the phone that says a frame
      // arrived. A screen recording can say "it did not appear" and nothing
      // about WHY, which is exactly the position W8-3 was in.
      //
      // So the fact is written down at the one instant it is knowable, in the
      // one seam every stt:* frame must cross. FIRST interim only — an utterance
      // emits several per second and this is a forensic line, not a trace.
      // ⚠️ INSTRUMENTATION, NOT A FIX: no delivery behaviour changes here.
      // `chars` and not the text: a preview is user speech.
      if (event === 'stt:interim') {
        const p = payload as { text?: unknown; segment_idx?: unknown };
        interims += 1;
        lastInterimChars = typeof p.text === 'string' ? p.text.length : -1;
        if (interims === 1) {
          log.info('stt.interim first frame of this utterance', {
            chars: lastInterimChars,
            segment_idx: p.segment_idx,
            room: args.roomUuid,
            fan_out_to_pc: fanOutToPc,
          });
        }
      }
      // 🔴 REQ-12-05 ROUND 2 — WHAT THE FIRST-FRAME LINE COULD NOT SAY.
      //
      // Device-line read the line above as `chars:1` on the LAN leg and saw no
      // growing text on screen. That reading is compatible with TWO opposite
      // worlds —"the engine produced exactly one interim" and "the engine
      // produced forty and the phone painted none of them"— because a
      // first-frame-only instrument answers "did any arrive" and was being
      // asked "how many, and did they grow". One value, two questions.
      //
      // So the utterance's totals are written when it closes. `stt:final` is the
      // right instant and this is the right seam: every terminal frame crosses
      // here (that is why markSttFinal is here too).
      // ⚠️ KNOWN GAPS, stated rather than papered over: a soft-segment rollover
      // emits more than one stt:final, so several summaries per hold are normal
      // and the counts are cumulative; and an utterance that dies on stt:error
      // emits none — there, the WARN above is the line, and its absence next to
      // a missing summary is itself the reading.
      // ⚠️ Counts only, never the text: a preview is user speech.
      if (event === 'stt:final') {
        log.info('stt.interim utterance summary', {
          interims,
          last_chars: lastInterimChars,
          room: args.roomUuid,
          fan_out_to_pc: fanOutToPc,
        });
      }
      args.resolveSocket()?.emit(event, payload);
      if (!fanOutToPc || args.roomUuid === null) return;
      args.store.getPc(args.roomUuid)?.emit(event, payload);
    },
  };
}

/**
 * Build a per-socket sttFactory: `(args) => SttOrchestrator`. The returned
 * closure is handed to registerAudioHandlers for each connection.
 */
export function makeSttSessionFactory(
  deps: SttFactoryDeps,
): (socket: Socket, args: SttStartArgs) => SttOrchestrator {
  // Fail-loud at boot: touch every FLOWMIC_STT_* parser so bad env aborts start.
  assertSttTuningEnv();
  const build = makeSttOrchestratorFactory({
    settings: deps.settings,
    mode: deps.mode,
    orchestratorOptions: readOrchestratorTuningFromEnv(),
  });
  return (socket, args) => {
    // The room is resolved ONCE here (audio:start time), not per frame: the
    // delivery intent is fixed for the utterance, so the fan-out decision is
    // too. A room switch mid-utterance would otherwise silently redirect
    // content — the session is torn down on that edge instead.
    const emitter = makeSttEmitter({
      // GA-04: the audio handler supplies a resolver that follows the session
      // across a reconnect; without one (unpaired/local session) the emitter
      // stays bound to the socket that started the utterance, as before.
      resolveSocket: args.resolveSocket ?? ((): Socket => socket),
      store: deps.store,
      roomUuid: getRoomUuid(socket),
      delivery: args.delivery,
    });
    // 🔴 fix-025 (BILLING FACE). This line used to read
    //     const hardLimitMs = deps.quota.remainingSttMs(args.userId);
    // and hand the result to the bridge as `hardLimitMs`, i.e. it wrote a BILLING
    // number into the ENGINE-SESSION ceiling. Two consequences, both live:
    //   ① the engineering ceiling became "whatever this account has left this
    //      month" — 1,200,000 ms for a fresh free account against a 300,000 ms
    //      default, hours for pro. The value meant to CLAMP was REPLACING;
    //   ② the session's `limitOrigin` still said `engine_session`, because the
    //      only thing that ever wrote `quota_budget` was `clampHardLimitMs`, which
    //      has never had a production caller. Post-N1-B4 that origin ROLLS OVER,
    //      so the billing wall did not merely go unlabelled — it went off.
    // The remaining budget is now declared as itself (see withQuotaBudget), and
    // the engine-session ceiling is left to AUDIO_DEFAULTS where it belongs: this
    // layer knows about money, not about how long a vendor session may run.
    const quotaBudgetMs = deps.quota.remainingSttMs(args.userId);
    // FINAL pipeline (06 §5), snapshotted at audio:start: resolve THIS user's
    // preferred-terminology rules (scenario-card terms ∪ dictionary packs ∪
    // stt.dictionary) ONCE and build the pure alias→canonical replacer, then
    // compose it with the F-2249 normalizer. Per-session snapshot (not a cached
    // singleton): each audio:start re-reads settings, so a settings:update
    // between recordings is naturally picked up on the next take, while a single
    // utterance's terminology is frozen — and there is zero I/O at final time.
    // resolveReplacementRules fails LOUD on a corrupt scenario.card (same
    // SETTINGS_SCHEMA_INVALID contract as compose) — the audio handler's catch
    // surfaces it as stt:error, never a silent empty replacer (red line: no silent failure).
    const replacementRules = resolveReplacementRules(deps.settings, args.userId);
    const finalText = makeFinalTextPipeline(buildDictionaryReplacer(replacementRules));
    // WP-R4-6 ⑤⑥ + M4/M6: per-session stt.polish snapshot — see resolvePolishDep
    // for the full contract (fail-loud settings, provenance, the llm valve).
    const polish = resolvePolishDep(deps, args.userId, replacementRules.map((r) => r.canonical));
    // GA-14 ⑤: per-session `stt.refine` snapshot, same cadence + fail-loud
    // discipline as the polish leg. Refine needs a BATCH engine (whole-utterance
    // POST); a streaming routing has no whole-utterance mode, so no substitute is
    // invented — the dep is simply absent and the reason is LOGGED, because a
    // switch that is on and does nothing must at least be explainable.
    const refineSetting = readSttRefine(deps.settings, args.userId);
    const refine = refineSetting.enabled ? resolveRefine(deps, args, refineSetting) : undefined;
    return new SttSessionBridge({
      build: withQuotaBudget(build, quotaBudgetMs),
      emitter,
      userId: args.userId,
      mode: args.mode,
      sourceLang: args.sourceLang,
      ...(args.targetLang !== undefined ? { targetLang: args.targetLang } : {}),
      onComplete: args.onComplete,
      ...(args.onPolishUsage !== undefined ? { onPolishUsage: args.onPolishUsage } : {}),
      finalText,
      ...(polish.armed ? { polish: { llm: polish.llm, deps: polish.deps } } : {}),
      // 🔴 POLISH-1 (owner, 2026-08-11) — production delivers the polish ON THE
      // FINAL again. This line said `'detached'` from 0.2.59 (7976cc3) until now,
      // and the detached pass HAS NO DELIVERY CODE: `runDetachedPolish` computes
      // the correction, meters it, and ends at "stt.polish produced a correction
      // but there is no safe carrier — withheld" plus a bare `return`. So for
      // every release in between, an account with polish ON paid for a correction
      // and received the bare final. owner was told what reverting costs — the
      // utterance's latency contains the LLM's again, budget
      // `800ms + 20ms/char` capped at `6s` (stt-polish.ts `polishBudgetMs`) — and
      // ruled to revert regardless.
      //
      // 🔴 WHAT THE ACTIVATION TRIPLE MISSED, and it is the thing to fix before
      // anyone selects `'detached'` here again: all three of its legs are about
      // the mobile CONSUMER (which row `_applyRefined` lands on, which APK carries
      // that fix, how many phones took it). Not one of them is "the server emits
      // anything at all". Discharging all three would not have delivered one
      // character to anybody, because nothing on this side sends. A precondition
      // list that omits the delivery itself cannot be completed by satisfying it.
      //
      // ⚠️ STATED, NOT OMITTED, and that is a decision. Deleting this key would
      // produce identical behaviour — `stt-session.ts`'s accessor defaults to
      // `'sync'` — and it is deliberately not done that way.
      // [[SttSessionDeps.polishDelivery]] says "the choice is a dep, not a
      // comment, so a census can enforce it", and a census can only police a
      // literal that exists. With the key absent this file makes no claim at all,
      // the production decision lives in a `??` two files away where the census
      // does not look, and the next person to add a line here starts from blank
      // space with no constraint attached to it. The census in
      // test/polish-delivery-census.test.ts now pins this exact pair — one
      // selector, and it says `'sync'` — so DELETING this line fails as loudly as
      // flipping it (measured both ways; the deletion direction is recorded there).
      // What a census cannot say is whether the selected mode DELIVERS: that is
      // "THE DELIVERY JOIN" in test/stt-session-bridge.test.ts, which feeds this
      // literal to a real bridge and asserts the polished text reaches the client.
      polishDelivery: 'sync',
      ...(!polish.armed && polish.unavailable !== undefined ? { polishUnavailable: polish.unavailable } : {}),
      ...(refine !== undefined ? { refine } : {}),
    });
  };
}

/**
 * 🔴 fix-025 — declare THIS user's remaining STT budget on the session, in the
 * one moment it can be declared.
 *
 * `SttSessionBridge`'s constructor calls `build` with the AudioSession it has
 * just made and BEFORE it calls `start()`, and `setQuotaBudgetMs` is legal only
 * from `idle`. That is the same seam `test/autostop-reason.test.ts` already uses
 * and describes in as many words "the one moment the session is still idle".
 *
 * ⚠️ WHY NOT A BRIDGE DEP. `SttSessionDeps` has exactly one field that reaches
 * the session's ceiling — `hardLimitMs` — and it lands on the ENGINE-session one.
 * Sending the budget through it is the defect this card closes, so the fix cannot
 * be "send a better number down the same pipe". That dep now has no producer at
 * all, which is the honest state: nothing in this repo has any business setting
 * an engine-session ceiling per account. Registered for the window that owns
 * `engine/stt-session*.ts`; the census in `test/quota-limit-origin.test.ts` fails
 * if a producer reappears here.
 *
 * The declaration is made BEFORE the inner build so that the #16 fail-fast
 * (SttConfigMissingError, thrown synchronously by the builder when no routing
 * matches) cannot produce the one ordering nobody would notice: a live session
 * whose budget was never declared.
 */
function withQuotaBudget(
  build: SttSessionDeps['build'],
  quotaBudgetMs: number,
): SttSessionDeps['build'] {
  return (session, language, userId, vad) => {
    session.setQuotaBudgetMs(quotaBudgetMs);
    return build(session, language, userId, vad);
  };
}

/**
 * What `stt.polish` resolved to for ONE audio session.
 *
 * RT-1 replaced a bare `| undefined` with this, because `undefined` was answering
 * two questions: "the user did not ask for polish" and "the user asked and we
 * could not give it". The wire needs to tell those apart — the second one paints
 * PolishSkippedMark, the first one must paint nothing at all.
 */
export type PolishArming =
  | { armed: true; llm: SelectedLlmConfig; deps: PolishDeps }
  /** `unavailable` present ⇔ polish was ON and could not be armed. */
  | { armed: false; unavailable?: PolishSkipReason };

/**
 * WP-R4-6 ⑤⑥: per-session stt.polish snapshot, SAME cadence + fail-loud
 * discipline as the dictionary leg. readSttPolish is the production GET anchor
 * of the settings-key-drift pair — present-but-malformed throws
 * SETTINGS_SCHEMA_INVALID here (audio:start), surfaced by the audio handler's
 * catch as stt:error (same contract as scenario.card). When ON, the LLM config is
 * resolved from the SAME shared `llm.config` resolver compose uses (no new model
 * identity). The resolved config is FROZEN into the bridge for this utterance, so a
 * settings:update mid-session cannot change it (next take re-snapshots). When
 * OFF, the bridge receives no `polish` dep → its stt:final shape is
 * byte-identical to today (no polish field). `protectedTerms` are the SAME
 * per-session dictionary canonicals the deterministic leg uses (lead-controller ruling,
 * 2026-07-24): polish output that drifts one is guard-rejected.
 *
 * M4: the config is resolved WITH provenance (resolveLlmConfigWithSource) and
 * handed to the bridge as a SelectedLlmConfig, so the polish meter judges BYOK
 * by "who provided it", never by key shape. (The old "polish is NOT metered in 0.1.0"
 * note here was an expired truth — v0.2.3 added the second recordLlmUsage site
 * in audio.handler.ts, and this snapshot is what feeds its flag.)
 *
 * M6 (0.3.0): the llm_tokens VALVE now covers this path. ensureQuota('llm') is
 * checked once per session at audio:start-snapshot time; exhausted ⇒ polish is
 * disabled for THIS session (loud forensic line, STT itself untouched — the
 * valve is runaway protection at 30-40x the tier's physically producible
 * tokens, not a product gate, so it must never fail the recording). Same
 * a-switch-that-is-on-and-does-nothing-must-be-explainable stance as the refine
 * leg below. Standalone mode NOOPs inside ensureQuota, so the valve only ever
 * closes in saas. Any non-QUOTA_EXCEEDED throw FROM THE VALVE is rethrown — fail
 * loud (see the asymmetry note in RT-1a below for why that stays narrow).
 *
 * 🔴 RT-1a (0.3.0, seventh task book): an unresolvable `llm.config` DEGRADES to
 * "no polish this session" (bare final) instead of failing the recording. It used
 * to propagate: resolveLlmConfigWithSource throws LLM_INVALID_MODEL when there is
 * no managed default and the user's row is absent/malformed, the throw travelled
 * up makeSttSessionFactory into audio.handler's audio:start catch, and the user
 * got stt:error + a failed ack — i.e. THE MICROPHONE DID NOT OPEN. That was
 * mostly latent while stt.polish defaulted OFF; RT-1 turns it ON for everyone, at
 * which point every account without a usable LLM loses the ability to record at
 * all. owner's red line for this feature is "correction is an enhancement — if any
 * link in the chain fails, it must degrade to the status quo; it must never happen
 * that 'the correction didn't run ⇒ the user saw nothing at all'", and a refused
 * audio:start is exactly "the user saw nothing at all".
 *
 * It degrades UNCONDITIONALLY — deliberately NOT split by "who turned polish on". The
 * plan document (2026-08-07-realtime-async-correction-plan-and-soniox-fluency-
 * research.md §3.2) proposed keeping fail-loud for users who explicitly opted in;
 * the lead controller ruled the red line wins, because a refused recording is the same product
 * outcome whoever flipped the switch. Two things fall out and both were checked
 * rather than assumed: `SttPolishSchema` is `{enabled:boolean}.strict()`, so there
 * is no provenance to branch on today and a split would have needed a settings-
 * schema change (human-review gate); and nothing in the repo consumes such a distinction —
 * there is no LLM availability/health/last-error surface anywhere (P-8 handoff §5
 * row 1: the compose frames carry no engine identity at all). Building the
 * distinction would have been a capability with no caller (anti-façade).
 *
 * The catch is UNCONDITIONAL rather than narrowed to LLM_INVALID_MODEL, and that
 * is the safer direction here, not the lazier one:
 *   - `managedLlmConfig` throws a plain Error when FLOWMIC_MANAGED_LLM_ENABLED is
 *     set but the env is malformed. Narrowing would let one typo in
 *     /etc/flowmic-app/env brick dictation for the WHOLE deployment — a worse
 *     blast radius than the per-account case this card exists to fix. That
 *     env's fail-loud is NOT lost: compose/index.ts calls the same resolver and
 *     does not catch, so translate/organize still refuses loudly.
 *   - it cannot hide a broken settings repo: the SAME repo answered twice already
 *     on this very audio:start (resolveReplacementRules above, readSttPolish two
 *     lines up), so a repo-level failure fails loud before control reaches here.
 * ⚠️ NOT a return to legacy's silent default: legacy fell back to a
 * DEFAULT_POLISH_LLM_CONFIG endpoint. This degrades to NO polish — it never
 * invents a model to send the user's speech to.
 *
 * ⚠️ The valve's narrow rethrow above is deliberately left alone, and it costs
 * nothing new: audio.handler already calls `guard.ensureQuota(userId,'stt')`
 * BEFORE building the factory and fails audio:start on any throw, so a guard that
 * is broken enough to throw a TypeError has already refused the recording one
 * layer up. Widening here would buy no reachable behaviour.
 *
 * ✅ RT-1 CLOSES the account this block used to register ("the degrade is silent
 * TO THE USER (server WARN only)"). It needed "a dep shape that can say 'on but
 * unusable'" — that is [[PolishArming]] — and it turned out to need NO mobile
 * copy at all: `polish:'skipped'` already paints PolishSkippedMark
 * (`chat_utterance.dart` records the entry id → `chat_flow_page.dart` →
 * `PolishSkippedMark`), and its copy "Polish not applied · original text used" is exactly true here.
 *
 * Both degrades normalize to the wire reason `llm_error`, staying inside the
 * frozen four (`kSttPolishReasons` on the phone is a CLOSED set — a new value
 * would parse to null there). That is not a rounding-down: `polishWireSignal`'s
 * own contract is that the wire carries four normalized values and "internal
 * fine-grained detail stays in the forensic log", and the two WARN lines below
 * are that detail. The valve case is coarser than the config case, and both are
 * honestly "the LLM leg was not usable for this session".
 */
export function resolvePolishDep(
  deps: Pick<SttFactoryDeps, 'settings' | 'quota'>,
  userId: string,
  protectedTerms: readonly string[],
): PolishArming {
  // Fail-loud PRESERVED: a present-but-malformed `stt.polish` row still throws
  // SETTINGS_SCHEMA_INVALID. That answers a DIFFERENT question ("your settings row is broken",
  // which the user can fix) from "the LLM isn't usable" (which they often cannot), and it is
  // not the LLM leg RT-1a is degrading.
  const polishSetting = readSttPolish(deps.settings, userId);
  // OFF ⇒ no `unavailable`: nothing was asked for, so nothing is owed an
  // explanation, and stt:final must stay byte-identical to today.
  if (!polishSetting.enabled) return { armed: false };
  // RT-1a: correction is an ENHANCEMENT — an unusable LLM degrades to a bare
  // final, it never refuses the recording. Full argument in the doc block above.
  let llm: SelectedLlmConfig;
  try {
    llm = resolveLlmConfigWithSource(deps.settings, userId);
  } catch (err) {
    // Forensics must be enough to ACT on: the code says WHICH failure (a missing
    // row vs a malformed one vs a bad managed env all arrive here), the message
    // says which field, and the user id says whose. "No silent failure" is not satisfied
    // by recording THAT something failed, only by recording enough to fix it.
    log.warn('stt.polish disabled for this session — llm.config is unusable (bare final delivered)', {
      userId,
      code: err instanceof ServerError ? err.code : 'non-ServerError',
      detail: err instanceof Error ? err.message : String(err),
    });
    return { armed: false, unavailable: 'llm_error' };
  }
  try {
    deps.quota.ensureQuota(userId, 'llm');
  } catch (err) {
    if (err instanceof ServerError && err.code === 'QUOTA_EXCEEDED') {
      log.warn('stt.polish disabled for this session — llm_tokens valve exhausted', {
        userId,
        detail: err.message,
      });
      return { armed: false, unavailable: 'llm_error' };
    }
    throw err;
  }
  return {
    armed: true,
    llm,
    deps: { protectedTerms: [...protectedTerms] },
  };
}

/** Build the GA-14 refine dep, or `undefined` when this routing cannot do a
 *  second pass. Every `undefined` here is logged with its reason. */
function resolveRefine(
  deps: SttFactoryDeps,
  args: SttStartArgs,
  cfg: SttRefine,
): { cfg: SttRefine; transcribe: (pcm: Buffer) => Promise<string> } | undefined {
  const routings = loadRoutings(deps.settings, args.userId);
  // The SAME selection the live session used — refine must not quietly pick a
  // different engine than the one that produced the first pass.
  const routing = selectRouting(args.sourceLang, routings);
  if (routing === null) {
    log.warn('stt.refine is ON but no routing matches — no second pass', { language: args.sourceLang });
    return undefined;
  }
  const batchId = batchEngineIdFor(routing.engine_id);
  if (batchId === null) {
    // The honest limit: funasr / deepgram / openai-realtime stream and have no
    // whole-utterance mode. Refine stays off for this session.
    log.warn('stt.refine is ON but the routed engine is streaming-only — no second pass', {
      engine: routing.engine_id,
      language: args.sourceLang,
    });
    return undefined;
  }
  const engineCfg = configFromRouting(routing, args.sourceLang);
  return { cfg, transcribe: (pcm: Buffer) => transcribeBatch(engineCfg, pcm) };
}
