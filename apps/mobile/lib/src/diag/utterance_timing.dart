// NR118-2: durations on ONE monotonic clock, never wall-clock joins or text.
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import '../stt/stt_stream.dart';
import 'diag_log.dart';

enum UtteranceMark {
  press,
  release,
  stopEmit,
  finalRx,
  painted,
  composeStart,
  composeDone,
  enqueueStart,
  persisted,
  enqueueDone,
  injectEmit,
  resultRx;

  String get wire =>
      name.replaceAllMapped(RegExp(r'[A-Z]'), (m) => '_${m[0]!.toLowerCase()}');
}

class UtteranceTiming {
  UtteranceTiming({
    required this.mode,
    required this.policy,
    required this.delivery,
    required this.route,
    int Function()? clock,
    this.frameHook = scheduleFrame,
    this.onClosed,
    Duration deadline = const Duration(seconds: 60),
  }) {
    final Stopwatch watch = Stopwatch()..start();
    _clock = clock ?? (() => watch.elapsedMilliseconds);
    mark(UtteranceMark.press);
    _deadline = deadline;
  }

  final String mode, policy, delivery, route;
  final void Function(void Function()) frameHook;
  final void Function()? onClosed;
  late final int Function() _clock;
  late final Duration _deadline;
  final Map<UtteranceMark, int> _marks = <UtteranceMark, int>{};
  final Map<int, int> _segments = <int, int>{};
  Timer? _timer;
  String _tcorr = '-', _polish = 'off';
  bool _closed = false, _finishing = false;
  bool _frameScheduled = false;

  static void scheduleFrame(void Function() callback) =>
      SchedulerBinding.instance.addPostFrameCallback((_) => callback());

  void mark(UtteranceMark mark) {
    if (_closed) return;
    _marks.putIfAbsent(mark, _clock);
    if (mark == UtteranceMark.release) {
      _timer ??= Timer(_deadline, () => close(incomplete: true));
    }
  }

  void finalReceived(SttFinal f) {
    if (_closed || _marks.containsKey(UtteranceMark.finalRx)) return;
    _segments[f.segmentIdx] = f.durationMs;
    if (f.isSegment) return;
    final String? id = f.utteranceId;
    _tcorr = id != null && RegExp(r'^[0-9a-f]{16}$').hasMatch(id)
        ? id.substring(0, 6)
        : '-';
    _polish = f.polish == SttPolish.skipped
        ? 'skipped:${kSttPolishReasons.contains(f.polishReason) ? f.polishReason : 'unknown'}'
        : f.polish == SttPolish.applied
        ? 'applied'
        : 'off';
    mark(UtteranceMark.finalRx);
  }

  void painted() {
    if (_frameScheduled) return;
    _frameScheduled = true;
    frameHook(() {
      mark(UtteranceMark.painted);
      if (_finishing) close();
    });
  }

  // Wait for the already-scheduled frame so a fast receipt / local settlement
  // does not discard V2. The deadline still bounds a backgrounded app.
  void finish() {
    if (_closed) return;
    _finishing = true;
    if (_marks.containsKey(UtteranceMark.painted)) close();
  }

  // A terminal final can repeat the last already-delivered segment index.
  // The FSM has finished, but settlement correctly mints no second request.
  void settleWithoutInject() {
    painted();
    finish();
  }

  void close({bool incomplete = false}) {
    if (_closed) return;
    _closed = true;
    _timer?.cancel();
    final int? release = _marks[UtteranceMark.release];
    String? member(String value, Set<String> allowed) =>
        allowed.contains(value) ? value : null;
    final Map<String, Object?> fields = <String, Object?>{
      'tcorr': _tcorr,
      'mode': member(mode, <String>{'realtime', 'translate', 'organize'}),
      'policy': member(policy, <String>{'direct', 'manual'}),
      'delivery': member(delivery, <String>{'inject', 'none'}),
      'route': member(route, <String>{'lan', 'cloud'}),
      'polish': _polish,
      'audio_ms': _segments.isEmpty
          ? null
          : _segments.values.fold<int>(0, (a, b) => a + b),
      'segs': _segments.length,
      for (final UtteranceMark m in UtteranceMark.values)
        '${m.wire}_ms': release == null || _marks[m] == null
            ? null
            : _marks[m]! - release,
      if (incomplete) 'open': _marks.keys.last.wire,
    };
    diag('utt.timing', fields);
    // Not assert/kDebugMode guarded: Android Logger_PrintString reaches
    // settings.log_message_callback (__android_log_print) in release too.
    _emitUtteranceTiming(fields);
    onClosed?.call();
  }
}

// Kept separate from the formatter to make the platform reach auditable.
void _emitUtteranceTiming(Map<String, Object?> fields) {
  final String line =
      'utt.timing ${fields.entries.map((e) => '${e.key}=${e.value}').join(' ')}';
  debugPrint('FMTIMING $line');
}

/// Per-session ownership. Request ids never enter the formatter or either log.
class UtteranceTimings {
  void Function(void Function()) frameHook = UtteranceTiming.scheduleFrame;
  UtteranceTiming? active;
  final Map<String, UtteranceTiming> _requests = <String, UtteranceTiming>{};
  final Set<UtteranceTiming> _pending = <UtteranceTiming>{};

  void begin({
    required String mode,
    required String policy,
    required String delivery,
    required String route,
  }) {
    late final UtteranceTiming timing;
    timing = UtteranceTiming(
      mode: mode,
      policy: policy,
      delivery: delivery,
      route: route,
      frameHook: frameHook,
      onClosed: () {
        _pending.remove(timing);
        _requests.removeWhere((_, value) => identical(value, timing));
        if (identical(active, timing)) active = null;
      },
    );
    active = timing;
    _pending.add(timing);
  }

  void bind(String requestId) {
    final UtteranceTiming? timing = active;
    if (timing != null) _requests[requestId] = timing;
  }

  UtteranceTiming? forRequest(String requestId) => _requests[requestId];
  void persisted(String requestId) =>
      forRequest(requestId)?.mark(UtteranceMark.persisted);
  void result(String? requestId) {
    final UtteranceTiming? timing = _requests[requestId];
    if (timing == null) return;
    timing.mark(UtteranceMark.resultRx);
    timing.finish();
  }

  void dispose() {
    for (final UtteranceTiming t in _pending.toList()) {
      t.close(incomplete: true);
    }
  }
}
