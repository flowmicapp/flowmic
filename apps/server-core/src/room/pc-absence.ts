// SPEC-REF:
//   docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §7.3 (owner ruling ⑧,
//     2026-08-04: GET /api/pc/presence gains the optional `pc_absent_reason`)
//   docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §4.2/§4.3 (the zombie-room
//     hole — "no layer holds the fact that 'this account has expired'")
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// 「WHY is that PC not here」 — the one fact no layer used to hold.
//
// Presence itself answers 「is the PC in its room」 and nothing else, which is
// correct and stays correct: `store.getPc(room_uuid) !== null`. What the relay
// never recorded is the REASON a PC left, so a desktop whose cloud login died
// was reported exactly like a desktop someone switched off. That is the second
// half of the incident in §4.3: the gate now keeps the zombie out of the room,
// and this table is what lets the phone say WHY the room is empty instead of
// inventing "offline" for both cases.
//
// ── WHAT MAY BE STORED ──────────────────────────────────────────────────────
// A CLOSED set of reasons (PC_ABSENT_REASONS), never free text: the value
// crosses the wire and the phone maps it to one sentence per language. Today
// the set has exactly ONE member, and both write sites write that one. There is
// deliberately no 'unknown' member — an absent entry IS 「we do not know」, and
// an enum value with no writer is this repo's #1 historical defect (a capability
// defined and never called).
//
// ── HOW A PC IS ADDRESSED, AND WHY IT TAKES TWO FORMS ───────────────────────
// Both write sites hold a DIFFERENT identity of the same machine, because of
// what each of them is:
//   ① the auth:expired watchdog fires on a socket that is IN the room, so it
//      holds `roomUuid` — the very key presence is keyed by;
//   ② the pc:reconnect account gate refuses to JOIN before any row is used for
//      room state (a connection about to be refused must not setOnline / enter
//      the room). IT-13 adds one read-only findPcByToken on that path so the
//      absence table can refuse unresolved tokens; the identity filed is still
//      the device token that was handed.
// So an entry is filed under whichever identity its writer legitimately has,
// and the reader — which holds the whole `pc` row, hence BOTH — tries both keys
// and takes the newer hit. The token is stored only as a sha256 digest: this
// table has no business holding a bearer secret in the clear (05 §7).
//
// ⚠️ Filing by token digest is not a lesser gate than filing by room. To reach
// write site ② at all a caller must already present that PC's device token —
// and a device token alone (with no account jwt) is enough to re-enter the room
// AS that PC. Anyone able to poison an entry here can already impersonate the
// machine outright, so this adds no reachable capability.
//
// 🔴 CORRECTION / MISSING HALF (IT-06 → owned by IT-13, 2026-08-05) — the
// paragraph above argues only about FORGING / poisoning a specific entry
// (writing a reason under a key the attacker already controls as that PC).
// It does NOT cover EVICTION: `PcAbsenceReasons.put` drops the oldest live
// key once `PC_ABSENCE_MAX_ENTRIES` (512) is exceeded, and write site ②
// (`pcAbsenceReasons.noteByDeviceToken` in
// `apps/server-core/src/socket/handlers/pc.handler.ts` on the
// `AUTH_TOKEN_EXPIRED` refusal of `pc:reconnect`) hashed whatever token string
// the payload carried — it did not require that string to resolve to a real
// `pc_devices` row. A caller that could reach that refusal path could therefore
// flood the table with random digests and squeeze real entries out. The
// forge-implies-impersonation argument never established that this squeeze-out
// is unreachable.
//
// ✅ IT-13 CLOSED (2026-08-05) — chose (b) grade-by-resolve over (a) rate-limit:
// write site ② only calls `noteByDeviceToken` after `registry.findPcByToken`
// hits a real row; `noteByDeviceToken(..., resolved)` itself no-ops when
// `resolved !== true`, so a future call site that forgets the check cannot
// re-open the flood. Rate-limiting the refusal path was rejected as the
// primary defence because the house-style IP tables fail OPEN on eviction
// (IT-08: forgetting a spent budget grants a fresh one) — applying that
// shape here would mean 「table full / budget spent ⇒ skip the note」, which
// is exactly the failure that makes a genuine expired desktop invisible on
// the devices page. A read-only `findByToken` on a refusal is the cost this
// path pays; it is not the hot diag-upload path that refuses DB work, and it
// does not mutate room state (the original 「must not touch the database」
// line meant must not join / setOnline on a connection about to be refused —
// not that a point lookup is forbidden).
//
// Fail-safe direction (the thing to get right): when the new gate bites,
// an UNRESOLVED token is what is dropped — never a resolved one. A genuine
// desktop reconnecting with a legitimately expired account JWT still holds a
// real device token ⇒ still resolves ⇒ still records. The design fails toward
// 「random noise never occupies a slot」; the opposite failure (silencing a
// real PC's reason so the phone falls back to bare 「not here」) would be a
// worse product than the flood it prevents. Unresolved entries were always
// unreachable to every reader anyway (presence keys off the row's token), so
// refusing to store them deletes no truthful answer.
//
// ── WHY ENTRIES MUST BE ERASED, NOT JUST EXPIRED ────────────────────────────
// A reason must never outlive the fact it describes. If a desktop logs in again
// and later shuts down normally, presence must go back to plain 「not here」 —
// otherwise the table would turn 「the owner switched it off」 into 「its login
// expired」, which is the exact class of defect (a stale value answering a
// question it no longer knows) the book-18 §7.3 contract forbids. Hence
// `clearFor` on every SUCCESSFUL room entry (pc:register / pc:reconnect), which
// is also why the ordinary offline path in bootstrap.ts needs no hook at all:
// nothing recorded ⇒ nothing answered ⇒ byte-identical to today's response.
//
// ── BOUNDED, IN MEMORY ──────────────────────────────────────────────────────
// Two independent bounds, because either one alone leaks: a TTL alone cannot
// stop a burst inside the window, and a cap alone would keep a dead PC's reason
// forever. Entries are pruned lazily (no timer, so tests run on a fake clock and
// nothing holds the process open). In memory only, like the room map itself
// (§4.1): a restart drops every room, so a reason that survived one would be
// describing a room that no longer exists.

import { createHash } from 'node:crypto';

/** The closed set. One member today; both write sites write this one. Adding a
 *  member is a contract change — book 18 §7.3.1 is the table it must match. */
export const PC_ABSENT_REASONS = ['auth_expired'] as const;
export type PcAbsentReason = (typeof PC_ABSENT_REASONS)[number];

/** Cap on live entries. A relay holds one per ABSENT-for-a-reason PC, so this is
 *  already far above any real deployment; it exists so a pathological reconnect
 *  storm cannot grow the map without end. */
export const PC_ABSENCE_MAX_ENTRIES = 512;

/** How long a reason stays answerable. Long enough that 「I looked at my phone
 *  the next morning」 still gets the truthful sentence; short enough that a fact
 *  nobody refreshed does not live forever. Every refusal re-stamps it. */
export const PC_ABSENCE_TTL_MS = 24 * 60 * 60 * 1000;

/** The reader's identity for one PC: the pc_devices row carries both keys, so a
 *  caller that resolved a row can address an entry filed under either form.
 *  Typed as a slice of PcRecord rather than importing it — this module must not
 *  depend on the db layer to hold two strings. */
export interface PcAbsenceSubject {
  room_uuid: string;
  device_token: string;
}

interface Entry {
  reason: PcAbsentReason;
  /** ms-since-epoch of the write, for both TTL and newest-wins resolution. */
  at: number;
}

const roomKey = (roomUuid: string): string => `room:${roomUuid}`;
const tokenKey = (deviceToken: string): string =>
  `tok:${createHash('sha256').update(deviceToken).digest('hex')}`;

export class PcAbsenceReasons {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = PC_ABSENCE_MAX_ENTRIES,
    private readonly ttlMs: number = PC_ABSENCE_TTL_MS,
  ) {}

  /** Write site ① — the auth:expired watchdog, which holds the room it is about
   *  to empty. */
  noteByRoom(roomUuid: string, reason: PcAbsentReason): void {
    this.put(roomKey(roomUuid), reason);
  }

  /** Write site ② — the pc:reconnect account gate, whose only identity for the
   *  machine it just refused is the device token that was presented.
   *
   *  IT-13: `resolved` MUST be true only when that token hashes to a live
   *  `pc_devices` row (handler uses `registry.findPcByToken`). An unresolved
   *  presentation is a no-op — it answers no reader and used to be the flood
   *  vector that squeezed real entries out of the 512-slot cap. */
  noteByDeviceToken(deviceToken: string, reason: PcAbsentReason, resolved: boolean): void {
    if (resolved !== true) return;
    this.put(tokenKey(deviceToken), reason);
  }

  /** The reason this PC is absent, or null when none was recorded (= 「unknown」,
   *  which is why the field is simply omitted upstream). Reads BOTH addressing
   *  forms and answers with the newer one; prunes whatever it finds expired. */
  reasonFor(pc: PcAbsenceSubject): PcAbsentReason | null {
    const hits = [this.live(roomKey(pc.room_uuid)), this.live(tokenKey(pc.device_token))]
      .flatMap((entry) => (entry === null ? [] : [entry]));
    if (hits.length === 0) return null;
    // Newest wins. Unobservable while the closed set has one member — it is here
    // so that the day a second reason exists, two entries filed at different
    // moments cannot make the answer depend on lookup order.
    return hits.reduce((newest, hit) => (hit.at > newest.at ? hit : newest)).reason;
  }

  /** Forget both forms for this PC. Called the moment it is BACK in its room —
   *  see the header: a reason that outlives its fact is a lie with a timestamp.
   *
   *  IT-13 orphan-key (recorded, not "fixed" with a worse coupling): on
   *  pc:register the registry rotates `device_token`, so the `pc` handed to
   *  this method carries the NEW token. The room key is stable and is cleared;
   *  the OLD token's digest is left until TTL. It produces no wrong answer
   *  (presence reads the row's current token) — it only burns one slot. Clearing
   *  it would require `registerPc` to return the previous token, which couples
   *  this table into the registry's return shape for slot hygiene alone. A
   *  silent skip of that cost would be the forbidden third option; naming it
   *  here is the acceptable one. */
  clearFor(pc: PcAbsenceSubject): void {
    this.entries.delete(roomKey(pc.room_uuid));
    this.entries.delete(tokenKey(pc.device_token));
  }

  /** Test-only drain of the module singleton between cases. Production has no
   *  caller (grep `drainForTests`) — the table's real erase path is clearFor. */
  drainForTests(): void {
    this.entries.clear();
  }

  /** Live entry count. Tests + the boundedness assertion; expired-but-unpruned
   *  entries are included, so this is the map size, not a claim about who is
   *  absent (same wording as ReleaseSuppression.size, same reason). */
  get size(): number {
    return this.entries.size;
  }

  private live(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  private put(key: string, reason: PcAbsentReason): void {
    // delete-then-set so a re-stamped entry moves to the END of the insertion
    // order: the eviction below drops the OLDEST write, and a Map.set on an
    // existing key would have kept its original position.
    this.entries.delete(key);
    this.prune();
    this.entries.set(key, { reason, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  private prune(): void {
    const deadline = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at <= deadline) this.entries.delete(key);
    }
  }
}

/** The ONE table this server answers from.
 *
 *  A module-level instance, stated plainly because the alternative is the house
 *  style: the three call sites have no shared owner to be constructed from. The
 *  watchdog is armed by bootstrap with `(socket, exp, clock)` only, the
 *  pc:reconnect gate runs before any dependency of its own is consulted, and the
 *  route is built by the http router — wiring one instance through all three
 *  would touch three files this change has no other reason to open.
 *
 *  What makes it safe: every key is globally unique (a room uuid, or the digest
 *  of a 256-bit device token), so two servers sharing a process — which only
 *  happens in tests — cannot read each other's entries, only each other's
 *  memory. If a per-server instance is ever needed, `new PcAbsenceReasons()` is
 *  the whole migration and this constant becomes bootstrap's field. */
export const pcAbsenceReasons = new PcAbsenceReasons();
