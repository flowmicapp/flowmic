// The `pairing_code` ack's runtime narrowing — moved OUT of lib/bridge.ts on
// 2026-08-26, VERBATIM, when that file sat exactly on the 800-line cap.
//
// ── WHY THIS FAMILY AND NOT SOME OTHER 80 LINES ─────────────────────────────
// bridge.ts is the Tauri IPC adapter: its job is to carry calls across the
// boundary. This function does not touch the boundary at all — it is a pure
// `unknown -> PairingInfo` narrowing, and it belongs beside the type it
// produces (./pairing). Two things follow, and the second is the point:
//
//   · it can now be tested with NO Tauri mock. The tests that exercise it
//     (pairing-bridge / pairing-fingerprint-wire / pairing-pcid) had to mock
//     `@tauri-apps/api/core` purely to reach it through bridge.ts;
//   · a hand-written narrowing is exactly the thing this repo wants easy to
//     look at. RV-新A: `lan_candidates`'s filter asserted `c is string` while
//     testing `typeof c === 'object'`, so that array was EMPTY on every
//     machine — the multi-NIC picker (GA-21) never appeared once, and the
//     pairing-code countdown (GA-18) was a façade with 11 green tests. The
//     compiler does not check a type predicate; only a test on a real payload
//     does. Four more fields have been eaten the same way since (see the
//     「survives asPairingInfo」 assertions in the wire tests).
//
// 🔴 NOTHING ABOUT THE BEHAVIOUR CHANGED. This is a move, not a rewrite: the
// field list, the guards and the reasoning are byte-for-byte what stood in
// bridge.ts. Diff it against that file's history before believing otherwise.

import type { PairingInfo } from './pairing';

const EMPTY_PAIRING: PairingInfo = {
  short_code: null,
  endpoint: '',
  pc_name: '',
  connected: false,
  mobiles: 0,
};

/** Narrow a `pairing_code` ack to the PairingInfo contract.
 *
 *  owner 2026-07-27: `?? EMPTY_PAIRING` only covers a WHOLE missing snapshot. An
 *  ack that is an object but lacks `endpoint` (an older shell, a serde rename)
 *  sailed through the cast, and the device page then called `endpoint.trim()` on
 *  undefined — a render throw that blanks the page, the same defect the timeline
 *  had. Field-by-field narrowing is the only thing a runtime cast never gives. */
export function asPairingInfo(v: unknown): PairingInfo {
  if (v === null || typeof v !== 'object') return { ...EMPTY_PAIRING };
  const o = v as Record<string, unknown>;
  // owner 2026-07-30 ② "the LAN card must list all the IPs it's listening on" — and they were all being thrown
  // away right here. `lan_candidates` is `string[]` (Rust `Vec<String>`), but the
  // filter asserted `c is string` while TESTING `typeof c === 'object'`, so every
  // address failed it and the field arrived as `[]` on every machine. A type
  // predicate is an assertion the compiler does not check, which is exactly why the
  // façade rule says to grep the production reader: the GA-21 multi-NIC picker has
  // never once had a candidate to show.
  const candidates = Array.isArray(o.lan_candidates)
    ? o.lan_candidates.filter((c): c is string => typeof c === 'string' && c !== '')
    : undefined;
  return {
    ...EMPTY_PAIRING,
    short_code: typeof o.short_code === 'string' ? o.short_code : null,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : '',
    pc_name: typeof o.pc_name === 'string' ? o.pc_name : '',
    connected: o.connected === true,
    mobiles: typeof o.mobiles === 'number' && Number.isFinite(o.mobiles) ? o.mobiles : 0,
    ...(candidates !== undefined ? { lan_candidates: candidates } : {}),
    // Three more fields the Rust side has been sending and this narrowing DROPPED,
    // found while wiring the LAN card's address list (same class as the filter
    // above — a field absent from the literal is a field the caller can never see):
    //   · lan_endpoint — the LAN card's OWN address (v0.2.4). Without it the card
    //     falls back to the pairing endpoint, the very conflation 0.2.4 split apart.
    //   · expires_in_ms — GA-18's code TTL. PairingModal computes a deadline from it
    //     and has therefore always shown the static "valid within 5 minutes" (5 分钟内有效) line instead of the
    //     countdown lib/pair-countdown.ts implements and tests.
    //   · machine_uid — v0.2.4's cross-channel machine identity; ConnDiagPage has
    //     always printed "unreadable" (读不到) for it.
    ...(typeof o.lan_endpoint === 'string' ? { lan_endpoint: o.lan_endpoint } : {}),
    ...(typeof o.expires_in_ms === 'number' && Number.isFinite(o.expires_in_ms)
      ? { expires_in_ms: o.expires_in_ms }
      : {}),
    ...(typeof o.machine_uid === 'string' && o.machine_uid !== '' ? { machine_uid: o.machine_uid } : {}),
    // N5 — WHICH channel this snapshot describes. Narrowed to the two known tags
    // and otherwise left ABSENT rather than defaulted: a snapshot from a shell that
    // does not report it must not claim to be 'lan', or the modal's cross-channel
    // gate would compare against a value nobody sent.
    ...(o.channel === 'lan' || o.channel === 'cloud' ? { channel: o.channel } : {}),
    // D2LAN-B2b — the LAN TLS fingerprint the QR carries as `fp=`.
    //
    // 🔴 THIS LINE IS THE WHOLE REASON THE FIELD ARRIVES. Everything upstream of
    // it can be perfect — the server publishing `lan_tls_fp`, the Rust snapshot
    // serializing it — and a field missing from this literal is a field the caller
    // can never see (the exact defect the three fields above were added for, and
    // the `lan_candidates` filter before them). A wired chain with a hole here
    // fails EXACTLY like an unwired one: no `fp=`, no error, all tests green.
    //
    // Absent / empty / not-a-string ⇒ left ABSENT rather than defaulted, so the
    // payload builder's 「no fingerprint」 branch is reached and the QR keeps its
    // pre-D2-LAN bytes.
    ...(typeof o.lan_tls_fp === 'string' && o.lan_tls_fp !== '' ? { lan_tls_fp: o.lan_tls_fp } : {}),
    // owner 2026-08-30 — the relay NODE. SEVENTH field to be added to this
    // literal, for the reason the block above already states twice: a field
    // missing from HERE is a field the caller can never see, and a wired chain
    // with a hole here fails EXACTLY like an unwired one — no badge, no error,
    // every test green. Pinned by `pairing-node.test.ts`.
    ...(typeof o.node === 'string' && o.node !== '' ? { node: o.node } : {}),
    // 0.2.66 — the relay's PCID. SIXTH field to be added to this literal, and the
    // block above says why that keeps happening: everything upstream can be perfect
    // and a field missing from HERE is a field the caller can never see. The proof
    // that this line is load-bearing is `pairing-pcid.test.ts`, which feeds a
    // Rust-SHAPED object in (serde key names, not a hand-built PairingInfo) and
    // asserts the id comes out non-empty — "it compiled" proves nothing.
    //
    // Only "whether it's a non-empty string" is decided here. The nine-digit SHAPE is the wire
    // parser's call (`socket/wire.rs`, symbol `parse_pcid`), and re-deciding it in a
    // second place would be two answers to one question — the drift that outlives
    // whichever of the two someone remembers to change.
    ...(typeof o.pcid === 'string' && o.pcid !== '' ? { pcid: o.pcid } : {}),
  };
}
