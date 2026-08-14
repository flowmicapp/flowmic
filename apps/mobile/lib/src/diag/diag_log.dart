// SPEC-REF:
//   apps/server-core/src/http/diag-routes.ts (POST /api/diag/mobile)
//   CLAUDE.md red line: no silent failures / no live production data enters this repo
//
// owner 2026-07-29:「对于手机侧你可以增加远程同步手机日志的功能，以便诊断，手机拿
// 日志不方便」("For the phone side you could add a feature to remotely sync the
// phone's logs, for diagnostics — getting logs off the phone by hand is inconvenient").
//
// Every hard bug this window cost a day had the same shape: the PC's half of the
// story was on disk and the PHONE's half existed only on a device that needs a
// USB cable and a laptop to read. 「电脑没有回应」("The computer isn't responding")
// is exactly the case where the
// missing half is the one that decides the answer — did the frame ever leave?
//
// WHAT GOES IN HERE, and what must never:
//   · IN — connection edges, emit outcomes, sizes, request ids, error codes,
//     watchdog firings: the mechanical trail of a delivery.
//   · NEVER — transcript text, typed text, image bytes, thumbnails, tokens.
//     The log is uploaded to the PC on request, so anything written here leaves
//     the phone. `note()` takes a fixed event name plus scalar fields, which is
//     the shape that makes 「someone pasted a sentence in」 hard to do by accident.
//
// The buffer is bounded and in-memory: a diagnostic trail that survives reboots
// is a data-retention decision nobody made.

import 'dart:collection';

/// How many lines to keep. A single send is ~10 lines; 400 covers a long
/// session's worth of edges without holding a transcript's worth of memory.
const int kDiagCapacity = 400;

/// One process-wide trail. A singleton because the point is that every layer
/// (socket, compose gate, delivery, image) writes into the SAME sequence — an
/// ordering across layers is most of what makes a trail readable.
class DiagLog {
  DiagLog._();

  static final DiagLog instance = DiagLog._();

  final Queue<String> _lines = Queue<String>();

  /// Wall-clock stamp source; injectable so tests are deterministic.
  DateTime Function() clock = DateTime.now;

  /// Record one mechanical event. [event] is a fixed name (`emit.inject`,
  /// `socket.connect`, `watchdog.fire`…) and [fields] carries scalars only —
  /// they are rendered `k=v`, so a value with a newline would break the line
  /// format and is flattened.
  void note(String event, [Map<String, Object?> fields = const <String, Object?>{}]) {
    final String stamp = clock().toUtc().toIso8601String();
    final String tail = fields.entries
        .map((MapEntry<String, Object?> e) => '${e.key}=${_scalar(e.value)}')
        .join(' ');
    _push(tail.isEmpty ? '$stamp $event' : '$stamp $event $tail');
  }

  static String _scalar(Object? v) {
    final String s = v == null ? 'null' : v.toString();
    return s.replaceAll('\n', '\\n').replaceAll('\r', '');
  }

  void _push(String line) {
    _lines.addLast(line);
    while (_lines.length > kDiagCapacity) {
      _lines.removeFirst();
    }
  }

  /// A snapshot for upload. Oldest first — the order things happened.
  List<String> snapshot() => List<String>.unmodifiable(_lines);

  int get length => _lines.length;

  void clear() => _lines.clear();
}

/// Shorthand used at call sites.
void diag(String event, [Map<String, Object?> fields = const <String, Object?>{}]) =>
    DiagLog.instance.note(event, fields);
