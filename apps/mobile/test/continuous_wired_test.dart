// Card CR-9 — is the continuous-recording feature WIRED, and does every exit
// really let go of it?
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/chat_flow_continuous.dart (the routing)
//   apps/mobile/lib/src/ptt/ptt_continuous.dart (begin / end / the cap edge)
//   task unit §6 C8 (「continuous recording ends, including abnormally ⇒ the
//     screen hold is definitely released」 — pinned per exit path)
//
// 🔴 WHY THIS FILE EXISTS SEPARATELY FROM THE BEHAVIOURAL TESTS. Three cards —
// CR-2 (screen), CR-3 (keep the mic through a link death) and CR-6 (the
// ceiling) — shipped complete, tested and UNREACHABLE, because the flag they
// all hang off had no producer. Every one of their suites was green the whole
// time. A green unit suite is worth nothing against 「is anybody calling this」,
// which is what the anti-façade rule says and what this file measures.
//
// Greps, deliberately, and not mocks: the question is whether PRODUCTION source
// reaches these, and only production source can answer it.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Production source with COMMENT LINES REMOVED.
///
/// 🔴 THE TRAP `chat_clear_history_button_test.dart` ALREADY NAMES: searching raw
/// source means commenting the call out leaves every assertion here green. A
/// guard that reads comments as code is not a guard — and this file is nothing
/// but such searches, so it strips first.
///
/// ⚠️ Line-level only (`//` at the start of a trimmed line). That is enough for
/// this repo's style and it is deliberately not a parser: a half-clever stripper
/// that mangled a string literal containing `//` would be a ruler with its own
/// bugs, which is worse than a blunt one whose limits are written down.
String _read(String rel) {
  final File f = File(rel);
  expect(f.existsSync(), isTrue,
      reason: 'positive control: run from apps/mobile or this file is blind — $rel');
  return f
      .readAsLinesSync()
      .where((String l) => !l.trimLeft().startsWith('//'))
      .join('\n');
}

/// Clamp an index to the string, so a window running past the end is a smaller
/// window rather than a crash. (It already was one: stripping comments shortens
/// every file, and a fixed 1600-character window then threw a RangeError — a
/// ruler that broke, reported as if it were a finding.)
int _cap(String s, int i) => i < s.length ? i : s.length;

void main() {
  test('🔴 the composition root supplies the account, or there is no feature', () {
    // The dock asks `widget.cloudSummary`, and a null there means 「this build
    // does not offer continuous recording」 — a correct answer for a standalone
    // instance, and a silent total loss if main.dart simply forgot. That is the
    // difference between a deliberate absence and an omission, and only the
    // composition root can tell them apart.
    final String main = _read('lib/main.dart');
    expect(main.contains('cloudSummary: _cloudSummary,'), isTrue,
        reason: 'without this line the entry never appears for anybody, and '
            'every test in this lane stays green');
  });

  test('🔴 the entry is reached from the dock, not merely defined', () {
    final String composer = _read('lib/src/ui/chat_flow_composer.dart');
    expect(composer.contains('_continuousEntryRouted('), isTrue,
        reason: 'CR-2, CR-3 and CR-6 were all complete and unreachable for a '
            'day because nothing called the thing that turns them on. This is '
            'the call that ends that.');
    expect(composer.contains('_continuousLiveRouted('), isTrue,
        reason: 'and the in-progress face, or a continuous recording would '
            'start with no way to stop it');
  });

  test('🔴 the flag goes up BEFORE the capture starts', () {
    // Between `beginContinuous` and `pttDown` a link death would reach
    // ptt_link_loss.dart, which decides whether to keep the microphone by
    // reading exactly that flag. Reversed, there is a window in which a
    // continuous recording is torn down as though it were an ordinary press.
    final String src = _read('lib/src/ui/chat_flow_continuous.dart');
    final int begin = src.indexOf('beginContinuous(');
    final int down = src.indexOf('_pttDownRouted(s)');
    expect(begin, greaterThan(0));
    expect(down, greaterThan(begin),
        reason: 'begin must come first — see ptt_link_loss.dart for what reads '
            'the flag in between');
  });

  test('🔴 a refused press does not leave the three facts switched on', () {
    // No recorder started ⇒ no recorder transition ⇒ nothing clears the flag
    // for us. The ceiling would fire minutes later and announce a limit nobody
    // reached, on a screen that had stayed lit the whole time.
    final String src = _read('lib/src/ui/chat_flow_continuous.dart');
    final int down = src.indexOf('_pttDownRouted(s)');
    expect(src.substring(down).contains('endContinuous()'), isTrue,
        reason: 'the failure branch after a refused pttDown must let go');
  });

  test('🔴 the teardown runs AFTER the predicate that reads what it tears down',
      () {
    // 🔴 THIS ONE IS A SCAR. The first cut of this card put `endContinuous()` on
    // pttUp's FIRST line, above `stopContinuousOffline()`. That call clears
    // `continuous.isActive`; the offline branch reads it to decide whether this
    // is a continuous recording at all. So it answered false, the next guard
    // returned on a `disconnected` session, and the microphone was never
    // stopped — §11-c's ZOMBIE MICROPHONE, rebuilt while tidying the teardown
    // into one place.
    //
    // `ptt_continuous_link_loss_test.dart` ②b caught it, which is the same
    // assertion that caught the original. This case is here so the ORDER itself
    // is pinned, not only the behaviour: a future reader looking at two
    // adjacent lines has no way to see that one destroys the other's input.
    final String edges = _read('lib/src/ptt/ptt_edges.dart');
    final int up = edges.indexOf('Future<void> pttUp() async {');
    expect(up, greaterThan(0));
    // Clamped: the comment stripper makes the file shorter than a fixed
    // window assumes, and a RangeError is a ruler that broke rather than a
    // finding.
    final String body = edges.substring(up, _cap(edges, up + 1600));
    final int offline = body.indexOf('if (stopContinuousOffline()) return;');
    final int teardown = body.indexOf('    endContinuous();');
    expect(offline, greaterThan(0), reason: 'positive control: found the branch');
    expect(teardown, greaterThan(0), reason: 'positive control: found the teardown');
    expect(teardown, greaterThan(offline),
        reason: 'endContinuous() clears the flag stopContinuousOffline() reads. '
            'Above it, a continuous recording that outlived its link cannot be '
            'stopped by the user at all.');
  });

  test('🔴 C8: every exit path releases — all five, by name', () {
    // Each entry is (file, the function the call must sit inside). The
    // containment check is what makes this more than a substring count: a call
    // in a comment or in an unrelated method would satisfy a bare `contains`.
    const Map<String, String> exits = <String, String>{
      // the user's stop, and the funnel every other release runs through
      'lib/src/ptt/ptt_edges.dart': 'Future<void> pttUp() async {',
      // the recorder dying under a live recording
      'lib/src/ptt/ptt_capture_pump.dart': 'void _onCaptureFault(String code) {',
      // the session going away
      'lib/src/ptt/ptt_session_dispose.dart': 'Future<void> _disposeRouted() async {',
    };
    exits.forEach((String rel, String anchor) {
      final String src = _read(rel);
      final int at = src.indexOf(anchor);
      expect(at, greaterThan(0), reason: 'positive control: $rel / $anchor');
      // The next 900 characters cover each of these short bodies; a release
      // that drifted out of the function would fall outside this window.
      final int end = _cap(src, at + 900);
      expect(src.substring(at, end).contains('endContinuous()'), isTrue,
          reason: '$rel: this exit leaves the screen lit and the ceiling armed '
              'for a recording that is already over');
    });

    // Exit 4 — cancel. Contractually unreachable for a continuous recording
    // (CR-D ③ ships no cancel gesture), and wired anyway: 「unreachable」 is a
    // claim about call sites, and call sites move.
    final String edges = _read('lib/src/ptt/ptt_edges.dart');
    final int cancel = edges.indexOf('Future<void> pttCancel() async {');
    expect(cancel, greaterThan(0));
    expect(edges.substring(cancel).contains('endContinuous()'), isTrue);

    // Exit 2 — the ceiling itself, which goes through `pttUp` rather than
    // repeating the teardown. Asserted as the ROUTE, not as another call.
    final String cont = _read('lib/src/ptt/ptt_continuous.dart');
    final int capStop = cont.indexOf('Future<void> stopForContinuousCap() async {');
    expect(capStop, greaterThan(0));
    expect(cont.substring(capStop).contains('await pttUp();'), isTrue,
        reason: 'the ceiling must take the ORDINARY release — a fence would '
            'discard the last segment of a half-hour recording');
  });

  test('🔴 the ceiling stop reports its own reason, never a borrowed one', () {
    final String src = _read('lib/src/ptt/ptt_continuous.dart');
    expect(src.contains('kLocalStopReasonContinuousCap'), isTrue);
    // W8-4: after this stop, pressing again works; after quota exhaustion it
    // does not. Two opposite next steps must never share a sentence.
    expect(src.contains("'quota_exhausted'"), isFalse);
    expect(src.contains("'hard_limit'"), isFalse);
  });

  test('🔴 the reminder has a reader, or the ceiling arrives unannounced', () {
    // The timer fires, the ticket goes up — and if nothing on any screen reads
    // it, the recording simply stops one minute later with no warning at all.
    // This is fix-026's sentence applied to a second field: this file is
    // 「where each primitive comes from」, so a primitive nobody reads from here
    // does not exist as far as the user is concerned.
    final String sources = _read('lib/src/ui/chat_banner_sources.dart');
    expect(sources.contains('capTimer.warningTicket'), isTrue);
    expect(sources.contains('onDismissContinuousCapWarning'), isTrue);

    // And it must be EVENT-type — owner §5-4. Registered with the auto-hide
    // reconciler is what makes that a mechanism rather than an intention.
    final String timers = _read('lib/src/session/chat_transient_banner_timers.dart');
    expect(timers.contains('BannerIds.continuousCapWarning'), isTrue,
        reason: 'unregistered ⇒ a standing 「1:00 left」 bar, which is exactly '
            'what owner ruled against');
  });

  test('🔴 the tablet arrangement and the entry cannot both be on screen', () {
    // The entry lives only in the phone branch, and that is safe ONLY because
    // two predicates agree: the offer needs a record-only destination, and
    // `_dockTwoColumnRouted` refuses to two-column for exactly that
    // destination. Pinned here because it is a fact about two things agreeing,
    // and either could be edited alone.
    final String composer = _read('lib/src/ui/chat_flow_composer.dart');
    final int two = composer.indexOf('bool _dockTwoColumnRouted(');
    expect(two, greaterThan(0));
    expect(composer.substring(two, two + 300).contains('!s.controller.destination.isRecordOnly'),
        isTrue,
        reason: 'if the tablet dock ever two-columns for a record-only '
            'destination, the continuous entry silently disappears on tablets');

    final String offer = _read('lib/src/audio/continuous_offer.dart');
    expect(offer.contains('if (!recordOnly) return _absent;'), isTrue,
        reason: 'the other half of the same agreement');
  });
}
