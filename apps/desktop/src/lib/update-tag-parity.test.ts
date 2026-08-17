// 🔴 UP-3b — bind the frontend's failure-sentence table to Rust's taxonomy.
//
// ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
//
// CLAUDE.md carries a standing, unpaid account, written after the last time this
// exact shape bit:
//
// > 🔴 **仍然开着的根因**：**没有任何机制把协议注册表与手机那张表绑在一起**
// > ——下一个新码会以同样的方式变成用户屏幕上的裸标识符，而所有门禁全绿。
// > (The root cause that's still open: there is no mechanism binding the protocol
// > registry to the phone's own copy of the table — the next new code will, in the
// > same way, turn into a bare identifier on the user's screen, while every gate
// > stays green.)
//
// The desktop's update chain has the same two-sided table: `UpdateFailure` in
// Rust decides WHICH failure, `update.ts` holds the four-locale sentence, and
// nothing in the type system spans the gap. Rust's own exhaustive `match` in
// `tag()` guarantees every variant HAS a tag; it cannot know whether anybody
// wrote a sentence for it.
//
// So this test reads `failure.rs` as DATA and parses the arms out of `tag()`.
// It is the `bundled-node.mjs` / `publish.mjs` technique the repo already uses
// in three places, pointed at our own source.
//
// 🔴 WHY THIS ASSERTION COSTS SOMETHING. The obvious version — comparing
// `FAILURE_KEYS` against a list of tags written in this file — would move both
// sides at once and stay green forever. This reads the OTHER language's source.
// Adding a variant in Rust without a sentence here turns it red, which is the
// only moment anyone would ever notice.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAILURE_KEYS } from './update-view';
import { UPDATE_STRINGS } from './strings/update';
import { UI_LOCALES } from './strings/locale';

const FAILURE_RS = fileURLToPath(new URL('../../src-tauri/src/update/failure.rs', import.meta.url));

/**
 * Every tag `UpdateFailure::tag()` can return.
 *
 * Parsed from the body of `pub fn tag`, so a tag mentioned in a doc comment
 * elsewhere in the file cannot be mistaken for a real arm — the same lesson the
 * Rust-side ordering guard learned when a comment fooled it.
 */
function rustTags(): string[] {
  const src = readFileSync(FAILURE_RS, 'utf8');
  const start = src.indexOf('pub fn tag(&self)');
  expect(start, `could not find tag() in ${FAILURE_RS}`).toBeGreaterThan(-1);
  // The function ends at the first line that closes it at the impl's indent.
  const body = src.slice(start, src.indexOf('\n    }', start));
  const tags = [...body.matchAll(/=>\s*"([a-z0-9_]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  expect(tags.length, 'parsed no tags — the match arms must have been reshaped').toBeGreaterThan(5);
  return [...new Set(tags)].sort();
}

describe('update failure tags: Rust ↔ the per-locale sentences', () => {
  it('🔴 every Rust failure tag has a sentence, and every sentence has a tag', () => {
    const rust = rustTags();
    const ours = Object.keys(FAILURE_KEYS).sort();
    const missing = rust.filter((t) => !ours.includes(t));
    const extra = ours.filter((t) => !rust.includes(t));
    expect(
      { missing, extra },
      'a tag with no sentence renders as a bare identifier on a user’s screen; a sentence with ' +
        'no tag is copy for a failure that cannot happen',
    ).toEqual({ missing: [], extra: [] });
  });

  it('every mapped key really exists in all four locales', () => {
    for (const key of Object.values(FAILURE_KEYS)) {
      for (const loc of UI_LOCALES) {
        const table = UPDATE_STRINGS[loc] as Record<string, string | undefined>;
        expect(table[key], `${loc} is missing ${key}`).toBeTruthy();
      }
    }
  });

  /**
   * 🔴 unknown ≠ up to date, asserted over every failure sentence in every language.
   *
   * The Rust side has the mirror of this test over its diagnostic strings
   * (`no_failure_ever_describes_itself_as_up_to_date`). Neither half can catch
   * the other's drift, which is exactly why both exist: the judgement is in Rust
   * and the words are here.
   */
  it('🔴 no failure sentence, in any language, can be read as “up to date”', () => {
    const forbidden = ['已是最新', '最新版本', 'up to date', 'up-to-date', '最新です', '최신 버전입니다'];
    for (const key of Object.values(FAILURE_KEYS)) {
      for (const loc of UI_LOCALES) {
        const s = (UPDATE_STRINGS[loc] as Record<string, string>)[key] ?? '';
        expect(s, `${loc}.${key} has no sentence at all`).not.toBe('');
        for (const bad of forbidden) {
          expect(s.toLowerCase().includes(bad.toLowerCase()), `${loc}.${key} = “${s}”`).toBe(false);
        }
      }
    }
  });

  /**
   * ⚠️ The hash-mismatch sentence must not overclaim.
   *
   * `failure.rs` states it at the variant: a mismatch means these bytes are not
   * the published ones. It does NOT establish an attack — design §2.1 says in as
   * many words that a compromised VPS could serve a bad package WITH a matching
   * hash. Copy that said "someone tampered with your installer" would be asserting
   * something the gate cannot know.
   */
  it('⚠️ the hash-mismatch copy does not claim an attack', () => {
    const overclaims = ['攻击', '篡改', 'attack', 'tamper', 'hacked', 'malware', '해킹', '改ざん'];
    for (const loc of UI_LOCALES) {
      const s = (UPDATE_STRINGS[loc] as Record<string, string>).upd_fail_hash_mismatch ?? '';
      for (const bad of overclaims) {
        expect(s.toLowerCase().includes(bad.toLowerCase()), `${loc}: “${s}”`).toBe(false);
      }
    }
  });

  /**
   * 🔴 The MSI hint must still name a route the user can walk themselves.
   *
   * ⚠️ 0.3.8 TURNED THIS TEST AROUND, and the original wording is kept because
   * the reversal is the lesson. It read:
   *   「🔴 The MSI hint must not promise an automatic relaunch. [measured,
   *    design §4.1] the default Tauri WiX template carries no
   *    launch-after-install. Promising it is the second direction of the
   *    no-silent-failure line …」
   * and it asserted, per language, that the sentence says *please reopen* and
   * never says *reopens itself*. Every word of that was true, and it pinned a
   * bad product in place: the install worked, nothing came back, and the
   * instruction was printed on the window the chain closes (owner, 2026-08-17).
   *
   * There IS a relaunch now (update/msi.rs), so the old assertion would forbid
   * the copy from describing what the product does. What survives is the half
   * that was actually load-bearing: **a relaunch can fail, and the reader
   * looking at an empty desktop needs the manual route in the same sentence.**
   * So the test now demands BOTH halves, per language — and the negative
   * assertion is inverted: the sentence may no longer be only an instruction.
   *
   * 🔴 Per language, not one regex, for the reason the original gave: the claim
   * is about the sentence a user in that language actually reads.
   */
  it('🔴 the MSI hint says it comes back by itself AND names the manual route', () => {
    const comesBack: Record<string, RegExp> = {
      'zh-CN': /自己重新启动|自动重新启动/,
      en: /starts itself again|restarts itself/i,
      ja: /自動で起動し直し|自動的に起動/,
      ko: /자동으로 다시 시작/,
      'zh-TW': /自己重新啟動|自動重新啟動/,
      fr: /redémarre tout seul|se relance/i,
      es: /vuelve a abrirse solo|se reinicia solo/i,
      de: /startet sich anschließend selbst|startet sich selbst/i,
      ru: /запустится сам/i,
    };
    const manualRoute: Record<string, RegExp> = {
      'zh-CN': /开始菜单/,
      en: /start menu/i,
      ja: /スタートメニュー/,
      ko: /시작 메뉴/,
      'zh-TW': /「開始」功能表|開始功能表/,
      fr: /menu démarrer/i,
      es: /menú inicio/i,
      de: /startmenü/i,
      ru: /меню «пуск»|меню пуск/i,
    };
    for (const loc of UI_LOCALES) {
      const s = (UPDATE_STRINGS[loc] as Record<string, string>).upd_msi_hint ?? '';
      expect(
        (comesBack[loc] as RegExp).test(s),
        `${loc} MSI hint must say the app starts itself again: “${s}”`,
      ).toBe(true);
      expect(
        (manualRoute[loc] as RegExp).test(s),
        `${loc} MSI hint must still name the manual route, because a relaunch can fail: “${s}”`,
      ).toBe(true);
    }
  });
});
