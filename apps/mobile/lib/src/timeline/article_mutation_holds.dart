// NR-115: delay destructive/forward actions until the existing live stop wait
// has concluded. The owner is the controller, never an article route.
import 'dart:async';

class ArticleMutationHolds {
  final Map<Object, String> _owners = {};
  final Map<String, Completer<void>> _held = {};

  void set(Object owner, String? articleId) {
    _owners.remove(owner);
    if (articleId != null) _owners[owner] = articleId;
    final Set<String> active = _owners.values.toSet();
    for (final String id in _held.keys.toList()) {
      if (!active.contains(id)) _held.remove(id)!.complete();
    }
    for (final String id in active) {
      _held.putIfAbsent(id, Completer<void>.new);
    }
  }

  bool contains(String? id) => _held.containsKey(id);
  bool get isNotEmpty => _held.isNotEmpty;
  Future<void> waitFor(String? id) => _held[id]?.future ?? Future<void>.value();
  Future<void> waitForAll() => Future.wait(_held.values.map((c) => c.future));
}
