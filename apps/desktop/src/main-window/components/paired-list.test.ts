// C-8 (owner 2026-08-01 unified channel visual identity, closing round): PairedList.vue used to draw its
// own `.chip.chan-lan/.chan-cloud` pair aliasing the generic teal/brand tokens —
// a SECOND definition of the channel colours that happened to render identically
// to CHANNEL_VISUAL today (both --teal-ink and --channel-lan-ink are #0f766e) but
// could silently drift the moment either token file's OWNER retuned the generic
// role for an unrelated reason. This file proves the row now goes through the ONE
// definition (lib/channel.ts's CHANNEL_VISUAL + tokens.css's `.chan-badge.<css>`).
//
// Render path: same as pairing-modal.test.ts — vitest's default SSR transform
// compiles the SFC into its SSR form, so `vue/server-renderer`'s renderToString is
// the matching runtime. PairedList.vue takes its whole state as the `view` prop
// (no onMounted fetch of its own — the parent fetches), so SSR renders the real
// row markup, not an empty pre-fetch placeholder.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import PairedList from './PairedList.vue';
import { S, setLocale } from '../../lib/strings';

beforeEach(() => {
  setLocale('zh-CN');
});
import type { PairedPresenceView, PresenceMobile } from '../../lib/paired-mobiles';

const LAN_ROW: PresenceMobile = {
  pairing_id: 'p-lan-1',
  mobile_name: 'LAN 手机',
  paired_at: '2026-08-01T09:00:00.000Z',
  last_seen_at: '2026-08-01T09:05:00.000Z',
  online: true,
  channel: 'lan',
  device_uid: 'uid-lan',
  presence: 'online',
  asOf: null,
};

const VIEW: PairedPresenceView = {
  rows: [
    LAN_ROW,
    {
      ...LAN_ROW,
      pairing_id: 'p-cloud-1',
      mobile_name: '云端手机',
      channel: 'cloud',
      device_uid: 'uid-cloud',
    },
  ],
  unlisted: [],
};

function render(): Promise<string> {
  return renderToString(
    createSSRApp(PairedList, { view: VIEW, reload: () => Promise.resolve() }),
  );
}

describe('PairedList channel badge (C-8, one definition)', () => {
  it('renders a `.chan-badge` per row, classed by channel — a REAL positive probe', async () => {
    const html = await render();
    // Positive probe first: if this is empty the negative assertions below prove
    // nothing (a blind probe reading「zero」could just as well be a broken render).
    // Vue's SSR renderer puts the :class binding BEFORE the static class attr.
    expect(html).toContain('class="lan chan-badge"');
    expect(html).toContain('class="cloud chan-badge"');
  });

  it('the two rows carry REAL different icon shapes, not the same glyph twice', async () => {
    const html = await render();
    // CHANNEL_VISUAL.lan has one <circle>, CHANNEL_VISUAL.cloud has none — same
    // vocabulary check channel.test.ts runs on the source object, here proven on
    // what actually lands in the DOM string for this component.
    const lanBadge = html.match(/class="lan chan-badge"[\s\S]*?<\/span>/)?.[0] ?? '';
    const cloudBadge = html.match(/class="cloud chan-badge"[\s\S]*?<\/span>/)?.[0] ?? '';
    expect(lanBadge).not.toBe('');
    expect(cloudBadge).not.toBe('');
    expect(lanBadge).toContain('<circle');
    expect(cloudBadge).not.toContain('<circle');
    expect(lanBadge).not.toBe(cloudBadge);
  });

  it('never draws the retired private chip classes or a channel-identity hex literal', async () => {
    const html = await render();
    expect(html).not.toContain('class="chan-lan"');
    expect(html).not.toContain('class="chan-cloud"');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

// 🔴 Reverse control (verified manually once then reverted, see the delivery
// report): change the lan row's `channel` in render() above to 'cloud' (both
// rows become cloud badges) → the second test, "REAL different icon shapes,"
// goes red (lanBadge has no <circle>); reverting it restores green. The same
// technique also proves the positive probe is not blind — the probe itself
// fails under this change by going from "found two different badges" to
// "both badges are identical," not because it cannot read the content.

// ── owner 2026-08-02 UI batch 1 ②: "offline" and "last active: just now" appear side by side ──────────────
//
// Review conclusion (the field-by-field definitions are in PairedList.vue's
// lastSeenTitle()): both values are true, and they answer two different
// questions. So the fix is not to change the judgement criteria — that would
// make it lie — but to let this row say which question it is answering.
// What this test guards is exactly that sentence actually being present in
// the DOM, because an explanation that only lives in a comment is invisible
// to the user.
describe('the row says WHICH question each status answers (owner ②)', () => {
  it('both cells carry their definitional tooltip', async () => {
    const html = await render();
    // The chip's question: "right now."
    expect(html).toContain(S.dev_paired_online_tip);
    // "last active"'s question: "last time" — and it is marked as explained (dotted underline),
    // otherwise only someone who happens to hover ever reads it.
    expect(html).toContain(S.dev_paired_last_seen_tip);
    expect(html).toContain('class="pm-seen"');
  });

  it('🔴 "offline + just now" really renders, and is NOT smoothed over', async () => {
    // The exact combination from owner's screenshot: no session right now, contacted
    // moments ago. It is a legitimate state (a phone whose reconnect keeps being
    // refused stamps last_seen_at on every attempt without ever joining the room), so
    // the row must show BOTH facts — inventing a third state, or suppressing one of
    // them, would be this repo's #1 bug shape wearing a bandage.
    const now = new Date().toISOString();
    const html = await renderToString(
      createSSRApp(PairedList, {
        view: {
          rows: [{ ...LAN_ROW, online: false, presence: 'offline', last_seen_at: now }],
          unlisted: [],
        } satisfies PairedPresenceView,
        reload: () => Promise.resolve(),
      }),
    );
    expect(html).toContain(S.dev_paired_offline);
    expect(html).toContain(S.dev_time_just_now);
    // Positive control: the online wording is genuinely absent here rather than the probe
    // being blind — the default VIEW above renders it.
    expect(await render()).toContain(S.dev_paired_online);
  });
});

// ── 2026-08-02 rework (mockup §2): unknown ≠ error ────────────────────────────────────
describe('an unreachable channel renders as "state unknown", never as an error or a vanished row', () => {
  const UNKNOWN_VIEW: PairedPresenceView = {
    rows: [
      LAN_ROW,
      {
        ...LAN_ROW,
        pairing_id: 'p-cloud-1',
        channel: 'cloud',
        online: false,
        presence: 'unknown',
        asOf: '2026-08-02T06:32:00.000Z',
      },
    ],
    unlisted: [],
  };

  function renderUnknown(): Promise<string> {
    return renderToString(createSSRApp(PairedList, { view: UNKNOWN_VIEW, reload: () => Promise.resolve() }));
  }

  it('🔴 the cached row STAYS on screen with a neutral chip (a row disappearing would read to the user as "the pairing is lost")', async () => {
    const html = await renderUnknown();
    expect(html).toContain(S.dev_paired_unknown);
    expect(html).toContain('unk-chip');
    // Positive control: the live row still says online, so the probe is not blind.
    expect(html).toContain(S.dev_paired_online);
  });

  it('🔴 the unknown chip is NOT the error style, and the old red banner is gone from the catalogue', async () => {
    const html = await renderUnknown();
    expect(html).not.toContain('chan-loud');
    // A string with zero producers follows its producer (the INJECT_NO_RECEIPT
    // precedent): the internal-reasoning sentence owner's screenshot caught no
    // longer exists in ANY language.
    expect(Object.keys(S)).not.toContain('dev_paired_channel_unreachable');
  });

  it('the unknown tooltip quotes WHEN the cached shape was true ("as of what time")', async () => {
    const html = await renderUnknown();
    expect(html).toContain(S.dev_paired_unknown_tip.split('{t}')[0]!.slice(0, 12));
    expect(html).toContain('2026-08-02');
  });

  it('unpair on an unknown row is disabled WITH the reason (a guaranteed failure is not a button)', async () => {
    const html = await renderUnknown();
    expect(html).toContain(S.dev_revoke_unreachable);
    // Positive control: the live LAN row's revoke is not disabled — exactly one disabled
    // revoke in this render.
    const disabledRevokes = html.match(new RegExp(S.dev_revoke_unreachable, 'g')) ?? [];
    expect(disabledRevokes).toHaveLength(1);
  });

  it('an unreachable channel with NOTHING cached gets the one quiet line, not red', async () => {
    const html = await renderToString(
      createSSRApp(PairedList, {
        view: { rows: [LAN_ROW], unlisted: ['cloud'] } satisfies PairedPresenceView,
        reload: () => Promise.resolve(),
      }),
    );
    expect(html).toContain('chan-note');
    expect(html).not.toContain('chan-loud');
    expect(html).toContain(S.dev_paired_unlisted.split('{ch}')[1]!.slice(0, 8));
  });
});

// ── owner 2026-08-02 screenshot: "there's a stray dot in front of the unpair row" ──────────────────
describe('no stray list marker on the handset group row', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./PairedList.vue', import.meta.url)), 'utf8');

  it('both <ul>s in THIS file suppress the marker', () => {
    // Cannot be proven by rendering: the bullet marker is drawn by UA styles,
    // it never enters the SSR HTML string. So the only judgement criterion is
    // "does that rule really exist, and does it really cover both lists."
    expect(SRC).toMatch(/\.paired-list,\s*\.pg-rows\s*\{[^}]*list-style:\s*none/);
  });

  it('🔴 the group <li> is the one that needs it — it has no `display` of its own', () => {
    // What this guards is **why only that one row has a dot**. `.paired-row` /
    // `.pg-rows` set flex, and flex knocks out list-item; `.paired-group` has
    // no `display` set, so it retains list-item and draws the marker. If
    // someone one day adds `display: flex` to `.paired-group`, this test will
    // remind them the rule above is no longer the sole line of defence — but
    // that is not a reason to delete it either (switching layouts back would
    // bring the dot back too).
    expect(SRC).toMatch(/\.paired-row\s*\{[^}]*display:\s*flex/);
    expect(SRC).toMatch(/\.pg-rows\s*\{[^}]*display:\s*flex/);
    expect(SRC).not.toMatch(/\.paired-group\s*\{[^}]*display:/);
  });

  it('the fix is scoped — it must NOT be a bare element-wide `ul` rule', () => {
    // Only four <ul>s in the whole repo, and the other two are
    // DataPortability's import-result lists, which **need** bullet markers.
    //
    // ⚠️ The assertion runs against a **comment-stripped view**: the first
    // version scanned SRC directly and went red on the very counter-example
    // spelling quoted in the explanation above — this is already the fourth
    // time this round has been bitten by the same thing (the other three are
    // in the 2026-08-02 delivery report §4).
    // Law: **a negative assertion is only as reliable as what it is allowed
    // to see**; a comment is an audit trail, the probe is what needs fixing.
    const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*(?:\/\/|<!--).*$/gm, '');
    expect(CODE).not.toMatch(/(^|[^.\w-])ul\s*\{/m);
  });
});

// ── REQ-12-10b (desktop half), reworked per owner 2026-08-20: EVERY handset is shelled ──
//
// The original 10b §2.4 rule (「a single pairing gets no shell」) optimised each
// item alone and lost the list: the owner's screenshot showed shelled two-pairing
// groups and bare one-line rows interleaved, reading as two different kinds of
// object when they are the same kind. The contract now: one box = one device,
// with the same header, whatever the pairing count. The sub-rows must survive
// the shell intact — that is the half a purely visual change can break silently,
// so it is what the render assertions below are aimed at, not the border itself.
describe('REQ-12-10b (2026-08-20 unified): every handset is shelled, and pairings stay whole', () => {
  const SAME_HANDSET: PairedPresenceView = {
    rows: [
      { ...LAN_ROW, mobile_name: '同一台手机' },
      {
        ...LAN_ROW,
        pairing_id: 'p-cloud-2',
        mobile_name: '同一台手机',
        channel: 'cloud',
        // The SAME device_uid is what makes them one handset (derivePairedGroups
        // keys on it) — this is the grouping's real input, not the name.
      },
    ],
    unlisted: [],
  };
  /** SSR keeps the template's HTML comments, and this component's comments quote
   *  the very words some assertions below count ("unpair"…). Counting on the raw
   *  string would measure the prose, so strip it — the same reason the source
   *  guards in this repo blank comment bodies before grepping. */
  const strip = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');
  const shelled = async (): Promise<string> =>
    strip(await renderToString(createSSRApp(PairedList, { view: SAME_HANDSET, reload: () => Promise.resolve() })));

  it('a two-pairing handset carries the device header WITH the count chip', async () => {
    const html = await shelled();
    expect(html).toContain('class="paired-group"');
    expect(html).toContain('class="pg-head"');
    expect(html).toContain('同一台手机');
    // The count chip still explains WHY one phone has several rows.
    expect(html).toContain(S.dev_group_pairings);
    expect(html).toContain(S.dev_group_hint);
  });

  it('🔴 both pairings survive the shell — two channels, two action sets', async () => {
    // The thing a "make it look a bit nicer" change is most likely to quietly cost. Each row is
    // an independent pairing with its own revoke; a shell that swallowed one, or
    // merged the two into a single actionable unit, would be the merge the ruling
    // forbids wearing different markup.
    const html = await shelled();
    expect(html).toContain('class="lan chan-badge"');
    expect(html).toContain('class="cloud chan-badge"');
    expect((html.match(/class="paired-row"/g) ?? []).length).toBe(2);
    // Two revoke buttons, counted by their own tooltip (a unique attribute)
    // rather than by the label "unpair," which also occurs inside the confirm
    // copy — counting the label would pass on a broken render for the wrong
    // reason, which is how a count assertion stops measuring anything.
    expect((html.match(new RegExp(S.dev_revoke_hint, 'g')) ?? []).length).toBe(2);
  });

  it('🔴 a SINGLE pairing gets the SAME shell and header (owner 2026-08-20: one list, one shape)', async () => {
    // The reversal of the old 10b §2.4 test that stood here. What stays out is
    // only the count chip: 「1 条配对」 explains nothing (and its English plural
    // would be wrong) — the SHELL is what is uniform, not the chip.
    const html = strip(
      await renderToString(
        createSSRApp(PairedList, {
          view: { rows: [LAN_ROW], unlisted: [] } satisfies PairedPresenceView,
          reload: () => Promise.resolve(),
        }),
      ),
    );
    expect(html).toContain('class="paired-group"');
    expect(html).toContain('class="pg-head"');
    expect(html).not.toContain(S.dev_group_pairings);
    // The name lives in the header now, not on the row — and it really rendered,
    // so the negative above is reading a real card rather than an empty render.
    expect(html).toContain(LAN_ROW.mobile_name);
    // The row keeps its own channel badge, chip and actions.
    expect(html).toContain('class="lan chan-badge"');
    expect((html.match(new RegExp(S.dev_revoke_hint, 'g')) ?? []).length).toBe(1);
  });

  it('the shell is one rule for ALL groups, and the row divider lives inside it', () => {
    const SRC = readFileSync(fileURLToPath(new URL('./PairedList.vue', import.meta.url)), 'utf8');
    expect(SRC).toMatch(/\.paired-group\s*\{[^}]*border:\s*1px solid var\(--line\)/);
    expect(SRC).toMatch(/\.paired-group\s*\{[^}]*background:\s*var\(--surface-inset\)/);
    // The old bare-row hairline is gone WITH the bare rows; rows divide inside
    // the shell instead.
    expect(SRC).not.toContain('.paired-group:not(.multi)');
    expect(SRC).toMatch(/\.paired-row\s*\+\s*\.paired-row\s*\{[^}]*border-top/);
    // Neutral by design — no per-machine tint invented on this surface (the phone
    // has an identity colour lane, the desktop does not).
    expect(SRC).not.toMatch(/\.paired-group\s*\{[^}]*var\(--channel-/);
  });
});

describe('PairedList.vue source no longer defines a private channel colour pair', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./PairedList.vue', import.meta.url)), 'utf8');

  it('imports CHANNEL_VISUAL — the one definition — instead of re-deriving one', () => {
    expect(SRC).toContain("CHANNEL_VISUAL, type ChannelId } from '../../lib/channel'");
  });

  it('the retired `.chip.chan-lan/.chan-cloud` CSS rules are gone from this file', () => {
    // Matches the LIVE rule (selector immediately followed by `{`), not the
    // history comment above the new markup that names the retired classes —
    // that prose IS the audit trail and must stay readable, not be grepped away.
    expect(SRC).not.toMatch(/\.chip\.chan-lan\s*\{/);
    expect(SRC).not.toMatch(/\.chip\.chan-cloud\s*\{/);
    expect(SRC).not.toContain("'chan-cloud' : 'chan-lan'");
  });
});
