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
//   • Exit non-zero iff any G FAILs. SKIPPED never fails the gate.
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

// The deadlines G2/G3/G10 wait on are the PRODUCT's, read from the product's own
// source — see terminalFrameWindowMs in harness.mjs for the CI failure that put
// them here and the measurements that sized them.
const COMPOSE_SRC = 'src/compose/mode.ts';
const STT_SPAWN_SRC = 'src/stt/orchestrator-types.ts';
// What a `requires` entry means, including the internal-only waiver. Same reason
// the wire helpers live in one place: the rule has ONE definition, and both this
// runner and scripts/opensource-export.mjs answer to it.
import { publicExportExclusions, resolveRequires, requirePath } from './requires.mjs';
import { G9 } from './g9-cloud-admission.mjs';
import { G11 } from './g11-console-surface.mjs';
import { G13 } from './g13-no-crosstalk.mjs';
import { G14 } from './g14-outbox-drain-crosstalk.mjs';
import { G15 } from './g15-cloud-image-policy.mjs';
import { G16 } from './g16-pc-presence.mjs';
import { G17 } from './g17-paddle-billing-chain.mjs';
import { G18 } from './g18-paddle-yearly-cycle.mjs';
import { G19 } from './g19-deferred-not-autoinjected.mjs';
import { G20 } from './g20-cloud-leg-roundtrip.mjs';
import { G21 } from './g21-pcid-cloud-pairing.mjs';

const AUDIO = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

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
      // settings:update from mobile → PC sees settings:updated (save-on-change broadcast).
      const updatedP = once(pc, 'settings:updated');
      // WP-R4-6 made stt.polish a REAL typed key ({enabled:boolean}, read at
      // audio:start) — a bare `true` would poison the shared standalone user's
      // later audio:start snapshots, so the round-trip uses the valid OFF shape.
      await ack(mobile, 'settings:update', { key: 'stt.polish', value: { enabled: false } });
      const broadcast = await updatedP;
      const ok = broadcast && broadcast.key === 'stt.polish'
        && broadcast.value && broadcast.value.enabled === false;
      pc.disconnect(); mobile.disconnect();
      return ok ? PASS('settings:update fanned out to the peer PC (即改即存)') : FAIL(`no/incorrect settings:updated broadcast: ${JSON.stringify(broadcast)}`);
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
  {
    id: 'G10',
    name: 'record-only → kept locally → deferred redelivery (record-only, no fan-out, later re-inject)',
    requires: [SERVER_DIST, path.join(SERVER_CORE, STT_SPAWN_SRC)],
    async fn(url) {
      // §6.4 headline narrative: an utterance the user keeps on the phone (delivery:'none')
      // is NEVER injected — the server must not fan the audio:start out to the PC
      // (the record-only red line). Later the same entry is deferred-redelivered via inject:request
      // and THEN the delivery truth chain runs: PC gets the request, replies
      // inject:result, and the row's status flips noted → injected. Hermetic:
      // standalone in-process server, sim PC + sim mobile, no LAN / no real STT.
      const { pc, mobile, reg, pair } = await registerAndPair(url);
      try {
        // 1. RED LINE — delivery:'none' says "keep it on the phone": the PC must
        //    receive NO audio:start fan-out (STT engine is unwired here; the
        //    fan-out gate runs BEFORE that, so this asserts the gate, not STT).
        //    GA-02 widened this from "zero audio fan-out" to "zero audio AND zero
        //    stt:* fan-out": the content leg used to cross unconditionally.
        //    Honest scope note (book 13 P7 — no stand-in coverage): this hermetic run
        //    has no STT engine, so the frames that really fly here are audio:start
        //    (gated in audio.handler) and the fail-loud stt:error (emitted straight
        //    at the mobile socket). Those two are asserted below for real. The
        //    stt:interim / stt:final / stt:level content leg cannot be produced
        //    without an engine, so it is asserted on the PRODUCTION seam itself —
        //    makeSttEmitter, every frame the bridge can send — in
        //    apps/server-core/test/audio-fanout.test.ts (GA-02 describe block).
        //    A LAN-engine end-to-end version is an owner-realenv item (GA-24).
        //    🔴 UPGRADED 2026-07-31 (card G) FROM AN EVENT-NAME LIST TO A RED LINE.
        //    Everything above is an allow-list of names that must not arrive, and
        //    an allow-list only ever guards the names somebody thought of. The
        //    rule owner stated is "'record-only' entries are unconditionally not synced to the PC" — not one character may
        //    reach the PC — so the assertion is now written against the FRAMES: across
        //    the whole record-only window (the audio:start below AND the
        //    history:create in step 2, which is the only place this run's text
        //    ever crosses the server at all), the PC socket must receive NOTHING,
        //    under any event name. A future fan-out invented for record-only
        //    entries fails here even though nobody added it to the list.
        //    The recorder stays armed into step 3 on purpose — see the probe
        //    control there, which is what keeps this silence from being vacuous.
        const pcFrames = recordAll(pc);
        const pcQuietP = neverWithin(pc, 'audio:start', 500);
        const pcSttQuietP = Promise.all(
          ['stt:interim', 'stt:final', 'stt:level', 'stt:error', 'stt:engine-status', 'audio:auto-stopped']
            .map((e) => neverWithin(pc, e, 500).then((quiet) => (quiet ? null : e))),
        );
        // The mobile MUST still be told what is happening on its own session
        // (withholding from the PC is not the same as swallowing: no silent failure
        // cuts both ways). Either face counts: stt:engine-status{failed} or the
        // terminal stt:error.
        // 🔴 CORRECTED 2026-08-07 — the sentence that used to stand here said
        // "the ladder speaks first and the terminal error only lands after the
        // 1/2/4s ×3 retry ladder". Measured on dev-pc-a: FALSE, and it
        // is what made 2500ms look sufficient. A cold-connect failure never
        // reaches the ladder at all — orchestrator-core.ts holds `engineOpening`
        // for the whole of engine.open(), so the spawn cap owns the verdict:
        // BOTH frames arrive together at 5007ms, with no `retry_count` and not
        // one `reconnecting` in between. Nothing is emitted before that cap, so
        // a window under it can only ever report a silence that isn't there.
        // (anti-façade ④: a comment asserting behaviour elsewhere is an assertion,
        // and this one had gone stale into a load-bearing wrong answer.)
        const w = terminalFrameWindowMs(STT_SPAWN_SRC, 'DEFAULT_ENGINE_SPAWN_TIMEOUT_MS');
        const mobileToldP = Promise.race([
          once(mobile, 'stt:engine-status', w).catch(() => null),
          once(mobile, 'stt:error', w).catch(() => null),
        ]);
        mobile.emit('audio:start', { ...AUDIO, delivery: 'none' });
        if (!(await pcQuietP)) return FAIL('delivery:none leaked an audio:start fan-out to the PC (record-only red line)');
        const leaked = (await pcSttQuietP).filter(Boolean);
        if (leaked.length) return FAIL(`delivery:none leaked ${leaked.join(', ')} to the PC (内容根本没去 PC red line)`);
        if (!(await mobileToldP)) return FAIL('record-only utterance failed on the server but the MOBILE was told nothing (silent failure)');

        // 2. kept locally — REWRITTEN 2026-07-31 (0.2.27, owner architecture ruling no-cloud-sync).
        //    This used to assert a server row with status:'noted'. "Local" now means what
        //    the word says — the phone owns it, the server stores nothing — so what is
        //    worth asserting flipped: not "the row was created" but "the server said so
        //    OUT LOUD". Retiring an event by unregistering it is a silent drop (red line);
        //    the handler stays and refuses.
        const nowIso = new Date().toISOString();
        const entryId = 'g10-noted-entry';
        const spoken = '这句话留在手机上';
        const item = {
          id: entryId, pairing_id: pair.pairing_id ?? null, pc_device_id: reg.pc_id,
          user_id: 'default', mobile_id: null, mode: 'realtime',
          source_text: spoken, source_lang: 'zh', output_text: spoken, output_lang: null,
          duration_ms: null, segments_count: 0, status: 'noted', edited: false,
          created_at: nowIso, updated_at: nowIso,
        };
        const created = await ack(mobile, 'history:create', { item });
        if (created === undefined) return FAIL('history:create was SILENTLY DROPPED (no ack at all) — retiring an event by unregistering it is the red line');
        // The specific wrong answer, pinned so it can never come back: a 0.2.26 phone
        // hard-codes SETTINGS_SYNC_FAIL into "the other side deleted this row" and DELETES the local row
        // (timeline_sync.dart → timeline_store.removeDeletedByPeer). Reusing that code
        // to report a server-side retirement would destroy the user's own record and
        // tell them a peer did it. Two questions, one wire answer — this repo's #1 bug.
        if (created?.error === 'SETTINGS_SYNC_FAIL') return FAIL('retirement answered with the code the phone turns into a local DELETE (SETTINGS_SYNC_FAIL)');
        if (created?.error !== 'HISTORY_SYNC_RETIRED') return FAIL(`history:create should be refused with HISTORY_SYNC_RETIRED, got: ${JSON.stringify(created)}`);

        // 🔴 2b. THE RED LINE, read now that the whole record-only window is over:
        //     the PC received not one frame of any kind while the user kept this
        //     utterance on the phone. Stated as "zero frames" rather than "zero
        //     frames carrying the text" deliberately — the text only exists on the
        //     wire during history:create here, so a text-only probe would be silent
        //     about a fan-out that announces the entry without quoting it (that is
        //     precisely what the retired `history:updated` did).
        if (pcFrames.frames.length > 0) {
          return FAIL(`a delivery:'none' utterance put ${pcFrames.frames.length} frame(s) on the PC socket: ${pcFrames.frames.map((f) => f.event).join(', ')} — 「仅记录」条目无条件不同步 PC`);
        }

        // 3. deferred redelivery — the mobile re-injects the kept entry; the PC receives it with
        //    the entry_id echoed verbatim (A-58 exact correlation, no FIFO drift).
        const injReqP = once(pc, 'inject:request');
        // 0.2.33: `target_pc_id` is mandatory — an unaddressed frame is refused
        // (INJECT_PC_UNSPECIFIED) and would never reach the PC, so a deferred redelivery that omits
        // it would fail this step for a reason that has nothing to do with deferred redelivery.
        // The address a real phone writes is the `pc_id` from its pairing ack; G13
        // owns the addressing verdicts themselves.
        mobile.emit('inject:request', { text: spoken, source: 'history', entry_id: entryId, target_pc_id: pair.pc_id });
        const injReq = await injReqP;
        if (injReq.entry_id !== entryId || injReq.text !== spoken) return FAIL(`补投 inject:request mis-echoed to PC: ${JSON.stringify(injReq)}`);
        // ⚠️ THE PROBE'S OWN CONTROL, on the SAME recorder that reported the
        //    silence above. A recorder that sees nothing because it is wired to
        //    nothing reports a perfect red line forever. Here it is looking at a
        //    frame that DID arrive, carrying the very sentence step 2b said had
        //    not: if this is empty, the "zero frames" assertion above proved nothing.
        if (pcFrames.carrying(spoken).length === 0) {
          return FAIL('the recorder that reported 「零帧」 cannot see a frame that DID carry the sentence — that assertion is vacuous');
        }

        // 4. Delivery truth — PC reports the outcome and the MOBILE hears it with the
        //    same entry_id. This step is unchanged and it is now where the whole
        //    delivery truth lives: the phone owns the row, so the echo IS the record.
        const injResP = once(mobile, 'inject:result');
        pc.emit('inject:result', { ok: true, entry_id: entryId, mode: 'sendinput' });
        const injRes = await injResP;
        if (injRes.ok !== true || injRes.entry_id !== entryId) return FAIL(`inject:result truth-chain inconsistent: ${JSON.stringify(injRes)}`);

        // 5. The server keeps NOTHING. The old step 5 read the row back and asserted
        //    noted→injected; that moved to step 4's echo (the phone is the owner). What
        //    is left to prove is the negative, and over the WIRE rather than by reading
        //    the DB: a read that answers with a CODE cannot quietly answer with an empty
        //    page, which would look identical to "you have no records" (0.2.26's web console).
        const list = await ack(mobile, 'history:list', {});
        if (list === undefined) return FAIL('history:list was SILENTLY DROPPED (no ack at all)');
        if (Array.isArray(list?.items)) return FAIL(`history:list still returns a page — the server is still serving history: ${JSON.stringify(list)}`);
        if (list?.error !== 'HISTORY_SYNC_RETIRED') return FAIL(`history:list should be refused with HISTORY_SYNC_RETIRED, got: ${JSON.stringify(list)}`);

        return PASS('🔴 delivery:none put ZERO frames OF ANY NAME on the PC socket across the whole record-only window (audio:start + the history:create that carries the sentence) — the named audio:start/stt:* checks still run inside it, and the same recorder is proved non-blind against the 补投 frame that DID carry the sentence; the mobile was still told (fail-loud intact); 补投 inject:request relayed with entry_id echo and the PC verdict reached the phone (delivery truth now lives on the owner); server history REFUSED out loud on both create and list (HISTORY_SYNC_RETIRED, never a silent drop, never an empty page)');
      } finally {
        pc.disconnect(); mobile.disconnect();
      }
    },
  },
  // card M1 (0.3.0) pushed step 6 past a paragraph of explanation and this file past
  // its 800-line cap, so G11 moved into its own module — same reason as G13–G20,
  // and the body went over VERBATIM. Cap breach fixed by SPLITTING, never by
  // deleting the reasoning (0.2.52 §5 set that precedent on two Dart files).
  G11,
  {
    id: 'G12',
    name: 'paired-phone table (R6 T-8: pc:list-mobiles — projection has no token / ownership isolation / real online state)',
    requires: [SERVER_DIST],
    async fn(url) {
      // The PC-side pairing query the device page reads. Three properties, all
      // security- or honesty-shaped, over the REAL server:
      //   ① the ack projection carries NO token (key or value, at any depth);
      //   ② ownership isolation — PC-A cannot see a phone paired to PC-B, and a mobile-role
      //      socket cannot run the query at all;
      //   ③ `online` is REAL room presence — it flips false when the phone's
      //      socket goes away, while the pairing ROW survives (a pairing table,
      //      not a presence table).
      // SIM-MOBILE CAVEAT applies to the phone half (see the file header): this
      // proves the SERVER + PC halves only.
      const sockets = [];
      const track = (s) => { sockets.push(s); return s; };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const tokenKeys = (v, path = '$') => {
        const hits = [];
        if (Array.isArray(v)) return v.flatMap((x, i) => tokenKeys(x, `${path}[${i}]`));
        if (v !== null && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (/token|secret|password/i.test(k)) hits.push(`${path}.${k}`);
            hits.push(...tokenKeys(x, `${path}.${k}`));
          }
        }
        return hits;
      };
      try {
        // ── PC-A + its phone ──
        const pcA = track(await connect(url));
        const regA = await ack(pcA, 'pc:register', { device_name: 'Golden PC A', client_instance_id: 'inst-g12-a-0123456789' });
        const mobA = track(await connect(url));
        const joinedA = once(pcA, 'pc:mobile-joined');
        const pairA = await ack(mobA, 'mobile:pair', { short_code: regA.short_code });
        await joinedA;
        if (!pairA.pairing_id || !pairA.mobile_token) return FAIL(`pair A produced no pairing: ${JSON.stringify(pairA)}`);

        // ── PC-B + its own phone (the cross-room negative, same user) ──
        const pcB = track(await connect(url));
        const regB = await ack(pcB, 'pc:register', { device_name: 'Golden PC B', client_instance_id: 'inst-g12-b-0123456789' });
        const mobB = track(await connect(url));
        const joinedB = once(pcB, 'pc:mobile-joined');
        const pairB = await ack(mobB, 'mobile:pair', { short_code: regB.short_code });
        await joinedB;
        if (regA.pc_id === regB.pc_id) return FAIL('the two PCs collapsed onto one device row — the isolation check would be vacuous');

        // ① it lists them + projection has no token.
        const listA = await ack(pcA, 'pc:list-mobiles', {});
        const rowsA = listA.mobiles;
        if (!Array.isArray(rowsA)) return FAIL(`pc:list-mobiles returned no mobiles array: ${JSON.stringify(listA)}`);
        const mine = rowsA.find((m) => m.pairing_id === pairA.pairing_id);
        if (!mine) return FAIL(`the just-paired phone is NOT listed: ${JSON.stringify(rowsA)}`);
        const leaked = tokenKeys(listA);
        if (leaked.length > 0) return FAIL(`ack leaked secret-ish key(s): ${leaked.join(', ')}`);
        if (JSON.stringify(listA).includes(pairA.mobile_token)) return FAIL('ack leaked the mobile_token VALUE');
        const fields = Object.keys(mine).sort().join(',');
        // `device_uid` joined the projection in db52ca0 (v0.2.4 machine-level
        // identity, owner-authorised) and this list was never updated — so G12 has
        // been RED since 2026-07-29 and nobody saw it, because `pnpm golden` sits
        // in no gate at all (pre-commit runs verify:lint + verify:types only).
        // Kept as an exact-set assertion on purpose: the guard exists to catch a
        // field APPEARING here, and a loose check would not. A token would still
        // fail it — device_uid is a machine identity, not a secret (tokenKeys above
        // is the separate secret-leak guard, and it still passes).
        if (fields !== 'device_uid,last_seen_at,mobile_name,online,paired_at,pairing_id')
          return FAIL(`unexpected projection fields: ${fields}`);
        if (mine.online !== true) return FAIL(`a phone with a LIVE socket reported online=${mine.online}`);

        // ② ownership isolation: A cannot see B's phone, B cannot see A's.
        if (rowsA.some((m) => m.pairing_id === pairB.pairing_id)) return FAIL('PC-A listed a phone paired to PC-B (跨房泄漏)');
        const listB = await ack(pcB, 'pc:list-mobiles', {});
        if (!(listB.mobiles ?? []).some((m) => m.pairing_id === pairB.pairing_id)) return FAIL('PC-B cannot see its OWN phone');
        if ((listB.mobiles ?? []).some((m) => m.pairing_id === pairA.pairing_id)) return FAIL('PC-B listed a phone paired to PC-A (跨房泄漏)');

        // ② the query is PC-only — a mobile-role socket is refused, not answered.
        const asMobile = await ack(mobA, 'pc:list-mobiles', {});
        if (asMobile.error !== 'AUTH_TOKEN_INVALID') return FAIL(`a MOBILE socket got an answer instead of AUTH_TOKEN_INVALID: ${JSON.stringify(asMobile)}`);

        // ③ real online state: the phone leaves → online flips false, the ROW stays.
        mobA.disconnect();
        await sleep(300);
        const afterLeave = await ack(pcA, 'pc:list-mobiles', {});
        const stillThere = (afterLeave.mobiles ?? []).find((m) => m.pairing_id === pairA.pairing_id);
        if (!stillThere) return FAIL('the pairing row vanished when the phone disconnected (this is a pairing table, not a presence table)');
        if (stillThere.online !== false) return FAIL(`a disconnected phone still reports online=${stillThere.online} (编造在线态)`);

        return PASS('paired phone listed after pairing; projection = the public six with NO token key or value; PC-A/PC-B mutually invisible; mobile-role socket refused (AUTH_TOKEN_INVALID); online flips true→false on disconnect while the pairing row survives');
      } catch (e) {
        return FAIL(`threw: ${e.message}`);
      } finally {
        for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      }
    },
  },
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
  // `verify:types` cannot catch either: tsc reads `src` through path mappings.
  //
  // So the freshness rule stops being a discipline someone has to remember —
  // CLAUDE.md already carries that discipline in writing, and it has now been
  // missed twice. Both packages are built every run: protocol first, because
  // server-core's dist embeds it. ~10 s on a gate that already takes ~20 s, in
  // exchange for the run being ABOUT the code in the working tree.
  process.stdout.write('[golden] building @flowmic/protocol + @flowmic/server-core (dist is what golden runs) …\n');
  for (const pkg of ['@flowmic/protocol', '@flowmic/server-core']) {
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

  const results = [];
  const waivers = new Map(); // G id → [{rel, why}] — printed by name in the summary
  for (const g of GOLDEN) {
    const { missing, waived, drift } = resolveRequires(g.requires, exclude);
    if (drift.length > 0) {
      // The declaration and opensource-manifest.mjs disagree. Not a product
      // failure — a contract failure — so it is named as one instead of hiding
      // inside "missing required file(s)".
      results.push({ ...g, ...FAIL(`\`requires\` contract violation:\n           · ${drift.join('\n           · ')}`) });
      continue;
    }
    if (missing.length > 0) {
      // A missing file counts as FAIL, never a silent pass.
      results.push({ ...g, ...FAIL(`missing required file(s): ${missing.join(', ')}`) });
      continue;
    }
    if (waived.length > 0) waivers.set(g.id, waived);
    const needsServer = (g.requires ?? []).some((e) => requirePath(e) === SERVER_DIST);
    if (needsServer && !url) {
      results.push({ ...g, ...FAIL('real server unavailable (build/start failed)') });
      continue;
    }
    try {
      const r = await g.fn(url);
      results.push({ ...g, ...r });
    } catch (e) {
      results.push({ ...g, ...FAIL(`threw: ${e.message}`) });
    }
  }

  if (server) server.child.kill();

  // ── summary table ──
  const icon = { PASS: 'PASS   ', SKIPPED: 'SKIPPED', FAIL: 'FAIL   ' };
  process.stdout.write('\n══════════════════════════ GOLDEN PATH SUMMARY ══════════════════════════\n');
  for (const r of results) {
    process.stdout.write(`  ${r.id}  ${icon[r.status]}  ${r.name}\n`);
    if (r.reason) process.stdout.write(`        └─ ${r.reason}\n`);
    // A waived requirement is NOT allowed to be invisible. Same `SKIP: <reason>`
    // vocabulary as scripts/run-script-tests.mjs, printed under the G it belongs
    // to, naming the file and quoting the declared reason verbatim.
    for (const w of waivers.get(r.id) ?? []) {
      process.stdout.write(`        └─ SKIP: required file ${w.rel} is absent — ${w.why}\n`);
    }
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  process.stdout.write('──────────────────────────────────────────────────────────────────────────\n');
  process.stdout.write(`  PASS=${n('PASS')}  SKIPPED=${n('SKIPPED')}  FAIL=${n('FAIL')}  (total ${results.length})\n`);
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

  process.exit(n('FAIL') > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`[golden] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
