// Card PAIR-SUCCESS (owner 2026-08-25, §3-4) — the PC half: when the QR modal
// may close on a NEW phone, the ~1 s success face, and the row flash that ends
// by itself.
//
// 【rendered-result】 the success face and the flashed row are asserted on
// renderToString output, in every locale, with positive controls.
//
// 🔴 TWO MANDATORY REVERSE CONTROLS, both seen red (recorded in the commit):
//   · 「an already-paired phone reconnecting must not close the QR」 — with
//     `detectPairingSuccess` swapped to a count-only criterion (the tempting
//     one), the second-channel row of an ALREADY-PAIRED device (same
//     device_uid, +1 row) reads as success:
//       AssertionError: expected true to be false
//     and the plain reconnect (same rows, online flipping) stays green under
//     both — which is exactly why the count is the wrong ruler: it cannot tell
//     the two cases apart and the second one closes the QR while the user is
//     still holding a NEW phone up to it.
//   · the flash ENDS on its own — asserted with fake timers, not eyeballed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import PairingModal from './components/PairingModal.vue';
import PairedList from './components/PairedList.vue';
import { S_BY_LOCALE, UI_LOCALES, setLocale, type UiLocale } from '../lib/strings';
import { EMPTY_CLOUD_STATUS } from '../lib/channel';
import type { PairingInfo } from '../lib/pairing';
import type { PairedMobile, PairedPresenceView } from '../lib/paired-mobiles';
import { detectPairingSuccess, rowKeyOf, snapshotPairing } from '../lib/pairing-success';
import { PAIR_FLASH_MS, PAIR_SUCCESS_HOLD_MS, usePairingSuccess } from './use-pairing-success';

function phone(over: Partial<PairedMobile> = {}): PairedMobile {
  return {
    pairing_id: 'p-a',
    mobile_name: 'Pixel',
    paired_at: '2026-08-25T10:00:00.000Z',
    last_seen_at: null,
    online: false,
    channel: 'lan',
    device_uid: 'uid-a',
    ...over,
  };
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

describe('the criterion: an identity diff, never a count', () => {
  const armed = snapshotPairing([phone({ pairing_id: 'p-a', device_uid: 'uid-a' })]);

  it('a NEW device_uid ⇒ matched, criterion uid, the new row named', () => {
    const v = detectPairingSuccess(armed, [
      phone({ pairing_id: 'p-a', device_uid: 'uid-a' }),
      phone({ pairing_id: 'p-b', device_uid: 'uid-b', channel: 'cloud' }),
    ]);
    expect(v).toEqual({ matched: true, criterion: 'uid', newKeys: ['cloud:p-b'] });
  });

  it('🔴 an already-paired phone RECONNECTING (same rows, online flips) ⇒ not matched', () => {
    const v = detectPairingSuccess(armed, [phone({ pairing_id: 'p-a', device_uid: 'uid-a', online: true })]);
    expect(v.matched).toBe(false);
  });

  it('🔴 an already-paired phone gaining a SECOND-CHANNEL row (same device_uid, +1 row) ⇒ not matched — a count would close the QR here', () => {
    const v = detectPairingSuccess(armed, [
      phone({ pairing_id: 'p-a', device_uid: 'uid-a' }),
      phone({ pairing_id: 'p-a2', device_uid: 'uid-a', channel: 'cloud' }),
    ]);
    expect(v.matched).toBe(false);
  });

  it('covers scanning, typing the code and manual entry alike — the criterion does not know how the row arrived', () => {
    // Nothing in the snapshot or the verdict carries a "how"; two rows that
    // differ only in pairing_id/channel are judged identically by identity.
    const byScan = detectPairingSuccess(armed, [phone(), phone({ pairing_id: 'scan', device_uid: 'uid-new' })]);
    const byCode = detectPairingSuccess(armed, [phone(), phone({ pairing_id: 'typed', device_uid: 'uid-new', channel: 'cloud' })]);
    expect(byScan.matched && byCode.matched).toBe(true);
  });

  it('null device_uid anywhere ⇒ the COUNT decides and the criterion SAYS so', () => {
    const armedNull = snapshotPairing([phone({ device_uid: null })]);
    expect(armedNull.uids).toBeNull();
    const v = detectPairingSuccess(armedNull, [phone({ device_uid: null }), phone({ pairing_id: 'p-b', device_uid: 'uid-b' })]);
    expect(v).toEqual({ matched: true, criterion: 'count', newKeys: ['lan:p-b'] });
    // …and a same-count reconnect under the fallback is still NOT a success.
    expect(detectPairingSuccess(armedNull, [phone({ device_uid: null, online: true })]).matched).toBe(false);
    // A null arriving on the AFTER side alone also drops to the count.
    const v2 = detectPairingSuccess(armed, [phone(), phone({ pairing_id: 'old-phone', device_uid: null })]);
    expect(v2).toEqual({ matched: true, criterion: 'count', newKeys: ['lan:old-phone'] });
  });

  it('a failed / pending read is never a success, and arming on one snapshots EMPTY', () => {
    expect(detectPairingSuccess(armed, null).matched).toBe(false);
    expect(detectPairingSuccess(armed, undefined).matched).toBe(false);
    const armedOnNothing = snapshotPairing(null);
    expect(armedOnNothing.count).toBe(0);
    expect(armedOnNothing.uids).toBeNull();
  });

  it('rowKeyOf matches PairedList\'s row key', () => {
    expect(rowKeyOf(phone({ channel: 'cloud', pairing_id: 'x' }))).toBe('cloud:x');
  });
});

describe('the composable: success face → close → flash that ends by itself', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * 🔴 ACCEPTANCE REGRESSION (2026-08-25, measured before the fix).
   *
   * The QR can open before the paired list has been read: `pairedView` is
   * `undefined` while the first read is in flight and `null` when a read
   * FAILED — DevicesPage assigns that verbatim, deliberately, so a failure is
   * never rendered as "no paired phones". Arming on either froze
   * `{keys: ∅, uids: null, count: 0}`, and a null uid forces the COUNT ruler,
   * so the next successful read answered `matched: true, criterion: 'count'`
   * for a phone that had been paired the whole time — closing the QR and
   * flashing a row while the user was still holding a phone up to it.
   *
   * Measured verdict before the fix, through the pure layer:
   *   `detectPairingSuccess(snapshotPairing(null), [alreadyPairedPhone])`
   *   → { matched: true, criterion: 'count' }
   *
   * ⚠️ The pure function still answers that, and that is correct — it is asked
   * "did this list grow", and against an empty baseline it did. The policy
   * about WHAT MAY BE USED AS A BASELINE belongs to the composable, which is
   * where it now lives.
   */
  it('🔴 a list that could not be read at arming time never counts as a pairing', () => {
    for (const unread of [null, undefined] as const) {
      const close = vi.fn();
      const forensic = vi.fn();
      const ps = usePairingSuccess({ close, forensic });
      ps.arm(unread);

      // The first list we can actually see is the BASELINE, not a success.
      ps.observe([phone()]);
      expect(ps.success.value, `armed on ${String(unread)}`).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(forensic).not.toHaveBeenCalled();

      // …and the feature still works from that baseline: a genuinely new
      // device is caught, by identity. (Positive control — without it this
      // test would also pass on a composable that never fires at all.)
      ps.observe([phone(), phone({ pairing_id: 'p-b', device_uid: 'uid-b' })]);
      expect(ps.success.value).toBe(true);
      expect(forensic.mock.calls[0]?.[0]).toContain('criterion=uid');
      ps.dispose();
    }
  });

  it('arms on open, shows success for the hold, closes, flashes the new row, and the flash ENDS', () => {
    const close = vi.fn();
    const forensic = vi.fn();
    const ps = usePairingSuccess({ close, forensic });
    ps.arm([phone()]);
    ps.observe([phone(), phone({ pairing_id: 'p-b', device_uid: 'uid-b' })]);
    expect(ps.success.value).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(forensic).toHaveBeenCalledTimes(1);
    expect(forensic.mock.calls[0]?.[0]).toContain('criterion=uid');
    expect(forensic.mock.calls[0]?.[0]).toContain('lan:p-b');

    vi.advanceTimersByTime(PAIR_SUCCESS_HOLD_MS);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ps.success.value).toBe(false);
    expect(ps.flashKey.value).toBe('lan:p-b');

    // 🔴 It ends without anyone touching it.
    vi.advanceTimersByTime(PAIR_FLASH_MS);
    expect(ps.flashKey.value).toBeNull();
    ps.dispose();
  });

  it('🔴 an already-paired phone reconnecting while the QR is open does NOT close it', () => {
    const close = vi.fn();
    const ps = usePairingSuccess({ close, forensic: vi.fn() });
    ps.arm([phone({ online: false })]);
    ps.observe([phone({ online: true })]);
    ps.observe([phone({ online: true }), phone({ pairing_id: 'p-a2', device_uid: 'uid-a', channel: 'cloud' })]);
    vi.advanceTimersByTime(PAIR_SUCCESS_HOLD_MS + PAIR_FLASH_MS);
    expect(ps.success.value).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(ps.flashKey.value).toBeNull();
    ps.dispose();
  });

  it('the count fallback is written to the forensic line', () => {
    const forensic = vi.fn();
    const ps = usePairingSuccess({ close: vi.fn(), forensic });
    ps.arm([phone({ device_uid: null })]);
    ps.observe([phone({ device_uid: null }), phone({ pairing_id: 'p-b', device_uid: 'uid-b' })]);
    expect(forensic.mock.calls[0]?.[0]).toContain('criterion=count');
    ps.dispose();
  });

  it('one detection per arming; a disarm (✕) means nothing fires later', () => {
    const close = vi.fn();
    const ps = usePairingSuccess({ close, forensic: vi.fn() });
    ps.arm([]);
    ps.disarm();
    ps.observe([phone()]);
    vi.advanceTimersByTime(PAIR_SUCCESS_HOLD_MS);
    expect(close).not.toHaveBeenCalled();
    ps.arm([]);
    ps.observe([phone()]);
    ps.observe([phone(), phone({ pairing_id: 'p-b', device_uid: 'uid-b' })]); // a second read while the face is up
    vi.advanceTimersByTime(PAIR_SUCCESS_HOLD_MS);
    expect(close).toHaveBeenCalledTimes(1);
    ps.dispose();
  });
});

// ── the presence-event criterion (2026-08-26, owner: a RE-pair counts) ──────
//
// Re-pairing a handset that is already in the list moves neither identity
// ruler: same device_uid, same count. The only thing that moves is the shell's
// JOIN counter (reconcile.rs `join_epoch`, summed by joinEpochSum) — so that
// counter, passed to arm()/observe(), is the third criterion.
//
// 🔴 MANDATORY REVERSE CONTROL, seen red (recorded in the commit): with the
// comparison flipped from `>` to `!==` — the tempting 「it changed」 — the
// decrease test below fails with `expected true to be false`: a counter that
// went DOWN (a channel row leaving the map, a shell restart) closed the QR
// claiming a pairing that never happened. `>` fails toward a modal that stays
// open, which the user can close by hand — the old behaviour.
describe('the presence-event criterion: a JOIN while the QR is open', () => {
  const rows = [phone({ pairing_id: 'p-a', device_uid: 'uid-a', online: true })];
  const armed = snapshotPairing(rows);

  it('🔴 a RE-pair (same rows, join counter moved) ⇒ matched, and the one online row flashes', () => {
    const v = detectPairingSuccess(armed, rows, true);
    expect(v).toEqual({ matched: true, criterion: 'presence-event', newKeys: ['lan:p-a'] });
  });

  it('several phones online ⇒ still matched, but no flash — naming one would be a guess', () => {
    const many = [
      phone({ pairing_id: 'p-a', device_uid: 'uid-a', online: true }),
      phone({ pairing_id: 'p-b', device_uid: 'uid-b', online: true }),
    ];
    const v = detectPairingSuccess(snapshotPairing(many), many, true);
    expect(v).toEqual({ matched: true, criterion: 'presence-event', newKeys: [] });
  });

  it('identity still wins when it CAN answer — the new row is named, not guessed', () => {
    const v = detectPairingSuccess(armed, [...rows, phone({ pairing_id: 'p-b', device_uid: 'uid-b' })], true);
    expect(v.matched && v.criterion === 'uid').toBe(true);
  });

  it('the composable fires on a join-counter INCREASE since arming, and says which ruler', () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const forensic = vi.fn();
    const ps = usePairingSuccess({ close, forensic });
    ps.arm(rows, 5);
    ps.observe(rows, 5); // nothing happened yet — same counter, same rows
    expect(ps.success.value).toBe(false);
    ps.observe(rows, 6); // the phone re-joined while the QR was up
    expect(ps.success.value).toBe(true);
    expect(forensic.mock.calls[0]?.[0]).toContain('criterion=presence-event');
    vi.advanceTimersByTime(PAIR_SUCCESS_HOLD_MS);
    expect(close).toHaveBeenCalledTimes(1);
    ps.dispose();
    vi.useRealTimers();
  });

  it('🔴 a DECREASE never fires — a departure or reset is not a pairing', () => {
    // The measured false positive this whole criterion split exists to prevent:
    // the sum can go down without any phone doing anything, and `presence_epoch`
    // (which also counts leaves) must never be what feeds this. joinEpochSum's
    // own tests pin the leave half; this pins the comparison direction.
    const close = vi.fn();
    const ps = usePairingSuccess({ close, forensic: vi.fn() });
    ps.arm(rows, 5);
    ps.observe(rows, 4);
    expect(ps.success.value).toBe(false);
    expect(close).not.toHaveBeenCalled();
    ps.dispose();
  });

  it('an older shell (no counter at all) degrades to the identity rulers', () => {
    const close = vi.fn();
    const ps = usePairingSuccess({ close, forensic: vi.fn() });
    ps.arm(rows); // no epoch observed at arming
    ps.observe(rows, 7); // …so a later number has no baseline and means nothing
    expect(ps.success.value).toBe(false);
    ps.dispose();
  });
});

describe('【rendered-result】 the two faces', () => {
  const info: PairingInfo = {
    short_code: '1234',
    endpoint: 'http://192.168.1.5:41879',
    pc_name: 'DESKTOP-MAIN',
    connected: true,
    mobiles: 0,
    channel: 'lan',
    expires_in_ms: null,
  };

  async function modal(loc: UiLocale, success: boolean): Promise<string> {
    setLocale(loc);
    const html = await renderToString(
      createSSRApp({ render: () => h(PairingModal, { open: true, info, channel: 'lan', cloud: { ...EMPTY_CLOUD_STATUS }, success }) }),
    );
    setLocale('zh-CN');
    return html;
  }

  it('success:true ⇒ the success sentence replaces the QR, in every locale; success:false ⇒ the normal modal', async () => {
    for (const loc of UI_LOCALES) {
      const on = await modal(loc, true);
      expect(on, `${loc}: no success face`).toContain('data-testid="pair-success"');
      expect(on, `${loc}: sentence missing`).toContain(esc(S_BY_LOCALE[loc].pair_success));
      expect(on, `${loc}: the QR/manual body must give way`).not.toContain(esc(S_BY_LOCALE[loc].pair_close));
      const off = await modal(loc, false);
      expect(off).not.toContain('data-testid="pair-success"');
      expect(off, `${loc}: positive control`).toContain(esc(S_BY_LOCALE[loc].pair_title));
    }
  });

  it('the just-paired row wears the flash class, and only that row', async () => {
    const view: PairedPresenceView = {
      rows: [
        { ...phone({ pairing_id: 'p-a' }), presence: 'online', asOf: null },
        { ...phone({ pairing_id: 'p-b', device_uid: 'uid-b' }), presence: 'online', asOf: null },
      ],
      unlisted: [],
    };
    setLocale('en');
    const html = await renderToString(
      createSSRApp({ render: () => h(PairedList, { view, reload: async () => {}, flashKey: 'lan:p-b' }) }),
    );
    expect((html.match(/just-paired/g) ?? []).length).toBe(1);
    const none = await renderToString(
      createSSRApp({ render: () => h(PairedList, { view, reload: async () => {}, flashKey: null }) }),
    );
    expect(none).not.toContain('just-paired');
    expect(none).toContain('paired-row'); // positive control
  });
});
