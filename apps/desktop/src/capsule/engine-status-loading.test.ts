// NR-38 (second half) — the capsule's side of `stt:engine-status{loading}`.
//
// TWO SEPARATE CLAIMS LIVE HERE, and only one of them was new.
//
// ① THE DEGRADE WAS ALREADY THERE, and it is asserted rather than assumed. The
//    reason the protocol commit could call `loading` additive is that every
//    shipped consumer drops a status it does not know instead of throwing. On
//    this leg that is `onEngineStatus`'s explicit `===` gate: a value outside
//    the set leaves `engineStatus` and `engineKnown` exactly as they were. The
//    row below is written against a value NO version will ever know
//    ('vendor-hibernating'), so it keeps proving the degrade after `loading`
//    stops being unknown — a test that used `loading` as its unknown value
//    would have deleted itself the moment this card landed. Measured before the
//    mapping below was written: already green, so no mutation was staged for it.
//    The other two consumers degrade structurally rather than by a gate and so
//    have nothing to assert here: the desktop Rust leg (`socket/fanout.rs
//    on_forward`) forwards the payload as a `serde_json::Value` and never
//    parses the enum, and the phone's `local_engine_status.dart observeFrame`
//    has an `_ => null` arm that returns without recording.
//
// ② THE MAPPING IS NEW: `loading` must reach the diagnostic as its own state,
//    not be swallowed by the same default arm that protects ①. That is the
//    whole point of the card — the capsule was silent for the 1.9 s‥8 s a local
//    pack takes to load, and the fix is worthless if the frame arrives and
//    nothing moves.
//
// 🔴 ③ THE SENTENCE ARRIVED (card WP2-COPY-1). Until it did, the value cell for
//    `loading` was asserted to be EMPTY — the key `cap_stt_loading` did not
//    exist and this repo does not let an executor author user-visible strings.
//    That row is now the opposite assertion: the cell renders the authored
//    string. What it does NOT do is assert the string's text, because a test
//    that spells out copy goes red every time the copy is improved and tells
//    nobody anything about the wiring. What it pins instead is the pair of
//    confusions that were available here: the cell must not fall back to
//    `cap_stt_unknown` ("Not checked" — a false claim about an engine that is
//    demonstrably present), and it must not put the raw identifier on screen.

import { beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CapsuleApp from './CapsuleApp.vue';
import { onEngineStatus, state } from './controller';
import { S } from '../lib/strings';

beforeEach(() => {
  state.engineProvider = '';
  state.engineStatus = '';
  state.engineKnown = false;
  state.diagOpen = false;
});

/** The engine row of the real diagnostic panel, rendered through the real SFC —
 *  the ternary in `engineLabel` is the half a state-only assertion cannot reach,
 *  and it is exactly the half that decides what a user sees. */
async function engineRow(): Promise<{ dot: string; value: string; html: string }> {
  state.diagOpen = true;
  const html = await renderToString(createSSRApp(CapsuleApp));
  const row = html.split('<div class="drow"').find((chunk) => chunk.includes(S.cap_stt_label));
  if (row === undefined) throw new Error(`engine diagnostic row not rendered; html was:
${html}`);
  const dot = /<span class="([^"]*)dot([^"]*)"/.exec(row);
  const value = /<span class="v"[^>]*>([\s\S]*?)<\/span>/.exec(row);
  if (!dot || !value) throw new Error(`engine row shape changed; row was:
${row}`);
  const strip = (t: string): string => t.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  return { dot: `${dot[1]!}${dot[2]!}`.trim(), value: strip(value[1]!), html };
}

describe('capsule engine-status — the loading value', () => {
  it('records loading as its own state (it is not "ready" and not "unknown")', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    expect(state.engineStatus).toBe('loading');
    expect(state.engineKnown).toBe(true);
    expect(state.engineProvider).toBe('sherpa-local');
  });

  it('loading -> ready is the whole cold open, and the last frame wins', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    onEngineStatus({ provider: 'sherpa-local', status: 'ready' });
    expect(state.engineStatus).toBe('ready');
  });

  it('loading -> failed leaves the failure showing, not a stuck spinner', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    onEngineStatus({ provider: 'sherpa-local', status: 'failed' });
    expect(state.engineStatus).toBe('failed');
  });

  it('a status no version knows is DROPPED, never written through (the degrade ① above)', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'ready' });
    onEngineStatus({ provider: 'sherpa-local', status: 'vendor-hibernating' });
    expect(state.engineStatus, 'an unknown value must not overwrite a known one').toBe('ready');
    onEngineStatus({ provider: 'x', status: 42 });
    onEngineStatus(null);
    onEngineStatus({ provider: 'x' });
    expect(state.engineStatus).toBe('ready');
  });

  it('renders the loading state with the amber dot and its own authored sentence', async () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    const row = await engineRow();
    expect(row.dot, 'work in progress shares the amber dot with reconnecting').toBe('y');
    // ③ above: the cell carries the string, and the string is its OWN — not the
    // "not checked" one, which would be a false claim about an engine that is
    // right here and working, and not a raw identifier on screen (0.2.53).
    expect(row.value, 'the loading cell renders cap_stt_loading').toBe(S.cap_stt_loading);
    expect(row.value, 'a non-empty cell is the whole point of this row').not.toBe('');
    expect(row.html).not.toContain('cap_stt_loading');
    expect(row.value).not.toBe(S.cap_stt_unknown);
    expect(row.value).not.toBe(S.cap_stt_ready);
  });

  it('ready still renders its own sentence — the empty cell is scoped to loading alone', async () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'ready' });
    const row = await engineRow();
    expect(row.dot).toBe('g');
    expect(row.value).toBe(S.cap_stt_ready);
  });

  it('an unknown status on a FRESH capsule leaves the engine unknown — no fabricated verdict', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'vendor-hibernating' });
    expect(state.engineKnown, 'a frame we cannot read is not a reading').toBe(false);
    expect(state.engineStatus).toBe('');
    // The provider IS taken: the name is a plain string, not part of the enum,
    // and the row's own label is allowed to name an engine it has no verdict on.
    expect(state.engineProvider).toBe('sherpa-local');
  });
});
