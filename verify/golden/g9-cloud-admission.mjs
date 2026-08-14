// verify/golden/g9-cloud-admission.mjs
//
// G9 — saas cloud-instance admission (REST + JWT handshake + idempotent pair).
//
// WHY IT LIVES IN ITS OWN FILE (card VERIFY-1, 2026-08-11). Its verification-
// gate step (2b) pushed run-golden.mjs past the 800-line lint cap — the exact
// pressure that moved G11 out (card M1) and the harness out before that. The
// repo's standing answer to that cap is a STRUCTURAL split, never deleting the
// reasoning (0.2.52 §5 precedent); the body below is VERBATIM from the runner —
// only the wrapper changed, the same sentence g11-console-surface.mjs opens with.

import {
  SERVER_DIST,
  connect, ack, startSaasServer, verifyRegisteredEmail, PASS, FAIL,
} from './harness.mjs';

export const G9 = {
    id: 'G9',
    name: 'cloud admission (saas cloud-instance admission — REST + JWT handshake + idempotent pair)',
    requires: [SERVER_DIST],
    async fn() {
      // Starts its OWN saas instance (G1–G8 share the standalone one, untouched).
      // VERIFY-1 (2026-08-11): the internal code echo — step 5 reads
      // /api/cloud/summary, a console feature route behind the verification
      // gate, and a spawned dist server has no mail channel (M1 reset-echo
      // precedent; the gate's own proof = G11 §1b + test/email-verification.test.ts).
      let saas = null;
      try {
        saas = await startSaasServer({ FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO: '1' });
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      const url = `http://127.0.0.1:${saas.port}`;
      const jsonPost = (p, body) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      try {
        // 1. REST register → 201 {token,user} (user never carries password_hash).
        const regRes = await jsonPost('/api/register', { email: 'g9@flowmic.test', password: 'longenough1', display_name: 'G9' });
        if (regRes.status !== 201) return FAIL(`/api/register status ${regRes.status}`);
        const reg = await regRes.json();
        if (typeof reg.token !== 'string' || !reg.user?.id) return FAIL('register missing token/user');
        if ('password_hash' in reg.user) return FAIL('register leaked password_hash');
        // 2. REST login → 200 {token,user}; use the login JWT for the handshake.
        const loginRes = await jsonPost('/api/login', { email: 'g9@flowmic.test', password: 'longenough1' });
        if (loginRes.status !== 200) return FAIL(`/api/login status ${loginRes.status}`);
        const jwt = (await loginRes.json()).token;
        // 2b. VERIFY-1 — pass the console gate before step 5's summary read.
        // Deliberately BETWEEN login and pairing: the phone-side admission in
        // steps 3–4 is exempt (owner's "console" wording) and following the
        // confirm proves the gate does not block a cloud pair either.
        await verifyRegisteredEmail(url, jwt);
        // 3. socket connect with the handshake JWT → cloud-instance pair.
        const c1 = await connect(url, { jwt });
        const p1 = await ack(c1, 'mobile:pair', { cloud_instance: true });
        if (p1.pc_instance_id !== 'flowmic-cloud-instance' || p1.pc_name !== 'FlowMic Cloud' || p1.pc_online !== false || p1.role !== 'active') {
          c1.disconnect();
          return FAIL(`cloud ack shape wrong: ${JSON.stringify(p1)}`);
        }
        if (!/^fm_[0-9a-f]{64}$/.test(p1.mobile_token || '')) {
          c1.disconnect();
          return FAIL('cloud pair token malformed');
        }
        // 4. Second admission is idempotent (same pc_id + pairing_id — DB virtual-PC
        //    semantics: re-admission never duplicates the virtual PC / pairing rows).
        const c2 = await connect(url, { jwt });
        const p2 = await ack(c2, 'mobile:pair', { cloud_instance: true });
        c1.disconnect();
        c2.disconnect();
        if (p2.pc_id !== p1.pc_id || p2.pairing_id !== p1.pairing_id) {
          return FAIL(`re-admission not idempotent: ${JSON.stringify([p1.pc_id, p1.pairing_id, p2.pc_id, p2.pairing_id])}`);
        }
        // 5. Quota face finite AS THIS ACCOUNT. Until 2026-07-31 (R4 ④ / owner A3)
        //    this line carried no Authorization header at all and still got a 200,
        //    because the saas server resolved every http caller to the constant
        //    user 'default': the assertion was reading SOMEBODY ELSE'S quota and
        //    could not have told the difference. The Bearer is not decoration here
        //    — it is what makes "this account's quota" a meaningful sentence.
        //
        // 🔴 card M5 (0.3.0) —— **this step changed routes, and the route change itself is this card's evidence.**
        //    It originally asked `/api/billing/quota`, which is a path on the **mock billing gateway**
        //    (`http/router.ts` GATE 3 `!config.mockBilling` ⇒ 404). M5 makes saas
        //    **hard-refuse mock billing at mount time** ⇒ **that path structurally cannot exist on saas**.
        //    ⇒ Keep asking it and you only prove "a development convenience surface is still there", while production saas never mounts it.
        //    The production route that actually answers "what is this account's quota" is `/api/cloud/summary`
        //    (the web console reads it; G11 §2 is the same source), so moving the assertion there is **closer to the real chain**,
        //    not a bypass. ⚠️ The assertion is still two sentences: first prove the **number** is finite, then prove **anonymous** is refused by name.
        const sumRes = await fetch(`${url}/api/cloud/summary`, { headers: { authorization: `Bearer ${jwt}` } });
        if (sumRes.status !== 200) return FAIL(`/api/cloud/summary status ${sumRes.status}`);
        const quota = (await sumRes.json())?.quota;
        const limit = quota?.stt?.limit_min;
        if (typeof limit !== 'number' || !Number.isFinite(limit)) return FAIL(`quota face not finite: ${JSON.stringify(quota)}`);
        // 5b. 🔴 card M5's positive assertion: the mock billing gateway **does not exist** on saas, and the non-existence is **named**
        //     (404 + PLAN_UPGRADE_REQUIRED), not a silent 404. This request goes out with a valid
        //     Bearer — so it tests GATE 3, not a false negative blocked by the two earlier gates.
        //     Without this one, someone putting the mock gateway back on saas would have no machine speaking up.
        const mockRes = await fetch(`${url}/api/billing/quota`, { headers: { authorization: `Bearer ${jwt}` } });
        if (mockRes.status !== 404) return FAIL(`M5: saas must NOT serve the mock billing gateway, got ${mockRes.status} on /api/billing/quota`);
        const mockBody = await mockRes.text();
        if (!mockBody.includes('mock billing gateway disabled')) return FAIL(`M5 refusal is not named: ${mockBody}`);
        // 6. The reverse, which is the half that proves a gate exists: the same
        //    request WITHOUT the token is refused by name, and the refusal names
        //    no user (a body carrying 'default' would mean it answered as one).
        const anonRes = await fetch(`${url}/api/cloud/summary`);
        if (anonRes.status !== 401) return FAIL(`anonymous /api/cloud/summary should be 401, got ${anonRes.status}`);
        const anonBody = await anonRes.text();
        if (!anonBody.includes('AUTH_TOKEN_INVALID')) return FAIL(`anonymous refusal is not named: ${anonBody}`);
        if (anonBody.includes('default')) return FAIL(`anonymous refusal leaked a user id: ${anonBody}`);
        return PASS(`REST register+login → JWT handshake cloud pair (FlowMic Cloud, pc_online:false, role:active); re-admission idempotent (same pc/pairing); quota finite as THIS account via the PRODUCTION route /api/cloud/summary (stt limit ${limit}min); 🔴 M5: the mock billing gateway is NOT served on saas (404 naming it, under a valid Bearer — GATE 3, not a false negative); anonymous summary 401 AUTH_TOKEN_INVALID naming no user`);
      } catch (e) {
        return FAIL(`threw: ${e.message}`);
      } finally {
        if (saas) saas.child.kill();
      }
    },
  };
