// Part of timeline_sqlite.dart — the FINAL schema, `onCreate` only: the DDL for
// every table at its current shape.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────────
// Same reason and same precedent as timeline_sqlite_migrations.dart /
// ptt_wire_keepalive.dart / chat_transient_banner_timers.dart: card E-CL left
// timeline_sqlite.dart at 788/800 (`verify/lint/file-size.mjs` SRC_MAX=800), so
// the NEXT edit would cross the cap — this block is pre-split now rather than
// under the pressure of that edit. This family was chosen because it is the
// natural sibling of the migrations part already split out: that file holds the
// per-version STEPS, this one holds the FINAL create their stepwise sum must
// converge on (the parity property in timeline_migration_test.dart). It is fully
// self-contained — every member is private to this library and its only inputs
// are a `Database` and the table-name constants, all visible through the `part`.
//
// 🔴 DIFF DISCIPLINE: every line below is moved **character-for-character** from
// timeline_sqlite.dart. Top-level functions in a `part` keep their names, their
// privacy and their call sites (`_createSchema` in `onCreate`,
// `_createTimelineSchema` in the migrations part's `createTimelineSchemaV1ForTest`
// hook), so there is NO mechanical edit. **Any difference in the diff is a bug.**
//
// ⚠️ NOTHING WAS DELETED. The D13 rationale comments (why the create path has no
// `IF NOT EXISTS`, why each table's shape is what it is) travel with their
// functions — they are the evidence a split must not drop.

part of 'timeline_sqlite.dart';

/// The full FINAL schema — `onCreate` only. Upgrades never call this.
Future<void> _createSchema(Database d) async {
  await _createTimelineSchema(d);
  await _createOutboxSchema(d);
  await _createInstanceMachineMapSchema(d);
  await _createBlindStoreCloudStateSchema(d);
}

/// v6 (card E-CL) — the blind store's local ledger, FINAL shape. `onCreate` only.
///
/// 🔴 Same D13 rule as the two above: no `IF NOT EXISTS` here, so misuse as an
/// upgrade step fails loudly on the first install that already has the table.
///
/// SHAPE NOTE — real columns, no JSON payload, for the same reason the outbox
/// has them: every column is something the drain SELECTS or ORDERs by.
///   · `entry_id` is the PRIMARY KEY and is `TimelineEntry.id` verbatim — the
///     same string the wire uses as the blob id and as the AEAD aad. One
///     spelling, or the aad binding stops matching and every row goes
///     undecryptable;
///   · `state` is `pushed` | `pending_delete`. A row's ABSENCE is the third
///     state (「云端没有这一条，也不欠什么」 — "the cloud doesn't have this entry,
///     and nothing is owed either") and is deliberately not an enum value:
///     storing 「nothing」 as a row would make the table grow forever;
///   · `payload_hash` is NULL exactly when there is no content left to
///     fingerprint (i.e. on a pending delete), never as 「不知道」("don't know");
///   · `updated_at` orders the drain oldest-first, so a bounded batch makes
///     progress on the oldest debt instead of starving it.
Future<void> _createBlindStoreCloudStateSchema(Database d) async {
  await d.execute('''
    CREATE TABLE $kBlindStoreCloudStateTable (
      entry_id     TEXT PRIMARY KEY,
      state        TEXT NOT NULL,
      payload_hash TEXT,
      updated_at   INTEGER NOT NULL
    )
  ''');
  await d.execute(
    'CREATE INDEX idx_blindstore_state ON $kBlindStoreCloudStateTable '
    '(state, updated_at ASC)',
  );
}

/// The timeline table + its two indexes.
///
/// ⚠️ UNCHANGED SINCE v1 — which is why one function can serve both the final
/// create and the parity test's v1 rebuild ([createTimelineSchemaV1ForTest]).
/// The day this table changes, this function becomes final-shape-only, the v1
/// text gets frozen into the test hook, and a new version step carries the
/// delta (D13 rule 1).
Future<void> _createTimelineSchema(Database d) async {
  // `payload` is the row. The rest are projections of it — see the file header.
  await d.execute('''
    CREATE TABLE $kTimelineTable (
      id                    TEXT    PRIMARY KEY,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      client_id             TEXT    NOT NULL,
      mode                  TEXT    NOT NULL,
      status                TEXT    NOT NULL,
      entry_type            TEXT    NOT NULL,
      spoken_to_instance_id TEXT,
      deleted               INTEGER NOT NULL DEFAULT 0,
      search_text           TEXT    NOT NULL DEFAULT '',
      payload               TEXT    NOT NULL
    )
  ''');
  // The timeline is read newest-first, always.
  await d.execute(
    'CREATE INDEX idx_timeline_created ON $kTimelineTable (created_at DESC)',
  );
  // V2-06a-1 narrowed view: 「进到某个 PC 实例里，只显示与该实例相关的历史」("once
  // inside a given PC instance, only show history related to that instance").
  await d.execute(
    'CREATE INDEX idx_timeline_owner ON $kTimelineTable '
    '(spoken_to_instance_id, created_at DESC)',
  );
}

/// window B3-2a — the outbox table, FINAL shape. `onCreate` only.
///
/// 🔴 D13: this is deliberately NO LONGER the v1→v2 upgrade step, and no longer
/// `IF NOT EXISTS`. Doubling as both was the trap: `covered_entry_ids` /
/// `wire_entry_id` were later edited INTO this statement, which is a no-op for
/// every install whose table already existed — those installs stayed two
/// columns short and every enqueue INSERT failed on an unknown column. A column
/// added here now MUST come with a new `_upgradeVn` step and a version bump, or
/// the fresh-vs-stepwise parity test (timeline_migration_test.dart) goes red.
/// Dropping `IF NOT EXISTS` makes any future misuse as an upgrade step fail
/// loudly on the first existing install instead of silently doing nothing.
///
/// SHAPE NOTE, and why it differs from the timeline's one-JSON-payload design:
/// the timeline stores a `payload` blob because an additive field on
/// TimelineEntry must not need a schema change. This table is the opposite case
/// — every column is something the DRAIN queries or orders by, and a queue whose
/// selection criteria live inside a JSON string cannot be indexed or reasoned
/// about. So the columns are real columns.
Future<void> _createOutboxSchema(Database d) async {
  await d.execute('''
    CREATE TABLE $kOutboxTable (
      -- 🔴 Gate 1: minted at ENQUEUE and never re-minted. PRIMARY KEY means the
      -- table physically cannot hold two rows for one delivery, which is the
      -- structural half of 「重试沿用同一个 request_id」("a retry reuses the same
      -- request_id").
      request_id            TEXT    PRIMARY KEY,
      entry_id              TEXT    NOT NULL,
      -- Every row this ONE delivery settles, comma-joined. Separate from
      -- `entry_id` (the representative / correlation key): RV-15 is what
      -- happens when one value answers both questions.
      covered_entry_ids     TEXT    NOT NULL DEFAULT '',
      -- 🔴 「这一帧要不要盖 inject:request.entry_id」("whether this frame should
      -- stamp inject:request.entry_id") — NULL means OMIT THE FIELD.
      --
      -- It answers exactly one question: DID THIS DELIVERY BUILD THAT ROW ITSELF?
      -- Non-null for a typed ➤ / a direct-send utterance / a picture / a
      -- backfill delivery,
      -- all of which created the row they name. NULL for a ➤ over rows that
      -- already existed (a multi-utterance buffered send), because there is no
      -- single row this frame is about.
      --
      -- ⚠️ NOT a nullable copy of `entry_id`, and NOT mergeable with
      -- `covered_entry_ids`. Those are 「结算锚点」("settlement anchor") (which
      -- local rows this verdict
      -- settles); this is 「线上要不要盖那个键」("whether that key should be
      -- stamped on the wire"). window B3-2a collapsed the second
      -- into the first by stamping `entry_id` unconditionally, and the cost is
      -- stated in typed_send_row_test.dart: one id on a frame covering N rows
      -- makes the PC write that one row's truth over all N.
      wire_entry_id         TEXT,
      kind                  TEXT    NOT NULL,
      source                TEXT    NOT NULL,
      text                  TEXT    NOT NULL,
      mode                  TEXT    NOT NULL,
      -- 🔴 Gate 3: the SPEAKING instant, not the sending instant.
      created_at            INTEGER NOT NULL,
      enqueued_at           INTEGER NOT NULL,
      -- 🔴 Gate 2: the destination is a MACHINE. `enqueued_pc_id` is audit-only and
      -- is deliberately never read to address a frame — see outbox_destination.dart.
      dest_machine_uid      TEXT,
      dest_pairing_identity TEXT,
      enqueued_pc_id        TEXT,
      source_text           TEXT,
      entry_type            TEXT,
      thumb_b64             TEXT,
      image_path            TEXT,
      image_mime            TEXT,
      device_label          TEXT,
      -- v3: the row's engine-reported speaking duration (ms). NULL = the row
      -- never had one (typed/manual/image) — absence, never 0.
      duration_ms           INTEGER,
      -- queued | inflight | delivered | refused. NEVER TimelineEntry.status —
      -- 「队列拿它怎么办」("what the queue should do with it") and 「这一条的投递
      -- 真相」("this entry's delivery truth") are two questions.
      delivery_state        TEXT    NOT NULL,
      refused_code          TEXT,
      attempts              INTEGER NOT NULL DEFAULT 0,
      last_attempt_at       INTEGER,
      last_refusal_note     TEXT
    )
  ''');
  // The drain walks pending items oldest-first (owner: 全部都要投递 — "everything
  // must be delivered", in the order
  // they were said), so that is the index.
  await d.execute(
    'CREATE INDEX idx_outbox_pending ON $kOutboxTable '
    '(delivery_state, enqueued_at ASC)',
  );
}

/// v5 (card F2) — the learned instance→machine table, FINAL shape. `onCreate` only.
///
/// 🔴 Same D13 rule as [_createOutboxSchema]: no `IF NOT EXISTS` here, so any
/// future misuse of this function as an upgrade step fails loudly on the first
/// install that already has the table instead of silently doing nothing.
///
/// SHAPE NOTE — four real columns, no JSON payload, because every one of them is
/// something a reader asks about:
///   · `instance_id` is the PRIMARY KEY and is `MobileSession.connectionIdentity`
///     VERBATIM — the same string the timeline stores as `spoken_to_instance_id`
///     and the queue freezes as `dest_pairing_identity`. One spelling of an
///     instance across three tables, or the join silently returns nothing;
///   · `machine_uid` is `pc_machine_uid`, the value the ID-cross-wiring red
///     line already
///     addresses deliveries by. ⚠️ NOT NULL on purpose: 「问不到 uid」("could not
///     determine the uid") must be an
///     ABSENT ROW, never a row saying null, because a null here would group with
///     every other null (machine_group.dart rule ①);
///   · `learned_at` / `source` are forensics — they answer 「why does this phone
///     think those two pairings are one computer」 without guessing.
Future<void> _createInstanceMachineMapSchema(Database d) async {
  await d.execute('''
    CREATE TABLE $kInstanceMachineMapTable (
      instance_id  TEXT PRIMARY KEY,
      machine_uid  TEXT NOT NULL,
      learned_at   INTEGER NOT NULL,
      source       TEXT NOT NULL
    )
  ''');
}
