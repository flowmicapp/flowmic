// SPEC-REF: Task C plan §9.1-9.4. This ledger cannot authorize a local save.
// Snapshot recipients BEFORE awaiting that save; a newly enabled channel must
// not adopt a record that was born while configuration was absent.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';

import '../diag/diag_log.dart';
import '../timeline/local_record_persistence.dart';
import '../timeline/timeline_entry.dart';
import 'mcp_channel.dart';

Future<int> reserveMcpGeneration(DatabaseExecutor txn) async {
  int next = await txn.rawInsert('INSERT INTO mcp_configuration_epochs DEFAULT VALUES');
  final int existing = Sqflite.firstIntValue(await txn.rawQuery('SELECT COALESCE(MAX(generation), 0) FROM '
    '(SELECT generation FROM mcp_channels UNION ALL SELECT generation FROM mcp_submissions)'))!;
  if (next <= existing) {
    next = existing + 1;
    await txn.insert('mcp_configuration_epochs', <String, Object?>{'sequence': next});
  }
  await txn.delete('mcp_configuration_epochs');
  return next;
}

class McpLimits {
  const McpLimits({this.registrations = 10000, this.pendingPerChannel = 2000,
    this.age = const Duration(days: 30), this.snapshotBytes = 256 * 1024,
    this.totalSnapshotBytes = 16 * 1024 * 1024, this.auditRows = 1000});
  final int registrations;
  final int pendingPerChannel;
  final Duration age;
  final int snapshotBytes;
  final int totalSnapshotBytes;
  final int auditRows;
}

class McpStore extends ChangeNotifier {
  McpStore(this.db, {this.limits = const McpLimits(), DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;
  final Database db;
  final McpLimits limits;
  final DateTime Function() _clock;
  List<McpChannel> _channels = <McpChannel>[];
  bool available = false;
  int get nowMs => _clock().toUtc().millisecondsSinceEpoch;
  List<McpChannel> get channels => List<McpChannel>.unmodifiable(_channels);
  Map<String, int> get armedTargets => available ? <String, int>{
    for (final McpChannel channel in _channels)
      if (channel.authorized) channel.id: channel.generation,
  } : const <String, int>{};

  Future<void> initialize() async {
    try {
      await db.update('mcp_submissions', <String, Object?>{
        'state': 'unknown', 'last_error': 'response_unknown', 'updated_at': nowMs,
      }, where: "state = 'sending'");
      await _reload();
      available = true;
      await maintain();
    } on Object { await markUnavailable('initialize'); }
  }

  Future<void> _reload() async {
    _channels = (await db.query('mcp_channels', orderBy: 'id')).map(McpChannel.fromRow).toList();
    notifyListeners();
  }

  Future<void> refresh() => _reload();
  Future<int> reserveGeneration() => db.transaction(reserveMcpGeneration);

  Future<void> markUnavailable(String operation) async {
    available = false;
    diag('mcp.storage_unavailable', <String, Object?>{'operation': operation});
    try {
      await db.update('mcp_channels', <String, Object?>{'state': 'storage_unavailable', 'tested_generation': null});
      await _reload();
    } on Object {
      // The in-memory availability flag remains authoritative even if the disk
      // cannot remember its own failure. No network worker runs in this state.
      diag('mcp.storage_unavailable', <String, Object?>{'operation': 'persist_failure_state'});
      notifyListeners();
    }
  }

  Future<void> saveChannel(McpChannel channel, {bool retainPendingForCredentialChange = false}) async {
    if (!available) throw StateError('storage_unavailable');
    await db.transaction((Transaction txn) async {
      final List<Map<String, Object?>> old = await txn.query('mcp_channels', where: 'id = ?', whereArgs: <Object?>[channel.id]);
      if (old.isEmpty && Sqflite.firstIntValue(await txn.rawQuery('SELECT COUNT(*) FROM mcp_channels'))! >= 3) {
        throw StateError('channel_limit');
      }
      if (old.isEmpty) {
        await txn.insert('mcp_channels', channel.toRow());
      } else {
        await txn.update('mcp_channels', channel.toRow(), where: 'id = ?', whereArgs: <Object?>[channel.id]);
        // A new destination/mapping generation never silently inherits old work.
        if (old.single['generation'] != channel.generation) {
          await txn.update('mcp_submissions', <String, Object?>{
            if (retainPendingForCredentialChange) 'generation': channel.generation,
            if (!retainPendingForCredentialChange) ...<String, Object?>{
              'state': 'rejected', 'snapshot': null, 'last_error': 'local_mapping',
            }, 'updated_at': nowMs,
          }, where: "channel_id = ? AND state IN ('pending','retrying')", whereArgs: <Object?>[channel.id]);
        }
      }
    });
    await _reload();
  }

  Future<void> setState(String id, int generation, McpChannelState state) async {
    await db.update('mcp_channels', <String, Object?>{'state': state.wire,
      if (state != McpChannelState.enabled && state != McpChannelState.paused && state != McpChannelState.saved)
        'tested_generation': null,
    },
      where: 'id = ? AND generation = ?', whereArgs: <Object?>[id, generation]);
    await _reload();
  }

  Future<void> tested(String id, int generation) async {
    await db.rawUpdate('UPDATE mcp_channels SET tested_generation = ?, last_test_at = ?, '
      "state = CASE WHEN paused = 1 THEN 'paused' WHEN authorized = 1 THEN 'enabled' ELSE 'saved' END "
      'WHERE id = ? AND generation = ?', <Object?>[generation, nowMs, id, generation]);
    await _reload();
  }

  Future<void> enable(String id, int generation) async {
    final int changed = await db.update('mcp_channels', <String, Object?>{
      'authorized': 1, 'paused': 0, 'state': 'enabled',
    }, where: 'id = ? AND generation = ? AND tested_generation = ?', whereArgs: <Object?>[id, generation, generation]);
    if (changed != 1) throw StateError('test_required');
    await _reload();
  }

  Future<void> pause(String id) async {
    await db.rawUpdate("UPDATE mcp_channels SET paused = 1, state = CASE WHEN state IN ('enabled','saved') THEN 'paused' ELSE state END WHERE id = ?", <Object?>[id]);
    await _reload();
  }

  Future<void> removeChannel(String id) async {
    await db.transaction((Transaction txn) async {
      final List<Map<String, Object?>> jobs = await txn.query('mcp_submissions', where: 'channel_id = ?', whereArgs: <Object?>[id]);
      for (final Map<String, Object?> job in jobs) { await _audit(txn, job, 'channel_removed'); }
      await txn.delete('mcp_submissions', where: 'channel_id = ?', whereArgs: <Object?>[id]);
      await txn.delete('mcp_channels', where: 'id = ?', whereArgs: <Object?>[id]);
      await txn.rawDelete('DELETE FROM mcp_local_records WHERE entry_id NOT IN (SELECT entry_id FROM mcp_submissions)');
      await _trimAudit(txn);
    });
    await _reload();
  }

  Future<void> recordLocal(TimelineEntry entry, {required LocalRecordSource source,
    required Map<String, int> targets}) async {
    if (!available || entry.origin != 'cloud' || entry.deleted ||
        !<String>{TimelineEntry.kTranscript, TimelineEntry.kImage}.contains(entry.entryType)) {
      return;
    }
    final bool birth = source == LocalRecordSource.birthReady || source == LocalRecordSource.birthAwaitingContent;
    if (birth && targets.isEmpty) return;
    if (source == LocalRecordSource.edit) return;
    await db.transaction((Transaction txn) async {
      if (birth) {
        // A delayed local save cannot enroll into a different configuration.
        final Map<String, int> recipients = <String, int>{};
        for (final MapEntry<String, int> target in targets.entries) {
          final List<Map<String, Object?>> rows = await txn.query('mcp_channels',
            where: 'id = ? AND generation = ? AND authorized = 1', whereArgs: <Object?>[target.key, target.value]);
          if (rows.isNotEmpty) recipients[target.key] = target.value;
        }
        if (recipients.isEmpty) return;
        await txn.insert('mcp_local_records', <String, Object?>{
          'entry_id': entry.id, 'registered_at': nowMs, 'ready': source == LocalRecordSource.birthReady ? 1 : 0,
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
        final int changed = Sqflite.firstIntValue(await txn.rawQuery('SELECT changes()'))!;
        if (changed == 0) return;
        for (final MapEntry<String, int> target in recipients.entries) {
          await txn.insert('mcp_submissions', <String, Object?>{
            'entry_id': entry.id, 'channel_id': target.key, 'generation': target.value,
            'state': 'pending', 'created_at': nowMs, 'updated_at': nowMs,
          }, conflictAlgorithm: ConflictAlgorithm.ignore);
        }
      } else if (source == LocalRecordSource.contentReady) {
        await txn.update('mcp_local_records', <String, Object?>{'ready': 1},
          where: 'entry_id = ?', whereArgs: <Object?>[entry.id]);
      }
    });
    await maintain();
    notifyListeners();
  }

  Future<void> forget(Iterable<String> entryIds) async {
    await db.transaction((Transaction txn) async {
      for (final String id in entryIds) {
        await txn.delete('mcp_submissions', where: 'entry_id = ?', whereArgs: <Object?>[id]);
        await txn.delete('mcp_local_records', where: 'entry_id = ?', whereArgs: <Object?>[id]);
        // A user clear also removes identifiers from the optional audit table.
        await txn.delete('mcp_evictions', where: 'entry_id = ?', whereArgs: <Object?>[id]);
      }
    });
    notifyListeners();
  }

  Future<List<Map<String, Object?>>> submissions(String channelId) => db.rawQuery(
    'SELECT s.*, r.ready FROM mcp_submissions s JOIN mcp_local_records r ON r.entry_id = s.entry_id '
    'WHERE s.channel_id = ? ORDER BY s.created_at DESC', <Object?>[channelId]);

  Future<void> maintain() async {
    if (!available) return;
    await db.transaction((Transaction txn) async {
      final int cutoff = nowMs - limits.age.inMilliseconds;
      final List<Map<String, Object?>> records = await txn.query('mcp_local_records', orderBy: 'registered_at DESC, entry_id');
      for (int i = 0; i < records.length; i++) {
        final Map<String, Object?> record = records[i];
        if (i < limits.registrations && (record['registered_at']! as int) >= cutoff) continue;
        final List<Map<String, Object?>> jobs = await txn.query('mcp_submissions', where: 'entry_id = ?', whereArgs: <Object?>[record['entry_id']]);
        for (final Map<String, Object?> job in jobs) {
          await _expire(txn, job, i >= limits.registrations ? 'capacity' : 'age');
        }
        await txn.delete('mcp_submissions', where: 'entry_id = ?', whereArgs: <Object?>[record['entry_id']]);
        await txn.delete('mcp_local_records', where: 'entry_id = ?', whereArgs: <Object?>[record['entry_id']]);
      }
      for (final McpChannel channel in _channels) {
        final List<Map<String, Object?>> pending = await txn.query('mcp_submissions',
          where: "channel_id = ? AND state IN ('pending','retrying','unknown','sending') AND expired = 0", whereArgs: <Object?>[channel.id],
          orderBy: 'created_at DESC, entry_id');
        for (final Map<String, Object?> job in pending.skip(limits.pendingPerChannel)) {
          await _expire(txn, job, 'capacity');
        }
      }
      int bytes = 0;
      final List<Map<String, Object?>> snapshots = await txn.query('mcp_submissions', where: 'snapshot IS NOT NULL', orderBy: 'created_at DESC, entry_id');
      for (final Map<String, Object?> job in snapshots) {
        bytes += utf8.encode(job['snapshot']! as String).length;
        if (bytes > limits.totalSnapshotBytes) await _expire(txn, job, 'snapshot_capacity');
      }
      // Resume failed cleanup after a crash, never re-enroll orphan rows.
      final List<Map<String, Object?>> orphaned = await txn.rawQuery(
        'SELECT s.* FROM mcp_submissions s LEFT JOIN timeline_entries t ON t.id = s.entry_id WHERE t.id IS NULL');
      for (final Map<String, Object?> job in orphaned) {
        await _audit(txn, job, 'timeline_removed');
        await txn.delete('mcp_submissions', where: 'entry_id = ? AND channel_id = ?', whereArgs: <Object?>[job['entry_id'], job['channel_id']]);
      }
      await txn.rawDelete('DELETE FROM mcp_local_records WHERE entry_id NOT IN (SELECT entry_id FROM mcp_submissions)');
      await _trimAudit(txn);
    });
    await _reload();
  }

  Future<void> _expire(DatabaseExecutor txn, Map<String, Object?> job, String reason) async {
    await _audit(txn, job, reason);
    // Only known-unexecuted records count as expired WITHOUT sending. Unknown
    // calls may have executed; their history/audit must not make that claim.
    final bool unsent = <String>{'pending', 'retrying'}.contains(job['state']);
    if (unsent && job['expired'] != 1) {
      await txn.rawUpdate('UPDATE mcp_channels SET expired_count = expired_count + 1 WHERE id = ?', <Object?>[job['channel_id']]);
    }
    await txn.update('mcp_submissions', <String, Object?>{
      if (unsent) 'state': 'rejected', 'snapshot': null, 'expired': 1,
      if (unsent) 'last_error': 'expired', 'updated_at': nowMs,
    }, where: 'entry_id = ? AND channel_id = ?', whereArgs: <Object?>[job['entry_id'], job['channel_id']]);
  }

  Future<void> _audit(DatabaseExecutor txn, Map<String, Object?> job, String reason) async {
    final int age = nowMs - (job['created_at']! as int);
    await txn.insert('mcp_evictions', <String, Object?>{
      'entry_id': job['entry_id'], 'channel_id': job['channel_id'],
      'age_ms': age < 0 ? 0 : age, 'reason': '${reason}_${job['state']}', 'recorded_at': nowMs,
    });
    diag('mcp.evicted', <String, Object?>{'entry_id': job['entry_id'],
      'channel_id': job['channel_id'], 'age_ms': age, 'reason': reason, 'state': job['state']});
  }

  Future<void> _trimAudit(DatabaseExecutor txn) async {
    final int removed = await txn.rawDelete('DELETE FROM mcp_evictions WHERE recorded_at < ? '
      'OR sequence NOT IN (SELECT sequence FROM mcp_evictions ORDER BY sequence DESC LIMIT ?)',
      <Object?>[nowMs - limits.age.inMilliseconds, limits.auditRows]);
    if (removed > 0) {
      await txn.rawInsert('INSERT OR IGNORE INTO mcp_maintenance(singleton, audit_pruned) VALUES (1, 0)');
      await txn.rawUpdate('UPDATE mcp_maintenance SET audit_pruned = audit_pruned + ? WHERE singleton = 1', <Object?>[removed]);
      diag('mcp.audit_pruned', <String, Object?>{'count': removed});
    }
  }
}
