// SPEC-REF: Task C plan §9. Frozen v8 additive schema. No timeline row is
// rewritten. No FK to timeline: its legacy REPLACE would cascade on every edit.
import 'package:sqflite/sqflite.dart';

import '../diag/diag_log.dart';

/// Optional bookkeeping must not make the primary timeline unusable. A partial
/// installation retries on every open; IF NOT EXISTS makes that replay safe.
Future<bool> installMcpSchemaV8(DatabaseExecutor db) async {
  try {
    await createMcpSchemaV8(db);
    return true;
  } on Object {
    diag('mcp.storage_unavailable', <String, Object?>{'operation': 'schema'});
    return false;
  }
}

Future<void> createMcpSchemaV8(DatabaseExecutor db) async {
  await db.execute('''CREATE TABLE IF NOT EXISTS mcp_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_hint TEXT NOT NULL,
    tool TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    mapping TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    tested_generation INTEGER,
    authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    state TEXT NOT NULL DEFAULT 'saved' CHECK (state IN
      ('saved','enabled','paused','reauthorization_required','tool_missing',
       'schema_unsupported','storage_unavailable')),
    expired_count INTEGER NOT NULL DEFAULT 0,
    last_success_at INTEGER,
    last_test_at INTEGER
  )''');
  await db.execute('''CREATE TABLE IF NOT EXISTS mcp_local_records (
    entry_id TEXT PRIMARY KEY,
    registered_at INTEGER NOT NULL,
    ready INTEGER NOT NULL CHECK (ready IN (0, 1))
  )''');
  await db.execute('''CREATE TABLE IF NOT EXISTS mcp_submissions (
    entry_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN
      ('pending','sending','sent','rejected','unknown','retrying')),
    remote_ack TEXT CHECK (remote_ack IN ('tool_result','accepted','completed')),
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    snapshot TEXT,
    payload_hash TEXT,
    expired INTEGER NOT NULL DEFAULT 0 CHECK (expired IN (0, 1)),
    PRIMARY KEY (entry_id, channel_id),
    FOREIGN KEY (entry_id) REFERENCES mcp_local_records(entry_id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES mcp_channels(id) ON DELETE CASCADE,
    CHECK ((state = 'sent' AND remote_ack IS NOT NULL) OR
      (state <> 'sent' AND remote_ack IS NULL)),
    CHECK (state NOT IN ('sent','rejected') OR snapshot IS NULL)
  )''');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_mcp_pending '
    'ON mcp_submissions(channel_id, state, created_at)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_mcp_registered '
    'ON mcp_local_records(registered_at)');
  await db.execute('''CREATE TABLE IF NOT EXISTS mcp_evictions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    channel_id TEXT,
    age_ms INTEGER NOT NULL,
    reason TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )''');
  await db.execute('''CREATE TABLE IF NOT EXISTS mcp_maintenance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    audit_pruned INTEGER NOT NULL DEFAULT 0
  )''');
  // The table is empty between allocations. SQLite's single sqlite_sequence
  // cell survives deletion, so restoring a removed id cannot reuse an epoch.
  await db.execute('CREATE TABLE IF NOT EXISTS mcp_configuration_epochs '
    '(sequence INTEGER PRIMARY KEY AUTOINCREMENT)');
  // Zero configuration leaves registration, submission, and audit tables empty.
}
