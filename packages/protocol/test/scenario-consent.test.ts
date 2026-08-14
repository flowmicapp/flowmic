// V2-08 / card Z2 — the classifier and the consent gate, now shared by both ends.
//
// These cases MOVED here verbatim (plus the reasons) from
// apps/server-core/test/compose-scenario-inference.test.ts when the functions
// moved into this package: the test has to live with the implementation, or the
// package that owns the rule ships with nobody guarding it.
//
// They are written as「怎样才会出事」("how things go wrong") rather than as API
// coverage, because both are
// one-way doors: a wrong `local` verdict sends the list of applications the user
// dictates into to whoever runs that endpoint, and a wrong「still consented」
// verdict lets a settings change silently widen what leaves the machine.

import { describe, expect, it } from 'vitest';
import {
  ADDITIONAL_PRIVATE_CIDRS,
  SETTINGS_KEY_SCENARIO_INFERENCE,
  classifyDestination,
  destinationOf,
  inferenceBlockedReason,
  scenarioConsentRow,
  type ScenarioInferenceConsent,
} from '../src/index';

describe('classifyDestination', () => {
  it('recognises loopback, RFC1918, link-local and intranet names as local', () => {
    for (const e of [
      'http://localhost:8000/v1',
      'http://127.0.0.1:8000/v1',
      'http://[::1]:8000/v1',
      'http://10.1.2.3:8000/v1',
      'http://172.16.0.5/v1',
      'http://172.31.255.254/v1',
      'http://192.168.1.7:11434/v1',
      'http://169.254.10.10/v1',
      'http://vllm-box:8000/v1',
      'http://nas.local:8000/v1',
    ]) {
      expect(classifyDestination(e), e).toBe('local');
    }
  });

  it('recognises public hosts as external when no additional CIDRs are supplied', () => {
    for (const e of [
      'https://api.openai.com/v1',
      'https://api.anthropic.com',
      'https://flowmic.app/v1',
      'http://8.8.8.8/v1',
      // 172.15 and 172.32 are OUTSIDE RFC1918 — the /12 boundary is a classic
      // off-by-one and getting it wrong here leaks process names to a public host.
      'http://172.15.0.1/v1',
      'http://172.32.0.1/v1',
      'http://192.169.1.1/v1',
      // THE OWNER'S OWN LAN MODEL BOX, with NO deployment overlay. 172/12 private
      // space is 172.16–172.31 only — .77 is publicly-registered address space.
      // Without the presets CIDR the classifier must NOT claim it is private
      // (fail closed; D1: the range lives in presets, not in this function).
      'http://100.64.7.179:8000/v1',
      'http://100.64.7.78:8000/v1',
    ]) {
      expect(classifyDestination(e), e).toBe('external');
    }
  });

  it('treats ADDITIONAL_PRIVATE_CIDRS as local — and ONLY those, not neighbours', () => {
    // D1: the same endpoint flips when the caller passes the presets overlay.
    // That is the whole point of the optional argument — deployment config, not
    // a hard-coded exception inside the classifier.
    // 🔴 OSS-DEFAULTS (0.3.0): the overlay is passed EXPLICITLY here. It used to
    // be `ADDITIONAL_PRIVATE_CIDRS`, which shipped `['100.64.7.0/24']` compiled
    // in; that const is now empty by default and a deployment declares its own.
    // The classifier's behaviour is what this test is about and it is unchanged —
    // so the overlay it is given is now stated in the test, where a reader can
    // see that the range is an INPUT rather than something the library believes.
    const overlay = ['100.64.7.0/24'];
    expect(ADDITIONAL_PRIVATE_CIDRS).toEqual([]); // the shipped default is empty
    expect(classifyDestination('http://100.64.7.179:8000/v1', overlay)).toBe('local');
    expect(classifyDestination('http://100.64.7.78:8000/v1', overlay)).toBe('local');
    // Adjacent publicly-registered space stays external even with the overlay.
    expect(classifyDestination('http://172.77.78.1:8000/v1', overlay)).toBe('external');
    expect(classifyDestination('http://172.15.0.1/v1', overlay)).toBe('external');
    // Omitting / empty / undefined all mean「no overlay」— same as the baseline.
    expect(classifyDestination('http://100.64.7.179:8000/v1')).toBe('external');
    expect(classifyDestination('http://100.64.7.179:8000/v1', undefined)).toBe('external');
    expect(classifyDestination('http://100.64.7.179:8000/v1', [])).toBe('external');
  });

  it('ignores malformed additional CIDRs (that entry cannot widen the verdict)', () => {
    expect(
      classifyDestination('http://100.64.7.179:8000/v1', ['not-a-cidr', '100.64.7.0/99']),
    ).toBe('external');
    // A well-formed neighbour in the same list still applies.
    expect(
      classifyDestination('http://100.64.7.179:8000/v1', [
        'bogus',
        '100.64.7.0/24',
        'also-bogus',
      ]),
    ).toBe('local');
  });

  it('FAILS TOWARD external when it cannot tell', () => {
    // The asymmetry that matters. An unrecognised endpoint is absence of
    // evidence, not evidence of a private network — and the two mistakes cost
    // very different things: one extra confirmation vs. process names reaching
    // whoever runs that endpoint under a consent given for a LAN box.
    for (const e of [undefined, '', '   ', 'not a url', '://///', 'ftp:']) {
      expect(classifyDestination(e as string | undefined), String(e)).toBe('external');
    }
  });

  it('destinationOf reads the SAME verdict off an LlmConfig endpoint', () => {
    // One field, one answer: the consent screen and the server gate must agree
    // on which part of the config the destination comes from.
    expect(destinationOf({ endpoint: 'http://192.168.1.5:8000/v1' })).toBe('local');
    expect(destinationOf({ endpoint: 'https://api.openai.com/v1' })).toBe('external');
    expect(destinationOf(undefined)).toBe('external');
    // 🔴 OSS-DEFAULTS (0.3.0): the DEFAULT overlay is now empty, so a
    // publicly-registered range is external unless a deployment declares it.
    // This line used to read `.toBe('local')` with no second argument — i.e. the
    // shipped default vouched for one office's addresses on every machine.
    expect(destinationOf({ endpoint: 'http://100.64.7.179:8000/v1' })).toBe('external');
    // Declared overlay ⇒ local. Same verdict `classifyDestination` gives, which
    // is the property this test exists for: one field, one answer.
    expect(destinationOf({ endpoint: 'http://100.64.7.179:8000/v1' }, ['100.64.7.0/24'])).toBe('local');
    // Explicit empty overlay forces the fail-closed RFC1918-only path.
    expect(destinationOf({ endpoint: 'http://100.64.7.179:8000/v1' }, [])).toBe('external');
  });
});

describe('the consent gate', () => {
  const localConsent: ScenarioInferenceConsent = { granted: true, grantedFor: 'local' };

  it('blocks with no consent — DEFAULT OFF, not a pre-ticked box', () => {
    expect(inferenceBlockedReason(undefined, 'local')).toBe('no-consent');
    expect(inferenceBlockedReason({ granted: false, grantedFor: 'local' }, 'local')).toBe(
      'no-consent',
    );
  });

  it('RE-ASKS when the model moves from local to external', () => {
    // Card constraint 3. Without this, agreeing to send process names to a box on your
    // own LAN silently becomes agreeing to send them to a vendor, via a settings
    // change that said nothing about privacy.
    expect(inferenceBlockedReason(localConsent, 'external')).toBe('destination-widened');
  });

  it('does NOT re-ask when the model moves external → local', () => {
    // One-directional on purpose: that change only narrows exposure, and
    // re-prompting for it teaches people to click through consent screens.
    const ext: ScenarioInferenceConsent = { granted: true, grantedFor: 'external' };
    expect(inferenceBlockedReason(ext, 'local')).toBeUndefined();
    expect(inferenceBlockedReason(ext, 'external')).toBeUndefined();
    expect(inferenceBlockedReason(localConsent, 'local')).toBeUndefined();
  });

  it('is the ONLY honest answer to 「开关该显示开还是关」 ("should the switch show on or off")', () => {
    // The desktop's reason for importing this. `granted === true` is NOT the same
    // question as「功能正在跑」("the feature is running"): this consent is granted
    // and the feature is off. A switch rendered from `granted` alone would show
    // ON while the server sends nothing — the「点了不生效的开关」("the switch that
    // does nothing when pressed") this whole card exists to avoid.
    expect(localConsent.granted).toBe(true);
    expect(inferenceBlockedReason(localConsent, 'external')).toBe('destination-widened');
  });
});

describe('the stored consent row', () => {
  it('carries snake_case field names and the closed destination vocabulary', () => {
    // server-core's reader (scenario-infer-store.readConsent) treats anything else
    // as MALFORMED ⇒「没有设置」("not configured") ⇒ off. A writer that
    // hand-spelled `grantedFor` here
    // would produce a switch the user can tick that changes nothing.
    expect(scenarioConsentRow({ granted: true, grantedFor: 'local' })).toEqual({
      granted: true,
      granted_for: 'local',
    });
    expect(scenarioConsentRow({ granted: false, grantedFor: 'external' })).toEqual({
      granted: false,
      granted_for: 'external',
    });
    // Exactly two keys — an extra one is not fatal to the reader, but it would
    // mean this package had started inventing value shape nobody reads.
    expect(Object.keys(scenarioConsentRow({ granted: true, grantedFor: 'local' })).sort()).toEqual([
      'granted',
      'granted_for',
    ]);
  });

  it('names the settings key the server actually reads', () => {
    // The literal is pinned in TWO packages on purpose: here, and in
    // apps/server-core/test/compose-scenario-infer-store.test.ts, which feeds a
    // row stored under THIS constant through the real reader. Neither test alone
    // would catch a rename of the other side.
    expect(SETTINGS_KEY_SCENARIO_INFERENCE).toBe('scenario.inference');
  });
});
