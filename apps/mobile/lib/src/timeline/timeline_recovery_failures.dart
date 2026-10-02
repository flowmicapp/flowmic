import 'dart:async';
import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../diag/diag_log.dart';
import 'timeline_write_failures.dart';

/// Acknowledge problem identities; active cloud storage failures stay visible.
class TimelineRecoveryFailures extends TimelineWriteFailures {
  TimelineRecoveryFailures({SharedPreferences? prefs}) : _prefs = prefs;
  final SharedPreferences? _prefs;
  static const String acknowledgementPrefix = 'flowmic.timeline.corruption_ack.v2.';
  final Map<String, Set<String>> _pending = {};
  final Map<String, Set<String>> _acknowledged = {};
  Future<void> acknowledgement = Future<void>.value();

  String _identity(String kind, String id) => sha256.convert(utf8.encode(jsonEncode([kind, id]))).toString();
  String _digest(String kind, Set<String> identities) =>
      sha256.convert(utf8.encode(jsonEncode([kind, identities.toList()..sort()]))).toString();
  String _entry(String kind, String identity) => 'corruption:$kind:$identity';

  Set<String> _readAcknowledged(String kind) {
    final prefs = _prefs;
    if (prefs == null) return _acknowledged[kind] ?? {};
    final key = '$acknowledgementPrefix$kind';
    final identities = (prefs.getStringList('$key.rows') ?? <String>[]).toSet();
    return prefs.getString(key) == _digest(kind, identities) ? identities : {};
  }

  void recordCorruption(String kind, Iterable<String> rowIds) {
    final acknowledged = _readAcknowledged(kind);
    for (final id in rowIds) {
      final identity = _identity(kind, id);
      if (acknowledged.contains(identity)) continue;
      if ((_pending[kind] ??= {}).add(identity)) recordOnce(_entry(kind, identity));
    }
  }

  void resolveCorruption(String kind, String id) {
    final identity = _identity(kind, id);
    _pending[kind]?.remove(identity);
    forgetDeletedEntries([_entry(kind, identity)]);
  }

  void reportStorageOpen(String? failure, Map<String, Set<String>> corruptionRowIds) {
    for (final issue in corruptionRowIds.entries) { recordCorruption(issue.key, issue.value); }
    if (failure != null && !failure.startsWith('fallback_unreadable') &&
        !failure.startsWith('fallback_import_cleanup:')) {
      recordOnce('storage-open');
    }
  }

  @override
  void dismissNotice() {
    if (_pending.values.every((ids) => ids.isEmpty)) { super.dismissNotice(); return; }
    // Capture before the first await so a new problem cannot be acknowledged by an old tap.
    final snapshot = {for (final e in _pending.entries) e.key: Set<String>.of(e.value)};
    acknowledgement = acknowledgement.then((_) => _acknowledge(snapshot));
    unawaited(acknowledgement);
  }

  Future<void> _acknowledge(Map<String, Set<String>> snapshot) async {
    try {
      for (final entry in snapshot.entries) {
        if (entry.value.isEmpty) continue;
        final identities = {..._readAcknowledged(entry.key), ...entry.value};
        final prefs = _prefs;
        if (prefs != null) {
          final key = '$acknowledgementPrefix${entry.key}';
          final rowsSaved = await prefs.setStringList('$key.rows', identities.toList()..sort());
          final hashSaved = await prefs.setString(key, _digest(entry.key, identities));
          await prefs.reload();
          if (!rowsSaved || !hashSaved || !_readAcknowledged(entry.key).containsAll(identities)) {
            throw StateError('corruption acknowledgement refused');
          }
        }
        _acknowledged[entry.key] = identities;
      }
      for (final entry in snapshot.entries) {
        _pending[entry.key]?.removeAll(entry.value);
        forgetEntries(entry.value.map((id) => _entry(entry.key, id)));
      }
      if (_pending.values.every((ids) => ids.isEmpty)) super.dismissNotice();
    } on Object catch (e) { diag('timeline.corruption_ack_failed', {'error': e.runtimeType}); }
  }
}
