// 0.3.30 — capsule strip per-row RE-INJECT (owner 2026-08-24). Two layers, the
// same split capsule-copy.test.ts uses: pure-logic specs here, plus the SFC
// wiring asserted by reading CapsuleApp.vue literally (a control that renders
// and calls nothing is this repo's named façade shape, and only the second layer
// can see it).
//
// 🔴 THE ONE ASSERTION THIS FILE EXISTS FOR is 「`cached` is not a success」.
// Copy is binary; injection is not — the pipeline can run to completion and the
// utterance still land nowhere. A green check on that row would be R11 in its
// purest form, and it is the mistake that costs nothing to make, because the
// call DID return and it DID say `ran: true`.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { S } from '../lib/strings';

import {
  canReinjectLine,
  parseReinjectReply,
  reinjectFeedback,
  type ReinjectReply,
} from './capsule-reinject';
import type { RecentLine } from './recent-line';
import { useRowReinject } from './use-row-reinject';

const capsuleVue = readFileSync(new URL('./CapsuleApp.vue', import.meta.url), 'utf8');
const composable = readFileSync(new URL('./use-row-reinject.ts', import.meta.url), 'utf8');
const iconVue = readFileSync(
  new URL('../main-window/components/Icon.vue', import.meta.url),
  'utf8',
);

describe('canReinjectLine: the R8 gate — omit rather than offer an act that is defined to fail', () => {
  it('a transcript row with text can be re-injected', () => {
    expect(canReinjectLine({ entryType: 'transcript', text: '你好' })).toBe(true);
  });

  it('🔴 an image row cannot — the store refuses it, so offering it would be a button that only fails', () => {
    expect(canReinjectLine({ entryType: 'image', text: '🖼 PNG · 214 KB' })).toBe(false);
  });

  it('a transcript row with nothing rendered cannot (same rule as canCopyLine)', () => {
    expect(canReinjectLine({ entryType: 'transcript', text: '' })).toBe(false);
    expect(canReinjectLine({ entryType: 'transcript', text: '   \n' })).toBe(false);
  });

  it('🔴 is written as an EQUALITY on transcript, not an inequality on image — REQ-12-13 already paid for that', () => {
    // The source, not the behaviour: an `!== "image"` test passes every case
    // above and STILL fails open the day a third kind arrives, which is exactly
    // what happened when `entry_type` gained 'control'. Only reading the code
    // can tell the two implementations apart.
    const src = readFileSync(new URL('./capsule-reinject.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function canReinjectLine'));
    expect(body).toContain("entryType === 'transcript'");
    expect(body.slice(0, body.indexOf('}'))).not.toContain("!== 'image'");
  });
});

describe('reinjectFeedback: three faces, because injection has three outcomes', () => {
  it('the pipeline ran and the row says injected → the success face', () => {
    const f = reinjectFeedback({ ran: true, status: 'injected' });
    expect(f.tone).toBe('ok');
    expect(f.icon).toBe('check');
    expect(f.status).toBe('injected');
  });

  it('🔴 CACHED IS NOT A SUCCESS — it ran, and the utterance landed nowhere', () => {
    const f = reinjectFeedback({ ran: true, status: 'cached' });
    expect(f.tone, 'a cached re-inject must never wear the success face').not.toBe('ok');
    expect(f.tone).toBe('warn');
    expect(f.icon).toBe('alert');
    // The row's own word is carried so the tooltip can say WHICH non-injection
    // this was, instead of a generic「失败」that would also be wrong (it did not
    // fail — it was buffered).
    expect(f.status).toBe('cached');
  });

  it('failed and noted also ran, and also are not successes', () => {
    for (const status of ['failed', 'noted'] as const) {
      const f = reinjectFeedback({ ran: true, status });
      expect(f.tone, `${status} must not be ok`).toBe('warn');
      expect(f.status).toBe(status);
    }
  });

  it('nothing was typed → the error face, and the reason survives for the tooltip', () => {
    for (const reason of ['no-such-row', 'not-a-transcript', 'nothing-typed'] as const) {
      const f = reinjectFeedback({ ran: false, reason });
      expect(f.tone).toBe('err');
      expect(f.icon).toBe('x');
      expect(f.reason).toBe(reason);
      expect(f.status, 'a run that never happened has no status to report').toBeNull();
    }
  });

  it('🔴 nobody answered and could-not-ask are DIFFERENT — a timeout is not a refusal', () => {
    expect(reinjectFeedback(null).reason).toBe('timeout');
    expect(reinjectFeedback('not-sent').reason).toBe('not-sent');
    // Both are errors, and both must be errors: silently doing nothing is the
    // one thing this button may not do.
    expect(reinjectFeedback(null).tone).toBe('err');
    expect(reinjectFeedback('not-sent').tone).toBe('err');
  });

  it('🔴 every icon it can ask for is one the icon set actually OWNS', () => {
    // Icon.vue renders an EMPTY svg for an unknown name — its own header says so —
    // so a name this mapping can produce and that file does not carry is a
    // silently blank box on a control the user just clicked.
    const replies: (ReinjectReply | null | 'not-sent')[] = [
      { ran: true, status: 'injected' },
      { ran: true, status: 'cached' },
      { ran: true, status: 'failed' },
      { ran: true, status: 'noted' },
      { ran: false, reason: 'no-such-row' },
      { ran: false, reason: 'not-a-transcript' },
      { ran: false, reason: 'nothing-typed' },
      null,
      'not-sent',
    ];
    const wanted = new Set(replies.map((r) => reinjectFeedback(r).icon));
    expect(wanted.size).toBeGreaterThan(1); // control: the mapping is not constant
    for (const name of wanted) {
      expect(iconVue, `Icon.vue does not own "${name}"`).toContain(`  ${name}: '<`);
    }
  });
});

describe('parseReinjectReply: an unreadable answer is "nobody answered", never a verdict', () => {
  it('accepts the two legal shapes', () => {
    expect(parseReinjectReply({ ran: true, status: 'cached' })).toEqual({
      ran: true,
      status: 'cached',
    });
    expect(parseReinjectReply({ ran: false, reason: 'nothing-typed' })).toEqual({
      ran: false,
      reason: 'nothing-typed',
    });
  });

  it('🔴 refuses a status this build does not know, rather than widening the union', () => {
    expect(parseReinjectReply({ ran: true, status: 'teleported' })).toBeNull();
    expect(parseReinjectReply({ ran: false, reason: 'because' })).toBeNull();
  });

  it('refuses junk, and never coerces it into a success', () => {
    for (const junk of [null, undefined, 0, '', 'ok', [], {}, { ran: 'yes' }]) {
      expect(parseReinjectReply(junk)).toBeNull();
    }
  });
});

describe('the SFC really wires it — a control that renders and calls nothing is the façade', () => {
  it('the button is gated by canReinjectLine and calls reinjectLine', () => {
    expect(capsuleVue).toContain('v-if="canReinjectLine(l)"');
    expect(capsuleVue).toContain('@click="reinjectLine(l)"');
  });

  it('🔴 the icon comes from the FEEDBACK, not from a literal', () => {
    // A hard-coded `name="reinject"` would render the same glyph whatever
    // happened — i.e. it would look identical on a success and on a refusal,
    // which is the state this whole card exists to leave behind.
    expect(capsuleVue).toContain(":name=\"injectStatus[l.id]?.icon ?? 'reinject'\"");
  });

  it('the tooltip is the outcome, not the verb repeated', () => {
    expect(capsuleVue).toContain(':title="injectTitle(l)"');
  });

  it('a second click cannot race the first', () => {
    expect(capsuleVue).toContain(':disabled="injectBusy.has(l.id)"');
  });

  it('🔴 the SFC does not grow a second injection path of its own', () => {
    // `timeline_reinject` is the main window's command to invoke. The capsule
    // asks; it does not act. (The composable is checked the same way below.)
    expect(capsuleVue).not.toContain('timeline_reinject');
    expect(composable).not.toContain('timeline_reinject');
  });
});

describe('useRowReinject: driven, not read — what a click actually does', () => {
  const row = (over: Partial<RecentLine> = {}): RecentLine =>
    ({
      id: 'r1',
      channel: 'cloud',
      mode: 'realtime',
      text: '再说一遍',
      source: null,
      mobileId: null,
      deviceLabel: null,
      time: '09:12',
      entryType: 'transcript',
      thumb: null,
      created: 0,
      status: 'cached',
      ...over,
    }) as RecentLine;

  it("🔴 sends the ROW's channel, not whatever the capsule is showing now", async () => {
    // owner 2026-07-31 iron rule: a delivery item carries its full address and is
    // never matched against 「当前是谁」 at the moment it acts. This asserts the
    // ARGUMENT, which is the only thing that can tell the two apart.
    const seen: { id: string; channel: string }[] = [];
    const r = useRowReinject(async (id, channel) => {
      seen.push({ id, channel });
      return { ran: true, status: 'injected' };
    });
    await r.reinjectLine(row({ id: 'lan-row', channel: 'lan' }));
    await r.reinjectLine(row({ id: 'cloud-row', channel: 'cloud' }));
    expect(seen).toEqual([
      { id: 'lan-row', channel: 'lan' },
      { id: 'cloud-row', channel: 'cloud' },
    ]);
  });

  it('a nonce is minted per CLICK, never per row', async () => {
    const nonces: string[] = [];
    const r = useRowReinject(async (_id, _ch, nonce) => {
      nonces.push(nonce);
      return { ran: true, status: 'injected' };
    });
    await r.reinjectLine(row());
    await r.reinjectLine(row());
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('🔴 an injected answer paints the success face; a CACHED one does not', async () => {
    const ok = useRowReinject(async () => ({ ran: true, status: 'injected' }));
    await ok.reinjectLine(row());
    expect(ok.injectStatus.value.r1!.tone).toBe('ok');

    const cached = useRowReinject(async () => ({ ran: true, status: 'cached' }));
    await cached.reinjectLine(row());
    expect(cached.injectStatus.value.r1!.tone).toBe('warn');
    expect(cached.injectStatus.value.r1!.icon).toBe('alert');
  });

  it('nobody answering is an ERROR face, never a quiet nothing', async () => {
    const r = useRowReinject(async () => null);
    await r.reinjectLine(row());
    expect(r.injectStatus.value.r1!.tone).toBe('err');
    expect(r.injectStatus.value.r1!.reason).toBe('timeout');
  });

  it('🔴 a row it must not act on is never even asked about', async () => {
    let asked = 0;
    const r = useRowReinject(async () => {
      asked += 1;
      return { ran: true, status: 'injected' };
    });
    await r.reinjectLine(row({ entryType: 'image', text: '🖼 PNG · 1 KB' }));
    await r.reinjectLine(row({ text: '   ' }));
    expect(asked, 'the guard must hold before the request, not after').toBe(0);
    // Control: a row it MAY act on does get asked, so the zero above is a
    // judgement and not a broken fake.
    await r.reinjectLine(row());
    expect(asked).toBe(1);
  });

  it('the tooltip says the OUTCOME afterwards, and the verb before', async () => {
    const r = useRowReinject(async () => ({ ran: true, status: 'cached' }));
    const l = row();
    expect(r.injectTitle(l)).toBe(S.op_reinject);
    await r.reinjectLine(l);
    expect(r.injectTitle(l)).toBe(S.st_cached);
    expect(r.injectTitle(l)).not.toBe(S.op_reinject);
  });

  it('🔴 "nothing was typed" gets its own sentence — not the 未注入 verdict word', async () => {
    // `st_failed` is a verdict the pipeline REACHED about an utterance; this says
    // the pipeline never ran. One word on two facts is the shape this repo hunts.
    const r = useRowReinject(async () => ({ ran: false, reason: 'nothing-typed' }));
    const l = row();
    await r.reinjectLine(l);
    expect(r.injectTitle(l)).toBe(S.op_reinject_nothing);
    expect(r.injectTitle(l)).not.toBe(S.st_failed);
  });

  it('a request in flight blocks a second one on the same row', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    let asked = 0;
    const r = useRowReinject(async () => {
      asked += 1;
      await gate;
      return { ran: true, status: 'injected' };
    });
    const first = r.reinjectLine(row());
    await Promise.resolve();
    expect(r.injectBusy.value.has('r1')).toBe(true);
    await r.reinjectLine(row()); // the second click, while the first is out
    expect(asked, 'a second click must not start a second injection').toBe(1);
    release(null);
    await first;
    expect(r.injectBusy.value.has('r1')).toBe(false);
  });
});
