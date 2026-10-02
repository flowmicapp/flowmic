import 'dart:convert';
import 'package:sqflite/sqflite.dart';
import '../diag/diag_log.dart';
import 'timeline_entry.dart';
import 'timeline_persistence.dart';

const kTimelineCorruptArchiveTable = 'timeline_corrupt_archive';

/// Auxiliary recovery data, compatible with older v8 readers. Install only
/// when needed, inside the same transaction that replaces the primary row.
Future<bool> archiveCorruptTimelineRow(
  DatabaseExecutor db,
  Map<String, Object?>? row, {
  required String table,
}) async {
  if (row == null) return false;
  final decoded = decodeTimelineRow(row['payload']);
  if (decoded != null && decoded.id == row['id']) return false;
  await db.execute(
    'CREATE TABLE IF NOT EXISTS $kTimelineCorruptArchiveTable ('
    'archive_id INTEGER PRIMARY KEY AUTOINCREMENT, row_id TEXT NOT NULL, '
    'payload BLOB NOT NULL, original_row TEXT NOT NULL)',
  );
  // Copy in SQLite: malformed UTF-8 and BLOB values must never pass through
  // a Dart text encoder before their original bytes are preserved.
  await db.rawInsert(
    'INSERT INTO $kTimelineCorruptArchiveTable (row_id, payload, original_row) '
    'SELECT id, CAST(payload AS BLOB), ? FROM $table WHERE id = ?',
    [jsonEncode(row), row['id']],
  );
  return true;
}

void reportCorruptTimelineReplacement(String id) =>
    diag('timeline.corrupt_row_replaced', {
      'row_id': boundedDiagnosticIds([id]),
    });

/// Only the row id is diagnostic; neither preserved nor incoming text is logged.
bool unreadableTimelineValue(Object? value, TimelineEntry entry) {
  final decoded = decodeTimelineRow(value);
  return decoded == null || decoded.id != entry.id;
}

Future<bool> hasTimelineCorruptArchive(DatabaseExecutor db) async =>
    (await db.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [kTimelineCorruptArchiveTable],
    )).isNotEmpty;
