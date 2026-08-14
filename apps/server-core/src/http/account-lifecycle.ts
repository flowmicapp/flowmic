// SPEC-REF:
//   docs/legal/privacy-policy.md 「Your rights」 (export it in a portable format;
//     delete it — 「Deleting your account removes your user record, and the
//     database cascades that deletion to your devices, settings, usage rows, and
//     stored records」)
//   docs/legal/terms-of-service.md §「You may close your account at any time from
//     the console」
//   docs/rebuild/05-DATA-MODEL.md §1 (the nine live tables and their FKs),
//     §2 (enc:v1: at rest under a SERVER-held key — never exported decrypted),
//     §5 (user_settings KV; account.password_reset holds a live credential)
//   src/db/schema.ts (the DDL that argues every ON DELETE CASCADE, and argues the
//     two deliberate NON-cascades: billing_events / ops_audit_log)
//   CLAUDE.md red line: no silent failures (both directions) / one value
//     answers only one question
//   *** HUMAN-AUDIT SENSITIVE (auth: irreversible destruction of an account) —
//       reviewable in isolation ***
//
// 0.3.0 P4 — THE TWO GDPR OBLIGATIONS, as pure functions over the repos.
//
// WHY A MODULE AND NOT TWO MORE BLOCKS IN console-routes.ts: that file is the
// HTTP surface (match a path, prove a Bearer, answer). What is being decided here
// — what a data export may contain, and what "deleting the account" actually destroys — is neither
// of those, it has to be readable without a request in hand, and it is the half a
// human audit needs to read on its own. (console-routes.ts is also 619 lines
// against the repo's 800-line cap; two inlined route bodies with the argument they
// require would have spent that budget on the wrong file.)
//
// ── 🔴 WHAT THIS MODULE MAY NEVER PUT ON THE WIRE ──────────────────────────────
// An account export is a file a user downloads, mails to themselves, and loses.
// So it carries the account's DATA and none of its CREDENTIALS. Four exclusions,
// each argued at its own call site below, none of them silent (the export names
// what it left out, in `omitted`, so a reader can tell "we didn't give you this" apart from
// "you don't have this"):
//   ① password_hash        — never leaves the server, in any shape;
//   ② device_token / mobile_token — LIVE credentials: a leaked export would be a
//      working key to the account's devices, which is strictly worse than the
//      export being incomplete;
//   ③ user_settings api_key/apiKey — the user's OWN third-party keys. They are
//      enc:v1: at rest under a SERVER-held key, and SettingsRepo.readAll hands
//      back plaintext, so the redaction happens HERE, after the read. Exporting
//      them decrypted would move a secret from 「we hold it encrypted」 to 「it is
//      in a file in your downloads folder」;
//   ④ the `account.password_reset` KV row — a live, unspent password-reset token.
//      Exporting it would turn 「download my data」 into a takeover primitive for
//      anyone who later reads the file.

import type { MobileRepo } from '../db/repos/mobile.repo';
import type { PcRepo } from '../db/repos/pc.repo';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { UsageRepo } from '../db/repos/usage.repo';
import { isPlatformAccount, type UserRecord, type UserRepo } from '../db/repos/user.repo';

/** The export envelope's format tag. Versioned because the FIRST consumer of a
 *  portable file is always the SECOND version of the thing that wrote it. */
export const ACCOUNT_EXPORT_SCHEMA = 'flowmic.account-export.v1';

/**
 * Every table the `users` row cascades into — the delete's full blast radius.
 *
 * 🔴 THIS CONSTANT IS NOT THE MECHANISM, IT IS A CLAIM ABOUT THE MECHANISM, and
 * that is the whole reason it is pinned by a test rather than merely written
 * down. The deletion itself is one `DELETE FROM users` (user.repo.ts `remove`);
 * SQLite does the cascade from the DDL. A hand-maintained list beside a mechanism
 * that does not read it is this repo's anti-façade ④ shape — a comment asserting
 * someone else's behaviour, whose truth changes when they change and which never
 * changes itself. So `test/account-lifecycle.test.ts` re-derives this exact set
 * from `PRAGMA foreign_key_list` on a live database: a seventh table with an FK
 * to users that is NOT listed here fails, and so does a listed table that stops
 * cascading.
 *
 * Sorted, so the assertion compares sets without either side needing an opinion
 * about order.
 */
export const USER_CASCADING_TABLES = [
  // VERIFY-1 (2026-08-11): the pending email-verification code. Deleting the
  // account deletes it — a pending code outliving its account would be a
  // credential for a person that no longer exists (db/schema.ts carries the
  // DDL argument). First in the list only because the census is sorted.
  'email_verifications',
  'mobile_pairings',
  'paddle_subscriptions',
  'pc_devices',
  'timeline_blobs',
  // GRANT-1 (2026-08-11): web-preview grant authorization rows. Deleting the
  // account deletes them — a grant outliving its account would be a standing
  // authorization to read a blind store whose rows the same cascade already
  // destroyed (inert, but a delete that leaves authorization facts behind is
  // exactly what this census exists to catch).
  'timeline_grants',
  // SALT-1 (2026-08-11): the blind-store key metadata row (KDF salt +
  // verification sentinel). Deleting the account deletes it — key metadata
  // surviving its account would be exactly the leftover a hand-written delete
  // list forgets, and the ciphertexts it unlocked die in `timeline_blobs` on
  // the same cascade.
  'timeline_keymeta',
  // A2-5 / REQ-12-08 (2026-08-12): the per-event usage log. Deleting the account
  // deletes it — a per-utterance record of a person who asked to be erased is the
  // single worst leftover this census could miss, and it is exactly the kind a
  // hand-written delete list forgets because the table is new. It cascades for
  // the same DDL reason as `usage_records` beside it; the difference between the
  // two is retention (90 days here, never swept there), not deletion.
  'usage_events',
  'usage_records',
  'user_settings',
] as const;

/**
 * The tables an account deletion deliberately does NOT touch, and which the
 * response therefore names out loud ("no silent failures" covers the direction where a
 * caller would otherwise believe more was destroyed than was).
 *
 * · `billing_events` — its DDL states the trade-off in as many words: "user_id
 *   deliberately has no FK — events that cannot be claimed by a person must
 *   still leave a trace" and "the lead ruled on 2026-08-01 to keep the status
 *   quo: residual ledger rows after account deletion are the visible
 *   consequence of that trade-off". It is also the webhook IDEMPOTENCY
 *   ledger, keyed on `event_id`: deleting a row would let a redelivered Paddle
 *   event be applied a second time. 0.3.0 is FREE with no payments (owner
 *   ruling), so in practice this set is empty — but "it should be empty" is a prediction
 *   and the delete response reports the real count instead.
 * · `ops_audit_log` — "an audit record that can be deleted is not an audit
 *   record, and deleting an account is exactly the kind of action that most
 *   needs to leave a trace" (schema.ts). Its `actor_user_id` carries no FK for exactly this
 *   reason.
 */
export const USER_RETAINED_TABLES = ['billing_events', 'ops_audit_log'] as const;

/** The `user_settings` keys an export must never carry. A SET, not a prefix
 *  match: "exclude everything that starts with account." would also swallow legitimate account
 *  preferences, and a rule that hides more than it says is how an export starts
 *  quietly omitting things nobody decided to omit. */
export const EXPORT_EXCLUDED_SETTING_KEYS: readonly string[] = ['account.password_reset'];

/** What a redacted secret reads as in the export. A sentence rather than `null`:
 *  `null` would say "you haven't configured this", which is a different fact. */
const REDACTED = '[redacted: encrypted at rest under a server-held key, never exported]';

/** The `api_key`/`apiKey` field names settings.repo.ts encrypts. Mirrored (not
 *  imported — that predicate is module-private there) and pinned by a test that
 *  drives a REAL SettingsRepo write, so the mirror cannot drift silently. */
function isApiKeyField(name: string): boolean {
  return name === 'api_key' || name === 'apiKey';
}

/** Deep-copy a settings value with every api_key/apiKey leaf replaced. Walks the
 *  same shape settings.repo.ts's walkEncrypt/walkDecrypt do — nested objects and
 *  arrays included, because a routing list is exactly that shape. */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isApiKeyField(k) && typeof v === 'string' && v.length > 0 ? REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** The repo reads an export needs. Sliced per repo (never the whole DbConnection)
 *  so this module structurally cannot reach a write path it has no business
 *  having — the same discipline ops-audit-trail.ts applies to its sink. */
export interface AccountExportStores {
  pcs: Pick<PcRepo, 'listByUser'>;
  mobiles: Pick<MobileRepo, 'listByPc'>;
  settings: Pick<SettingsRepo, 'readAll'>;
  usage: Pick<UsageRepo, 'listByUser'>;
}

export interface AccountExport {
  schema: string;
  exported_at: string;
  account: {
    id: string;
    email: string | null;
    display_name: string;
    plan: string;
    locale: string;
    created_at: string;
  };
  pc_devices: unknown[];
  mobile_pairings: unknown[];
  settings: { key: string; value: unknown; updated_at: string }[];
  usage_records: { month: string; stt_minutes: number; llm_tokens_in: number; llm_tokens_out: number; updated_at: string }[];
  /** 🔴 What is deliberately NOT in this file, and why. An export that silently
   *  drops fields is indistinguishable from an account that never had them. */
  omitted: Record<string, unknown>;
}

/**
 * Build the account's portable JSON — 「see what we hold about you」 + 「export it」.
 *
 * Reads through the SAME repo methods the console's own read routes use
 * (`pcs.listByUser` / `mobiles.listByPc` / `settings.readAll` / the usage table),
 * so there is no second source of truth for what an account owns: an export that
 * queried its own way could disagree with GET /api/cloud/devices about how many
 * phones are paired, and only one of them could be right.
 *
 * 🔴 SCOPE IS THE PROVEN SUBJECT, ALWAYS. The `user` argument is the row the
 * Bearer verified (http/account-auth.ts `accountUserFromBearer`); nothing here
 * takes a user id from a caller, and there is no parameter through which one
 * could arrive. Pairings are reached THROUGH this account's PC rows, which is the
 * same traversal /api/cloud/devices uses, so a pairing on someone else's PC is
 * unreachable by construction rather than by a filter somebody has to remember.
 */
export function buildAccountExport(user: UserRecord, stores: AccountExportStores, nowMs: number): AccountExport {
  const pcs = stores.pcs.listByUser(user.id);
  const settings = stores.settings
    .readAll(user.id)
    .filter((row) => !EXPORT_EXCLUDED_SETTING_KEYS.includes(row.key))
    .map((row) => ({ key: row.key, value: redactSecrets(row.value), updated_at: row.updated_at }));
  return {
    schema: ACCOUNT_EXPORT_SCHEMA,
    exported_at: new Date(nowMs).toISOString(),
    // password_hash is not omitted here by filtering — it is simply never named.
    // A projection that listed it and then deleted it would be one refactor away
    // from shipping it.
    //
    // ⚠️ THE TWO OPERATIONAL FLAGS ARE NOT HERE EITHER, and the reason is not
    // secrecy: `is_admin` and `permanent_free` are OUR classification OF the
    // account (an access-control bit and a billing exemption), not data about the
    // person, and they are the two columns docs/legal/privacy-policy.md's 「what we
    // hold」 table does not list. Exporting them would put a field in a portable
    // file that the policy does not even claim to hold. Keeping `is_admin` out of
    // this module ALSO keeps the column confined to the three files
    // test/console-admin-gate-coverage.test.ts allows to name it — the delete
    // guard asks `isPlatformAccount(user)` (db/repos/user.repo.ts) instead, which
    // is a predicate over the record and not a second reading of the column.
    // `omitted.account_flags` says all this on the wire.
    account: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      plan: user.plan,
      locale: user.locale,
      created_at: user.created_at,
    },
    // Same field names as the GET /api/cloud/devices projection: one shape for
    // 「a device, publicly」, so a console rendering either one shows the same
    // thing. device_token is absent there too, for the same reason.
    pc_devices: pcs.map((pc) => ({
      pc_id: pc.id,
      device_name: pc.device_name,
      client_instance_id: pc.client_instance_id,
      machine_uid: pc.machine_uid,
      is_online: pc.is_online === 1,
      last_seen_at: pc.last_seen_at,
      created_at: pc.created_at,
    })),
    mobile_pairings: pcs.flatMap((pc) =>
      stores.mobiles.listByPc(pc.id).map((m) => ({
        pairing_id: m.id,
        pc_id: m.pc_device_id,
        mobile_name: m.mobile_name,
        device_uid: m.device_uid,
        paired_at: m.paired_at,
        last_seen_at: m.last_seen_at,
      })),
    ),
    settings,
    usage_records: stores.usage.listByUser(user.id).map((u) => ({
      month: u.month,
      stt_minutes: u.stt_minutes,
      llm_tokens_in: u.llm_tokens_in,
      llm_tokens_out: u.llm_tokens_out,
      updated_at: u.updated_at,
    })),
    omitted: {
      password_hash: 'never exported — it is a credential, not data about you',
      device_token: 'never exported — a live key to your PC pairing',
      mobile_token: 'never exported — a live key to your phone pairing',
      settings_api_keys: `redacted in place as ${JSON.stringify(REDACTED)} — encrypted at rest under a server-held key`,
      settings_keys: EXPORT_EXCLUDED_SETTING_KEYS,
      account_flags:
        'not exported — the admin bit and the permanent-free exemption are our operational classification of this account, not data about you, and the privacy policy does not list them among what we hold',
      timeline_blobs:
        'not exported — end-to-end encrypted (e2e:v1:); the server stores ciphertext it cannot read, so it has no portable form to hand you here',
    },
  };
}

// ── DELETION ────────────────────────────────────────────────────────────────

/** The exact literal a caller must send in `confirm`. A fixed word rather than
 *  「any truthy value」: `{"confirm":true}` is something a client library can
 *  produce by accident, and a typed English verb is not. */
export const DELETE_CONFIRM_LITERAL = 'DELETE';

export interface DeleteConfirmationVerdict {
  ok: boolean;
  /** Present iff `ok` is false — the sentence the 400 carries. It names the
   *  missing field, never the account. */
  message?: string;
}

/**
 * 🔴 THE CONFIRMATION SHAPE — the only thing between a stray POST and an
 * irreversible destruction.
 *
 * Three fields, three questions, and none of them is 「who are you」 (the Bearer
 * already answered that, and this route has NO target parameter — the account
 * destroyed is always the proven subject):
 *
 *   `confirm_user_id`  "is this the one you want to delete" — must equal the account the Bearer
 *      proved. It catches the real-world mistake this guard exists for: a console
 *      showing account A while the browser still holds B's token. Not a secret,
 *      so a plain compare — the caller already knows their own id (GET /api/me).
 *   `confirm`          "do you really want to destroy it" — the literal 'DELETE'.
 *   `acknowledge_platform_account`  "do you know this is the platform's own account" — required ONLY
 *      when `isPlatformAccount(user)` (db/repos/user.repo.ts), i.e. owner's
 *      `permanent_free=1, is_admin=1` account and anything else carrying either
 *      bit. Deleting that one takes the platform's own devices, settings and
 *      usage with it and nothing in this product can put it back.
 *
 * ⚠️ Order matters for the MESSAGE, not for the outcome: every branch refuses.
 * The platform check is LAST so that a caller who got the basic shape wrong is
 * told about the shape, rather than being handed the fact that this account
 * carries an operations bit.
 */
export function checkDeleteConfirmation(body: Record<string, unknown>, user: UserRecord): DeleteConfirmationVerdict {
  if (body.confirm !== DELETE_CONFIRM_LITERAL) {
    return { ok: false, message: `confirm must be the exact string ${JSON.stringify(DELETE_CONFIRM_LITERAL)} — account deletion is irreversible` };
  }
  if (typeof body.confirm_user_id !== 'string' || body.confirm_user_id !== user.id) {
    return { ok: false, message: "confirm_user_id must equal the authenticated account's own id (GET /api/me)" };
  }
  if (isPlatformAccount(user) && body.acknowledge_platform_account !== true) {
    return {
      ok: false,
      message:
        'this account carries a platform bit (admin and/or permanent-free); deleting it requires acknowledge_platform_account: true',
    };
  }
  return { ok: true };
}

export interface AccountDeleteStores {
  users: Pick<UserRepo, 'remove'>;
}

export interface AccountDeleteResult {
  ok: true;
  /** Whether a `users` row was actually removed. `false` means the account was
   *  already gone — a truthful answer, not an error, and not a fake success. */
  deleted: boolean;
  user_id: string;
  /** Stated on every response, because it is the one property of this route a
   *  client's copy has to get right. */
  irreversible: true;
  /** The tables THIS CALL's cascade emptied.
   *
   *  Present on every response as an array (never omitted): when `deleted` is
   *  false the value is `[]`. Chosen over an absent field because the two are
   *  not equivalent — `[]` asserts 「this call emptied nothing」, which is the
   *  true answer for an already-gone account; omitting the field would assert
   *  「there is nothing to say about a cascade」, which refuses to answer a
   *  question the caller is entitled to ask (「did this request destroy any
   *  rows?」). An empty list is a claim about work; an absent field is a claim
   *  about topicality. Only the first is honest here.
   *
   *  Two production consumers: the server WARN line, and the HTTP response body
   *  (`console-routes.ts` → `sendJson(res, 200, result)`). The latter leaves this
   *  repo for the web console — so `[]` vs absent is a cross-repo contract, not
   *  something that can be "simplified" because "only our own log reads it".
   *
   *  ⚠️ Not every field on this object follows that rule — see `irreversible`
   *  (stated every time on purpose) and `retained` (policy, not work). */
  cascaded: readonly string[];
  /** Static policy: the tables an account deletion deliberately never touches.
   *  Named on EVERY response (including `deleted: false`) because it answers
   *  「what does this operation refuse to destroy」, not 「what did this call just
   *  spare」. On a repeat delete there was no work to spare anything from, but
   *  the policy is still the same sentence — so it stays. See
   *  USER_RETAINED_TABLES for the per-table argument. */
  retained: readonly string[];
}

/**
 * Destroy the account. One statement, and the schema does the rest.
 *
 * There is nothing to undo afterwards: no tombstone, no soft-delete column, no
 * 30-day grace bucket. That is the promise docs/legal/privacy-policy.md makes
 * (「removes your user record, and the database cascades that deletion」), and a
 * hidden soft-delete would make that sentence false while looking identical to a
 * caller.
 *
 * ⚠️ WHAT THIS DOES **NOT** DO, stated here rather than discovered later:
 *   · it does not force-disconnect sockets that are ALREADY connected. The
 *     account's tokens die immediately (their rows are gone, so
 *     auth/middleware.ts refuses every future handshake — proven in
 *     test/account-lifecycle.test.ts against the real middleware), but a socket
 *     that is up right now stays up until it next reconnects. This is the SAME
 *     boundary POST /api/cloud/devices/revoke already has; making it different
 *     for one of the two would mean two answers to "what happens to that
 *     connected socket after revocation". What such a socket cannot do is resurrect the account: every insert it
 *     could still attempt carries `user_id REFERENCES users(id)` and now fails the
 *     FK loudly.
 *   · it writes NO `ops_audit_log` row. That table has exactly one production
 *     writer by design (http/ops-audit-trail.ts `adminGate`), asserted from the
 *     source tree by test/ops-audit-wiring.test.ts, and a self-service deletion is
 *     not an admin action. The record of this event is the WARN log line the route
 *     emits. 🔴 This is a real gap and it is on the ledger, not papered over:
 *     schema.ts argues that `ops_audit_log` carries no FK precisely because
 *     "deleting an account is exactly the kind of action that most needs to
 *     leave a trace" — so the DDL expects deletions to be
 *     traceable and today they are only traceable in the log file.
 */
export function deleteAccount(userId: string, stores: AccountDeleteStores): AccountDeleteResult {
  const deleted = stores.users.remove(userId);
  return {
    ok: true,
    deleted,
    user_id: userId,
    irreversible: true,
    // Report cascade work ONLY when a row was actually removed. A manufactured
    // constant list beside `deleted: false` would answer two questions in one
    // frame — 「was there an account」 (honest no) and 「which tables did we empty」
    // (six names of work that did not happen). See AccountDeleteResult.cascaded
    // for why the honest shape is `[]` rather than an absent field.
    cascaded: deleted ? USER_CASCADING_TABLES : [],
    // Policy statement, not a claim about this call's work — always the same.
    retained: USER_RETAINED_TABLES,
  };
}
