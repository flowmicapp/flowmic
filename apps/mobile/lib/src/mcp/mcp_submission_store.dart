// Durable attempt transitions. Claim BEFORE sending; process death leaves a
// sending row that startup classifies unknown. There is no optimistic success.
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:sqflite/sqflite.dart';

import '../timeline/timeline_entry.dart';
import 'mcp_channel.dart';
import 'mcp_store.dart';
import 'mcp_transport.dart';

String mcpPayloadHash(Map<String, Object?> arguments) => sha256.convert(utf8.encode(jsonEncode(arguments))).toString();

String? mcpJobRevision(Map<String, Object?>? job) => job == null ? null : jsonEncode(<Object?>[
  job['generation'], job['state'], job['attempts'], job['updated_at'], job['payload_hash'],
]);

extension McpSubmissionStore on McpStore {
  Future<bool> claim(Map<String, Object?> job, String snapshot, String hash) async {
    final int bytes = utf8.encode(snapshot).length;
    // The global snapshot budget is tested in the same transaction as claim:
    // concurrent channel workers cannot each spend the same remaining bytes.
    final int count = await db.transaction((Transaction txn) async {
    final int retained = Sqflite.firstIntValue(await txn.rawQuery(
      'SELECT COALESCE(SUM(length(CAST(snapshot AS BLOB))), 0) FROM mcp_submissions '
      'WHERE NOT (entry_id = ? AND channel_id = ?)', <Object?>[job['entry_id'], job['channel_id']]))!;
    if (bytes > limits.snapshotBytes || retained + bytes > limits.totalSnapshotBytes) {
      return -1;
    }
    // Destination deletion/pause/change and local deletion win if they reached
    // SQLite before this claim. An already-sent request cannot be recalled.
    return txn.rawUpdate("UPDATE mcp_submissions SET state = 'sending', "
      'snapshot = ?, payload_hash = ?, attempts = attempts + 1, updated_at = ? '
      "WHERE entry_id = ? AND channel_id = ? AND generation = ? AND state IN ('pending','retrying') "
      'AND EXISTS (SELECT 1 FROM timeline_entries WHERE id = mcp_submissions.entry_id) '
      "AND EXISTS (SELECT 1 FROM mcp_channels WHERE id = mcp_submissions.channel_id AND state = 'enabled' "
      'AND authorized = 1 AND paused = 0 AND generation = ? AND tested_generation = generation)',
      <Object?>[snapshot, hash, nowMs, job['entry_id'], job['channel_id'], job['generation'], job['generation']]);
    });
    if (count == -1) { await reject(job, 'local_mapping'); return false; }
    await refresh();
    return count == 1;
  }

  Future<void> reject(Map<String, Object?> job, String reason) async {
    await db.update('mcp_submissions', <String, Object?>{'state': 'rejected',
      'snapshot': null, 'last_error': reason, 'updated_at': nowMs},
      where: "entry_id = ? AND channel_id = ? AND generation = ? AND state IN ('pending','retrying')",
      whereArgs: <Object?>[job['entry_id'], job['channel_id'], job['generation']]);
    await refresh();
  }

  Future<void> conclude(Map<String, Object?> job, McpReply reply) async {
    final int attempts = (job['attempts']! as int) + 1;
    final bool exhausted = attempts >= 5;
    final bool unauthorized = reply.status == 401;
    final String state = switch (reply.evidence) {
      McpEvidence.result => 'sent',
      McpEvidence.unknown => 'unknown',
      McpEvidence.rejected => 'rejected',
      McpEvidence.notExecuted => unauthorized ? 'pending' : exhausted ? 'rejected' : 'retrying',
    };
    final Duration delay = reply.retryAfter ?? Duration(seconds: 1 << (attempts - 1).clamp(0, 4));
    await db.transaction((Transaction txn) async {
      final int changed = await txn.update('mcp_submissions', <String, Object?>{
        'state': state, 'remote_ack': state == 'sent' ? 'tool_result' : null,
        'last_error': state == 'sent' ? null : reply.evidence == McpEvidence.rejected ? 'remote_tool'
          : exhausted && reply.evidence == McpEvidence.notExecuted && !unauthorized ? 'retry_exhausted' : reply.reason,
        if (state == 'sent' || state == 'rejected') 'snapshot': null,
        'next_attempt_at': state == 'retrying' ? nowMs + delay.inMilliseconds : null,
        'updated_at': nowMs,
      }, where: "entry_id = ? AND channel_id = ? AND generation = ? AND state = 'sending'",
        whereArgs: <Object?>[job['entry_id'], job['channel_id'], job['generation']]);
      if (changed == 1 && state == 'sent') {
        await txn.update('mcp_channels', <String, Object?>{'last_success_at': nowMs},
          where: 'id = ? AND generation = ?', whereArgs: <Object?>[job['channel_id'], job['generation']]);
      }
    });
    await refresh();
  }

  /// Manual submission is explicit, including history and previous failures.
  /// The screen obtains duplicate-risk confirmation before reaching this verb.
  Future<void> manual(TimelineEntry entry, McpChannel channel, {required String? expectedRevision}) async {
    if (!available || !channel.canSend || entry.deleted ||
        !<String>{TimelineEntry.kTranscript, TimelineEntry.kImage}.contains(entry.entryType)) {
      throw StateError('manual_unavailable');
    }
    await db.transaction((Transaction txn) async {
      final List<Map<String, Object?>> recipient = await txn.query('mcp_channels',
        where: "id = ? AND generation = ? AND authorized = 1 AND paused = 0 AND state = 'enabled' AND tested_generation = generation",
        whereArgs: <Object?>[channel.id, channel.generation]);
      if (recipient.isEmpty) throw StateError('manual_unavailable');
      final List<Map<String, Object?>> registration = await txn.query('mcp_local_records',
        where: 'entry_id = ?', whereArgs: <Object?>[entry.id]);
      if (registration.isNotEmpty && registration.single['ready'] != 1) {
        throw StateError('content_not_ready');
      }
      final List<Map<String, Object?>> old = await txn.query('mcp_submissions',
        where: 'entry_id = ? AND channel_id = ?', whereArgs: <Object?>[entry.id, channel.id]);
      if (mcpJobRevision(old.isEmpty ? null : old.single) != expectedRevision) throw StateError('confirmation_changed');
      if (old.isNotEmpty && old.single['state'] == 'sending') throw StateError('sending');
      await txn.insert('mcp_local_records', <String, Object?>{
        'entry_id': entry.id, 'registered_at': nowMs, 'ready': 1,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      await txn.update('mcp_local_records', <String, Object?>{'ready': 1}, where: 'entry_id = ?', whereArgs: <Object?>[entry.id]);
      await txn.insert('mcp_submissions', <String, Object?>{
        'entry_id': entry.id, 'channel_id': channel.id, 'generation': channel.generation,
        'state': 'pending', 'created_at': nowMs, 'updated_at': nowMs,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    });
    await maintain();
  }
}
