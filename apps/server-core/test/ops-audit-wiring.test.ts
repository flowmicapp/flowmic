// 0.2.48 — "does the audit store really have a production writer" + behaviour when the trail write fails.
//
// SPEC-REF: src/http/ops-audit-trail.ts (the gate's trail, and its failure policy)
//           src/db/repos/ops-audit.repo.ts (the file header this test discharges)
//           docs/strategy/2026-08-02-o2-usage-route-contract.md §1.3
//           CLAUDE.md anti-façade ①③④ / red line: no silent failure
//
// WHY THIS FILE EXISTS, in one sentence: `ops-audit.repo.ts`'s header says
// "Grep `opsAudit.append` outside tests: it comes back empty … this is the FIRST
// thing to re-check when reading this file later" — and a rule that has to be
// re-checked by hand is a rule that will be re-checked once. This file is that
// grep, as an assertion.
//
// ⚠️ WHY NOT `verify/lint/module-reachability.mjs`: that lint's SPEC_MODULES list
// is hand-maintained and it only proves a module is IMPORT-reachable from
// index.ts. Import-reachable is not called: `ops-audit.repo.ts` was import-
// reachable through db/connection.ts for the whole of 0.2.47 and had zero
// writers. What has to be true is that a PRODUCTION code path CALLS append, which
// is a different question and needs a different instrument.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService } from '../src/auth/auth-service';
import { log } from '../src/log';
import { tryHandleOpsRoutes, type OpsRoutesDeps } from '../src/http/ops-routes';
import { ADMIN_GATED_ROUTES, MUTATING_ADMIN_GATED_ROUTES } from '../src/http/ops-audit-trail';
import { stripTsComments as stripComments } from '../../../verify/lint/strip-ts-comments.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');
const SECRET = 'ops-audit-wiring-secret-32-bytes-xxxx';

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFilesUnder(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** repo-relative paths under src/ whose (comment-stripped) text matches. */
function srcFilesMatching(re: RegExp): string[] {
  return tsFilesUnder(SRC)
    .filter((f) => re.test(stripComments(readFileSync(f, 'utf8'))))
    .map((f) => relative(SRC, f).replace(/\\/g, '/'))
    .sort();
}

// ── ① anti-façade: these three facts must be "really written that way in the code" ─────────────────────────
describe('audit-store wiring — the [unwired] grep, as an assertion', () => {
  it('🔴 `append` has at least one PRODUCTION caller, and it is the admin gate', () => {
    const callers = srcFilesMatching(/\b(?:audit|opsAudit)\.append\s*\(/);
    // The whole point. In 0.2.47 this array was EMPTY and the repo header said so.
    //
    // 🔴 A2-3 (2026-08-12) — there are TWO writers now, and the second one is
    // not a duplicate of the first. `ops-audit-trail.ts` writes the ROUTE-LEVEL
    // row ("this admin called this path") and cannot know what a route MEANS;
    // `account-restriction-routes.ts` writes the BUSINESS row ("this account's
    // restriction changed, for this reason") and additionally makes its own
    // append FAIL-CLOSED — if the row cannot be written, the account is not
    // touched. That second property is the whole reason it appends itself
    // instead of asking the gate to carry a `detail` for it.
    // ⚠️ A THIRD entry appearing here is a real question, not a formality: it
    // means some other route decided to record its own action, and whoever adds
    // it owes the same two answers (what does the row assert, and what happens
    // when the append throws).
    expect(
      callers,
      'ops_audit_log has no production writer — it is 【not wired】 again, and must not be\n' +
        'reported as 「implemented」. The intended writers are http/ops-audit-trail.ts adminGate\n' +
        '(route-level rows) and http/account-restriction-routes.ts (its business row).',
    ).toEqual(['http/account-restriction-routes.ts', 'http/ops-audit-trail.ts']);
  });

  it('🔴 bootstrap actually hands the repo to a route surface', () => {
    // The 0.2.47 defect was NOT a missing repo — db/connection.ts built one all
    // along. It was that bootstrap never passed it into `console: {…}`, so the
    // only object that could have written a row never reached anything that
    // wanted to. A caller inside a module nobody wires is still [unwired].
    const wired = srcFilesMatching(/\bopsAudit\s*:\s*db\.opsAudit\b|\baudit\s*:\s*db\.opsAudit\b/);
    // VERIFY-1 (2026-08-11): the HttpDeps composition moved VERBATIM from
    // bootstrap.ts to bootstrap-http-deps.ts (split-for-size; that file's
    // header is the move record). The wiring root still calls it — this
    // assertion follows the code, not the filename it used to live in.
    expect(wired, 'db.opsAudit is constructed but handed to nobody — check bootstrap-http-deps.ts').toContain('bootstrap-http-deps.ts');
  });

  it('🔴 no route calls the bare decision `adminFromBearer` — they all go through the gate', () => {
    // A route wired straight to `adminFromBearer` is correctly gated and
    // completely untraceable, which is WORSE than an ungated route because it
    // looks right in review. account-auth.ts is the definition; ops-audit-trail.ts
    // is the one wrapper. Anything else in this list is a route that leaves no
    // trail.
    const callers = srcFilesMatching(/\badminFromBearer\s*\(/);
    expect(
      callers,
      'a module calls adminFromBearer directly — its admin actions leave NO audit row.\n' +
        'Call http/ops-audit-trail.ts `adminGate` instead.',
    ).toEqual(['http/account-auth.ts', 'http/ops-audit-trail.ts']);
  });

  it('every admin-gated route is a GET — EXCEPT the declared mutators, and that list is exactly one', () => {
    // recordGateOutcome chooses "serve the request, shout about the failed write"
    // and its argument is explicitly bounded by this fact. The moment a mutating
    // ops route appears, that policy has to be re-argued — so the fact is asserted
    // here rather than left as a sentence in a comment nobody re-reads.
    //
    // 🔴 2026-08-12 (card A2-3): THAT MOMENT ARRIVED, AND THIS ASSERTION IS HOW.
    // Adding `POST /api/ops/users/restrict` to ADMIN_GATED_ROUTES turned the old
    // form of this test RED, verbatim:
    //     AssertionError: POST /api/ops/users/restrict is not a GET —
    //     re-argue recordGateOutcome's failure policy: expected false to be true
    // That red was the instrument working exactly as its author intended, so it
    // is recorded here rather than described. What replaces the assertion is NOT
    // "skip the mutators": it is "the mutators are a DECLARED list, and it is
    // this one" — so a SECOND mutating admin route still turns this red and still
    // forces somebody to re-read the policy paragraph, which is the whole value
    // of the original line.
    expect(ADMIN_GATED_ROUTES.length).toBeGreaterThan(0);
    // The declared mutators must really be gated routes (a stale entry naming a
    // route the fence dropped would silently exempt nothing and hide a GET).
    for (const m of MUTATING_ADMIN_GATED_ROUTES) {
      expect(ADMIN_GATED_ROUTES, `${m} is declared mutating but is not an admin-gated route`).toContain(m);
    }
    for (const r of ADMIN_GATED_ROUTES) {
      if (MUTATING_ADMIN_GATED_ROUTES.includes(r)) continue;
      expect(r.startsWith('GET '), `${r} is not a GET — re-argue recordGateOutcome's failure policy`).toBe(true);
    }
    // 🔴 The census itself, so growing the exemption is a DELIBERATE edit of this
    // line and never a side effect of adding a route to the fence.
    expect(
      [...MUTATING_ADMIN_GATED_ROUTES].sort(),
      'a second admin-gated route MUTATES. recordGateOutcome serves-and-shouts on a failed\n' +
        'audit write, which is only defensible for reads. Whatever you added must write its\n' +
        'own business row FAIL-CLOSED, the way http/account-restriction-routes.ts does.',
    ).toEqual(['POST /api/ops/users/restrict']);
  });

  it('🔴 the one mutating admin route does NOT rely on this module\'s serve-but-shout policy', () => {
    // The assertion above says a mutator EXISTS. This one says it did the thing
    // that existence obliges — because "we re-argued the policy" is a claim about
    // code, and a claim about code belongs in a test rather than in a paragraph.
    //
    // Read from the source: the route must append its own row and, in the catch,
    // must NOT fall through to the write. The behavioural proof (a throwing sink
    // leaves `restricted_at` untouched and answers 503) is in
    // test/account-restriction.test.ts with a positive control; this is the
    // structural half — it fails if somebody later moves the append AFTER the
    // mutation, which no behavioural test with a WORKING sink would notice.
    const src = stripComments(readFileSync(join(SRC, 'http', 'account-restriction-routes.ts'), 'utf8'));
    const appendAt = src.indexOf('audit.append(');
    const writeAt = src.indexOf('users.setRestricted(');
    expect(appendAt, 'the mutating route does not append a business row at all').toBeGreaterThan(-1);
    expect(writeAt, 'the mutating route does not write the column').toBeGreaterThan(-1);
    expect(
      appendAt,
      'the audit append must come BEFORE the account write. Write-then-append produces the\n' +
        'one state ops-audit-trail.ts forbids: a change nobody recorded, reported as success.',
    ).toBeLessThan(writeAt);
  });
});

// ── ② when the trail cannot be written, the request is still served, but never silently ───────────────────────────
describe('trail-write failure — the request is served, and the failure is LOUD', () => {
  let db: DbConnection | null = null;
  let server: Server | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    db?.close();
    db = null;
  });

  /** A real DB + a real AuthService + a real admin, with an INJECTABLE audit sink
   *  — the one seam this test needs. Everything else is the production object. */
  async function boot(sink: OpsRoutesDeps['audit']): Promise<{ url: string; bearer: Record<string, string> }> {
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('wiring-test-secret-32-bytes-or-more') });
    const auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8') });
    const admin = db.users.insert({ id: 'u-admin', email: 'a@w.co', display_name: 'A', is_admin: true });
    db.users.insert({ id: 'u-x', display_name: 'X' });
    db.usage.increment('u-x', '2026-08', { stt_minutes: 3 });
    const deps: OpsRoutesDeps = { auth, usage: db.usage, audit: sink, auditLog: db.opsAudit };
    server = createServer((req, res) => {
      if (!tryHandleOpsRoutes(req, res, deps)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      bearer: { authorization: `Bearer ${auth.issueToken(admin).token}` },
    };
  }

  it('🔴 a sink that throws does NOT break the read — and logs at ERROR', async () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { url, bearer } = await boot({
      append(): number {
        throw new Error('disk is full');
      },
    });

    const res = await fetch(`${url}/api/ops/usage/summary?month=2026-08`, { headers: bearer });
    // ① The read still works. An unwritable audit table must not become "the ops
    //    console will not open" on a surface whose only power is to LOOK — see recordGateOutcome.
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: { stt_minutes: number } }).total.stt_minutes).toBe(3);
    // ② …and it is NOT silent (CLAUDE.md red line, both directions). The message names
    //    what happened AND what did not, and carries the driver's own reason.
    expect(errors).toHaveBeenCalledTimes(1);
    const [msg, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain('append FAILED');
    expect(msg).toContain('NOT recorded');
    expect(fields).toMatchObject({
      route: 'GET /api/ops/usage/summary',
      actor: 'u-admin',
      reason: 'disk is full',
    });
  });

  it('🔴 POSITIVE CONTROL — with a working sink the same request logs NO error', async () => {
    // Without this, the spy above could be seeing an error that every request
    // produces, and the assertion would be measuring nothing.
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const written: string[] = [];
    const { url, bearer } = await boot({
      append(input): number {
        written.push(`${input.action} ${input.target_id ?? ''}`);
        return written.length;
      },
    });

    const res = await fetch(`${url}/api/ops/usage/summary?month=2026-08`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(errors).not.toHaveBeenCalled();
    expect(written).toEqual(['ops.admin.granted GET /api/ops/usage/summary']);
  });

  it('a throwing sink cannot turn a 403 into a 500 either', async () => {
    // The denied path writes a row too, so it has the same exposure — and the
    // refusal is the answer a caller most needs to receive intact.
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { url } = await boot({
      append(): number {
        throw new Error('disk is full');
      },
    });
    if (!db) throw new Error('unreachable');
    const auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8') });
    const normal = db.users.findById('u-x');
    if (!normal) throw new Error('unreachable');
    const res = await fetch(`${url}/api/ops/usage/months`, {
      headers: { authorization: `Bearer ${auth.issueToken(normal).token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('ADMIN_ONLY');
  });
});
