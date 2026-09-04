// SPEC-REF:
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md
//     (Q1 dictionary merges into the card; Q2 b refine; Q3 a consent on the
//     phone; Q6 note "配置不进云端" — these preferences are never stored server-side)
//   docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md
//     D1 (carrier = per-key settings:update on the socket), D2 (this overlay),
//     D3 (the phone-owned key set), D11 (existing DB rows are left in place)
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md
//     (both channels are transit, never storage — the same rule, applied to
//     preferences)
//
// THE PHONE OWNS THESE PREFERENCES. A phone carries its scenario card, polish
// switch, refine switch and inference consent INSIDE the request that starts
// a cycle (`audio:start` / `compose:start` `prefs`, protocol phone-prefs.ts);
// the receiving handler puts that bundle on the socket for the one session
// (socket/wire.ts setSessionPrefs — replace, never merge), and every
// server-side reader of those keys — the STT
// factory, the compose factory — reads them THROUGH this overlay instead of
// the database. Nothing here writes a row; nothing here reads a phone-owned
// row from the database while a phone bundle is present.
//
// 🔴 THE FAILURE DIRECTION IS THE CONTRACT (design §2):
//   · prefs === null  ⇒ the request carried no bundle (an old phone). The database repo
//     is returned UNCHANGED — not wrapped, not filtered — so today's behaviour
//     is preserved byte for byte, including reading whatever rows the account
//     still has (D11: existing rows stay until owner orders them deleted).
//   · prefs !== null, key present ⇒ the phone's value, as a synthesised row.
//   · prefs !== null, key ABSENT  ⇒ `null` = "not set". NEVER the database
//     row. A phone that pushed a bundle without `stt.polish` has said "I hold no
//     such preference", and the reader's own absent-branch (its default) is the
//     honest answer (a key absent from the bundle is UNSET). Falling through to a stale DB row would let a preference
//     the user deleted on the phone keep acting from a server they cannot see —
//     the exact shape the owner's "配置不进云端" note forbids. The reverse
//     control for this line is in test/session-overlay.test.ts.
//   · `stt.dictionary` is RETIRED (Q1): under a phone bundle it answers null
//     unconditionally. The aliases it used to carry now live on the card's
//     terms (protocol scenario.ts, 2026-09-03).
//
// VALIDATION STAYS IN THE READERS. The bundle holds RAW values, exactly as the
// phone sent them; readCard / readSttPolish / readSttRefine parse with the
// same zod schemas and fail loud (SETTINGS_SCHEMA_INVALID) on a malformed one,
// exactly as they do for a malformed database row. The wire already refused a
// malformed bundle (PhonePrefsSchema inside the start frame), so a bundle
// value is normally already well-formed; the reader-side gate is what makes
// that a belt-and-braces fact rather than an assumption about the frame.
//
// `updated_at` on a synthesised row is the empty string: there is no stored
// moment to report and inventing one would be the lie `withEffectiveDefaults`
// (settings.handler.ts) already refuses to tell for computed rows. No reader on
// this path consumes the stamp (settings:list does not go through the overlay).

import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';

/**
 * The keys the phone owns (design D3). Literal strings on purpose, and NOT the
 * protocol `SETTINGS_KEY_*` constants: this list is the server's own statement
 * of "which keys are transit-only", and pinning it to the same strings the
 * readers anchor on (`readSetting('scenario.card')` etc.) is asserted in
 * test/session-overlay.test.ts rather than assumed through an import.
 */
export const PHONE_OWNED_SETTING_KEYS = [
  'scenario.card',
  'stt.polish',
  'stt.refine',
  'scenario.inference',
] as const;

export type PhoneOwnedKey = (typeof PHONE_OWNED_SETTING_KEYS)[number];

/** Q1: the personal dictionary is retired — its aliases moved onto the card's
 *  terms. A phone bundle makes this key answer null; a settings:update of it
 *  is refused by the settings handler (same disposition as the deleted
 *  singular `stt.routing`). */
export const RETIRED_SETTING_KEY_STT_DICTIONARY = 'stt.dictionary';

export function isPhoneOwnedKey(key: string): key is PhoneOwnedKey {
  return (PHONE_OWNED_SETTING_KEYS as readonly string[]).includes(key);
}

/** Every key the overlay intercepts: the four phone-owned ones plus the
 *  retired dictionary. Exported for the handler's refusal branch. */
export function isOverlayKey(key: string): boolean {
  return isPhoneOwnedKey(key) || key === RETIRED_SETTING_KEY_STT_DICTIONARY;
}

/**
 * One phone's preference bundle for one connection: a per-key map of RAW
 * values. A key that is not a property of the map was never pushed on this
 * socket. The value type is `unknown` on purpose — see the header: the readers
 * own validation, and typing the bundle would put a second, unenforced claim
 * about the shape next to the enforced one.
 */
export type SessionPrefs = { readonly [K in PhoneOwnedKey]?: unknown };

function hasOwn(prefs: SessionPrefs, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(prefs, key);
}

/**
 * Wrap a SettingsRepo so phone-owned keys answer from `prefs` and every other
 * key goes to the database. `prefs === null` returns `db` itself (old phone —
 * see the header for why this must be the SAME object and not a wrapper).
 */
export function overlaySettings(db: SettingsRepo, prefs: SessionPrefs | null): SettingsRepo {
  if (prefs === null) return db;
  const synthesised = (userId: string, key: string): SettingRow | null => {
    if (!hasOwn(prefs, key)) return null;
    const value = (prefs as Record<string, unknown>)[key];
    // `undefined` in the bundle is "pushed with no value" and reads as absent,
    // the same way the readers treat a stored `null` value.
    if (value === undefined) return null;
    return { user_id: userId, key, value, updated_at: '' };
  };
  return {
    read(userId, key): SettingRow | null {
      if (key === RETIRED_SETTING_KEY_STT_DICTIONARY) return null;
      if (isPhoneOwnedKey(key)) return synthesised(userId, key);
      return db.read(userId, key);
    },
    readAll(userId): SettingRow[] {
      // The database's phone-owned rows are hidden for the same reason read()
      // never falls through to them; the bundle's keys are appended so a
      // reader that enumerates sees the same world read() answers from.
      const rows = db.readAll(userId).filter((r) => !isOverlayKey(r.key));
      for (const key of PHONE_OWNED_SETTING_KEYS) {
        const row = synthesised(userId, key);
        if (row !== null) rows.push(row);
      }
      return rows;
    },
    write(userId, key, value, now): SettingRow {
      // No reader on this path writes; a write of a phone-owned key through the
      // overlay would be the storage the owner's note forbids, so it is refused
      // loudly rather than forwarded to the database.
      if (isOverlayKey(key)) {
        throw new Error(`session overlay: '${key}' is phone-owned and is never written server-side`);
      }
      return db.write(userId, key, value, now);
    },
    remove(userId, key): boolean {
      if (isOverlayKey(key)) {
        throw new Error(`session overlay: '${key}' is phone-owned and is never written server-side`);
      }
      return db.remove(userId, key);
    },
  };
}
