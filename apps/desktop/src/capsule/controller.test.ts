// GA-25 — the capsule's "inject target" (注入目标) against the REAL reactive state: the two writers
// of `state.target` (live focus vs. the delivered inject:result) and the lock that
// freezes the display mid-utterance.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRecentChannel,
  capsuleVisibleForTest,
  dismiss,
  fireAudioStartForTest,
  fireLatchStarvedForTest,
  firePhonePausedForTest,
  firePhoneResumedForTest,
  onConnection,
  speakingForTest,
  onFocusChanged,
  onHistoryDeleted,
  onHistoryItem,
  onInjectResult,
  primaryChannelForTest,
  resetDirectoryEdgeForTest,
  resetPrimaryChannelForTest,
  seedConnection,
  setConnectionSnapshotFetcher,
  setDirectoryFetcher,
  state,
} from './controller';
import type { ConnectionState } from '../lib/types';
import { DEFAULT_LOCALE, INJECT_FAIL_REASON, S, setLocale } from '../lib/strings';
import { INJECT_FAIL_REASON_CATALOGUES } from '../lib/strings/capsule';

const focus = (window_title: string, process_name = 'notepad') => ({
  window_title,
  process_name,
});

beforeEach(() => {
  setLocale('zh-CN');
  state.target = '';
  state.locked = false;
  state.injected = null;
  state.injectFailed = null;
  state.finalText = '';
  state.interim = '';
  state.recent = [];
  state.mobiles = 0;
  state.phonePresent = false;
  resetPrimaryChannelForTest('lan');
});

// GA-28 (owner UAT 2026-07-26): the capsule floated on the cloud relay (云端中继) (primary,
// phones online (在线手机) = 0) instance because a stale LAN PRESENCE frame (primary:false) carried
// mobiles>0 and was the last CONNECTION frame the capsule received. The HUD must
// key off the PRIMARY channel alone — a phone on a non-primary channel is not a
// phone on the active instance.
describe('capsule phone-presence keys off the PRIMARY channel only', () => {
  const frame = (mobiles: number, primary: boolean | undefined) => ({
    connected: true,
    registered: true,
    room_uuid: 'room-1',
    mobiles,
    primary,
    channel: primary === false ? 'lan' : 'cloud',
  });

  it('a NON-primary (presence) frame with mobiles>0 does NOT mark a phone present', () => {
    onConnection(frame(1, false));
    expect(state.phonePresent).toBe(false);
    expect(state.mobiles).toBe(0);
  });

  it('a PRIMARY frame drives presence; primary=0 clears a phantom left by a stale non-primary frame', () => {
    onConnection(frame(2, true)); // phone genuinely on the active instance
    expect(state.phonePresent).toBe(true);
    onConnection(frame(1, false)); // stale presence frame on the other channel — ignored
    expect(state.phonePresent).toBe(true);
    onConnection(frame(0, true)); // active instance now empty → presence clears
    expect(state.phonePresent).toBe(false);
  });

  it('a pre-GA-28 frame with primary absent is treated as the primary', () => {
    onConnection(frame(1, undefined));
    expect(state.phonePresent).toBe(true);
  });
});

// RV-07 — the capsule had cloud / sidecar / history seeds and NO connection seed,
// so the v0.2.4 pull fix (main-window/store.ts + connection-seed.test.ts) covered
// the main window only. `flowmic://connection` fires on CHANGE and Rust wins the
// boot race every time, so "desktop restarted, phone already in the room" (the cloud-leg (云端腿) default) left the HUD
// believing there was no phone for the whole session.
describe('RV-07 capsule seeds CONNECTION from a pull', () => {
  const snapRow = (over: Partial<ConnectionState>): ConnectionState => ({
    connected: true,
    registered: true,
    room_uuid: 'room-1',
    mobiles: 0,
    reason: 'snapshot',
    channel: 'cloud',
    primary: true,
    ...over,
  });

  beforeEach(() => {
    resetDirectoryEdgeForTest();
    // A mobiles-count change asks pc:list-mobiles for the name directory; stub it
    // so the seed under test is the only thing that touches the bridge.
    setDirectoryFetcher(async () => []);
  });

  it('a phone already in the room is present after the seed (no push will ever come)', async () => {
    setConnectionSnapshotFetcher(async () => [snapRow({ mobiles: 1 })]);
    await seedConnection();
    expect(state.phonePresent).toBe(true);
    expect(state.mobiles).toBe(1);
    expect(state.connected).toBe(true);
  });

  it('the seed goes through the SAME primary gate as the push — a non-primary row is not presence', async () => {
    setConnectionSnapshotFetcher(async () => [
      snapRow({ channel: 'lan', primary: false, mobiles: 1 }), // stale presence channel
      snapRow({ channel: 'cloud', primary: true, mobiles: 0 }), // the active instance
    ]);
    await seedConnection();
    expect(state.phonePresent).toBe(false);
    expect(state.mobiles).toBe(0);
  });

  it('an empty snapshot changes nothing — no resident channel is not「a phone left」', async () => {
    setConnectionSnapshotFetcher(async () => [snapRow({ mobiles: 2 })]);
    await seedConnection();
    setConnectionSnapshotFetcher(async () => []);
    await seedConnection();
    expect(state.phonePresent).toBe(true);
  });

  it('a FAILED seed is recorded, not thrown — the drive loop must still start', async () => {
    setConnectionSnapshotFetcher(async () => {
      throw new Error('bridge unavailable');
    });
    await expect(seedConnection()).resolves.toBeUndefined();
    expect(state.phonePresent).toBe(false);
  });
});

describe('capsule target', () => {
  it('① unlocked: focus-changed moves the target (the GA-25 bug: it never did)', () => {
    onFocusChanged(focus('无标题 - 记事本'));
    expect(state.target).toBe('无标题 - 记事本');
    onFocusChanged(focus('Slack | 常规', 'slack'));
    expect(state.target).toBe('Slack | 常规');
  });

  it('② locked: focus-changed does NOT move the target (🔒 freeze, 07 §3)', () => {
    onFocusChanged(focus('无标题 - 记事本'));
    state.locked = true; // audio:start holds the SPEAKING latch
    onFocusChanged(focus('Slack | 常规', 'slack'));
    expect(state.target).toBe('无标题 - 记事本');
    // The view renders the lock icon off this same flag.
    expect(state.locked).toBe(true);
  });

  it('③ a non-injectable foreground clears to empty → "—", never fabricated', () => {
    onFocusChanged(focus('无标题 - 记事本'));
    onFocusChanged({ window_title: 'FlowMic', process_name: 'flowmic-desktop' });
    expect(state.target).toBe('');
  });

  it('④ inject:result overwrites the target with the delivered truth', () => {
    onFocusChanged(focus('无标题 - 记事本'));
    state.locked = true;
    state.finalText = '你好';
    onInjectResult({ ok: true, mode: 'injected', inject_target: { window_title: 'Slack | 常规' } });
    expect(state.target).toBe('Slack | 常规');
    expect(state.injected?.target).toBe('Slack | 常规');
    expect(state.locked).toBe(false);
  });

  it('④b the lock releases with inject:result, so the next focus event flows again', () => {
    onFocusChanged(focus('无标题 - 记事本'));
    state.locked = true;
    onInjectResult({ ok: true, mode: 'injected', inject_target: { window_title: '无标题 - 记事本' } });
    onFocusChanged(focus('Slack | 常规', 'slack'));
    expect(state.target).toBe('Slack | 常规');
  });

  it('④c a FAILED inject does not invent a target, and focus keeps tracking', () => {
    onFocusChanged(focus('无标题 - 记事本'));
    state.locked = true;
    onInjectResult({ ok: false, mode: 'cached', error: 'INJECT_FOCUS_LOST' });
    expect(state.injected).toBeNull();
    expect(state.injectFailed?.cached).toBe(true);
    expect(state.target).toBe('无标题 - 记事本'); // untouched, not overwritten with ''
    onFocusChanged(focus('Slack | 常规', 'slack'));
    expect(state.target).toBe('Slack | 常规');
  });
});

// RV-43 §4 / W2: capsule flash faces match the phone's four words.
// The retired readback-uncertain face left with the 0.2.22 readback gate.
describe('capsule inject flash says the same four faces as the phone', () => {
  it('ok → "injected" (已注入) (green face; view prints S.cap_injected)', () => {
    onInjectResult({
      ok: true,
      mode: 'sendinput',
      inject_target: { window_title: '记事本', process_name: 'notepad', injected_at: '' },
    });
    expect(state.injected).not.toBeNull();
    expect(state.injectFailed).toBeNull();
    expect(S.cap_injected).toBe('已注入');
  });

  it('ok:false + mode:cached → "not injected · cached" (未注入 · 已缓存) (amber, ONE definition with st_cached)', () => {
    onInjectResult({ ok: false, mode: 'cached', error: 'INJECT_FOCUS_LOST' });
    expect(state.injectFailed?.cached).toBe(true);
    // 🔴 卡 L7 — was `toBe('未投递')`. See docs/rebuild/15 §2.0: the capsule runs
    // on the PC, so this frame WAS delivered; only the injection did not happen.
    expect(S.cap_cached).toBe('未注入 · 已缓存');
    // Reason is stored, but the view omits it on the 📥 face (the word already
    // says the whole thing).
    expect(state.injectFailed?.reason).toBe(INJECT_FAIL_REASON.INJECT_FOCUS_LOST);
  });

  // owner 2026-08-07 deleted the word "failed" (失败) from this face, and IJ-02 §C-3 found a
  // second "false shared-source" (假同源) while doing it: this literal used to be '未成功' while the timeline
  // said '注入失败' — the same event, two words across two PC surfaces (同一件事两块 PC 界面两个词), book 15 §2.5c violated in production.
  // It now REFERENCES st_failed, which is what the second assertion pins.
  it('ok:false + hard mode → "not injected" (未注入) (red) with a reason line', () => {
    onInjectResult({ ok: false, mode: 'clipboard', error: 'INJECT_CLIPBOARD_FAIL' });
    expect(state.injectFailed?.cached).toBe(false);
    expect(S.cap_inject_failed).toBe('未注入');
    expect(S.cap_inject_failed).toBe(S.st_failed);
    expect(state.injectFailed?.reason).toBe(INJECT_FAIL_REASON.INJECT_CLIPBOARD_FAIL);
  });

  // RV-50: INJECT_SENDINPUT_FAIL only paints on the !ok face. The old copy
  // "已回退剪贴板 / Fell back to clipboard" (fell back to clipboard) sounded like a successful fallback.
  // Pin: every locale names a FAILURE, never a fallback / success / retry promise.
  it('INJECT_SENDINPUT_FAIL reason names the failure, never a clipboard fallback', () => {
    onInjectResult({ ok: false, mode: 'sendinput', error: 'INJECT_SENDINPUT_FAIL' });
    expect(state.injectFailed?.cached).toBe(false);
    expect(state.injectFailed?.reason).toBe(INJECT_FAIL_REASON.INJECT_SENDINPUT_FAIL);
    expect(INJECT_FAIL_REASON.INJECT_SENDINPUT_FAIL).toBe('打字与粘贴都没成功');
    for (const loc of Object.keys(INJECT_FAIL_REASON_CATALOGUES) as Array<keyof typeof INJECT_FAIL_REASON_CATALOGUES>) {
      const text = INJECT_FAIL_REASON_CATALOGUES[loc].INJECT_SENDINPUT_FAIL!;
      expect(text.length, `${loc} non-empty`).toBeGreaterThan(0);
      // Banned success-shaped / mid-path / promise words (zh/en/ja/ko remnants).
      for (const ban of ['已回退', 'Fell back', 'fallback', 'フォールバック', '폴백', '请重试', 'retry', 'try again']) {
        expect(text.toLowerCase().includes(ban.toLowerCase()), `${loc} must not say「${ban}」`).toBe(false);
      }
    }
    // Default locale is what the capsule paints until the user switches.
    expect(INJECT_FAIL_REASON_CATALOGUES[DEFAULT_LOCALE].INJECT_SENDINPUT_FAIL).toBe('Neither typing nor paste succeeded');
  });

  it('"waiting to inject" (等待注入) is a DISTINCT word from "not injected · cached" (未注入 · 已缓存) (speaking latch, no verdict yet)', () => {
    // 🔴 卡 L7 — was "delivering" (投递中), a segment-① word on a face that is entirely about
    // segment ② (this window IS the PC). docs/rebuild/15 §2.5c.
    expect(S.cap_delivering).toBe('等待注入');
    expect(S.cap_delivering).not.toBe(S.cap_cached);
  });
});

// W2: main-window accepts both channels; capsule "delivered-in record" (转入记录) filters to primary.
describe('"delivered-in record" (转入记录) strip filters by admission-derived primary channel', () => {
  const item = (id: string) => ({
    id,
    mode: 'realtime' as const,
    status: 'injected' as const,
    source_text: null,
    output_text: id,
    created_at: '2026-07-28T08:20:00.000Z',
    updated_at: '2026-07-28T08:20:00.000Z',
  });

  it('acceptRecentChannel: matching stamp passes; wrong / absent stamp fails', () => {
    resetPrimaryChannelForTest('lan');
    expect(acceptRecentChannel('lan')).toBe(true);
    expect(acceptRecentChannel('cloud')).toBe(false);
    // 0.2.18 lesson: no stamp → do NOT guess lan.
    expect(acceptRecentChannel(undefined)).toBe(false);
    expect(acceptRecentChannel('')).toBe(false);
  });

  it('history:updated from the other channel does NOT enter the strip', () => {
    resetPrimaryChannelForTest('lan');
    onHistoryItem({ item: item('cloud-row'), channel: 'cloud' });
    expect(state.recent).toEqual([]);
    onHistoryItem({ item: item('lan-row'), channel: 'lan' });
    expect(state.recent.map((r) => r.id)).toEqual(['lan-row']);
  });

  it('history:updated with NO channel stamp is dropped (never defaulted to lan)', () => {
    resetPrimaryChannelForTest('lan');
    onHistoryItem({ item: item('unstamped') });
    expect(state.recent).toEqual([]);
  });

  // The 'history:list-result from the wrong channel' case is GONE with the seed pull
  // (0.2.27): the server stores no transcripts, so the strip has no snapshot to merge.
  // The channel sieve it exercised is still covered by the two upsert cases above and
  // the three delete cases below — one function, `acceptRecentChannel`, asserted alone
  // at the top of this block.

  it('primary flip clears the strip (rows belong to a different server)', () => {
    setDirectoryFetcher(async () => []);
    resetPrimaryChannelForTest('lan');
    onHistoryItem({ item: item('lan-1'), channel: 'lan' });
    expect(state.recent).toHaveLength(1);
    onConnection({
      connected: true,
      registered: true,
      room_uuid: 'r',
      mobiles: 1,
      primary: true,
      channel: 'cloud',
      reason: 'ok',
    });
    expect(primaryChannelForTest()).toBe('cloud');
    expect(state.recent).toEqual([]);
  });

  // RV-新B — the capsule's ONE answer to "which channel is current".
  it('state.channel is the CONNECTION frame’s tag, and drives the label + endpoint row', () => {
    resetPrimaryChannelForTest('lan');
    const frame = (channel: string, primary: boolean): unknown => ({
      connected: true, registered: true, room_uuid: 'r', mobiles: 1, primary, channel, reason: 'ok',
    });
    onConnection(frame('cloud', true));
    // The diag "current channel" label, deriveConnDot's channel input and the endpoint row all
    // read this field; before RV-新B they read `state.cloud.channel`, which came from a
    // Rust flag with no writer and was therefore 'lan' for every user, forever.
    expect(state.channel).toBe('cloud');
    // THE REVERSE ASSERTION: the presence channel's frame is gated out and must not
    // relabel the capsule (a stale LAN frame carrying mobiles>0 is exactly the shape
    // that once floated the HUD for a PC with no phone).
    onConnection(frame('lan', false));
    expect(state.channel).toBe('cloud');
  });

  // X3 ②: a row that is GONE must leave the strip; a wrong/absent stamp must not touch
  // it. 0.2.27 — the same handler now serves TWO sources and the second one is the only
  // live one: `history:deleted` (peer delete, no producer any more) and the main
  // window's own `flowmic://ui-timeline-row-gone`. Both deliver `{id, channel}`, which
  // is why one handler is honest here rather than two — see the handler's doc for why
  // the local case was ALWAYS uncovered (a room broadcast excludes the emitter, and
  // both windows share one socket).
  it('a row reported gone with a matching stamp leaves the strip', () => {
    resetPrimaryChannelForTest('lan');
    onHistoryItem({ item: item('keep'), channel: 'lan' });
    onHistoryItem({ item: item('gone'), channel: 'lan' });
    expect(state.recent.map((r) => r.id).sort()).toEqual(['gone', 'keep']);
    onHistoryDeleted({ id: 'gone', channel: 'lan' });
    expect(state.recent.map((r) => r.id)).toEqual(['keep']);
  });

  it('a wrong channel stamp leaves the strip untouched', () => {
    resetPrimaryChannelForTest('lan');
    onHistoryItem({ item: item('stay'), channel: 'lan' });
    onHistoryDeleted({ id: 'stay', channel: 'cloud' });
    expect(state.recent.map((r) => r.id)).toEqual(['stay']);
  });

  it('NO channel stamp leaves the strip untouched', () => {
    resetPrimaryChannelForTest('lan');
    onHistoryItem({ item: item('stay'), channel: 'lan' });
    onHistoryDeleted({ id: 'stay' });
    expect(state.recent.map((r) => r.id)).toEqual(['stay']);
  });

  it('a LOCAL delete in the main window drops the strip line (0.2.27)', () => {
    // The case X3's fix never actually covered: the server excludes the emitter from a
    // room broadcast and both windows share one socket, so a delete made in the main
    // window never came back here — the HUD kept showing a record the user had just
    // destroyed. Since 0.2.27 a local delete is the ONLY kind, so that latent gap would
    // have become every case; the main window emits the row's address instead
    // (lib/bridge.ts notifyRowRemoved) and it lands on this same handler, same sieve.
    resetPrimaryChannelForTest('lan');
    onHistoryItem({ item: item('deleted-on-the-pc'), channel: 'lan' });
    expect(state.recent).toHaveLength(1);
    onHistoryDeleted({ id: 'deleted-on-the-pc', channel: 'lan' });
    expect(state.recent).toEqual([]);
  });
});

// ── 卡 F1 —— the phone switches to background, the computer treats it as "paused", not "left" ──────────────────────
// owner ruling ①: "the computer should consider the phone 'paused' (still paired, just with the capsule collapsed)".
//
// 🔴 These assertions ARE the ruling. Collapsing the capsule is the easy half and
// any wrong implementation gets it right too — `onConnection(false, …)` collapses
// it as well. What separates "paused" from "the phone left" is everything that must NOT move:
// presence (which is what makes the device page say "no phone currently connected" and arms the
// reconnect logic), the room/channel identity, the strip, and the SPEAKING latch.
// So each test below pairs the visible effect with the untouched state, and the
// negative half carries its own positive control (the pause DID do something).
describe('卡 F1 — a phone pause collapses the capsule and touches nothing else', () => {
  const paired = () => ({
    connected: true,
    registered: true,
    room_uuid: 'room-1',
    mobiles: 1,
    primary: true,
    channel: 'lan',
  });

  it('pause retreats the capsule while pairing / room / presence stay put', () => {
    onConnection(paired());
    expect(capsuleVisibleForTest()).toBe(true); // positive control: it WAS up
    state.recent = [];
    onHistoryItem({
      item: {
        id: 'row-1',
        mode: 'realtime',
        output_text: 'hello',
        created_at: '2026-08-04T10:00:00.000Z',
      },
      channel: 'lan',
    });
    expect(state.recent).toHaveLength(1);

    firePhonePausedForTest({ reason: 'background' });

    expect(capsuleVisibleForTest()).toBe(false); // capsule collapsed
    // 🔴 …and NOTHING that says "this phone is still here" moved:
    expect(state.phonePresent).toBe(true);
    expect(state.mobiles).toBe(1);
    expect(state.connected).toBe(true);
    expect(state.registered).toBe(true);
    expect(state.channel).toBe('lan');
    expect(state.recent).toHaveLength(1); // collapsing is not forgetting
  });

  it('resume brings it back, still on the same pairing', () => {
    onConnection(paired());
    firePhonePausedForTest({ reason: 'background' });
    expect(capsuleVisibleForTest()).toBe(false);

    firePhoneResumedForTest();

    expect(capsuleVisibleForTest()).toBe(true);
    expect(state.phonePresent).toBe(true);
    expect(state.mobiles).toBe(1);
  });

  it('presence ticks during the pause keep the capsule down (no flicker)', () => {
    onConnection(paired());
    firePhonePausedForTest({ reason: 'background' });
    onConnection(paired()); // the 10s presence poll, twice
    onConnection(paired());
    expect(capsuleVisibleForTest()).toBe(false);
    expect(state.phonePresent).toBe(true);
    firePhoneResumedForTest();
    expect(capsuleVisibleForTest()).toBe(true);
  });

  it('a pause mid-utterance does not release the SPEAKING latch', () => {
    // The utterance is paused, not cancelled: the phone still owns the window it
    // locked at audio:start, and audio:resume continues the same utterance.
    onConnection(paired());
    state.locked = true;
    firePhonePausedForTest({ reason: 'background' });
    expect(state.locked).toBe(true);
  });

  it('🔴 the latch-watchdog clear releases the × gate, not only the morph', () => {
    // WP8-acceptance, owner hit it live: an utterance that ends WITHOUT an
    // inject:result (silence-empty, swipe-cancel, manual fold, record-only)
    // starves the watchdog — and the force-clear must release BOTH holders of
    // the speaking fact. Before the fix it cleared the morph half only, so the
    // × stayed grey until the phone left the room.
    onConnection(paired());
    fireAudioStartForTest();
    expect(speakingForTest()).toBe(true); // × gated — genuinely speaking
    fireLatchStarvedForTest(); // 6s signal starvation (the watchdog's verdict)
    expect(speakingForTest()).toBe(false); // ⇒ the × is live again
    dismiss(); // …and actually works: dismiss must not be REFUSED
    expect(capsuleVisibleForTest()).toBe(false);
  });
});
