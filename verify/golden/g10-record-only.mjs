// verify/golden/g10-record-only.mjs
//
// G10 — record-only → kept locally → deferred redelivery.
//
// WHY IT LIVES IN ITS OWN FILE (card G10-TIMING, 2026-09-11). The measurement
// block that replaced this case's wall-clock window — see `MOBILE_TOLD_CEILING_MS`
// below — pushed run-golden.mjs past the 800-line lint cap, the same pressure
// that moved G9 out (card VERIFY-1) and G11 before it (card M1). The repo's
// standing answer to that cap is a STRUCTURAL split, never deleting the
// reasoning (0.2.52 §5 precedent); the body below is VERBATIM from the runner,
// only the wrapper changed — and the numbers that made the split necessary are
// the whole point of the change, so shortening them to stay under the cap would
// have thrown away the thing being delivered.

import {
  SERVER_DIST,
  once, ack, neverWithin, recordAll, registerAndPair, PASS, FAIL,
} from './harness.mjs';

// The frame every press starts with. A LOCAL copy rather than an import from the
// runner (that would be a cycle) — the same call g22-settings-cross-channel.mjs
// made, and it is the only `AUDIO` the runner still had a use for.
const AUDIO = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

export const G10 = {
    id: 'G10',
    name: 'record-only → kept locally → deferred redelivery (record-only, no fan-out, later re-inject)',
    requires: [SERVER_DIST],
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
        // cuts both ways). Either face counts: an `stt:engine-status` about this
        // session's engine, or the terminal `stt:error`.
        //
        // 🔴 REWRITTEN 2026-09-11 (card G10-TIMING) — THE WINDOW WAS TIMING
        // SOMETHING THIS FRAME DOES NOT OBEY, and the correction block that used to
        // stand here (itself a 2026-08-07 correction of an earlier wrong one) is
        // false on any machine that has a local model staged. It read
        // `terminalFrameWindowMs(STT_SPAWN_SRC, 'DEFAULT_ENGINE_SPAWN_TIMEOUT_MS')`
        // = 5_000 + 2_000 grace, over a sentence saying 「a cold-connect failure
        // never reaches the ladder; the spawn cap owns the verdict; BOTH frames
        // arrive together at 5007ms」.
        //
        // MEASURED 2026-09-11 on dev-pc-a, against the very
        // server this case drives, by timestamping that server's own stderr:
        //
        //   engineFactory()                                       ~1 ms
        //   sherpa-local open → resolveReadyModelForLanguage   ~4_140 ms  ← memoised SHA-256 over a 989 MB model
        //   sherpa-local open → load the recognizer            ~3_790 ms  ← native, synchronous
        //   emit → the frame the mobile receives         6_040‥7_976 ms  (8 cold runs: 6019/6040/6179/6381/6643/7238/7906/7976)
        //   the same press again on that warm server process     1–17 ms
        //
        // and the frame is `stt:engine-status{provider:'sherpa-local',
        // status:'ready'}` — a SUCCESS. Three consequences, each of which the old
        // window had wrong:
        //   ① THE 5 s SPAWN CAP CANNOT FIRE ON THIS PATH. `raceSpawnTimeout` arms a
        //      `setTimeout`, and both costs above are synchronous native work that
        //      blocks the event loop straight past the cap's due time; when the load
        //      returns, `work.then` is a microtask and wins the race. A cap that is
        //      provably unable to fire is not the deadline this frame obeys, so a
        //      window derived from it was arithmetic on an unrelated number.
        //      ⚠️ NAMED AS AN OPEN ACCOUNT, NOT FIXED HERE: the first press after a
        //      sidecar start gets ~8 s of silence and the cap meant to bound it is
        //      inert. That is a product question about where the model load runs,
        //      and it is not this case's subject.
        //      🔴 IN-PLACE CORRECTION (NR-38, 2026-09-13, dev-pc-a, node v22.22.3,
        //      measured against the real 229 MB SenseVoice pack with a 20 ms tick
        //      watch). The sentence above says BOTH costs are synchronous work that
        //      blocks the loop. Only ONE of them ever was. The model SHA-256 is
        //      already `createReadStream` piped into the hash and it yields between
        //      chunks — 367–538 ms of wall time, 0 ms of max tick lag; the 4.1 s on
        //      the 989 MB pack was DISK, not a stalled loop. `new OfflineRecognizer()`
        //      was the one blocking: 1_505 ms wall, 1_455 ms max tick lag, zero ticks.
        //      It now goes through `OfflineRecognizer.createAsync` (the pinned
        //      sherpa-onnx-node 1.13.4 has it), so the whole cold open holds the loop
        //      for 12 ms instead of 1_631 ms and the cap CAN fire. The open account
        //      that remains is the one this case never claimed: the user is still not
        //      TOLD during those seconds — `engine-status` has no `loading` value and
        //      adding one is a protocol change nobody has ruled on.
        //      🔴 CORRECTED IN PLACE 2026-09-14 (NR-38 second half, lane
        //      lane/nr38-engine-status-loading). That last sentence is now FALSE and
        //      the original is kept because it is the record of what was open:
        //      `loading` IS a protocol value (`SttEngineStatusSchema`, commit
        //      39bd85b1) and the sidecar emits it before the pack load
        //      (orchestrator-core `spawnEngine(coldOpen)`). ⚠️ THIS CASE WENT RED ON
        //      THAT FRAME, and the red is worth writing down because it is the one
        //      consumer in the repo that did NOT degrade: every shipped reader has a
        //      default arm that drops an unknown status, but the shape check below
        //      is a CLOSED SET and answered `{"provider":"sherpa-local","status":
        //      "loading"}` with 「in a shape it cannot act on」. Being told EARLIER is
        //      not being told LESS, so `loading` joins the set rather than the frame
        //      being filtered out — filtering would have made this case wait for a
        //      frame it had already received and rebuilt the silence it exists to
        //      forbid.
        //   ② WHAT ACTUALLY BOUNDS THIS FRAME IS NOT READABLE FROM THE PRODUCT: it
        //      is how long this machine takes to hash and load whatever model it
        //      happens to have downloaded. No model ⇒ milliseconds (a loud
        //      STT_CONFIG_MISSING); the 229 MB SenseVoice pack ⇒ ~2 s; the 989 MB
        //      whisper-turbo pack staged here on 2026-09-01 ⇒ a distribution that
        //      straddles 7_000 ms — which is exactly when this case started failing
        //      「intermittently」.
        //   ③ SO THE CEILING BELOW IS A LIVENESS BOUND, NOT A PERFORMANCE CLAIM. It
        //      sits far above the measured distribution, and it is NOT the widened
        //      window CE-6b / NR-35 / NR-37 forbid: those were two product deadlines
        //      racing each other and the rule there is 「wait on the event」. This
        //      wait IS on the event — what changed is that it stopped claiming a
        //      number it can read is the number it is waiting for. A golden that
        //      goes red because someone downloaded a bigger ASR model is not
        //      measuring the record-only red line.
        //
        // ⚠️ AND THE VERDICT IS READ NOW, NOT COUNTED. The old `await` asked only
        // 「did anything arrive」, so one green covered 「the engine failed loudly」 and
        // 「the engine opened fine」 — two opposite facts under one word, this repo's
        // #1 shape, sitting in the assertion whose whole job is fail-loud. The frame
        // is now checked for a shape the phone could act on, and NAMED in the PASS
        // line so a reader can tell which of the two this run saw.
        //
        // ⚠️ Hand-rolled rather than `Promise.race([once(...), once(...)])` on
        // purpose: `once` leaves its rejection timer armed, and at this ceiling a
        // leftover one would hold the runner open for a minute after the summary
        // printed. Here the timer is cleared by whichever frame lands.
        const MOBILE_TOLD_CEILING_MS = 60_000;
        const mobileToldP = new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), MOBILE_TOLD_CEILING_MS);
          const land = (event) => (payload) => { clearTimeout(t); resolve({ event, payload }); };
          mobile.once('stt:engine-status', land('stt:engine-status'));
          mobile.once('stt:error', land('stt:error'));
        });
        mobile.emit('audio:start', { ...AUDIO, delivery: 'none' });
        if (!(await pcQuietP)) return FAIL('delivery:none leaked an audio:start fan-out to the PC (record-only red line)');
        const leaked = (await pcSttQuietP).filter(Boolean);
        if (leaked.length) return FAIL(`delivery:none leaked ${leaked.join(', ')} to the PC (内容根本没去 PC red line)`);
        const told = await mobileToldP;
        if (told === null) {
          return FAIL(`the record-only utterance's own session said NOTHING to the MOBILE within ${MOBILE_TOLD_CEILING_MS}ms — neither stt:engine-status nor stt:error (silent failure: withholding from the PC is not permission to swallow)`);
        }
        // Content, not arrival. A frame of the right NAME carrying a shape the phone
        // cannot act on is the same silence one layer down, and it is exactly the
        // failure a bare 「something arrived」 check is blind to.
        const st = told.payload;
        const toldFace = told.event === 'stt:error'
          ? (typeof st?.error === 'string' && st.error.length > 0 ? `stt:error{${st.error}}` : null)
          : (typeof st?.provider === 'string' && st.provider.length > 0
              && ['loading', 'ready', 'failed', 'reconnecting'].includes(st?.status)
            ? `stt:engine-status{${st.provider}:${st.status}}` : null);
        if (toldFace === null) {
          return FAIL(`the MOBILE received ${told.event} for its own session but in a shape it cannot act on: ${JSON.stringify(st)}`);
        }

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

        return PASS(`🔴 delivery:none put ZERO frames OF ANY NAME on the PC socket across the whole record-only window (audio:start + the history:create that carries the sentence) — the named audio:start/stt:* checks still run inside it, and the same recorder is proved non-blind against the 补投 frame that DID carry the sentence; the mobile was still told, and told something it could act on — ${toldFace} — rather than merely 「a frame arrived」 (fail-loud intact); 补投 inject:request relayed with entry_id echo and the PC verdict reached the phone (delivery truth now lives on the owner); server history REFUSED out loud on both create and list (HISTORY_SYNC_RETIRED, never a silent drop, never an empty page)`);
      } finally {
        pc.disconnect(); mobile.disconnect();
      }
    },
  };
