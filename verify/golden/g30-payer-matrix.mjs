// G30 — cards MP-0, MP-6 and MP-10: WHO PAYS, over all five branches of the
// ordered rule, and WHAT THE LEDGER SAYS ABOUT IT AFTERWARDS.
// owner 2026-09-11 §11 再追认: 「只要有对端，就扣对端」, and §11
// 「向额度的消耗有迹可寻」.
//
// 🔴 MP-6 REORDERED THE RULE AND THIS FILE GREW WITH IT. Two of the five
// branches did not exist as answers before that card (a demo room bills
// FlowMic's own account; an unsigned guest bills the computer's owner rather
// than an anonymous grant), and two of them are REFUSALS — an unbillable demo
// room and an unreadable far end — which no golden could assert while the rule
// had no way to say 「nobody」.
//
// 🔴🔴 CARD MP-10 INVERTED SECTIONS 3-6 OF THIS FILE, AND THE OLD ASSERTION
// IS WORTH STATING BEFORE THE NEW ONE. Until 2026-09-11 凌晨 this golden
// asserted, in section 3 and again in section 6:
//
//     a signed-in phone B, paired to A's computer, spends B's OWN month;
//     A's usage_records must NOT move, and the row says payer_reason='self'
//
// That was owner §9 「谁说扣谁」 as card MP-0 read it. owner's own last word
// the same night — 「「已登录用户默认也是扣对端」也包括自家 PC」 — makes A
// the payer. So THE OLD ASSERTION IS NOW THE WRONG PRODUCT, and it is spelled
// out here rather than deleted for two reasons:
//
//   · it names an account and a direction, so anyone bisecting a billing
//     complaint across this week needs to know which rule a given build shipped;
//   · 「the golden went red, so revert」 is the plausible wrong move — the file
//     and the rule changed together, on purpose, and section 3's failure text
//     now says which owner ruling it is quoting.
//
// ⚠️ WHAT MP-10 DID NOT MOVE: the integrator branch (already far-end-first
// since MP-1) and the site demo (a signed-in visitor still pays for themselves —
// owner 2026-09-09 §13 / W4-05, which the 再追认 does not revisit; G26 owns that
// arm).
//
// SPEC-REF:
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md
//     §1 (the matrix) · §2 (the ordered rule) · §3 D1/D5 · §6 (the reverse controls)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md
//     §9 (谁说扣谁; 手机账号≠PC 账号 ⇒ 扣手机) and §9-1
//   docs/decisions/... owner 2026-08-15 QTA-2 (「两边有一方不满足都不能继续」)
//   apps/server-core/src/auth/metering-principal.ts (`resolvePayer`)
//
// ── WHY A GOLDEN, AND WHY THIS ONE COULD NOT HAVE BEEN A UNIT TEST ─────────
//
// The rule itself is proved over the whole matrix by
// `apps/server-core/test/metering-principal.test.ts`, against no database at
// all. What that cannot reach is the sentence owner actually said, because it is
// assembled from four layers that each hold a different piece: the handshake JWT
// (who is speaking), `pc_devices.user_id` (whose computer it is),
// `commitSttUsage` (which ledger the seconds are written to) and `QuotaGuard`
// (whose ceiling may still stop it). A stub of any one of them proves the stub.
//
// 🔴 AND THE DEFECT THIS CLOSES WAS INVISIBLE TO EVERY EXISTING TEST. Before
// this card `meteringPrincipal` answered `mobile.user_id ?? pc.user_id` for an
// App pairing, `PairInput.user_id` has no caller that passes anything, and so a
// phone signed into ITS OWN paid account spent the COMPUTER OWNER's month —
// silently, with a plausible number of minutes on both screens. There was a unit
// test asserting exactly that, in as many words, as a deliberate reverse control
// pointing the wrong way (0.2.52's law, third sighting).
//
// ── WHAT IT DOES NOT NEED ─────────────────────────────────────────────────
// No vendor STT engine (the pool points at a closed port, enough to arm the
// quota deadline — G24's header carries that measurement), no LAN, no browser.
// It therefore never SKIPs.

import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ROOT, startSaasServer, connect, ack, recordAll, saasJwt, verifyRegisteredEmail,
  mailFileDir, PASS, FAIL,
} from './harness.mjs';
import {
  PLAN_MINUTES,
  PLAN_MS,
  SEEDED_HEADROOM_MS,
  CAP_HEADROOM_MS,
  TRIAL_GRANT_MS,
  LLM_TOKENS_IN,
  LLM_TOKENS_OUT,
  OWNER_EMAIL,
  PHONE_EMAIL,
  DEMO_PAYER_EMAIL,
  GUEST_UID,
  DEMO_UID,
  SITE_ORIGIN,
  makeProbes,
  sleep,
  budgets,
  startSiteverifyStub,
  startLlmStub,
  makeBaseEnv,
} from './g30-payer-matrix-fixtures.mjs';

export const G30 = {
  id: 'G30',
  name: "payer matrix, all five branches (MP-10: whenever a far end exists the FAR END pays — a signed-in phone B on A's computer spends A's month, not B's, and A is told `signed_in_speaker` while B is told `payer:'far_end'`; an UNSIGNED guest is billed to A the same way but with `guest_speaker`, and NO trial identity is minted; the speaker's own plan is no longer a second gate; a site-demo room is billed to FlowMic's configured demo account at mode:'trial'; the SAME demo room with no demo account configured is REFUSED rather than billed to a fallback; a far end this build cannot classify is refused; and every one of those recordings leaves a usage_events row naming payer_reason and speaker_ref)",
  requires: [
    'apps/server-core/src/auth/metering-principal.ts',
    'apps/server-core/src/billing/budget-push.ts',
    'apps/server-core/src/auth/web-trial-identity.ts',
    'apps/server-core/src/db/repos/usage-events.repo.ts',
    'apps/server-core/src/billing/usage-tracker.ts',
  ],
  async fn() {
    const protocol = await import(pathToFileURL(path.join(ROOT, 'packages', 'protocol', 'dist', 'index.js')).href);
    const { safeParseEvent } = protocol;

    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g30-'));
    const dbPath = path.join(dir, 'g30.sqlite');
    const mailDir = mailFileDir();
    const turnstile = await startSiteverifyStub();
    // card MP-9 — see startLlmStub: without a vendor that answers there is no
    // `kind:'llm'` row to assert anything about.
    const llm = await startLlmStub();
    let saas;
    let db;
    const open = [];
    const track = (s) => { open.push(s); return s; };
    // card MP-11 — `baseEnv` moved VERBATIM to g30-payer-matrix-fixtures.mjs
    // (`makeBaseEnv`) when this file crossed the 800-line cap again. It asserts
    // nothing; it is configuration with reasons attached, which is exactly what
    // that module is for. Every paragraph went with it.
    const baseEnv = makeBaseEnv({ dbPath, turnstilePort: turnstile.port, llmPort: llm.port, mailDir });
    try {
      try {
        // 🔴 THE FIRST HALF RUNS WITH NO `FLOWMIC_DEMO_PAYER_USER_ID`, on
        // purpose: 「a site demo nobody has said who pays for is refused」 is one
        // of the five branches, and it can only be observed on a deployment that
        // really has not configured one. The second half restarts this same
        // database with the variable set, which is also the only way to point it
        // at an account id the server itself generated.
        saas = await startSaasServer(baseEnv);
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      let url = `http://127.0.0.1:${saas.port}`;
      db = new DatabaseSync(dbPath);
      const post = (p, body, headers = {}) => fetch(`${url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SITE_ORIGIN, ...headers },
        body: JSON.stringify(body ?? {}),
      });
      const {
        events, anonCount, usageOf, spentMinutes, periodKeyOf, seedUsedMs, START, speak,
      } = makeProbes(db);
      // ── 1 · TWO REAL ACCOUNTS, and a computer belonging to the first ──────
      // The whole card lives in the gap between them. If the fixture used one
      // account for both ends, every assertion below would pass against the
      // defect as happily as against the fix.
      const ownerJwt = await saasJwt(url, OWNER_EMAIL);
      await verifyRegisteredEmail(url, ownerJwt, mailDir, OWNER_EMAIL);
      const phoneJwt = await saasJwt(url, PHONE_EMAIL);
      await verifyRegisteredEmail(url, phoneJwt, mailDir, PHONE_EMAIL);
      const ownerId = db.prepare('SELECT id FROM users WHERE email=?').get(OWNER_EMAIL)?.id;
      const phoneId = db.prepare('SELECT id FROM users WHERE email=?').get(PHONE_EMAIL)?.id;
      if (!ownerId || !phoneId) return FAIL('one of the two accounts has no users row');
      if (ownerId === phoneId) return FAIL('the fixture collapsed to one account — this golden would then prove nothing');

      const pc = track(await connect(url, { jwt: ownerJwt }));
      const pcRec = recordAll(pc);
      const reg = await ack(pc, 'pc:register', {
        device_name: 'G30 PC (account A)', client_instance_id: 'inst-g30-0123456789ab',
      });
      if (!reg.short_code) return FAIL(`pc:register produced no short_code: ${JSON.stringify(reg)}`);

      // ── 2 · phone B pairs to A's computer, CARRYING ITS OWN ACCOUNT ───────
      const phone = track(await connect(url, { jwt: phoneJwt }));
      const phoneRec = recordAll(phone);
      const pair = await ack(phone, 'mobile:pair', {
        short_code: reg.short_code, pcid: reg.pcid,
        device_uid: 'ph-b1b2c3d4e5f60718', mobile_name: 'Phone-B', client: 'app', client_version: 'g30',
      });
      if (pair.error) return FAIL(`the signed-in phone could not pair with A's computer: ${JSON.stringify(pair)}`);
      await sleep(250);

      // 🔴 THE PAIRING ROW STILL NAMES A, AND THAT IS THE POINT OF THE FIX.
      // MP-0 does not write the account onto the row (that would spend one of B's
      // mobile slots and hang a foreign row off A's computer); the payer is
      // derived per admission from the handshake. So a golden that asserted on
      // this column would go green against the defect. It is checked here only to
      // pin that the fix did NOT quietly start writing it.
      const pairedUserId = db.prepare('SELECT user_id FROM mobile_pairings WHERE id=?').get(pair.pairing_id)?.user_id;
      if (pairedUserId !== ownerId) {
        return FAIL(`mobile_pairings.user_id is ${pairedUserId}, want the PC owner ${ownerId} — MP-0 must not write the speaker's account onto the row`);
      }

      // ── 3 · B speaks into A's computer. A's ledger moves; B's does not. ──
      // 🔴🔴 THE ASSERTION THAT INVERTED WITH CARD MP-10. Until 2026-09-11 凌晨
      // this block seeded B near its ceiling and demanded that B's row grow and
      // A's stand still (owner §9 as MP-0 read it). owner's own last word —
      // 「「已登录用户默认也是扣对端」也包括自家 PC」 — bills A. The seeds swap
      // with the rule: it is the PAYER that must sit near its ceiling, because
      // nothing in this golden emits `audio:stop`, so a recording settles (and
      // therefore meters) only when the quota deadline fires.
      seedUsedMs(ownerId, PLAN_MS - SEEDED_HEADROOM_MS);
      seedUsedMs(phoneId, 0);
      const phoneUsageAtRest = JSON.stringify(usageOf(phoneId));
      phoneRec.frames.length = 0;
      pcRec.frames.length = 0;
      await speak(phone, SEEDED_HEADROOM_MS + 1_500);

      // The positive control FIRST: a recording that never ran would leave both
      // ledgers still, and "B did not move" would then be the silence of nothing
      // having happened rather than the silence this card is about.
      const aSpent = spentMinutes(ownerId);
      if (!(aSpent > (PLAN_MS - SEEDED_HEADROOM_MS) / 60_000)) {
        return FAIL(
          `the COMPUTER OWNER's account was not metered (usage_records says ${aSpent} min, seeded ${(PLAN_MS - SEEDED_HEADROOM_MS) / 60_000}) `
          + `— and the signed-in speaker's row is now ${JSON.stringify(usageOf(phoneId))} (was ${phoneUsageAtRest}). `
          + "If the SPEAKER's row MOVED, this build is still on card MP-0's rule (「谁说扣谁」), which owner's "
          + '2026-09-11 凌晨 再追认 replaced with 「只要有对端，就扣对端」 — the fix is in '
          + 'auth/metering-principal.ts `resolvePayer`, not in this file. '
          + 'If NEITHER moved, nobody paid for a recording that demonstrably ran.',
        );
      }
      if (JSON.stringify(usageOf(phoneId)) !== phoneUsageAtRest) {
        return FAIL(
          `REVERSE CONTROL (card MP-10): the SIGNED-IN SPEAKER's usage_records changed while they spoke into `
          + `somebody else's computer — ${JSON.stringify(usageOf(phoneId))} (was ${phoneUsageAtRest}). `
          + 'owner 2026-09-11 再追认 is 「只要有对端，就扣对端」: B\'s own plan is not a constraint of this '
          + "recording and not the ledger it moves. Putting the speaker branch back above the room-owner "
          + 'branch in `resolvePayer` is exactly what produces this failure',
        );
      }

      // ── 4 · the two ends are told DIFFERENT, TRUE things ─────────────────
      // 🔴 BOTH SOCKETS NOW NAME THE SAME ACCOUNT (A), so an id comparison — all
      // the relay had before MP-6 — cannot separate them. Only the role can:
      // A is told 'self' (its minutes really are the ones moving) plus
      // `signed_in_speaker`, and B is told 'far_end' (the number in that frame
      // is not B's to spend).
      const phoneStarted = budgets(phoneRec).filter((b) => b.reason === 'started');
      const pcStarted = budgets(pcRec).filter((b) => b.reason === 'started');
      if (phoneStarted.length < 1) return FAIL('the speaking phone got no billing:budget{reason:started} frame');
      if (pcStarted.length < 1) return FAIL("the computer got no billing:budget{reason:started} frame for an utterance bound for it");
      for (const [who, frame] of [['phone', phoneStarted[0]], ['pc', pcStarted[0]]]) {
        const parsed = safeParseEvent('billing:budget', frame);
        if (!parsed.success) return FAIL(`the ${who}'s budget frame does not satisfy the protocol schema: ${parsed.error?.message}`);
      }
      if (phoneStarted[0].payer !== 'far_end') {
        return FAIL(
          `the signed-in speaker's frame says payer=${JSON.stringify(phoneStarted[0].payer)}, want 'far_end' — `
          + "since MP-10 the account in that frame is the COMPUTER OWNER's, and a page that read it as 「your」 "
          + "remaining time would be rendering somebody else's month",
        );
      }
      if (phoneStarted[0].mode !== 'plan') {
        return FAIL(`the signed-in speaker was told mode=${JSON.stringify(phoneStarted[0].mode)}, want 'plan' — 'trial' belongs to the site demo, and only there`);
      }
      if (pcStarted[0].payer !== 'self') {
        return FAIL(`the computer's frame says payer=${JSON.stringify(pcStarted[0].payer)}, want 'self' — the minutes in that frame really are the ones moving`);
      }
      // 🔴 THE FIELD CARD MP-10 ADDED, and the reason it is not `guest_speaker`:
      // A must be able to tell a colleague signing in from a stranger's browser,
      // because the two point at different remedies, and A cannot derive either
      // from anything else on the wire.
      if (pcStarted[0].signed_in_speaker !== true) {
        return FAIL(
          `the computer's frame carries signed_in_speaker=${JSON.stringify(pcStarted[0].signed_in_speaker)}, want true — `
          + 'it is the ONLY thing on the wire that says another ACCOUNT is spending these minutes',
        );
      }
      if (pcStarted[0].guest_speaker !== undefined) {
        return FAIL(
          "the computer's frame carries guest_speaker for a SIGNED-IN speaker — the two flags are mutually "
          + 'exclusive, and this one would tell the owner to unpair a browser that does not exist',
        );
      }
      if (phoneStarted[0].signed_in_speaker !== undefined || phoneStarted[0].guest_speaker !== undefined) {
        return FAIL("the speaker's own frame carries a speaker flag — those are for the account being spent, not for the person spending it");
      }

      // ── 5 · QTA-2's second gate is GONE for a FlowMic far end (MP-10) ────
      // 🔴🔴 THE SECOND ASSERTION THAT INVERTED. This section used to exhaust A
      // while B had a full allowance and demand a QUOTA_EXCEEDED refusal, on
      // owner 2026-08-15 「两边有一方不满足都不能继续」 (design §8 Q1, answered 甲).
      // That ruling asked A's ledger as a SECOND one because B's was the one
      // being spent. Under 「对端付」 A's IS the one being spent, so it is the
      // FIRST gate — the refusal is still there and it is a different sentence.
      // What is gone is the other half: B's own plan no longer constrains this
      // recording at all, and this section now proves BOTH directions.
      //
      // ⚠️ Direction 1 — the PAYER exhausted still refuses. Same observable code
      // as before this card, on purpose: MP-10 adds no error code, and the
      // whitelist and the registry count are untouched.
      seedUsedMs(ownerId, PLAN_MS);
      seedUsedMs(phoneId, 0);
      await sleep(150);
      phoneRec.frames.length = 0;
      phone.emit('audio:start', START);
      await sleep(700);
      const refusal = phoneRec.frames.find((f) => f.event === 'stt:error');
      if (refusal?.args[0]?.code !== 'QUOTA_EXCEEDED') {
        return FAIL(
          `with the PAYER (the computer's owner) exhausted, the press answered `
          + `${JSON.stringify(refusal?.args[0]?.code)} — want the EXISTING QUOTA_EXCEEDED. `
          + 'This card adds no refusal code; the whitelist and the error-code count are untouched',
        );
      }
      // 🔴 card MP-11 / gap — AND IT MUST SAY WHOSE LEDGER. This is the peer
      // case by construction: the speaker is B, signed into its own account,
      // and the ledger that just refused is A's. WP-9 put `judged_account` on
      // this frame for exactly this moment and MP-10 made it unreachable —
      // `judged_account` was decided from `gate === 'pc_owner'`, and MP-10
      // retired that gate, so every refusal a press could produce said
      // `'self'`. The phone then rendered 「your monthly quota is used up」 to
      // somebody whose own account is untouched, and hid the only true remedy:
      // ask the other side. R11 — the word must be able to say why it is that
      // word.
      //
      // REVERSE CONTROL (executed 2026-09-11, this worktree): put
      // `judgedAccount` in `socket/handlers/audio-start-quota.ts` back to the
      // WP-9 expression (`gate === 'pc_owner' ? 'pc_owner' : 'self'`).
      // OBSERVED, verbatim: 「the refusal says judged_account="self" — B's own
      // account is fine; A's is the one that ran out…」. Restored; no marker
      // string was inserted and none is left behind.
      if (refusal.args[0].judged_account !== 'pc_owner') {
        return FAIL(
          `the refusal says judged_account=${JSON.stringify(refusal.args[0].judged_account)} — B's own `
          + "account is fine; A's is the one that ran out, so 'self' tells the speaker their own plan is "
          + 'spent (false) and points them at an upgrade that would change nothing. '
          + "Want 'pc_owner', which is what makes the phone's `sttStallQuotaExceededPcOwner` sentence "
          + 'reachable and true (mobile recording_strings.dart)',
        );
      }
      // ⚠️ Direction 2 — THE SPEAKER exhausted does NOT refuse, and this is the
      // half that would have been red before MP-10. Without it, 「the second gate
      // was removed」 and 「the first gate happens to be the same account」 are
      // indistinguishable: every assertion above passes on a build that still
      // asks both.
      seedUsedMs(ownerId, PLAN_MS - SEEDED_HEADROOM_MS);
      seedUsedMs(phoneId, PLAN_MS);
      await sleep(150);
      phoneRec.frames.length = 0;
      await speak(phone, 600);
      const speakerGated = phoneRec.frames.find((f) => f.event === 'stt:error' && f.args[0]?.code === 'QUOTA_EXCEEDED');
      if (speakerGated) {
        return FAIL(
          "the SPEAKER's own exhausted plan refused a recording the COMPUTER'S OWNER is paying for — "
          + 'owner 2026-09-11 再追认 makes the far end the payer, so the speaker\'s allowance is not a '
          + 'constraint of this recording. This is QTA-2\'s second ledger still running (see '
          + '`auth/metering-principal.ts` `pcOwnerQuotaGate`)',
        );
      }
      // …and the POSITIVE CONTROL for that admission: give the payer its minutes
      // back and a press still runs. Without this, 「not refused」 could be a
      // relay that stopped refusing anything at all.
      seedUsedMs(ownerId, 0);
      seedUsedMs(phoneId, 0);
      await sleep(150);
      phoneRec.frames.length = 0;
      await speak(phone, 600);
      const stillRefused = phoneRec.frames.find((f) => f.event === 'stt:error' && f.args[0]?.code === 'QUOTA_EXCEEDED');
      if (stillRefused) {
        return FAIL('the press was still refused for quota after BOTH accounts had head-room — the refusal above was not a money one');
      }

      // ── 6 · the LEDGER says why, not just how much (MP-6, design §10-3) ──
      // 🔴 THE POINT OF THE TWO COLUMNS IS THAT `user_id` ALONE CANNOT ANSWER
      // owner §11. Section 3 proved A's minutes moved; this proves the row can
      // still say, months later, that they moved because B was the one speaking.
      // 🔴 THE VALUES INVERTED WITH MP-10: the row is on A with
      // payer_reason='peer', where before this card it was on B with 'self'.
      // `speaker_ref` is what keeps the reason widening for free — it is B's
      // ACCOUNT id here and a browser uid in section 7, on the same reason word.
      const bRows = events(ownerId).filter((r) => r.speaker_ref === phoneId);
      if (bRows.length < 1) {
        return FAIL(
          `the signed-in recording wrote no usage_events row naming the speaker — the owner's rows carry `
          + `speaker_ref ${JSON.stringify(events(ownerId).map((r) => r.speaker_ref))}, want one equal to ${phoneId}. `
          + 'FLOWMIC_USAGE_EVENTS_ENABLED is on, so the detail log is the thing that failed, not the switch',
        );
      }
      if (bRows[0].payer_reason !== 'peer') {
        return FAIL(
          `the signed-in recording's usage_events row says payer_reason=${JSON.stringify(bRows[0].payer_reason)}, want 'peer'. `
          + "'self' here means the build still bills the speaker (card MP-0's rule); owner's 再追认 replaced it",
        );
      }
      if (events(phoneId).length !== 0) {
        return FAIL(
          `the SPEAKER's own account has ${events(phoneId).length} usage_events row(s) — one recording moves one bill, `
          + 'and since MP-10 that bill is the far end\'s',
        );
      }

      // ── 6b · card MP-9 · THE AI TURN'S ROW SAYS THE SAME THING ───────────
      // 🔴 THE ROW SECTION 6 JUST CHECKED HAD A SILENT TWIN IN PRODUCTION. On
      // 2026-09-11 the NY relay's `usage_events` held an `stt` row with
      // `payer_reason='self'` and a `speaker_ref` beside an `llm` row from the
      // same session with NULL in both: card MP-6 stamped the recording leg, and
      // `recordLlmUsage` kept a signature nobody had to revisit. owner §11 asks
      // that EVERY metered unit name its payer and its speaker, and the AI turn
      // spends its tokens on the very text the recording produced.
      const llmBefore = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE kind='llm'").get().n;
      phoneRec.frames.length = 0;
      phone.emit('compose:start', {
        request_id: 'g30-mp9', entry_id: 'g30-mp9-entry',
        task: 'translate', source_text: 'The quarterly report is due on Friday morning.',
        source_lang: 'en', target_lang: 'zh-CN',
      });
      for (let i = 0; i < 60; i += 1) {
        if (phoneRec.frames.some((f) => f.event === 'compose:done' || f.event === 'compose:error')) break;
        await sleep(100);
      }
      const composeErr = phoneRec.frames.find((f) => f.event === 'compose:error');
      if (composeErr) {
        return FAIL(
          `the AI turn ended in compose:error ${JSON.stringify(composeErr.args[0]?.code)} — the stub vendor DID answer, so `
          + 'this is the relay refusing its own reply (output guard / model config), not the payer stamp. '
          + 'Nothing below can be read until a turn completes',
        );
      }
      if (!phoneRec.frames.some((f) => f.event === 'compose:done')) {
        return FAIL('the AI turn never terminated — with no llm row written, the assertion below would be vacuous');
      }
      // The positive control: a turn that billed nothing leaves the table
      // unchanged, and 「the row does not say NULL」 would then be the silence of
      // a row that does not exist.
      const llmRows = db.prepare(
        "SELECT user_id, payer_reason, speaker_ref, tokens_in, tokens_out FROM usage_events WHERE kind='llm' AND outcome='ok' ORDER BY id",
      ).all();
      if (llmRows.length !== llmBefore + 1) {
        return FAIL(
          `the AI turn wrote ${llmRows.length - llmBefore} usage_events row(s) of kind 'llm', want exactly 1 — `
          + `the stub vendor reported ${LLM_TOKENS_IN}/${LLM_TOKENS_OUT} tokens, so a missing row means the meter never ran`,
        );
      }
      const llmRow = llmRows[llmRows.length - 1];
      if (llmRow.tokens_in !== LLM_TOKENS_IN || llmRow.tokens_out !== LLM_TOKENS_OUT) {
        return FAIL(
          `the llm row carries ${llmRow.tokens_in}/${llmRow.tokens_out} tokens, want ${LLM_TOKENS_IN}/${LLM_TOKENS_OUT} — `
          + 'this row is not the turn that just ran',
        );
      }
      // 🔴 THE ASSERTION: identical to the recording's, and NOT NULL. Equality
      // alone is satisfied by two NULLs, which is exactly the production state.
      if (llmRow.payer_reason !== bRows[0].payer_reason || llmRow.speaker_ref !== bRows[0].speaker_ref) {
        return FAIL(
          `the AI turn's usage_events row says payer_reason=${JSON.stringify(llmRow.payer_reason)} `
          + `speaker_ref=${JSON.stringify(llmRow.speaker_ref)}, while the recording that produced its text says `
          + `${JSON.stringify(bRows[0].payer_reason)} / ${JSON.stringify(bRows[0].speaker_ref)}. `
          + 'One session, one payer: the tokens are spent on the text the recording produced (owner §11)',
        );
      }
      if (llmRow.payer_reason !== 'peer' || llmRow.speaker_ref !== phoneId || llmRow.user_id !== ownerId) {
        return FAIL(
          `both rows agree and both say ${JSON.stringify(llmRow.payer_reason)} / ${JSON.stringify(llmRow.speaker_ref)} `
          + `on account ${JSON.stringify(llmRow.user_id)} — two NULLs agree too, which is the very state this section `
          + `exists to refuse. Want 'peer' / ${phoneId} / ${ownerId} (card MP-10: the AI turn follows the recording's `
          + 'payer, and since the 再追认 that payer is the far end)',
        );
      }

      // ── 7 · AN UNSIGNED GUEST ON A's COMPUTER (MP-6 step 4) ───────────────
      // 🔴 THE BRANCH THIS CARD TURNED OVER. Until MP-6 this visitor spent an
      // anonymous FlowMic grant — a cost with no account behind it, which is the
      // model owner §11 replaced. They now spend the computer owner's allowance,
      // and the owner is TOLD, which is the half that makes it defensible.
      // 🔴 THE OWNER IS SEEDED NEAR ITS CEILING, and that is a property of the
      // harness rather than of the card: nothing in this golden emits
      // `audio:stop`, so a recording SETTLES — and therefore meters — when the
      // quota deadline fires. An account with five whole minutes in hand records
      // nothing inside a 1.5-second press, and 「the owner's ledger did not move」
      // would then be the silence of a session that never ended.
      seedUsedMs(ownerId, PLAN_MS - SEEDED_HEADROOM_MS);
      seedUsedMs(phoneId, 0);
      const reg2 = await ack(pc, 'pc:register', {
        device_name: 'G30 PC (account A)', client_instance_id: 'inst-g30-0123456789ab',
      });
      const guest = track(await connect(url, {}));
      const guestRec = recordAll(guest);
      const guestPair = await ack(guest, 'mobile:pair', {
        short_code: reg2.short_code ?? reg.short_code, pcid: reg2.pcid ?? reg.pcid,
        device_uid: GUEST_UID, mobile_name: 'Guest-0718', client: 'web', client_version: 'g30',
      });
      if (guestPair.error) return FAIL(`the unsigned web guest could not pair with A's computer: ${JSON.stringify(guestPair)}`);
      await sleep(250);

      // 🔴 REVERSE CONTROL (design §10-4): NO TRIAL IDENTITY IS MINTED. Point
      // `web-trial-identity.ts`'s conjunction back at `'app'` rooms and this row
      // is non-null and an anonymous users row exists — which is precisely the
      // behaviour MP-6 removed, so the assertion goes red on the old rule.
      const guestRow = db.prepare('SELECT user_id, client, trial_user_id, device_uid FROM mobile_pairings WHERE id=?').get(guestPair.pairing_id);
      if (guestRow.client !== 'web') return FAIL(`the guest pairing says client=${JSON.stringify(guestRow.client)} — the web branch was never even asked`);
      if (guestRow.trial_user_id !== null) {
        return FAIL(`the guest pairing names trial identity ${guestRow.trial_user_id} — MP-6 mints grants for SITE-DEMO rooms only, and a grant here is a cost with no account behind it (owner §11)`);
      }
      if (anonCount() !== 0) {
        return FAIL(`${anonCount()} anonymous identities exist after an unsigned guest paired to a REAL desktop, want 0`);
      }

      guestRec.frames.length = 0;
      pcRec.frames.length = 0;
      const ownerBeforeGuest = spentMinutes(ownerId);
      await speak(guest, SEEDED_HEADROOM_MS + 1_500);

      const ownerAfterGuest = spentMinutes(ownerId);
      if (!(ownerAfterGuest > ownerBeforeGuest)) {
        return FAIL(
          `the COMPUTER OWNER's usage_records did not move while an unsigned guest spoke into their machine `
          + `(${ownerBeforeGuest} → ${ownerAfterGuest}). Under MP-6 the owner pays for their guests; if nobody's ledger moved, `
          + 'nobody paid for a recording that demonstrably ran, which is the outcome owner §11 exists to forbid',
        );
      }
      const guestStarted = budgets(guestRec).filter((b) => b.reason === 'started');
      const ownerStarted = budgets(pcRec).filter((b) => b.reason === 'started');
      if (guestStarted.length < 1) return FAIL('the unsigned guest got no billing:budget{reason:started} frame');
      if (ownerStarted.length < 1) return FAIL("the computer got no billing:budget{reason:started} frame for the guest's utterance");
      for (const [who, frame] of [['guest', guestStarted[0]], ['owner', ownerStarted[0]]]) {
        const parsed = safeParseEvent('billing:budget', frame);
        if (!parsed.success) return FAIL(`the ${who}'s budget frame does not satisfy the protocol schema: ${parsed.error?.message}`);
      }
      // 🔴 THE TWO FRAMES NAME THE SAME ACCOUNT AND MEAN OPPOSITE THINGS. Both
      // ends are metered under A, so an id comparison — all the relay had before
      // MP-6 — cannot separate them; only the role can.
      if (ownerStarted[0].guest_speaker !== true) {
        return FAIL(
          `the computer's frame carries guest_speaker=${JSON.stringify(ownerStarted[0].guest_speaker)}, want true — `
          + 'it is the ONLY thing on the wire that says these minutes are being spent by somebody else, and the desktop cannot derive it',
        );
      }
      if (ownerStarted[0].payer !== 'self') {
        return FAIL(`the computer's frame says payer=${JSON.stringify(ownerStarted[0].payer)}, want 'self' — the minutes in that frame really are the ones moving`);
      }
      if (guestStarted[0].payer !== 'far_end') {
        return FAIL(`the guest's frame says payer=${JSON.stringify(guestStarted[0].payer)}, want 'far_end' — the account in that frame is not the guest's`);
      }
      if (guestStarted[0].guest_speaker !== undefined) {
        return FAIL("the guest's own frame carries guest_speaker — that flag is for the account being spent, not for the person spending it");
      }
      if (guestStarted[0].mode !== 'plan') {
        return FAIL(`the guest was told mode=${JSON.stringify(guestStarted[0].mode)}, want 'plan' — MP-6 leaves 'trial' to the site demo, and only there`);
      }
      // \U0001F534 FILTERED BY `speaker_ref`, NOT BY `payer_reason`, AND THAT IS A
      // CONSEQUENCE OF CARD MP-10: section 3's signed-in recording now lands on
      // THIS account with the SAME reason word ('peer'), so a filter on the
      // reason alone would happily read section 3's row and call it the guest's.
      // The two are told apart by WHO SPOKE — an account id there, a browser uid
      // here — which is exactly the question `speaker_ref` exists to answer.
      const ownerRows = events(ownerId);
      const guestRowsLedger = ownerRows.filter((r) => r.speaker_ref === GUEST_UID);
      if (guestRowsLedger.length < 1) {
        return FAIL(
          `the owner's usage_events rows carry speaker_ref ${JSON.stringify(ownerRows.map((r) => r.speaker_ref))}, `
          + `want one equal to the browser uid ${GUEST_UID} — an account id there would be a guess, and an email `
          + 'there would be a privacy defect',
        );
      }
      if (guestRowsLedger[0].payer_reason !== 'peer') {
        return FAIL(`the guest's usage_events row carries payer_reason ${JSON.stringify(guestRowsLedger[0].payer_reason)}, want 'peer' — 「is somebody else using my minutes」 is unanswerable without it`);
      }

      // ── 8 · A SITE-DEMO ROOM WITH NOBODY CONFIGURED TO PAY IS REFUSED ─────
      // MP-6 step 3's failure direction, and the reason it is a golden: the two
      // fall-backs a reader reaches for (the visitor's own grant, the room's
      // anonymous owner) both look correct one layer down.
      const anon = await post('/api/web/anon', { turnstile: 'ok', device_uid: DEMO_UID });
      if (anon.status !== 200) return FAIL(`POST /api/web/anon answered ${anon.status} — the site-demo arm is not serving, so this branch cannot be tested`);
      const identity = await anon.json();
      const demoRoomRes = await post('/api/web/rooms', { auth: { kind: 'anon_token' } }, { authorization: `Bearer ${identity.anon_token}` });
      if (demoRoomRes.status !== 200) return FAIL(`the anonymous arm of POST /api/web/rooms answered ${demoRoomRes.status}`);
      const demoRoom = await demoRoomRes.json();

      const unbillable = track(await connect(url, {}));
      const refusedPair = await ack(unbillable, 'mobile:pair', {
        short_code: demoRoom.code, pcid: demoRoom.pcid,
        device_uid: DEMO_UID, mobile_name: 'Demo-6543', client: 'web', client_version: 'g30',
      });
      if (!refusedPair.error) {
        return FAIL(
          'a site-demo room was admitted on a deployment with no FLOWMIC_DEMO_PAYER_USER_ID — '
          + 'so somebody is paying for it and nobody chose who. owner §11: 向额度的消耗有迹可寻',
        );
      }
      if (anonCount() !== 1) {
        return FAIL(`${anonCount()} anonymous identities exist — the refused admission must not have minted one, and the site arm's own identity is the only expected row`);
      }
      unbillable.disconnect();

      // ── 9 · THE SAME ROOM, WITH A DEMO ACCOUNT CONFIGURED ────────────────
      // The account is registered HERE and the server restarted onto it,
      // because the id is generated by the server and the variable is read at
      // boot. A literal id written into the fixture would be an id no `users`
      // row has, which is the misconfiguration this branch is not about.
      // 🔴 WRITTEN STRAIGHT INTO `users`, NOT REGISTERED OVER HTTP, and the
      // reason is a measurement rather than a preference: this golden already
      // spends four of the five registration attempts `REGISTER_MAX_ATTEMPTS`
      // allows one address in ten minutes (auth/register-rate-limit.ts), and a
      // third `saasJwt` here answers 429 — which reads as a failure of this card
      // and is a failure of the fixture. The demo payer is a users row with a
      // plan and nothing else; it never logs in, never holds a token, and every
      // question this section asks of it is answered from the ledger. Registering
      // it would exercise the account surface, which is not what is under test.
      const demoPayerId = 'g30-demo-payer';
      db.prepare(
        "INSERT INTO users (id, email, display_name, plan, locale, created_at) VALUES (?,?,?,'free','en',?)",
      ).run(demoPayerId, DEMO_PAYER_EMAIL, 'G30 demo payer', new Date().toISOString().replace('T', ' ').slice(0, 19));
      if (!db.prepare('SELECT id FROM users WHERE id=?').get(demoPayerId)) {
        return FAIL('the demo payer account has no users row');
      }

      // 🔴 …and one more thing before the restart: a far end this build cannot
      // read (MP-6 step 5). Written straight onto the row because nothing in
      // this build can mint one — that is the point of the branch.
      const guestPcId = db.prepare('SELECT pc_device_id FROM mobile_pairings WHERE id=?').get(guestPair.pairing_id).pc_device_id;
      db.prepare("UPDATE pc_devices SET room_kind='kiosk' WHERE id=?").run(guestPcId);
      const unreadable = track(await connect(url, {}));
      const unreadableAck = await ack(unreadable, 'mobile:reconnect', { token: guestPair.mobile_token, device_uid: GUEST_UID });
      if (!unreadableAck.error) {
        return FAIL(
          'an admission to a room whose kind this build cannot read was ACCEPTED — it may be a third-party host page, '
          + "and billing it to a guess is exactly what owner §9-1 forbids",
        );
      }
      unreadable.disconnect();
      db.prepare("UPDATE pc_devices SET room_kind=NULL WHERE room_kind='kiosk'").run();

      for (const sck of open) { try { sck.disconnect(); } catch { /* closing */ } }
      open.length = 0;
      try { saas?.child?.kill(); } catch { /* restarting */ }
      await sleep(600);
      try {
        saas = await startSaasServer({ ...baseEnv, FLOWMIC_DEMO_PAYER_USER_ID: demoPayerId });
      } catch (e) {
        return FAIL(`the saas server failed to restart with a demo payer configured: ${e.message}`);
      }
      url = `http://127.0.0.1:${saas.port}`;

      // Two ledgers, seeded to two DIFFERENT head-rooms, and the gap between
      // them is the assertion.
      //   · the demo ACCOUNT keeps `SEEDED_HEADROOM_MS`, because the deadline
      //     this golden relies on to settle a press is armed from the PAYER's
      //     remaining (engine/stt-factory.ts `quotaBudgetMs`) — an account with
      //     five whole minutes in hand records nothing inside a short press;
      //   · the browser's own grant is seeded LOWER still, so the number in the
      //     frame can only have come from the cap. A relay that ignored the cap
      //     would report the account's ~1500 ms and pass every other assertion
      //     in this section.
      seedUsedMs(demoPayerId, PLAN_MS - SEEDED_HEADROOM_MS);
      const anonOwnerId = db.prepare('SELECT id FROM users WHERE anonymous=1').get()?.id;
      if (!anonOwnerId) return FAIL('the site-demo arm minted no anonymous identity, so there is no cap to assert');
      seedUsedMs(anonOwnerId, TRIAL_GRANT_MS - CAP_HEADROOM_MS);
      const demoBefore = spentMinutes(demoPayerId);
      const anonOwnerBefore = spentMinutes(anonOwnerId);
      // 🔴 A FRESH CODE, NOT THE ONE FROM SECTION 8. Short codes have an active
      // window and the restart spends part of it; reusing it answers
      // PAIR_EXPIRED_CODE, which is a fixture failure wearing this card's
      // clothes. The IDENTITY is deliberately the same browser uid — `claim`
      // finds the row it already has, so this is still ONE visitor with ONE
      // grant, which section 8's anonymous-row count and the cap below both
      // depend on.
      const anon2 = await post('/api/web/anon', { turnstile: 'ok', device_uid: DEMO_UID });
      if (anon2.status !== 200) return FAIL(`POST /api/web/anon answered ${anon2.status} after the restart`);
      const identity2 = await anon2.json();
      const demoRoom2Res = await post('/api/web/rooms', { auth: { kind: 'anon_token' } }, { authorization: `Bearer ${identity2.anon_token}` });
      if (demoRoom2Res.status !== 200) return FAIL(`the anonymous arm of POST /api/web/rooms answered ${demoRoom2Res.status} after the restart`);
      const demoRoom2 = await demoRoom2Res.json();
      if (anonCount() !== 1) {
        return FAIL(`${anonCount()} anonymous identities exist after the same browser asked twice, want exactly 1 — a second row IS a second grant`);
      }
      const visitor = track(await connect(url, {}));
      const visitorRec = recordAll(visitor);
      const demoPair = await ack(visitor, 'mobile:pair', {
        short_code: demoRoom2.code, pcid: demoRoom2.pcid,
        device_uid: DEMO_UID, mobile_name: 'Demo-6543', client: 'web', client_version: 'g30',
      });
      if (demoPair.error) {
        return FAIL(`the site-demo room refused a visitor even with FLOWMIC_DEMO_PAYER_USER_ID set: ${JSON.stringify(demoPair)} — this is the POSITIVE CONTROL for section 8, and without it that refusal proves nothing`);
      }
      await sleep(250);
      visitorRec.frames.length = 0;
      await speak(visitor, SEEDED_HEADROOM_MS + 1_500);

      const demoAfter = spentMinutes(demoPayerId);
      if (!(demoAfter > demoBefore)) {
        return FAIL(`the DEMO ACCOUNT's usage_records did not move while a site-demo visitor spoke (${demoBefore} → ${demoAfter}) — owner §11 asks the demo's spend to land on one account an operator can look up`);
      }
      // 🔴 THE CAP IDENTITY IS DEBITED TOO, AND THAT IS THE POINT — it is what
      // makes the 120 s survive a reload instead of resetting. What separates a
      // CAP from a PAYER is not whether its counter moves; it is that the demo
      // ACCOUNT is the one named in the detail ledger, and the anonymous
      // identity is named nowhere in it.
      if (spentMinutes(anonOwnerId) <= anonOwnerBefore) {
        return FAIL(
          `the cap identity's usage_records did not move (${anonOwnerBefore} → ${spentMinutes(anonOwnerId)}) — `
          + 'then the per-browser 120 s is frozen at its full value and every reload hands out a fresh two minutes, '
          + 'which is the defect the cap exists to prevent',
        );
      }
      if (events(anonOwnerId).length !== 0) {
        return FAIL(
          `the cap identity has ${events(anonOwnerId).length} usage_events row(s) — it is a ceiling, not a payer, `
          + 'and a second row for the same seconds would double-count them in the one table an operator aggregates',
        );
      }
      const demoStarted = budgets(visitorRec).filter((b) => b.reason === 'started');
      if (demoStarted.length < 1) return FAIL('the site-demo visitor got no billing:budget{reason:started} frame');
      const parsedDemo = safeParseEvent('billing:budget', demoStarted[0]);
      if (!parsedDemo.success) return FAIL(`the demo visitor's budget frame does not satisfy the protocol schema: ${parsedDemo.error?.message}`);
      if (parsedDemo.data.mode !== 'trial') {
        return FAIL(
          `the site-demo visitor was told mode=${parsedDemo.data.mode}, want 'trial' — the payer is now a REAL account with a plan, `
          + 'so without the cap deciding the mode the page would show a subscription\'s face over a two-minute allowance',
        );
      }
      if (parsedDemo.data.remaining_ms === null || parsedDemo.data.remaining_ms > CAP_HEADROOM_MS) {
        return FAIL(
          `the site-demo visitor was told ${JSON.stringify(parsedDemo.data.remaining_ms)} ms remain, want at most ${CAP_HEADROOM_MS} — `
          + `the demo account has ${SEEDED_HEADROOM_MS} ms of head-room and THIS BROWSER's own grant has ${CAP_HEADROOM_MS}, `
          + 'so a relay reporting the ACCOUNT number is one that never consulted the cap',
        );
      }
      const demoRows = events(demoPayerId);
      if (demoRows.length < 1 || demoRows[0].payer_reason !== 'demo') {
        return FAIL(`the demo recording's usage_events rows carry payer_reason ${JSON.stringify(demoRows.map((r) => r.payer_reason))}, want 'demo'`);
      }
      if (demoRows[0].speaker_ref !== DEMO_UID) {
        return FAIL(`the demo recording's usage_events row says speaker_ref=${JSON.stringify(demoRows[0].speaker_ref)}, want the browser uid ${DEMO_UID}`);
      }

      // ── 10 · THE CAP CUTS THE RECORDING OFF, WITH THE ACCOUNT STILL RICH ──
      // 🔴 THE ASSERTION THE FIRST DRAFT OF THIS CARD COULD NOT HAVE PASSED. The
      // cap decided the number on the page and nothing else, so a demo visitor
      // watched a clock reach zero and went on talking. Here the demo ACCOUNT is
      // given its whole month back and only the BROWSER's grant is short: the
      // press must still end by itself, with the exhaustion face, and it must be
      // the cap that ended it.
      seedUsedMs(demoPayerId, 0);
      seedUsedMs(anonOwnerId, TRIAL_GRANT_MS - CAP_HEADROOM_MS);
      await sleep(150);
      visitorRec.frames.length = 0;
      await speak(visitor, CAP_HEADROOM_MS + 2_000);
      const stopped = visitorRec.frames.find((f) => f.event === 'audio:auto-stopped');
      if (stopped?.args[0]?.reason !== 'quota_exhausted') {
        return FAIL(
          `the recording was not auto-stopped for quota (${JSON.stringify(stopped?.args[0]?.reason)}) while the `
          + `browser's grant had only ${CAP_HEADROOM_MS} ms left and the demo account had its whole month — `
          + 'the cap is being displayed and not enforced, which is a countdown with no mechanism behind it (R11)',
        );
      }
      // The POSITIVE CONTROL for that stop: the demo account really did have
      // budget throughout, so 「it ended」 cannot be the account running out.
      const demoLeftMin = PLAN_MINUTES - spentMinutes(demoPayerId);
      if (!(demoLeftMin > 1)) {
        return FAIL(`the demo account had only ${demoLeftMin} min left, so this section proves nothing about the cap`);
      }
      // …and the next press is refused before it starts, by the cap's own gate.
      visitorRec.frames.length = 0;
      visitor.emit('audio:start', START);
      await sleep(700);
      const capRefusal = visitorRec.frames.find((f) => f.event === 'stt:error');
      if (capRefusal?.args[0]?.code !== 'QUOTA_EXCEEDED') {
        return FAIL(
          `with this browser's grant spent and the demo account still rich, the next press answered `
          + `${JSON.stringify(capRefusal?.args[0]?.code)} — want the EXISTING QUOTA_EXCEEDED. This card adds no refusal code`,
        );
      }

      return PASS(
        `MP-10: signed-in phone B on A's computer — A's usage_records grew to ${aSpent} min and B's did not move; `
        + `payer far_end to B and self+signed_in_speaker to A; A (the payer) exhausted still refused the press, `
        + "and B's OWN exhausted plan did NOT (the second gate is gone); usage_events payer_reason='peer' "
        + `speaker_ref=${phoneId} on A's account and zero rows on B's. `
        + `MP-6: an unsigned guest was billed to A the same way but with guest_speaker (no trial row, `
        + `usage_events payer_reason='peer' speaker_ref=${GUEST_UID}); a site-demo room with no demo account was REFUSED and with `
        + `${DEMO_PAYER_EMAIL} configured billed that account at mode:'trial' capped to <=${CAP_HEADROOM_MS} ms `
        + "(payer_reason='demo', and the cap identity debited but named in no usage_events row); the cap ENDED a "
        + 'recording (auto-stopped quota_exhausted) and refused the next press while the demo account still had '
        + 'minutes; and a room_kind this build cannot read was refused. '
        + `MP-9: the AI turn that followed B's recording wrote its own usage_events row `
        + `(${LLM_TOKENS_IN}/${LLM_TOKENS_OUT} tokens) naming the SAME payer_reason='peer' and speaker_ref as the recording.`,
      );
    } catch (e) {
      return FAIL(`G30 threw: ${e?.stack || e?.message || String(e)}`);
    } finally {
      for (const s of open) { try { s.disconnect(); } catch { /* closing */ } }
      try { db?.close(); } catch { /* closing */ }
      try { saas?.child?.kill(); } catch { /* closing */ }
      try { turnstile?.srv?.close(); } catch { /* closing */ }
      try { llm?.srv?.close(); } catch { /* closing */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  },
};
