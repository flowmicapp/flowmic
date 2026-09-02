// The wiring nothing else can prove.
//
// SPEC-REF: apps/server-core/src/room/pc-presence.ts
//           apps/server-core/src/socket/handlers/mobile.handler.ts
//             (`rowsFromReplicationPull` — OPTIONAL there, and this file is the
//              reason that is allowed)
//
// ── WHY A SOURCE-TREE ASSERTION, WHICH IS NORMALLY THE WEAK KIND ────────────
// `PresenceRoutesDeps` makes its two node facts REQUIRED, so bootstrap cannot
// construct that dep without them: the compiler is the gate and no test is
// needed. The socket side cannot do the same. `nodeId` there is optional
// because absence legitimately means「single node」, and a REQUIRED partner
// beside an optional one would be a compile error every deployment shape has to
// answer with a lie. So `rowsFromReplicationPull` is optional too — and an
// optional dep that bootstrap forgets is exactly this repo's #1 historical bug:
// a capability defined and never called, with every gate green.
//
// What forgetting it would cost, stated so nobody has to guess whether this
// file earns its place: on a replica, a healthy remote PC's stamp is up to one
// replication pull old, so a 20 s window would report it online right after a
// pull and offline ten seconds later — the phone's instance list blinking its
// computer in and out every thirty seconds while nothing is wrong. That reads
// as a network fault, not as a missing line of wiring, which is why it must not
// be discoverable only in production.
//
// ⚠️ WHAT THIS DOES NOT PROVE. It proves the text is there, not that the value
// is right — a `rowsFromReplicationPull: false` hard-coded on a replica would
// pass. The value is pinned by cross-node-phone-presence.test.ts, which drives
// the real handler with both settings and asserts opposite answers. Two halves;
// neither is the other.
//
// Precedent for reading the tree: test/mail-password-reset.test.ts asserts from
// the source that bootstrap is where the mailer gets built.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripTsComments } from '../../../verify/lint/strip-ts-comments.mjs';

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
}

/** 🔴 CODE ONLY. The first version of the last case below matched the comment
 *  that RECORDS the old expression and went red against a correct file — the
 *  「would a correct product also match this string?」 trap, in one line. The
 *  same helper the enc-inventory and admin-gate sweeps use. */
function code(rel: string): string {
  return stripTsComments(source(rel));
}

describe('the presence facts reach the handlers that need them', () => {
  it('🔴 bootstrap tells the mobile handlers whether this node reads a replicated copy', () => {
    const boot = source('bootstrap.ts');
    const call = boot.slice(boot.indexOf('registerMobileHandlers(socket, {'));
    const line = call.slice(0, call.indexOf('\n'));
    expect(line).toContain('rowsFromReplicationPull:');
    // The VALUE has to come from the resolved node role, not from a literal:
    // `readNodeConfig` is the one place that decides what this process is
    // (node/node-config.ts), and a second derivation is a second answer.
    expect(line).toContain("nodeRuntime.nodeConfig.role === 'replica'");
  });

  it('bootstrap gives GET /api/pc/presence a per-request node id, not a process-wide one', () => {
    // `home_node` is stamped with the id of the DOOR a PC arrived through
    // (bootstrap's `socketNodeId`). Comparing a door id against a process id
    // would call a PC on this very process remote — and the pair/reconnect acks
    // and this route would then answer one question two ways.
    const deps = source('bootstrap-http-deps.ts');
    const presence = deps.slice(deps.indexOf('    presence: {'), deps.indexOf('    pairing: registry,'));
    expect(presence).toContain('nodeIdFor:');
    expect(presence).toContain('nodeIdForHost(');
    expect(presence).toContain('requestHost(');
    expect(presence).toContain("rowsFromReplicationPull: w.nodeRuntime.nodeConfig.role === 'replica'");
  });

  it('no phone-facing surface computes presence for itself any more', () => {
    // F7 (2026-09-02 audit) — the old expression's ONE exception is gone: the
    // `mobile:list-pcs` handler that carried it (no phone ever emitted the
    // event; grep across apps/mobile found no producer) was deleted along with
    // its sole caller. The exception this comment used to name no longer
    // exists, so the assertion is now unconditional rather than scoped to
    // `pc_online:` lines — a second copy anywhere in this file is exactly the
    // regression this test exists to catch.
    const OLD = 'store.getPc(pc.room_uuid) !== null';
    expect(code('http/presence-routes.ts')).not.toContain(OLD);
    expect(code('socket/handlers/mobile.handler.ts')).not.toContain(OLD);
  });
});
