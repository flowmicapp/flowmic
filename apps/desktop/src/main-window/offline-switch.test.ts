// P7 (0.3.1, owner 2026-08-15) — the manual offline switch's WIRING pins.
//
// Why source-literal probes rather than a render: OfflineSwitch reads the real
// store (which constructs SettingsClient/TimelineStore over the Tauri bridge)
// and its state arrives via onMounted-era pulls SSR never runs — the same
// reasoning devices-info-panel.test.ts records for the page itself. What is
// worth pinning here is the wiring that a green build cannot otherwise prove:
//   ① the event name is ONE string on both sides of the language boundary
//     (bridge.rs is the producer, bridge.ts the consumer — a one-character
//     drift is a listener that never fires and no compiler on either side
//     notices);
//   ② both entrances exist (the page mounts the switch; the tray builds the
//     toggle item) and both go through the same Rust write path;
//   ③ the teardown speaks for itself (the pump-freeze trap: TRAY_STATE and the
//     store rows are repainted BY the offline path, because dropping the
//     sockets kills their normal producer).
// The behaviour itself (drop both, refuse dials, phones see the PC offline) is
// verified on the real machine in the 0.3.1 close-out — a fake AppHandle here
// would be measuring a harness, not the product.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CH } from '../lib/bridge';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const RUST_BRIDGE = read('../../src-tauri/src/socket/bridge.rs');
const RUST_OFFLINE = read('../../src-tauri/src/shell/offline.rs');
const RUST_TRAY = read('../../src-tauri/src/shell/tray.rs');
const RUST_SESSION = read('../../src-tauri/src/shell/channel_session.rs');
const PAGE = read('./DevicesPage.vue');
const SWITCH = read('./components/OfflineSwitch.vue');
const STORE = read('./store.ts');

describe('P7 · offline switch wiring', () => {
  it('① the OFFLINE_STATE channel is byte-identical in bridge.rs and bridge.ts', () => {
    const m = /OFFLINE_STATE:\s*&str\s*=\s*"([^"]+)"/.exec(RUST_BRIDGE);
    expect(m, 'bridge.rs must declare OFFLINE_STATE').not.toBeNull();
    expect(CH.offlineState).toBe(m![1]);
  });

  it('② both entrances exist and share the single write path', () => {
    // Devices page mounts the switch in its header span.
    expect(PAGE).toMatch(/<OfflineSwitch\s*\/>/);
    expect(PAGE).toMatch(/import OfflineSwitch from '\.\/components\/OfflineSwitch\.vue'/);
    // The switch invokes the command wrapper, renders the store fact (never
    // its own click intention), and carries the hint for both title and AT.
    expect(SWITCH).toContain('setOfflineMode');
    expect(SWITCH).toContain(':checked="offlineMode"');
    expect(SWITCH).toContain('S.dev_offline_hint');
    // Tray: the toggle item exists and clicks through shell::offline::apply —
    // the same body the offline_set command calls.
    expect(RUST_TRAY).toContain('"offline_toggle"');
    expect(RUST_TRAY).toContain('offline::apply(app, enable)');
    expect(RUST_OFFLINE).toMatch(/pub fn offline_set[\s\S]*?apply\(&app, enable\)/);
  });

  it('③ the teardown speaks for itself (the pump dies with the sockets)', () => {
    // Rust: going offline drops BOTH slots, then emits its own TRAY_STATE and
    // clears the change-only memo so the post-online repaint cannot be
    // swallowed by 「tooltip unchanged」.
    expect(RUST_OFFLINE).toContain('set_socket(app, Channel::Lan, None)');
    expect(RUST_OFFLINE).toContain('set_socket(app, Channel::Cloud, None)');
    expect(RUST_OFFLINE).toMatch(/tray_showing_reset\(\)/);
    expect(RUST_OFFLINE).toContain('channel::TRAY_STATE');
    // Store: the OFFLINE_STATE handler rewrites the frozen rows to
    // disconnected — without this the chips keep their last connected words.
    expect(STORE).toContain("reason: 'manual-offline'");
    // Rust: every dial funnels through connect_on_main, and the gate lives
    // exactly there (gating any single caller would miss the other three).
    expect(RUST_SESSION).toMatch(/connect_on_main[\s\S]{0,600}is_offline\(\)/);
  });

  // ── P7b (owner 2026-08-15: 「做成胶囊形状的开关」) ──────────────────────────
  // The checkbox became a capsule switch. Two things about that are load-bearing
  // rather than cosmetic, and neither is provable by a green build.
  describe('P7b · the capsule skin did not cost the control anything', () => {
    it('🔴 the knob follows the STORE, never the click — no `:checked` styling hook', () => {
      // The component's own rule since P7: 「the rendered state is ALWAYS the
      // store's offlineMode … the control never renders the click's intention」.
      // A skin is exactly how that gets broken by accident — `input:checked +
      // .track` is the CSS everyone reaches for first, and it paints the ON
      // state from the DOM's optimistic checked flag the instant the user
      // clicks, before Rust has agreed. The class hook must come from the
      // store binding.
      expect(SWITCH).toMatch(/:class="\{\s*on:\s*offlineMode/);
      const css = SWITCH.slice(SWITCH.indexOf('<style'));
      expect(
        css,
        'the ON fill must not be driven by :checked — that renders intention, not fact',
      ).not.toMatch(/:checked\s*[+~]?\s*[^{]*\.(track|knob)/);
    });

    it('🔴 the real <input> is still there, and hidden the way that KEEPS the keyboard', () => {
      // A <div role="switch"> would have to re-implement Space/Enter, the
      // checked announcement and the label association. And `display:none` /
      // `visibility:hidden` remove the input from the focus order, which is the
      // same loss wearing a different hat.
      expect(SWITCH).toMatch(/<input[\s\S]{0,200}type="checkbox"/);
      const css = SWITCH.slice(SWITCH.indexOf('<style'));
      const srBlock = /\.sr\s*\{([^}]*)\}/.exec(css);
      expect(srBlock, '.sr (the visually-hidden rule) must exist').not.toBeNull();
      expect(srBlock![1]).not.toMatch(/display:\s*none|visibility:\s*hidden/);
      // …and the focus ring has to land on what the user actually sees.
      expect(css).toMatch(/\.sr:focus-visible\s*\+\s*\.track/);
    });
  });

  it('the flag is session-scoped: no persistence write anywhere in offline.rs', () => {
    // NOT persisted is a design decision (a PC silently offline across a
    // restart is a support black hole) — pin its implementation: the module
    // must not touch disk or any settings store. Comments are blanked first —
    // the prose above the code SAYS 「not persisted」, and a probe that can
    // read prose fails against correct code (the devices-info-panel lesson,
    // third red in one round).
    const code = RUST_OFFLINE.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/std::fs|File::|\.save\(|Credentials|persist/);
  });
});
