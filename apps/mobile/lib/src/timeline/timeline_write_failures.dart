import 'dart:async';

import 'package:flutter/foundation.dart';

/// Phone-local write truth, separate from delivery status and never persisted.
class TimelineWriteFailures extends ChangeNotifier {
  static const Duration burstQuietPeriod = Duration(seconds: 2);

  final Set<String> _persistentIds = <String>{};
  bool get hasPersistentFailures => _persistentIds.isNotEmpty;
  void recordPersistent(String entryId) {
    if (_disposed) return;
    _persistentIds.add(entryId);
    recordOnce(entryId);
    if (_noticeTicket == null) {
      _noticeTicket = ++_nextTicket;
      notifyListeners();
    }
  }

  final Set<String> _entryIds = <String>{};

  /// IDs of rows currently held in memory whose last write failed.
  Set<String> get entryIds => Set<String>.unmodifiable(_entryIds);
  int? get noticeTicket => _noticeTicket;
  int? _noticeTicket;
  int _nextTicket = 0;
  Timer? _quietTimer;
  bool _disposed = false;

  /// One notice for an unresolved persistent failure, even after dismissal.
  void recordOnce(String entryId) {
    if (_disposed || !_entryIds.add(entryId)) return;
    _noticeTicket = ++_nextTicket;
    notifyListeners();
  }

  void remember(String entryId) => _entryIds.add(entryId);

  void record(String entryId) {
    if (_disposed) return;
    _entryIds.add(entryId);
    final bool firstInBurst = _quietTimer == null || _noticeTicket == null;
    _quietTimer?.cancel();
    _quietTimer = Timer(burstQuietPeriod, () => _quietTimer = null);
    if (firstInBurst) {
      _noticeTicket = ++_nextTicket;
      notifyListeners();
    }
  }

  void saved(String entryId) {
    final bool wasPersistent = hasPersistentFailures;
    _entryIds.remove(entryId); _persistentIds.remove(entryId);
    if (!_disposed && wasPersistent != hasPersistentFailures) notifyListeners();
  }

  void clearEntries() => _entryIds.clear();

  void forgetEntries(Iterable<String> entryIds) =>
      _entryIds.removeAll(entryIds);

  void forgetDeletedEntries(Iterable<String> entryIds) {
    final bool wasPersistent = hasPersistentFailures;
    _entryIds.removeAll(entryIds);
    _persistentIds.removeAll(entryIds);
    if (_entryIds.isEmpty) { dismissNotice(); }
    else if (!_disposed && wasPersistent != hasPersistentFailures) { notifyListeners(); }
  }

  void dismissNotice() {
    if (_disposed || _noticeTicket == null || hasPersistentFailures) return;
    _noticeTicket = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _quietTimer?.cancel();
    super.dispose();
  }
}
