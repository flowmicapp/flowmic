// The census behind node/writer-only.ts.
//
// ── WHY A CENSUS AND NOT A LIST ────────────────────────────────────────────
// The card that opened this work said「refuse pc:register and mobile:pair」. The
// measurement found TEN write sites across SIX events. Being wrong by four is
// not the interesting part — the interesting part is that NOTHING WOULD HAVE
// TOLD ANYONE. A hand-kept list of dangerous events goes stale the first time a
// handler grows a write, and it goes stale silently, while every gate stays
// green and the list still reads as authoritative.
//
// So the list is not maintained by memory. This test SCANS the handlers for
// write-shaped calls and compares what it finds against a table where every
// entry carries a VERDICT. A new write in any handler fails here until somebody
// says which of the four things it is. That is the whole mechanism.
//
// ── THE FOUR VERDICTS ──────────────────────────────────────────────────────
//   'refused'   — this event is refused on a replica (node/writer-only.ts), so
//                 the write never runs there. Pinned by writer-only-refusal.test.
//   'forwarded' — the write goes to the WRITER and is NOT performed locally.
//                 Two transports, and they are two because they answer two
//                 questions: metering goes through the durable outbox (at-least-
//                 once, nobody is waiting), while `pc:refresh-code` is forwarded
//                 SYNCHRONOUSLY over /api/node/mint-code because a user is
//                 staring at the modal that needs the digits. Both share the
//                 property this column asserts: the replica's own database is
//                 not written.
//   'in-memory' — touches no database, so a replica has nothing to lose.
//                 EVERY entry with this verdict was verified by reading the
//                 declaration, not by the name looking harmless.
//   'lost'      — 🔴 AN OPEN ACCOUNT. The write happens on a replica and the next
//                 pull erases it. Accepted deliberately, because refusing these
//                 would stop a replica serving live sessions, which is the only
//                 thing it exists to do. Every one of these must be closed before
//                 srvjp is ever made selectable.
//
// ⚠️ 'lost' IS NOT 'HANDLED'. If this file ever ends up with an empty 'lost'
// column because someone re-labelled rather than fixed, the multi-node channel
// will look finished and will still drop presence on the floor.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const HANDLER_DIR = path.resolve(__dirname, '../src/socket/handlers');

/**
 * A call is write-shaped if its METHOD name is one of these. Deliberately over-
 * broad: a false positive costs one line in the table below and a moment's
 * thought, while a false negative is a write nobody classified. The asymmetry is
 * the point — this scan is allowed to be noisy and is not allowed to be quiet.
 */
const WRITE_ISH =
  /^(insert|upsert|update|delete|remove|put|save|write|touch\w*|stamp\w*|claim\w*|adopt\w*|rotate\w*|revoke\w*|retire\w*|mint\w*|record\w*|set[A-Z]\w*|register[A-Z]\w*|pair[A-Z]\w*|reconnect[A-Z]\w*|refresh[A-Z]\w*|admit[A-Z]\w*|reap[A-Z]\w*|rename[A-Z]\w*|resolvePcForPair)$/;

type Verdict = 'refused' | 'forwarded' | 'in-memory' | 'lost';

/**
 * Measured 2026-08-29 by running the scan below over the handler directory.
 * Every row is a real call site, and every verdict is a decision someone made.
 */
const CENSUS: Record<string, { verdict: Verdict; why: string }> = {
  // ── refused on a replica (node/writer-only.ts) ────────────────────────────
  'registry.registerPc': { verdict: 'refused', why: 'pc:register — mints identity + the short code the PC displays' },
  // 🔴 2026-08-31 — 'forwarded', and the ONLY member of that verdict that does
  // not travel through the outbox. The write still never happens on a replica
  // (which is what this column is about); it is performed BY THE WRITER, over
  // POST /api/node/mint-code, synchronously, because a user is waiting for the
  // digits. Left as 'refused' this row would have gone on describing a guard
  // whose real consequence — a PC on a replica can never add a phone again —
  // nobody had noticed, which is precisely what this census exists to prevent.
  'registry.refreshShortCode': { verdict: 'forwarded', why: 'pc:refresh-code — minted ON THE WRITER via /api/node/mint-code; the replica falls back to the refusal when it cannot ask' },
  // 🔴 2026-09-02 (B5, WP-6) — 'forwarded', same shape as `refreshShortCode`
  // below: the write still never happens on a replica's own database; it is
  // performed BY THE WRITER, over the generic POST /api/node/forward-sync
  // (node/forward-sync.ts `releaseMobileOnWriter`), because a user is waiting
  // for `pc:release-mobile` to disconnect or revoke a phone. The replica falls
  // back to this refusal when there is nobody to ask or the ask fails.
  'registry.revokeMobile': { verdict: 'forwarded', why: 'pc:release-mobile — revoked ON THE WRITER via /api/node/forward-sync; the replica falls back to the refusal when it cannot ask' },
  'registry.pairMobile': { verdict: 'refused', why: 'mobile:pair — mints the pairing row and its token' },
  'registry.admitCloudInstance': { verdict: 'refused', why: 'mobile:pair (cloud-instance variant) — inserts a PC row and a pairing' },
  // 🔴 Its `recordFailedGuess` is IN-MEMORY (room/short-code.ts holds plain Maps),
  // so a replication pull does not touch it — an earlier draft of this row said it
  // did, which was a mechanism I had not read. The real reason it belongs here is
  // that the governor a replica holds is EMPTY, so a correct code resolves to
  // nothing and the user is told the code is invalid. A false statement, not a
  // lost write.
  'registry.resolvePcForPair': { verdict: 'refused', why: 'mobile:pair — a replica cannot resolve any code (empty in-memory governor) so it calls a correct code invalid' },
  // 🔴 2026-09-02 (B4, WP-6) — 'forwarded', the phone's half of the same fix as
  // `revokeMobile` above (`unpair_mobile` verb).
  'registry.retireMobile': { verdict: 'forwarded', why: 'mobile:unpair — retired ON THE WRITER via /api/node/forward-sync; the replica falls back to the refusal when it cannot ask' },
  // 🔴 2026-09-02 (B6, WP-6) — 'forwarded', the `settings_update` verb
  // (`applySettingsUpdateOnWriter`'s PC_NAME_KEY branch).
  'registry.renamePc': { verdict: 'forwarded', why: 'settings:update reserved key device.pc_name — renamed ON THE WRITER via /api/node/forward-sync; the replica falls back to the refusal when it cannot ask' },
  // 🔴 2026-09-02 (B6, WP-6) — 'forwarded', the same `settings_update` verb's
  // ordinary KV branch (`applySettingsUpdateOnWriter`).
  'repo.write': { verdict: 'forwarded', why: 'settings:update — the KV row is written ON THE WRITER via /api/node/forward-sync; the replica falls back to the refusal when it cannot ask' },
  'registry.reapCrossAccountSiblings': {
    verdict: 'refused',
    why: 'reachable ONLY from inside pc:register, which is refused first — so unreachable on a replica',
  },

  // ── forwarded to the writer through the outbox ────────────────────────────
  'usageTracker.recordSttUsage': { verdict: 'forwarded', why: 'a replica gets the forwarding tracker (node-runtime), which never writes locally' },
  'usageTracker.recordLlmUsage': { verdict: 'forwarded', why: 'as above' },
  'usageTracker.recordQuotaRefusal': { verdict: 'forwarded', why: 'as above' },

  // ── in-memory: verified by reading the declaration, not by the name ───────
  'pairLimiter.recordFailure': { verdict: 'in-memory', why: 'PairRateLimiter — in-memory by design (WP-R23-1)' },
  'pairLimiter.recordSuccess': { verdict: 'in-memory', why: 'as above' },
  'loginLimiter.record': { verdict: 'in-memory', why: 'the register/login limiter instance, in-memory' },
  'store.setLastFocus': { verdict: 'in-memory', why: 'RoomStore — live socket presence only, never persisted' },
  'store.setFocusProcess': { verdict: 'in-memory', why: 'as above' },
  'sessions.put': { verdict: 'in-memory', why: 'AudioSessionRegistry — `private readonly entries = new Map()`' },
  'sessions.adopt': { verdict: 'in-memory', why: 'as above' },
  'pending.put': { verdict: 'in-memory', why: 'grant.handler — `private readonly entries = new Map()`' },
  'entries.delete': { verdict: 'in-memory', why: 'the same Map' },

  // ── 🔴 LOST: accepted on a replica and erased by the next pull ────────────
  'registry.reconnectPc': {
    verdict: 'lost',
    why: 'pc:reconnect — claimClientInstance/setOnline/stampMachineUid/stampPcid. Refusing it would stop a replica serving live sessions. setOnline in particular means a PC on a replica reads OFFLINE to its phone, which asks the writer.',
  },
  'registry.reconnectMobile': {
    verdict: 'lost',
    why: 'mobile:reconnect — touchLastSeen/setDeviceUid. Same reason, smaller consequence.',
  },
  // 2026-08-30: was 'lost'. The local write on a replica IS still erased by the
  // next pull — what changed is that the same heartbeat now also enqueues a
  // `pc.presence` forward, and the writer's copy is the one the console reads.
  // So the FACT reaches its reader; only a copy nobody reads is discarded.
  'pcs.touchLastSeen': { verdict: 'forwarded', why: 'heartbeat — forwarded via node-runtime stampPresence so the console can see a remote PC' },
  // B8/F3 (2026-09-02): the disconnect handler moved to its own file
  // (socket/handlers/disconnect.handler.ts, 800-line cap on bootstrap.ts) and
  // is scanned for the first time here. Same story as touchLastSeen above but
  // the other direction: the local `is_online=0` a replica writes is erased by
  // the next pull, and BEFORE this card nothing forwarded the `false` either —
  // the writer's row stayed `is_online=1` forever. Now the same stampPresence
  // instance carries `false` too, so the writer's copy (what the console and
  // reaper.ts's listStaleOffline actually read) reaches the truth.
  'pcs.setOnline': { verdict: 'forwarded', why: 'disconnect handler — forwarded via node-runtime stampPresence(pcId, false, …) so the writer learns a replica PC went offline' },
  // Still lost, and deliberately: a phone's last_seen_at has no cross-node
  // reader. Forwarding it would be work with no consumer — the defect shape this
  // whole file exists to make visible.
  'mobiles.touchLastSeen': { verdict: 'lost', why: 'heartbeat — no cross-node reader for a phone last_seen; refusing a heartbeat would be absurd' },
  'service.recordSignIn': { verdict: 'lost', why: 'auth — the sign-in audit row for a login served by a replica' },
};

/** Every `receiver.method(` in a handler file, comments stripped. */
function scanHandlers(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of readdirSync(HANDLER_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(HANDLER_DIR, file), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    for (const m of src.matchAll(/\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\(/g)) {
      if (!WRITE_ISH.test(m[2]!)) continue;
      const key = `${m[1]}.${m[2]}`;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key)!.add(file);
    }
  }
  return found;
}

describe('writer-only census — every write in a socket handler has a verdict', () => {
  it('🔴 POSITIVE CONTROL: the scan can actually see a write it is meant to see', () => {
    // Without this, a scan whose regex stopped matching would report「nothing
    // unclassified」 — the most reassuring possible way to be blind, and the
    // failure mode this repo has hit often enough to have a name for it
    // (先核你的尺子).
    const found = scanHandlers();
    expect(found.has('registry.registerPc')).toBe(true);
    expect(found.get('registry.registerPc')).toContain('pc.handler.ts');
    // And enough breadth that a regex matching one lucky name is not enough.
    expect(found.size).toBeGreaterThan(20);
  });

  it('no write in a handler is unclassified', () => {
    const found = scanHandlers();
    const unclassified = [...found.keys()].filter((k) => !(k in CENSUS)).sort();
    expect(
      unclassified,
      'A socket handler grew a write that nobody has classified. Decide which it is — ' +
        "'refused' (add it to node/writer-only.ts AND to writer-only-refusal.test), " +
        "'forwarded' (it must go through the outbox), 'in-memory' (READ the declaration, " +
        "do not trust the name), or 'lost' (an open account that blocks making srvjp " +
        'selectable). Then add a row to CENSUS with the reason.',
    ).toEqual([]);
  });

  it('the census has no rows for calls that no longer exist', () => {
    // A stale row is not harmless: it makes the table look like it covers more
    // than it does, and it is the half of drift that a「did I classify it?」
    // check can never catch on its own.
    const found = scanHandlers();
    const orphans = Object.keys(CENSUS).filter((k) => !found.has(k)).sort();
    expect(orphans, 'CENSUS rows whose call site is gone — delete them').toEqual([]);
  });

  it('🔴 the open account is still open, and says so out loud', () => {
    const lost = Object.entries(CENSUS).filter(([, v]) => v.verdict === 'lost').map(([k]) => k);
    // This is NOT an assertion that the number is right. It is an assertion that
    // somebody who reduces it has to come here and say so — because the tempting
    // way to make this column empty is to re-label, and re-labelling would make
    // the multi-node channel look finished while presence still hits the floor.
    expect(lost.sort()).toEqual([
      'mobiles.touchLastSeen',
      'registry.reconnectMobile',
      'registry.reconnectPc',
      'service.recordSignIn',
    ]);
  });
});
