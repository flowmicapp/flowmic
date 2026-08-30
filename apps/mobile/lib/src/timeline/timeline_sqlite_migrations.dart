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

/// v1 — THE TIMELINE TABLE AS v1 SHIPPED IT, frozen.
///
/// 🔴 THIS IS A COPY, AND THE COPY IS THE POINT. Until v7 the final create
/// doubled as the v1 rebuild, because the table had never changed; the parity
/// test (fresh-create vs stepwise-upgrade) was therefore comparing today's DDL
/// with itself, and would have stayed green through any change made in both
/// places at once. Frozen text is what makes 「upgrade an OLD database」 mean
/// anything, and D13 rule 1 says the freeze happens on the FIRST change, not
/// later — later is exactly when nobody remembers what v1 was.
///
/// Never edited again. A further column is a new `_upgradeVn` plus a version
/// bump.
Future<void> _createTimelineSchemaV1AsShipped(Database d) async {
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
  await d.execute(
    'CREATE INDEX idx_timeline_created ON $kTimelineTable (created_at DESC)',
  );
  await d.execute(
    'CREATE INDEX idx_timeline_owner ON $kTimelineTable '
    '(spoken_to_instance_id, created_at DESC)',
  );
}

/// v6 → v7 (card CR-7) — the article grouping key, AS v7 SHIPS IT.
///
/// Guarded by inspection rather than by luck, exactly like
/// [_upgradeV3AddOutboxDuration]: SQLite has no `ADD COLUMN IF NOT EXISTS`, and
/// D13 ① records a real way this step can run twice (an older APK stamped a
/// newer file back DOWN, then a newer APK upgraded it again). An unguarded
/// `ALTER` there does not merely fail — it drops that install to the 100-row
/// store on every launch, permanently, with nothing naming the cause.
///
/// ⚠️ The INDEX is created in the same step as the column. It has to be: the
/// fresh-vs-stepwise parity test compares indexes as well as columns, so a step
/// that added the column alone would converge on shape and diverge on plan.
///
/// 🔴 NOTHING IS BACK-FILLED, and that is the honest answer rather than a
/// shortcut. Every row written before articles existed belongs to no recording,
/// and there is no evidence on disk from which one could be inferred — adopting
/// them into 「whatever recording is nearest in time」 is the same lie V2-06a-1
/// refused when it would not invent an owner for a legacy row.
Future<void> _upgradeV7AddTimelineArticleId(Database d) async {
  if (!await _timelineHasColumn(d, 'article_id')) {
    await d.execute('ALTER TABLE $kTimelineTable ADD COLUMN article_id TEXT');
  }
  await d.execute(
    'CREATE INDEX IF NOT EXISTS idx_timeline_article ON $kTimelineTable '
    '(article_id, created_at ASC)',
  );
}

Future<bool> _timelineHasColumn(Database d, String name) async {
  final List<Map<String, Object?>> cols = await d.rawQuery(
    'PRAGMA table_info($kTimelineTable)',
  );
  return cols.any((Map<String, Object?> c) => c['name'] == name);
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
///
/// 🔴 Points at the FROZEN v1 text since v7. It used to point at
/// `_createTimelineSchema`, which was correct only for as long as the table had
/// never changed — see [_createTimelineSchemaV1AsShipped] for why that made the
/// parity test compare today's DDL with itself.
@visibleForTesting
Future<void> createTimelineSchemaV1ForTest(Database d) =>
    _createTimelineSchemaV1AsShipped(d);

/// Rebuild the outbox table exactly as v2 shipped it — the pre-B3-2b shape the
/// v4 healing step exists for.
@visibleForTesting
Future<void> createOutboxSchemaV2ForTest(Database d) =>
    _upgradeV2CreateOutboxAsShipped(d);

