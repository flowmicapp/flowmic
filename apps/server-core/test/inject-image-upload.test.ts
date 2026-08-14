// POST /api/inject/image — the phone's picture delivery over a fresh http
// request (RCA-v3, 2026-07-30).
//
// What these tests pin is the route's HONESTY at every exit: auth is checked
// before the body is read, every refusal carries a real code, the response
// carries the PC's real verdict (never an optimistic phantom), a missing
// verdict is named as such (INJECT_RESULT_TIMEOUT) rather than dressed as a
// failure or a success, and file persistence is reported truthfully
// (saved:false when it did not happen — the delivery itself is never blocked
// by it).

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Socket } from 'socket.io';
import { tryHandleInjectRoutes, type InjectRoutesDeps } from '../src/http/inject-routes';
import { InjectPendingRegistry } from '../src/socket/inject-pending';
import type { Registry } from '../src/room/registry';
import type { RoomStore } from '../src/room/store';
import type { ReleaseSuppression } from '../src/room/release-suppression';

const ROOM = 'room-upload';
/** The `pc_devices.id` the harness's registry resolves from `good-token` — i.e.
 *  the value this route compares `target_pc_id` against (`pc.id`). One constant
 *  so a test can never address a PC the fixture does not actually bind to. */
const BOUND_PC = 'pc-1';

function request(method: string, url: string, body?: string, token?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers = token !== undefined ? { authorization: `Bearer ${token}` } : {};
  return req;
}

function response(): { res: ServerResponse; done: Promise<{ status: number; body: Record<string, unknown> }> } {
  let settle: (v: { status: number; body: Record<string, unknown> }) => void;
  const done = new Promise<{ status: number; body: Record<string, unknown> }>((r) => (settle = r));
  let status = 0;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      settle({ status, body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {} });
    },
    once() {
      return res;
    },
  } as unknown as ServerResponse;
  return { res, done };
}

// 0.2.27: `item` is no longer READ by the route (the server stores no
// transcripts), but a 0.2.26 phone still puts it in the body — so every test here
// keeps sending it, and that is the point: an ignored field must not turn a
// working delivery into a rejection.
function validItem(id = 'entry-1'): Record<string, unknown> {
  return {
    id,
    pairing_id: 'claimed-pairing',
    pc_device_id: 'claimed-pc',
    user_id: 'claimed-user',
    mobile_id: 'claimed-mobile',
    mode: 'realtime',
    source_text: '🖼 JPEG · 3 B',
    source_lang: null,
    output_text: '🖼 JPEG · 3 B',
    output_lang: null,
    duration_ms: null,
    segments_count: 0,
    status: 'failed',
    entry_type: 'image',
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
  };
}

function validRequest(requestId = 'i1-test'): Record<string, unknown> {
  return {
    text: '',
    source: 'image',
    request_id: requestId,
    entry_id: 'entry-1',
    // 0.2.33: an address is part of being VALID. A frame without one is refused
    // (INJECT_PC_UNSPECIFIED) before the request_id ledger, the hold-out gate, the
    // file write or the relay — so every test below that is about one of THOSE
    // would otherwise be asserting on a frame that never got near them. `pc-1` is
    // the id the harness's registry resolves from `good-token`, i.e. the same
    // column the route compares (`pc.id`).
    target_pc_id: BOUND_PC,
    image_b64: 'QUJD', // "ABC"
    image_mime: 'image/jpeg',
  };
}

interface Harness {
  deps: InjectRoutesDeps;
  pending: InjectPendingRegistry;
  pcEmits: { event: string; payload: unknown }[];
  persist: ReturnType<typeof vi.fn>;
}

function harness(opts: { pcOnline?: boolean; suppressed?: { ms: number; reason: 'manual' | 'busy' } } = {}): Harness {
  const pcEmits: { event: string; payload: unknown }[] = [];
  const pcSocket = { id: 'pc-sock', emit: (event: string, payload: unknown) => pcEmits.push({ event, payload }) };
  const registry = {
    reconnectMobile: (token: string) =>
      token === 'good-token'
        ? {
            mobile: { id: 'pair-1', user_id: 'u-real' },
            pc: { id: 'pc-1', user_id: 'u-real', room_uuid: ROOM },
          }
        : null,
  } as unknown as Registry;
  const store = {
    getPc: (room: string) => (room === ROOM && (opts.pcOnline ?? true) ? (pcSocket as unknown as Socket) : null),
    getMobiles: () => [],
  } as unknown as RoomStore<Socket>;
  const pending = new InjectPendingRegistry();
  const persist = vi.fn(() => 'C:/data/inbox-images/x.jpg');
  const suppression = opts.suppressed
    ? ({
        remainingMs: () => opts.suppressed!.ms,
        reasonFor: () => opts.suppressed!.reason,
      } as unknown as ReleaseSuppression)
    : undefined;
  return {
    deps: {
      registry,
      store,
      pending,
      persist,
      ...(suppression ? { suppression } : {}),
      resultWaitMs: 50,
      now: () => '2026-07-30T01:00:00.000Z',
    },
    pending,
    pcEmits,
    persist,
  };
}

function post(deps: InjectRoutesDeps, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, done } = response();
  const handled = tryHandleInjectRoutes(
    request('POST', '/api/inject/image', JSON.stringify(body), token),
    res,
    deps,
  );
  expect(handled).toBe(true);
  return done;
}

describe('POST /api/inject/image', () => {
  it('relays the frame and answers with the PC\'s real verdict', async () => {
    const h = harness();
    const answer = post(h.deps, { item: validItem(), request: validRequest('i1-ok') }, 'good-token');
    // The PC "answers" through the same pending bridge relay.handler feeds.
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    h.pending.resolve({ ok: true, mode: 'clipboard', request_id: 'i1-ok', entry_id: 'entry-1' });
    const out = await answer;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, mode: 'clipboard', request_id: 'i1-ok', saved: true });
    // The image bytes reached the persist seam decoded.
    expect(h.persist).toHaveBeenCalledTimes(1);
    const [name, bytes] = h.persist.mock.calls[0]! as [string, Buffer];
    expect(name).toMatch(/i1-ok\.jpg$/);
    expect(bytes.toString('utf8')).toBe('ABC');
    // 0.2.27, and this is now the assertion (inverted on purpose): the route
    // writes NO server row and therefore pushes NO `history:updated`. The PC
    // learns this picture from the delivery it is receiving — the ONE frame it
    // gets — instead of from a second, server-authored copy of the same fact.
    expect(h.pcEmits.some((e) => e.event === 'history:updated')).toBe(false);
    expect(h.pcEmits.map((e) => e.event)).toEqual(['inject:request']);
  });

  it('a failed verdict travels back as-is — never softened', async () => {
    const h = harness();
    const answer = post(h.deps, { item: validItem(), request: validRequest('i1-fail') }, 'good-token');
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    h.pending.resolve({ ok: false, mode: 'clipboard', error: 'INJECT_CLIPBOARD_FAIL', request_id: 'i1-fail' });
    const out = await answer;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: false, mode: 'clipboard', error: 'INJECT_CLIPBOARD_FAIL' });
  });

  it('refuses without a token — before any body is read', async () => {
    const h = harness();
    const out = await post(h.deps, { item: validItem(), request: validRequest() });
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ ok: false, error: 'AUTH_TOKEN_INVALID' });
    expect(h.pcEmits).toHaveLength(0);
  });

  it('refuses an unknown token', async () => {
    const h = harness();
    const out = await post(h.deps, { item: validItem(), request: validRequest() }, 'bad-token');
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ ok: false, error: 'AUTH_TOKEN_INVALID' });
  });

  it('names INJECT_PC_OFFLINE and echoes the delivery it refused (no row is stamped — 0.2.27)', async () => {
    const h = harness({ pcOnline: false });
    const out = await post(h.deps, { item: validItem(), request: validRequest() }, 'good-token');
    expect(out.status).toBe(200);
    // The verdict + BOTH correlation ids: this response is now the only way the
    // phone (the row's owner) learns this delivery failed, since the server-side
    // `failed` stamp went with `transcript_history`.
    expect(out.body).toMatchObject({ ok: false, error: 'INJECT_PC_OFFLINE', request_id: 'i1-test', entry_id: 'entry-1' });
  });

  it('a verdict that never comes is named INJECT_RESULT_TIMEOUT, not invented', async () => {
    const h = harness();
    const out = await post(h.deps, { item: validItem(), request: validRequest('i1-slow') }, 'good-token');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: false, error: 'INJECT_RESULT_TIMEOUT', relayed: true });
  });

  it('rejects an over-cap image with INJECT_FRAME_TOO_LARGE at the schema boundary', async () => {
    const h = harness();
    const big = 'A'.repeat(5_500_004); // one unit over InjectImageBase64Schema's cap
    const out = await post(h.deps, { item: validItem(), request: { ...validRequest(), image_b64: big } }, 'good-token');
    expect(out.status).toBe(413);
    expect(out.body).toMatchObject({ ok: false, error: 'INJECT_FRAME_TOO_LARGE' });
    expect(h.pcEmits).toHaveLength(0);
  });

  it('rejects a non-image frame — this route carries source=image only', async () => {
    const h = harness();
    const out = await post(h.deps, { item: validItem(), request: { text: 'hi', source: 'manual', request_id: 'm1' } }, 'good-token');
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ ok: false, error: 'INJECT_FRAME_INVALID' });
  });

  it('a persist failure is said (saved:false) and never blocks the delivery', async () => {
    const h = harness();
    h.persist.mockReturnValue(null);
    const answer = post(h.deps, { item: validItem(), request: validRequest('i1-nosave') }, 'good-token');
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    h.pending.resolve({ ok: true, mode: 'clipboard', request_id: 'i1-nosave' });
    const out = await answer;
    expect(out.body).toMatchObject({ ok: true, saved: false });
  });

  // Two row-level tests were REMOVED on 2026-07-31 with the row itself:
  //   1. a duplicate create for an id this user already owns is a no-op — that was
  //      ROW idempotency. What actually protects the user here (the same request
  //      must never paste twice) is request_id idempotency, which has its own
  //      describe block below and is untouched.
  //   2. an id owned by ANOTHER user is refused with the no-oracle shape — a
  //      cross-tenant check over findById. There is no row to own any more; the
  //      tenant boundary is verifyPairedMobile + the room address, pinned by the
  //      two 401 tests above.
  // Named rather than silently dropped, so the next reader can tell "the criterion moved"
  // from "the criterion was dropped".

  it('refuses a frame without request_id — its verdict could never be reported', async () => {
    const h = harness();
    const req = validRequest();
    delete req.request_id;
    const out = await post(h.deps, { item: validItem(), request: req }, 'good-token');
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ ok: false, error: 'INJECT_FRAME_INVALID' });
  });
});

// ── 🔴 card S · never mix up IDs — the SAME gate the socket ingress applies ────────────
//
// owner 2026-07-31, original words "a life-or-death line, must not be crossed". This ingress is "another entry, not a second
// contract" — so if the check lived only on the socket leg, this route would be the
// red line's back door. `pc.id` here is the PC row resolved from the phone's own
// Bearer token (registry.reconnectMobile → pcs.findById(mobileRow.pc_device_id)),
// which is the very same `pc_devices.id` the socket leg compares as
// `auth.deviceId`. The harness's bound PC is 'pc-1'.
describe('POST /api/inject/image — target_pc_id (card S)', () => {
  it('a MATCHING address is delivered like any other frame', async () => {
    const h = harness();
    const answer = post(
      h.deps,
      { item: validItem(), request: { ...validRequest('i1-addr-ok'), target_pc_id: 'pc-1' } },
      'good-token',
    );
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    h.pending.resolve({ ok: true, mode: 'clipboard', request_id: 'i1-addr-ok', entry_id: 'entry-1' });
    const out = await answer;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, mode: 'clipboard' });
    // …and the address rode along to the PC unchanged.
    expect((h.pcEmits[0]!.payload as { target_pc_id?: string }).target_pc_id).toBe('pc-1');
  });

  it('a MISMATCHED address is refused, and the PC receives NOT ONE FRAME', async () => {
    const h = harness();
    const out = await post(
      h.deps,
      { item: validItem(), request: { ...validRequest('i1-addr-bad'), target_pc_id: 'pc-somebody-else' } },
      'good-token',
    );
    // 409 CONFLICT, not 200+ok:false — grep'd against the phone, not guessed
    // (mobile session/image_upload.dart, symbol `uploadImageInject`): any 200
    // that is neither
    // INJECT_PC_OFFLINE / INJECT_RESULT_TIMEOUT nor `retryable:true` is read as
    // "this is the PC's verdict" and settles the row from a SERVER refusal (the RV-05 lie).
    // A non-200 lands in ImageUploadStatus.refused — "the server refused, retrying will not help" —
    // the only one of the phone's five outcomes that is true here.
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({
      ok: false,
      error: 'INJECT_PC_MISMATCH',
      request_id: 'i1-addr-bad',
      entry_id: 'entry-1',
    });
    // Never delivered, never re-routed — and it cost nothing on the way out:
    // no file written, no request_id claimed (so re-addressing it can still go
    // through under the same id rather than hitting a phantom conclusion).
    expect(h.pcEmits).toHaveLength(0);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.pending.answerFor('i1-addr-bad')).toBeUndefined();
    expect(h.pending.size).toBe(0);
  });

  // 0.2.33 (window B3): THIS TEST USED TO ASSERT THE OPPOSITE — "an ABSENT address
  // behaves exactly as today (an informed compatibility gap)" — and it was right at the time: a
  // 0.2.28 phone could not stamp the field. That tolerance named its own closing
  // condition (senders stamp it unconditionally) and the condition was met, so the
  // gap is now a named refusal on BOTH ingresses. Replaced rather than deleted, so
  // a reader who greps for the old behaviour lands on why it stopped.
  it('🔴 an ABSENT address is REFUSED by name, and costs nothing on the way out', async () => {
    const h = harness();
    const { target_pc_id: _unaddressed, ...noAddress } = validRequest('i1-addr-absent');
    const out = await post(h.deps, { item: validItem(), request: noAddress }, 'good-token');

    // 400, not the mismatch's 409: nothing CONFLICTS with this endpoint, a required
    // field is simply missing — the same verdict an absent `request_id` gets. What
    // matters equally is what they share: NON-200, which is the phone's
    // `ImageUploadStatus.refused` branch. A 200 would be settled as "this is the PC's
    // verdict" about a picture no PC ever saw.
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({
      ok: false,
      error: 'INJECT_PC_UNSPECIFIED',
      request_id: 'i1-addr-absent',
      entry_id: 'entry-1',
    });
    // 🔴 Not the mismatch code: that one says "the PC you meant to send to is not this one" about a sender
    // that HAS an address. This frame named nobody, and its copy's whole job is the
    // one action that helps (update the phone).
    expect((out.body as { error: string }).error).not.toBe('INJECT_PC_MISMATCH');
    // Refused in the same place as the mismatch — before the ledger, the hold-out
    // gate, the file write and the relay.
    expect(h.pcEmits).toHaveLength(0);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.pending.answerFor('i1-addr-absent')).toBeUndefined();
    expect(h.pending.size).toBe(0);
  });

  it('the POSITIVE control for that zero: the SAME frame WITH an address is delivered', async () => {
    // Otherwise "pcEmits is empty" above could equally mean the harness stopped
    // wiring a PC at all, and the refusal would be proving nothing.
    const h = harness();
    const answer = post(h.deps, { item: validItem(), request: validRequest('i1-addr-present') }, 'good-token');
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    h.pending.resolve({ ok: true, mode: 'clipboard', request_id: 'i1-addr-present' });
    expect((await answer).body).toMatchObject({ ok: true });
  });
});

// ── RV-04: HTTP auto-retry × image-bypasses-dedup ⇒ the SAME picture pasted
// twice. The retry is real (image_send_controller reuses the request_id OUTSIDE
// its loop) and the response really does get lost — the dead-TCP window is what
// this whole ingress exists for. So the retry must be idempotent, by id.
describe('POST /api/inject/image — request_id idempotency (RV-04)', () => {
  it('body arrived, response lost, phone retried ⇒ ONE relay to the PC, the first verdict repeated', async () => {
    const h = harness();
    // Attempt 1: the PC pastes and answers. (The phone never sees this body —
    // its TCP died in the background; that is the whole scenario.)
    const first = post(h.deps, { item: validItem(), request: validRequest('i1-retry') }, 'good-token');
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    h.pending.resolve({ ok: true, mode: 'clipboard', request_id: 'i1-retry', entry_id: 'entry-1' });
    expect((await first).body).toMatchObject({ ok: true, mode: 'clipboard' });
    const relaysAfterFirst = h.pcEmits.filter((e) => e.event === 'inject:request').length;
    expect(relaysAfterFirst).toBe(1);

    // Attempt 2: byte-identical retry, same request_id (the controller mints it
    // once, outside the retry loop).
    const second = await post(h.deps, { item: validItem(), request: validRequest('i1-retry') }, 'good-token');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, mode: 'clipboard', request_id: 'i1-retry', replayed: true });
    // THE assertion of this card: the PC was told exactly once.
    expect(h.pcEmits.filter((e) => e.event === 'inject:request')).toHaveLength(1);
    // …and the retry did no work at all: no second row, no second file.
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it('a retry after a TIMEOUT answer is told the same thing — it does not re-relay a slow paste', async () => {
    const h = harness();
    const first = await post(h.deps, { item: validItem(), request: validRequest('i1-slow2') }, 'good-token');
    expect(first.body).toMatchObject({ ok: false, error: 'INJECT_RESULT_TIMEOUT', relayed: true });
    const second = await post(h.deps, { item: validItem(), request: validRequest('i1-slow2') }, 'good-token');
    expect(second.body).toMatchObject({ ok: false, error: 'INJECT_RESULT_TIMEOUT', replayed: true });
    expect(h.pcEmits.filter((e) => e.event === 'inject:request')).toHaveLength(1);
  });

  it('a CONCURRENT retry joins the in-flight delivery — one relay, both answers identical', async () => {
    const h = harness();
    const a = post(h.deps, { item: validItem(), request: validRequest('i1-race') }, 'good-token');
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    const b = post(h.deps, { item: validItem(), request: validRequest('i1-race') }, 'good-token');
    await vi.waitFor(() => expect(h.pending.size).toBe(1));
    h.pending.resolve({ ok: true, mode: 'clipboard', request_id: 'i1-race' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toMatchObject({ ok: true, mode: 'clipboard' });
    expect(rb.body).toMatchObject({ ok: true, mode: 'clipboard' });
    expect(h.pcEmits.filter((e) => e.event === 'inject:request')).toHaveLength(1);
  });

  it('a claim that cannot be armed does NOT emit, and is never dressed as a timeout', async () => {
    const h = harness();
    // Fill the waiter table with ids this request will never own.
    for (let i = 0; i < 64; i++) expect(h.pending.begin(`squat-${i}`, 5_000).kind).toBe('armed');
    const out = await post(h.deps, { item: validItem(), request: validRequest('i1-full') }, 'good-token');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      ok: false,
      error: 'INJECT_SERVER_BUSY',
      retryable: true,
      request_id: 'i1-full',
      entry_id: 'entry-1',
    });
    expect(out.body.error).not.toBe('INJECT_RESULT_TIMEOUT');
    // Nor PC_BUSY: that code's user-facing sentence blames another phone and
    // tells the user to leave a page on it. Neither is true here.
    expect(out.body.error).not.toBe('PC_BUSY');
    // (A): a wait that was refused must not put a frame on the wire.
    expect(h.pcEmits.filter((e) => e.event === 'inject:request')).toHaveLength(0);
  });
});

// ── RV-05: a server hold-out refusal was being read by the phone as the PC's
// injection verdict — and the phone then marked SYNCED a row this route returns
// before ever creating. The echo is what makes the refusal legible.
describe('POST /api/inject/image — hold-out refusal echoes its subject (RV-05)', () => {
  for (const [reason, code] of [
    ['busy', 'PC_BUSY'],
    ['manual', 'PAIR_RELEASED'],
  ] as const) {
    it(`${code}: retryable, with retry_after_ms and the request_id/entry_id echo`, async () => {
      const h = harness({ suppressed: { ms: 7_500, reason } });
      const out = await post(h.deps, { item: validItem(), request: validRequest('i1-held') }, 'good-token');
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({
        ok: false,
        error: code,
        retryable: true,
        retry_after_ms: 7_500,
        request_id: 'i1-held',
        entry_id: 'entry-1',
      });
      // Nothing at all happened for this delivery — which is exactly why the phone
      // must not mark it synced (that is the mobile half of this card).
      expect(h.pcEmits).toHaveLength(0);
      expect(h.persist).not.toHaveBeenCalled();
    });
  }

  it('the refusal is not remembered as a conclusion — the same delivery goes through once the window lapses', async () => {
    let held = 5_000;
    const h = harness({ suppressed: { ms: 0, reason: 'busy' } });
    (h.deps as { suppression?: unknown }).suppression = {
      remainingMs: () => held,
      reasonFor: () => 'busy',
    };
    const refused = await post(h.deps, { item: validItem(), request: validRequest('i1-later') }, 'good-token');
    expect(refused.body).toMatchObject({ error: 'PC_BUSY', retryable: true });
    held = 0; // the window lapses
    const answer = post(h.deps, { item: validItem(), request: validRequest('i1-later') }, 'good-token');
    await vi.waitFor(() => expect(h.pcEmits.some((e) => e.event === 'inject:request')).toBe(true));
    h.pending.resolve({ ok: true, mode: 'clipboard', request_id: 'i1-later' });
    expect((await answer).body).toMatchObject({ ok: true, mode: 'clipboard' });
  });
});

describe('InjectPendingRegistry', () => {
  function armed(p: InjectPendingRegistry, id: string, ms: number): Promise<unknown> {
    const attempt = p.begin(id, ms);
    expect(attempt.kind).toBe('armed');
    if (attempt.kind !== 'armed') throw new Error('unreachable');
    return attempt.outcome;
  }

  it('resolves a waiter exactly once and cleans up', async () => {
    const p = new InjectPendingRegistry();
    const w = armed(p, 'r1', 1000);
    expect(p.size).toBe(1);
    p.resolve({ ok: true, mode: 'clipboard', request_id: 'r1' });
    p.resolve({ ok: false, mode: 'cached', request_id: 'r1' }); // second is a no-op
    expect(await w).toMatchObject({ kind: 'result', result: { ok: true } });
    expect(p.size).toBe(0);
  });

  it('times out to a TAGGED timeout — never a null the caller has to interpret', async () => {
    const p = new InjectPendingRegistry();
    expect(await armed(p, 'r2', 10)).toEqual({ kind: 'timeout' });
    expect(p.size).toBe(0);
  });

  it('a result nobody waits on is a no-op', () => {
    const p = new InjectPendingRegistry();
    expect(() => p.resolve({ ok: true, mode: 'sendinput', request_id: 'ghost' })).not.toThrow();
  });

  // RV-04: the three facts `null` used to collapse into one.
  it('a second arrival of an IN-FLIGHT request_id joins the wait — it does not relay', async () => {
    const p = new InjectPendingRegistry();
    const first = p.begin('r3', 1000);
    const second = p.begin('r3', 1000);
    expect(first.kind).toBe('armed');
    expect(second.kind).toBe('joined');
    if (first.kind !== 'armed' || second.kind !== 'joined') throw new Error('unreachable');
    expect(p.size).toBe(1); // joining costs no capacity slot
    p.resolve({ ok: true, mode: 'clipboard', request_id: 'r3' });
    // ONE relay, ONE truth, both reporters say the same thing.
    expect(await first.outcome).toEqual(await second.outcome);
    expect(await second.outcome).toMatchObject({ kind: 'result', result: { ok: true } });
  });

  it('a CONCLUDED request_id replays its recorded answer instead of arming again', async () => {
    const p = new InjectPendingRegistry();
    p.recordAnswer('r4', { ok: true, mode: 'clipboard', request_id: 'r4' });
    const again = p.begin('r4', 1000);
    expect(again.kind).toBe('replay');
    if (again.kind !== 'replay') throw new Error('unreachable');
    expect(again.answer).toMatchObject({ ok: true, request_id: 'r4' });
    expect(p.size).toBe(0); // a replay arms nothing
    expect(p.answerFor('r4')).toBeDefined();
    expect(p.answerFor('never-seen')).toBeUndefined();
  });

  it('a full waiter table is named `overloaded`, not a 0 ms timeout', () => {
    const p = new InjectPendingRegistry();
    for (let i = 0; i < 64; i++) expect(p.begin(`full-${i}`, 5_000).kind).toBe('armed');
    expect(p.begin('one-too-many', 5_000).kind).toBe('overloaded');
    // …but a retry of an id already in flight still gets in.
    expect(p.begin('full-0', 5_000).kind).toBe('joined');
  });

  it('the answer ledger is bounded — the oldest conclusions are evicted', () => {
    const p = new InjectPendingRegistry();
    for (let i = 0; i < 300; i++) p.recordAnswer(`a-${i}`, { ok: true, mode: 'clipboard' });
    expect(p.answeredSize).toBe(256);
    expect(p.answerFor('a-0')).toBeUndefined();
    expect(p.answerFor('a-299')).toBeDefined();
  });
});
