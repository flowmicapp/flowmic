import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/diag/utterance_timing.dart';
import 'package:flowmic/src/stt/stt_stream.dart';
import 'package:flutter_test/flutter_test.dart';

SttFinal finalFrame({
  String text = 'PRIVATE_MARKER_118',
  bool segment = false,
  String id = 'abcdef0123456789',
}) => SttFinal.tryFromJson(<String, Object?>{
  'text': text,
  'confidence': .9,
  'language': 'en',
  'segment_idx': segment ? 0 : 1,
  'is_segment': segment,
  'duration_ms': 300,
  'utterance_id': id,
  'polish': 'skipped',
  'polish_reason': 'guard_reject',
})!;

void main() {
  setUp(() => DiagLog.instance.clear());
  test(
    'one whitelisted line, release-relative clock, no text or identifiers',
    () {
      int now = 10;
      final UtteranceTiming t = UtteranceTiming(
        mode: 'realtime',
        policy: 'direct',
        delivery: 'inject',
        route: 'cloud',
        clock: () => now,
        frameHook: (callback) => callback(),
      );
      t.finalReceived(finalFrame(segment: true));
      now = 110;
      t.mark(UtteranceMark.release);
      now = 115;
      t.mark(UtteranceMark.stopEmit);
      now = 310;
      t.finalReceived(finalFrame());
      now = 320;
      t.painted();
      t.mark(UtteranceMark.resultRx);
      t.finish();
      t.close();
      expect(
        DiagLog.instance.snapshot().join('\n'),
        isNot(contains('PRIVATE_MARKER_118')),
      );
      final String line = DiagLog.instance.snapshot().single;
      expect(
        line.split('utt.timing ').last,
        'tcorr=abcdef mode=realtime policy=direct delivery=inject route=cloud '
        'polish=skipped:guard_reject audio_ms=600 segs=2 press_ms=-100 release_ms=0 '
        'stop_emit_ms=5 final_rx_ms=200 painted_ms=210 compose_start_ms=null '
        'compose_done_ms=null enqueue_start_ms=null persisted_ms=null '
        'enqueue_done_ms=null inject_emit_ms=null result_rx_ms=210',
      );
      expect(line, isNot(contains('PRIVATE_MARKER_118')));
      expect(line, isNot(contains('abcdef0123456789')));
    },
  );
  test('deadline emits once with last mark, missing values remain null', () {
    fakeAsync((async) {
      final UtteranceTiming t = UtteranceTiming(
        mode: 'realtime',
        policy: 'manual',
        delivery: 'none',
        route: 'lan',
        clock: () => async.elapsed.inMilliseconds,
        frameHook: (_) {},
      );
      t.mark(UtteranceMark.release);
      t.mark(UtteranceMark.stopEmit);
      async.elapse(const Duration(seconds: 60));
      expect(DiagLog.instance.snapshot().single, contains('open=stop_emit'));
      expect(DiagLog.instance.snapshot().single, contains('final_rx_ms=null'));
      t.finish();
      t.close();
      expect(DiagLog.instance.length, 1);
    });
  });
  test('bad metadata and ids cannot inject fields; cancel is incomplete', () {
    final UtteranceTiming t = UtteranceTiming(
      mode: 'secret text',
      policy: 'x',
      delivery: 'x',
      route: '1.2.3.4',
      frameHook: (_) {},
    );
    t.finalReceived(finalFrame(id: 'bad token\ntext=SECRET'));
    t.close(incomplete: true);
    final String line = DiagLog.instance.snapshot().single;
    expect(line, contains('tcorr=- mode=null policy=null delivery=null route=null'));
    expect(line, contains('open=final_rx'));
    expect(line, isNot(contains('SECRET')));
  });
  test('local settle waits for paint, then closes exactly once', () {
    late void Function() frame;
    final UtteranceTiming t = UtteranceTiming(
      mode: 'realtime',
      policy: 'manual',
      delivery: 'none',
      route: 'lan',
      frameHook: (callback) => frame = callback,
    );
    t.mark(UtteranceMark.release);
    t.finalReceived(finalFrame());
    t.painted();
    t.finish();
    expect(DiagLog.instance.length, 0);
    frame();
    t.finish();
    expect(DiagLog.instance.length, 1);
    expect(DiagLog.instance.snapshot().single, isNot(contains('open=')));
  });
}
