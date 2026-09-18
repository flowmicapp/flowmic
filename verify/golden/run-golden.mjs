// WP-R3.5 — `pnpm golden` runner. G1–G8 (11 §1) as REPEATABLE scripts against a
// REAL in-process server (spawned from the built server-core), each producing a
// three-state result: PASS / SKIPPED(reason) / FAIL(reason).
//
// Not in .husky/pre-commit: this spins a real server + real sockets (seconds),
// so the pre-commit gate stays lint+types only. Delivery gate is
// `pnpm verify:delivery` (= lint + types + golden) — call that before a handoff.
//
// Rules (11 §1 + WP-R3.5 card):
//   • Each G has ONE entry. A required file that is MISSING → FAIL (never a silent
//     skip): `requires` is checked before the G runs.
//     ONE declared exception, added 2026-08-06 and verified rather than trusted:
//     an entry wrapped in `internalOnly(path, why)` names itself as a file the
//     open-source export deliberately EXCLUDEs, so it is waived — BY NAME, WITH
//     ITS REASON, in the summary below — in an exported tree, and still hard-FAILs
//     here. What decides which tree this is, why it is not "the file is missing so
//     this must be the public one", and the two drift checks that keep the marker
//     honest: verify/golden/requires.mjs (read its header before touching this).
//   • LAN engines (funasr 100.64.7.68 / vLLM 100.64.7.179) are OWNER-network
//     only: reachable → real turn; unreachable → SKIPPED(reason) ≠ FAIL.
//   • No-real-device / no-interactive-desktop segments (physical keystroke inject,
//     real-mic long audio) → SKIPPED(reason) ≠ FAIL.
//   • Exit non-zero iff any G FAILs — or any G skips UNDECLARED. ⚠️ This rule
//     used to end "SKIPPED never fails the gate", unconditionally; corrected
//     2026-08-19 (lane L4): "the LAN is down" and "someone broke the
//     reachability probe" printed the same green while the right responses are
//     opposite. A skip now passes only when expected-skips.mjs declares it (id
//     + a regex the printed reason must match, with why it is environment-
//     bound); an undeclared skip fails the run naming the case and what it was
//     supposed to prove. Same escalation family as scripts/run-script-tests.mjs
//     (all-skipped ⇒ FAIL; unreadable skip ⇒ FAIL), one level finer-grained.
//
// Run: pnpm golden   (delegates here; builds server-core if dist is missing).
// Also: pnpm verify:delivery (lint + types + this suite).
//
// ⚠️ SIM-MOBILE CAVEAT (R6 T-3a, learned the hard way — read before trusting a
// green run). The "mobile" in every path below is a socket.io script, NOT the
// Dart app. When it emits `inject:request` it is STANDING IN for the phone, so a
// pass proves the SERVER + PC halves of that chain and says NOTHING about whether
// the real app ever emits it. That distinction hid a headline defect for months:
// direct-send injection was never wired in the phone at all (`_onFinal` only sent
// history:create), so a real utterance parked at ⏳ cached forever — while these
// harnesses, doing the phone's job for it, stayed green the whole time.
// RULE: a wire event the sim emits is covered here only from the receiving side.
// Whether the PHONE emits it belongs to apps/mobile's own tests + a real-device
// run. Same caveat applies to apps/desktop/scripts/golden-smoke*.mjs.
//
// GA-01 (2026-07-25) is the second time this bit. G2/G3 called the compose module
// DIRECTLY and reported "translate chain green" — while the phone was injecting raw transcripts
// in every mode, because it never emitted compose:start at all. Both paths are
// rewritten: each now asserts only what it can actually see (the server leg + the
// no-server-injection invariant) and NAMES the file that pins the phone leg
// (apps/mobile/test/utterance_compose_test.dart), which is `requires`d so the
// evidence cannot quietly disappear. When a G's story needs the phone, cite the
// phone's own test — do not re-enact it here.
//
// ── HOW THE 32 CASES ARE SCHEDULED (card L3, 2026-09-13) ────────────────────
//
// They used to run in one `for` loop, one at a time, and the suite cost the sum
// of every wait in it. Two of those waits are PRODUCT constants and cannot be
// shortened without destroying what the case proves (G32 spends a real minute
// because `FLOWMIC_PLAN_LIMITS` takes integer minutes; G28 spends GA-04's real
// 30 s grace window) — so the only honest lever left is to spend them AT THE
// SAME TIME. No product knob was added; nothing waits for less than it did.
//
// A case may only share the machine if it shares NOTHING ELSE. That splits the
// suite in two, and the split is measured off each case's own source rather
// than assumed:
//
//   SHARED-STANDALONE (19) — takes the `url` of the ONE standalone server this
//   runner starts, and registers PCs / pairs phones / mints short codes in its
//   single in-memory database. Two of these at once would be two cases writing
//   one room table: `pc:list-mobiles` would see the other's phone, a
//   presence probe would see the other's PC. They stay SEQUENTIAL, in table
//   order, as one chain.
//     G1 G2 G3 G5 G6 G7 G8  registerAndPair(url) on the shared instance
//     G10  registerAndPair(url)          G12  four sockets + pc:list-mobiles
//     G13  crosstalkLeg(url) LAN leg     G14  setupMachine(url) ×2 + HTTP POST
//     G16  presence over the shared url  G17  posts a webhook AT standaloneUrl
//     G19 G20 G23  registerAndPair(url)  G27  8 sockets, one shared room
//     G28  parks/drops web clients       G33  registerAndPair(url)
//   ⚠️ G13/G14/G16/G17/G19/G20/G23 ALSO start their own saas server; that half
//   is isolated, but their standalone half is not, so the whole case is shared.
//
//   SELF-STARTING (14) — start every server they touch, with FLOWMIC_PORT '0'
//   (an ephemeral port), FLOWMIC_DB_PATH `:memory:` or a `mkdtempSync` file, and
//   a `mailFileDir()` that is itself a mkdtemp (harness.mjs says why). Nothing
//   they write is addressed by a fixed name, so N of them can run at once.
//     G4 (pure SKIP, touches nothing)  G9 G11 G15 G18 G21 G22 G24 G25 G26 G30
//     G31 G32 G34
//   ⚠️ G22 is the one entry whose signature takes a parameter (`_sharedUrl`)
//   and ignores it — declared with `ignoresUrl` below so the arity cross-check
//   below does not have to trust this sentence.
//
// The chain counts as ONE task in the same pool, so `FLOWMIC_GOLDEN_CONCURRENCY`
// means "at most N cases executing at once" for the whole suite. Set it to 1 and
// the runner is sequential again — that is the reverse control, and its wall
// clock is written beside the pooled ones under MEASURED below.
//
// 🔴 OUTPUT ORDER IS STILL TABLE ORDER. Results are stored by id and printed
// from `GOLDEN`, never in completion order — same rule as
// scripts/run-script-tests.mjs, and for the same reason: a summary that
// reshuffles itself run to run cannot be diffed against the last one.
//
// 🔴 A CLAIM THIS CHANGE MADE STALE, AND WHAT REPLACED IT:
// verify/golden/g31-integrator-arm.mjs:613 used to argue that a G31 edit could
// not have caused a G10 failure because the suite ran one case at a time. That
// reason is gone. The schedule now "puts G31 in the `pool` group and G10 in the
// `chain` group", so the two DO overlap whenever FLOWMIC_GOLDEN_CONCURRENCY > 1.
// The comment there has been rewritten to rest on isolation instead of order —
// G31 brings its own saas server on an ephemeral port with a mkdtemp db, so the
// two share the CPU and nothing else. The same file also records that G10 is
// flaky on its own clock — 4 pass / 1 fail across six clean sequential runs —
// which is worth knowing before reading one pooled run as evidence about the
// pool.
//
// MEASURED on dev-pc-a (16C/32T), quiet box (another lane's flutter run was
// locked out for every reading), medians of three:
//   FLOWMIC_GOLDEN_CONCURRENCY=1 → 174.8 s  (reverse control: the pool is real)
//   FLOWMIC_GOLDEN_CONCURRENCY=4 →  65.6 s  ⇐ default when nothing is set
//   FLOWMIC_GOLDEN_CONCURRENCY=6 →  65.7 s
// All nine runs printed PASS=30 SKIPPED=2 FAIL=0 and exited 0.
//
// 🔴 4 AND 6 ARE THE SAME NUMBER, AND THAT IS THE INTERESTING PART: past three
// workers the suite is no longer bounded by the pool. Sequentially the cases
// cost 170.6 s in total, but two tasks own almost all of it — G32 at 61.4 s
// (its own header: `FLOWMIC_PLAN_LIMITS` takes integer minutes, so 60 s is the
// shortest ceiling the PRODUCTION config path can express) and the shared chain
// at 61.0 s, of which G28 alone is 39.3 s (GA-04's real grace window). Three
// workers already run those two side by side with one spare for the 48 s tail,
// so the floor is ~62 s + ~4 s of protocol/server-core build and no worker
// count goes under it. Making it faster from here means making G32 or G28 cheap,
// and both are refused for the reason each states in its own file.
// Per-case wall clock is on every row and the five slowest are printed under the
// summary, so the next person re-derives this instead of believing it.

import { existsSync } from 'node:fs';
import path from 'node:path';

// The wire helpers live in ONE place (verify/golden/harness.mjs) — see that
// file's header for why they were split out rather than copied. G13 imports the
// same definitions; a second `connect`/`ack`/`once` would be this repo's #1 bug
// shape pointed at its own harness.
import {
  ROOT, SERVER_CORE, SERVER_DIST, LAN, reachable,
  connect, ack, once, neverWithin, recordAll,
  run, startServer, startSaasServer, verifyRegisteredEmail,
  PASS, SKIP, FAIL, registerAndPair, terminalFrameWindowMs,
} from './harness.mjs';

// The deadlines G2/G3 wait on are the PRODUCT's, read from the product's own
// source — see terminalFrameWindowMs in harness.mjs for the CI failure that put
// them here and the measurements that sized them.
//
// 🔴 G10 USED TO BE ON THAT LIST AND IS NOT ANY MORE (2026-09-11, card G10-TIMING).
// It read `DEFAULT_ENGINE_SPAWN_TIMEOUT_MS` from src/stt/orchestrator-types.ts
// and waited spawn-cap + 2 s. MEASURED: that cap does not — and on this path
// CANNOT — govern the frame it was waiting for. See G10's own `MOBILE_TOLD_*`
// constant for the numbers; the short version is that the cap's timer is a
// `setTimeout` and sherpa-local's cold open blocks the event loop for seconds,
// so the cap never fires and the frame is a SUCCESS (`engine-status{ready}`),
// not the timeout failure the window was sized for.
const COMPOSE_SRC = 'src/compose/mode.ts';
// What a `requires` entry means, including the internal-only waiver. Same reason
// the wire helpers live in one place: the rule has ONE definition, and both this
// runner and scripts/opensource-export.mjs answer to it.
import { publicExportExclusions, resolveRequires, requirePath } from './requires.mjs';
// The declared skip budget (lane L4) — see that file's header for the rule and
// the measured seed. Data only; the enforcement lives in main()'s summary.
import { EXPECTED_SKIPS } from './expected-skips.mjs';
// Which cases may share the box, and the pool that lets them (card L3). Data +
// its drift checks live there; the narrative is this file's header.
import { planSchedule, resolveConcurrency, runPool } from './scenario-schedule.mjs';
import { G9 } from './g9-cloud-admission.mjs';
import { G10 } from './g10-record-only.mjs';
import { G11 } from './g11-console-surface.mjs';
import { G12 } from './g12-paired-phone-table.mjs';
import { G13 } from './g13-no-crosstalk.mjs';
import { G14 } from './g14-outbox-drain-crosstalk.mjs';
import { G15 } from './g15-cloud-image-policy.mjs';
import { G16 } from './g16-pc-presence.mjs';
import { G17 } from './g17-paddle-billing-chain.mjs';
import { G18 } from './g18-paddle-yearly-cycle.mjs';
import { G19 } from './g19-deferred-not-autoinjected.mjs';
import { G20 } from './g20-cloud-leg-roundtrip.mjs';
import { G21 } from './g21-pcid-cloud-pairing.mjs';
import { G22 } from './g22-settings-cross-channel.mjs';
import { G23 } from './g23-dom-inject-mode.mjs';
import { G24 } from './g24-billing-budget.mjs';
import { G25 } from './g25-web-room.mjs';
import { G26 } from './g26-site-demo.mjs';
import { G27 } from './g27-web-identity-dedup.mjs';
import { G28 } from './g28-web-room-release.mjs';
import { G30 } from './g30-payer-matrix.mjs';
import { G31 } from './g31-integrator-arm.mjs';
import { G32 } from './g32-continuous-minutes-cap.mjs';
import { G33 } from './g33-control-key-receipt.mjs';
import { G34 } from './g34-trial-cap-enforced.mjs';

// `AUDIO` left with G10 (card G10-TIMING) — it was this file's only reader.

// ── the eight golden paths ──────────────────────────────────────────────────
const GOLDEN = [
  {
    id: 'G1',
    name: 'first pairing + realtime (first config + realtime)',
    requires: [SERVER_DIST, path.join(ROOT, 'apps/mobile/test/integration_ptt_full_chain_test.dart')],
    async fn(url) {
      // Server-observable first-pairing chain: register → pair → settings:list adopt.
      const { pc, mobile } = await registerAndPair(url);
      const list = await ack(mobile, 'settings:list', {});
      if (!Array.isArray(list.items)) return FAIL('settings:list returned no items array');
      pc.disconnect(); mobile.disconnect();
      // Realtime STT + physical inject segments are LAN/interactive.
      const sttErr = await reachable(LAN.funasr);
      const notes = [];
      notes.push(sttErr ? `STT SKIPPED: ${LAN.funasr.label} unreachable (${sttErr})` : `STT engine reachable (real turn covered by apps/mobile integration test)`);
      notes.push('physical inject SKIPPED: no interactive desktop (apps/desktop/scripts/golden-smoke-r2-1b.mjs)');
      return PASS(`config+pair chain OK; ${notes.join('; ')}`);
    },
  },
  {
    id: 'G2',
    name: 'translate (translate: real-end emit + server never injects on its behalf + real LAN vLLM run)',
    // GA-01 rewrite. The old G2 called the compose module directly through
    // smoke-compose-lan and called the mode "green" — book 13 P7 in its purest
    // form: the harness stood in for the phone, so the thing it proved (compose
    // works) was not the thing it claimed (speak → translate → inject works). It passed for
    // months while translate mode injected the raw transcript.
    //
    // Now three legs, each honest about what it covers:
    //   ① WIRE (hermetic, always runs): a real in-process server + a sim mobile
    //      emitting the SAME compose:start the phone now emits. Asserts the
    //      server answers on the phone's own socket and — the invariant that
    //      matters — NEVER injects into the PC off the back of a compose.
    //   ② PHONE (evidence file, required below): the terminal-final → compose →
    //      inject-the-product fork with its red lines lives in the Dart contract
    //      test, driven through the REAL ChatController. This card refuses to
    //      re-enact it here with a Node stand-in; it names it instead.
    //   ③ MODEL (LAN, skips off-network): one real translate + organize turn.
    requires: [
      path.join(SERVER_CORE, 'scripts/smoke-compose-lan.mjs'),
      path.join(SERVER_CORE, COMPOSE_SRC),
      path.join(ROOT, 'apps/mobile/test/utterance_compose_test.dart'),
    ],
    async fn(url) {
      const { pc, mobile } = await registerAndPair(url);
      let wire;
      try {
        // ① The phone's compose:start shape (cross-checked byte-for-byte by
        // apps/mobile/test/wire_payloads_test.dart).
        const pcQuiet = neverWithin(pc, 'inject:request', 700);
        // COMPOSE_BUDGET_MS, not a literal: with the engine down this leg is
        // answered by the abort at that cap, and a shorter window called the
        // answer a silence. Free when the engine is up — the race settles early.
        const w = terminalFrameWindowMs(COMPOSE_SRC, 'COMPOSE_BUDGET_MS');
        const replyP = Promise.race([
          once(mobile, 'compose:done', w).then((d) => ({ done: d })).catch(() => null),
          once(mobile, 'compose:error', w).then((e) => ({ error: e })).catch(() => null),
        ]);
        mobile.emit('compose:start', {
          task: 'translate', source_text: '今天天气不错', source_lang: 'zh',
          target_lang: 'en', draft: true, request_id: 'u0-golden', entry_id: 'loc-golden',
        });
        const reply = await replyP;
        if (!reply) return FAIL('compose:start drew NEITHER compose:done nor compose:error (silent failure)');
        const echo = reply.done ?? reply.error;
        if (echo.request_id !== 'u0-golden' || echo.entry_id !== 'loc-golden') {
          return FAIL(`compose reply lost its correlation echo: ${JSON.stringify(echo)}`);
        }
        // The one invariant a compose must never break, engine up or down.
        if (!(await pcQuiet)) return FAIL('the server injected into the PC off a compose:start — the phone is the only author of a delivery');
        wire = reply.done ? 'compose:done' : `compose:error{${reply.error.code}}`;
      } finally {
        pc.disconnect(); mobile.disconnect();
      }
      // ③ the real model turn.
      const err = await reachable(LAN.vllm);
      if (err) return SKIP(`wire leg OK (${wire}, PC never injected); LAN model turn skipped — ${LAN.vllm.label} unreachable (${err})`);
      const { code, out } = await run('node', ['scripts/smoke-compose-lan.mjs'], { cwd: SERVER_CORE });
      if (code !== 0) return FAIL(`smoke-compose-lan exited ${code}`);
      if (/SMOKE SKIP/.test(out)) return SKIP(`wire leg OK (${wire}); LAN vLLM errored mid-turn`);
      if (!/SMOKE OK/.test(out)) return FAIL('smoke-compose-lan produced neither OK nor SKIP');
      return PASS(`wire leg: compose reply echoed + PC never injected (${wire}); phone leg: apps/mobile/test/utterance_compose_test.dart (10 cases, real ChatController); model leg: real translate+organize turn on LAN vLLM`);
    },
  },
  {
    id: 'G3',
    name: 'organize (organize: fail-loud on failure, never fall back to injecting the original transcript)',
    // The organize half of the same chain, aimed at the RED LINE rather than the
    // happy path: when compose fails there must be no injection at all — not the
    // product, and above all not the original transcript dressed up as one.
    requires: [
      path.join(SERVER_CORE, 'scripts/smoke-compose-lan.mjs'),
      path.join(SERVER_CORE, COMPOSE_SRC),
      path.join(ROOT, 'apps/mobile/test/utterance_compose_test.dart'),
    ],
    async fn(url) {
      const { pc, mobile } = await registerAndPair(url);
      try {
        const pcQuiet = neverWithin(pc, 'inject:request', 700);
        const w = terminalFrameWindowMs(COMPOSE_SRC, 'COMPOSE_BUDGET_MS');
        const replyP = Promise.race([
          once(mobile, 'compose:done', w).then((d) => ({ done: d })).catch(() => null),
          once(mobile, 'compose:error', w).then((e) => ({ error: e })).catch(() => null),
        ]);
        mobile.emit('compose:start', {
          task: 'organize', source_text: '嗯 就是那个 我们明天开会吧',
          source_lang: 'zh', draft: true, request_id: 'u1-golden', entry_id: 'loc-golden-2',
        });
        const reply = await replyP;
        if (!reply) return FAIL('organize compose:start drew no terminal frame at all (silent failure)');
        if (!(await pcQuiet)) return FAIL('an organize compose caused an injection the phone never asked for');
        const face = reply.done ? 'compose:done' : `compose:error{${reply.error.code}}`;
        const err = await reachable(LAN.vllm);
        if (err) return SKIP(`wire leg OK (${face}, zero injection); LAN model turn skipped — ${LAN.vllm.label} unreachable (${err})`);
        return PASS(`wire leg: ${face} with zero PC injection; the real organize turn rides the same smoke-compose-lan run as G2; the phone-side 「失败不回退注原文」 red line is pinned in apps/mobile/test/utterance_compose_test.dart`);
      } finally {
        pc.disconnect(); mobile.disconnect();
      }
    },
  },
  {
    id: 'G4',
    name: '5min long audio (5-min long audio)',
    requires: [path.join(SERVER_CORE, 'scripts/smoke-lan-stt.mjs')],
    async fn() {
      // A 5-minute real-mic run is an owner-realenv / real-audio segment; the
      // hard-limit auto-stop path (audio:auto-stopped{hard_limit}) is unit-tested.
      return SKIP('5-min real-audio run is owner realenv; hard-limit auto-stop path unit-tested (no headless 5-min fixture)');
    },
  },
  {
    id: 'G5',
    name: 'disconnect recovery (disconnect → reconnect)',
    requires: [SERVER_DIST],
    async fn(url) {
      const { pc, mobile, reg } = await registerAndPair(url);
      pc.disconnect();
      const pc2 = await connect(url, { token: reg.token });
      const recon = await ack(pc2, 'pc:reconnect', { token: reg.token });
      const ok = recon.room_uuid === reg.room_uuid && recon.pc_id === reg.pc_id;
      mobile.disconnect(); pc2.disconnect();
      return ok ? PASS('PC token-reconnect restored the same room + pc_id') : FAIL(`reconnect room/pc mismatch: ${JSON.stringify(recon)}`);
    },
  },
  {
    id: 'G6',
    // Renamed 2026-07-31 (window A): the old name said "settings broadcast + history
    // sync" and the body has NEVER asserted a single thing about history — it
    // emits settings:update and checks the peer PC hears settings:updated, full
    // stop. An over-claiming test NAME is worse than a missing test: the summary
    // line printed at the end of every run made it look like history sync had
    // golden coverage, so nobody went looking for it. (And this round retires
    // server-side history entirely, so the second half would have become a claim
    // about a flow that does not exist.) The name now says what it checks.
    name: 'multi-device sync (settings broadcast)',
    requires: [SERVER_DIST],
    async fn(url) {
      const { pc, mobile } = await registerAndPair(url);
      // settings:update of a STORED key from the PC → the paired mobile sees
      // settings:updated (save-on-change broadcast).
      // 2026-09-03: this used to push `stt.polish` FROM the mobile and expect the
      // PC to hear it. That key is PHONE-OWNED now (owner rulings, design D1):
      // it rides the phone's socket, is never stored and never broadcast — G22
      // asserts that contract on both legs. The broadcast mechanism itself is
      // unchanged, so it is driven here through a key that still stores (the
      // PC's scenario-inference override table), in the direction that still
      // exists: PC → phone.
      const updatedP = once(mobile, 'settings:updated');
      await ack(pc, 'settings:update', { key: 'scenario.inference.overrides', value: { golden: 'probe' } });
      const broadcast = await updatedP;
      const ok = broadcast && broadcast.key === 'scenario.inference.overrides'
        && broadcast.value && broadcast.value.golden === 'probe';
      pc.disconnect(); mobile.disconnect();
      return ok ? PASS('settings:update of a stored key fanned out to the paired phone (即改即存)') : FAIL(`no/incorrect settings:updated broadcast: ${JSON.stringify(broadcast)}`);
    },
  },
  {
    id: 'G7',
    name: 'mobile pairing end-to-end (register → code → pair → reconnect)',
    requires: [SERVER_DIST],
    async fn(url) {
      const { mobile, pair } = await registerAndPair(url);
      if (!/^fm_[0-9a-f]{64}$/.test(pair.mobile_token || '')) return FAIL('mobile:pair returned a malformed token');
      // Mobile token-reconnect keeps the pairing.
      mobile.disconnect();
      const m2 = await connect(url, { token: pair.mobile_token });
      const recon = await ack(m2, 'mobile:reconnect', { token: pair.mobile_token });
      m2.disconnect();
      const ok = recon && recon.room_uuid === pair.room_uuid;
      return ok ? PASS('short-code pair → token → mobile:reconnect kept the room') : FAIL(`mobile:reconnect room mismatch: ${JSON.stringify(recon)}`);
    },
  },
  {
    id: 'G8',
    name: 'flow-message relay (control:key relay, renamed WP-R0-1)',
    requires: [SERVER_DIST],
    async fn(url) {
      // "flow-message" is the pre-rename legacy name; the discrete control-key relay
      // ships as control:key (mobile → server → PC). This drives the real relay.
      const { pc, mobile } = await registerAndPair(url);
      const relayedP = once(pc, 'control:key');
      await new Promise((r) => setTimeout(r, 20));
      mobile.emit('control:key', { kind: 'enter' });
      const relayed = await relayedP.catch(() => null);
      pc.disconnect(); mobile.disconnect();
      return relayed && relayed.kind === 'enter'
        ? PASS('mobile control:key{enter} relayed to the PC (the renamed flow-message path)')
        : FAIL('control:key was not relayed to the PC');
    },
  },
  // Card VERIFY-1 (2026-08-11): G9's gate step pushed this file past the
  // 800-line cap — split VERBATIM into its own module, the G11/M1 precedent.
  G9,
  // card G10-TIMING (2026-09-11) moved G10 into its own module — the measured
  // account of why its window was wrong is longer than the case, and this file
  // was at the 800-line cap. Same remedy as G9/G11/G13–G20, body VERBATIM.
  G10,
  // card M1 (0.3.0) pushed step 6 past a paragraph of explanation and this file past
  // its 800-line cap, so G11 moved into its own module — same reason as G13–G20,
  // and the body went over VERBATIM. Cap breach fixed by SPLITTING, never by
  // deleting the reasoning (0.2.52 §5 set that precedent on two Dart files).
  G11,
  G12,
  // 🔴 The owner's "life-or-death line" regression. Lives in its own module because this
  // file is at its 800-line cap (see harness.mjs's header).
  G13,
  // card B4-2 (2026-08-01): the queue-drain shape of the same red line — four
  // pc_id, two channels alive at once, drain-shaped batches + a frozen
  // cross-channel address + HTTP retry idempotency. Own module for the same
  // 800-line-cap reason as G13.
  G14,
  // card B4-9 / RV-87 (2026-08-01, owner "the server uniformly intercepts the client"): the cloud relay's
  // image policy over a REAL saas server — 1 MiB refused by name, 200 pictures
  // per 24 h enforced, both with the PC's silence asserted at frame level. Own
  // module for the same 800-line-cap reason as G13/G14.
  G15,
  // card B4-14 / RV-98 (2026-08-01, owner "must correctly show whether the PC side is online"): does a REAL
  // PC leaving a REAL room actually change what a REAL http request answers — on
  // standalone AND on the relay. Own module for the same 800-line-cap reason.
  G16,
  // window D1 / Lane E (2026-08-01): the COLLECTION chain — a signed Paddle webhook
  // reaching a real saas server and coming out the other side as the number the
  // quota gate enforces, with both reverse controls (a body altered in flight, a
  // stale timestamp) asserted on STATE rather than on a status code. Own module
  // for the same 800-line-cap reason as G13/G14/G15.
  G17,
  // window D1 / Lane H (2026-08-01, owner "test yearly first… do not ship it in the first or second release stage"):
  // the ANNUAL half of that chain — owner's two real sandbox annual prices land on
  // the right tiers with cycle 'yearly' and an expiry a YEAR out (the failure it
  // guards is silent for four weeks and then downgrades someone who paid for a
  // year), with a monthly discriminator on the same instance and a reverse control
  // proving "not configuring a price is equivalent to not shipping it" is a real mechanism rather than an
  // intention. Own module because G17 already stands at 630 of the 800-line cap.
  G18,
  // card L8 (2026-08-02, owner "deferred-redelivery messages must not auto-inject"): the DEPLOY GATE for that
  // ruling. `inject_origin` is an additive optional field, and zod STRIPS unknown
  // keys — so a relay older than 0.2.48 deletes it in flight and every deferred redelivery keeps
  // auto-injecting, silently, with every other test still green (`duration_ms`
  // paid for this lesson one round earlier). This path fails RED on that exact
  // state. It deliberately does NOT claim the desktop half — its "PC" is a bare
  // socket client with no injection pipeline; that half is Rust
  // (inject/pipeline_tests.rs + socket/inject_ops.rs inline), and the PASS line
  // says so. Own module for the same 800-line-cap reason as G13/G14/G15.
  G19,
  G20,
  G21,
  // G2 cross-channel settings convergence. Own module, same 800-line-cap reason —
  // and it is the only path that needs a standalone AND a saas server alive at the
  // same moment, because the divergence it asserts on cannot exist inside one KV.
  G22,
  // S2-03 — the `mode:'dom'` receipt a FLOWMIC-WEB target sends. Own module for
  // the same 800-line-cap reason as G13-G22. It is the only path whose CENTRAL
  // assertion is a NEGATIVE one about the relay (an off-enum mode reaches nobody),
  // because the addendum that specified the card claimed the opposite and the
  // deploy order depends on which is true.
  G23,
  // card S2-02 — the budget meter: pushed at join and at every press, moving
  // while somebody speaks, reaching zero, and the relay ending the recording
  // itself. Own module for the same 800-line-cap reason as G13/G14/G15, and it
  // needs no vendor engine (see its header), so it never SKIPs.
  G24,
  // card S2-04 — the browser target's room: minted by an HTTP POST, entered by
  // `pc:reconnect`, paired into by a phone, and carrying an utterance. Here
  // rather than in a unit test because the claim spans two protocols and four
  // modules that each have to agree about one row (see its header).
  G25,
  // card M4-01 — the site demo end to end: an anonymous identity, its room, a
  // phone pairing in, `budget.mode:'trial'` on every surface that carries it,
  // and the meter stopping the recording. Here rather than in a unit test
  // because that one field is the ONLY way either end knows it is a demo, and
  // it is derived five layers away from where it is rendered (see its header).
  G26,
  // card ID-3 — the relay half of web-client identity dedup: a stable
  // device_uid keeps a browser tab's pairing to ONE row across reconnect,
  // re-pair, and revoke-then-re-pair, over the real server. Own module for
  // the same 800-line-cap reason as G13/G14/G15. It needs no vendor engine,
  // so it never SKIPs.
  G27,
  // card R-2 — how fast the relay frees a room when a web client parks vs
  // when its TCP connection is merely destroyed: a deliberate close collapses
  // GA-04's grace window (<1s to pc:mobile-left, no ReleaseSuppression armed,
  // A's own return is never PAIR_RELEASED); a destroyed socket runs the full
  // grace window before pc:mobile-left, even though — measured, not assumed,
  // see the file's own header — admission of a NEW device_uid is gated by
  // socket.connected alone and is NOT delayed by that same window. No vendor
  // engine, so it never SKIPs.
  G28,
  // 🔴🔴 G29 IS GONE — RETIRED 2026-09-11 BY CARD MP-6, NOT LOST. Its whole
  // subject was 「an UNSIGNED BROWSER paired to somebody's REAL computer spends
  // its OWN two minutes at `mode:'trial'`, not the owner's month」, and owner
  // §11 removed that sentence from the product: an unsigned guest on a real
  // desktop is now billed to the DESKTOP'S OWNER (`resolvePayer` step 4,
  // reason 'peer'), mints no trial identity at all
  // (`auth/web-trial-identity.ts` mints for `'demo'` rooms and nowhere else),
  // and is told `mode:'plan'`. Every one of that file's fourteen sections
  // asserted the superseded half.
  //
  // 🔴 IT IS DELETED RATHER THAN LEFT REGISTERED-AND-WEAKENED, which is this
  // repo's rule for a cancelled flow: either the flow goes, or the reason it
  // is kept is written where it stood. A file repointed at the demo room would
  // have been a second, thinner copy of G26 — and 「two goldens about one
  // behaviour」 is how one of them quietly stops being maintained.
  //
  // WHERE ITS LIVE COVERAGE WENT, so nobody has to reconstruct this:
  //   · 「an unsigned guest on a real desktop is billed to the owner, mints no
  //     trial row, and the owner's frame carries `guest_speaker`」 → G30 §7.
  //   · 「a trial view exists, says `mode:'trial'`, carries `resets_at:null`
  //     and NR-31's `free_plan_minutes` off the EFFECTIVE plan table, and is
  //     absent from every `mode:'plan'` view」 → G26 §8 and §14. The demo room
  //     is now the only room kind that has a trial at all, so that is also the
  //     only place those assertions can live.
  //   · 「the same browser continues on the grant it already has; a different
  //     browser starts fresh; exactly one anonymous row per browser」 → G26
  //     §7 and §12, and G27 for the pairing-row dedup half.
  //   · 「QTA-2 still gates on the PC owner's ledger」 → G30 §5, which drives it
  //     with a SIGNED-IN phone. G29's version drove it with an unsigned
  //     visitor, and under MP-6 that visitor is metered to the owner anyway —
  //     so the refusal would have arrived from the FIRST gate and proved
  //     nothing about the second.
  //
  // ⚠️ ONE THING IS GENUINELY UNCOVERED AND IS NAMED HERE RATHER THAN DROPPED:
  // card NR-29's mobile-slot exemption. G29 §11 was its only end-to-end proof,
  // and MP-6 changed what it covers — `willMint` now answers true only inside a
  // demo room, so an unsigned browser on a REAL desktop takes one of the
  // owner's handset slots again. That may well be right (the owner is paying
  // for that visitor now), but it is a behaviour change nobody asserted, and a
  // deleted file is exactly where such a thing disappears without a trace.
  G30,
  // card MP-1 — the third-party host arm. Its own file rather than five more
  // sections in G30: that one stands at 787 of the 800-line cap, and it asks a
  // different question (「which branch chose this payer」 vs 「does the integrator
  // ARM exist and does its ceiling stop a recording」).
  G31,
  // card G-8 — the per-tier SITTING LENGTH ceiling, enforced by the relay. Its
  // own file rather than a section of G24: that case spends an account to zero
  // and asks 「does the MONEY wall work」, while this one deliberately leaves the
  // money untouched and asks 「does the LENGTH wall work」 — the two ceilings are
  // the pair `billing/session-cap.ts` exists to keep apart.
  // ⚠️ It costs about a minute of wall clock and says why in its own header:
  // `FLOWMIC_PLAN_LIMITS` takes integer minutes, so 60 s is the shortest ceiling
  // the PRODUCTION config path can express — and going around that path is the
  // one thing that would stop this case from being able to fail for the original
  // reason.
  G32,
  // card MP-14 — the receipt `control:key` never had. Its own file rather than a
  // section of G23: that one asks whether a DELIVERY verdict survives the relay
  // verbatim, this one asks whether a KEYPRESS can be refused out loud at all.
  // The two frames are deliberately different events for the same reason
  // (a keypress has no row, no text and no mode), so their paths are too.
  G33,
  // The anonymous visitor's 120 s, on its ENFORCEMENT face. Its own file rather
  // than a section of G26 for the reason its header gives: G26 seeds the DEMO
  // ACCOUNT down and refuses on the payer's month, so it is green with the
  // per-browser gate deleted. This one leaves the payer a whole month and spends
  // only the browser's grant, so the only ceiling in its room is the one owner's
  // 2026-09-16 default-on ruling put between a stranger and our engines.
  G34,
];

async function main() {
  // ── ALWAYS BUILD, NEVER "build only if missing" (0.2.29, gate blind spot) ────────
  //
  // This spawns `dist/index.js`, so what golden actually tests is a BUILD, not the
  // source anyone just edited. The old rule here was "missing dist → build it",
  // which means a dist that merely became STALE was used as-is — and the result is
  // a verdict about the PREVIOUS build wearing this run's name.
  //
  // BOTH DIRECTIONS ARE REAL AND BOTH HAPPENED IN ONE AFTERNOON:
  //   · FALSE RED — the desktop lane ran golden while the server lane's new
  //     `target_pc_id` check was in src but not yet in dist. G13 failed on a
  //     correct implementation, and the failure named the red line, so the first
  //     reading was "the no-crosstalk gate is broken". It was not.
  //   · FALSE GREEN — the same staleness passes a server change that was never
  //     executed, which is the 0.2.22 lesson (`server-core` consumes protocol's
  //     `dist`, not `src`; a new zod field was stripped by an old dist and an
  //     assertion that should have failed passed).
  // `verify:types` cannot catch either — CORRECTED 2026-08-19: this line used to
  // say "tsc reads `src` through path mappings", a second live copy of the wrong
  // mechanism CLAUDE.md debunked on 2026-08-07. Measured again on this machine
  // (`tsc --noEmit --traceResolution` in apps/server-core): `@flowmic/protocol`
  // resolves to `packages/protocol/dist/index.d.ts` — there are no path mappings
  // anywhere. So tsc is not blind because it bypasses dist; it type-checks the
  // SAME stale dist, which is worse: a stale contract makes types green too.
  // Since 2026-08-19 `verify:delivery` builds protocol at the head of the chain
  // (`verify:protocol-dist`, mirroring .github/workflows/verify.yml's "Build
  // protocol" step) — this per-run rebuild stays because `pnpm golden` also runs
  // standalone, and because server-core's dist embeds protocol's.
  //
  // So the freshness rule stops being a discipline someone has to remember —
  // CLAUDE.md already carries that discipline in writing, and it has now been
  // missed twice. Both packages are built every run: protocol first, because
  // server-core's dist embeds it. ~10 s on a gate that already takes ~20 s, in
  // exchange for the run being ABOUT the code in the working tree.
  //
  // -- THE ONE WAY TO SKIP HALF OF IT, AND WHY (2026-09-12) -----------------
  // `FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT=1` means: the caller built
  // `packages/protocol` from THIS tree moments ago and is running other lanes
  // that are reading `packages/protocol/dist` RIGHT NOW. Rebuilding it here
  // would have tsup delete and rewrite those files under a concurrent
  // `tsc --noEmit` or vitest -- a false red with no relation to the product.
  //
  // Only verify/run-delivery-fast.mjs sets it, and only after its Stage 0
  // barrier ran `pnpm verify:protocol-dist` to completion. `pnpm golden` on
  // its own, `verify:delivery`, and CI never set it, so the freshness rule
  // above is untouched on every path a release takes.
  //
  // THE FLAG IS ABOUT PROTOCOL ONLY. server-core's dist is still rebuilt here
  // every run, unconditionally: it is what `startServer()` spawns, no other
  // lane touches it, so there is nothing to race and no reason to trust
  // anyone else to have built it. A flag that skipped BOTH would be one env
  // var away from golden reporting on a build nobody made.
  const protocolPrebuilt = process.env.FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT === '1';
  const toBuild = protocolPrebuilt
    ? ['@flowmic/server-core']
    : ['@flowmic/protocol', '@flowmic/server-core'];
  process.stdout.write(
    protocolPrebuilt
      ? '[golden] building @flowmic/server-core (dist is what golden runs); @flowmic/protocol was already built from this tree by the caller (FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT=1) …\n'
      : '[golden] building @flowmic/protocol + @flowmic/server-core (dist is what golden runs) …\n'
  );
  for (const pkg of toBuild) {
    const { code } = await run('pnpm', ['--filter', pkg, 'build']);
    if (code !== 0) {
      // Loud, not silent: a build failure here makes every server-dependent G
      // meaningless, and a summary of FAILs with no stated cause is the worst
      // possible shape — it looks like the product broke.
      process.stdout.write(`[golden] BUILD FAILED for ${pkg} — every server-dependent G below is about a STALE build (or none). Fix the build first; do not read the results.\n`);
    }
  }
  if (!existsSync(SERVER_DIST)) {
    process.stdout.write('[golden] server dist still missing after build — every server-dependent G will FAIL.\n');
  }

  let server = null;
  let url = null;
  try {
    if (existsSync(SERVER_DIST)) {
      server = await startServer();
      url = `http://localhost:${server.port}`;
      process.stdout.write(`[golden] real server up on ${url}\n`);
    }
  } catch (e) {
    process.stdout.write(`[golden] server failed to start: ${e.message}\n`);
  }

  // null ⇒ this tree came out of the exporter (the manifest excludes itself).
  // Read once: every G asks the same question about the same tree.
  const exclude = await publicExportExclusions();

  const byId = new Map(); // G id → result. Printed from GOLDEN, never from this.
  const waivers = new Map(); // G id → [{rel, why}] — printed by name in the summary

  // One case, start to finish, INCLUDING its precondition checks — so the ms a
  // row reports is the wall clock the suite actually spent on it, not just the
  // part inside `fn`.
  const runOne = async (g) => {
    const t0 = Date.now();
    const done = (r) => byId.set(g.id, { ...g, ...r, ms: Date.now() - t0 });
    const { missing, waived, drift } = resolveRequires(g.requires, exclude);
    if (drift.length > 0) {
      // The declaration and opensource-manifest.mjs disagree. Not a product
      // failure — a contract failure — so it is named as one instead of hiding
      // inside "missing required file(s)".
      return done(FAIL(`\`requires\` contract violation:\n           · ${drift.join('\n           · ')}`));
    }
    // A missing file counts as FAIL, never a silent pass.
    if (missing.length > 0) return done(FAIL(`missing required file(s): ${missing.join(', ')}`));
    if (waived.length > 0) waivers.set(g.id, waived);
    const needsServer = (g.requires ?? []).some((e) => requirePath(e) === SERVER_DIST);
    if (needsServer && !url) return done(FAIL('real server unavailable (build/start failed)'));
    try {
      return done(await g.fn(url));
    } catch (e) {
      return done(FAIL(`threw: ${e.message}`));
    }
  };

  const { chain, pool, notes } = planSchedule(GOLDEN);
  const { n: concurrency, note: concurrencyNote } = resolveConcurrency();
  if (concurrencyNote) process.stdout.write(`[golden] ${concurrencyNote}\n`);
  for (const note of notes) process.stdout.write(`[golden] SCHEDULE: ${note}\n`);
  process.stdout.write(
    `[golden] ${chain.length} case(s) share the one standalone server and run in table order as a single chain; `
    + `${pool.length} start their own servers; at most ${concurrency} of these ${pool.length + 1} tasks run at once `
    // The parenthetical is a HINT about a value you could set, not a report
    // of the value in force - `at most N` above is the one in force. Spelled
    // out because a reader who takes it as a report will attribute a POOLED
    // run's wall clock to a sequential one, and mis-reading your own ruler is
    // this repo's second headline failure shape.
    + '(set FLOWMIC_GOLDEN_CONCURRENCY=1 for a fully sequential run)\n');

  // The chain is ONE task in the same pool, so `concurrency` is the number of
  // cases in flight for the whole suite rather than for half of it.
  const chainTask = async () => { for (const g of chain) await runOne(g); };
  await runPool([chainTask, ...pool.map((g) => () => runOne(g))], concurrency);

  const results = GOLDEN.map((g) => byId.get(g.id) ?? { ...g, ...FAIL('never ran — the scheduler dropped it'), ms: 0 });

  if (server) server.child.kill();

  // ── summary table ──
  const icon = { PASS: 'PASS   ', SKIPPED: 'SKIPPED', FAIL: 'FAIL   ' };
  process.stdout.write('\n══════════════════════════ GOLDEN PATH SUMMARY ══════════════════════════\n');
  // The `(N ms)` on every row is the whole point of being able to read this
  // suite's cost at all: before card L3 the runner printed one summary at the
  // end and NOTHING said which case spent the time, so the only way to find the
  // expensive ones was to instrument it from outside (the 2026-09-13 cost
  // ledger had to give up and report five checkpoints for 32 cases).
  const ms = (r) => `(${String(r.ms ?? 0).padStart(6)} ms)`;
  for (const r of results) {
    process.stdout.write(`  ${r.id}  ${icon[r.status]}  ${ms(r)}  ${r.name}\n`);
    if (r.reason) process.stdout.write(`        └─ ${r.reason}\n`);
    // A waived requirement is NOT allowed to be invisible. Same `SKIP: <reason>`
    // vocabulary as scripts/run-script-tests.mjs, printed under the G it belongs
    // to, naming the file and quoting the declared reason verbatim.
    for (const w of waivers.get(r.id) ?? []) {
      process.stdout.write(`        └─ SKIP: required file ${w.rel} is absent — ${w.why}\n`);
    }
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  // ── the skip budget (lane L4; rule + measured seed in expected-skips.mjs) ──
  // Matched on (id, printed reason): a declared G skipping with a differently-
  // shaped reason is as undeclared as a new G skipping at all — the shape
  // drifting is exactly the signal a broken probe would give.
  const undeclared = results.filter(
    (r) => r.status === 'SKIPPED'
      && !EXPECTED_SKIPS.some((e) => e.id === r.id && e.reason.test(r.reason ?? '')),
  );
  for (const u of undeclared) {
    process.stdout.write(`  UNDECLARED SKIP  ${u.id}  ${u.name}\n`);
    process.stdout.write(`     └─ reason: ${u.reason ?? '(none printed)'}\n`);
    process.stdout.write(
      `     └─ this case was supposed to prove: ${u.name}. A skip not declared in\n`
      + `        verify/golden/expected-skips.mjs is indistinguishable from a broken\n`
      + `        probe — fix what stopped the case from running, or declare the skip\n`
      + `        there with its reason and why it is environment-bound.\n`,
    );
  }
  process.stdout.write('──────────────────────────────────────────────────────────────────────────\n');
  // Five slowest, because under a pool the suite's wall clock is the LONGEST
  // task and not the sum — so "what would make this faster" is a question about
  // these five and nothing else. ⚠️ Two of them are meant to be there: G32
  // spends a real minute (integer-minute plan limits) and G28 spends GA-04's
  // real grace window; each says so in its own header. Shortening those is
  // refused, not pending.
  const slowest = [...results].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5);
  process.stdout.write(`  slowest 5: ${slowest.map((r) => `${r.id} ${((r.ms ?? 0) / 1000).toFixed(1)}s`).join('  ')}\n`);
  process.stdout.write(`  PASS=${n('PASS')}  SKIPPED=${n('SKIPPED')}  FAIL=${n('FAIL')}  (total ${results.length})\n`);
  if (undeclared.length > 0) {
    process.stdout.write(`  ✗ ${undeclared.length} UNDECLARED skip(s) — the gate fails (see the lines above).\n`);
  }
  const waivedTotal = [...waivers.values()].reduce((sum, w) => sum + w.length, 0);
  if (waivedTotal > 0) {
    // Deliberately NOT folded into the PASS/SKIPPED/FAIL tally: the G itself did
    // run, in full. What was waived is an evidence cross-link, and losing that
    // link is a much smaller loss than losing the assertions would be — so the
    // fact gets its own line rather than a status it would misrepresent.
    process.stdout.write(
      `  ⚠ ${waivedTotal} required file(s) waived as internal-only. This tree has no\n` +
      '    scripts/opensource-manifest.mjs — which that manifest excludes from itself — so this is\n' +
      '    an EXPORTED public tree. Each waiver is named above with its reason. They are evidence\n' +
      '    cross-links, not test inputs: every assertion of those paths still ran.\n');
  }
  process.stdout.write('══════════════════════════════════════════════════════════════════════════\n');

  process.exit(n('FAIL') > 0 || undeclared.length > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`[golden] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
