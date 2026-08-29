// The first-run guess at what this machine's owner SPEAKS (owner ruling
// 2026-08-28 item 1), and the one rule it must not break: it never becomes the
// interface language.
//
// ⚠️ EVERY CASE STUBS `navigator`. Node 22 ships a real `navigator.language`
// and on the machine this was written on it answers `zh-CN` — a test that read
// the ambient value would pass here and fail on a German CI box, while
// measuring nothing about the mapping. The stub is not scaffolding; it is what
// makes the assertion about the code instead of about the room.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPOKEN_LANG_FALLBACK,
  machineSpokenLang,
  spokenLangFromTag,
} from './machine-spoken-lang';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BCP-47 tag → speaking language', () => {
  it('keeps a base subtag the product has packs for', () => {
    expect(spokenLangFromTag('en-US')).toBe('en');
    expect(spokenLangFromTag('en')).toBe('en');
    expect(spokenLangFromTag('ja-JP')).toBe('ja');
    expect(spokenLangFromTag('ko-KR')).toBe('ko');
    expect(spokenLangFromTag('ru-RU')).toBe('ru');
    expect(spokenLangFromTag('de-AT')).toBe('de');
    expect(spokenLangFromTag('es-419')).toBe('es');
    expect(spokenLangFromTag('fr-CA')).toBe('fr');
  });

  it('🔴 every Chinese tag collapses to zh — simplified and traditional share the packs', () => {
    // LM-CAT §3-1: zh-TW is a SCRIPT, not a ninth acoustic key. Splitting them
    // here would hand the caller a language the catalog has no model for, and
    // the card would then have nothing to offer a Taiwanese reader.
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant-TW', 'ZH-hans-cn']) {
      expect(spokenLangFromTag(tag), tag).toBe('zh');
    }
  });

  it('a language the product has no packs for falls to en, and so does nothing at all', () => {
    // The owner's words: 「映射不到的落 en」.
    expect(spokenLangFromTag('pt-BR')).toBe(SPOKEN_LANG_FALLBACK);
    expect(spokenLangFromTag('hi')).toBe(SPOKEN_LANG_FALLBACK);
    expect(spokenLangFromTag('')).toBe(SPOKEN_LANG_FALLBACK);
    expect(spokenLangFromTag('   ')).toBe(SPOKEN_LANG_FALLBACK);
    expect(spokenLangFromTag(null)).toBe(SPOKEN_LANG_FALLBACK);
    expect(spokenLangFromTag(undefined)).toBe(SPOKEN_LANG_FALLBACK);
    expect(SPOKEN_LANG_FALLBACK).toBe('en');
  });

  it('the SERVER list wins when the caller has one', () => {
    // The default list and the server's agree today; that is a fact about
    // today, so the parameter exists and this pins that it is honoured.
    expect(spokenLangFromTag('de-DE', ['en', 'zh'])).toBe('en');
    expect(spokenLangFromTag('de-DE', ['en', 'zh', 'de'])).toBe('de');
  });

  it('the default supported list is the eight the catalog ships', () => {
    for (const l of ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru']) {
      expect(spokenLangFromTag(l), l).toBe(l);
    }
  });
});

describe('reading the machine', () => {
  it('maps navigator.language through the same rule', () => {
    vi.stubGlobal('navigator', { language: 'zh-TW' });
    expect(machineSpokenLang()).toBe('zh');
    vi.stubGlobal('navigator', { language: 'ko-KR' });
    expect(machineSpokenLang()).toBe('ko');
  });

  it('🔴 no navigator (SSR, the test runner, a stripped WebView) is not a crash', () => {
    vi.stubGlobal('navigator', undefined);
    expect(machineSpokenLang()).toBe(SPOKEN_LANG_FALLBACK);
    vi.stubGlobal('navigator', {});
    expect(machineSpokenLang()).toBe(SPOKEN_LANG_FALLBACK);
  });
});
