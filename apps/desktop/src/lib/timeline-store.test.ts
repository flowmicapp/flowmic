import { describe, expect, it } from 'vitest';
import { TimelineStore } from './timeline-store';
import { MAX_ROWS } from './timeline-retention';
import type { ChannelTag, InjectResult, ReportingKvStore, TimelineTransport, WireHistoryItem } from './types';

// The shared fixtures (RecordingTransport / MemStore / item / fresh / verdict / seed)
// moved VERBATIM to ./timeline-store-test-support.ts on 2026-08-19 — a structural
// split at this file's pinned file-size debt, so the cause suite
// (timeline-store-cause.test.ts) could share ONE definition of the fixtures
// instead of copying them. See the support file header.
import { MemStore, RecordingTransport, fresh, item, seed, verdict } from './timeline-store-test-support';

// ── 0.2.27: deferred delivery is LOCAL — no server, no round trip ─────────────────────────────
//
// `history:inject{id}` made the PC send an id so the server could read the text out of
// `transcript_history` and send it straight back to the SAME PC as an inject:request.
// The table is gone (owner's architecture ruling) and this store has owned the text since 0.2.26.
describe('TimelineStore — 补投 runs the local pipeline with the row it owns', () => {
  it('hands over the row’s TEXT (not its id) and puts the verdict on that row', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { status: 'failed', output_text: 'the sentence to re-deliver' })]);

    await store.reInject('1', 'lan');

    // THE assertion of this card: the text travels, because the owner supplies it.
    expect(t.calls).toEqual([{ text: 'the sentence to re-deliver', entryId: '1' }]);
    const r = store.entries()[0]!;
    expect(r.status).toBe('injected');
  });

  it('the verdict is applied through the SAME reconciler the socket path uses', async () => {
    // One meaning for `injected` (RV-45 hard constraint): the result of a local deferred delivery is
    // fed to onInjectResult exactly like a phone-initiated delivery's, target and all.
    const { store, t } = fresh();
    seed(store, [item('1', { status: 'cached' })]);
    t.result = {
      ok: true,
      mode: 'clipboard',
      inject_target: { window_title: 'WeChat', process_name: 'WeChat', injected_at: '2026-07-31T10:00:00.000Z' },
    };
    await store.reInject('1', 'lan');
    const r = store.entries()[0]!;
    expect(r.status).toBe('injected');
    expect(r.target?.process_name).toBe('WeChat');
    expect(r.target?.injected_at).toBe('2026-07-31T10:00:00.000Z');
  });

  it('the store stamps the row’s OWN channel, so the other server’s row is untouched', async () => {
    // The Rust command routes nowhere, so it echoes no channel — the store supplies the
    // address it already holds. Two rows can share an id (the phone mints them and
    // re-flushes wherever it is connected), which is why the stamp still matters.
    const { store, t } = fresh();
    seed(store, [item('1', { status: 'failed' })], 'lan');
    seed(store, [item('1', { status: 'failed' })], 'cloud');
    t.result = { ok: true, mode: 'sendinput' };

    await store.reInject('1', 'cloud');
    const byChannel = new Map(store.entries().map((r) => [r.channel, r.status]));
    expect(byChannel.get('cloud')).toBe('injected');
    expect(byChannel.get('lan')).toBe('failed');
  });

  it('a TRUTHFUL failure is a result, not a refusal — the row says 未注入', async () => {
    // "tried, but it didn't land" travels as ok:false and lands on the ROW (status), with no red
    // op line: the utterance is not lost and the reason belongs to that row.
    const { store, t } = fresh();
    seed(store, [item('1', { status: 'injected' })]);
    t.result = { ok: true, mode: 'sendinput' };
    t.result = { ok: false, mode: 'sendinput', error: 'INJECT_NO_TEXT_TARGET' };
    await store.reInject('1', 'lan');
    expect(store.entries()[0]!.status).toBe('failed');
    expect(store.lastFailure).toBeNull();
    // …and a Stage-1 miss is `cached` — nothing was delivered, but nothing was lost.
    t.result = { ok: false, mode: 'cached', error: 'INJECT_FOCUS_LOST' };
    await store.reInject('1', 'lan');
    expect(store.entries()[0]!.status).toBe('cached');
    expect(store.lastFailure).toBeNull();
  });

  it('NOTHING TYPED is stated out loud, and never as a delivery', async () => {
    // `null` = the attempt did not happen at all (no resident session / deduped). The
    // row's status must not move a millimetre, and the page has to be able to say it.
    const { store, t } = fresh();
    seed(store, [item('1', { status: 'cached' })]);
    t.result = null;
    await store.reInject('1', 'lan');
    expect(store.lastFailure).toEqual({ op: 'inject', id: '1', channel: 'lan' });
    expect(store.entries()[0]!.status).toBe('cached'); // unchanged — no fabricated verdict
  });

  it('a 补投 on a row this store does not hold is refused, not sent', async () => {
    const { store, t } = fresh();
    seed(store, [item('1')]);
    await store.reInject('nope', 'cloud');
    expect(t.calls).toEqual([]);
    expect(store.lastFailure).toEqual({ op: 'inject', id: 'nope', channel: 'cloud' });
  });

  it('is never queued — a replay would paste into a window the user never chose', async () => {
    const { store, t } = fresh();
    seed(store, [item('1')]);
    t.result = null;
    await store.reInject('1', 'lan');
    // Nothing retries it: one call, and the button stays for the user to press again
    // when they are looking at the window they mean.
    expect(t.calls).toHaveLength(1);
  });

  it('the failure line is dismissible and cleared by nothing else', async () => {
    const { store, t } = fresh();
    seed(store, [item('1')]);
    t.result = null;
    await store.reInject('1', 'lan');
    expect(store.lastFailure).not.toBeNull();
    store.clearFailure();
    expect(store.lastFailure).toBeNull();
  });
});

// ── B3-7 (depth guard, not a live-bug fix — see card report) ───────────────────
//
// RV-68 gave an image row a REAL caption in `output_text` (row_transit.rs
// `row_face`), where it used to always be `''`. `reInject` types `row.output_text`
// verbatim, so the ONE thing that used to make a missed guard harmless is gone.
// The store itself never looked at `entry_type` — TimelinePage.vue's v-if
// (`rowCanReinject`) is the only thing withholding the button today, and it
// predates this card unchanged. This guard is depth for a caller that does not
// exist yet, mirroring the mobile side's store-level rule
// (manual_delivery.dart `reInject`: `if (entry.isImage) return null;`).
describe('TimelineStore — 补投 refuses an image row no matter what output_text holds', () => {
  it('never reaches the ONE seam this store has into native code — not the caption, not anything', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { entry_type: 'image', output_text: '🖼 PNG · 214 KB', status: 'failed' })]);

    await store.reInject('1', 'lan');

    // THE assertion: transport.reInjectLocally — the actual typing exit point —
    // was never called at all. Not with the caption, not with an empty string.
    expect(t.calls).toEqual([]);
    // Refused NAMED, not swallowed (red line: no silent failure): the existing inject-failure
    // face is reused rather than a new silent branch invented for this one case.
    expect(store.lastFailure).toEqual({ op: 'inject', id: '1', channel: 'lan' });
    expect(store.entries()[0]!.status).toBe('failed'); // unchanged — no fabricated verdict
  });

  it('positive control: a TEXT row on the same store still goes through the typer', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { entry_type: 'transcript', output_text: 'a real sentence', status: 'failed' })]);

    await store.reInject('1', 'lan');

    expect(t.calls).toEqual([{ text: 'a real sentence', entryId: '1' }]);
    expect(store.entries()[0]!.status).toBe('injected');
  });
});

// ── 0.2.27: edit and delete are LOCAL writes, and send nothing at all ───────────
describe('TimelineStore — edit / delete write this machine’s own store', () => {
  it('an edit sends NOTHING and is not「pending」anything', async () => {
    const { store, t } = fresh();
    seed(store, [item('1', { output_text: 'original' })]);

    expect(store.edit('1', 'my edit', 'lan')).toBe(true);
    const r = store.entries()[0]!;
    expect(r.output_text).toBe('my edit');
    expect(r.edited).toBe(true);
    // The only native call this transport has is deferred delivery — an edit must
    // not reach it, and
    // there is no other seam left through which an edit could leave the machine.
    expect(t.calls).toEqual([]);
    // No failure line either: nothing could have failed. (RV-01's three sentences about
    // "the server hasn't confirmed" are retired with the verbs — see lib/strings/timeline.ts.)
    expect(store.lastFailure).toBeNull();
    await Promise.resolve();
  });

  it('source_text is untouched by an edit (红线: 不可变)', () => {
    const { store } = fresh();
    seed(store, [item('1', { mode: 'translate', source_text: '原文', output_text: 'translated' })]);
    store.edit('1', 'my better translation', 'lan');
    const r = store.entries()[0]!;
    expect(r.source_text).toBe('原文');
    expect(r.output_text).toBe('my better translation');
  });

  it('a delete is final, and reports whether a row was really removed', () => {
    const { store, t } = fresh();
    seed(store, [item('1'), item('2')]);
    // The boolean is not decoration: the page uses it to decide whether to tell the
    // OTHER window (the capsule strip keeps its own copies).
    expect(store.remove('1', 'lan')).toBe(true);
    expect(store.remove('1', 'lan')).toBe(false); // already gone → nothing to announce
    expect(store.remove('nope', 'cloud')).toBe(false);
    expect(store.entries().map((r) => r.id)).toEqual(['2']);
    expect(t.calls).toEqual([]);
  });

  it('an edit / delete on a row that is not here is a no-op, not a red line', () => {
    // The page can only offer these on a row it is rendering from this very store, so a
    // missing id means the row was evicted or deleted between paint and click. Nothing
    // happened and there is nothing the user could do — a failure line would be noise.
    const { store } = fresh();
    expect(store.edit('ghost', 'x', 'lan')).toBe(false);
    expect(store.remove('ghost', 'lan')).toBe(false);
    expect(store.lastFailure).toBeNull();
  });

  it('both survive a restart, because this machine is where they live', () => {
    const kv = new MemStore();
    const s1 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    seed(s1, [item('1', { output_text: 'original' }), item('2')]);
    s1.edit('1', 'edited and kept', 'lan');
    s1.remove('2', 'lan');

    const s2 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(s2.entries().map((r) => r.id)).toEqual(['1']);
    expect(s2.entries()[0]!.output_text).toBe('edited and kept');
    expect(s2.entries()[0]!.edited).toBe(true);
  });
});

// ── 0.2.27: the retired 0.2.26 durable change queue is wound down ───────────────
describe('TimelineStore — the retired change queue is wound down, not replayed', () => {
  /** A 0.2.26 machine: rows already carrying the user's edit (0.2.26 wrote them
   *  optimistically BEFORE queueing) plus the queue that never reached the server. */
  function storageFrom0226(): MemStore {
    const kv = new MemStore();
    kv.set('flowmic.history.cache', JSON.stringify([
      { ...item('1', { output_text: 'the user’s edit' }), channel: 'lan', target: null, edited: true, pending: true },
      { ...item('2'), channel: 'cloud', target: null },
    ]));
    kv.set('flowmic.history.queue', JSON.stringify([
      { kind: 'edit', id: '1', text: 'the user’s edit', channel: 'lan' },
      { kind: 'delete', id: 'already-gone', channel: 'cloud' },
    ]));
    return kv;
  }

  it('the user’s edits and deletes are STILL THERE — nothing is lost', () => {
    // This is the whole reason the wind-down is safe: the queue only ever held the
    // un-mirrored SERVER half. The rows on screen already show every queued change.
    const kv = storageFrom0226();
    const store = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(store.entries().map((r) => r.id)).toEqual(['2', '1']);
    expect(store.entries().find((r) => r.id === '1')!.output_text).toBe('the user’s edit');
    expect(store.entries().find((r) => r.id === '1')!.edited).toBe(true);
    // The deleted row is not resurrected either — it was already absent from the rows.
    expect(store.entries().map((r) => r.id)).not.toContain('already-gone');
  });

  it('the ops are dropped, the key is emptied, and the COUNT is reportable', () => {
    // A one-way discard of work the user initiated has to be discoverable even when
    // discarding it is correct (no silent failure) — main-window/store.ts logs this number.
    const kv = storageFrom0226();
    const store = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(store.windedDownQueueOps).toBe(2);
    // Emptied on disk, so no later build can resurrect the ops by reading it again.
    expect(kv.get('flowmic.history.queue')).toBe('[]');

    // A second boot has nothing left to wind down and says so — the number answers
    // "how many did this boot wind down", not "how many has this machine ever had".
    const store2 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(store2.windedDownQueueOps).toBe(0);
  });

  it('nothing is ever re-sent — there is no seam to re-send it through', async () => {
    const kv = storageFrom0226();
    const t = new RecordingTransport();
    new TimelineStore(t, kv, () => 1_000);
    await Promise.resolve();
    expect(t.calls).toEqual([]);
  });

  it('a queue that cannot be parsed is reported as unknown, never as zero', () => {
    const kv = new MemStore();
    kv.set('flowmic.history.queue', '{not json');
    const store = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(store.windedDownQueueOps).toBe(-1);
  });

  it('a machine that never queued anything reports zero and rewrites nothing', () => {
    const kv = new MemStore();
    const store = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(store.windedDownQueueOps).toBe(0);
    expect(kv.get('flowmic.history.queue')).toBeNull();
  });

  it('a 0.2.26 row’s `pending` bit does not survive as a chip', () => {
    // `pending` meant "this machine changed it and it hasn't been uplinked yet". With
    // no uplink the flag could never be true
    // again, so it is dropped at the normalization boundary rather than rendered as
    // "saved locally" forever (the text-layer face of a façade).
    const kv = storageFrom0226();
    const store = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect('pending' in store.entries()[0]!).toBe(false);
  });
});

// ── RV-01: two channels are two servers, and (channel, id) is still the ADDRESS ──
//
// No verb travels to a server any more, so this is no longer about routing. It is about
// identity: both channels' rows live in one list, and inject:result / the page's own
// keys have to be able to name exactly one of them.
describe('TimelineStore — a row is addressed by (channel, id)', () => {
  it('the SAME id on both servers is two rows, and each op hits only its own', () => {
    // The phone mints entry ids and re-flushes them wherever it is connected, so one id
    // really can exist on both channels' histories. Keying by the bare id would have
    // made this edit, display and delete the wrong machine's row.
    const { store } = fresh();
    seed(store, [item('1', { output_text: 'the LAN row' })], 'lan');
    seed(store, [item('1', { output_text: 'a DIFFERENT row, same id' })], 'cloud');
    expect(store.entries()).toHaveLength(2);

    store.edit('1', 'text meant for the LAN row', 'lan');
    const byChannel = new Map(store.entries().map((r) => [r.channel, r.output_text]));
    expect(byChannel.get('lan')).toBe('text meant for the LAN row');
    expect(byChannel.get('cloud')).toBe('a DIFFERENT row, same id'); // untouched
    expect(store.textOf('1', 'cloud')).toBe('a DIFFERENT row, same id');

    store.remove('1', 'cloud');
    expect(store.entries().map((r) => r.channel)).toEqual(['lan']); // the LAN row stays
  });

  it('BOTH channels’ rows are held, each keeping its stamp', () => {
    // owner 2026-07-30 ①. The INVERSE of what this used to assert: the cloud rows used
    // to be discarded as「another room's timeline」, which is how rows this PC had really
    // received disappeared whenever a phone joined on the other channel.
    const { store } = fresh();
    seed(store, [item('1')], 'lan');
    seed(store, [item('7'), item('8')], 'cloud');
    expect(store.entries().map((r) => r.id)).toEqual(['8', '7', '1']);
    expect(new Set(store.entries().map((r) => r.channel))).toEqual(new Set(['lan', 'cloud']));
  });

  it('a restart resumes BOTH channels’ rows', () => {
    const kv = new MemStore();
    const s1 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    seed(s1, [item('5')], 'cloud');
    seed(s1, [item('4')], 'lan');

    const s2 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(s2.entries().map((r) => r.id)).toEqual(['5', '4']);
    expect(new Set(s2.entries().map((r) => r.channel))).toEqual(new Set(['lan', 'cloud']));
  });
});

// ── R6 T-4 image pipeline ────────────────────────────────────────────────────────────
describe('TimelineStore — a picture row never quietly claims to be text', () => {
  it('an image inject marks the row 图片, and the mark is durable', () => {
    const kv = new MemStore();
    const s1 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    seed(s1, [item('1'), item('2')]);
    expect(s1.entries().find((r) => r.id === '1')!.entry_type).toBe('transcript');

    s1.onInjectResult(verdict('1', { mode: 'clipboard', entry_kind: 'image' }));
    s1.onInjectResult(verdict('2'));
    expect(s1.entries().find((r) => r.id === '1')!.entry_type).toBe('image');
    expect(s1.entries().find((r) => r.id === '2')!.entry_type).toBe('transcript');

    // A brand-new store over the same storage still knows which row was a picture.
    const s2 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(s2.entries().find((r) => r.id === '1')!.entry_type).toBe('image');
    expect(s2.entries().find((r) => r.id === '2')!.entry_type).toBe('transcript');
  });

  it('an image result that arrives BEFORE its row is not lost', () => {
    const { store } = fresh();
    // The PC pastes and reports before the row itself is known here.
    expect(store.onInjectResult(verdict('9', { mode: 'clipboard', entry_kind: 'image' }))).toBe('no-such-row');
    expect(store.entries()).toHaveLength(0);

    seed(store, [item('9')]);
    expect(store.entries()[0]!.entry_type).toBe('image');
  });
});

// ── owner 2026-07-31: the search is local, because the rows are local ─────────────────────────────
//
// The server stores no transcripts, so `history:list{query}` would answer "no match" to
// every query ever typed — the same sentence, become a lie with none of its characters
// changed. These lock the replacement: NOTHING leaves the machine to answer a search.
describe('TimelineStore — the search is a local filter over the rows this PC owns', () => {
  it('a search sends NOTHING and answers from the rows in hand', () => {
    const { store, t } = fresh();
    seed(store, [item('1', { output_text: 'the standup notes' }), item('2')]);

    store.search('  standup  '); // trimmed at the boundary
    expect(t.calls).toHaveLength(0); // no pull, no round trip, no server
    expect(store.query).toBe('standup');
    expect(store.entries().map((r) => r.id)).toEqual(['1']);
  });

  it('matches output_text OR source_text, and nothing else', () => {
    // The two fields a SURFACE renders. `source_text` is the source text — a translate
    // row's output can be text the user never read, so a hit there is the honest one.
    const { store } = fresh();
    seed(store, [
      item('1', { output_text: 'translated output', source_text: '会议纪要', mode: 'translate' }),
      item('2', { output_text: 'nothing relevant', source_text: null }),
    ]);
    store.search('会议');
    expect(store.entries().map((r) => r.id)).toEqual(['1']);
    store.search('translated');
    expect(store.entries().map((r) => r.id)).toEqual(['1']);
    // A row whose source_text is null must not throw or match.
    store.search('nothing');
    expect(store.entries().map((r) => r.id)).toEqual(['2']);
  });

  it('is ASCII-case-insensitive, and stops there — a STATED limit', () => {
    // 0.2.22 ruling: `toLowerCase()` was REJECTED because it is Unicode-aware. Folding
    // differently on two surfaces is how a should-match becomes a silent miss.
    const { store } = fresh();
    seed(store, [item('1', { output_text: 'Hello Ärger' })]);
    store.search('hello');
    expect(store.entries()).toHaveLength(1); // ASCII folds
    store.search('ärger');
    expect(store.entries()).toHaveLength(0); // non-ASCII does NOT
    store.search('Ärger');
    expect(store.entries()).toHaveLength(1);
  });

  it('the term is a LITERAL, not a pattern', () => {
    const { store } = fresh();
    seed(store, [item('1', { output_text: '100% done' }), item('2', { output_text: '100 done' })]);
    store.search('100%');
    expect(store.entries().map((r) => r.id)).toEqual(['1']); // not "100 followed by anything"
  });

  it('the hits are DERIVED, so a row arriving mid-search joins them', () => {
    // Why the hit set is not stored: a phone talking while the box has text would
    // otherwise be hidden from a list headed "search results" that claims to hold the matches.
    const { store } = fresh();
    store.search('meeting');
    expect(store.entries()).toEqual([]);
    seed(store, [item('9', { output_text: 'the meeting starts' })], 'cloud');
    expect(store.entries().map((r) => r.id)).toEqual(['9']);
  });

  it('an edit that stops matching leaves the results immediately', () => {
    const { store } = fresh();
    seed(store, [item('1', { output_text: 'before' })]);
    store.search('before');
    expect(store.entries()).toHaveLength(1);
    store.edit('1', 'after', 'lan');
    expect(store.entries()).toHaveLength(0); // no stale hit left behind
    store.clearSearch();
    expect(store.entries()[0]!.output_text).toBe('after'); // one row object, edited once
  });

  it('clearing restores the full timeline with no round trip', () => {
    const { store, t } = fresh();
    seed(store, [item('1', { output_text: 'aaa' }), item('2'), item('3')]);
    store.search('aaa');
    expect(store.entries()).toHaveLength(1);
    store.clearSearch();
    expect(store.query).toBe('');
    expect(store.entries()).toHaveLength(3);
    expect(t.calls).toHaveLength(0);
  });

  it('searching for whitespace is not a search', () => {
    const { store } = fresh();
    seed(store, [item('1')]);
    store.search('   ');
    expect(store.query).toBe('');
    expect(store.entries()).toHaveLength(1);
  });

  it('deleting a hit removes it from the results as well as the list', () => {
    const { store } = fresh();
    seed(store, [item('1', { output_text: 'x marks' }), item('2', { output_text: 'x also' })]);
    store.search('x ');
    expect(store.entries()).toHaveLength(2);
    store.remove('1', 'lan');
    expect(store.entries().map((r) => r.id)).toEqual(['2']);
    store.clearSearch();
    expect(store.entries().map((r) => r.id)).toEqual(['2']);
  });
});

// ── owner 2026-07-31: THIS PC OWNS THE ROWS ──────────────────────────────────
//
// The store used to be a cache of the server's `transcript_history`; the server holds
// no transcripts at all now. These lock the obligations an owner has and a cache does
// not: a STATED bound and a CHECKED write.

/** A row with an explicit instant, for the ordering the bound depends on. */
function dated(id: string, iso: string, over: Partial<WireHistoryItem> = {}): WireHistoryItem {
  return { ...item(id), created_at: iso, updated_at: iso, ...over };
}
/** `n` rows one minute apart, oldest first. */
function series(n: number, prefix = 'r'): WireHistoryItem[] {
  const base = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => dated(`${prefix}${i}`, new Date(base + i * 60_000).toISOString()));
}

describe('TimelineStore — no other writer may overwrite a row this PC owns', () => {
  it('the delivery status THIS machine established is the one that stands', () => {
    // The local row's status is delivery truth this PC established by injecting (red line).
    // Nothing bulk-rewrites rows any more — the pull that could is gone — so this locks
    // the property that survives: onInjectResult is the only writer of `status`.
    const { store } = fresh();
    seed(store, [item('1', { status: 'cached' })]);
    expect(store.onInjectResult(verdict('1'))).toBeNull();
    expect(store.entries()[0]!.status).toBe('injected');
  });

  // RV-72 — `entry_id` is a CORRELATION echo, not an address. It stopped being one the
  // moment a re-delivery started carrying the SAME entry_id for a NEW row (owner ②), and
  // it never was one for the frames that carry none. Reading it here would put a verdict
  // on whichever row happened to share that string.
  it('a verdict lands by row_id, and NEVER by the entry_id riding beside it', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'cached' })]);
    // A verdict for some OTHER row, whose A-58 echo happens to name this one.
    expect(store.onInjectResult(verdict('other', { entry_id: '1' }))).toBe('no-such-row');
    expect(store.entries()[0]!.status).toBe('cached');
    // Positive control on the same store: the right address does land.
    expect(store.onInjectResult(verdict('1', { entry_id: 'something else entirely' }))).toBeNull();
    expect(store.entries()[0]!.status).toBe('injected');
  });

  it('an UNADDRESSABLE result updates no row rather than guessing — and SAYS so', () => {
    // Both halves ship in one binary, so a bridge frame missing either stamp means the
    // bridge drifted. Guessing "just assume it's the current channel" is RV-01 all
    // over again; guessing
    // "just assume entry_id is the row number" is RV-72 all over again. The caller writes the forensic line
    // (main-window/store.ts) — a silent no-op is what this return value replaces.
    const { store } = fresh();
    seed(store, [item('1', { status: 'failed' })]);
    // No channel…
    expect(store.onInjectResult({ ok: true, mode: 'sendinput', row_id: '1' })).toBe('unaddressable');
    // …no row_id…
    expect(store.onInjectResult({ ok: true, mode: 'sendinput', entry_id: '1', channel: 'lan' })).toBe('unaddressable');
    expect(store.entries()[0]!.status).toBe('failed');
    // …but a result that HAS an address and only lacks the channel still applies the
    // IMAGE hint at once (a display fact that needs no server), because nothing will
    // come along later to rewrite the row.
    store.onInjectResult({ ok: true, mode: 'clipboard', row_id: '1', entry_kind: 'image' });
    expect(store.entries()[0]!.entry_type).toBe('image');
    // …and the positive control, so the zeroes above are the rule and not a blind probe.
    expect(store.onInjectResult(verdict('1'))).toBeNull();
    expect(store.entries()[0]!.status).toBe('injected');
  });

  // 🔴 card D — an existing row's status must never be downgraded.
  //
  // A queued re-delivery of the same utterance is a REAL case (owner ⑤: "no matter
  // how much time has passed, everything must be delivered", and the phone re-sends
  // until it is acked), and it can honestly resolve
  // to `cached` the second time — the window the user was typing into moved on. Letting
  // that rewrite the row would turn a delivery that really happened into a claim that it
  // did not: the "no silent failure" red line read from its other side, and the literal breach
  // of obligation ① at the top of timeline-store.ts.
  it('a row that was really INJECTED is never re-minted back down to cached', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'injected', output_text: 'the sentence that landed' })]);
    // The same entry_id arrives again carrying a worse verdict.
    seed(store, [item('1', { status: 'cached', output_text: 'the sentence that landed' })]);
    expect(store.entries()[0]!.status).toBe('injected');
    seed(store, [item('1', { status: 'failed' })]);
    expect(store.entries()[0]!.status).toBe('injected');
    // …and it survives the restart, because it was persisted as the truth it is.
    expect(store.entries()).toHaveLength(1);
  });

  // 🔴 Lead controller's ruling 2026-07-31 — obligation ① read literally, and a regression THIS window
  // introduced: while `onHistoryUpdated` had no producer this could not happen; wiring
  // the producer back made it reachable, so it is closed in the same round.
  //
  // owner ⑦ says the PC does not PUSH its edits out. It does not say the PC's row may be
  // pushed back over. A local edit is a fact this machine established, exactly like
  // `status`, and a re-delivery of the same entry_id (owner ⑧: the phone's only route
  // for new text) has no standing to revoke it.
  it('a row EDITED on this PC keeps that edit when the same delivery arrives again', () => {
    const { store } = fresh();
    seed(store, [item('1', { output_text: 'what the phone sent' })]);
    store.edit('1', '用户在电脑上改过的正文', 'lan');
    // The phone re-delivers the same row — with ITS text, which is not the user's.
    seed(store, [item('1', { output_text: 'what the phone sent' })]);
    const row = store.entries()[0]!;
    expect(row.output_text).toBe('用户在电脑上改过的正文');
    expect(row.edited).toBe(true);
  });

  it('the refusal is REPORTED, so it does not swap one silence for another', () => {
    const { store } = fresh();
    seed(store, [item('1', { output_text: 'the original' })]);
    store.edit('1', 'the user’s words', 'lan');
    const report = store.onHistoryUpdated(item('1', { output_text: 'a phone-side rewrite' }), 'lan');
    expect(report?.refusedFields).toContain('output_text');
    expect(report?.refusedFields).toContain('edited');
    expect(report?.locallyEdited).toBe(true);
    expect(report?.id).toBe('1');
    expect(report?.channel).toBe('lan');
    // …and a frame that AGREES reports nothing, so the log is not noise.
    seed(store, [item('2')]);
    expect(store.onHistoryUpdated(item('2'), 'lan')?.refusedFields).toEqual([]);
    // A brand-new row has nothing to disagree with.
    expect(store.onHistoryUpdated(item('3'), 'lan')?.refusedFields).toEqual([]);
  });

  it('an UNEDITED row is protected too — the rule is about the ROW, not about `edited`', () => {
    // A phone-side edit re-delivered per owner ⑧ arrives with new text and `edited:false`.
    // It is refused all the same: this PC's record of what was delivered is not the
    // phone's to rewrite, and the refusal is reported rather than swallowed.
    const { store } = fresh();
    seed(store, [item('1', { output_text: 'as first delivered' })]);
    const report = store.onHistoryUpdated(item('1', { output_text: 'the phone changed it' }), 'lan');
    expect(store.entries()[0]!.output_text).toBe('as first delivered');
    expect(report?.refusedFields).toEqual(['output_text']);
    expect(report?.locallyEdited).toBe(false);
  });

  it('source_text is immutable across a re-delivery too (红线: 不可变)', () => {
    const { store } = fresh();
    seed(store, [item('1', { source_text: '原文' })]);
    seed(store, [item('1', { source_text: 'a different 原文' })]);
    expect(store.entries()[0]!.source_text).toBe('原文');
  });

  it('DISPLAY facts still backfill — absent → present is an answer, not an overwrite', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'cached' })]);
    seed(store, [
      item('1', {
        status: 'injected',
        thumb_b64: 'QUJDRA==',
        device_label: 'Pixel 8-ab12',
        entry_type: 'image',
      }),
    ]);
    const row = store.entries()[0]!;
    expect(row.status).toBe('injected'); // forward-only status still applies
    expect(row.thumb_b64).toBe('QUJDRA==');
    expect(row.device_label).toBe('Pixel 8-ab12');
    expect(row.entry_type).toBe('image');
    // …but present → DIFFERENT is not a backfill, and image → transcript would undo what
    // this PC learned by pasting the bytes.
    seed(store, [item('1', { thumb_b64: 'WllYWQ==', device_label: 'Mate 60-cd34', entry_type: 'transcript' })]);
    const after = store.entries()[0]!;
    expect(after.thumb_b64).toBe('QUJDRA==');
    expect(after.device_label).toBe('Pixel 8-ab12');
    expect(after.entry_type).toBe('image');
  });

  it('an UPGRADE is not blocked — a later delivery that really succeeded stands', () => {
    // The rule is one-way on purpose. `cached`/`failed` say "this attempt didn't land", and a later
    // attempt that DID get in is newer truth about the same row.
    const { store } = fresh();
    seed(store, [item('1', { status: 'cached' })]);
    seed(store, [item('1', { status: 'injected' })]);
    expect(store.entries()[0]!.status).toBe('injected');
  });

  it('the guard is per ADDRESS — the other server’s row of the same id is untouched', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'injected' })], 'lan');
    seed(store, [item('1', { status: 'cached' })], 'cloud');
    const byChannel = Object.fromEntries(store.entries().map((r) => [r.channel, r.status]));
    expect(byChannel).toEqual({ lan: 'injected', cloud: 'cached' });
  });
});

// ── card P + card D: a delivery frame IS the row ─────────────────────────────────
//
// The producer is `socket::row_transit::mint_row` (Rust). What is asserted here is the
// half that lives in this store: a minted row is a complete row, and the field the
// minted shape brought with it (`device_label`) survives the boundary. The two
// rulings — born-with-the-verdict, and one result ⇔ one row — are properties of
// the PRODUCER and
// are asserted in apps/desktop/src-tauri/src/socket/row_transit.rs.
describe('TimelineStore — a row minted from a delivery frame', () => {
  /** Exactly the item shape `row_transit::build_row` emits. */
  function minted(over: Partial<WireHistoryItem> = {}): WireHistoryItem {
    return {
      // RV-72: the id a current producer really emits is the DELIVERY's, prefixed —
      // `row_transit::row_id` → `req:{request_id}`. Written out rather than left as a
      // phone `entry_id`, because "the row address is entry_id" is precisely the
      // assumption this
      // card removed, and a fixture that keeps it would hide the next regression.
      id: 'req:u7-1',
      mode: 'translate',
      status: 'injected',
      edited: false,
      source_text: '你好世界',
      output_text: 'Hello world',
      created_at: '2026-07-30T08:15:00.000Z',
      updated_at: '2026-07-30T08:15:00.000Z',
      entry_type: 'transcript',
      device_label: 'Pixel 8-ab12',
      ...over,
    };
  }

  it('lands as a complete row — every field comes from the frame that delivered it', () => {
    const { store } = fresh();
    store.onHistoryUpdated(minted(), 'lan');
    const row = store.entries()[0]!;
    expect(row).toMatchObject({
      id: 'req:u7-1',
      mode: 'translate',
      status: 'injected',
      edited: false,
      source_text: '你好世界',
      output_text: 'Hello world',
      created_at: '2026-07-30T08:15:00.000Z',
      entry_type: 'transcript',
      device_label: 'Pixel 8-ab12',
      channel: 'lan',
    });
    // Provenance is still PC-local knowledge that arrives on the inject:result, not on
    // the row — a minted row starts with none rather than an invented one.
    expect(row.target).toBeNull();
  });

  it('the row and its inject:result describe ONE delivery, in either order', () => {
    // The producer forwards the row first and the result second, and the result then
    // stamps the target the row could not carry. Asserted both ways round because the
    // two frames cross two independent Tauri channels.
    const { store } = fresh();
    const row = minted();
    store.onHistoryUpdated(row, 'lan');
    // The producer hands the ADDRESS over on the verdict (row_transit::forward_verdict);
    // it is the id of the row it just minted, which is `req:{request_id}` for every frame
    // a current phone sends — NOT the entry_id echoed beside it.
    expect(
      store.onInjectResult({
        ok: true,
        mode: 'sendinput',
        row_id: row.id,
        entry_id: 'the A-58 echo, which is not an address',
        channel: 'lan',
        inject_target: { window_title: 'Untitled - Notepad', process_name: 'notepad', injected_at: 'i' },
      }),
    ).toBeNull();
    expect(store.entries()[0]!.status).toBe('injected');
    expect(store.entries()[0]!.target?.process_name).toBe('notepad');
  });

  it('a row minted for a phone that named itself can SAY which phone (卡 P device_label)', () => {
    // The delivery frame carries no `mobile_id` — the relay forwards it verbatim and
    // InjectRequestSchema has no such field — so this is the row's only sender identity
    // and it must survive the boundary AND the restart.
    const kv = new MemStore();
    const s1 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    s1.onHistoryUpdated(minted(), 'lan');
    const s2 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(s2.entries()[0]!.device_label).toBe('Pixel 8-ab12');
  });

  it('a phone that did not name itself leaves it null — never an empty chip', () => {
    const { store } = fresh();
    store.onHistoryUpdated(minted({ device_label: undefined }), 'lan');
    expect(store.entries()[0]!.device_label).toBeNull();
    // …and a later frame that omits it does not blank a row that already knew.
    store.onHistoryUpdated(minted({ id: 'req:u7-2' }), 'lan');
    store.onHistoryUpdated(minted({ id: 'req:u7-2', device_label: undefined }), 'lan');
    expect(store.entries().find((r) => r.id === 'req:u7-2')!.device_label).toBe('Pixel 8-ab12');
  });

  // ── RV-72 (owner 2026-07-31 ②) — the half of "one re-delivery = one new row" that lives here ──
  //
  // The producer's half (a re-delivery gets a NEW address) is asserted in
  // socket/row_transit.rs. What has to hold HERE is that a second address really becomes
  // a second row rather than being folded in by the freeze rule — and that the first row
  // is left exactly as it was, which is the whole point of "the old row is kept
  // exactly as it was".
  it('a re-delivery arrives as a SECOND row and leaves the first one alone', () => {
    const { store } = fresh();
    store.onHistoryUpdated(minted({ output_text: 'the first attempt' }), 'lan');
    store.onHistoryUpdated(
      minted({ id: 'req:u7-1-rp99', output_text: '改过的句子', created_at: '2026-07-30T09:00:00.000Z' }),
      'lan',
    );
    const rows = store.entries();
    expect(rows.map((r) => r.id)).toEqual(['req:u7-1-rp99', 'req:u7-1']);
    expect(rows.map((r) => r.output_text)).toEqual(['改过的句子', 'the first attempt']);
    // Reverse control: the SAME delivery replayed (INJ-3 reconnect flap) is still ONE
    // row, or every network hiccup would duplicate a line in the user's timeline.
    store.onHistoryUpdated(minted({ id: 'req:u7-1-rp99', output_text: '改过的句子' }), 'lan');
    expect(store.entries()).toHaveLength(2);
  });

  it('an image row minted from a picture delivery keeps its preview', () => {
    const { store } = fresh();
    store.onHistoryUpdated(
      minted({ id: 'img-1', entry_type: 'image', output_text: '', thumb_b64: 'QUJDRA==' }),
      'lan',
    );
    const row = store.entries().find((r) => r.id === 'img-1')!;
    expect(row.entry_type).toBe('image');
    expect(row.thumb_b64).toBe('QUJDRA==');
  });
});

// ── RV-93 — size B on the PC: two sizes on the row, and the big one on disk ──────
//
// owner 2026-08-01: "on the PC, its timeline should also show a small thumbnail
// similar to the phone's, and once opened, it should also show the actual
// delivered picture that works". The row carries the flag; the bytes live beside the
// forensic log (socket::row_image) because ONE `image_b64` can be 3× the whole
// localStorage budget for every row this store keeps.
describe('TimelineStore — 两个尺寸: the row says whether its big picture was kept', () => {
  it('takes the flag off the frame that minted the row', () => {
    const { store } = fresh();
    seed(store, [item('img-1', { entry_type: 'image', thumb_b64: 'QUJDRA==', full_image: true })]);
    const row = store.entries()[0]!;
    expect(row.full_image).toBe(true);
    // positive control: the SMALL size is untouched — two sizes, not one replacing the other.
    expect(row.thumb_b64).toBe('QUJDRA==');
  });

  it('a frame that says nothing means 「没存下来」, never `undefined`', () => {
    // Every row minted before this feature, and every row whose picture could not be
    // written. The zoom then shows the thumbnail — the behaviour those rows always had.
    const { store } = fresh();
    seed(store, [item('img-2', { entry_type: 'image', thumb_b64: 'QUJDRA==' })]);
    expect(store.entries()[0]!.full_image).toBe(false);
  });

  it('backfills false → true, and a later frame can never un-say it', () => {
    // Same rule as thumb_b64 / device_label: absent → present is an answer. The reverse
    // would leave a picture on disk that no row is willing to open.
    const { store } = fresh();
    seed(store, [item('img-3', { entry_type: 'image', status: 'cached' })]);
    seed(store, [item('img-3', { entry_type: 'image', full_image: true })]);
    expect(store.entries()[0]!.full_image).toBe(true);
    seed(store, [item('img-3', { entry_type: 'image' })]);
    expect(store.entries()[0]!.full_image).toBe(true);
  });

  it('🔴 a trimmed row takes its picture with it — and only the trimmed ones', () => {
    // "when a row gets trimmed, its bytes go with it". This is the ONLY delete of a delivered picture in the
    // product, so if this call is ever dropped the files accumulate forever with no
    // row left to open them — a leak nothing else in the system would report.
    const { store, t } = fresh();
    const rows = series(MAX_ROWS + 3).map((r) => ({ ...r, entry_type: 'image' as const, full_image: true }));
    seed(store, rows);
    expect(store.entries()).toHaveLength(MAX_ROWS);
    // The three OLDEST were evicted, and exactly those three ids were sent.
    expect(t.droppedImages).toEqual(['r0', 'r1', 'r2']);
    // positive control: a row still on screen must never have had its picture dropped.
    const kept = new Set(store.entries().map((r) => r.id));
    for (const id of t.droppedImages) expect(kept.has(id)).toBe(false);
  });

  it('evicting rows that kept no picture costs no call at all', () => {
    // ⟲ reverse control for the test above: if the filter were dropped, THIS would send 3 ids
    // for rows that have no file — noise the Rust side would have to sift.
    const { store, t } = fresh();
    seed(store, series(MAX_ROWS + 3));
    expect(store.entries()).toHaveLength(MAX_ROWS);
    expect(t.droppedImages).toEqual([]);
  });
});

describe('TimelineStore — the bound is stated, not silent (owner ②)', () => {
  it('keeps at most MAX_ROWS and reports how many, and from when', () => {
    const { store } = fresh();
    const rows = series(MAX_ROWS + 50);
    seed(store, rows);

    const { kept, cutoff } = store.retention;
    expect(kept).toBe(MAX_ROWS);
    expect(store.entries()).toHaveLength(MAX_ROWS);
    // The cutoff is the newest instant DROPPED — everything at or older than it is
    // gone from this PC, which is exactly what the page tells the user.
    expect(cutoff).toBe(rows[49]!.created_at);
    expect(store.entries().map((r) => r.id)).not.toContain('r49');
    expect(store.entries().map((r) => r.id)).toContain('r50');
  });

  it('nothing evicted ⇒ cutoff is null (「更早的没有」 is a different sentence)', () => {
    const { store } = fresh();
    seed(store, series(10));
    expect(store.retention).toEqual({ kept: 10, cutoff: null, cutoffs: { text: null, images: null } });
  });

  it('a byte budget binds before the row count when rows carry pictures', () => {
    // 2000 transcripts fit easily; a handful of 200 KB previews do not. The user is
    // told the KEPT COUNT and the CUTOFF, which stay true whichever limit bound.
    const { store } = fresh();
    seed(store, series(6, 'img').map((r) => ({ ...r, thumb_b64: 'A'.repeat(400_000) })));
    expect(store.retention.kept).toBeLessThan(6);
    expect(store.retention.kept).toBeGreaterThan(0);
    expect(store.retention.cutoff).not.toBeNull();
    expect(store.entries()[0]!.id).toBe('img5'); // the newest survives
  });

  it('the newest row is kept even if it alone exceeds the budget', () => {
    const { store } = fresh();
    seed(store, [dated('huge', '2026-02-01T00:00:00.000Z', { thumb_b64: 'A'.repeat(2_000_000) })]);
    expect(store.entries().map((r) => r.id)).toEqual(['huge']);
  });

  it('an EDITED row is evictable like any other — and that is deliberate', () => {
    // 0.2.26 protected `pending` rows because their op was still in the uplink queue.
    // There is no queue and no uplink, so an edited row is just a row: it participates
    // in the bound like the rest, and the STATED cutoff is what keeps that honest.
    const { store } = fresh();
    seed(store, series(MAX_ROWS + 50));
    store.edit('r50', 'edited, and still subject to the bound', 'lan');
    seed(store, series(100, 'later').map((r) => ({
      ...r,
      created_at: `2027-${r.created_at.slice(5)}`,
      updated_at: `2027-${r.updated_at.slice(5)}`,
    })));
    expect(store.entries().map((r) => r.id)).not.toContain('r50');
    expect(store.retention.kept).toBe(MAX_ROWS);
    expect(store.retention.cutoff).not.toBeNull(); // …and the page can say so
  });

  // ── RV-76 — "a row that just succeeded in delivery" beats "older than the
  // cutoff" (Lead controller, 2026-07-31) ──────────────
  //
  // The cutoff used to REFUSE any arriving row at or older than it, silently. That was
  // right while the only producer was a server re-broadcasting its own table. The only
  // producer now is a DELIVERY FRAME, whose created_at is when the phone SPOKE — days ago
  // for a queued re-delivery, by design (owner: "no matter how much time has
  // passed, everything must be delivered"). So the guard
  // was throwing away rows whose text had JUST been typed into the user's window.
  it('a row older than the cutoff is TAKEN IN — the words were just typed here', () => {
    const { store } = fresh();
    // Make the store evict, so a real cutoff exists…
    seed(store, series(MAX_ROWS + 50));
    const cutoff = store.retention.cutoff;
    expect(cutoff).not.toBeNull();
    // …then delete enough rows that there is plenty of room, and deliver something the
    // phone spoke long before the cutoff. This is the whole failure: nothing about the
    // bound stops this row, only the door did.
    for (const r of store.entries().slice(0, 100)) store.remove(r.id, r.channel);
    const old = dated('queued-for-days', '2020-01-01T00:00:00.000Z', { output_text: '三天前说的那句' });
    const report = store.onHistoryUpdated(old, 'lan');

    expect(report).not.toBeNull();
    expect(report!.evictedOnArrival).toBe(false);
    expect(store.entries().map((r) => r.id)).toContain('queued-for-days');
    // …and the BOUND is untouched: the cutoff this PC published is still true and still
    // says what it always said (owner ②). Fixing the door must not delete the policy.
    expect(store.retention.cutoff).toBe(cutoff);
  });

  it('…and at the bound it is reported as dropped-on-arrival, never silently swallowed', () => {
    // The residual case, made LOUD instead of made to disappear: the store really is
    // full, the row really is older than everything in it, so the stated policy drops it
    // in the same write. The caller writes the forensic line (main-window/store.ts).
    const { store } = fresh();
    seed(store, series(MAX_ROWS + 50));
    const report = store.onHistoryUpdated(dated('queued-for-days', '2020-01-01T00:00:00.000Z'), 'lan');
    expect(report).not.toBeNull();
    expect(report!.evictedOnArrival).toBe(true);
    expect(store.entries().map((r) => r.id)).not.toContain('queued-for-days');
    expect(store.entries()).toHaveLength(MAX_ROWS);
  });

  it('the cutoff survives a restart —「被清掉了」must not become「本来就没有」', () => {
    const kv = new MemStore();
    const s1 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    seed(s1, series(MAX_ROWS + 50));
    const cutoff = s1.retention.cutoff;
    expect(cutoff).not.toBeNull();

    const s2 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    // C2: the persisted shape gained per-kind marks. A capacity eviction is
    // kind-blind, so both of them are the same instant as the combined one.
    expect(s2.retention).toEqual({ kept: MAX_ROWS, cutoff, cutoffs: { text: cutoff, images: cutoff } });
  });

  it('the bound is applied AT BOOT, not at the first user action', () => {
    // A store hydrating an oversized cache from an older build must not render rows it
    // is about to shed — that is "thought it was all there" arriving by a different door.
    const kv = new MemStore();
    kv.set('flowmic.history.cache', JSON.stringify(
      series(MAX_ROWS + 50).map((r) => ({ ...r, channel: 'lan', target: null, entry_type: 'transcript' })),
    ));
    const store = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(store.entries()).toHaveLength(MAX_ROWS);
    expect(store.retention.cutoff).not.toBeNull();
    // What is on screen is what is on disk.
    expect(JSON.parse(kv.get('flowmic.history.cache') ?? '[]')).toHaveLength(MAX_ROWS);
  });
});

describe('TimelineStore — a write that did not land is stated (owner ③)', () => {
  it('a refusing store sets storageFailed, and a working one clears it', () => {
    const kv = new MemStore();
    const store = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    expect(store.storageFailed).toBe(false);

    kv.refuse = true;
    seed(store, [item('1')]);
    // The row is on screen — and it is NOT on disk (storage still holds the empty
    // array the constructor wrote). Before this the two were indistinguishable, which
    // is "the user thinks their whole history is there" one layer down.
    expect(store.entries()).toHaveLength(1);
    expect(store.storageFailed).toBe(true);
    expect(kv.get('flowmic.history.cache')).toBe('[]');

    kv.refuse = false;
    store.edit('1', 'now it can be written', 'lan');
    expect(store.storageFailed).toBe(false);
    expect(JSON.parse(kv.get('flowmic.history.cache') ?? '[]')).toHaveLength(1);
  });

  it('an EMPTY store is not a failed one', () => {
    const { store } = fresh();
    expect(store.storageFailed).toBe(false);
    expect(store.retention).toEqual({ kept: 0, cutoff: null, cutoffs: { text: null, images: null } });
  });
});

// ── owner 2026-07-27: the PC timeline page going entirely blank regression ────────────────────────
//
// The persisted `flowmic.history.cache` outlives upgrades and can hold rows in a
// shape no current type describes. The owner's PC held raw SERVER rows
// (pairing_id / source_lang / duration_ms …) carrying status:'injected' and NO
// `target` key; `undefined` slipped past a `=== null` guard in the provenance
// helper and threw DURING RENDER, blanking the whole page. These lock the
// boundary that now normalizes such rows.
import { describe as d3, expect as e3, it as i3 } from 'vitest';
import { asChannelTag, normalizeCachedRow } from './timeline-normalize';
import { TimelineStore as TS3 } from './timeline-store';
import { injectProvenanceTooltip } from './inject-provenance';

/** Verbatim shape of a row found in the owner's real WebView2 localStorage. */
function legacyServerRow(): Record<string, unknown> {
  return {
    id: 'bc77ebec-a7ae-4190-89fd-6c24c96e1834',
    pairing_id: '0d8684cd-3e6f-4c52-b8f4-1234567890ab',
    pc_device_id: '4638-2393-00fe',
    user_id: 'default',
    mobile_id: '494f2b8c',
    mode: 'realtime',
    source_text: null,
    source_lang: 'zh-CN',
    output_text: '然后呢我想问一下',
    output_lang: 'zh-CN',
    duration_ms: 9490,
    segments_count: 1,
    status: 'injected', // ← injected, and there is NO `target` key at all
    edited: 0,
    created_at: '2026-07-26T11:36:12.800Z',
    updated_at: '2026-07-26T11:36:12.800Z',
  };
}

d3('timeline cache — legacy/foreign row shapes cannot blank the page', () => {
  i3('the provenance helper survives an injected row whose target is undefined', () => {
    // This threw `Cannot read properties of undefined (reading window_title)`
    // before the fix — inside a Vue render, which took the entire page with it.
    e3(() => injectProvenanceTooltip('injected', undefined as never)).not.toThrow();
    e3(injectProvenanceTooltip('injected', undefined as never)).toBeNull();
  });

  i3('a raw server row normalizes to the TimelineRow contract', () => {
    const row = normalizeCachedRow(legacyServerRow(), 'lan');
    e3(row).not.toBeNull();
    e3(row!.target).toBeNull(); // the missing key becomes an explicit null
    e3(row!.entry_type).toBe('transcript');
    e3(row!.edited).toBe(false); // 0 is not true
    e3(row!.output_text).toBe('然后呢我想问一下');
    e3(row!.channel).toBe('lan');
  });

  i3('an UNTAGGED cached row is dropped rather than assumed to be LAN"s', () => {
    // RV-01: every row cached by a pre-RV-01 build has no channel, so nobody can know
    // which server it lives on — and a guess is the defect being fixed. ⚠️ 0.2.27 makes
    // this LOSSY where it used to be self-healing: there is no refresh to re-pull a
    // properly stamped window any more, so such a row is gone for good. Accepted rather
    // than softened: the builds that wrote untagged rows predate 0.2.4, and inventing a
    // channel for a row is what RV-01 exists to forbid.
    e3(normalizeCachedRow(legacyServerRow())).toBeNull();
    e3(normalizeCachedRow({ ...legacyServerRow(), channel: 'saas' })).toBeNull();
    e3(normalizeCachedRow({ ...legacyServerRow(), channel: 'cloud' })!.channel).toBe('cloud');
    // The narrowing helper the bridge handlers share.
    e3(asChannelTag('lan')).toBe('lan');
    e3(asChannelTag('cloud')).toBe('cloud');
    e3(asChannelTag(undefined)).toBeNull();
    e3(asChannelTag('primary')).toBeNull();
  });

  i3('hydrating a cache of tagged legacy rows yields renderable entries', () => {
    const kv = new MemStore();
    kv.set('flowmic.history.cache', JSON.stringify([{ ...legacyServerRow(), channel: 'lan' }]));
    const store = new TS3(new RecordingTransport(), kv);
    const rows = store.entries();
    e3(rows).toHaveLength(1);
    // The exact call the template makes for every row — must not throw.
    e3(() => injectProvenanceTooltip(rows[0]!.status, rows[0]!.target)).not.toThrow();
  });

  i3('junk in the cache is dropped instead of poisoning the store', () => {
    const kv = new MemStore();
    kv.set(
      'flowmic.history.cache',
      JSON.stringify([null, 42, {}, { id: '' }, { ...legacyServerRow(), channel: 'lan' }]),
    );
    const store = new TS3(new RecordingTransport(), kv);
    e3(store.entries()).toHaveLength(1); // only the one addressable row survived
  });

  i3('a target naming neither window nor process is null, not a half-object', () => {
    const row = normalizeCachedRow({ ...legacyServerRow(), target: { injected_at: 'x' } }, 'lan');
    e3(row!.target).toBeNull();
  });
});
