// The desktop reason line for INJECT_CLIPBOARD_FAIL, in all nine languages. The rules
// are in docs/rebuild/15 (the paste section): the code also covers a paste nobody took
// and pictures, so the line may not blame the clipboard, and "delivery" belongs to the
// phone-to-computer part, which worked.
//
// The capsule draws this on one 11px line, cut off with an ellipsis at 52% of the card
// (styles/capsule.css `.failsub`), so length decides whether it can be read at all.
//
// Reverse control, `vitest run src/lib/strings/inject-clipboard-fail-reason.test.ts`:
// putting "Clipboard delivery unconfirmed" back as the English line in
// generated/catalogue.g.ts turns the first and third cases red.

import { describe, expect, it } from 'vitest';
import { UI_LOCALES, setLocale } from '../strings';
import { INJECT_FAIL_REASON, INJECT_FAIL_REASON_CATALOGUES as INJECT_FAIL_REASON_BY_LOCALE } from './capsule';

const BLAMES_THE_CLIPBOARD: Record<string, RegExp> = {
  en: /clipboard|deliver/i,
  'zh-CN': /剪贴板|投递/,
  'zh-TW': /剪貼簿|投遞/,
  fr: /presse-papiers|livr/i,
  es: /portapapeles|entreg/i,
  de: /zwischenablage|zustell/i,
  ja: /クリップボード|配信/,
  ko: /클립보드|전달/,
  ru: /буфер|достав/i,
};

function isCjk(text: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯]/.test(text);
}

describe('INJECT_CLIPBOARD_FAIL reason line', () => {
  it('says the paste did not finish, without blaming the clipboard, in every language', () => {
    for (const loc of UI_LOCALES) {
      const line = INJECT_FAIL_REASON_BY_LOCALE[loc]?.INJECT_CLIPBOARD_FAIL;
      expect(line, loc).toBeTruthy();
      expect(line, loc).not.toMatch(BLAMES_THE_CLIPBOARD[loc]!);
    }
  });

  it('fits the capsule line it is drawn on', () => {
    for (const loc of UI_LOCALES) {
      const line = INJECT_FAIL_REASON_BY_LOCALE[loc]?.INJECT_CLIPBOARD_FAIL ?? '';
      expect(line.length, `${loc}: ${line}`).toBeLessThanOrEqual(isCjk(line) ? 20 : 40);
    }
  });

  it('reaches the surface through the getter the capsule and timeline read', () => {
    setLocale('en');
    try {
      expect(INJECT_FAIL_REASON.INJECT_CLIPBOARD_FAIL).toBe('Paste did not complete');
    } finally {
      setLocale('zh-CN');
    }
  });
});
