// SPEC-REF:
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md
//     §9-1 / §11 追认 item 1 (the third-party host pays, whoever is speaking)
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §2 (「加每 key /
//     每宿主 origin 的硬上限（控制台可设，缺省＝档位全量）」), §5 (failure
//     directions), §10-6 (order: the integrator room is decided BEFORE the
//     speaker's account)
//   ./schema.ts (INIT_SQL — the world a FRESH database is created in;
//     INTEGRATOR_SQL is interpolated there unconditionally, in one exec)
//   ./repos/integrator-key.repo.ts (the only reader/writer)
//   ../billing/integrator-quota.ts (the policy over these rows)
//   *** HUMAN-AUDIT SENSITIVE (schema + billing) ***
//
// Card MP-1's DDL. Split into its own module for the reason schema-trial.ts and
// schema-recovery.ts were: db/schema.ts stands at 799 of the 800-line `file-size`
// cap and two tables plus their argument do not fit in what is left.
//
// 🔴 SAME TEMPLATE-LITERAL TRAP AS schema.ts: this is ONE template literal, so a
// backtick anywhere inside it — even inside a `--` SQL comment — terminates it
// early and breaks the whole server-core build, with the error surfacing at some
// later line so it reads as a broken toolchain. Quote identifiers with 「」.
//
// ── 🔴 TWO NEW TABLES, AND ZERO NEW COLUMNS ON 「pc_devices」, ON PURPOSE ────
//
// The obvious shape for 「which key minted this room」 is a column on
// 「pc_devices」. It was measured and rejected, twice over:
//
//   · node/replica-puller.ts applies the writer's snapshot with
//     「INSERT INTO main.t SELECT * FROM snap.t」, which maps BY POSITION and by
//     COLUMN COUNT. A new column on an existing table makes that statement throw
//     during a mixed-version window, and because the whole pull is ONE
//     transaction it rolls back EVERY table — one column stops replication of
//     the entire database until both nodes match. A NEW TABLE costs nothing
//     there: it is skipped with a warning by an older replica and is simply
//     absent from an older writer's snapshot.
//     > 🔴 IN-PLACE CORRECTION (2026-09-14, card D5/NR-22): this bullet was the
//     > measurement it claims to be, and it no longer holds. The puller projects
//     > by column NAME now (grep 「NR-22-PROJECT-BY-NAME」), so a writer-ahead
//     > column is dropped with one WARN instead of stalling every table. THE
//     > DECISION IS UNCHANGED — it never rested on this bullet alone, and the
//     > second one below is untouched.
//   · node/token-rows.ts 「parsePc」 returns null when ANY expected key is
//     missing from a replicated row. A new required field would make a NEW
//     replica drop EVERY 「pc_devices」 row an OLD writer sends — a total outage
//     produced by an additive migration.
//
// So the room→key edge lives in 「integrator_rooms」, keyed by the room row it
// describes. 「integrator_user_id」 needs no column at all for the same family of
// reasons: 「pc_devices.user_id」 IS the integrator T (this module's mint site
// inserts the room under T's account), so a second column could only ever drift
// from it. That is also why 「room_kind」 is not duplicated here — it stays the
// one answer 「roomKindOf」 reads.
//
// ── WHY THE SUB-QUOTA'S COUNTER LIVES ON THE KEY ROW ──────────────────────
//
// 「how many of T's minutes has THIS key spent this cycle」 cannot be answered
// from 「usage_records」 (that table is per ACCOUNT, and T's own recordings share
// it) nor from 「usage_events」 (that log is behind FLOWMIC_USAGE_EVENTS_ENABLED,
// which is OFF on the relay — a ceiling read from a switched-off log would be a
// wall with nothing behind it, product red line R11). So the counter is a column
// here, with exactly ONE writer: billing/usage-tracker.ts, inside the same
// 「meterOnce」 effect that moves the bill, so a re-sent operation cannot spend
// the sub-quota twice while being charged once.
//
// 🔴 「used_period」 IS WHAT MAKES IT A CYCLE COUNTER RATHER THAN A LIFETIME ONE,
// and it stores the SAME string 「usage_records.month」 does (BillingService
// usagePeriodKey — the account's own anniversary bucket, owner 2026-09-05 乙).
// A counter that reset on some other boundary would let a key be exhausted while
// T's plan had rolled over, or the reverse; one author for 「which cycle is this」
// is the only way the two ceilings can be compared with 「Math.min」 at all.

export const INTEGRATOR_SQL = /* sql */ `
-- ── 21. integrator_keys (card MP-1, 2026-09-11 — publishable keys) ──────────
--
-- ONE ROW PER PUBLISHABLE KEY an integrator T holds. A key is what turns
-- 「POST /api/web/rooms {auth:{kind:'publishable_key'}}」 into a room T pays for.
CREATE TABLE IF NOT EXISTS integrator_keys (
  id               TEXT PRIMARY KEY,
  -- T. Also the room owner every key of this row ever mints, so
  -- 「resolvePayer」 step 「host」 reads pc_devices.user_id and never this column
  -- (one fact, one place). CASCADE like every per-account table: a key
  -- outliving its account would keep minting rooms billed to nobody.
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 🔴 THE 「fmpk_」 STRING ITSELF, IN CLEAR, AND THAT IS NOT AN OVERSIGHT.
  -- PUBLISHABLE means published: card MP-2 puts this value in a host page's
  -- own JavaScript, where every visitor can read it. Hashing it would buy
  -- nothing (the plaintext is on the page) and would cost the ONE thing this
  -- column is for — an integrator reading their key back out of the console
  -- after they lost it. The security boundary is 「origins」 below plus the
  -- sub-quota, NOT secrecy; see billing/integrator-quota.ts for the residual
  -- that follows from that and why the sub-quota is the answer to it.
  publishable_key  TEXT NOT NULL UNIQUE,
  -- A JSON array of exact 「scheme://host[:port]」 origins this key may build
  -- rooms from, compared verbatim against the request's 「Origin」 header.
  -- 🔴 A JSON ARRAY IN ONE COLUMN RATHER THAN A CHILD TABLE, deliberately: the
  -- list is only ever read WHOLE (one membership test per request) and only
  -- ever written WHOLE (the console replaces it), so a child table would add a
  -- join and a second place for 「what does this key allow」 to be true.
  -- 🔴 AN EMPTY ARRAY IS A KEY THAT CAN BUILD NOTHING, never 「allow all」. The
  -- route refuses on a non-match, and an empty list matches nothing — the
  -- failure direction that costs a working key rather than T's minutes.
  origins          TEXT NOT NULL,
  -- The per-key ceiling, in whole minutes of transcription per T's own billing
  -- cycle. 🔴 NULL MEANS 「THIS KEY ADDS NO CEILING OF ITS OWN」, which is
  -- exactly the design's default of 「= T's plan allowance」: the admission takes
  -- 「Math.min(T's remaining, this key's remaining)」 and the minimum with an
  -- absent ceiling IS T's remaining. Storing T's plan minutes here instead
  -- would be a COPY of a number the plan table owns, and it would go stale the
  -- day T upgrades.
  quota_minutes    INTEGER,
  -- Milliseconds this key has spent inside 「used_period」. Written by exactly
  -- one place (billing/usage-tracker.ts) — see this file's header.
  used_ms          INTEGER NOT NULL DEFAULT 0,
  -- WHICH cycle 「used_ms」 belongs to — the same string usage_records.month
  -- holds (BillingService.usagePeriodKey). A row whose 「used_period」 is not the
  -- current one reads as zero used, which is how the counter rolls over without
  -- a sweep. NULL = never spent anything.
  used_period      TEXT,
  -- What the integrator calls this key -- AND, since card MP-13, the name the
  -- room it mints carries: see room/integrator-room.ts integratorRoomName. Never
  -- parsed; REQUIRED on create since MP-13 (older rows may be NULL or empty).
  label            TEXT,
  -- ms since epoch (never TEXT — the +08:00 lesson in billing.repo.ts). NULL =
  -- live. 🔴 REVOCATION IS A STAMP, NOT A DELETE: a deleted row would take
  -- 「which key spent these minutes」 out of the usage log's reach, and the
  -- question an integrator asks after revoking a key is precisely what it did.
  revoked_at       INTEGER,
  created_at       INTEGER NOT NULL
);
-- 「this account's keys, newest last」 — the console list read, and the only one.
CREATE INDEX IF NOT EXISTS idx_integrator_keys_user ON integrator_keys(user_id, id);

-- ── 22. integrator_rooms (card MP-1 — which key minted which room) ──────────
--
-- ONE ROW PER INTEGRATOR ROOM. Keyed by the 「pc_devices」 row it describes, so
-- the cascade takes it when the room goes and nothing has to remember to.
CREATE TABLE IF NOT EXISTS integrator_rooms (
  pc_device_id  TEXT PRIMARY KEY REFERENCES pc_devices(id) ON DELETE CASCADE,
  -- CASCADE as well: deleting a key is not something the console does (see
  -- 「revoked_at」 above), but an ACCOUNT deletion reaches this row through both
  -- of its parents and neither path may leave an orphan naming the other.
  key_id        TEXT NOT NULL REFERENCES integrator_keys(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL
);
-- 「every room this key minted」 — what a revocation sweep and an operator's
-- 「which pages is this key live on」 question both walk.
CREATE INDEX IF NOT EXISTS idx_integrator_rooms_key ON integrator_rooms(key_id);
`;
