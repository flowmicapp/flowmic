// v0.2.4 — the connection state must be PULLABLE, not only pushable.
//
// owner 2026-07-29 (devices-page screenshot): "it's always like this" — both
// channel cards stuck at "connecting…", the footer at "not connected," for
// the whole session, while the forensic log two lines above said both sockets
// were open and registered and the paired-phone table (a direct invoke) was
// fully populated.
//
// The instrumented log gave the exact numbers:
//
//   02:07:05.968  [pump] CONNECTION → ui (lan   connected=true)
//   02:07:05.977  [pump] CONNECTION → ui (cloud connected=true)
//   02:07:07.026  fe.bridge#1 initBridge: wiring…          ← 1.1 s LATE
//
// The pump forwards only on CHANGE — correct and cheap, but it makes the frame a
// ONE-SHOT the UI has to already be listening for. Rust opens both sockets in
// ~2 s; a WebView boots in ~4 s. Rust wins every launch, nothing changed after
// that, and the page never heard another word. Not flaky — deterministic, which
// is exactly why the owner saw it EVERY time.
//
// The fix is a seed from `connection_snapshot`, applied through the same
// function the push uses. These tests pin that function's rules, because the
// two paths sharing one applier is what stops them drifting into two answers to
// one question — this repo's most expensive recurring bug shape.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyConnectionRows, conn, connByChannel, currentChannel, lanConnected, settings, timeline } from './store';
import type { ConnectionState } from '../lib/types';

function row(over: Partial<ConnectionState> = {}): ConnectionState {
  return {
    connected: true,
    registered: true,
    room_uuid: 'room-1',
    mobiles: 0,
    reason: 'snapshot',
    channel: 'lan',
    primary: true,
    ...over,
  } as ConnectionState;
}

beforeEach(() => {
  for (const k of Object.keys(connByChannel)) delete connByChannel[k];
  Object.assign(conn, {
    connected: false, registered: false, room_uuid: null, mobiles: 0, reason: 'init',
  });
});

describe('applyConnectionRows — the seed the race made necessary', () => {
  it('a snapshot taken AFTER the sockets came up still lights both cards', () => {
    // The whole point: this is the state the UI missed because it was not yet
    // listening. Nothing will change again, so if the seed does not apply it,
    // the page is wrong for the rest of the session.
    applyConnectionRows([
      row({ channel: 'lan', primary: false }),
      row({ channel: 'cloud', primary: true }),
    ]);
    expect(connByChannel.lan?.connected).toBe(true);
    expect(connByChannel.cloud?.connected).toBe(true);
  });

  it('the GLOBAL view follows the primary channel only', () => {
    // The sidebar dot / "This PC" card read `conn`. Letting a non-primary
    // channel write it is how the dot used to blink between two live sockets.
    applyConnectionRows([
      row({ channel: 'lan', primary: false, mobiles: 0, room_uuid: 'lan-room' }),
      row({ channel: 'cloud', primary: true, mobiles: 2, room_uuid: 'cloud-room' }),
    ]);
    expect(conn.mobiles).toBe(2);
    expect(conn.room_uuid).toBe('cloud-room');
  });

  it('a non-primary row NEVER overwrites the global view, whatever the order', () => {
    applyConnectionRows([row({ channel: 'cloud', primary: true, mobiles: 3 })]);
    applyConnectionRows([row({ channel: 'lan', primary: false, mobiles: 0 })]);
    expect(conn.mobiles).toBe(3);
    expect(connByChannel.lan?.mobiles).toBe(0);
  });

  it('an ABSENT `primary` is treated as primary (a one-socket shell)', () => {
    const legacy = row({ channel: 'lan', mobiles: 1 });
    delete (legacy as { primary?: boolean }).primary;
    applyConnectionRows([legacy]);
    expect(conn.mobiles).toBe(1);
  });

  it('an empty snapshot changes nothing — no resident channel is not "disconnected"', () => {
    // The honesty rule on the pull side: a channel with no session must not be
    // reported at all. Inventing a disconnected row would put a "not connected"
    // card on screen for a channel the user never configured.
    applyConnectionRows([row({ channel: 'cloud', primary: true })]);
    applyConnectionRows([]);
    expect(conn.connected).toBe(true);
    expect(Object.keys(connByChannel)).toEqual(['cloud']);
  });

  it('the seed and a later push are idempotent — the same row twice is one state', () => {
    // The seed is taken AFTER the listener is registered, so a frame can legally
    // arrive twice. That must be a no-op, not a flicker.
    const r = row({ channel: 'cloud', primary: true, mobiles: 1 });
    applyConnectionRows([r]);
    const first = { ...connByChannel.cloud! };
    applyConnectionRows([r]);
    expect({ ...connByChannel.cloud! }).toEqual(first);
    expect(conn.mobiles).toBe(1);
  });

  it('a row with an unknown channel still lands in its own slot', () => {
    // Defensive, not speculative: the tag comes from Rust's `Channel::tag()`,
    // and a future third channel must not silently overwrite `lan`.
    applyConnectionRows([row({ channel: 'relay-2' as ConnectionState['channel'] })]);
    expect(connByChannel['relay-2']?.connected).toBe(true);
    expect(connByChannel.lan).toBeUndefined();
  });
});

// RV-16 — the settings flush trigger used to be the PRIMARY channel's connected
// rising edge, while both settings verbs are pinned to the LAN socket in Rust
// (shell/mod.rs `settings_update` / `settings_list` → `with_lan_socket`, "owner ⑤:
// settings target the LAN server only"). With preference=cloud the LAN could come
// back and nothing flushed, so a "saved locally" edit waited for a cloud reconnect
// or a restart. The reverse assertion below (a cloud edge must NOT flush) is the
// real judge of the fix: watching the wrong channel also "works" on a LAN-primary PC.
describe('RV-16 settings flush edge follows the LAN channel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a LAN rising edge flushes the queue even though CLOUD is primary', () => {
    const flush = vi.spyOn(settings, 'flushPending').mockResolvedValue(undefined);
    applyConnectionRows([
      row({ channel: 'cloud', primary: true, connected: true }),
      row({ channel: 'lan', primary: false, connected: true }),
    ]);
    expect(lanConnected.value).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('a CLOUD-only rising edge does NOT flush — that socket cannot carry settings', () => {
    const flush = vi.spyOn(settings, 'flushPending').mockResolvedValue(undefined);
    applyConnectionRows([row({ channel: 'cloud', primary: true, connected: true })]);
    expect(lanConnected.value).toBe(false);
    expect(flush).not.toHaveBeenCalled();
  });

  it('only the EDGE flushes: a repeated connected LAN row is not a second replay', () => {
    const flush = vi.spyOn(settings, 'flushPending').mockResolvedValue(undefined);
    const lan = row({ channel: 'lan', primary: true, connected: true });
    applyConnectionRows([lan]);
    applyConnectionRows([lan]);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('a LAN drop and return flushes again (the queue may have grown while it was down)', () => {
    const flush = vi.spyOn(settings, 'flushPending').mockResolvedValue(undefined);
    applyConnectionRows([row({ channel: 'lan', primary: true, connected: true })]);
    applyConnectionRows([row({ channel: 'lan', primary: true, connected: false })]);
    applyConnectionRows([row({ channel: 'lan', primary: true, connected: true })]);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('the LAN seed alone is enough — the boot race means no push may ever arrive', () => {
    // Same defect this file is named after: Rust had the LAN socket up before the
    // WebView booted, so if only the push path flushed, nothing ever would.
    const flush = vi.spyOn(settings, 'flushPending').mockResolvedValue(undefined);
    applyConnectionRows([row({ channel: 'lan', primary: false, connected: true })]);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

// This applier is where the two stores learn a channel is back. 0.2.27 leaves only ONE
// of them with anything to do about it:
//   · SETTINGS — the durable queue is real and is really re-flushed (RV-01 ⑤ was the
//     anti-façade finding: a store method with no production caller, so "saved locally"
//     had been promising a retry no code performed);
//   · TIMELINE — nothing. Its uplink and its pull are gone with the server's transcript
//     store, so there is no queue to replay and no list to fetch. The specs below assert
//     that as an ABSENCE, because restoring it "by symmetry" with settings is the exact
//     mistake that would put a red "the server never confirmed" line back on every edit.
//
// owner 2026-07-30 ①: applying a primary row must NOT touch the row set at all (the old
// `setChannel` cleared the cache on every flip).
describe('a connection edge drives the settings queue only, and redirects nothing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a primary flip does NOT clear or re-scope the timeline', () => {
    // The defect this replaces: `setChannel(tag)` dropped every cached row that did
    // not belong to the new primary, so a phone joining on the relay blanked rows
    // this PC really had received over the sidecar (and vice versa).
    const before = timeline.entries().length;
    applyConnectionRows([
      row({ channel: 'lan', primary: false, connected: true }),
      row({ channel: 'cloud', primary: true, connected: true }),
    ]);
    expect(timeline.entries().length).toBe(before);
  });

  it('an unknown channel keeps its own slot and steers nothing', () => {
    // `connByChannel` keeps the raw tag (test above); nothing else may act on it.
    applyConnectionRows([row({ channel: 'relay-2' as ConnectionState['channel'] })]);
    expect(connByChannel['relay-2']?.connected).toBe(true);
  });

  it('a connected edge touches the timeline in NO way at all (0.2.27)', () => {
    // What used to be here: "each channel's connected rising edge replays ITS OWN
    // queued ops" (`timeline.flushQueue`) and a per-channel `timeline.refresh`. Both are
    // retired with the uplink and the pull — the server stores no transcripts (owner's
    // architecture ruling), so there is nothing to replay to and nothing to pull.
    // Asserted as an ABSENCE on purpose: restoring either watcher "by symmetry" with
    // the settings queue below is the mistake this spec exists to catch, and it would
    // come back as a red "the server never confirmed" line on every edit.
    const rows = timeline.entries().length;
    applyConnectionRows([row({ channel: 'lan', primary: true, connected: true })]);
    applyConnectionRows([row({ channel: 'cloud', primary: false, connected: true })]);
    expect(timeline.entries().length).toBe(rows);
    // The store has no such verbs left to call — the surface itself is the guard.
    expect('flushQueue' in timeline).toBe(false);
    expect('refresh' in timeline).toBe(false);
    // …while the SETTINGS queue still flushes on the LAN edge (RV-16), because settings
    // really do live on the server. One retirement must not take the other with it.
    expect(connByChannel.cloud?.connected).toBe(true);
  });

  // ── RV-新B: "which channel is current" has ONE answer, and it comes from here ──────────

  it('currentChannel is the PRIMARY row’s own tag, and a presence row cannot move it', () => {
    // The four surfaces that used to read the dead `cloud.channel` preference — the
    // footer dot, the diagnostics "current channel" row, the settings account line
    // and the pairing modal's default tab — all read this. A pure-cloud user's
    // answer has to be 'cloud'.
    // No frame yet ⇒ the process default, the same answer Rust gives with no evidence.
    expect(currentChannel.value).toBe('lan');
    applyConnectionRows([
      row({ channel: 'lan', primary: false }),
      row({ channel: 'cloud', primary: true }),
    ]);
    expect(currentChannel.value).toBe('cloud');
    // THE REVERSE ASSERTION: the non-primary channel's frame arrives later (both pumps
    // push) and must NOT drag the answer back — that would put "local LAN" on screen
    // while the relay carries the phone, which is the old defect with a new source.
    applyConnectionRows([row({ channel: 'lan', primary: false, connected: true })]);
    expect(currentChannel.value).toBe('cloud');
    // …and it follows the primary flip back, because it is derived rather than latched.
    applyConnectionRows([row({ channel: 'lan', primary: true })]);
    expect(currentChannel.value).toBe('lan');
  });

  it('an unknown channel tag never becomes the current channel', () => {
    applyConnectionRows([row({ channel: 'relay-2' as ConnectionState['channel'], primary: true })]);
    // `connByChannel` keeps the raw tag for the record; the CURRENT channel must be one
    // of the two the rest of the app can address, so it falls back to the default.
    expect(connByChannel['relay-2']?.connected).toBe(true);
    expect(currentChannel.value).toBe('lan');
  });

  it('only the EDGE replays the SETTINGS queue, and a drop-and-return replays again', () => {
    // RV-16, moved onto the queue that still exists. `flush: 'sync'` + the watcher's own
    // previous value is what makes this an EDGE rather than a level: a settings write
    // held "saved locally" must be retried once when the LAN socket returns, not on
    // every frame it sends afterwards.
    const flush = vi.spyOn(settings, 'flushPending').mockResolvedValue(undefined);
    const lan = (connected: boolean): ConnectionState => row({ channel: 'lan', primary: true, connected });
    applyConnectionRows([lan(true)]);
    applyConnectionRows([lan(true)]);
    expect(flush).toHaveBeenCalledTimes(1);
    applyConnectionRows([lan(false)]);
    applyConnectionRows([lan(true)]);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
