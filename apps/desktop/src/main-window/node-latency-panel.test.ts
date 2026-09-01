// WP2 Card 1 — the relay-node latency panel, asserted ON THE RENDERED RESULT.
//
// Same render path as channel-card-head.test.ts / cloud-account-card.test.ts:
// vitest's default SSR transform + vue/server-renderer. The component is
// presentational, so what SSR emits is the real markup, not a placeholder.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import NodeLatencyPanel from './components/NodeLatencyPanel.vue';
import { S } from '../lib/strings';
import { setLocale } from '../lib/strings/locale';
import type { NodeLatencyRow } from '../lib/relay-latency';
import { asNodeRows } from '../lib/relay-latency';

function render(nodes: NodeLatencyRow[], busy = false): Promise<string> {
  return renderToString(createSSRApp(NodeLatencyPanel, { nodes, busy }));
}

const BOTH: NodeLatencyRow[] = [
  {
    short: 'asia',
    selected: true,
    paths: [
      { kind: 'published', connect_ms: 1353, rtt_ms: 200 },
      { kind: 'alternate', connect_ms: 90, rtt_ms: 67 },
    ],
  },
];

afterEach(() => setLocale('en'));

describe('the panel is information, not a menu', () => {
  it('renders the title, the note, and a check — never a per-node control', async () => {
    const html = await render([]);
    expect(html).toContain(S.node_lat_title);
    expect(html).toContain(S.node_lat_note);
    expect(html).toContain(S.node_lat_check);
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('type="checkbox"');
  });

  it('says Checking… while a check is in flight', async () => {
    const html = await render([], true);
    expect(html).toContain(S.node_lat_checking);
    expect(html).not.toContain(`>${S.node_lat_check}<`);
  });
});

describe('both paths and the hot number are what the user reads', () => {
  it('shows Cloudflare and Direct when a node has two doors, and marks the one in use', async () => {
    const html = await render(BOTH);
    expect(html).toContain('asia');
    expect(html).toContain(S.node_lat_via_cloud);
    expect(html).toContain(S.node_lat_via_direct);
    expect(html).toContain(S.node_lat_here);
    expect(html).toContain('200');
    expect(html).toContain('67');
    expect(html).toContain(S.node_lat_latency);
    expect(html).toContain(S.node_lat_connect);
    expect(html).not.toContain('srvjp');
    expect(html).not.toContain('flowmic.app');
  });

  it('a miss is named, never drawn as a large number', async () => {
    const html = await render([
      {
        short: 'us',
        selected: false,
        paths: [{ kind: 'published', connect_ms: null, rtt_ms: null }],
      },
    ]);
    expect(html).toContain(S.node_lat_unanswered);
    expect(html).not.toMatch(/\d{3,} ms/);
  });

  it('a single door does not wear a Cloudflare/Direct label — those names answer a comparison', async () => {
    const html = await render([
      {
        short: 'hk',
        selected: false,
        paths: [{ kind: 'published', connect_ms: 90, rtt_ms: 67 }],
      },
    ]);
    expect(html).toContain(S.node_lat_latency);
    expect(html).toContain('67');
    expect(html).not.toContain(S.node_lat_via_cloud);
    expect(html).not.toContain(S.node_lat_via_direct);
  });
});

describe('asNodeRows drops ids and urls rather than forwarding them', () => {
  it('keeps short/selected/paths and forgets everything else', () => {
    const rows = asNodeRows({
      nodes: [
        {
          id: 'srvjp',
          url: 'https://srvjp.flowmic.app',
          short: 'asia',
          selected: true,
          paths: [{ kind: 'alternate', connect_ms: 90, rtt_ms: 67 }],
        },
      ],
    });
    expect(rows).toEqual([
      {
        short: 'asia',
        selected: true,
        paths: [{ kind: 'alternate', connect_ms: 90, rtt_ms: 67 }],
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('srvjp');
  });
});

describe('the command has a production caller', () => {
    it('SettingsPage mounts the panel and the check goes through relay-latency.ts', () => {
    const page = readFileSync(
      fileURLToPath(new URL('./SettingsPage.vue', import.meta.url)),
      'utf8',
    );
    expect(page).toContain('<NodeLatencyPanel');
    expect(page).toContain('checkRelayLatency');
    const door = readFileSync(
      fileURLToPath(new URL('../lib/relay-latency.ts', import.meta.url)),
      'utf8',
    );
    expect(door).toContain("invokeSafe<unknown>('relay_latency_check')");
    expect(door).not.toContain("from '@tauri-apps");
  });
});
