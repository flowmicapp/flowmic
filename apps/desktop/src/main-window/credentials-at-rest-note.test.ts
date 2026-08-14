// MAC-08 plan B — the device-page sentence that non-Windows hosts store
// pairing credentials as plaintext.
//
// Shaped by two repo lessons:
//   · 【rendered-result】 assert through renderToString, not by reading S.* —
//     a catalogue entry nobody mounts is a façade (data-flow-disclosure.test.ts).
//   · 【layout, not a crowded row】 the note is its own block (display:block,
//     white-space:normal, no ellipsis). 0.2.53's INJ… truncation was green
//     under Text.data while the user saw three letters.
//
// DevicesPage itself is not mounted here: its channel cards need onMounted +
// the Tauri bridge (see devices-info-panel.test.ts). The gate and the readable
// block live in CredentialsAtRestNote.vue; the page wiring is pinned by a
// source-literal check below.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CredentialsAtRestNote from './components/CredentialsAtRestNote.vue';
import { S_BY_LOCALE, setLocale } from '../lib/strings';
import { DEVICES_STRINGS } from '../lib/strings/devices';

const LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;
type Loc = (typeof LOCALES)[number];

const PAGE = readFileSync(fileURLToPath(new URL('./DevicesPage.vue', import.meta.url)), 'utf8');
const NOTE_SRC = readFileSync(
  fileURLToPath(new URL('./components/CredentialsAtRestNote.vue', import.meta.url)),
  'utf8',
);

async function renderOn(platform: string, loc: Loc = 'zh-CN'): Promise<string> {
  setLocale(loc);
  const html = await renderToString(
    createSSRApp(CredentialsAtRestNote, { platform }),
  );
  setLocale('zh-CN');
  return html;
}

/** One unique fragment per locale — proves the mounted sentence, not a key name. */
const MARKERS: Record<Loc, string> = {
  'zh-CN': '以未加密形式保存',
  en: 'stored unencrypted',
  ja: '暗号化せずに',
  ko: '암호화되지 않은 형태',
};

describe('CredentialsAtRestNote — platform gate (rendered)', () => {
  it('positive: on non-Windows platforms this sentence appears (all four languages)', async () => {
    for (const loc of LOCALES) {
      for (const platform of ['darwin', 'linux'] as const) {
        const html = await renderOn(platform, loc);
        expect(html, `${loc} on ${platform}`).toContain(MARKERS[loc]);
        expect(html).toContain('data-cred-plain-note');
        // Own block, not an inline chip squeezed into a Row.
        expect(html).toMatch(/class="[^"]*cred-plain-note[^"]*"/);
      }
    }
  });

  it('negative: on Windows this sentence does not appear', async () => {
    // 🔴 If someone "fixes" the gate to always show, THIS is who tells them —
    // not a Mac screenshot, and not a catalogue-only assert. Flipping the
    // expectation to toContain would turn a Windows lie into the acceptance
    // criterion (the 0.2.51 reverse-control failure mode).
    for (const loc of LOCALES) {
      const html = await renderOn('windows', loc);
      expect(html, `${loc} on windows must stay silent`).not.toContain(MARKERS[loc]);
      expect(html).not.toContain('data-cred-plain-note');
      expect(html.trim()).toBe('<!---->');
    }
  });
});

describe('CredentialsAtRestNote — copy discipline', () => {
  it('all four languages present, no digits, no imperatives, does not claim encryption', () => {
    for (const loc of LOCALES) {
      const line = DEVICES_STRINGS[loc].dev_cred_plaintext_note;
      expect(line, `${loc} missing`).toBeTruthy();
      expect(line, `${loc} digits`).not.toMatch(/\d/);
      // Imperatives the user cannot act on (written precedent: INJECT_PC_MISMATCH).
      expect(line, `${loc} imperative`).not.toMatch(/请|請|please|ください|하세요|해 주세요/i);
      // Must not claim the current state is encrypted / secure.
      // ⚠️ Do NOT match the bare substring `encrypted` — English says
      // `unencrypted`, and a naïve `/encrypted/` would ban the true sentence.
      expect(line, `${loc} false security`).not.toMatch(
        /已加密|(?<![Nn]ot\s)(?<![Uu]n)encrypted|\bsecure\b|안전함|안전하게 저장|暗号化されて/i,
      );
      // Must state the plaintext fact (the reason this note exists).
      expect(line, `${loc} missing plaintext claim`).toContain(MARKERS[loc]);
    }
  });

  it('locale catalogue exposes the key on every language S reads', () => {
    for (const loc of LOCALES) {
      expect(S_BY_LOCALE[loc].dev_cred_plaintext_note).toBe(
        DEVICES_STRINGS[loc].dev_cred_plaintext_note,
      );
    }
  });
});

describe('CredentialsAtRestNote — readable block (not a crowded row)', () => {
  it('scoped CSS keeps the sentence as a wrapping block with no ellipsis', () => {
    // Assert the stylesheet the user actually gets, not Text.data.
    expect(NOTE_SRC).toMatch(/\.cred-plain-note\s*\{[^}]*display:\s*block/s);
    expect(NOTE_SRC).toMatch(/\.cred-plain-note\s*\{[^}]*white-space:\s*normal/s);
    expect(NOTE_SRC).toMatch(/\.cred-plain-note\s*\{[^}]*text-overflow:\s*clip/s);
    expect(NOTE_SRC).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(NOTE_SRC).not.toMatch(/white-space:\s*nowrap/);
  });
});

describe('DevicesPage wires the note under "This PC"', () => {
  it('mounts CredentialsAtRestNote (production path, no platform prop override)', () => {
    expect(PAGE).toContain('CredentialsAtRestNote');
    expect(PAGE).toMatch(/<CredentialsAtRestNote\s*\/>/);
    // Lives with the "This PC" card — machine-scoped fact, not a channel status.
    const selfIdx = PAGE.indexOf('S.dev_self');
    const noteIdx = PAGE.indexOf('<CredentialsAtRestNote');
    expect(selfIdx).toBeGreaterThan(0);
    expect(noteIdx).toBeGreaterThan(selfIdx);
  });
});
