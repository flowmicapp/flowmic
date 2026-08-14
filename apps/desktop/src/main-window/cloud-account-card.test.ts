// L3 account card — **the reproducible half of stub-based verification**: feed the
// IPC stub a realistically-shaped Rust response and walk the whole real chain
// (bridge invoke → asCloudAccountRaw → parseLiveAccount → deriveAccountCard →
// component render), asserting **the numbers from the stub are really printed on
// the card**.
//
// Why this test cannot be replaced by "the pure layer is already green": the pure
// layer proves "the computation is correct"; this proves "the computed value is
// actually painted on screen". The exact gap between the two is what this repo has
// been burned by before (a capability defined with nobody calling it = the No.1
// historical bug class).
//
// Render path: vitest's default SSR transform + `vue/server-renderer`, the same
// route as paired-list.test.ts / pairing-modal.test.ts. The component is purely
// presentational (its whole state arrives via the `card` prop), so what SSR renders
// is the real row markup, not a pre-fetch placeholder.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/strings';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CloudAccountLines from './components/CloudAccountLines.vue';
import { deriveAccountCard, parseLiveAccount, type AccountCard } from '../lib/cloud-account';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from '../lib/channel';

/** M3-8. 🔴 The criterion is **shape**, not one known literal string: an eyeball
 *  assertion (`not.toContain('u-1')`) can only prove "that one test constant didn't
 *  appear", while what would really appear on screen is a 36-character UUID.
 *  This regex is the only ruler for this whole line of accounting. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Taken verbatim from the string in owner's screenshot in the L3 design doc §1.1
 *  (i.e. the exact one shown to the user). */
const ACCOUNT_UUID = '3f9c1a2e-8b0d-4c77-9a51-6d2e0f7ab7d4';

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

const hadWindow = 'window' in globalThis;
(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const { fetchCloudAccount } = await import('../lib/bridge');

const KEY_EXP_UNIX = Math.floor(new Date(2026, 7, 3, 16, 41, 0).getTime() / 1000);
const FETCHED_AT = Math.floor(new Date(2026, 7, 2, 16, 2, 0).getTime() / 1000);
const SIGNED_IN: CloudStatus = {
  ...EMPTY_CLOUD_STATUS,
  key_set: true,
  // 🔴 A realistically-shaped `sub` (the server's `auth-service.ts:113` uses
  // `randomUUID()`). This used to say `'u-1'` here, so the question "will an
  // internal id show up on screen" was being answered by a string that doesn't even
  // look like an id.
  subject: ACCOUNT_UUID,
  plan: 'free', // 🔴 A snapshot from the JWT — the card must never show it as the plan
  expires_at: KEY_EXP_UNIX,
  readiness: 'ready',
};

/** Matches `CloudAccountDto` (src-tauri/src/shell/cloud.rs) plus two real routes'
 *  bodies, verbatim. Deliberately typed as the loose `Record<string, any>` shape:
 *  what this simulates is **JSON as it arrives in production**, and the value of the
 *  test is precisely that what gets fed in is "what the server actually sends"
 *  rather than an object already narrowed by TS — `expires_at: null` /
 *  `limit_min: null` (what Infinity looks like once serialized) both have to be
 *  feedable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PRO_DTO: Record<string, any> = {
  outcome: 'ok',
  fetched_at: FETCHED_AT,
  detail: null,
  me: { user: { id: ACCOUNT_UUID, email: 'owner@example.com', display_name: 'owner', plan: 'pro' } },
  summary: {
    plan: {
      plan: 'pro',
      source: 'paddle',
      quota_exempt: false,
      cycle: 'monthly',
      state: 'active',
      expires_at: '2026-09-01T08:00:00.000Z',
      paddle_subscription_id: 'sub_123',
    },
    quota: { stt: { used_min: 128, limit_min: 900 }, llm: { used: 12, limit: 20_000_000 }, month: '2026-08' },
    devices: { pc_count: 1, mobile_count: 2 },
  },
};

function render(card: AccountCard): Promise<string> {
  return renderToString(createSSRApp(CloudAccountLines, { card }));
}

/** The whole chain, exactly as the pages run it. */
async function renderThroughBridge(dto: unknown, opts: { cloud?: CloudStatus } = {}): Promise<string> {
  invoke.mockResolvedValue(dto);
  const raw = await fetchCloudAccount();
  const parsed = parseLiveAccount(raw);
  const card = deriveAccountCard({
    cloud: opts.cloud ?? SIGNED_IN,
    raw,
    lastLive: parsed === null ? null : { account: parsed, at: raw.fetched_at ?? FETCHED_AT },
    loading: false,
  });
  return render(card);
}

beforeEach(() => {
  invoke.mockReset();
  setLocale('zh-CN');
});

describe('打桩实证: 服务端的数真的印在卡上', () => {
  it('pro 账号: 邮箱 / PRO / 128 · 900 / 两个不同的到期日 全部出现在 HTML 里', async () => {
    const html = await renderThroughBridge(PRO_DTO);
    // The bridge really was called, and with that specific command (not some default
    // value that happened to line up).
    expect(invoke).toHaveBeenCalledWith('cloud_account_fetch', undefined);

    expect(html).toContain('owner@example.com');
    // 🔴 M3-8's positive control, paired with the two negative assertions below in
    // the "unreachable" case: the account row (`ca-v mono`) **really does render**
    // when there is a live answer, and what it prints is the email, not that id
    // string — otherwise "no UUID on screen" could simply mean the whole component
    // never rendered.
    expect(html).toContain('ca-v mono');
    expect(html).not.toMatch(UUID_RE);
    expect(html).toContain('PRO');
    expect(html).toContain('128 / 900 分钟');
    expect(html).toContain('已订阅');
    // 🔴 Two expiry dates, two labels, two sentences.
    expect(html).toContain('订阅有效期至');
    expect(html).toContain('2026-09-01');
    expect(html).toContain('Cloud Key 有效期至');
    expect(html).toContain('2026-08-03 16:41');
    expect(html).toContain('账号信息更新于 16:02');

    // Anti-façade: the disclosure that "the desktop client is not wired to /api/me"
    // must already be gone (its reason for existing no longer applies).
    expect(html).not.toContain('未接入');
    // eslint-disable-next-line no-console
    console.log('\n[L3 打桩渲染 · pro]\n' + html + '\n');
  });

  it('免费档: FREE + 3/20 分钟, 且 HTML 里根本没有「订阅有效期至」这一行', async () => {
    const free = structuredClone(PRO_DTO);
    free.me.user.plan = 'free';
    free.summary.plan = {
      plan: 'free',
      source: 'none',
      quota_exempt: false,
      cycle: null,
      state: 'none',
      // Even if the server happens to include a date, the free tier must never draw it.
      expires_at: '2026-09-01T08:00:00.000Z',
      paddle_subscription_id: null,
    };
    free.summary.quota.stt = { used_min: 3, limit_min: 20 };
    const html = await renderThroughBridge(free);

    expect(html).toContain('FREE');
    expect(html).toContain('3 / 20 分钟');
    // 🔴 The one owner called out on 2026-08-02: the whole line is absent on the free tier.
    expect(html).not.toContain('订阅有效期至');
    expect(html).not.toContain('2026-09-01');
    // Positive control on the same screen: the Cloud Key line is still there, so "no
    // subscription period" is not the whole render being broken.
    expect(html).toContain('Cloud Key 有效期至');
    expect(html).toContain('2026-08-03 16:41');
    // eslint-disable-next-line no-console
    console.log('\n[L3 打桩渲染 · free]\n' + html + '\n');
  });

  it('owner 那一档: FREE + 长期免费 + MAX 的数（名字与数分开断言）', async () => {
    const exempt = structuredClone(PRO_DTO);
    exempt.summary.plan = {
      plan: 'free',
      source: 'permanent_free',
      quota_exempt: true,
      cycle: null,
      state: 'none',
      expires_at: null,
      paddle_subscription_id: null,
    };
    // 🔴 2026-08-07 (owner ruling ①): an exempt account no longer reports
    // Infinity/null — the server now sends the MAX tier's own finite number. This
    // line used to be `limit_min: null` + an assertion for "128 minutes · unlimited".
    exempt.summary.quota.stt = { used_min: 128, limit_min: 3000 };
    const html = await renderThroughBridge(exempt);
    expect(html).toContain('FREE'); // the name: owner bought nothing
    expect(html).toContain('长期免费'); // the reason why
    expect(html).toContain('128 / 3000 分钟 · 不计费'); // the number that actually applies
    // 🔴 A sentence that is no longer true must not be printed on the card: the
    // server really does gate the user at 3,000 minutes right now.
    // This is an assertion on the **rendered result**, not on the S catalogue (the
    // 0.2.53 rule).
    expect(html).not.toContain('不限额');
    expect(html).not.toContain('PRO');
    expect(html).not.toContain('订阅有效期至');
  });

  it('问不到: 中性态 —— HTML 里 grep 不到任何套餐/用量，也没有红色 loud 块', async () => {
    const html = await renderThroughBridge({
      outcome: 'unreachable',
      fetched_at: null,
      detail: 'timeout',
      me: null,
      summary: null,
    });
    expect(html).toContain('暂时问不到账号信息');
    expect(html).toContain('重新查询');
    // 🔴 Negative assertion + positive control: the two tests above prove these
    // strings really do appear when there is an answer.
    expect(html).not.toContain('FREE');
    expect(html).not.toContain('PRO');
    expect(html).not.toContain('分钟');
    expect(html).not.toContain('订阅有效期至');
    expect(html).not.toContain('ca-loud');
    // 🔴 M3-8: this used to assert `toContain('u-1')` — the account's internal UUID
    // was really being printed on screen. Now the whole line is absent. The
    // criterion is **structure** (`ca-v mono` is the only monospace tile on this
    // card = the account row) plus **shape** (the UUID regex), not any one literal:
    // ⚠️ Must not write `not.toContain('账号')` ("account") — "暂时问不到账号信息"
    //    ("account info temporarily unreachable") already contains those two
    //    characters, so that assertion would be permanently red/green because of an
    //    unrelated sentence, and would not be testing this at all.
    expect(html).not.toContain('ca-v mono');
    expect(html).not.toMatch(UUID_RE);
    // eslint-disable-next-line no-console
    console.log('\n[L3 打桩渲染 · 问不到]\n' + html + '\n');
  });

  it('401: 响亮块出现，且不是「暂时问不到」', async () => {
    const html = await renderThroughBridge({
      outcome: 'unauthorized',
      fetched_at: null,
      detail: 'http 401',
      me: null,
      summary: null,
    });
    expect(html).toContain('ca-loud');
    // F5 / owner ruling ⑤ 2026-08-04: verbatim wording "登录已过期，请重新登录。"
    // ("Login has expired, please sign in again.") — a fixed four-locale copy.
    expect(html).toContain('登录已过期，请重新登录。');
    expect(html).not.toContain('暂时问不到账号信息');
    expect(html).not.toContain('重新查询');
    // 🔴 M3-8: this state previously had **zero identity assertions**, and it fell
    // back to `cloud.subject` the same way ⇒ the red block on a 401 was printing
    // that UUID string right underneath it.
    expect(html).not.toContain('ca-v mono');
    expect(html).not.toMatch(UUID_RE);
  });

  it('冷启动第一次还在问（loading，从来没有过答案）: 也不许先把 UUID 顶上去占位', async () => {
    // This state had **never actually been exercised** at the render layer before
    // (the component tests only ever fed live/free/exempt/unreachable/401). It
    // shares the same fallback path as "unreachable": `account` is null ⇒ the old
    // code fell back to `cloud.subject`.
    const card = deriveAccountCard({ cloud: SIGNED_IN, raw: null, lastLive: null, loading: true });
    const html = await render(card);
    expect(html).toContain('正在查询账号信息…');
    expect(html).not.toContain('ca-v mono');
    expect(html).not.toMatch(UUID_RE);
    // Currently asking ≠ unreachable: the "temporarily unreachable" sentence must
    // not appear in this state.
    expect(html).not.toContain('暂时问不到');
  });

  it('stale（问到过、这次问不到）: 身份仍是上次问到的**邮箱**，且那句话说得出是几点问到的', async () => {
    const remembered = parseLiveAccount({
      outcome: 'ok',
      fetched_at: FETCHED_AT,
      detail: null,
      me: PRO_DTO.me,
      summary: PRO_DTO.summary,
    })!;
    const card = deriveAccountCard({
      cloud: SIGNED_IN,
      raw: { outcome: 'unreachable', fetched_at: null, detail: 'connect', me: null, summary: null },
      lastLive: { account: remembered, at: FETCHED_AT },
      loading: false,
    });
    const html = await render(card);
    expect(html).toContain('owner@example.com');
    expect(html).toContain('暂时问不到，下面是 16:02 问到的'); // "what's this claim based on" (R11)
    expect(html).not.toMatch(UUID_RE);
  });

  it('服务端答了、这个账号确实没有邮箱: 说「未绑定邮箱」，不是那串 id，也不是「问不到」', async () => {
    // `users.email` is allowed to be empty (the users DDL in server-core
    // db/schema.ts) ⇒ this is a genuinely **reachable** live answer. It is a
    // different thing from "unreachable", so it gets a different sentence.
    const noEmail = structuredClone(PRO_DTO);
    noEmail.me.user.email = null;
    const html = await renderThroughBridge(noEmail);
    expect(html).toContain('未绑定邮箱');
    expect(html).toContain('ca-v mono'); // this row **exists** (there is an answer), the answer just isn't an email
    expect(html).not.toMatch(UUID_RE); // but must never fall back to printing `me.user.id`
    expect(html).not.toContain('暂时问不到'); // and must never be read as "unreachable" either
    expect(html).toContain('PRO'); // positive control: this really was a successful live read
  });

  it('桥不在（浏览器里裸跑）: 走 no_bridge，绝不冒充「服务器说的」', async () => {
    delete (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window!.__TAURI_INTERNALS__;
    const raw = await fetchCloudAccount();
    expect(raw.outcome).toBe('no_bridge');
    expect(invoke).not.toHaveBeenCalled();
    (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window!.__TAURI_INTERNALS__ = {};
  });
});
