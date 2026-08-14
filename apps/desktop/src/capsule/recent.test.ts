// V2-15 / V2-16 — the structured "delivered-in record" (转入记录) strip + the pre-utterance session title.
//
// Specs ①②③ below are the card's acceptance bars: ① a translated row shows the
// TRANSLATION by default with the original one click away; ② the three content
// states are mutually distinct on the row; ③ a missing field is OMITTED, never
// back-filled with a plausible default — the only guard against fabricating data (编数据) this card
// has. The SFC is also read literally (the mode-badge.test.ts technique): a
// state field nobody renders, or a MODE_BADGE the template re-literalises, is
// exactly the façade bug class this repo hunts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchPairedMobiles } from '../lib/bridge';
import { CHANNEL_VISUAL } from '../lib/channel';
import { MODE_BADGE, S } from '../lib/strings';
import type { WireHistoryItem } from '../lib/types';
import {
  deriveSessionTitle,
  onConnection,
  resetDirectoryEdgeForTest,
  setDirectoryFetcher,
  state,
  toRecentLine,
  upsertRecentLine,
  type RecentLine,
} from './controller';

const capsuleVue = readFileSync(fileURLToPath(new URL('./CapsuleApp.vue', import.meta.url)), 'utf8');
const capsuleCss = readFileSync(fileURLToPath(new URL('../styles/capsule.css', import.meta.url)), 'utf8');

const wire = (over: Partial<WireHistoryItem>): WireHistoryItem => ({
  id: 'r1',
  mode: 'realtime',
  status: 'injected',
  source_text: null,
  output_text: '大家好',
  created_at: '2026-07-28T08:20:00.000Z',
  updated_at: '2026-07-28T08:20:00.000Z',
  ...over,
});

beforeEach(() => {
  state.recent = [];
  state.mobileNames = {};
  state.session = S.cap_session_default as string;
  state.speaking = false;
  state.mobiles = 0;
  state.phonePresent = false;
  resetDirectoryEdgeForTest();
});
afterEach(() => {
  // Hand the REAL bridge read back so a fake never leaks into another spec.
  setDirectoryFetcher(fetchPairedMobiles);
});

describe('① V2-15 translated row: processed text by default, original expandable', () => {
  it('a translate wire row yields the translation (译文) as the face and the original text (原文) as the source', () => {
    const line = toRecentLine(
      wire({ mode: 'translate', output_text: 'Hello everyone', source_text: '大家好' }),
    );
    expect(line?.mode).toBe('translate');
    expect(line?.text).toBe('Hello everyone'); // the PROCESSED result…
    expect(line?.source).toBe('大家好'); // …and the original is kept, not shown
  });

  it('the SFC renders the processed face in the row line and gates the source behind the expand toggle', () => {
    // Default face = the processed text, with the full text in the tooltip.
    expect(capsuleVue).toContain('<span class="rtext" :title="l.text">{{ l.text }}</span>');
    // The original appears ONLY under the expanded branch — never by default.
    expect(capsuleVue).toContain('v-if="canShowSource(l) && expandedSrc.has(l.id)"');
    expect(capsuleVue).toContain('{{ S.tl_source_label }}{{ l.source }}');
    // …and the toggle itself is gated the same way the timeline gates it.
    expect(capsuleVue).toContain('v-if="canShowSource(l)"');
  });
});

describe('② V2-15 the three content states are mutually distinct on the row', () => {
  it('realtime / translate / organize narrow to three different modes…', () => {
    const modes = (['realtime', 'translate', 'organize'] as const).map(
      (m) => toRecentLine(wire({ mode: m }))?.mode,
    );
    expect(new Set(modes).size).toBe(3);
  });

  it('…and the capsule marks them with the SHARED MODE_BADGE table (V2-17), no re-listed literals', () => {
    expect(capsuleVue).toContain(':title="MODE_BADGE[l.mode]?.label"');
    expect(capsuleVue).toContain('<Icon :name="MODE_BADGE[l.mode]?.icon ?? \'\'" />');
    expect(capsuleVue).toContain(':class="MODE_BADGE[l.mode]?.cls"');
    // The table itself still gives three distinct icons + words (belt to the
    // suspenders of mode-badge.test.ts, now for the capsule consumer).
    const icons = ['realtime', 'translate', 'organize'].map((m) => MODE_BADGE[m]?.icon);
    const labels = ['realtime', 'translate', 'organize'].map((m) => MODE_BADGE[m]?.label);
    expect(new Set(icons).size).toBe(3);
    expect(new Set(labels).size).toBe(3);
  });
});

describe('③ V2-15 a missing field is OMITTED, never back-filled (the fabricating-data (编数据) guard)', () => {
  it('an unknown wire mode stays null — it is NOT defaulted to realtime', () => {
    expect(toRecentLine(wire({ mode: 'hyperdrive' as never }))?.mode).toBeNull();
  });

  it('an absent/unparseable created_at yields NO time (and no borrowed timestamp)', () => {
    expect(toRecentLine(wire({ created_at: '' }))?.time).toBeNull();
    expect(toRecentLine(wire({ created_at: 'not-a-date' }))?.time).toBeNull();
  });

  it('an absent mobile_id yields NO sender id', () => {
    expect(toRecentLine(wire({}))?.mobileId).toBeNull();
    expect(toRecentLine(wire({ mobile_id: 'pair-9' }))?.mobileId).toBe('pair-9');
  });

  // 卡 P/D — a row minted from a delivery frame carries `device_label` and NEVER a
  // `mobile_id` (the relay forwards the inject frame verbatim and it has no pairing
  // id). Without this the strip's device cell would be omitted on every new row, i.e.
  // the field would exist with nothing rendering it.
  it('the phone’s own label is narrowed the same way, and empty is not a label', () => {
    expect(toRecentLine(wire({}))?.deviceLabel).toBeNull();
    expect(toRecentLine(wire({ device_label: '' }))?.deviceLabel).toBeNull();
    expect(toRecentLine(wire({ device_label: 'Pixel 8-ab12' }))?.deviceLabel).toBe('Pixel 8-ab12');
  });

  it('the SFC resolves the sender name from the pairing map FIRST, then that label', () => {
    // Read literally, like MODE_BADGE above: a `deviceLabel` the template never
    // consults is the same façade this file exists to catch.
    expect(capsuleVue).toContain('deviceName');
    expect(capsuleVue).toContain('l.deviceLabel');
  });

  it('a row without an id cannot be rendered at all', () => {
    expect(toRecentLine(wire({ id: '' }))).toBeNull();
  });

  it('the SFC omits each missing CELL (v-if), instead of rendering a placeholder', () => {
    // `v-else-if` on the mode badge since v0.2.2 — an image row takes the branch
    // before it. The rule under test is unchanged: a row with NO mode renders no
    // badge at all rather than a stand-in.
    expect(capsuleVue).toMatch(/v-(else-)?if="l\.mode"/);
    expect(capsuleVue).toContain('v-if="l.time"');
    expect(capsuleVue).toContain('v-if="deviceName(l)"');
  });

  // W2 / RV-43 §4 — every injection face must have a production reader (façade rule
  // ①). Glyphs are Icons; these are the WORDS. FIVE since owner 2026-08-07 甲-3 split
  // the green face by ③evidence: `cap_delivered` is the weak half, and it is listed
  // here on the day it was born precisely because a new catalogue entry with no reader
  // is the shape this assertion exists to catch.
  it('the SFC consumes the five capsule-face getters ("injected" / "delivered" / "waiting to inject" / "not injected · cached" / "not injected")', () => {
    expect(capsuleVue).toContain('S.cap_injected');
    expect(capsuleVue).toContain('S.cap_delivered');
    expect(capsuleVue).toContain('S.cap_delivering');
    expect(capsuleVue).toContain('S.cap_cached');
    expect(capsuleVue).toContain('S.cap_inject_failed');
  });

  // ── v0.2.2: an image row is not a transcript ────────────────────────────
  //
  // owner 2026-07-29, from a screenshot: the picture row wore the realtime
  // WAVEFORM badge, i.e. it looked like something that had been said. `mode` is
  // meaningless for a picture, and the strip was rendering it anyway.
  it('an image row carries entryType + thumb off the wire', () => {
    const img = toRecentLine(wire({ entry_type: 'image', thumb_b64: 'QUJD' }));
    expect(img?.entryType).toBe('image');
    expect(img?.thumb).toBe('QUJD');
    // A transcript row is the default and must NOT claim a picture.
    const txt = toRecentLine(wire({}));
    expect(txt?.entryType).toBe('transcript');
    expect(txt?.thumb).toBeNull();
    // An image row WITHOUT a preview is still an image row — the badge falls
    // back to an icon rather than the row pretending to be a transcript.
    expect(toRecentLine(wire({ entry_type: 'image' }))?.thumb).toBeNull();
    expect(toRecentLine(wire({ entry_type: 'image', thumb_b64: '' }))?.thumb).toBeNull();
  });

  it('the SFC gives an image row its OWN badge, ahead of the mode badge', () => {
    // Ordering is the whole fix: the image branch must come FIRST, otherwise a
    // picture that also carries a mode keeps the waveform.
    const imageBranch = capsuleVue.indexOf(`v-if="l.entryType === 'image'"`);
    const modeBranch = capsuleVue.search(/v-else-if="l\.mode"/);
    expect(imageBranch).toBeGreaterThan(-1);
    expect(modeBranch).toBeGreaterThan(imageBranch);
    // The picture itself when there is one, a generic icon when there is not.
    expect(capsuleVue).toContain('data:image/png;base64,${l.thumb}');
    expect(capsuleVue).toContain('name="image"');
    // …and it is clickable, because a HUD cannot show a picture properly and the
    // main window already can.
    expect(capsuleVue).toContain('@click="openImage()"');
  });
});

describe('V2-15 line shape: time format + ordering + upsert', () => {
  it('time is HH:mm, hand-built (no OS-locale leakage)', () => {
    const iso = '2026-07-28T08:20:00.000Z';
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const want = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(toRecentLine(wire({ created_at: iso }))?.time).toBe(want);
  });

  it('upsert: a new id prepends and the strip caps at 5', () => {
    let list: RecentLine[] = [];
    for (let i = 0; i < 7; i++) {
      const line = toRecentLine(wire({ id: `r${i}` }))!;
      list = upsertRecentLine(list, line);
    }
    expect(list.map((l) => l.id)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
  });

  it('upsert: a stt:refined / peer edit REPLACES IN PLACE — no duplicate, no jump to top', () => {
    let list: RecentLine[] = [];
    list = upsertRecentLine(list, toRecentLine(wire({ id: 'a' }))!);
    list = upsertRecentLine(list, toRecentLine(wire({ id: 'b' }))!);
    const refined = toRecentLine(wire({ id: 'a', output_text: '第二遍的更好版本' }))!;
    list = upsertRecentLine(list, refined);
    expect(list.map((l) => l.id)).toEqual(['b', 'a']);
    expect(list[1]?.text).toBe('第二遍的更好版本');
  });

  // The two `mergeRecentSeed` specs are GONE with the function (0.2.27). It merged a
  // `history:list-result` snapshot into the strip, and the server stores no transcripts
  // — the pull could only ever have answered empty, which on an empty strip looks
  // exactly like a seed that worked. Nothing replaces it: the rows live on the PC and
  // this window does not own them. What the strip still guarantees — upsert in place,
  // the cap, newest-first — is covered by the `upsertRecentLine` specs above.
});

describe('V2-16 deriveSessionTitle: the pre-utterance capsule title', () => {
  it('exactly ONE online phone → its pairing name', () => {
    expect(deriveSessionTitle(['Pixel 8-ab12'], false, '手机')).toBe('Pixel 8-ab12');
  });

  it('zero online → the generic default', () => {
    expect(deriveSessionTitle([], false, 'Pixel 8-ab12')).toBe(S.cap_session_default);
  });

  it('≥2 online → the generic default (naming one of several would be a guess)', () => {
    expect(deriveSessionTitle(['Pixel 8-ab12', 'Mate 60-cd34'], false, '手机')).toBe(S.cap_session_default);
  });

  // ⚠️ 卡 D-a — this case used to be named "the title belongs to audio:start", and that
  // sentence was the cover for a branch that could never run: `AudioStartSchema` has no
  // `device_label`, so `onAudioStart` never wrote this field. The BEHAVIOUR asserted
  // here is unchanged and still wanted; only its stated reason was fiction.
  it('mid-utterance the title is held STEADY — a refresh must not re-label under the user', () => {
    expect(deriveSessionTitle(['Pixel 8-ab12'], true, 'Mate 60-cd34')).toBe('Mate 60-cd34');
  });
});

describe('V2-19 per-row copy button (owner 2026-08-01 §4b-7)', () => {
  it('the button is gated by canCopyLine — omitted, not disabled, for a row with nothing to copy', () => {
    expect(capsuleVue).toContain('v-if="canCopyLine(l)"');
    expect(capsuleVue).toContain('@click="copyLine(l)"');
  });

  it('the icon swaps copy → check/✗ off the SAME per-row status, never a growing element', () => {
    expect(capsuleVue).toContain("copyStatus[l.id] === 'copied' ? 'check'");
    expect(capsuleVue).toContain("copyStatus[l.id] === 'error' ? 'x'");
    // Tooltip carries the failure word instead of a new banner (form height is
    // a fixed budget per 07 §1 — nothing here may grow the idle_with_history row).
    expect(capsuleVue).toContain('S.op_copy_failed');
  });

  // Gate 1 (focus gate / 焦点门): the copy control must NEVER do what openImage/openSettings
  // do — those explicitly call showMainWindow() as the one user-gesture
  // exception to "ambient surfacing never activates or steals focus" (ambient 浮现永不激活抢焦点). copyLine must stay pure
  // clipboard + local state, or it would silently cross into that exception
  // without the click actually being one. This is the literal, breakable
  // guarantee behind item ② of the C-2 task brief (window (窗口) activation is a
  // native WS_EX_NOACTIVATE property applied once at setup — see
  // apps/desktop/src-tauri/src/shell/mod.rs `configure_capsule_window` — so
  // this test cannot observe THAT half; it guards the half that lives in
  // this file: that copyLine never asks for activation in the first place).
  it('copyLine never calls showMainWindow/navigateMain — it stays ambient, no focus-steal exception invoked', () => {
    const start = capsuleVue.indexOf('async function copyLine');
    const end = capsuleVue.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = capsuleVue.slice(start, end);
    expect(body).not.toContain('showMainWindow');
    expect(body).not.toContain('navigateMain');
  });

  it('a refused write is recorded, never silent (appendForensic on the catch branch)', () => {
    const start = capsuleVue.indexOf('async function copyLine');
    const end = capsuleVue.indexOf('\n}', start);
    const body = capsuleVue.slice(start, end);
    expect(body).toContain('appendForensic');
    expect(body).toContain('FAILED');
  });

  it('the copy payload is copyPayload(l) — literally the module capsule-copy.ts owns, not a re-derived string here', () => {
    expect(capsuleVue).toContain('capsule.copyText(copyPayload(l))');
  });

  // 2026-08-02 escalation (coordinator-mandated): the browser Clipboard API
  // requires `document.hasFocus()`, and the capsule's WS_EX_NOACTIVATE window
  // may never satisfy that — which would make a `navigator.clipboard` button
  // reject on EVERY click regardless of what the user does (R8 façade). This
  // is the literal, breakable guarantee that the fix stays fixed: the browser
  // path must never come back as the capsule's write mechanism.
  it('never falls back to navigator.clipboard — the native command is the ONLY write path', () => {
    // Not a bare substring check: the explanatory comment above copyLine
    // NAMES `navigator.clipboard` (to say why it is NOT used), so the guard
    // has to target an actual CALL, not the word appearing in prose.
    expect(capsuleVue).not.toMatch(/navigator\.clipboard\.(writeText|write)\(/);
  });

  // 2026-08-02 second pass (RV-97 precedent, coordinator-mandated): the first
  // cut of this feature imported the Tauri `invoke` binding DIRECTLY in this
  // file, making `lib/bridge.ts` no longer the only production import site of
  // the Tauri JS API package in this app — exactly the "address rules scattered across multiple places" (地址规则散落多处) shape
  // RV-97 (ws→http, `http_endpoint.dart`) paid tuition for, where the SAME
  // defect family surfaced three times, once leaving every scanned-pairing
  // session's channel unknown for its whole life. A funnel with a second
  // entry point stops being a funnel, and the next person edits by example —
  // so this has to be a machine guard, not a remembered rule ("a discipline
  // that relies on people remembering it, once it has already been missed
  // twice, should be automated" (要靠人记住的纪律，已经被漏掉两次，就该自动化)). `capsule.copyText` in lib/bridge.ts is
  // now the ONLY caller of `capsule_copy_text`.
  //
  // The regex literal below necessarily NAMES the package it forbids (a check
  // for a string's absence has to spell the string out somewhere) — that is
  // expected and is the one legitimate reason this test file itself still
  // matches a bare `grep "@tauri-apps/api"`; it is a guard, not a second
  // import site. See the round's report for the production-only grep.
  it('imports NO Tauri JS API package directly — every Tauri call goes through lib/bridge.ts', () => {
    expect(capsuleVue).not.toMatch(/from ['"]@tauri-apps\/api/);
  });
});

describe('V2-16 wiring: connection edge → directory → state.session', () => {
  const frame = (mobiles: number) => ({
    connected: true,
    registered: true,
    room_uuid: 'room-1',
    mobiles,
    primary: true,
    channel: 'lan',
    reason: 'test',
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a phone joining names the capsule before its first utterance', async () => {
    setDirectoryFetcher(async () => [
      { pairing_id: 'p1', mobile_name: 'Pixel 8-ab12', paired_at: '2026-07-20T00:00:00Z', last_seen_at: null, online: true, channel: 'lan' as const, device_uid: null },
    ]);
    onConnection(frame(1));
    await flush();
    expect(state.session).toBe('Pixel 8-ab12');
    expect(state.mobileNames.p1).toBe('Pixel 8-ab12');
  });

  it('the phone leaving returns the title to the generic default', async () => {
    setDirectoryFetcher(async () => [
      { pairing_id: 'p1', mobile_name: 'Pixel 8-ab12', paired_at: '2026-07-20T00:00:00Z', last_seen_at: null, online: true, channel: 'lan' as const, device_uid: null },
    ]);
    onConnection(frame(1));
    await flush();
    expect(state.session).toBe('Pixel 8-ab12');
    setDirectoryFetcher(async () => [
      { pairing_id: 'p1', mobile_name: 'Pixel 8-ab12', paired_at: '2026-07-20T00:00:00Z', last_seen_at: null, online: false, channel: 'lan' as const, device_uid: null },
    ]);
    onConnection(frame(0));
    await flush();
    expect(state.session).toBe(S.cap_session_default);
  });

  it('two online phones keep the generic title (honest ambiguity)', async () => {
    setDirectoryFetcher(async () => [
      { pairing_id: 'p1', mobile_name: 'Pixel 8-ab12', paired_at: '2026-07-20T00:00:00Z', last_seen_at: null, online: true, channel: 'lan' as const, device_uid: null },
      { pairing_id: 'p2', mobile_name: 'Mate 60-cd34', paired_at: '2026-07-21T00:00:00Z', last_seen_at: null, online: true, channel: 'lan' as const, device_uid: null },
    ]);
    onConnection(frame(2));
    await flush();
    expect(state.session).toBe(S.cap_session_default);
    // …but BOTH names are in the directory, so each recent row can still say
    // which of the two sent it.
    expect(state.mobileNames.p2).toBe('Mate 60-cd34');
  });

  it('a FAILED directory read keeps the previous title + map (null ≠ no phones)', async () => {
    setDirectoryFetcher(async () => [
      { pairing_id: 'p1', mobile_name: 'Pixel 8-ab12', paired_at: '2026-07-20T00:00:00Z', last_seen_at: null, online: true, channel: 'lan' as const, device_uid: null },
    ]);
    onConnection(frame(1));
    await flush();
    setDirectoryFetcher(async () => null);
    onConnection(frame(0));
    await flush();
    expect(state.session).toBe('Pixel 8-ab12');
    expect(state.mobileNames.p1).toBe('Pixel 8-ab12');
  });

  it('mid-utterance a directory refresh does NOT re-label the capsule', async () => {
    // 卡 D-a: the label being protected is whatever the LAST directory read derived —
    // not, as this line used to claim, something audio:start wrote (it never could).
    state.session = 'Mate 60-cd34';
    state.speaking = true;
    setDirectoryFetcher(async () => [
      { pairing_id: 'p1', mobile_name: 'Pixel 8-ab12', paired_at: '2026-07-20T00:00:00Z', last_seen_at: null, online: true, channel: 'lan' as const, device_uid: null },
    ]);
    onConnection(frame(1));
    await flush();
    expect(state.session).toBe('Mate 60-cd34');
  });

  it('a NON-primary frame never triggers the directory (GA-28 primary gate)', async () => {
    let reads = 0;
    setDirectoryFetcher(async () => {
      reads += 1;
      return [];
    });
    onConnection({ ...frame(1), primary: false });
    await flush();
    expect(reads).toBe(0);
    expect(state.session).toBe(S.cap_session_default);
  });
});

// V2-20 — channel visual identity (owner 2026-08-01: LAN / cloud relay each get their own colour + icon identity (LAN/云端中继各立颜色+图标身份),
// defined once and unified across the whole product (一处定义全产品统一)). This lane only CONSUMES the existing definitions —
// CHANNEL_VISUAL (lib/channel.ts, icon path + css class) and the four
// --channel-*-ink/-soft tokens (styles/tokens.css, already AA-checked by
// another lane) — the same pair main-window/TimelinePage.vue's `.chan-badge`
// already reads. Nothing new is defined in this file; capsule.css only maps
// the capsule's OWN `.chan` element onto those same tokens at its own size.
describe('V2-20 channel visual identity (owner 2026-08-01, consumed not reinvented)', () => {
  it('lan and cloud are genuinely different — not the same icon recoloured (positive probe: both non-empty)', () => {
    // Positive probe first: if either path were empty, "different" would be a
    // false positive (empty !== non-empty is trivially true and proves nothing).
    expect(CHANNEL_VISUAL.lan.iconPath.length).toBeGreaterThan(0);
    expect(CHANNEL_VISUAL.cloud.iconPath.length).toBeGreaterThan(0);
    expect(CHANNEL_VISUAL.lan.iconPath).not.toBe(CHANNEL_VISUAL.cloud.iconPath);
    expect(CHANNEL_VISUAL.lan.css).not.toBe(CHANNEL_VISUAL.cloud.css);
  });

  it('the header chip binds the shared icon+class dynamically off state.channel (not a static default)', () => {
    expect(capsuleVue).toContain(
      '<span class="chan" :class="CHANNEL_VISUAL[state.channel].css">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" ' +
        'v-html="CHANNEL_VISUAL[state.channel].iconPath"></svg>' +
        '{{ connChannelLabel(state.channel) }}</span>',
    );
  });

  it('the diagnostics row carries the SAME badge (one definition, two consumers) — not a plain-text duplicate', () => {
    expect(capsuleVue).toContain(
      '<span class="chan chan-diag" :class="CHANNEL_VISUAL[state.channel].css">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" ' +
        'v-html="CHANNEL_VISUAL[state.channel].iconPath"></svg>' +
        '{{ connChannelLabel(state.channel) }}</span>',
    );
    // Exactly two icon bindings in the whole file — the header and the diag
    // row, and nowhere a THIRD, silently-diverged copy.
    const bindingCount = (capsuleVue.match(/v-html="CHANNEL_VISUAL\[state\.channel\]\.iconPath"/g) ?? []).length;
    expect(bindingCount).toBe(2);
  });

  it('the colour is read ONLY from the four shared tokens — capsule.css defines .chan.lan/.chan.cloud, zero new hex', () => {
    expect(capsuleCss).toContain(
      '.chan.lan { color: var(--channel-lan-ink); background: var(--channel-lan-soft); }',
    );
    expect(capsuleCss).toContain(
      '.chan.cloud { color: var(--channel-cloud-ink); background: var(--channel-cloud-soft); }',
    );
    // No hex/rgb/hsl literal anywhere inside either new rule — the same
    // guarantee `pnpm verify:lint`'s design-token-literals checks for .vue/.ts,
    // asserted locally so a reviewer does not have to trust the lint run alone
    // (that lint does not even scan .css files — see its own header).
    expect(capsuleCss).not.toMatch(/\.chan\.(lan|cloud)\s*\{[^}]*#[0-9a-fA-F]{3,8}/);
    expect(capsuleCss).not.toMatch(/\.chan\.(lan|cloud)\s*\{[^}]*(rgba?|hsla?)\(/);
  });
});

// ── 🔴 卡 L7 / owner 2026-08-02 — "on the PC-side capsule window, the row for a
//    message that wasn't injected should use a different background or style
//    to set it apart" (docs/rebuild/15 §2.5c-2) ─────────────────────────────────────
//
// This was NOT a pure-CSS card: `RecentLine` had no `status` field and
// `toRecentLine` never read `item.status`, so every row in the strip was blind
// to its own injection outcome — even though `WireHistoryItem.status` had been
// on the wire the whole time (book 15 §1.4's "`pc_online` was always right
// there on the ack, and the phone dropped it on the floor", the same shape).
describe('卡 L7 — the strip knows whether a row was injected', () => {
  it('narrows `status` off the wire row', () => {
    expect(toRecentLine(wire({ status: 'injected' }))?.status).toBe('injected');
    expect(toRecentLine(wire({ status: 'cached' }))?.status).toBe('cached');
    expect(toRecentLine(wire({ status: 'failed' }))?.status).toBe('failed');
    expect(toRecentLine(wire({ status: 'noted' }))?.status).toBe('noted');
  });

  it('an ABSENT or unknown status stays null — never guessed into a value', () => {
    // Same rule as `mode` (V2-15 ③): a missing field vanishes, it is never
    // back-filled with a plausible default. A guessed 'injected' here would
    // paint a NOT-injected row as if it had landed.
    const unknown = toRecentLine(wire({ status: 'teleported' as never }));
    expect(unknown?.status).toBeNull();
    const absent = toRecentLine({ ...wire({}), status: undefined as never });
    expect(absent?.status).toBeNull();
  });

  it('the SFC binds a per-row status class built by ONE function', () => {
    // anti-façade ①: the field has a production reader, and the template does not
    // re-implement the mapping with its own literals.
    expect(capsuleVue).toContain(':class="rowStatusClass(l)"');
    expect(capsuleVue).toContain("if (l.status === 'cached') return 'st-cached';");
    expect(capsuleVue).toContain("if (l.status === 'failed') return 'st-failed';");
  });

  it('🔴 noted (record-only, 仅记录) is NOT dressed as a failure, and neither is an unknown row', () => {
    // R9: a noted row is never offered for injection at all, so a failure style
    // would manufacture a fault the user does not have.
    const cls = (s: string): string => {
      const m = capsuleVue.match(/function rowStatusClass\(l: RecentLine\): string \{([\s\S]*?)\n\}/);
      expect(m, 'rowStatusClass must exist').not.toBeNull();
      const body = m![1]!;
      // Emulate the function's own branch order rather than re-implementing it.
      if (body.includes(`l.status === '${s}'`)) return `st-${s}`;
      return '';
    };
    expect(cls('noted')).toBe('');
    expect(cls('injected')).toBe('');
  });

  it('🔴 greyscale-readable: each decorated row gets a BAR, not colour alone', () => {
    // The channel-badge principle. A border-left is a SHAPE, so the distinction
    // survives a colour-blind reader and a greyscale screenshot.
    expect(capsuleCssInline()).toMatch(/\.recent \.r\.st-cached \{[^}]*border-left:\s*3px solid var\(--amber\)/);
    expect(capsuleCssInline()).toMatch(/\.recent \.r\.st-failed \{[^}]*border-left:\s*3px solid var\(--red\)/);
    // Same tokens the 📥/✗ capsule faces already use — "same status, one colour".
    expect(capsuleCssInline()).toMatch(/\.recent \.r\.st-cached \{[^}]*background: var\(--amber-soft\)/);
    expect(capsuleCssInline()).toMatch(/\.recent \.r\.st-failed \{[^}]*background: var\(--red-soft\)/);
    // Zero new hex — the tokens are theme-aware, a literal would not be.
    expect(capsuleCssInline()).not.toMatch(/\.recent \.r\.st-(cached|failed) \{[^}]*#[0-9a-fA-F]{3,8}/);
  });

  it('a late verdict re-paints the SAME row through the existing upsert (no new mechanism)', () => {
    // book 15 §2.5c-2 ②: the row and its verdict are two frames of unknown order.
    const first = toRecentLine(wire({ id: 'r9', status: 'cached' }))!;
    let list = upsertRecentLine([], first);
    expect(list[0]!.status).toBe('cached');
    const verdict = toRecentLine(wire({ id: 'r9', status: 'injected' }))!;
    list = upsertRecentLine(list, verdict);
    expect(list).toHaveLength(1);          // replaced IN PLACE, not appended
    expect(list[0]!.status).toBe('injected');
  });
});

/** The SFC's own <style scoped> block (the strip rules live there, not in
 *  styles/capsule.css). Read literally, same technique as `capsuleVue` above. */
function capsuleCssInline(): string {
  const i = capsuleVue.indexOf('<style scoped>');
  expect(i, 'CapsuleApp.vue must have a scoped style block').toBeGreaterThan(-1);
  return capsuleVue.slice(i);
}
