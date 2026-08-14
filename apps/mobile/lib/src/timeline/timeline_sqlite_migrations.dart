// Part of timeline_sqlite.dart — the frozen per-version migration steps and the
// test hooks that rebuild historical databases.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────────
// Same reason as ptt_wire_keepalive.dart / chat_transient_banner_timers.dart:
// card F2's v5 step pushed timeline_sqlite.dart over the 800-line cap
// (`verify/lint/file-size.mjs` SRC_MAX=800). This family was chosen because it
// is the one fully self-contained block left — the D13 section header already
// draws the line, every member is private to this library, and nothing outside
// calls any of them.
//
// 🔴 DIFF DISCIPLINE: every line below is moved **character-for-character** from
// timeline_sqlite.dart. There is NO mechanical edit this time (top-level
// functions in a `part` keep their names, their privacy and their call sites).
// **Any difference in the diff is a bug.**
//
// ⚠️ NOTHING WAS DELETED. The D13 rationale comments travel with their steps —
// they are the evidence for why a shipped step is frozen, and a split that
// dropped them would cost exactly what the split was supposed to protect.

part of 'timeline_sqlite.dart';

// ── D13 — the FROZEN per-version upgrade steps ───────────────────────────────
//
// Each function below is the schema delta AS THAT VERSION SHIPPED IT and is
// never edited again. The stepwise sum v1 → [kTimelineDbVersion] must equal
// [_createSchema]'s final shape — proven by timeline_migration_test.dart
// comparing PRAGMA table_info of both paths, so drift is a red test, not a
// field incident.

/// v1 → v2 (window B3-2a): the outbox table as v2 shipped — WITHOUT
/// `covered_entry_ids` / `wire_entry_id` (B3-2b, healed by v4) and WITHOUT
/// `duration_ms` (v3). Column comments live on the final create above; this is
/// deliberately bare DDL, frozen.
Future<void> _upgradeV2CreateOutboxAsShipped(Database d) async {
  await d.execute('''
    CREATE TABLE $kOutboxTable (
      request_id            TEXT    PRIMARY KEY,
      entry_id              TEXT    NOT NULL,
      kind                  TEXT    NOT NULL,
      source                TEXT    NOT NULL,
      text                  TEXT    NOT NULL,
      mode                  TEXT    NOT NULL,
      created_at            INTEGER NOT NULL,
      enqueued_at           INTEGER NOT NULL,
      dest_machine_uid      TEXT,
      dest_pairing_identity TEXT,
      enqueued_pc_id        TEXT,
      source_text           TEXT,
      entry_type            TEXT,
      thumb_b64             TEXT,
      image_path            TEXT,
      image_mime            TEXT,
      device_label          TEXT,
      delivery_state        TEXT    NOT NULL,
      refused_code          TEXT,
      attempts              INTEGER NOT NULL DEFAULT 0,
      last_attempt_at       INTEGER,
      last_refusal_note     TEXT
    )
  ''');
  await d.execute(
    'CREATE INDEX idx_outbox_pending ON $kOutboxTable '
    '(delivery_state, enqueued_at ASC)',
  );
}

/// v2 → v3 (0.2.43) — see [kTimelineDbVersion]. Idempotent by inspection, not
/// by luck: SQLite has no `ADD COLUMN IF NOT EXISTS`, so presence is checked
/// first — installs whose table came from a create that already carried the
/// column no-op here.
Future<void> _upgradeV3AddOutboxDuration(Database d) async {
  if (await _outboxHasColumn(d, 'duration_ms')) return;
  await d.execute('ALTER TABLE $kOutboxTable ADD COLUMN duration_ms INTEGER');
}

/// v3 → v4 (0.3.0 D13) — heal the in-place-edit trap: add the two columns
/// window B3-2b edited into the create statement without a version bump. Guarded
/// PER COLUMN: most installs got them via the edited create and no-op here;
/// the trapped ones (table born before the edit, version already ≥2) finally
/// converge. Defaults match the final create exactly — the parity test checks
/// `dflt_value` per column, not just presence.
Future<void> _upgradeV4AddOutboxWireEntryColumns(Database d) async {
  if (!await _outboxHasColumn(d, 'covered_entry_ids')) {
    await d.execute(
      "ALTER TABLE $kOutboxTable ADD COLUMN covered_entry_ids TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!await _outboxHasColumn(d, 'wire_entry_id')) {
    await d.execute('ALTER TABLE $kOutboxTable ADD COLUMN wire_entry_id TEXT');
  }
}

/// v4 → v5 (0.3.0 card F2) — the learned instance→machine table, AS v5 SHIPS IT.
///
/// 🔴 `IF NOT EXISTS` here and NOT on the create path, and the asymmetry is the
/// whole point of D13's two rules pulling in opposite directions:
///   · the CREATE must fail loudly if the table is already there, because that
///     means someone is using it as an upgrade step (the B3-2b trap);
///   · this STEP must no-op if the table is already there, because it really can
///     run against an install that already has it — D13 ① documents that an
///     older APK opening a newer file used to stamp the version back DOWN, and
///     a file that was stamped down and then upgraded again walks this step a
///     second time. Design §3.2/§3.3: 「幂等性不是装饰」 ("idempotency is not decoration").
/// Frozen: a later column on this table is a NEW `_upgradeVn` plus a version
/// bump, never an edit here.
Future<void> _upgradeV5CreateInstanceMachineMapAsShipped(Database d) async {
  await d.execute('''
    CREATE TABLE IF NOT EXISTS $kInstanceMachineMapTable (
      instance_id  TEXT PRIMARY KEY,
      machine_uid  TEXT NOT NULL,
      learned_at   INTEGER NOT NULL,
      source       TEXT NOT NULL
    )
  ''');
}

/// v5 → v6 (0.3.0 card E-CL) — the blind store's local ledger, AS v6 SHIPS IT.
///
/// `IF NOT EXISTS` on the step and not on the create, for the reason spelled out
/// on [_upgradeV5CreateInstanceMachineMapAsShipped]: a step really can run twice
/// (D13 ① — a file stamped down by an older APK and upgraded again), a create
/// never legitimately can. Frozen: a later column here is a NEW `_upgradeVn`
/// plus a version bump, never an edit to this text.
///
/// ⚠️ The index is created in the same step as the table. It has to be: the
/// fresh-vs-stepwise parity test compares indexes as well as columns, so a step
/// that built the table alone would converge on shape and diverge on plan.
Future<void> _upgradeV6CreateBlindStoreCloudStateAsShipped(Database d) async {
  await d.execute('''
    CREATE TABLE IF NOT EXISTS $kBlindStoreCloudStateTable (
      entry_id     TEXT PRIMARY KEY,
      state        TEXT NOT NULL,
      payload_hash TEXT,
      updated_at   INTEGER NOT NULL
    )
  ''');
  await d.execute(
    'CREATE INDEX IF NOT EXISTS idx_blindstore_state ON '
    '$kBlindStoreCloudStateTable (state, updated_at ASC)',
  );
}

Future<bool> _outboxHasColumn(Database d, String name) async {
  final List<Map<String, Object?>> cols = await d.rawQuery(
    'PRAGMA table_info($kOutboxTable)',
  );
  return cols.any((Map<String, Object?> c) => c['name'] == name);
}

// ── D13 test hooks — building HISTORICAL databases is the only way to test an
// upgrade, and the DDL must be this file's own, not a copy that can drift ─────

/// Rebuild a v1 database's schema (timeline only — v1 had no outbox table).
@visibleForTesting
Future<void> createTimelineSchemaV1ForTest(Database d) =>
    _createTimelineSchema(d);

/// Rebuild the outbox table exactly as v2 shipped it — the pre-B3-2b shape the
/// v4 healing step exists for.
@visibleForTesting
Future<void> createOutboxSchemaV2ForTest(Database d) =>
    _upgradeV2CreateOutboxAsShipped(d);

