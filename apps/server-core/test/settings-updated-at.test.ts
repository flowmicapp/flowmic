import { describe, it, expect } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerSettingsHandlers, SETTINGS_STAMP_MAX_SKEW_MS } from '../src/socket/handlers/settings.handler';
import type { AuthContext } from '../src/auth/middleware';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

// G2 (0.3.x) — the SERVER half of cross-channel settings convergence.
// Contract: docs/rebuild/04-PROTOCOL-SPEC.md §3.7-a, 05 §5.1/§5.2.
//
// 🔴 WHY THE REGRESS GUARD IS THE LOAD-BEARING PART, not the timestamp.
// `scenario.card` has TWO writers — the phone (settings_client.dart) and the
// DESKTOP (desktop settings-client.ts) — and two writers across two servers make
// FOUR copies. The moment clients start pushing their local copy on reconnect to
// converge, a phone holding a week-old card can clobber a desktop edit made five
// minutes ago. Without the refusal below, the convergence fix CREATES a
// data-loss path that does not exist today: strictly worse than the divergence
// it cures. Everything here is about that, not about carrying a string.
//
// ⚠️ What this file does NOT prove: that two DIFFERENT servers converge. There is
// one server here. The two-server case is golden G22, which is the only place in
// the repo where a standalone and a saas instance exist at once.
//
// REVERSE CONTROLS (executed 2026-08-16, this tree) — recorded here because a
// negative assertion nobody has watched fail is not evidence:
//   1. Flip the guard's comparison `existingMs > incomingMs` to `<` —
//      4 failed / 7 passed (this draft predicted 2; the measured number is 4 and
//      the measurement is what stands):
//        FAIL  a NEWER stamp wins and is what gets stored
//          AssertionError: expected 'v1-older' to be 'v2-newer'
//        FAIL  an OLDER stamp is refused: the row is not moved backwards
//          AssertionError: expected 'v1-older' to be 'v2-newer'
//        FAIL  the loser is TOLD, with the value that won
//          AssertionError: expected [] to have a length of 1 but got +0
//        FAIL  a refused write does NOT broadcast
//          AssertionError: expected [ { event: 'settings:updated', …(1) } ] to
//                          have a length of +0 but got 1
//      Restored byte-identical, re-run: 11 passed.
//      🔴 Note for the record: that same break leaves the FUTURE MOBILE HALF
//      entirely green — a client that only ever pushes and re-reads its own copy
//      cannot see whose write survived. That is why neither half may be called
//      "the acceptance test" on its own.
//   2. Remove the clamp (store `parsed.data.updated_at` unconditionally) —
//      1 failed / 10 passed:
//        FAIL  a stamp from the future is clamped, so the row cannot be frozen
//          AssertionError: expected '2027-09-20T20:47:39.989Z' not to be
//                          '2027-09-20T20:47:39.989Z'
//      Restored byte-identical, re-run: 11 passed.

const U = 'u-g2';

/** A minimal origin socket that captures what the handler emits back to it, plus
 *  the ack. Deliberately NOT a real socket.io server: the frames this file
 *  asserts on are the ones the handler addresses to the ORIGIN, and a real
 *  server would let a broadcast路径 mask a missing direct emit. */
function harness(kind: AuthContext['kind'] = 'pc') {
  // No seeding: this file is about ONE key's stamp, and the seeded rows would
  // only add noise to the settings:list assertions.
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('g2-secret-32-bytes-or-more-xxxxx') });
  db.users.insert({ id: U, display_name: 'G2', plan: 'free' });
  const emittedToOrigin: { event: string; payload: unknown }[] = [];
  const broadcastToPeer: { event: string; payload: unknown }[] = [];

  const peer = {
    id: 'peer',
    data: { auth: { userId: U, kind: 'pc' } as AuthContext },
    emit: (event: string, payload: unknown) => { broadcastToPeer.push({ event, payload }); },
  };
  const io = { sockets: { sockets: new Map<string, unknown>([['peer', peer]]) } } as unknown as Server;

  const handlers = new Map<string, (p: unknown, ack: unknown) => void>();
  const origin = {
    id: 'origin',
    data: { auth: { userId: U, kind } as AuthContext },
    on(event: string, fn: (p: unknown, ack: unknown) => void) { handlers.set(event, fn); return this; },
    emit: (event: string, payload: unknown) => { emittedToOrigin.push({ event, payload }); },
  };
  registerSettingsHandlers(origin as unknown as Socket, { io, repo: db.settings });

  const update = (payload: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => { handlers.get('settings:update')!(payload, resolve as unknown); });
  const list = (): Promise<{ items: { key: string; value: unknown; updated_at?: string }[] }> =>
    new Promise((resolve) => { handlers.get('settings:list')!({}, resolve as unknown); });

  return { db, update, list, emittedToOrigin, broadcastToPeer };
}

const KEY = 'scenario.card';
const card = (tag: string) => ({ professions: [tag], domains: [], packs: [], terms: [] });
const T1 = '2026-08-16T10:00:00.000Z';
const T2 = '2026-08-16T11:00:00.000Z';

describe('G2 settings updated_at — the server refuses to move a row backwards', () => {
  it('a NEWER stamp wins and is what gets stored', async () => {
    const h = harness();
    await h.update({ key: KEY, value: card('v1-older'), updated_at: T1 });
    await h.update({ key: KEY, value: card('v2-newer'), updated_at: T2 });

    const row = h.db.settings.read(U, KEY)!;
    expect((row.value as { professions: string[] }).professions[0]).toBe('v2-newer');
    expect(row.updated_at).toBe(T2);
  });

  it('🔴 an OLDER stamp is refused: the row is not moved backwards', async () => {
    const h = harness();
    await h.update({ key: KEY, value: card('v2-newer'), updated_at: T2 });
    const ack = await h.update({ key: KEY, value: card('v1-older'), updated_at: T1 });

    // The ack is still ok:true — the sender did nothing wrong, it is merely
    // holding an older copy. This is not an error condition and deliberately
    // mints no error code.
    expect(ack).toEqual({ ok: true });
    const row = h.db.settings.read(U, KEY)!;
    expect((row.value as { professions: string[] }).professions[0]).toBe('v2-newer');
    expect(row.updated_at).toBe(T2);
  });

  it('🔴 the loser is TOLD, with the value that won', async () => {
    const h = harness();
    await h.update({ key: KEY, value: card('v2-newer'), updated_at: T2 });
    h.emittedToOrigin.length = 0;
    h.broadcastToPeer.length = 0;
    await h.update({ key: KEY, value: card('v1-older'), updated_at: T1 });

    // A silent ok:true would leave the sender believing its stale copy is now
    // authoritative — 没有静默失败 in the direction that says a thing was done
    // when it was not. So the refusal answers with the copy that won.
    expect(h.emittedToOrigin).toHaveLength(1);
    const frame = h.emittedToOrigin[0] as { event: string; payload: { key: string; value: unknown; updated_at?: string } };
    expect(frame.event).toBe('settings:updated');
    expect(frame.payload.key).toBe(KEY);
    expect((frame.payload.value as { professions: string[] }).professions[0]).toBe('v2-newer');
    expect(frame.payload.updated_at).toBe(T2);
  });

  it('🔴 a refused write does NOT broadcast — peers keep the copy they already hold', async () => {
    const h = harness();
    await h.update({ key: KEY, value: card('v2-newer'), updated_at: T2 });
    h.broadcastToPeer.length = 0;
    await h.update({ key: KEY, value: card('v1-older'), updated_at: T1 });
    // Positive control that the probe is not blind: the peer DID hear the
    // accepted write below, so this zero means "nothing was sent", not
    // "nothing is ever seen here".
    expect(h.broadcastToPeer).toHaveLength(0);
    await h.update({ key: KEY, value: card('v3'), updated_at: '2026-08-16T12:00:00.000Z' });
    expect(h.broadcastToPeer).toHaveLength(1);
  });
});

describe('G2 absence means UNKNOWN — never epoch', () => {
  it('a write with NO stamp is accepted even when a newer row exists', async () => {
    // The compatibility rule, and the one most likely to be "optimised" away by
    // someone reading absence as 1970: every deployed client sends no stamp, and
    // treating them as infinitely stale would silently drop all of their writes.
    const h = harness();
    await h.update({ key: KEY, value: card('v2-newer'), updated_at: T2 });
    await h.update({ key: KEY, value: card('no-stamp') });

    expect((h.db.settings.read(U, KEY)!.value as { professions: string[] }).professions[0]).toBe('no-stamp');
  });

  it('🔴 a STORED row whose stamp is not a time cannot freeze the key', async () => {
    // MEASURED correction to this test's first draft, which wrote a row through
    // the handler with no stamp and expected it to be "uncomparable". It is not:
    // a stamped-less write is stored with `now()`, so every row the handler
    // writes has a real time. The genuinely uncomparable case is a row that got
    // its stamp from somewhere else — a legacy row, a direct repo write, a
    // future migration — and THAT is the branch with no other coverage.
    //
    // If such a row were compared as a string it would outrank every real
    // timestamp and the key would be permanently unwritable. Treating it as
    // unknown degrades to today's behaviour instead.
    const h = harness();
    h.db.settings.write(U, KEY, card('legacy'), 'not-a-time');
    await h.update({ key: KEY, value: card('repaired'), updated_at: T1 });

    const row = h.db.settings.read(U, KEY)!;
    expect((row.value as { professions: string[] }).professions[0]).toBe('repaired');
    expect(row.updated_at).toBe(T1);
  });

  it('🔴 an UNPARSEABLE stamp is treated as absent, not as a comparable value', async () => {
    // `Iso8601` is `z.string().min(1)` — a name, not a validator (MEASURED; it
    // is pinned in packages/protocol/test/settings-updated-at.test.ts). String
    // comparison would rank 'yesterday' ABOVE '2026-08-16T…' (lowercase 'y' >
    // '2'), so garbage would win every comparison and could pin the row forever.
    const h = harness();
    await h.update({ key: KEY, value: card('v2-newer'), updated_at: T2 });
    await h.update({ key: KEY, value: card('garbage'), updated_at: 'yesterday' });

    const row = h.db.settings.read(U, KEY)!;
    // Accepted (absence ⇒ today's behaviour) …
    expect((row.value as { professions: string[] }).professions[0]).toBe('garbage');
    // … and the garbage was NOT stored as the row's time.
    expect(row.updated_at).not.toBe('yesterday');
    expect(Number.isNaN(Date.parse(row.updated_at))).toBe(false);
  });
});

describe('G2 the clamp — a future stamp must not freeze a key forever', () => {
  it('🔴 a stamp from the future is clamped, so the row cannot be frozen', async () => {
    // The one new failure mode this design introduces: the guard refuses
    // anything older than the stored stamp, so a row stamped in the year 3000
    // would be permanently unwritable. Closed at the boundary.
    const h = harness();
    const farFuture = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
    await h.update({ key: KEY, value: card('from-the-future'), updated_at: farFuture });

    const row = h.db.settings.read(U, KEY)!;
    expect(row.updated_at).not.toBe(farFuture);
    expect(Date.parse(row.updated_at)).toBeLessThanOrEqual(Date.now() + SETTINGS_STAMP_MAX_SKEW_MS);

    // …and the proof it is not frozen: an ordinary later write still lands.
    await h.update({ key: KEY, value: card('after'), updated_at: new Date().toISOString() });
    expect((h.db.settings.read(U, KEY)!.value as { professions: string[] }).professions[0]).toBe('after');
  });

  it('a stamp inside the skew window is kept verbatim', async () => {
    // The clamp must not re-stamp honest edits: a client seconds ahead of this
    // server is normal, and replacing its edit time with ours would throw away
    // the only fact the field exists to carry.
    const h = harness();
    const slightlyAhead = new Date(Date.now() + 30_000).toISOString();
    await h.update({ key: KEY, value: card('nearly-now'), updated_at: slightlyAhead });
    expect(h.db.settings.read(U, KEY)!.updated_at).toBe(slightlyAhead);
  });
});

describe('G2 settings:list puts the stamp on the wire', () => {
  it('a stored row comes back with the stamp it was written with', async () => {
    const h = harness();
    await h.update({ key: KEY, value: card('v1'), updated_at: T1 });
    const listed = await h.list();
    const item = listed.items.find((i) => i.key === KEY);
    expect(item?.updated_at).toBe(T1);
  });

  it('🔴 the mobile arm carries it too — that arm is the one that has to converge', async () => {
    // The phone is the client with two channels to reconcile. Dropping the stamp
    // on exactly the arm that needs it is the shape this whole card exists to
    // remove, and it would look identical to "the feature works" from the PC.
    const h = harness('mobile');
    await h.update({ key: KEY, value: card('v1'), updated_at: T1 });
    const listed = await h.list();
    const item = listed.items.find((i) => i.key === KEY);
    expect(item?.updated_at).toBe(T1);
  });
});
