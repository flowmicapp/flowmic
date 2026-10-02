import 'package:sqflite/sqflite.dart';

const String kTimelineFallbackReceiptsTable = 'timeline_fallback_import_receipts';

/// Auxiliary schema is additive and replayable on both v8 shapes (receipts present or absent).
/// Receipts outlive deleted notes and must never be pruned without a separate
/// retention decision: they prevent a failed pending-row cleanup resurrecting data.
Future<void> installTimelineFallbackReceiptsSchema(DatabaseExecutor db) => db.execute(
  'CREATE TABLE IF NOT EXISTS $kTimelineFallbackReceiptsTable ('
  'id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (id, fingerprint))',
);
