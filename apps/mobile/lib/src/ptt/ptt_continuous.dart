// Part of ptt_session.dart — THE CONTINUOUS-RECORDING LIFECYCLE.
//
// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.B② (the phone enforces, the server issues the number), §4.G (screen),
//     §6 C1 / C1b / C8
//   apps/mobile/lib/src/audio/continuous_cap_timer.dart (the clock)
//   apps/mobile/lib/src/audio/screen_wake.dart (the hold)
//   apps/mobile/lib/src/audio/local_stop_reasons.dart
//     (`kLocalStopReasonContinuousCap`, and the W8-4 account for why it is
//      neither `hard_limit` nor `quota_exhausted`)
//
// ── 🔴 ONE BEGIN, ONE END, BECAUSE C8 IS A CLAIM ABOUT *EVERY* EXIT ─────────
//
// Three things turn on together when a continuous recording starts — the flag
// (CR-3's link-loss behaviour), the screen hold (CR-2) and the ceiling's clock
// (CR-6) — and criterion C8 asks that all three be off again on every path that
// ends one, INCLUDING the abnormal ones. Three separate call sites at each of
// five exits is fifteen chances to forget one, and the one that gets forgotten
// is the wake lock, whose symptom is a battery reading somebody notices a week
// later.
//
// ⇒ [beginContinuous] and [endContinuous]. `endContinuous` is idempotent and
// deliberately CHEAP, so the exits can call it without first asking whether
// this was a continuous recording at all: `pttUp` runs it on every ordinary
// release too, where all three verbs are no-ops.
//
// The five exits, each wired and each named in a test:
//   · the user's stop            → `pttUp` (ptt_edges.dart), first line
//   · the ceiling                → [stopForContinuousCap], below
//   · the recorder dying         → `_onCaptureFault` (ptt_capture_pump.dart)
//   · cancel                     → `pttCancel`, contractually inert for
//                                  continuous (CR-D ③), belt-and-braces anyway
//   · the session going away     → `_disposeRouted` (ptt_session_dispose.dart)
//
// ⚠️ THE LINK DYING IS NOT ON THAT LIST, AND THAT IS CR-3's WHOLE POINT: a
// continuous recording SURVIVES a link death (the microphone stays open and the
// retention layer catches the audio). It ends later, through the user's stop —
// which is what `stopContinuousOffline` exists to serve.
//
// ── 🔴 THE CEILING IS ENFORCED HERE AND ISSUED ELSEWHERE ────────────────────
//
// The number is `/api/cloud/summary`'s `continuous_minutes` —
// `PLAN_LIMITS.continuous_minutes` resolved through the SAME solver the server
// enforces quota with, never a tier name looked up on this phone. That is C1b:
// `permanent_free` (the owner's own account) reports its plan as 'free' and its
// NUMBERS as the max tier's, so a phone deciding 「free ⇒ 10」 would give the one
// person who has to record for thirty minutes exactly ten.
//
// ⚠️ IT IS A CLIENT-SIDE CEILING, WHICH IS A CALCULATED TRADE (§4.B②). A
// modified client can ignore it; what it then spends is its own monthly quota,
// which the server enforces. Hard server enforcement would cost a new
// `audio:start` field and a new closed-enum stop reason — a protocol gate, and
// a relay-before-APK deployment.

part of 'ptt_session.dart';

extension PttSessionContinuous on PttSession {
  /// 🔴 DEFECT D-1b — THE EDGE 「the microphone just closed」, for the deferrals
  /// that had nowhere to be re-pulled from.
  ///
  /// Round four's D-1 fix made two exits DEFER while a capture is live, and a
  /// deferral is only as good as the thing that re-asks it. Two of the three
  /// exits ride the controller's notify, which re-fires on its own; the third
  /// (`_maybeLeaveOnPcReleasedRouted`) rides `PcReleaseCooldown.tick`, which is
  /// bumped exactly once, by the `mobile:released` event itself. Deferring
  /// there without this edge would have been an exit that never happens —
  /// which is why R4F left it open rather than guessing.
  ///
  /// ⚠️ ONE PRODUCER, NOT ONE PER CONSUMER. It is bound to the recorder's own
  /// transition stream, the same source [ContinuousRecording] clears its flag
  /// on, so 「a capture ended」 cannot come to mean two slightly different
  /// moments in two layers. The consumers are [PttSession.captureStopped] (the
  /// reconnect ladder's deferred give-up, `chat_link_watch.dart`) and the poke
  /// below.
  ///
  /// ⚠️ IT FIRES ON EVERY RECORDER STOP, INCLUDING ORDINARY PUSH-TO-TALK. That
  /// is why every consumer re-asks [continuousStillCapturing] instead of
  /// treating this as 「a long recording ended」: this says only 「the answer may
  /// have changed」.
  void wireCaptureEndedEdge() {
    _recorderStateSub = audio.state.listen((RecorderState s) {
      if (s != RecorderState.stopped) return;
      captureStopped.value += 1;
      // The PC-release exit rides `releaseCooldown.tick` and nothing else, so
      // its deferral is re-pulled by poking that same notifier rather than by
      // giving the page a second listener it has no room for (the page file is
      // one line under its cap).
      releaseCooldown.repoll();
    });
  }

  /// 🔴 THE RECORDING THE USER IS MAKING RIGHT NOW — 「哪一篇正在被录」.
  ///
  /// Two halves, and BOTH are required, which is why this getter exists rather
  /// than either input being read directly by a screen:
  ///   · [ArticleScribe.liveArticleId] says WHICH article rows are being filed
  ///     under. It stays non-null past the stop button ON PURPOSE — the last
  ///     sentence settles after the recorder has closed, and it belongs in its
  ///     own recording (the scribe is closed by the next `pttDown`, not by
  ///     `endContinuous`);
  ///   · [ContinuousRecording.isActive] says WHETHER a continuous capture is
  ///     running. It is the same flag the in-progress bar is drawn from.
  ///
  /// Asking the scribe alone gets 「still recording」 wrong for as long as the
  /// scribe stays open after 停止 — measured while writing
  /// `article_screen_test.dart`: a finished recording never collapsed into its
  /// card, which is the SAME product symptom this window was opened to fix,
  /// arriving through a different door.
  String? get recordingArticleId =>
      continuous.isActive ? articles.liveArticleId : null;
  /// Mark this capture continuous, hold the screen, and start the ceiling's
  /// clock for [cap].
  ///
  /// [onWarning] fires once, [kContinuousCapWarningLead] before the end. It is
  /// the CALLER's: this layer has no idea what a banner is, and a session
  /// reaching into the UI would be the wrong dependency in the direction that
  /// is hardest to undo.
  ///
  /// ⚠️ ORDER IS THE CALLER'S PROBLEM AND IT HAS TWO HALVES. The flag must be
  /// set BEFORE capture starts — a link that dies in between would otherwise
  /// tear the microphone down — and the clock must not outlive a capture that
  /// never began, so a refused `pttDown` has to call [endContinuous]. Both are
  /// pinned by the entry's own wiring test.
  ///
  /// Returns the ARTICLE ID this recording will write under. The caller needs
  /// it because it is also the retained-audio session key (CR-4): the same
  /// string names 「which recording」 for the rows and for the bytes, so an
  /// outage's audio cannot end up filed under a recording that was not running.
  ///
  /// 🔴 RETURNS NULL AND DOES NOTHING WHEN A CAPTURE IS ALREADY RUNNING —
  /// DEFECT D-3 (round-four device drill, 2026-09-06). With an orphaned
  /// recording still live (defect D-1), pressing 「开始录音」 again minted a new
  /// article id and drew a fresh 「29:42 left」 session — while
  /// `AudioCapture.start()` returned early on `_state == recording`, so NO new
  /// journal was opened and the second sitting's audio was appended to the
  /// FIRST article's PCM file. Measured: 38,912,000 -> 40,115,200 B with no new
  /// file, and pressing Stop closed the ORIGINAL article. Every offset computed
  /// for the second recording is wrong, and there is no way to tell afterwards.
  ///
  /// ⚠️ THE REFUSAL BELONGS HERE, NOT ONLY AT THE ENTRY. D-1 removes the
  /// screen's only route into this state, so the entry is already unreachable —
  /// but 「unreachable」 is a claim about call sites and those move, and what
  /// this one costs when it comes back is a corrupted recording rather than a
  /// wasted tap. The article id is minted on the FIRST line of the old body, so
  /// a refusal that arrived any later would already have rolled the scribe.
  String? beginContinuous({
    required Duration cap,
    required void Function() onWarning,
  }) {
    if (continuousStillCapturing) {
      diag('audio.continuous.begin_refused', <String, Object?>{
        'reason': 'already_capturing',
        'recorder': audio.currentState.name,
        'article': articles.liveArticleId,
      });
      return null;
    }
    // FIRST, and before the flag: the id has to exist before a byte is
    // captured, because the retention layer keys its files by it.
    final String articleId = articles.begin();
    diag('audio.continuous.begin', <String, Object?>{
      'cap_ms': cap.inMilliseconds,
      'article': articleId,
    });
    audio.retainedAudio?.beginSession(articleId);
    continuous.begin();
    unawaited(screenWake.hold());
    capTimer.arm(
      cap: cap,
      onWarning: onWarning,
      onCap: () => unawaited(stopForContinuousCap()),
    );
    return articleId;
  }

  /// Turn all three back off. Idempotent, cheap, and safe on a capture that was
  /// never continuous — see the header for why that matters more than it looks.
  /// 🔴 AND IT DELIBERATELY DOES **NOT** CLOSE THE SCRIBE. Read this before
  /// "fixing" the asymmetry — it looks exactly like the C8 bug and is its
  /// opposite.
  ///
  /// A recording's LAST segment settles AFTER the button is released: `pttUp`
  /// sends `audio:stop` and the terminal `stt:final` comes back afterwards.
  /// Closing the scribe here dropped that final sentence out of its own
  /// article — measured, three rows spoken and two filed. Same shape as §11-c:
  /// a teardown running ahead of something that still reads what it tears down,
  /// which this file already paid for once with the zombie microphone.
  ///
  /// ⇒ the scribe is closed by whatever is about to mint rows that must NOT be
  /// in the recording — `pttDown` on an ordinary press, [beginContinuous] on
  /// the next recording, and `dispose`. Nothing else can mint a row, so a
  /// scribe left open between two presses cannot stamp anything.
  ///
  /// ⚠️ THE THREE VERBS ABOVE ARE STILL C8, UNCHANGED. They hold real
  /// resources — a wake lock, a timer, a flag the link-loss edge reads — and
  /// every one of them must be off on every exit. The scribe holds a string.
  void endContinuous() {
    capTimer.disarm();
    continuous.end();
    audio.retainedAudio?.endSession();
    unawaited(screenWake.release());
  }

  /// End a continuous recording because it reached this account's ceiling.
  ///
  /// 🔴 THE ORDINARY RELEASE, NOT A FENCE. `pttUp()` flushes the residual tail,
  /// sends `audio:stop`, and waits for the terminal final — so the last thing
  /// said lands as the last segment. `fenceAndStop()` means 「this utterance
  /// never happened」 and would throw that segment away, while the copy this
  /// edge raises says the recording was saved: a sentence like that sitting on
  /// top of a fence is precisely the unbacked promise 15 册 §2.0-b bans.
  ///
  /// 🔴 AND IT REPORTS ITS OWN REASON RATHER THAN BORROWING ONE. `hard_limit`
  /// and `quota_exhausted` are both already on this stream and both would read
  /// plausibly here — and both would be wrong in the way W8-4 records: after
  /// THIS stop, pressing again works; after `quota_exhausted` it does not. Two
  /// opposite next steps must never share a sentence.
  Future<void> stopForContinuousCap() async {
    // The FSM check first: by the time a timer fires the user may have stopped
    // the recording themselves. Announcing a ceiling nobody reached would be a
    // fabricated state, and this is the one place it could be invented.
    if (fsm.session != SessionState.recording) {
      // 🔴 DEFECT D-2 — 「the session is not RECORDING」 AND 「there is no
      // recording」 ARE TWO QUESTIONS, AND THIS LINE USED TO ANSWER THE SECOND
      // WITH THE FIRST. CR-3 invented a state in which they disagree: the link
      // dies, the drop grace expires, the FSM says `disconnected`, and the
      // microphone is deliberately still open. Measured on device
      // (round-four drill, `.local/session-2026-09-06-durability-drill-r4`):
      // `13:37:28.611 audio.continuous.cap_stale session=disconnected` — the
      // 30-minute ceiling fired, was discarded, and the recording ran 5m44s
      // further until it was stopped by hand. Nothing would have stopped it.
      //
      // ⇒ ask the recorder, not the socket. The ceiling is a LOCAL clock over
      // a budget this phone was handed at the start, so an outage may not
      // raise it; the server's meter stays the second enforcer for the case
      // where there IS a link.
      if (_stopAtCeilingWithoutLink()) return;
      diag('audio.continuous.cap_stale', <String, Object?>{'session': fsm.session.name});
      return;
    }
    diag('audio.continuous.cap_reached', const <String, Object?>{});
    // `pttUp` runs `endContinuous()` on its first line, so the flag, the hold
    // and this very timer are all released by the call below. Nothing to undo
    // here afterwards.
    await pttUp();
    if (!_autoStoppedCtl.isClosed) {
      _autoStoppedCtl.add(kLocalStopReasonContinuousCap);
    }
  }

  /// Defect D-2 — the ceiling, enforced with no link. Returns whether it ended
  /// anything, so the caller can fall through to `cap_stale` when there really
  /// was no recording left to end.
  ///
  /// ── 🔴 WHY THE CEILING MAY NOT BE DEFERRED, EVER ────────────────────────
  ///
  /// `continuous_minutes` is a plan item (owner 2026-08-29: free 10, pro/max
  /// 30) and the phone already holds the number — it was handed over by
  /// `/api/cloud/summary` BEFORE the first byte and pinned into
  /// [ContinuousCapTimer.armedCap] for exactly this reason. Nothing about
  /// enforcing it needs a connection, and the case in which the link is gone is
  /// the case that produces the most unbilled audio.
  ///
  /// ⚠️ THE BUDGET IS THE ONE KNOWN AT THE START, NEVER A LONGER ONE. That is
  /// what `cap_stale` was protecting and it is preserved here: CR-Q has the
  /// SERVER re-read the month's balance mid-recording, so a ceiling re-derived
  /// on this phone from a later account read could only ever move the deadline
  /// out. This path does not re-derive anything — it fires on the clock armed
  /// by [beginContinuous] and stops.
  ///
  /// ── WHY NOT `pttUp()`, AND WHY NOT [stopContinuousOffline] ──────────────
  ///
  /// `pttUp` would emit `audio:stop` into a dead socket and move the FSM out of
  /// a state it is not in (the argument is written out in
  /// [stopContinuousOffline]'s own doc). [stopContinuousOffline] is the right
  /// SHAPE and the wrong SENTENCE: it reports the link-loss reason, and the
  /// user's next step after a ceiling ("press again — this resets") is the
  /// opposite of the one after a link death. Two endings, two reasons — W8-4.
  ///
  /// ⚠️ It accepts a `paused` recorder as well as a recording one. A
  /// backgrounded app parks the recorder and resumes it when the user comes
  /// back, so refusing here would defer the ceiling until the phone happened
  /// to be in the foreground — the same deferral this defect is about, through
  /// a second door.
  bool _stopAtCeilingWithoutLink() {
    if (!continuousStillCapturing) return false;
    final RecorderState was = audio.currentState;
    final bool kept = audio.stopKeepingTail(reason: JournalInterrupt.capReached);
    // `pttUp` — the heartbeat's only other stopper — will never run for this
    // recording, and a surviving timer would resume emitting keepalives for a
    // session that no longer exists the moment the socket returns.
    _stopHeartbeat();
    endContinuous();
    diag('audio.continuous.cap_reached_offline', <String, Object?>{
      'kept': kept,
      'recorder_was': was.name,
      'session': fsm.session.name,
    });
    if (!_autoStoppedCtl.isClosed) {
      _autoStoppedCtl.add(kLocalStopReasonContinuousCap);
    }
    return true;
  }

  /// Is a continuous capture still running on THIS phone, whatever the link is
  /// doing?
  ///
  /// 🔴 ONE PREDICATE, THREE DEFECTS. Round four found the same disagreement
  /// three times over — the ceiling deferred it (D-2), the page navigated away
  /// from it (D-1) and a second 「start」 walked straight into it (D-3) — and
  /// every one of them was some layer asking the SESSION whether a recording
  /// was running. Since CR-3 the session is not the authority on that: the flag
  /// and the recorder are, and they outlive the link on purpose.
  ///
  /// ⚠️ DIFFERENT FROM [continuousCapturingOffline], WHICH IS NARROWER AND MUST
  /// STAY SO. That one is a licence to say a sentence about retention, so it
  /// additionally demands a live spill and a down uplink, and it refuses
  /// `paused`. This one answers 「is the microphone this phone's problem right
  /// now?」, and a parked recorder still is.
  bool get continuousStillCapturing {
    if (!continuous.isActive) return false;
    final RecorderState rec = audio.currentState;
    return rec == RecorderState.recording || rec == RecorderState.paused;
  }
}
