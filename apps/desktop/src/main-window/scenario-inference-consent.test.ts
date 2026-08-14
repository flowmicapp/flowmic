// V2-08 / card Z2 — the consent switch.
//
// The previous attempt at this switch STOPPED rather than ship it, and the reason
// is the shape of every assertion here: server-core's reader accepts exactly
// `{granted, granted_for:'local'|'external'}` and treats anything else as "no
// setting" ⇒ feature off. A switch that writes a row the server cannot read is a
// switch the user can tick that changes nothing — worse than no switch, because
// it also makes a promise.
//
// So "the local ref changed" proves nothing and is not asserted anywhere below.
// What is asserted is that a real `settings:update` reached the Tauri transport
// carrying that key and a row whose `granted_for` was COMPUTED by the protocol
// classifier (not hardcoded, not re-derived here), plus the two states the
// switch itself has to get right: default OFF, and OFF-because-the-endpoint-moved.

// 🔴 OSS-DEFAULTS (0.3.0) — WHICH WORLD THIS FILE MEASURES.
//
// `ADDITIONAL_PRIVATE_CIDRS` used to ship `['100.64.7.0/24']` compiled in. It is
// now EMPTY by default and a deployment DECLARES its ranges — the shipped default
// is pinned in packages/protocol/test/engine-presets.test.ts, and the stock-build
// direction is pinned below in 「a STOCK build vouches for nobody's LAN」.
//
// This file runs in the DECLARED-overlay world, because what it is here to prove
// is that the desktop CONSUMES the overlay all the way through the real model and
// the real transport (the D1 cases). `vi.hoisted` and not a `beforeEach`: that
// const is a MODULE-LOAD SNAPSHOT of the environment, so a value set after
// `@flowmic/protocol` was evaluated could never reach it, and the D1 cases would
// then be green or red for a reason that has nothing to do with this code.
vi.hoisted(() => {
  process.env.FLOWMIC_ADDITIONAL_PRIVATE_CIDRS = '100.64.7.0/24';
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import {
  ADDITIONAL_PRIVATE_CIDRS,
  SETTINGS_KEY_SCENARIO_INFERENCE,
  classifyDestination,
  scenarioConsentRow,
} from '@flowmic/protocol';
import ScenarioInference from './components/ScenarioInference.vue';
import {
  applyServerSettings,
  inferenceBlocked,
  inferenceDestination,
  inferenceEnabled,
  model,
  setScenarioInferenceGranted,
} from './settings-model';
import { settings } from './store';
import { settingsTransport } from '../lib/bridge';
import { SettingsClient } from '../lib/settings-client';
import { S_BY_LOCALE, setLocale } from '../lib/strings';

const LAN = 'http://192.168.1.5:8000/v1';
const CLOUD = 'https://api.openai.com/v1';
/** The owner's own office model box. Publicly-registered space used as a private
 *  network; with the presets overlay (`ADDITIONAL_PRIVATE_CIDRS`) the desktop
 *  classifier says `local` (owner D1 2026-07-31). Without the overlay it stays
 *  `external` — that fail-closed path is pinned in the protocol package tests. */
const OWNER_BOX = 'http://100.64.7.179:8000/v1';

/** Every settings:update that reached the Tauri boundary. `settingsTransport` is
 *  the object store.ts handed the SettingsClient, and the client looks the method
 *  up at call time — so this spies on the production write path rather than on a
 *  stand-in built for the test.
 *
 *  REAL timers on purpose: the process-wide SettingsClient is constructed when
 *  store.ts is imported, so its debouncer captured the real `setTimeout` long
 *  before any fake-timer install could reach it. Faking here would have produced
 *  a green "nothing was sent" — the assertion would have been about the test harness. */
function recordWires(): {
  calls: Array<{ key: string; value: unknown }>;
  consent(): Array<{ key: string; value: unknown }>;
} {
  const calls: Array<{ key: string; value: unknown }> = [];
  vi.spyOn(settingsTransport, 'settingsUpdate').mockImplementation(async (key, value) => {
    calls.push({ key, value });
    return true;
  });
  return { calls, consent: () => calls.filter((c) => c.key === SETTINGS_KEY_SCENARIO_INFERENCE) };
}

beforeEach(() => {
  setLocale('zh-CN');
  model.llm = { preset_id: 'x', protocol: 'openai-compatible', endpoint: LAN, api_key: '', model: 'q' };
  model.inferenceConsent = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the row that actually goes out on the wire', () => {
  it('writes `scenario.inference` with a granted_for the PROTOCOL classifier produced', async () => {
    const wire = recordWires();
    setScenarioInferenceGranted(true);
    // No manual flush: this is the real 200ms change-applies-immediately debounce firing on its own.
    await new Promise((r) => setTimeout(r, 300));

    const sent = wire.consent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe('scenario.inference'); // the literal the server reads
    // The exact row shape server-core's readConsent accepts — snake_case, closed
    // vocabulary. Built by the protocol helper, compared against the protocol
    // classifier's own verdict for the endpoint on screen.
    expect(sent[0]!.value).toEqual({ granted: true, granted_for: classifyDestination(LAN) });
    expect(sent[0]!.value).toEqual(scenarioConsentRow({ granted: true, grantedFor: 'local' }));
  });

  it('granted_for follows the endpoint — it is computed, not a constant', async () => {
    const wire = recordWires();
    model.llm.endpoint = CLOUD;
    setScenarioInferenceGranted(true);
    await settings.flushPending(); // the reconnect replay path, same transport
    expect(wire.consent().at(-1)?.value).toEqual({ granted: true, granted_for: 'external' });
  });

  it("the owner's own 100.64.7.x box is recorded as local once the DEPLOYMENT declares the overlay", async () => {
    // D1: settings-model passes ADDITIONAL_PRIVATE_CIDRS into classifyDestination,
    // so the consent row's granted_for matches what the consent screen shows.
    // The classifier itself still has no 172.77 literal — grep the implementation.
    // 🔴 OSS-DEFAULTS: and neither does the OVERLAY any more. The range reaching
    // this assertion came from FLOWMIC_ADDITIONAL_PRIVATE_CIDRS at the top of this
    // file, i.e. from deployment config — which is the property being measured:
    // the desktop carries the mechanism, not the address.
    const wire = recordWires();
    model.llm.endpoint = OWNER_BOX;
    setScenarioInferenceGranted(true);
    await settings.flushPending();
    expect(wire.consent().at(-1)?.value).toEqual({ granted: true, granted_for: 'local' });
    expect(classifyDestination(OWNER_BOX, ADDITIONAL_PRIVATE_CIDRS)).toBe('local');
    // Sanity: the same endpoint without the overlay is still external.
    expect(classifyDestination(OWNER_BOX)).toBe('external');
  });

  it('turning it OFF writes granted:false — a recorded answer, not a forgotten question', async () => {
    const wire = recordWires();
    setScenarioInferenceGranted(true);
    setScenarioInferenceGranted(false);
    await settings.flushPending();
    // A written false also CHANGES the server's consent fingerprint, which is the
    // mechanism behind "once turned off, use stops immediately from the next
    // sentence on (including any previously-cached inference)": the store
    // drops that user's whole descriptor cache when the premises change.
    expect(wire.consent().at(-1)).toEqual({
      key: SETTINGS_KEY_SCENARIO_INFERENCE,
      value: { granted: false, granted_for: 'local' },
    });
    expect(inferenceEnabled()).toBe(false);
  });

  it('nothing is written until the user touches it (default OFF is silence, not a false row)', async () => {
    // A fresh install must send NOTHING — not `granted:false`. The server's
    // "absent ⇒ off" default is the one state that needs no round trip to be true.
    const kv = new Map<string, string>();
    const client = new SettingsClient(
      { settingsUpdate: async (key, value) => { kv.set(key, JSON.stringify(value)); return true; } },
      { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
      1,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect([...kv.keys()]).not.toContain(SETTINGS_KEY_SCENARIO_INFERENCE);
    void client;
    expect(model.inferenceConsent).toBeNull();
    expect(inferenceEnabled()).toBe(false);
  });
});

describe('what the switch shows is whether the feature RUNS', () => {
  it('a consent for a LAN box does not survive the endpoint moving to a vendor', () => {
    setScenarioInferenceGranted(true);
    expect(inferenceEnabled()).toBe(true);
    model.llm.endpoint = CLOUD;
    // granted is still true — and the feature is off. Rendering the switch from
    // `granted` would claim ON while the server sends nothing.
    expect(model.inferenceConsent?.granted).toBe(true);
    expect(inferenceBlocked()).toBe('destination-widened');
    expect(inferenceEnabled()).toBe(false);
  });

  it('external → local does NOT demand a re-confirmation (that change only narrows)', () => {
    model.llm.endpoint = CLOUD;
    setScenarioInferenceGranted(true);
    model.llm.endpoint = LAN;
    expect(inferenceEnabled()).toBe(true);
  });

  it('adopts the SERVER-authoritative row, and skips one it cannot read', () => {
    applyServerSettings([{ key: 'scenario.inference', value: { granted: true, granted_for: 'external' } }]);
    expect(model.inferenceConsent).toEqual({ granted: true, grantedFor: 'external' });
    // "cannot parse it" is not "the user refused": leave the last known answer
    // alone rather than inventing a refusal (the server's own reader treats it
    // as off, loudly).
    applyServerSettings([{ key: 'scenario.inference', value: { granted: true, granted_for: 'somewhere' } }]);
    expect(model.inferenceConsent).toEqual({ granted: true, grantedFor: 'external' });
  });
});

describe('the consent copy says the three things it has to say', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./components/ScenarioInference.vue', import.meta.url)),
    'utf8',
  );

  it('renders collection / no-screen-reading / destination + the endpoint verbatim', async () => {
    model.llm.endpoint = CLOUD;
    const html = await renderToString(createSSRApp(ScenarioInference));
    expect(html).toContain('只读取当前焦点程序的可执行文件名');
    expect(html).toContain('不读窗口标题、不截屏');
    expect(html).toContain('这个文件名会被发送到下面这个模型端点');
    // Cloud endpoint stays on the unprovable branch — copy itself is untouched
    // (W-c); only the classification input changed under D1.
    expect(html).toContain(CLOUD);
    expect(html).toContain('172.16–172.31.x');
    expect(html).toContain('程序无法自动判定它是不是你自己的机器');
    expect(html).toContain('由你在下面确认');
    expect(html).toContain('关闭后下一句起立即停止使用');
  });

  it('says the address is inside the standard private ranges for a LAN endpoint', async () => {
    // Assertion updated with the RV-55 copy rewrite: both branches now name the
    // same ranges so the user can see WHY the other branch refused — not just
    // a bare "it's a private network" that hides the rule.
    model.llm.endpoint = LAN;
    const html = await renderToString(createSSRApp(ScenarioInference));
    expect(html).toContain(LAN);
    expect(html).toContain('这是标准私网地址段内的地址');
    expect(html).not.toContain('程序无法自动判定它是不是你自己的机器');
  });

  it('D1: owner box 100.64.7.179 takes the private-range copy when the deployment declares the overlay', async () => {
    // Copy strings are NOT edited — only the destination flips, so the existing
    // private branch renders. Without ADDITIONAL_PRIVATE_CIDRS this would still
    // be the unprovable sentence (pinned in protocol tests).
    model.llm.endpoint = OWNER_BOX;
    const html = await renderToString(createSSRApp(ScenarioInference));
    expect(html).toContain(OWNER_BOX);
    expect(html).toContain('这是标准私网地址段内的地址');
    expect(html).not.toContain('程序无法自动判定它是不是你自己的机器');
  });

  it('shows the paused notice ONLY when the endpoint outgrew the consent', async () => {
    model.llm.endpoint = LAN;
    setScenarioInferenceGranted(true);
    expect(await renderToString(createSSRApp(ScenarioInference))).not.toContain('情景推断已停用');
    model.llm.endpoint = CLOUD;
    const html = await renderToString(createSSRApp(ScenarioInference));
    expect(html).toContain('情景推断已停用');
  });

  // ── RV-55, narrowed by 0.3.0 P3 ────────────────────────────────────────────
  //
  // What this guard used to be: "no `infer_*` string in any locale may contain
  // 第三方 / third party / 第三者 / 제3자" (all local-language spellings of "third
  // party"). The INTENT was right and is kept below.
  // The EFFECT was not: it banned a word instead of a claim, so the panel could
  // not tell the user the one thing that is actually true on the unprovable
  // branch — that an endpoint the classifier could not place may belong to
  // someone else, and if it does, that someone is a real third party. A guard
  // that makes an honest sentence impossible eventually gets deleted wholesale;
  // the lie it was protecting against then comes back with it.
  //
  // The claim being guarded, stated as a claim: THE PANEL MUST NEVER TELL THE
  // USER THAT AN ADDRESS IS A THIRD PARTY WHEN IT CANNOT KNOW THAT. Three
  // clauses, each with a different failure it catches:
  //   (A) destination PROVED private ⇒ the word may not appear anywhere in the
  //       rendered panel. Here the program has a positive answer, so any mention
  //       is false — this is the owner's-own-box case RV-55 was written for.
  //   (B) the VERDICT SLOT (the panel's own conclusion about the address, the
  //       single call site of infer_dest_private / infer_dest_unprovable) never
  //       carries the word, on either branch, in any locale.
  //   (C) on the unprovable branch the word may appear ONLY while the panel is
  //       simultaneously saying it cannot tell whose machine this is. Deleting
  //       the hedge and keeping the claim turns a conditional into an assertion,
  //       and that is the original lie wearing different clothes.
  //
  // What it deliberately does NOT protect: nothing here can tell a conditional
  // from an assertion by reading the sentence. (A) and (C) fence the word to the
  // one branch and the one context where a conditional is true; beyond that the
  // guard is structural, not linguistic, and says so rather than pretending.
  const THIRD_PARTY_WORDS = ['第三方', 'third party', 'third-party', '第三者', '제3자'] as const;
  const LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;

  /** Render the panel in every UI language, restoring the default afterwards.
   *
   *  HTML comments are stripped: Vue's SSR emits template comments verbatim into
   *  the output, and the comment that explains WHY the private branch may not
   *  name a third party has to be able to use the words. What the guard is about
   *  is what the user reads, and a comment is not that. (Found by this test —
   *  the first run went red on its own explanatory comment.) */
  async function renderAllLocales(): Promise<Array<{ loc: (typeof LOCALES)[number]; html: string }>> {
    const out: Array<{ loc: (typeof LOCALES)[number]; html: string }> = [];
    for (const loc of LOCALES) {
      setLocale(loc);
      const raw = await renderToString(createSSRApp(ScenarioInference));
      out.push({ loc, html: raw.replace(/<!--[\s\S]*?-->/g, '') });
    }
    setLocale('zh-CN');
    return out;
  }

  it('(A) a destination PROVED private is never described as a third party, in any locale', async () => {
    for (const endpoint of [LAN, OWNER_BOX]) {
      model.llm.endpoint = endpoint;
      expect(inferenceDestination(), endpoint).toBe('local'); // positive control
      for (const { loc, html } of await renderAllLocales()) {
        // Positive control: a selector/render that produced nothing would pass
        // every negative assertion below without seeing a single character.
        expect(html, `${loc} rendered the endpoint`).toContain(endpoint);
        expect(html, `${loc} rendered the private verdict`).toContain(
          S_BY_LOCALE[loc].infer_dest_private,
        );
        for (const w of THIRD_PARTY_WORDS) {
          expect(html.toLowerCase(), `${loc} @ ${endpoint} must not contain ${w}`).not.toContain(
            w.toLowerCase(),
          );
        }
      }
    }
  });

  it("🔴 OSS-DEFAULTS: a STOCK build vouches for nobody's LAN", () => {
    // The other half of the world this file runs in. With NO overlay declared —
    // which is what a stranger's install has — the owner's box is publicly
    // registered space and the classifier says so. That is the FAIL-CLOSED
    // direction, and it is the one that matters: the copy the user then sees is
    // "the program cannot automatically determine whether this is your own
    // machine," not a reassurance about somebody else's network.
    //
    // Asserted through the classifier with an EXPLICIT empty overlay rather than
    // through `ADDITIONAL_PRIVATE_CIDRS`, because this file deliberately runs with
    // the overlay declared (see the vi.hoisted block at the top). The shipped
    // default being empty is pinned where it lives — protocol's own test.
    expect(classifyDestination(OWNER_BOX, [])).toBe('external');
    expect(classifyDestination(OWNER_BOX, undefined)).toBe('external');
    // ⚠️ Deliberately NOT also grepping settings-model.ts for the literal here.
    // That question — 「did shipped code re-acquire a LAN address」 — belongs to
    // verify/lint/no-lan-ip.mjs, which owns the comment-waiver distinction this
    // assertion cannot make (the explanations in settings-model.ts NAME the old
    // addresses, and a naive regex reads documentation as a defect). Two
    // mechanisms answering one question is the shape this repo keeps paying for.
  });

  it('(B) the verdict slot never claims ownership the classifier cannot prove', () => {
    // These two keys have exactly ONE call site — the <span class="verdict"> in
    // ScenarioInference.vue — so pinning the catalogue pins the slot. The grep
    // is asserted here rather than described in a comment (anti-façade ④). The
    // \b matters: `S.infer_dest_unprovable_note` is a DIFFERENT key rendered in a
    // different slot, and a prefix match would silently count it as a third hit.
    expect(src.match(/S\.infer_dest_(?:private|unprovable)\b/g)).toHaveLength(2);
    for (const loc of LOCALES) {
      for (const key of ['infer_dest_private', 'infer_dest_unprovable'] as const) {
        for (const w of THIRD_PARTY_WORDS) {
          expect(S_BY_LOCALE[loc][key].toLowerCase(), `${loc}.${key} vs ${w}`).not.toContain(
            w.toLowerCase(),
          );
        }
      }
    }
  });

  it('(C) on the unprovable branch the word only ever appears next to the 「cannot tell」 hedge', async () => {
    model.llm.endpoint = CLOUD;
    expect(inferenceDestination()).toBe('external'); // positive control
    let sawTheWordAtLeastOnce = false;
    for (const { loc, html } of await renderAllLocales()) {
      const hedge = S_BY_LOCALE[loc].infer_dest_unprovable;
      const mentions = THIRD_PARTY_WORDS.some((w) => html.toLowerCase().includes(w.toLowerCase()));
      if (!mentions) continue;
      sawTheWordAtLeastOnce = true;
      expect(html, `${loc} names a third party without the hedge`).toContain(hedge);
    }
    // Reverse-control anchor: if the copy ever stops mentioning it at all, this
    // clause silently guards nothing — so it must fail rather than pass empty.
    expect(sawTheWordAtLeastOnce, 'clause (C) guarded nothing').toBe(true);
  });

  it('states the off-timing as "from the next sentence" and never as "immediately"', () => {
    // "Immediately" would promise something untrue: the sentence being assembled right
    // now already has its prompt built.
    expect(S_BY_LOCALE['zh-CN'].infer_off_note).toContain('下一句起');
    expect(S_BY_LOCALE['zh-CN'].infer_off_note).not.toContain('即刻');
    expect(S_BY_LOCALE.en.infer_off_note).toContain('from the next sentence');
  });

  it('all four locales carry every consent string, non-empty', async () => {
    for (const loc of ['zh-CN', 'en', 'ja', 'ko'] as const) {
      for (const key of ['infer_collect', 'infer_no_screen', 'infer_sends_to', 'infer_off_note'] as const) {
        expect(S_BY_LOCALE[loc][key].trim(), `${loc}.${key}`).not.toBe('');
      }
    }
    // …and the component really switches with them (not just the catalogue).
    setLocale('en');
    const en = await renderToString(createSSRApp(ScenarioInference));
    expect(en).toContain('never takes a screenshot');
    expect(en).not.toContain('不读窗口标题');
    setLocale('zh-CN');
  });

  it('change-applies-immediately: the toggle writes through setScenarioInferenceGranted, and there is no save button', () => {
    expect(src).toContain('setScenarioInferenceGranted(!inferenceEnabled())');
    const tpl = src.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
    expect(tpl).not.toMatch(/type="submit"/);
    expect(tpl).not.toMatch(/保存|Save/);
    // No half-open doors allowed: the overrides key has no UI in this card, so
    // it has no disabled button and no "coming soon" placeholder either.
    expect(tpl).not.toContain('overrides');
    expect(tpl).not.toMatch(/即将|coming soon/i);
  });

  it('the destination is never re-derived in the UI — the classifier is imported', () => {
    // Landmine 2: lib/lan-endpoint.ts has its own idea of "private network" (it
    // patches a missing scheme onto a bare host; the classifier refuses a
    // non-URL outright). Using it
    // here would be a second answer to the question the server gates on.
    const modelSrc = readFileSync(fileURLToPath(new URL('./settings-model.ts', import.meta.url)), 'utf8');
    expect(modelSrc).toContain('classifyDestination');
    expect(modelSrc).toContain('ADDITIONAL_PRIVATE_CIDRS');
    expect(modelSrc).toContain('inferenceBlockedReason');
    expect(modelSrc).not.toContain('lan-endpoint');
    expect(src).not.toContain('lan-endpoint');
    expect(inferenceDestination()).toBe(
      classifyDestination(model.llm.endpoint, ADDITIONAL_PRIVATE_CIDRS),
    );
  });
});
