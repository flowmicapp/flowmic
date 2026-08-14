// REQ-12-14 / REQ-12-10b — the glance layer's two pure decisions.
//
// These are SEMANTIC tests (what the derivation answers), not presentation ones.
// Whether the word is readable on screen is a different question and is asked
// where it can actually be answered: components/channel-card-head.test.ts renders
// the head and reads the word out of the rendered markup (0.2.53's law — a copy
// assertion belongs on the rendered result, never on the source string alone).

import { describe, expect, it } from 'vitest';
import { channelStateWord, summariseChannelGroup } from './channel-card-state';
import { deriveCloudCard, deriveLanCard, EMPTY_CLOUD_STATUS, type Dot } from './channel';
import { S } from './strings';
import { setLocale, UI_LOCALES } from './strings/locale';

const ALL_DOTS: Dot[] = ['g', 'y', 'r', 'o'];

describe('channelStateWord — one word per dot, and never a fifth', () => {
  it('gives every dot a distinct, non-empty word', () => {
    const words = ALL_DOTS.map(channelStateWord);
    expect(words.every((w) => w.trim() !== '')).toBe(true);
    // Distinct is the point: two dots sharing a word would put the card back to
    // "colour is the only difference", which owner 2026-08-01 ruled out.
    expect(new Set(words).size).toBe(ALL_DOTS.length);
  });

  it('reuses the EXISTING connecting copy rather than minting a second one', () => {
    // Two strings for one state is how they drift apart; the amber dot and the
    // status line must say the same thing because they ARE the same thing.
    expect(channelStateWord('y')).toBe(S.dev_chan_connecting);
  });

  it('answers in all four locales — no locale falls through to a blank pill', () => {
    for (const loc of UI_LOCALES) {
      setLocale(loc);
      for (const dot of ALL_DOTS) {
        expect(channelStateWord(dot), `${dot} is empty in ${loc}`).not.toBe('');
      }
      // Distinctness has to hold per locale, not only in zh-CN.
      expect(new Set(ALL_DOTS.map(channelStateWord)).size, `collision in ${loc}`).toBe(4);
    }
    setLocale('zh-CN');
  });

  it('🔴 covers every dot the two REAL derivations can produce', () => {
    // The anti-façade half. A word table is only honest if it is exhaustive over
    // the values that actually reach it, so the inputs here come from
    // deriveLanCard / deriveCloudCard themselves rather than from a list someone
    // typed — if either grows a dot this table does not know, this goes red.
    const produced = new Set<Dot>([
      deriveLanCard({ connected: true, sidecarPhase: 'healthy', loopback: false }).dot,
      deriveLanCard({ connected: false, sidecarPhase: 'healthy', loopback: false }).dot,
      deriveLanCard({ connected: true, sidecarPhase: 'failed', loopback: false }).dot,
      deriveLanCard({ connected: true, sidecarPhase: 'suspended', loopback: false }).dot,
      deriveCloudCard({ status: { ...EMPTY_CLOUD_STATUS, key_set: true, readiness: 'ready' }, connected: true }).dot,
      deriveCloudCard({ status: { ...EMPTY_CLOUD_STATUS, key_set: true, readiness: 'ready' }, connected: false }).dot,
      deriveCloudCard({ status: { ...EMPTY_CLOUD_STATUS, readiness: 'no_key' }, connected: false }).dot,
      deriveCloudCard({
        status: { ...EMPTY_CLOUD_STATUS, key_set: true, readiness: 'key_expired' },
        connected: false,
      }).dot,
    ]);
    expect([...produced].sort()).toEqual([...ALL_DOTS].sort());
    for (const dot of produced) expect(channelStateWord(dot)).not.toBe('');
  });
});

describe('summariseChannelGroup — the shell counts what the cards already said', () => {
  it('counts only the green ones, and takes the total from the input', () => {
    expect(summariseChannelGroup(['g', 'g'])).toMatchObject({ ready: 2, total: 2 });
    expect(summariseChannelGroup(['g', 'o'])).toMatchObject({ ready: 1, total: 2 });
    expect(summariseChannelGroup(['r', 'y'])).toMatchObject({ ready: 0, total: 2 });
  });

  it('🔴 the total is NOT the literal 2 — a third channel would be counted', () => {
    // The devices page renders a fixed pair today. A hard-coded 「/2」would keep
    // saying 2 on the day a third card appears, and there would be no symbol to
    // grep for the lie.
    const three = summariseChannelGroup(['g', 'g', 'o']);
    expect(three.total).toBe(3);
    expect(three.label).toContain('3');
    expect(summariseChannelGroup([])).toMatchObject({ ready: 0, total: 0 });
  });

  it('renders both numbers into the label, in all four locales', () => {
    for (const loc of UI_LOCALES) {
      setLocale(loc);
      const label = summariseChannelGroup(['g', 'o']).label;
      expect(label, `{n} unresolved in ${loc}`).not.toContain('{n}');
      expect(label, `{m} unresolved in ${loc}`).not.toContain('{m}');
      expect(label).toContain('1');
      expect(label).toContain('2');
    }
    setLocale('zh-CN');
  });
});
