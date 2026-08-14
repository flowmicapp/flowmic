// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (user_settings PK (user_id,key), value TEXT),
//     §2 (enc:v1: envelope for any api_key/apiKey field — server-decryptable,
//     STRICTLY distinct from timeline e2e:v1:), §5 (KV key list)
//   Ported walkEncrypt/walkDecrypt mechanism from legacy user-settings.repo.ts.
//
// At-rest encryption only: the wire (settings:list / settings:updated) carries
// PLAINTEXT; the repo wraps on write and unwraps on read. Any JSON field named
// `api_key`/`apiKey` (top-level or nested) is enc:v1: enveloped. The method names
// here (read/readAll/write/remove) are the STORAGE layer — keys always arrive as
// variables, so this file is intentionally NOT where the settings-key-drift lint
// anchors. Per decision 2026-07-23-settings-key-drift-literal-anchors the literal-
// key GET anchors live in the real consumers, each pairing with a UI literal SET
// anchor: compose/scenario-context.ts (readSetting('scenario.card') ↔ mobile +
// desktop), compose/llm-config.ts (readSetting('llm.config') ↔ desktop, WP-R2-2),
// stt/engine-factory.ts (readSetting('stt.routings') ↔ desktop, WP-R2-2), and
// stt/stt-polish-settings.ts (readSetting('stt.polish') ↔ desktop, WP-R4-6);
// this repo just serves whatever variable key its callers pass.

import type { DatabaseSync } from 'node:sqlite';
import { ENVELOPE_PREFIX, decrypt, encrypt } from '../../auth/crypto';

export interface SettingRow {
  user_id: string;
  key: string;
  /** JSON-deserialised; api_key fields decrypted on read. */
  value: unknown;
  updated_at: string;
}

export interface SettingsRepo {
  readAll(user_id: string): SettingRow[];
  read(user_id: string, key: string): SettingRow | null;
  write(user_id: string, key: string, value: unknown, now?: string): SettingRow;
  remove(user_id: string, key: string): boolean;
}

function isApiKeyField(name: string): boolean {
  return name === 'api_key' || name === 'apiKey';
}

function walkEncrypt(value: unknown, key: Buffer): unknown {
  if (Array.isArray(value)) return value.map((v) => walkEncrypt(v, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isApiKeyField(k)) {
        if (typeof v === 'string' && v.startsWith(ENVELOPE_PREFIX)) out[k] = v; // already wrapped
        else if (typeof v === 'string' && v.length > 0) out[k] = encrypt(v, key);
        else out[k] = v; // null / '' → verbatim
      } else {
        out[k] = walkEncrypt(v, key);
      }
    }
    return out;
  }
  return value;
}

function walkDecrypt(value: unknown, key: Buffer): unknown {
  if (Array.isArray(value)) return value.map((v) => walkDecrypt(v, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isApiKeyField(k) && typeof v === 'string' && v.startsWith(ENVELOPE_PREFIX)) {
        out[k] = decrypt(v, key); // throws on tamper → surfaced by caller
      } else {
        out[k] = walkDecrypt(v, key);
      }
    }
    return out;
  }
  return value;
}

export function makeSettingsRepo(db: DatabaseSync, encryptionKey: Buffer): SettingsRepo {
  const listStmt = db.prepare('SELECT * FROM user_settings WHERE user_id=? ORDER BY key ASC');
  const getStmt = db.prepare('SELECT * FROM user_settings WHERE user_id=? AND key=?');
  const upsertStmt = db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  );
  const delStmt = db.prepare('DELETE FROM user_settings WHERE user_id=? AND key=?');

  function toRow(r: Record<string, unknown>): SettingRow {
    const parsed = JSON.parse(r.value as string) as unknown;
    return {
      user_id: r.user_id as string,
      key: r.key as string,
      value: walkDecrypt(parsed, encryptionKey),
      updated_at: r.updated_at as string,
    };
  }

  return {
    readAll(user_id): SettingRow[] {
      return (listStmt.all(user_id) as Record<string, unknown>[]).map(toRow);
    },
    read(user_id, key): SettingRow | null {
      const r = getStmt.get(user_id, key) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    write(user_id, key, value, now): SettingRow {
      const wrapped = walkEncrypt(value, encryptionKey);
      const updated_at = now ?? new Date().toISOString();
      upsertStmt.run(user_id, key, JSON.stringify(wrapped), updated_at);
      // Echo the caller's plaintext; the enc:v1: artifact stays internal.
      return { user_id, key, value, updated_at };
    },
    remove(user_id, key): boolean {
      return Number(delStmt.run(user_id, key).changes) > 0;
    },
  };
}
