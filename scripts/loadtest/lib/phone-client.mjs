// scripts/loadtest/lib/phone-client.mjs
//
// One simulated "PC + paired phone" pair. Each call to runPhoneClient() plays
// BOTH ends of one user's device pair over real sockets against the real
// server — a real PC-role socket.io-client connection and a real mobile-role
// one — exactly like verify/golden/harness.mjs's registerAndPair, except
// parameterized per client index (unique client_instance_id) so N clients
// produce N independent rooms instead of colliding onto one PC's device row
// (machine-identity dedup — see room/registry.ts registerPc — would otherwise
// silently fold every client with the SAME client_instance_id into one PC).
//
// Deliberately reuses connect/ack/once from verify/golden/harness.mjs (see
// that file's header for why a second copy of those three functions is this
// repo's #1 bug shape aimed at its own harness) rather than re-implementing
// the socket.io-client wiring here.

import { connect, ack, once } from '../../../verify/golden/harness.mjs';
import { SINE_CHUNK_B64, CHUNK_MS, chunkCountFor } from './audio-synth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param opts.url            server URL (loopback, enforced by the caller)
 * @param opts.index           0-based client index, used to build a unique identity
 * @param opts.runId            short id shared by every client in this run (identity namespacing)
 * @param opts.engineMode       'off' | 'local' — see README "engine modes"
 * @param opts.utteranceMs      length of each simulated utterance
 * @param opts.gapMs            pause between utterances (PTT release → next press)
 * @param opts.heartbeatMs      cadence of the heartbeat side-channel (also the event-loop-lag probe)
 * @param opts.startDelayMs     ramp-in delay before this client does anything
 * @param opts.endAtMs          absolute Date.now() timestamp — the audio loop stops issuing new
 *                                utterances once this is reached (a wall-clock deadline shared by
 *                                every client, not a per-client duration, so --ramp does not shrink
 *                                each client's share of --minutes)
 */
export async function runPhoneClient(opts) {
  const {
    url, index, runId, engineMode, utteranceMs, gapMs, heartbeatMs, startDelayMs, endAtMs,
  } = opts;

  const result = {
    index,
    connect_ok: false,
    pair_ok: false,
    engine_off_ok: engineMode === 'off' ? false : null,
    errors: [],
    audio_start_latencies_ms: [],
    audio_stop_latencies_ms: [],
    heartbeat_latencies_ms: [],
    utterances_attempted: 0,
    utterances_completed: 0,
    stt_finals: 0,
    stt_errors_acked: 0,   // audio:start itself came back with an error
    stt_errors_terminal: 0, // a terminal stt:error arrived after chunks were sent
    terminal_frame_timeouts: 0,
  };

  if (startDelayMs > 0) await sleep(startDelayMs);

  let pc;
  let mobile;
  try {
    pc = await connect(url);
  } catch (e) {
    result.errors.push({ stage: 'pc_connect', message: String(e.message ?? e) });
    return result;
  }
  try {
    mobile = await connect(url);
  } catch (e) {
    result.errors.push({ stage: 'mobile_connect', message: String(e.message ?? e) });
    try { pc.disconnect(); } catch { /* already gone */ }
    return result;
  }
  result.connect_ok = true;

  const base = `loadtest-${runId}-pc-${index}`;
  const clientInstanceId = base.length >= 16 ? base : base.padEnd(16, '0');

  try {
    const reg = await ack(pc, 'pc:register', { device_name: `LoadTest PC ${index}`, client_instance_id: clientInstanceId });
    if (!reg || reg.error) throw new Error(`pc:register refused: ${reg?.error ?? 'no ack'}`);
    const joinedP = once(pc, 'pc:mobile-joined', 5000).catch(() => null);
    const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code });
    if (!pair || pair.error) throw new Error(`mobile:pair refused: ${pair?.error ?? 'no ack'}`);
    await joinedP;
    result.pair_ok = true;
  } catch (e) {
    result.errors.push({ stage: 'pair', message: String(e.message ?? e) });
    try { pc.disconnect(); } catch { /* already gone */ }
    try { mobile.disconnect(); } catch { /* already gone */ }
    return result;
  }

  // "off" engine mode (this tool's DEFAULT — see README "engine modes"):
  // clear this account's stt.routings so audio:start's engine-construction
  // step throws SttConfigMissingError synchronously and audio:chunk becomes a
  // pure drop (state.orchestrator stays null — see audio.handler.ts). That
  // isolates transport + auth + fan-out + settings write cost from any STT
  // compute at all, matching the owner's "STT leg: fake engine" S0a
  // instruction as literally as this server's real wire protocol allows
  // (there is no server-side "install a fake sttFactory" knob reachable from
  // outside the process — see README for why).
  if (engineMode === 'off') {
    try {
      const upd = await ack(mobile, 'settings:update', { key: 'stt.routings', value: [] });
      result.engine_off_ok = !!(upd && upd.ok === true);
      if (!result.engine_off_ok) result.errors.push({ stage: 'engine_off', message: `settings:update refused: ${JSON.stringify(upd)}` });
    } catch (e) {
      result.errors.push({ stage: 'engine_off', message: String(e.message ?? e) });
    }
  }

  // ── heartbeat side-channel ──────────────────────────────────────────────
  // Doubles as (a) an ack-latency sample independent of the audio path, and
  // (b) an event-loop-lag proxy: `heartbeat` is a cheap handler (one auth
  // check + one DB touch), so a growing ack RTT under load is dominated by
  // how long this client's callback sat in the server's event queue, not by
  // handler work. Cadence matches production (CLAUDE.md: "心跳 5s/设备").
  let stopping = false;
  let hbTimer = null;
  function scheduleHeartbeat() {
    hbTimer = setTimeout(async () => {
      if (stopping) return;
      const t0 = Date.now();
      try {
        const r = await ack(pc, 'heartbeat', { ts: Date.now() });
        if (r && r.ok === true) result.heartbeat_latencies_ms.push(Date.now() - t0);
        else result.errors.push({ stage: 'heartbeat', message: `refused: ${JSON.stringify(r)}`, at_ms: Date.now() });
      } catch (e) {
        result.errors.push({ stage: 'heartbeat', message: String(e.message ?? e), at_ms: Date.now() });
      }
      if (!stopping) scheduleHeartbeat();
    }, heartbeatMs);
  }
  scheduleHeartbeat();

  // ── audio loop: audio:start → 200ms chunks → audio:stop → gap → repeat ──
  while (Date.now() < endAtMs) {
    result.utterances_attempted++;
    try {
      const t0 = Date.now();
      const startAck = await ack(mobile, 'audio:start', {
        sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh',
      });
      result.audio_start_latencies_ms.push(Date.now() - t0);
      const started = !!(startAck && !startAck.error);
      if (!started) result.stt_errors_acked++;

      // 🔴 Chunks stream UNCONDITIONALLY, even when audio:start itself was
      // refused (e.g. 'off' engine mode's STT_CONFIG_MISSING). The task this
      // harness serves is measuring transport load, and a real phone's PTT
      // button press already committed to a 200ms chunk cadence before any
      // ack came back (ptt_session.dart fires audio:start and starts feeding
      // the mic fire-and-forget — see audio.handler.ts's own comment on why
      // the ack is not read). Gating the chunk loop on the ack succeeding
      // would have silently dropped this tool's #1 job (audio:chunk wire load)
      // in the exact engine mode this tool defaults to — caught by a smoke run
      // where utterances_completed read 0 while chunks were believed sent.
      const chunkCount = chunkCountFor(utteranceMs);
      // A terminal frame can only ever arrive when a session actually exists —
      // i.e. audio:start was accepted AND an engine is wired. Waiting for one
      // in any other case would only measure this tool's own timeout.
      const terminalP = (started && engineMode !== 'off') ? Promise.race([
        once(mobile, 'stt:final', 8000).then((d) => ({ kind: 'final', d })).catch(() => null),
        once(mobile, 'stt:error', 8000).then((d) => ({ kind: 'error', d })).catch(() => null),
      ]) : null;

      for (let seq = 0; seq < chunkCount; seq++) {
        mobile.emit('audio:chunk', { seq, data_b64: SINE_CHUNK_B64, ts_ms: Date.now() });
        if (seq < chunkCount - 1) await sleep(CHUNK_MS);
      }

      const t1 = Date.now();
      await ack(mobile, 'audio:stop', {});
      result.audio_stop_latencies_ms.push(Date.now() - t1);

      if (terminalP) {
        const outcome = await terminalP;
        if (!outcome) result.terminal_frame_timeouts++;
        else if (outcome.kind === 'final') result.stt_finals++;
        else result.stt_errors_terminal++;
      }
      if (started) result.utterances_completed++;
    } catch (e) {
      result.errors.push({ stage: 'audio_loop', message: String(e.message ?? e), at_ms: Date.now() });
      await sleep(200); // do not spin hot against a persistently failing server
    }
    if (Date.now() >= endAtMs) break;
    await sleep(gapMs);
  }

  stopping = true;
  if (hbTimer) clearTimeout(hbTimer);
  try { pc.disconnect(); } catch { /* already gone */ }
  try { mobile.disconnect(); } catch { /* already gone */ }
  return result;
}
