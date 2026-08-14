// SPEC-REF:
//   docs/decisions/2026-07-30-a5-owner-rulings.md ② (owner's own words "V2-08:
//     choose option a" — exe basename ONLY; `window_title` must not be collected)
//   docs/strategy/2026-07-30-task-package-v1.md group F, F2 (consent storage +
//     per-process cache + owner can see and override + an unresolved answer is
//     undefined, zero contribution, never guess)
//   docs/strategy/R7-V2-TASK-CARDS.md V2-08 (Option C: LLM inference + per-process cache)
//   ./scenario-inference.ts (the gate, the whitelist, the resolution order)
//   ./scenario-infer-call.ts (the one LLM round trip)
//   ./app-category.ts (the built-in closed map — the `builtin` leg)
//   apps/server-core/src/compose/index.ts (the WIRING ROOT — createComposeFactory
//     builds ONE store per process and calls resolve() per compose:start)
//   CLAUDE.md red line: no silent failure (every refusal gets a named forensic line)
//
// THE WIRING. The two files above it were a complete, tested decision layer with
// zero production callers for two days — this repo's number-one historical bug
// class in its purest form. What was missing was never a decision; it was the
// three boring things a decision needs in order to run: somewhere to read the
// consent from, somewhere to keep an answer, and somebody to make the call.
//
// Three properties are worth reading before changing anything here:
//
//  1. DEFAULT OFF IS STRUCTURAL, NOT POLITE. `resolve()` asks
//     [inferenceBlockedReason] before it will even look at a cached inference,
//     and [runInference] is unreachable while that returns a reason. With no
//     `scenario.inference` row present at all — which is every account today —
//     the number of LLM calls this file makes is zero, and the reason is written
//     to the log rather than assumed to be obvious.
//
//  2. THE CACHE IS PART OF THE CONSENT SURFACE. A descriptor inferred while the
//     switch was on is still an inference; continuing to use it after the switch
//     goes off would honour the letter of the gate and break its point. So the
//     cache is fingerprinted by (granted, grantedFor, destination) and dropped
//     whole when that changes — including for a call still in flight, whose
//     result is discarded rather than stored.
//
//  3. THE HOT PATH NEVER WAITS FOR A MODEL. resolve() is synchronous and answers
//     from override / built-in table / cache only. A miss SCHEDULES the round
//     trip and returns undefined, so the utterance being composed right now
//     contributes no app-scenario line and the NEXT one under that process does.
//     This is Option C by construction: Option B (ask per utterance) was
//     rejected for eating the ≤800 ms scenario-correction budget whole.

import type { LlmConfig } from '@flowmic/protocol';
import type { SettingsRepo } from '../db/repos/settings.repo';
import { isErrorCode } from '../errors';
import type { ErrorCode } from '@flowmic/protocol';
import { log } from '../log';
import { appCategoryDescriptor } from './app-category';
import type { LlmStreamer } from './llm';
// Card Z2: the classifier and the gate moved to @flowmic/protocol so the desktop
// consent screen asks the SAME functions. Import path only — same functions.
import {
  destinationOf,
  inferenceBlockedReason,
  type ModelDestination,
  type ScenarioInferenceConsent,
} from '@flowmic/protocol';
import {
  inferenceLogLine,
  resolveDescriptor,
  validateInferredDescriptor,
  type DescriptorRejection,
  type ResolvedDescriptor,
} from './scenario-inference';
import { inferDescriptor } from './scenario-infer-call';

/**
 * The consent row. Read with a VARIABLE key on purpose — the settings-key-drift
 * lint pairs a literal-keyed server GET anchor with a literal-keyed UI SET anchor
 * in apps/desktop or apps/mobile, and the consent SCREEN is desktop work that
 * this card does not own. Anchoring the literal here would make the lint demand a
 * UI writer that does not exist yet, i.e. a false match. Same stance, same reason
 * as `stt.dictionary` in scenario-context.ts.
 *
 * (This paragraph deliberately does not spell the anchor call shapes out: the
 * lint reads source text, so writing them in prose fabricates an anchor. It
 * caught exactly that on the first run of this file.)
 *
 * Nothing about the write path is missing, though: `settings:update` takes an
 * arbitrary key (socket/handlers/settings.handler.ts), so the row is writable
 * over the existing protocol the moment a consent screen exists. Until then this
 * reads absent ⇒ the feature is off ⇒ zero LLM calls, which is the intended
 * default rather than a gap.
 *
 * Shape: `{ "granted": true, "granted_for": "local" | "external" }` — snake_case
 * on the wire/KV side, camelCase in [ScenarioInferenceConsent].
 */
const CONSENT_KEY = 'scenario.inference';

/**
 * The owner's manual per-process corrections: `{ "<exe basename lowercased>":
 * "<descriptor>" }`. Variable-key read for the same reason as CONSENT_KEY.
 *
 * Criterion 3, "a single wrong judgment would permanently and silently pollute
 * every utterance under that process", is why this outranks the
 * built-in table — and why a MALFORMED entry is treated as a rejected override
 * rather than as an absent one (see [readOverride]).
 */
const OVERRIDES_KEY = 'scenario.inference.overrides';

/** Cache ceiling. A desktop sees tens of distinct executables in a session; 256
 *  is far past that and still bounded, which is the requirement. */
const MAX_CACHE_ENTRIES = 256;

/** How long a TRANSPORT failure suppresses retries for that process. An error is
 *  not an answer, so it must not become a permanent verdict — but retrying on
 *  every utterance against a wedged endpoint is the cost Option C exists to avoid.
 *  One attempt per minute per process is the compromise. */
const ERROR_RETRY_MS = 60_000;

interface CacheEntry {
  /** The accepted descriptor. Absent = the answer was "no descriptor" (the model
   *  said UNKNOWN, or the whitelist rejected what it said). An absent descriptor
   *  is still an ANSWER and stops us asking again — that is the point of caching
   *  a negative. */
  readonly descriptor?: string;
  /** Epoch ms after which asking again is allowed. Absent = never ask again.
   *  Only a transport failure sets this. */
  readonly retryAfter?: number;
}

export interface ScenarioInferenceSeams {
  /** Off-band execution. Default: a 0 ms timer, so the round trip starts after
   *  the current compose:start has finished being assembled. Tests pass a
   *  synchronous runner. */
  readonly schedule?: (task: () => void) => void;
  readonly now?: () => number;
  /**
   * Forensic sink. Default: the real server logger — deliberately NOT a no-op,
   * because a DI default that quietly does nothing is exactly how this project
   * lost the microphone for eleven versions (13-LESSONS-LEARNED §7 F1 ②).
   */
  readonly logLine?: (line: string, level: 'info' | 'warn') => void;
  readonly maxEntries?: number;
  /** Passed through to [inferDescriptor]. */
  readonly timeoutMs?: number;
  readonly errorRetryMs?: number;
}

export interface ScenarioInferenceDeps extends ScenarioInferenceSeams {
  readonly settings: SettingsRepo;
  readonly streamerFor: (protocol: LlmConfig['protocol']) => LlmStreamer;
  /**
   * M6: the LLM meter for the inference round trip — REQUIRED, because a
   * defaulted no-op meter is exactly the dial-that-cannot-move façade the polish
   * pass already went through (owner read 「LLM tokens 0 / 250000」 while it ran
   * all day). The ONE production injector is createComposeFactory
   * (compose/index.ts), which forwards to UsageTracker.recordLlmUsage — the same
   * single llm bucket as compose + polish (owner ruling ⑨: no per-engine split).
   * `isByok` is the caller's provenance judgement (resolveByokLlm) — the tracker
   * waives BYOK inside.
   */
  readonly recordUsage: (userId: string, tokensIn: number, tokensOut: number, isByok: boolean) => void;
  readonly fetch?: typeof globalThis.fetch;
}

/** Whatever [inferenceLogLine] is willing to accept as a reason — a closed union
 *  of reason literals plus the protocol's closed ErrorCode list. Derived from that
 *  signature so the two cannot drift. */
type LogDetail = Parameters<typeof inferenceLogLine>[2];

function asErrorCode(code: string): ErrorCode {
  // Same narrowing the compose orchestrator uses. Keeps the forensic detail
  // inside the protocol's closed code list — a free-form string there would be a
  // hole in "the log only records the process name and the reason".
  return isErrorCode(code) ? code : 'LLM_TIMEOUT';
}

/**
 * (granted, grantedFor, destination) as one comparable string.
 *
 * Cache validity, not gate logic. It answers "what consent state was in effect
 * when this was last inferred", and a
 * mismatch means every stored inference was made under premises that no longer
 * hold. Revoking consent, and switching the model from a LAN box to a vendor,
 * both change it.
 */
function consentFingerprint(
  consent: ScenarioInferenceConsent | undefined,
  destination: ModelDestination,
): string {
  if (consent === undefined) return `absent|${destination}`;
  return `${consent.granted ? 'granted' : 'refused'}|${consent.grantedFor}|${destination}`;
}

/** Per-user, per-process scenario-descriptor resolution with an off-band LLM
 *  inference behind the consent gate. ONE instance per server process (the cache
 *  is the reason it is an object at all). */
export class ScenarioInferenceStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Set<string>();
  /** userId → the fingerprint its cached entries were produced under. */
  private readonly fingerprints = new Map<string, string>();
  /** Refusals already announced, so a permanently-off feature writes one line per
   *  process instead of one per utterance. Keyed by user+process+fingerprint, so
   *  the reason is re-announced whenever the reason could have changed. */
  private readonly announced = new Set<string>();

  constructor(private readonly deps: ScenarioInferenceDeps) {}

  /**
   * The descriptor for this compose turn's focus process, or `undefined`.
   *
   * Synchronous and total: override > builtin > inferred (the order lives in
   * [resolveDescriptor]; this method only supplies the three candidates). Never
   * guesses — criterion 1, "cannot be inferred → undefined, zero contribution
   * to the prompt".
   */
  resolve(args: {
    userId: string;
    cfg: LlmConfig;
    /** M6: is `cfg` the user's own key (resolveByokLlm on the SAME resolution
     *  that produced `cfg`)? Drives the metering of the off-band call. Absent ⇒
     *  false ⇒ METERED — the fail direction that can never silently waive
     *  platform spend (a wrongly-metered BYOK call costs bounded, visible quota;
     *  an unmetered platform call costs unbounded, invisible money). The ONE
     *  production caller (compose/index.ts) always passes the real judgement. */
    byok?: boolean;
    processName?: string;
  }): ResolvedDescriptor | undefined {
    const name = args.processName?.trim() ?? '';
    // No focus signal at all (no PC in the room, PC never reported, focus
    // cleared). Nothing to resolve and nothing to explain.
    if (name.length === 0) return undefined;
    const key = name.toLowerCase();

    const destination = destinationOf(args.cfg);
    const consent = this.readConsent(args.userId);
    const blocked = inferenceBlockedReason(consent, destination);
    this.reconcileFingerprint(args.userId, consentFingerprint(consent, destination), destination);

    const builtin = appCategoryDescriptor(name);
    const override = this.readOverride(args.userId, key);
    // BLOCKED ⇒ the inferred leg is not consulted AT ALL. Not "we stop making new
    // ones" — the ones we already have stop contributing, which is what turning
    // the switch off has to mean.
    const cached = blocked === undefined ? this.cacheGet(args.userId, key)?.descriptor : undefined;

    const resolved = resolveDescriptor({
      ...(override !== undefined ? { override } : {}),
      ...(builtin !== undefined ? { builtin } : {}),
      ...(cached !== undefined ? { cached } : {}),
    });

    if (resolved === undefined && override !== undefined) {
      // resolveDescriptor refuses to fall through to the built-in after throwing
      // away what the owner typed, and that silence is the thing we have to
      // break: from the outside, an ignored correction and an applied one look
      // identical. Do NOT infer here either — the owner has spoken about this
      // process; asking a model to speak over them would be worse than nothing.
      this.say(
        name,
        destination,
        'rejected',
        validateInferredDescriptor(override).rejected ?? 'empty',
        'warn',
      );
      return undefined;
    }
    if (resolved !== undefined) {
      // Only the inferred leg is worth a line: override and builtin are facts the
      // owner or the code already own, and logging them per utterance would bury
      // the ones that matter.
      if (resolved.source === 'inferred') this.say(name, destination, 'hit');
      return resolved;
    }

    // Nothing known. This is the ONLY state an inference can help with.
    if (blocked !== undefined) {
      // "silent skipping is not allowed": say why there was no inference, once per reason.
      this.sayOnce(args.userId, key, name, destination, 'blocked', blocked);
      return undefined;
    }
    // blocked === undefined guarantees a granted consent (that is the first
    // branch of inferenceBlockedReason), so the non-null assert is the gate's
    // guarantee rather than an assumption about the caller.
    this.kick(args.userId, args.cfg, args.byok ?? false, consent as ScenarioInferenceConsent, name, key, destination);
    return undefined;
  }

  // ── settings reads ─────────────────────────────────────────────────────────

  private readConsent(userId: string): ScenarioInferenceConsent | undefined {
    const value = this.deps.settings.read(userId, CONSENT_KEY)?.value;
    // Never asked. The default, and the only state every account is in today.
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.malformed(userId, CONSENT_KEY);
      return undefined;
    }
    const granted = (value as { granted?: unknown }).granted;
    const grantedFor = (value as { granted_for?: unknown }).granted_for;
    if (typeof granted !== 'boolean' || (grantedFor !== 'local' && grantedFor !== 'external')) {
      // A consent row we cannot read is NOT a consent. Unlike `scenario.card`
      // (which throws, because a corrupt profile silently changes what the
      // transcript says), the safe reading of this one is the documented default
      // — so it degrades to OFF and says so, instead of failing the utterance.
      this.malformed(userId, CONSENT_KEY);
      return undefined;
    }
    return { granted, grantedFor };
  }

  /**
   * The owner's override for this process, or undefined when they have not set
   * one.
   *
   * A present-but-non-string entry comes back as `''`, which
   * [validateInferredDescriptor] rejects as 'empty'. That is deliberate: it keeps
   * the override at the TOP of the priority order (a malformed correction still
   * beats the built-in table and still blocks inference) without re-implementing
   * that order here. Treating it as absent would let the built-in silently answer
   * for a process the owner had explicitly written about.
   */
  private readOverride(userId: string, key: string): string | undefined {
    const value = this.deps.settings.read(userId, OVERRIDES_KEY)?.value;
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.malformed(userId, OVERRIDES_KEY);
      return undefined;
    }
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) return undefined;
    return typeof raw === 'string' ? raw : '';
  }

  // ── cache ──────────────────────────────────────────────────────────────────

  /** NUL as the separator, written as an ESCAPE and never as a raw byte — a raw
   *  one makes this whole file binary to git and grep (it did, once, before this
   *  comment existed). Neither a user id nor an executable basename can contain
   *  it, so two different (user, process) pairs cannot collide into one entry. */
  private cacheKey(userId: string, key: string): string {
    return `${userId}\u0000${key}`;
  }

  private cacheGet(userId: string, key: string): CacheEntry | undefined {
    return this.cache.get(this.cacheKey(userId, key));
  }

  private cacheSet(userId: string, key: string, entry: CacheEntry): void {
    const max = this.deps.maxEntries ?? MAX_CACHE_ENTRIES;
    const k = this.cacheKey(userId, key);
    this.cache.delete(k); // re-insert so Map order is recency of write
    while (this.cache.size >= max) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(k, entry);
  }

  /** Drop everything remembered for one user. Called when the consent premises
   *  change — see [consentFingerprint]. */
  private dropUser(userId: string): number {
    const prefix = `${userId}\u0000`;
    let dropped = 0;
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(prefix)) {
        this.cache.delete(k);
        dropped++;
      }
    }
    for (const k of [...this.announced]) {
      if (k.startsWith(prefix)) this.announced.delete(k);
    }
    return dropped;
  }

  private reconcileFingerprint(userId: string, fp: string, destination: ModelDestination): void {
    const previous = this.fingerprints.get(userId);
    if (previous === fp) return;
    this.fingerprints.set(userId, fp);
    if (previous === undefined) return; // first turn for this user — nothing stale
    const dropped = this.dropUser(userId);
    this.line(
      `scenario-inference cache dropped (consent premises changed: ${previous} -> ${fp}, ${dropped} entr${dropped === 1 ? 'y' : 'ies'}) dest=${destination}`,
      'warn',
    );
  }

  // ── the call ───────────────────────────────────────────────────────────────

  // Valve note (M6): every kick() is downstream of the compose:start admission
  // — compose.handler.ts runs the ONE ensureQuota('llm') gate BEFORE the compose
  // factory (and therefore resolve()) is ever invoked, so an exhausted llm_tokens
  // valve stops scheduling new inference calls without a second quota site here.
  private kick(
    userId: string,
    cfg: LlmConfig,
    byok: boolean,
    consent: ScenarioInferenceConsent,
    name: string,
    key: string,
    destination: ModelDestination,
  ): void {
    const id = this.cacheKey(userId, key);
    if (this.inFlight.has(id)) return;
    const entry = this.cacheGet(userId, key);
    if (entry !== undefined) {
      // Already answered. "the same exe should not ask the LLM on every
      // utterance" — the only entry that
      // ever expires is a transport failure's retry window.
      if (entry.retryAfter === undefined || this.clock() < entry.retryAfter) return;
    }
    this.inFlight.add(id);
    const fp = this.fingerprints.get(userId);
    const schedule = this.deps.schedule ?? ((task: () => void): void => { setTimeout(task, 0); });
    schedule(() => {
      void this.runInference(userId, cfg, byok, consent, name, key, destination, fp)
        .catch((err: unknown) => {
          // runInference is total, so reaching here means a bug in it. Still not
          // allowed to become an unhandled rejection (that kills the process) and
          // still not allowed to be silent.
          this.line(
            `scenario-inference ${name} error (store bug: ${err instanceof Error ? err.name : 'throw'}) dest=${destination}`,
            'warn',
          );
        })
        .finally(() => {
          this.inFlight.delete(id);
        });
    });
  }

  /**
   * One round trip, then store what it means. Total — every arm of
   * [InferenceOutcome] is handled and none of them produces a guess.
   *
   * The `fp` argument closes the in-flight window: consent can be revoked while
   * a call is out, and a result that lands after the gate closed must be thrown
   * away rather than cached.
   */
  private async runInference(
    userId: string,
    cfg: LlmConfig,
    byok: boolean,
    consent: ScenarioInferenceConsent,
    name: string,
    key: string,
    destination: ModelDestination,
    fp: string | undefined,
  ): Promise<void> {
    let streamer: LlmStreamer;
    try {
      streamer = this.deps.streamerFor(cfg.protocol);
    } catch {
      // The dispatcher throws on a protocol it does not know. That is a real
      // configuration fault and it gets a real line — not a swallowed exception
      // on a background task nobody is awaiting.
      this.say(name, destination, 'error', 'LLM_INVALID_MODEL', 'warn');
      return;
    }
    const outcome = await inferDescriptor(
      { processName: name },
      {
        cfg,
        consent,
        streamer,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      },
    );

    // M6 metering — BEFORE the fingerprint check on purpose: a result discarded
    // because consent flipped mid-flight was still a real round trip; the tokens
    // were spent whatever we then did with the text. Billing records cost, not
    // verdicts (the polish pass pinned the same rule). Absent usage = the
    // provider did not say, and an absent number is never recorded as a zero.
    const usage =
      outcome.kind === 'ok' || outcome.kind === 'unknown' || outcome.kind === 'rejected'
        ? outcome.usage
        : undefined;
    if (usage) this.deps.recordUsage(userId, usage.tokensIn, usage.tokensOut, byok);

    if (this.fingerprints.get(userId) !== fp) {
      this.line(
        `scenario-inference ${name} discarded (consent premises changed while the call was in flight) dest=${destination}`,
        'warn',
      );
      return;
    }

    switch (outcome.kind) {
      case 'ok':
        this.cacheSet(userId, key, { descriptor: outcome.descriptor });
        this.say(name, destination, 'inferred');
        return;
      case 'unknown':
        // "does not recognize it" is an answer, and an honest one. Cache the absence so the same
        // executable is not re-asked every turn, and log it as its own outcome
        // rather than as a rejection — blaming the model for admitting ignorance
        // makes the log unreadable.
        this.cacheSet(userId, key, {});
        this.say(name, destination, 'unknown');
        return;
      case 'rejected':
        // The whitelist refused what came back. NOT repaired, NOT replaced with a
        // plausible category (criterion 1) — and cached as an absence, because asking
        // the same model the same question again is not a plan.
        this.cacheSet(userId, key, {});
        this.say(name, destination, 'rejected', outcome.reason, 'warn');
        return;
      case 'blocked':
        // The gate closed between resolve() and here. Nothing left, nothing
        // cached, and the reason is named.
        this.say(name, destination, 'blocked', outcome.reason, 'warn');
        return;
      case 'error': {
        // Red line: an LLM failure never degrades into a fabricated result. It leaves
        // NO descriptor and a retry window, so the feature stays honest about
        // having not run rather than pretending this app has no scenario.
        const retryAfter = this.clock() + (this.deps.errorRetryMs ?? ERROR_RETRY_MS);
        this.cacheSet(userId, key, { retryAfter });
        this.say(name, destination, 'error', asErrorCode(outcome.code), 'warn');
        return;
      }
      default: {
        const _exhaustive: never = outcome;
        throw new Error(`scenario-infer-store: unhandled outcome ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // ── forensics ──────────────────────────────────────────────────────────────

  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  private line(text: string, level: 'info' | 'warn'): void {
    const sink =
      this.deps.logLine ??
      ((l: string, lv: 'info' | 'warn'): void => {
        if (lv === 'warn') log.warn(l);
        else log.info(l);
      });
    sink(text, level);
  }

  /**
   * One forensic line per outcome, with the destination appended.
   *
   * `dest=` is not decoration. owner's own ruling is that the risk differs by
   * where the model lives, and a log that records the outcome but not the
   * destination cannot answer "where did this process name go" after the fact — which is the
   * only question that matters if the endpoint is ever found to have been wrong.
   */
  private say(
    name: string,
    destination: ModelDestination,
    outcome: 'hit' | 'inferred' | 'rejected' | 'blocked' | 'unknown' | 'error',
    detail?: LogDetail,
    level: 'info' | 'warn' = 'info',
  ): void {
    this.line(`${inferenceLogLine(name, outcome, detail)} dest=${destination}`, level);
  }

  private sayOnce(
    userId: string,
    key: string,
    name: string,
    destination: ModelDestination,
    outcome: 'blocked',
    detail: LogDetail,
  ): void {
    const fp = this.fingerprints.get(userId) ?? '';
    const id = `${userId}\u0000${key}\u0000${outcome}|${String(detail)}|${fp}`;
    if (this.announced.has(id)) return;
    if (this.announced.size >= (this.deps.maxEntries ?? MAX_CACHE_ENTRIES)) this.announced.clear();
    this.announced.add(id);
    this.say(name, destination, outcome, detail, 'warn');
  }

  private malformed(userId: string, settingKey: string): void {
    const id = `${userId}\u0000!malformed|${settingKey}`;
    if (this.announced.has(id)) return;
    if (this.announced.size >= (this.deps.maxEntries ?? MAX_CACHE_ENTRIES)) this.announced.clear();
    this.announced.add(id);
    // The KEY, never the value: a malformed settings blob is user content.
    this.line(`scenario-inference setting '${settingKey}' is malformed — treated as not set`, 'warn');
  }
}
