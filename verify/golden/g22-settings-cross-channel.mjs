// verify/golden/g22-settings-cross-channel.mjs
//
// G22 — 🔴 phone-owned preferences RIDE THE START FRAME on both channels, are used
// for exactly that session, and are never storage
// (owner rulings 2026-09-03, docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md,
// and the same-day follow-up ruling that the carrier is `audio:start` / `compose:start`;
// design docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md D2/D4).
//
// ── 🔴 what this file proves, and what it does not ─────────────────────────────────
//
// The "phone" here, as in G19/G20, is a **bare socket.io client**. So:
//   · proved — on TWO REAL SERVERS OF DIFFERENT MODES (standalone = the LAN sidecar,
//     saas = the cloud relay):
//       ① an `audio:start` carrying `prefs.scenario.card` resolves THAT card for THAT
//          session (the pipeline trace's `terms.resolved` reports the card's own
//          term/alias counts — 3/2 — on the production seam);
//       ② the card NEVER lands in `user_settings` (the PC's `settings:list` lists every
//          stored row and does not show it; positive control: the same probe shows
//          `llm.config`, which the PC just stored);
//       ③ REVERSE CONTROL: the next `audio:start` on the SAME socket WITHOUT `prefs`
//          resolves NO card (0/0) — a stale bundle never acts on a later utterance;
//       ④ a `compose:start` carrying the card feeds the scenario block (`compose.scenario`
//          reports professions=1, term_count=3), and one without it feeds nothing (0/0);
//       ⑤ a `settings:update('scenario.card')` is refused by name from the MOBILE and
//          from the PC alike, and still nothing is stored;
//   · not proved — that the phone actually puts its preferences on every start frame.
//     That half is the mobile client's (WP-B).
//
// ── 🔴 why ① and ③ are the load-bearing pair ─────────────────────────────────────────
//
// ② alone is satisfied by a server that drops the bundle; ① alone is satisfied by a
// server that keeps the LAST bundle forever. Only the pair says "used, then forgotten":
// the counts are measured on the production seam (engine/stt-factory.ts, level `meta` —
// counts only, never the words), and ② has just shown the database has nothing that
// could have produced them.
//
// ⚠️ **Every cloud assertion has a same-shape LAN control** — G20's rule. "The cloud leg
// went red" and "the feature is entirely broken" look identical without it, and the two
// dispositions are opposite (redeploy the relay / go back and change the code).
//
// 🔴 **DEPLOYMENT ORDER IS DETECTABLE HERE.** A relay older than this contract strips the
// unknown `prefs` key (zod) and resolves no card: ① fails on the cloud leg with 0/0 while
// the LAN leg passes. The failure message names the order (relay first, then APK).
//
// ── REVERSE CONTROLS (executed 2026-09-03, this tree; all three restored byte-identical,
//    sha256 compared, dist rebuilt from the restored sources and G22 re-run green) ──
//
//   A. STALE BUNDLE: audio.handler.ts `setSessionPrefs(socket, parsed.data.prefs ?? null)`
//      → set only when present (a frame without prefs keeps the previous bundle) →
//        G22  FAIL  lan/③: 不带 prefs 的第二次 audio:start 仍然看到了上一次的情景卡 ——
//                   terms.resolved 报 rule_count=3 alias_count=2，应为 0/0。
//      i.e. ① and ② stayed green and ONLY ③ caught it — which is the whole argument for ③.
//   B. STORAGE: settings.handler.ts — the `isPhoneOwnedKey` refusal deleted →
//        G22  FAIL  lan/⑤: mobile 写 scenario.card 没有被具名拒收（{"ok":true}）…
//   C. TRANSIT: engine/stt-factory.ts — `overlaySettings(deps.settings, getSessionPrefs(socket))`
//      replaced with `deps.settings` (read the database, ignore the frame) →
//        G22  FAIL  lan/①: audio:start 没有用帧里带的情景卡 —— terms.resolved 报 rule_count=0
//                   alias_count=0，应为 3/2 …
//   Each fired on the LAN leg first, on the step built for it, before any cloud step ran.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  ROOT, SERVER_CORE, SERVER_DIST,
  connect, ack, once, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';
import { internalOnly } from './requires.mjs';

const KEY = 'scenario.card';

/** The card the phone carries: 3 terms, 2 aliases in total, 1 profession. Those
 *  numbers are what ① and ④ read back off the trace, so they are stated once here. */
const CARD = {
  professions: ['golden'],
  domains: [],
  packs: [],
  terms: ['FlowMic', { term: 'Kubernetes', aliases: ['k8s', '库伯'] }, 'Soniox'],
};
const CARD_TERMS = 3;
const CARD_ALIASES = 2;

const AUDIO = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh', delivery: 'none' };
const COMPOSE = { task: 'organize', source_text: 'golden probe' };
/** A stored key the PC may still write; it doubles as the positive control for the
 *  "no row" probe AND as the LLM config the compose factory needs to get as far as
 *  the scenario trace (the endpoint is unreachable — the turn ends in compose:error,
 *  which is fine: the `compose.scenario` record is written before any call). */
const LLM_CONFIG = { protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:9/v1', api_key: 'EMPTY', model: 'golden-probe' };

/** A standalone server of our own, so the pipeline trace can be switched on for it.
 *  Same spawn shape as harness.startServer, plus the two trace env vars. */
function startStandaloneTraced(tracePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER_CORE,
      env: {
        ...process.env,
        FLOWMIC_MODE: 'standalone', FLOWMIC_PORT: '0',
        FLOWMIC_SETTINGS_SECRET: 'golden-secret-32-bytes-minimum-xxx',
        FLOWMIC_TRACE_PIPELINE: 'meta', FLOWMIC_TRACE_PATH: tracePath,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on('exit', (code) => reject(new Error(`standalone server exited early (${code})`)));
    setTimeout(() => reject(new Error('standalone server start timeout')), 8000);
  });
}

async function pcSettingsKeys(pc) {
  const list = await ack(pc, 'settings:list', {});
  if (!Array.isArray(list?.items)) return null;
  return list.items.map((i) => i.key);
}

/** All records of one stage in the trace file. */
function records(tracePath, stage) {
  let text;
  try { text = readFileSync(tracePath, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.stage === stage);
}

/** Wait for the stage to gain a record beyond `already`, up to ~3 s. */
async function nextRecord(tracePath, stage, already) {
  for (let i = 0; i < 30; i++) {
    const all = records(tracePath, stage);
    if (all.length > already) return all[all.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function startAndStop(mobile, payload) {
  try { await ack(mobile, 'audio:start', payload); } catch { /* an engine-less server may refuse; the trace is already written */ }
  try { await ack(mobile, 'audio:stop', {}); } catch { /* same */ }
}

/**
 * The five steps, run identically on one leg. Returns an error string or null.
 * `label` is 'lan' | 'cloud'; the message names the leg so the two dispositions stay apart.
 */
async function runLeg(label, { pc, mobile, tracePath }) {
  const stale = `\n  🔴 部署顺序＝**先中继、后 APK**：老中继会把未知的 \`prefs\` 键在途剥掉；若 LAN 腿绿而云端红 ⇒ 是中继没部署，别改代码。`;

  // ── ① audio:start CARRYING the card resolves it for that session ───────────────
  const n1 = records(tracePath, 'terms.resolved').length;
  await startAndStop(mobile, { ...AUDIO, prefs: { [KEY]: CARD } });
  const r1 = await nextRecord(tracePath, 'terms.resolved', n1);
  if (r1 === null) {
    return `${label}/①: audio:start 之后 trace 里没有新的 terms.resolved 记录（${tracePath}）——`
      + ' FLOWMIC_TRACE_PIPELINE=meta 没生效，或 audio:start 根本没走到 stt-factory 的闭包。';
  }
  if (r1.rule_count !== CARD_TERMS || r1.alias_count !== CARD_ALIASES) {
    return `${label}/①: audio:start 没有用帧里带的情景卡 —— terms.resolved 报 rule_count=${r1.rule_count} alias_count=${r1.alias_count}，`
      + `应为 ${CARD_TERMS}/${CARD_ALIASES}。② 证明库里没有卡，这个数只能来自帧上的 prefs；为 0 ⇒ 要么 audio.handler 没把 bundle 挂上 socket，要么 stt-factory 读的是库。${stale}`;
  }

  // ── ② …and it NEVER lands: the PC's settings:list (every stored row) has no card ──
  //     Positive control first: a key a PC stores DOES show up through the same probe.
  const stored = await ack(pc, 'settings:update', { key: 'llm.config', value: LLM_CONFIG });
  if (stored?.ok !== true) return `${label}/②-control: PC 写一个仍然入库的键失败了（${JSON.stringify(stored)}）——探针本身没法证明自己不瞎。`;
  const keys = await pcSettingsKeys(pc);
  if (keys === null) return `${label}/②: PC 的 settings:list 没有 items 数组`;
  if (!keys.includes('llm.config')) return `${label}/②-control: PC 刚存的 llm.config 在 settings:list 里看不见 ⇒ 这个探针是瞎的，下面的「没有」什么都不证明。`;
  if (keys.includes(KEY)) {
    return `${label}/②: \`${KEY}\` 落进了 user_settings（PC 的 settings:list 看得见它）。`
      + '\n  🔴 这台服务端把帧里的 prefs 当成了存储（配置不进云端，owner Q6 备注）。';
  }

  // ── ③ REVERSE CONTROL: the next audio:start WITHOUT prefs sees NO card ──────────
  const n3 = records(tracePath, 'terms.resolved').length;
  await startAndStop(mobile, AUDIO);
  const r3 = await nextRecord(tracePath, 'terms.resolved', n3);
  if (r3 === null) return `${label}/③: 第二次 audio:start 之后 trace 里没有新的 terms.resolved 记录。`;
  if (r3.rule_count !== 0 || r3.alias_count !== 0) {
    return `${label}/③: 不带 prefs 的第二次 audio:start 仍然看到了上一次的情景卡 —— terms.resolved 报 rule_count=${r3.rule_count} alias_count=${r3.alias_count}，应为 0/0。`
      + '\n  🔴 bundle 在 socket 上残留了：一次请求的配置必须只作用于那一次（替换而不是合并；缺席即清空）。';
  }

  // ── ④ compose:start carrying the card feeds the scenario block; without it, nothing ─
  const n4 = records(tracePath, 'compose.scenario').length;
  mobile.emit('compose:start', { ...COMPOSE, prefs: { [KEY]: CARD } });
  const r4 = await nextRecord(tracePath, 'compose.scenario', n4);
  if (r4 === null) return `${label}/④: compose:start 之后 trace 里没有 compose.scenario 记录（LLM 配置没解析出来？② 刚写了 llm.config）。`;
  if (r4.professions !== 1 || r4.term_count !== CARD_TERMS || r4.block_present !== true) {
    return `${label}/④: compose:start 没有用帧里带的情景卡 —— compose.scenario 报 professions=${r4.professions} term_count=${r4.term_count} block_present=${r4.block_present}，`
      + `应为 1/${CARD_TERMS}/true。${stale}`;
  }
  const n4b = records(tracePath, 'compose.scenario').length;
  mobile.emit('compose:start', COMPOSE);
  const r4b = await nextRecord(tracePath, 'compose.scenario', n4b);
  if (r4b === null) return `${label}/④-control: 第二次 compose:start 没有留下 compose.scenario 记录。`;
  if (r4b.professions !== 0 || r4b.term_count !== 0 || r4b.block_present !== false) {
    return `${label}/④-control: 不带 prefs 的 compose:start 仍然看到了上一次的情景卡（professions=${r4b.professions} term_count=${r4b.term_count}）。`;
  }

  // ── ⑤ settings:update of the key is refused by name — from the phone AND the PC ──
  for (const [who, sock] of [['mobile', mobile], ['pc', pc]]) {
    const refused = await ack(sock, 'settings:update', { key: KEY, value: CARD });
    if (refused?.error !== 'SETTINGS_SCHEMA_INVALID' || !String(refused?.message ?? '').includes('phone-owned')) {
      return `${label}/⑤: ${who} 写 ${KEY} 没有被具名拒收（${JSON.stringify(refused)}）—— 这个键只许随 audio:start/compose:start 走，settings:update 一律拒收。`;
    }
  }
  const keysAfter = await pcSettingsKeys(pc);
  if (keysAfter?.includes(KEY)) return `${label}/⑤: 拒收了却还是落了库。`;
  return null;
}

export const G22 = {
  id: 'G22',
  name: '🔴 phone-owned settings: the card rides audio:start/compose:start on BOTH legs — used for that session only, never stored, settings:update refused',
  requires: [
    SERVER_DIST,
    internalOnly(path.join(ROOT, 'docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md'),
      'internal working record: the open-source export EXCLUDEs all of docs/. '
      + 'Q6 note ("配置不进云端") is the ruling this path enforces; an evidence cross-link, not an input.'),
    internalOnly(path.join(ROOT, 'docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md'),
      'internal working record: D2/D4/D12 — the overlay, the refusal, the deployment order.'),
    // The halves being asserted. NOT docs: hard requirements.
    path.join(ROOT, 'packages/protocol/src/phone-prefs.ts'),
    path.join(ROOT, 'apps/server-core/src/socket/handlers/settings.handler.ts'),
    path.join(ROOT, 'apps/server-core/src/settings/session-overlay.ts'),
  ],
  async fn(_sharedUrl) {
    const sockets = [];
    let lan = null;
    let saas = null;
    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g22-'));
    try {
      // ── LAN leg: our OWN standalone (the shared one has no trace switched on) ───────
      const lanTrace = path.join(dir, 'lan-trace.jsonl');
      try {
        lan = await startStandaloneTraced(lanTrace);
      } catch (e) {
        return FAIL(`standalone server failed to start: ${e.message}`);
      }
      const lanUrl = `http://127.0.0.1:${lan.port}`;
      const lanPc = await connect(lanUrl);
      const lanReg = await ack(lanPc, 'pc:register', { device_name: 'G22 LAN PC', client_instance_id: 'inst-g22lan0123456789' });
      const lanMobile = await connect(lanUrl);
      const lanJoined = once(lanPc, 'pc:mobile-joined');
      await ack(lanMobile, 'mobile:pair', { short_code: lanReg.short_code });
      await lanJoined;
      sockets.push(lanPc, lanMobile);

      let err = await runLeg('lan', { pc: lanPc, mobile: lanMobile, tracePath: lanTrace });
      if (err) return FAIL(`${err}\n  ⚠️ LAN 腿就红了 ⇒ 这不是「中继旧了」，是功能本身坏了。`);

      // ── cloud leg (the relay — the only half deployed on its own) ──────────────────
      const cloudTrace = path.join(dir, 'cloud-trace.jsonl');
      try {
        saas = await startSaasServer({ FLOWMIC_TRACE_PIPELINE: 'meta', FLOWMIC_TRACE_PATH: cloudTrace });
      } catch (e) {
        return FAIL(`cloud server failed to start: ${e.message}`);
      }
      const cloudUrl = `http://127.0.0.1:${saas.port}`;
      const jwt = await saasJwt(cloudUrl);
      const pc = await connect(cloudUrl, { jwt });
      const reg = await ack(pc, 'pc:register', { device_name: 'G22 PC', client_instance_id: 'inst-g22-0123456789ab' });
      const mobile = await connect(cloudUrl);
      const joined = once(pc, 'pc:mobile-joined');
      // 0.2.66 — a saas pairing NAMES its PC; inert on standalone. Same spelling as G20.
      await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      await joined;
      sockets.push(pc, mobile);

      err = await runLeg('cloud', { pc, mobile, tracePath: cloudTrace });
      if (err) return FAIL(`${err}\n  ⚠️ LAN 腿绿而云端红 ⇒ 先部署中继，别改代码。`);

      return PASS(
        '两台真服务端（standalone ＋ saas，各自开着 FLOWMIC_TRACE_PIPELINE=meta）各跑同一组判据：'
        + `① 带 prefs.${KEY} 的 audio:start 在生产缝 terms.resolved 报 rule_count=${CARD_TERMS} alias_count=${CARD_ALIASES}；`
        + '② **从未落库** —— PC 的 settings:list 列出全部存量行而没有它（正向对照：同一探针看得见 PC 刚存的 llm.config）；'
        + '③ **反向对照**：同一 socket 下一次不带 prefs 的 audio:start 报 0/0 —— 一次请求的配置只作用于那一次；'
        + `④ 带 prefs 的 compose:start 让 compose.scenario 报 professions=1 term_count=${CARD_TERMS} block_present=true，不带的报 0/0/false；`
        + `⑤ 手机与 PC 的 settings:update('${KEY}') 都被具名拒收（SETTINGS_SCHEMA_INVALID + phone-owned），且仍未落库。`
        + '🔴 NOT covered here：手机到底有没有把配置放进每一帧 audio:start/compose:start —— 本文件的「手机」是裸 socket.io 客户端（WP-B）。',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
      if (lan) lan.child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
