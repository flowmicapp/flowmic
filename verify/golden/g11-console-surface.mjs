// verify/golden/g11-console-surface.mjs
//
// G11 — the web console's REST surface, end to end against a REAL saas server:
// register → login → summary/subscription (Bearer) → cloud pair → devices list →
// revoke (idempotent + reconnect-after-revoke fails) → password-reset ROTATION.
//
// WHY IT LIVES IN ITS OWN FILE (2026-08-04). It was inline in `run-golden.mjs`
// until card M1 made step 6 need a paragraph of its own; that paragraph pushed
// the runner over the 800-line lint cap. The repo's standing answer to that cap
// is a STRUCTURAL split, never deleting the evidence (0.2.52 §5 did the same to
// two Dart files), and G13–G20 already established one-case-per-file as the
// shape. The body below is VERBATIM from the runner — only the wrapper changed.
//
// SIM-MOBILE CAVEAT applies unchanged: the "phone" here is `connect()`, a
// socket.io script, so a pass proves the SERVER half of the pairing leg and says
// nothing about whether the Dart app emits any of it.

import {
  SERVER_DIST,
  connect, ack, startSaasServer, verifyRegisteredEmail, PASS, FAIL,
} from './harness.mjs';

export const G11 = {
  id: 'G11',
  name: 'console support surface (R5-WEB WP-W1: saas register → summary/devices/revoke/password-reset full chain)',
  requires: [SERVER_DIST],
  async fn() {
    // Starts its OWN saas instance (the console REST is saas-only, same as G9).
    //
    // 🔴 card M1 (0.3.0) —— `FLOWMIC_INTERNAL_RESET_TOKEN_ECHO` is newly added on this line,
    // and it is also this case's **only honest reading** now. M1 turned `/api/password/forgot`
    // echoing `reset_token` into default-off (for any **known email**, two anonymous requests
    // can take over the account), leaving only a strict '1'/'true' internal switch. ⇒ In the default shape
    // the "forgot password → change password" chain **cannot be walked in this repo at all**: this repo has no mail channel,
    // the token only lands in `user_settings`, and nobody delivers it to the user's hands (the M1 file header writes this
    // ledger as-is; card M2 is the one that adds mail).
    // ⇒ So step 6 below proves the **rotation mechanism itself** (old password dead, new password live),
    //   not "the user can really self-serve a reset". Those two sentences are far apart; the PASS copy spells it out.
    //
    // 🔴 **in-place correction (2026-08-09, card MAIL-1) — the sentence above "this repo has no mail channel"
    // is false today, and it was true when it was written. Original text kept, not deleted.**
    // `apps/server-core/src/mail/` has been built and wired: the forgot route hands every minted
    // token to the mail channel; a deployment with no mail configured gets the one that **fails by name**
    // (`unconfiguredPasswordResetMailer`), and **nowhere will ever say "sent"**.
    // ⚠️ **But step 6's criterion below has not changed by a single word, and must not change**: this case runs a server
    // **with no `FLOWMIC_MAIL_*` configured**, so it still only proves the **rotation mechanism itself**.
    // "The user can really self-serve a reset" needs **actually sending a letter**, and owner has not delivered a Resend key
    // ⇒ that stretch is still **[not measured]** (`apps/server-core/src/mail/resend.ts` file header).
    // ⇒ Do not read this case's PASS as "reset is usable" just because "there is a mail channel now".
    // The mail side's criteria live in `apps/server-core/test/mail-password-reset.test.ts`
    // (injected fake transport, real template, real link), not here.
    // ⚠️ The default-off half (no echo, and byte-identical to an unknown email) is pinned by
    //   `apps/server-core/test/console-routes.test.ts` — turning it on explicitly here
    //   also proves that the switch is actually live (with it off this case would go red on step 6 immediately).
    // VERIFY-1 (2026-08-11) — the second internal echo flag, same M1 precedent
    // and the same honest reading: this server has no mail channel, so the
    // code rides the send response; what step 1b proves is the GATE mechanism
    // (unverified walled by name → verified admitted), not "a user really
    // received an email" (that half is test/email-verification.test.ts's fake
    // transport, and a REAL mail remains [not measured] per mail/resend.ts).
    let saas = null;
    try {
      saas = await startSaasServer({
        FLOWMIC_INTERNAL_RESET_TOKEN_ECHO: '1',
        FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO: '1',
      });
    } catch (e) {
      return FAIL(`saas server failed to start: ${e.message}`);
    }
    const url = `http://127.0.0.1:${saas.port}`;
    const jsonPost = (p, body, headers = {}) =>
      fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const jsonGet = (p, headers = {}) => fetch(`${url}${p}`, { headers });
    try {
      // 1. register + login → JWT (Bearer for REST + socket handshake).
      const regRes = await jsonPost('/api/register', { email: 'g11@flowmic.test', password: 'longenough1', display_name: 'G11' });
      if (regRes.status !== 201) return FAIL(`/api/register status ${regRes.status}`);
      const loginRes = await jsonPost('/api/login', { email: 'g11@flowmic.test', password: 'longenough1' });
      if (loginRes.status !== 200) return FAIL(`/api/login status ${loginRes.status}`);
      const jwt = (await loginRes.json()).token;
      const auth = { authorization: `Bearer ${jwt}` };

      // 1b. VERIFY-1 — the console gate, both directions: a fresh registration
      // is WALLED by name, then the send→confirm flow (real routes, code via
      // the internal echo) opens it. Without this step every console read
      // below would now honestly 403 — the gate is the product, not a fixture
      // inconvenience.
      const walled = await jsonGet('/api/cloud/summary', auth);
      if (walled.status !== 403) return FAIL(`unverified summary expected 403 EMAIL_NOT_VERIFIED, got ${walled.status}`);
      if ((await walled.json()).error !== 'EMAIL_NOT_VERIFIED') return FAIL('unverified summary refusal not EMAIL_NOT_VERIFIED');
      await verifyRegisteredEmail(url, jwt);

      // 2. summary + subscription (Bearer) — plan free, quota finite, 0 devices.
      const sumRes = await jsonGet('/api/cloud/summary', auth);
      if (sumRes.status !== 200) return FAIL(`/api/cloud/summary status ${sumRes.status}`);
      const summary = await sumRes.json();
      if (summary.plan?.plan !== 'free') return FAIL(`summary plan not free: ${JSON.stringify(summary.plan)}`);
      if (!Number.isFinite(summary.quota?.stt?.limit_min)) return FAIL(`summary quota not finite: ${JSON.stringify(summary.quota)}`);
      if (summary.devices?.pc_count !== 0 || summary.devices?.mobile_count !== 0) return FAIL(`summary device counts not zero: ${JSON.stringify(summary.devices)}`);
      const subRes = await jsonGet('/api/cloud/subscription', auth);
      if (subRes.status !== 200 || (await subRes.json()).subscription?.plan !== 'free') return FAIL('subscription read-out wrong');
      if ((await jsonGet('/api/cloud/summary')).status !== 401) return FAIL('summary without Bearer should 401');

      // 3. Create a real pairing via cloud-instance admission (JWT handshake).
      const c1 = await connect(url, { jwt });
      const pair = await ack(c1, 'mobile:pair', { cloud_instance: true });
      const pairingId = pair.pairing_id;
      const mobileToken = pair.mobile_token;
      c1.disconnect();
      if (!pairingId || !mobileToken) return FAIL(`cloud pair produced no pairing: ${JSON.stringify(pair)}`);

      // 4. devices list shows the FlowMic Cloud PC + the pairing (no tokens leaked).
      const devRes = await jsonGet('/api/cloud/devices', auth);
      const devices = await devRes.json();
      const pcRow = (devices.pc_devices ?? []).find((p) => p.client_instance_id === 'flowmic-cloud-instance');
      if (!pcRow) return FAIL(`devices list missing cloud PC: ${JSON.stringify(devices.pc_devices)}`);
      if ('device_token' in pcRow) return FAIL('devices leaked device_token');
      const pairRow = (devices.mobile_pairings ?? []).find((m) => m.pairing_id === pairingId);
      if (!pairRow || 'mobile_token' in pairRow) return FAIL(`devices pairing row wrong: ${JSON.stringify(devices.mobile_pairings)}`);

      // 5. revoke (idempotent) + reconnect-after-revoke fails: the revoked mobile_token cannot reconnect.
      const rev1 = await (await jsonPost('/api/cloud/devices/revoke', { pairing_id: pairingId }, auth)).json();
      if (rev1.ok !== true || rev1.revoked !== true) return FAIL(`first revoke wrong: ${JSON.stringify(rev1)}`);
      const reconnectVerdict = await connect(url, { token: mobileToken }).then((s) => { s.disconnect(); return 'connected'; }).catch(() => 'rejected');
      if (reconnectVerdict !== 'rejected') return FAIL('revoked mobile_token was NOT rejected on reconnect (续连失效 broken)');
      const rev2 = await (await jsonPost('/api/cloud/devices/revoke', { pairing_id: pairingId }, auth)).json();
      if (rev2.ok !== true || rev2.revoked !== false) return FAIL(`second (idempotent) revoke wrong: ${JSON.stringify(rev2)}`);

      // 6. password reset rotation: forgot → reset → old dead, new logs in.
      const forgot = await (await jsonPost('/api/password/forgot', { email: 'g11@flowmic.test' })).json();
      if (typeof forgot.reset_token !== 'string') return FAIL(`forgot did not echo reset_token: ${JSON.stringify(forgot)}`);
      const reset = await jsonPost('/api/password/reset', { email: 'g11@flowmic.test', reset_token: forgot.reset_token, new_password: 'rotatedpass1' });
      if (reset.status !== 200) return FAIL(`/api/password/reset status ${reset.status}`);
      const oldLogin = await jsonPost('/api/login', { email: 'g11@flowmic.test', password: 'longenough1' });
      if (oldLogin.status !== 401) return FAIL(`old password still logs in after reset (status ${oldLogin.status})`);
      const newLogin = await jsonPost('/api/login', { email: 'g11@flowmic.test', password: 'rotatedpass1' });
      if (newLogin.status !== 200) return FAIL(`new password does NOT log in after reset (status ${newLogin.status})`);

      return PASS('register→login→VERIFY-1 gate (unverified 403 EMAIL_NOT_VERIFIED → send/confirm via internal code echo → admitted)→summary/subscription(Bearer)→cloud pair→devices list(no token leak)→revoke idempotent+续连失效→password reset ROTATION with the M1 internal echo flag explicitly ON (old dead, new logs in) — ⚠️ 这不证明用户能自助重置：本用例这台服务器没有配 FLOWMIC_MAIL_*，且真发信至今【未实测】（邮件链判据在 test/mail-password-reset.test.ts 与 test/email-verification.test.ts，卡 MAIL-1 / VERIFY-1）');
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      if (saas) saas.child.kill();
    }
  },
};
