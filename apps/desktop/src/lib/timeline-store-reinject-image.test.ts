// The image re-inject arm (0.3.36 — 15-vol §2.5e-7 ①'s PC half), split out of
// timeline-store.test.ts at its 1200-line cap the same day the arm was added.
// Fixtures come from ./timeline-store-test-support.ts like every sibling suite.

import { describe, expect, it } from 'vitest';
import { reinjectRouteOf } from './timeline-store-surface';
import { fresh, item, seed } from './timeline-store-test-support';

describe('reinjectRouteOf: a whitelist of the kinds that have a door', () => {
  it('transcript → the text door, image → the image door, anything else → refuse', () => {
    expect(reinjectRouteOf('transcript')).toBe('text');
    expect(reinjectRouteOf('image')).toBe('image');
    // The REQ-12-13 case by name, plus the kind nobody has invented yet: both
    // must refuse — an unknown kind growing a verb for free is the fail-open
    // shape this function exists to prevent.
    expect(reinjectRouteOf('control')).toBeNull();
    expect(reinjectRouteOf('someday-new-kind')).toBeNull();
  });
});

// ✅ 0.3.36 (owner 2026-08-26): the refusal became an ARM. What this block
// defended is untouched and still asserted below — the caption must never be
// typed — but the way an image row honours that changed: it now routes to the
// IMAGE transport (which carries no text at all) instead of being refused.
// The old B3-7 refusal now covers only the kinds with no arm ('control', and
// anything the future adds), which keeps REQ-12-13's fail-closed direction.
describe('TimelineStore — 补投 on an image row pastes the PICTURE, and the caption never travels', () => {
  it('routes to the image transport with the row id — the TEXT seam is never touched', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { entry_type: 'image', output_text: '🖼 PNG · 214 KB', status: 'failed' })]);

    await store.reInject('1', 'lan');

    // THE two assertions, one per door: the picture door got the id, and the
    // typing door — the only seam that could ever type the caption — got
    // nothing. A shared recorder could not make this distinction.
    expect(t.imageCalls).toEqual(['1']);
    expect(t.calls).toEqual([]);
    expect(store.entries()[0]!.status).toBe('injected');
  });

  it('a null from the image arm (no original on disk / no session) is stated, not dressed as success', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { entry_type: 'image', status: 'failed' })]);
    t.imageResult = null;

    const v = await store.reInject('1', 'lan');

    expect(v).toEqual({ ran: false, reason: 'nothing-typed' });
    expect(store.lastFailure).toEqual({ op: 'inject', id: '1', channel: 'lan' });
    expect(store.entries()[0]!.status).toBe('failed'); // unchanged — no fabricated verdict
  });

  it('a kind with NO arm is still refused by name — the fail-closed direction survives the image arm', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { entry_type: 'control', output_text: 'Clear', status: 'failed' })]);

    const v = await store.reInject('1', 'lan');

    expect(v).toEqual({ ran: false, reason: 'not-a-transcript' });
    expect(t.calls).toEqual([]);
    expect(t.imageCalls).toEqual([]);
    expect(store.lastFailure).toEqual({ op: 'inject', id: '1', channel: 'lan' });
  });

  it('positive control: a TEXT row on the same store still goes through the typer', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { entry_type: 'transcript', output_text: 'a real sentence', status: 'failed' })]);

    await store.reInject('1', 'lan');

    expect(t.calls).toEqual([{ text: 'a real sentence', entryId: '1' }]);
    expect(t.imageCalls).toEqual([]);
    expect(store.entries()[0]!.status).toBe('injected');
  });
});

