// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §1/§5.5 (standalone vs saas — mode is
//     the single branch point; standalone binds all interfaces for LAN pairing,
//     saas binds loopback behind an edge)
//   docs/strategy/2026-07-23-mock-billing-design.md §1 (FLOWMIC_MOCK_BILLING /
//     FLOWMIC_MOCK_UNLOCK_ALL env gates)
//   docs/rebuild/05-DATA-MODEL.md §1 (FLOWMIC_DB_PATH; default in-memory)
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §4-3 (paddle block)
//   docs/strategy/2026-07-31-owner-nine-rulings-batch.md A1 (tier/price/quota configurable)
//
// Pure env → resolved config. Side effects, all deliberate and all documented:
//   ① resolving the standalone secret (may mint+persist on first boot);
//   ② installing the resolved plan-limits table into billing/plans.ts — see the
//      long comment there for WHY it happens here and not in bootstrap.
// Every downstream module takes the resolved ServerConfig, never process.env.

import { isPlan, type Plan, type ServerMode } from '@flowmic/protocol';
import { installPlanLimits, resolvePlanLimits, type PlanLimitsOverrides } from './billing/plans';
import { resolveStandaloneSecret } from './identity';
import { trustedProxiesFromEnv, TRUSTED_PROXIES_ENV } from './http/trusted-proxy';
import { REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MS } from './auth/register-rate-limit';
import { PAIR_IP_MAX_FAILURES, PAIR_IP_WINDOW_MS } from './room/pair-rate-limit';
import { log } from './log';

// F-2232 / A-31: fixed uncommon standalone port (below the Windows ephemeral
// range so it never drifts). saas binds loopback behind the edge.
export const DEFAULT_STANDALONE_PORT = 41879;
export const DEFAULT_SAAS_PORT = 3210;
export const SAAS_LISTEN_HOST = '127.0.0.1';

export interface ServerConfig {
  mode: ServerMode;
  port: number;
  /** Bind host. undefined = all interfaces (standalone LAN); saas = loopback. */
  host: string | undefined;
  /** SQLite path. ':memory:' when unset (tests / ephemeral). */
  dbPath: string;
  /** Deployment secret → AES key (enc:v1:) + saas JWT signing. */
  secret: string;
  /** Mock billing gateway enabled (private-internal 0.1.0). */
  mockBilling: boolean;
  /** Private-internal all-unlock: getPlan returns pro for everyone. */
  mockUnlockAll: boolean;
  /**
   * A2-5 / REQ-12-08 — may the per-event usage log actually RECORD anything.
   *
   * 🔴 DEFAULT OFF, AND THE DEFAULT IS THE FEATURE. The table, the repo, the
   * daily sweep and the read route ship regardless; what this gates is
   * COLLECTION. The published privacy policy owes users 30 days notice before
   * usage stops being a monthly bucket and starts being one row per utterance
   * (docs/legal/privacy-policy.md 「we will give 30 days' notice」), and the
   * asymmetry is what forces the default: shipping the code early costs
   * nothing, while a row written early cannot be un-collected by any later
   * ruling.
   *
   * Same shape and same precedent as `FLOWMIC_MANAGED_STT_ENABLED` on the VPS —
   * present, deliberately 0, flipped by owner and nobody else.
   *
   * ⚠️ It gates the WRITE only. Retention still sweeps (a keep-90-days promise
   * that lapses when a switch flips is not a promise), and the read routes are
   * still mounted (with the switch off they honestly answer "zero rows"
   * (零行) for a period during which nothing was recorded).
   *
   * Its state is announced at startup — billing/usage-tracker.ts logs one line
   * naming this variable either way, so nobody has to guess which state a
   * machine is in. A switch whose position cannot be observed is worse than no
   * switch.
   */
  usageEventsEnabled: boolean;
  /**
   * First-party public-site aggregate counts (2026-08-15).
   *
   * 🔴 DEFAULT OFF — same shape as `usageEventsEnabled`. The table, routes and
   * retention ship regardless; this gates COLLECTION only. The privacy policy
   * names the feature; flipping the switch before the policy page is live would
   * collect under a promise that is not yet on the site. Owner gate.
   *
   * Retention still sweeps with the switch off (a 90-day promise that lapses
   * when a feature is disabled is not a promise). Ops read routes stay mounted
   * and honestly answer zeros for periods with no collection.
   */
  siteAnalyticsEnabled: boolean;
  /**
   * LOGIN-1 (2026-08-19) — may a successful sign-in leave a record behind.
   *
   * Owner ruling: docs/decisions/owner-web-rulings/latest.md:59-62,
   * 「上次登录时间 / 登录流水」→「要记，并同步改隐私政策」, option value
   * `approve_with_policy`. The option value is the whole design constraint:
   * recording and the policy change are ONE piece of work, not two.
   *
   * 🔴 DEFAULT OFF, AND THE DEFAULT IS THE FEATURE — same shape, same argument
   * and the same precedent as `usageEventsEnabled` above. The column, the
   * migration, the write path and the ops projection all ship regardless; what
   * this gates is COLLECTION.
   *
   * 🔴 WHY OFF IS THE ONLY CORRECT DEFAULT HERE — AND THE OBVIOUS REASON IS THE
   * WRONG ONE, SO IT IS WRITTEN OUT RATHER THAN ASSUMED.
   * The reflex argument is「the live policy does not mention this yet, so
   * collecting would make it false」. THAT IS NOT TRUE OF THIS FIELD [measured
   * 2026-08-19]: docs/legal/privacy-policy.md has carried a
   * 「Last successful sign-in time」row since commit `82ba0e61`
   * (2026-08-12T05:13:43Z — about an hour after the ruling was processed), and
   * that row is already synced into the web repo's `vendor/legal/` mirror. So
   * today the published policy OVER-claims: it discloses a collection this
   * server does not perform. Turning the switch on would make that sentence
   * TRUE, not false.
   *
   * The default is still OFF, for three reasons that survive that correction:
   *   ① THE LIVE WORDING DESCRIBES SOMETHING ELSE. It said the time is kept
   *      「so you and operators can see when the account was last used」— which
   *      is ACTIVITY language for a value that only moves when a CREDENTIAL is
   *      presented. A person who signed in a week ago and used the product every
   *      day since would be shown a week-old date under the words「last used」.
   *      The corrected row (this repo, 2026-08-19) says what is actually
   *      recorded, and IT is not live.
   *   ② THE POLICY OWES 30 DAYS' NOTICE. Its own「Changes」section promises
   *      「30 days' notice by email and in the console」for a material change,
   *      and beginning a collection is material. No notice has been given. This
   *      is the same obligation `usageEventsEnabled` above is still waiting out.
   *   ③ PUBLISHING IS NOT OURS. Editing the file here does NOT change the live
   *      page — only a web-repo sync plus a deploy does, and both are owner's
   *      (the audit queue's Class C list carries「政策/条款对外上线」verbatim,
   *      with「草稿可先合」).
   * And the asymmetry that decides the direction in every case: shipping the
   * code early costs nothing, while a row written early cannot be un-collected
   * by any later ruling.
   *
   * ⚠️ It gates the WRITE only (auth/auth-service.ts `recordSignIn`). The
   * migration runs unconditionally — a schema that appears only when a switch is
   * on would make flipping the switch a migration — and the ops read route stays
   * mounted, honestly answering `login_recording:false` rather than 404ing.
   *
   * Its state is announced at startup, once, in BOTH directions
   * (auth/auth-service.ts `LOGIN_RECORD_SWITCH_LOG`): a switch whose position
   * cannot be observed is worse than no switch.
   *
   * 🔴 WHAT MUST BE TRUE BEFORE ANYBODY SETS THIS TO 1 — all four:
   *   1. the CORRECTED sign-in row is live on flowmic.app/privacy (web repo
   *      `vendor/legal/` re-synced from this repo AND deployed), not merely
   *      merged here;
   *   2. the 30 days' notice the policy promises has actually been given;
   *   3. the store-listing privacy answers carry the field
   *      (docs/strategy/2026-08-19-store-listing-metadata-draft.md — its own
   *      text requires it to move in the same batch as the policy);
   *   4. owner says go.
   * Nothing in this repo may open it.
   */
  loginRecordEnabled: boolean;
  /** GA-15: saas CORS allow-list (FLOWMIC_CORS_ORIGIN, comma separated).
   *  Defaults to the current production origin, so an unset env keeps today's
   *  behaviour exactly; standalone ignores it and stays '*'. */
  corsOrigins: string[];
  /** D1: Paddle (merchant-of-record) webhook intake. See PaddleConfig. */
  paddle: PaddleConfig;
  /** D2-LAN: the LAN TLS identity's home, or null when this deployment serves
   *  the LAN in plain only. See resolveLanTls for what「null」means and why it is
   *  the default in more cases than it might look. */
  lanTls: LanTlsConfig | null;
  /** A1: plan-quota overlay as CONFIGURED (null = nothing overridden). The
   *  RESOLVED table is not here — it lives in billing/plans.ts, installed by
   *  loadConfig, and is read through planLimits()/currentPlanLimits(). Two
   *  copies of the same table would be two answers to one question; this field
   *  answers only "what did the deployment configure" (部署配了什么) and exists
   *  so a diagnostics/console surface can say so out loud. */
  planLimits: PlanLimitsOverrides | null;
}

/** Paddle sandbox/production intake. We are NOT a payment processor: Paddle is
 *  the merchant of record and this block only describes how we authenticate the
 *  webhooks it sends us and how we translate its price ids into our tiers. */
export interface PaddleConfig {
  /** FLOWMIC_PADDLE_ENABLED. saas-only (forced false in standalone). */
  enabled: boolean;
  /** FLOWMIC_PADDLE_ENV. Default 'sandbox' — production must be said out loud. */
  env: PaddleEnv;
  /** FLOWMIC_PADDLE_WEBHOOK_SECRET. 🔴 NEVER logged, never persisted. */
  webhookSecret: string | null;
  /** FLOWMIC_PADDLE_API_KEY. 🔴 Same handling as the webhook secret.
   *
   *  ⚠️ 2026-08-21 CORRECTION (0.3.25 B2). This used to read 「Stored, unused
   *  this round (later reconciliation pulls)」, and it was true for twenty days:
   *  a grep for api.paddle.com across the tree returned nothing. It now has one
   *  consumer, billing/paddle/client.ts, and it is spent on real outbound calls
   *  whenever `writeEnabled` is on. */
  apiKey: string | null;
  /**
   * FLOWMIC_PADDLE_WRITE_ENABLED. 🔴 DEFAULTS OFF, and it is a SEPARATE switch
   * from `enabled` on purpose.
   *
   * `enabled` governs what we ACCEPT from Paddle (webhook intake); this governs
   * what we SEND to it. They are different risks and they must be openable
   * separately: intake is read-only and has been live for weeks, whereas a
   * write can cancel a paying customer or move money. Folding the two into one
   * flag would mean the day we turned intake on we also turned writes on, which
   * is precisely the kind of second consequence a single value should never
   * carry.
   *
   * ⚠️ Off does NOT mean 「pretend it worked」: every method on the client throws
   * a named error while it is off (PaddleWritesDisabledError). Nothing is
   * silently skipped.
   */
  writeEnabled: boolean;
  /** FLOWMIC_PADDLE_TOLERANCE_SEC. Signature timestamp skew window; 5 = the
   *  Paddle SDK default. */
  toleranceSec: number;
  /** FLOWMIC_PADDLE_PRICE_TIERS, JSON {"pri_xxx":"pro"}. The ONLY price_id →
   *  tier mapping; an unmapped price id is an `unmapped` ledger row, never a
   *  guessed tier. */
  priceTiers: Record<string, Plan>;
}

/** D2-LAN (design 2026-08-08 §4-2): where this machine's LAN TLS key + cert live.
 *  Present ⇒ the LAN listener accepts TLS in addition to plain. */
export interface LanTlsConfig {
  /** Directory holding `lan-tls.key.pem` + `lan-tls.cert.pem`. Shares its home
   *  and its lifecycle with `standalone.secret` and the database. */
  dir: string;
}

/**
 * Resolve the LAN TLS home, or null for「plain LAN only, exactly as today」.
 *
 * 🔴 null in three cases, and none of them is an error:
 *   ① saas — that deployment binds loopback behind an edge proxy that already
 *      terminates real TLS with a real certificate. A second, self-signed layer
 *      there would protect nothing and confuse the one that matters.
 *   ② `FLOWMIC_LAN_TLS=0` — the kill switch. This is a new listener in front of
 *      the port everything on this machine talks through; a deployment that hits
 *      trouble must be able to get today's behaviour back without a rebuild.
 *   ③ no durable home configured (no `FLOWMIC_LAN_TLS_DIR`, no `FLOWMIC_HOME`).
 *      This is the interesting one. The published fingerprint has to survive a
 *      restart — a phone pins it — and a server with nowhere to persist a key
 *      cannot promise that. Offering TLS anyway would mint a new identity every
 *      boot and invalidate every QR ever scanned, and the phone's correct
 *      response (refuse) is indistinguishable from a broken network. So the
 *      absence of a home is answered by not making the promise at all.
 *      In practice the desktop always passes `FLOWMIC_HOME` when it spawns the
 *      sidecar (apps/desktop/src-tauri/src/sidecar/io.rs, symbol `spawn_sidecar`),
 *      so the shipped product is case ③'s opposite; a bare `node dist/index.js`
 *      and the whole test suite are not, which is why neither changes behaviour.
 *
 * The failure direction of every branch is "back to today's plaintext"
 * (回到今天的明文), never "can't connect" (连不上).
 */
function resolveLanTls(mode: ServerMode): LanTlsConfig | null {
  if (mode !== 'standalone') return null;
  if (process.env.FLOWMIC_LAN_TLS === '0') {
    log.info('lan tls: disabled by FLOWMIC_LAN_TLS=0 — the LAN leg stays plain');
    return null;
  }
  const dir = process.env.FLOWMIC_LAN_TLS_DIR ?? process.env.FLOWMIC_HOME;
  if (dir === undefined || dir.trim() === '') return null;
  return { dir: dir.trim() };
}

export type PaddleEnv = 'sandbox' | 'production';
export const DEFAULT_PADDLE_TOLERANCE_SEC = 5;

/** The origin the production stack serves today — the default, not a hardcode:
 *  FLOWMIC_CORS_ORIGIN overrides it (that is the flowmic.app reverse-proxy
 *  prerequisite, owner's suspended item ④). */
export const DEFAULT_CORS_ORIGIN = 'https://flowmic.app';

function envCorsOrigins(): string[] {
  const raw = process.env.FLOWMIC_CORS_ORIGIN;
  if (raw === undefined) return [DEFAULT_CORS_ORIGIN];
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  // An env that is set but empty/blank is a misconfiguration, not a request to
  // allow nothing (which would silently break every browser call).
  if (list.length === 0) {
    throw new Error('config: FLOWMIC_CORS_ORIGIN is set but lists no origin');
  }
  return list;
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new Error(`config: ${name} must be an integer port 0..65535 (got ${v})`);
  }
  return n;
}

/** FLOWMIC_HOST bind-host override (both modes). Unset → mode default
 *  (standalone all-interfaces / saas loopback). Set-but-empty is garbage →
 *  fail loud at boot (13 §4: bind is fail-loud, never a silent 0.0.0.0 drift). */
function envHost(): string | undefined {
  const v = process.env.FLOWMIC_HOST;
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  if (trimmed === '') {
    throw new Error('config: FLOWMIC_HOST must be a non-empty host string when set');
  }
  return trimmed;
}

/** A secret-shaped env var: absent → null; present-but-blank → boot failure.
 *  A blank secret is never a request for "no secret", it is a broken deploy
 *  script, and the one thing we must not do with a broken secret is start. */
function envSecretString(name: string): string | null {
  const v = process.env[name];
  if (v === undefined) return null;
  const trimmed = v.trim();
  if (trimmed === '') {
    throw new Error(`config: ${name} is set but empty — remove it or give it a value`);
  }
  return trimmed;
}

function envToleranceSec(): number {
  const v = process.env.FLOWMIC_PADDLE_TOLERANCE_SEC;
  if (v === undefined || v.trim() === '') return DEFAULT_PADDLE_TOLERANCE_SEC;
  const n = Number(v);
  // Upper bound is not pedantry: the timestamp window is the only thing that
  // stops an intercepted-but-valid webhook from being replayed later, so an
  // "infinite tolerance" deploy would silently disable half the signature check.
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw new Error(`config: FLOWMIC_PADDLE_TOLERANCE_SEC must be an integer 1..3600 seconds (got ${v})`);
  }
  return n;
}

function envJson(name: string): unknown {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`config: ${name} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** FLOWMIC_PADDLE_PRICE_TIERS → {price_id: Plan}. Every value must be a real
 *  tier: a typo'd tier name that we accepted would map real money to a plan
 *  that does not exist, and the failure would only surface as a user who paid
 *  and stayed on free. */
function envPriceTiers(): Record<string, Plan> {
  const parsed = envJson('FLOWMIC_PADDLE_PRICE_TIERS');
  if (parsed === undefined) return {};
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('config: FLOWMIC_PADDLE_PRICE_TIERS must be a JSON object of {price_id: tier}');
  }
  const out: Record<string, Plan> = {};
  for (const [priceId, tier] of Object.entries(parsed as Record<string, unknown>)) {
    if (priceId.trim() === '') {
      throw new Error('config: FLOWMIC_PADDLE_PRICE_TIERS has an empty price id key');
    }
    if (!isPlan(tier)) {
      throw new Error(
        `config: FLOWMIC_PADDLE_PRICE_TIERS maps ${priceId} to "${String(tier)}", which is not a plan tier`,
      );
    }
    out[priceId] = tier;
  }
  return out;
}

function envPaddleEnv(): PaddleEnv {
  const v = process.env.FLOWMIC_PADDLE_ENV;
  if (v === undefined || v.trim() === '') return 'sandbox';
  const trimmed = v.trim();
  if (trimmed !== 'sandbox' && trimmed !== 'production') {
    throw new Error(`config: FLOWMIC_PADDLE_ENV must be 'sandbox' or 'production' (got ${v})`);
  }
  return trimmed;
}

/** Resolve the Paddle block: env → overrides → mode clamp → guards.
 *  ORDER MATTERS. The standalone clamp runs BEFORE the secret guard, so a dev
 *  box with FLOWMIC_PADDLE_ENABLED=1 left in its shell still boots (paddle just
 *  turns off, loudly) instead of demanding a secret it will never use. */
function resolvePaddle(mode: ServerMode, overrides: Partial<PaddleConfig> | undefined): PaddleConfig {
  const requested = overrides?.enabled ?? envFlag('FLOWMIC_PADDLE_ENABLED');
  let enabled = requested;
  if (mode === 'standalone' && enabled) {
    // standalone is a LAN server on someone's PC. There is no merchant of
    // record, no account, and nothing to bill — an open webhook endpoint there
    // would be pure attack surface.
    log.warn('paddle webhook intake is saas-only — forcing it OFF in standalone mode');
    enabled = false;
  }
  const webhookSecret = overrides?.webhookSecret !== undefined
    ? overrides.webhookSecret
    : envSecretString('FLOWMIC_PADDLE_WEBHOOK_SECRET');
  const apiKey = overrides?.apiKey !== undefined ? overrides.apiKey : envSecretString('FLOWMIC_PADDLE_API_KEY');
  const paddle: PaddleConfig = {
    enabled,
    env: overrides?.env ?? envPaddleEnv(),
    webhookSecret,
    apiKey,
    writeEnabled: overrides?.writeEnabled ?? envFlag('FLOWMIC_PADDLE_WRITE_ENABLED'),
    toleranceSec: overrides?.toleranceSec ?? envToleranceSec(),
    priceTiers: overrides?.priceTiers ?? envPriceTiers(),
  };

  // 🔴 An enabled webhook endpoint without a secret verifies nothing, which
  // means it ACCEPTS ANY EVENT ANYONE POSTS — free Pro for the whole internet.
  // Fail loud rather than serve that.
  if (paddle.enabled && (paddle.webhookSecret === null || paddle.webhookSecret === '')) {
    throw new Error(
      'config: FLOWMIC_PADDLE_ENABLED is on but FLOWMIC_PADDLE_WEBHOOK_SECRET is missing — ' +
        'an unauthenticated webhook endpoint would accept forged subscription events',
    );
  }
  if (paddle.enabled && Object.keys(paddle.priceTiers).length === 0) {
    // Not fatal: an intake with no mapping still records every event honestly
    // (outcome='unmapped'). But it can never upgrade anyone, and that is worth
    // one line at boot rather than a silent "why did I pay and not get upgraded"
    // (为什么付了钱没升级).
    log.warn('paddle is enabled but FLOWMIC_PADDLE_PRICE_TIERS is empty — every event will be recorded as unmapped');
  }
  if (paddle.enabled) {
    // 🔴 Secrets NEVER appear here. Length + presence is everything an operator
    // needs to tell "misconfigured" (配错了) from "not configured" (没配), and
    // everything an attacker gets.
    log.info('paddle webhook intake enabled', {
      env: paddle.env,
      tolerance_sec: paddle.toleranceSec,
      webhook_secret_len: paddle.webhookSecret === null ? 0 : paddle.webhookSecret.length,
      api_key_present: paddle.apiKey !== null,
      api_key_len: paddle.apiKey === null ? 0 : paddle.apiKey.length,
      price_tiers: Object.keys(paddle.priceTiers).length,
      // 🔴 Boot says which DIRECTION is open. An operator debugging 「the cancel
      // button does nothing」 needs to be able to tell 「we never turned writes on」
      // from 「we called Paddle and it said no」 without reading the source, and
      // this is the only line printed before anyone clicks anything.
      write_enabled: paddle.writeEnabled,
    });
    if (paddle.writeEnabled && (paddle.apiKey === null || paddle.apiKey === '')) {
      // NOT fatal, deliberately, and the asymmetry with the webhook-secret check
      // above is the argument: a missing webhook secret makes us ACCEPT forged
      // events (an open door), while a missing API key makes every outbound call
      // refuse itself by name (a closed one). Refusing to boot over the second
      // would take the whole relay down — intake, sockets, injection — over a
      // feature nobody can reach yet. One loud line, and the throw lands on
      // whoever clicks cancel.
      log.warn(
        'paddle WRITES are enabled but FLOWMIC_PADDLE_API_KEY is empty — every outbound call will refuse by name',
      );
    }
  } else if (requested !== enabled) {
    log.info('paddle webhook intake disabled', { mode });
  }
  return paddle;
}

export interface LoadConfigOverrides {
  mode?: ServerMode;
  port?: number;
  host?: string;
  dbPath?: string;
  secret?: string;
  secretPath?: string;
  mockBilling?: boolean;
  mockUnlockAll?: boolean;
  /** A2-5: explicit per-event usage logging (tests). Like every override here it
   *  WINS over the env var — which is how a test turns the collection ON without
   *  touching process.env, and how the OFF case is asserted without depending on
   *  an env var simply not being set. */
  usageEventsEnabled?: boolean;
  /** First-party site analytics collection (tests). Same override-wins shape. */
  siteAnalyticsEnabled?: boolean;
  /** LOGIN-1: sign-in recording (tests). Same override-wins shape — which is how
   *  the OFF case is asserted without depending on an env var merely not being
   *  set, i.e. without a test that would pass on a machine where somebody had
   *  exported it. */
  loginRecordEnabled?: boolean;
  /** GA-15: explicit CORS allow-list (tests / embedded hosts). */
  corsOrigins?: string[];
  /** D1: explicit Paddle block (tests). Merged cell-by-cell over the env values;
   *  the mode clamp and the secret guard still run on the merged result. */
  paddle?: Partial<PaddleConfig>;
  /** A1: explicit plan-limit overlay (tests). `null` = "no overrides" and, like
   *  every other override here, WINS over the env var. */
  planLimits?: PlanLimitsOverrides | null;
  /** D2-LAN: explicit LAN TLS home (tests / embedded hosts). `null` = "plaintext
   *  — today's status quo" (明文，就是今天) and, like every other override here,
   *  WINS over the env. */
  lanTls?: LanTlsConfig | null;
  /** fix-010: this deployment's proxy posture, DECLARED by the caller.
   *
   *  `[]` is a real answer — 「nothing is in front of me」 — which is why this is
   *  a list and not a truthiness flag. `undefined` means NOBODY SAID, and
   *  silence is the only thing the saas requirement below refuses. An in-process
   *  server (tests, embedded hosts) is not behind nginx and its direct peer IS
   *  the client, so `[]` is the honest declaration for it — not an exemption.
   *
   *  ⚠️ SCOPE, stated because the name invites a bigger reading: this satisfies
   *  the requirement below and nothing else. It does NOT configure who is
   *  trusted at request time — every per-IP derivation reads the env through
   *  `trustedProxiesFromEnv()` (http/trusted-proxy.ts), which this card
   *  deliberately leaves untouched. A non-empty value here is therefore a
   *  DECLARATION, not a configuration, and if it disagrees with the env then the
   *  ENV is what the limiters follow. Making this field the runtime source means
   *  threading a trust list through every limiter call site; until someone does
   *  that, do not read this as 「the server trusts these」. */
  trustedProxies?: readonly string[];
}

/** Resolve the runtime config from env + explicit overrides (tests). */
export function loadConfig(overrides: LoadConfigOverrides = {}): ServerConfig {
  const rawMode = overrides.mode ?? process.env.FLOWMIC_MODE ?? 'standalone';
  if (rawMode !== 'standalone' && rawMode !== 'saas') {
    throw new Error(`config: FLOWMIC_MODE must be 'standalone' or 'saas' (got ${rawMode})`);
  }
  const mode: ServerMode = rawMode;

  // saas requires an explicit secret; standalone auto-mints+persists (identity).
  if (mode === 'saas' && !overrides.secret && !process.env.FLOWMIC_JWT_SECRET && !process.env.FLOWMIC_SETTINGS_SECRET) {
    throw new Error('config: saas mode requires FLOWMIC_JWT_SECRET (no auto-generated secret in saas)');
  }
  const secret = resolveStandaloneSecret({
    ...(overrides.secret !== undefined ? { explicitSecret: overrides.secret } : {}),
    ...(overrides.secretPath !== undefined ? { secretPath: overrides.secretPath } : {}),
  });

  const port = overrides.port ?? envInt('FLOWMIC_PORT', mode === 'saas' ? DEFAULT_SAAS_PORT : DEFAULT_STANDALONE_PORT);
  // Precedence: explicit override (tests) → FLOWMIC_HOST env → mode default.
  const host = overrides.host ?? envHost() ?? (mode === 'saas' ? SAAS_LISTEN_HOST : undefined);
  // GA-15: `:memory:` is a fine default for standalone and for tests, and an
  // outright hazard in saas — W2 lost real registered users to exactly this
  // (the process restarted and the "database" was gone). A saas deployment that
  // does not say where its data lives must not start; standalone keeps the
  // convenient default but says out loud that nothing is being persisted.
  const explicitDbPath = overrides.dbPath ?? process.env.FLOWMIC_DB_PATH;
  if (mode === 'saas' && explicitDbPath === undefined) {
    throw new Error(
      'config: saas mode requires FLOWMIC_DB_PATH — refusing to run a production ' +
        'server on an in-memory database (GA-15; W2 lost registered users this way)',
    );
  }
  const dbPath = explicitDbPath ?? ':memory:';
  if (dbPath === ':memory:') {
    log.warn('database is IN-MEMORY — every row disappears on restart', { mode });
  }

  // fix-010 — saas must SAY what sits in front of it. Behind nginx the direct
  // peer of every public request is 127.0.0.1, and with an empty trust list
  // `clientIpFrom` answers with that peer (http/trusted-proxy.ts), so every
  // per-IP limiter — register + login (http/auth-routes.ts), password reset
  // (http/password-reset-routes.ts), pairing (socket/handlers/mobile.handler.ts)
  // — collapses into ONE bucket keyed on the proxy and shared by the whole
  // internet. The derivation module is CORRECT; what was missing is any surface
  // that reports a missing variable re-arming what that module disarmed, so a
  // saas deploy that forgot it booted completely clean.
  //
  // Satisfied by an explicit declaration OR by the env — the same shape as the
  // secret and db-path requirements above, and for the same reason: a caller
  // that states its configuration has configured it. What is refused is SILENCE,
  // not the empty list, which is why `[]` is accepted and `undefined` is not.
  //
  // 🔴 Deliberately NO env-settable bypass. An 「ignore this」 variable that tests
  // could use is one a production box could use, and this is the exact failure
  // mode the trusted-proxy module exists to prevent. A deployment that genuinely
  // has nothing in front of it declares so in code — a visible diff — rather
  // than through an env var set on a box at 2am.
  if (mode === 'saas' && overrides.trustedProxies === undefined && trustedProxiesFromEnv().length === 0) {
    // Numbers are DERIVED from the limiters they describe, never retyped: a
    // budget quoted in a second place is a copy, and the copy is the one that
    // goes stale the day someone tunes the real constant.
    const lockoutRequests = REGISTER_MAX_ATTEMPTS + 1;
    const lockoutMinutes = Math.round(REGISTER_WINDOW_MS / 60_000);
    const pairSeconds = Math.round(PAIR_IP_WINDOW_MS / 1_000);
    throw new Error(
      [
        `config: saas mode requires ${TRUSTED_PROXIES_ENV} — refusing to start with an undeclared proxy posture, because every per-IP limiter in this process would share ONE bucket.`,
        `CONSEQUENCE: saas serves the public through a reverse proxy, so the direct peer of every request is that proxy (127.0.0.1 for a same-box nginx). With an empty trust list the client-IP derivation ignores X-Forwarded-For and answers with that peer (http/trusted-proxy.ts, symbol clientIpFrom), so registration, login, password reset and mobile pairing all key their budgets on the SAME address. About ${lockoutRequests} requests from any one person would then lock registration and login for EVERY user for ${lockoutMinutes} minutes, and about ${PAIR_IP_MAX_FAILURES} wrong pairing codes would block pairing for everyone for ${pairSeconds} seconds.`,
        `FIX: set ${TRUSTED_PROXIES_ENV} to the literal IPs of the reverse proxies in front of this process — for a same-box nginx that is ${TRUSTED_PROXIES_ENV}=127.0.0.1,::1. Literal IPs only: no CIDR, no hostnames. Entries that do not parse as an IP are dropped and trusted by nothing, which is why a value that parses to nothing arrives here too.`,
        'DEPLOYMENT CONTRACT: this setting is only meaningful if the fronting proxy APPENDS to X-Forwarded-For (nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for). Under a pass-through proxy the header is whatever the client sent, and trusting that peer makes a forged hop the bucket key — which both evades every limit and burns the budget of whichever address it forges. Nothing here detects such a regression: it is a contract on the deployment, not a check.',
      ].join('\n'),
    );
  }

  // A1 — plan quotas. Parse + validate + INSTALL in one breath: there is no
  // window in which the overlay has been read and not applied, so the
  // "configured but not in effect" (配置了但没生效) failure has nowhere to live.
  // Anything malformed throws out of resolvePlanLimits and takes the boot with
  // it (never a silent default).
  const rawPlanLimits: unknown = overrides.planLimits !== undefined
    ? overrides.planLimits
    : (envJson('FLOWMIC_PLAN_LIMITS') ?? null);
  installPlanLimits(resolvePlanLimits(rawPlanLimits));
  // Only a value that resolvePlanLimits validated key-by-key and cell-by-cell
  // can reach this line — anything else threw above. The assertion is therefore
  // post-validation, not a hope about the shape of an env var.
  const planLimitOverrides = rawPlanLimits as PlanLimitsOverrides | null;
  if (planLimitOverrides !== null) {
    // Say which tiers were touched — an operator who edited the JSON must be
    // able to see, in the log, that the server agreed with them.
    log.info('plan limits overridden by configuration', { tiers: Object.keys(planLimitOverrides) });
  }

  return {
    mode,
    port,
    host,
    dbPath,
    secret,
    mockBilling: overrides.mockBilling ?? envFlag('FLOWMIC_MOCK_BILLING'),
    mockUnlockAll: overrides.mockUnlockAll ?? envFlag('FLOWMIC_MOCK_UNLOCK_ALL'),
    // A2-5 — unset ⇒ false ⇒ not one usage_events row is written. `envFlag`
    // accepts only '1'/'true', so a typo'd value fails CLOSED (no collection),
    // which is the safe direction for a switch guarding a data-collection
    // promise.
    usageEventsEnabled: overrides.usageEventsEnabled ?? envFlag('FLOWMIC_USAGE_EVENTS_ENABLED'),
    siteAnalyticsEnabled: overrides.siteAnalyticsEnabled ?? envFlag('FLOWMIC_SITE_ANALYTICS'),
    // LOGIN-1 — unset ⇒ false ⇒ not one `users.last_login_at` is written.
    // `envFlag` accepts only '1'/'true', so a typo'd value fails CLOSED (no
    // collection), which is the safe direction for a switch guarding a
    // data-collection promise. Named after the sentence it makes false:
    // http/ops-user-routes.ts said this repo has「no login record of any kind」.
    loginRecordEnabled: overrides.loginRecordEnabled ?? envFlag('FLOWMIC_LOGIN_RECORD_ENABLED'),
    corsOrigins: overrides.corsOrigins ?? envCorsOrigins(),
    lanTls: overrides.lanTls !== undefined ? overrides.lanTls : resolveLanTls(mode),
    paddle: resolvePaddle(mode, overrides.paddle),
    planLimits: planLimitOverrides,
  };
}
