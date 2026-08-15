// AppStrings copy-catalogue shard: polish signal / recording auto-stop and
// stall banners / recording panel / PTT four states.
// The sole external entry point remains ../app_strings.dart (AppStrings
// composes this mixin via `with`;
// starting 0.2.67 the copy leaves `_lf…` are implemented by generated classes
// under l10n/, this shard keeps only logic and reasoning comments).
part of '../app_strings.dart';

mixin RecordingStrings on AppStringsLeaves {
  // The sole translation of the 「仅记录」("record only") term lives in
  // ChatStrings.recordOnly (later than this mixin in the `with` order) — this
  // only declares the signature (the same cross-shard pattern as pairError).
  String get recordOnly;

  // ── STT polish honest signal (WP-R4-6 ⑦) ────────────────────────────────
  /// Transient chat-bubble corner mark when stt:final arrives with
  /// polish:'skipped'. Delivery still happened (two-stage text); this only
  /// tells the user the LLM polish layer did not apply. Never a status five-state.
  String get polishSkipped => _lfPolishSkipped;

  // ── auto-stop fail-loud banner (R6 P0-R3 / W8-4) ─────────────────────────
  //
  // 🔴 W8-4 (card fix-020): `audio:auto-stopped` now carries WHY. The server
  // used to hard-code `reason:'hard_limit'`, so the single sentence below was
  // shown no matter what ended the recording; card N1-B4 turned the five-minute
  // wall into an engine-session rollover the user never sees, which left quota
  // exhaustion as the only trigger that still stops a recording — and made the
  // 5-minute sentence a lie in four languages at the exact moment it fired.
  //
  // The reasons are wired one-to-one with the emitter's table
  // (`apps/server-core/src/engine/stt-session-autostop.ts`), and the wire values
  // themselves are `AudioAutoStoppedSchema` in
  // `packages/protocol/src/protocol-schemas-audio.ts`.

  /// `reason: 'hard_limit'` — a real time ceiling. UNCHANGED, and deliberately
  /// so: this sentence is still exactly true for the case it was written for,
  /// and the next step it implies (「按一次接着说」/ "press once and keep
  /// talking") is the right one. 08 §B-5: a
  /// recording that stops must never silently vanish.
  String get recordingAutoStopped => _lfRecordingAutoStopped;

  /// `reason: 'quota_exhausted'` — the user is out of transcription minutes.
  ///
  /// Its own sentence rather than a reworded time limit, because the two lead
  /// somewhere different: pressing the button again works after a time ceiling
  /// and changes nothing after this one.
  ///
  /// ⚠️ NOT ONE DIGIT AND NOT ONE TIER NAME, on purpose. The minutes per plan
  /// live in `apps/server-core/src/billing/plans.ts` and this string cannot read
  /// them; a number here would be a third copy that goes stale silently (the
  /// same reason the PC-busy copy carries no device count). What IS asserted is
  /// verifiable: the budget is per calendar month —
  /// `billing/quota-guard.ts` `budget()` reads `usageRepo.get(user_id,
  /// currentMonth(clock))`.
  String get recordingAutoStoppedQuota => _lfRecordingAutoStoppedQuota;

  /// `kLocalStopReasonLinkLossKept` — the phone itself judged the recording
  /// dead (3 s drop grace expired, ptt_link_loss.dart) and the unsent tail
  /// went to the on-device retention layer.
  ///
  /// 🔴 EXACT HONESTY BOUND (design 2026-08-11 §2-R4 / volume 15 §2.0-b): the
  /// sentence states the two facts the phone can prove — the recording stopped
  /// because the connection was lost, and the recorded audio is kept on this
  /// phone — and NOTHING about transcription. The upload/re-transcription
  /// mechanism does not exist (design §6), so 「待转录」("awaiting
  /// transcription")/「稍后会补转录」("will be transcribed later") and
  /// every synonym are banned words here; a guard test greps this copy
  /// (link_loss_copy_guard_test.dart) so the ban outlives this comment.
  String get recordingStoppedLinkLossKept => _lfRecordingStoppedLinkLossKept;

  /// `kLocalStopReasonLinkLoss` — same edge, but nothing was retained (no
  /// spill wired, or the press produced zero audio). Its own sentence because
  /// the retention claim above would then be an unbacked promise — the exact
  /// shape volume 15 §2.0-b constraint 3 bans. It states only what the edge itself
  /// proves: the link died and the recording stopped.
  String get recordingStoppedLinkLoss => _lfRecordingStoppedLinkLoss;

  /// A `reason` this build has no sentence for.
  ///
  /// It states only what the event itself proves — the recording stopped by
  /// itself — and prints the raw identifier rather than inventing a cause. Same
  /// choice as the inject-verdict note makes for an unregistered error code
  /// (0.2.53): 不认识的码不给它编一句("don't make up a sentence for a code you
  /// don't recognise"). The identifier is deliberately visible, not
  /// smoothed away — the failure mode this whole family exists to prevent is a
  /// confident sentence about something nobody verified, and a build that has
  /// fallen behind the protocol should LOOK like it has.
  String recordingAutoStoppedUnknown(String reason) => _lfRecordingAutoStoppedUnknown(reason);

  /// The auto-stop banner's text for a wire `reason`.
  ///
  /// 🔴 CORRECTION (lead, 2026-08-10, hours after the paragraph below was
  /// written). What stood here read: 「NO PRODUCTION CALLER YET … `ptt_session.dart`
  /// exposes `Stream<void> get autoStopped`, `ptt_inbound.dart` pushes `null` …
  /// Until that lands, the phone shows the 5-minute sentence for EVERY
  /// auto-stop」. **Every clause of that is now false**, and it credited the
  /// widening to the wrong card (fix-016 instrumented this path for W8-3;
  /// **fix-026** widened it).
  ///
  /// Today: `autoStopped` is a `Stream<String>` carrying the wire `reason`
  /// verbatim, `ptt_inbound.dart` passes it through (absent or non-String
  /// becomes `''`, never `'hard_limit'`), and `banner_queue.dart` calls this
  /// selector. Wire-level tests drive a real frame to the rendered glyphs for
  /// every reason, and the reverse control — reverting the point of use — turns
  /// eight of them red with the five-minute sentence as the actual value.
  ///
  /// ⚠️ It is quoted rather than deleted for the reason this repo keeps saying:
  /// this doc is what the next person reads to decide whether the phone can hear
  /// the server, and an unmarked rewrite lets a retracted claim be re-derived.
  /// A doc that says 「not wired yet」 about something wired is worse than no doc —
  /// it is authoritative and wrong, and it stops the question being asked.
  ///
  /// ⚠️ ONE THING THE OLD PARAGRAPH WAS RIGHT ABOUT, and it still stands: none of
  /// this means a user sees the right sentence. Until `fix-025` landed, the
  /// server labelled a quota stop `hard_limit`, and this chain would have
  /// faithfully rendered the five-minute sentence for it. The phone renders what
  /// it is told; whether it is told the truth is the origin's question, and the
  /// end-to-end proof is device-line.
  ///
  /// Keyed on the WIRE string, not on a mirrored Dart enum: a second enum would
  /// be another hand-maintained copy of the protocol's list, and nothing binds
  /// such a copy to the registry (the open account behind the 0.2.53 defect).
  String recordingAutoStoppedMessage(String reason) {
    switch (reason) {
      case 'hard_limit':
        return recordingAutoStopped;
      case 'quota_exhausted':
        return recordingAutoStoppedQuota;
      // SEG-2 — the two LOCAL reasons (never on the wire; the `local:` prefix
      // is the collision guard, see audio/local_stop_reasons.dart). Matched on
      // the shared constants, not re-typed literals.
      case kLocalStopReasonLinkLossKept:
        return recordingStoppedLinkLossKept;
      case kLocalStopReasonLinkLoss:
        return recordingStoppedLinkLoss;
      // `mobile_disconnect` / `engine_failed` / `auth_expired` are in the schema
      // and have ZERO emitters anywhere in the server (measured 2026-08-10), so
      // they land here rather than getting invented copy — a sentence written
      // for a frame nobody sends is a façade with a translation budget.
      default:
        return recordingAutoStoppedUnknown(reason);
    }
  }

  // ── PROCESSING stall fail-loud banner (GA-03) ────────────────────────────
  /// Shown when PROCESSING closed with no terminal stt:final. The two causes
  /// are NOT collapsed into one 「识别失败」("recognition failed"): 「nothing came
  /// back」 (the 15 s local
  /// safety net fired — likely the link or the server) and 「the engine said it
  /// broke」 point the user at different things.
  String sttStallMessage(SttStallReason reason) {
    switch (reason) {
      case SttStallReason.timeout:
        return _lfSttStallMessage__1;
      case SttStallReason.engineError:
        return _lfSttStallMessage__2;
      // Deliberately NOT 「识别失败」("recognition failed"): nothing failed. The engine answered, and
      // its answer was silence — so point the user at the microphone and at
      // whether they were actually heard, not at a fault that did not happen.
      case SttStallReason.emptyTranscript:
        return _lfSttStallMessage__3;
      // A different fault and a different instruction: the mic never opened, so
      // speaking again changes nothing. Point at the permission / the device.
      case SttStallReason.captureDead:
        return _lfSttStallMessage__4;
    }
  }

  // ── ENG-3 (fix-030): the NAMED engine refusal ────────────────────────────
  //
  // The phone does not render protocol strings — this is the string MIRROR for
  // one registered code (same discipline as the inject-verdict notes, 0.2.53:
  // per-code, four languages, and an unrecognised code prints its raw
  // identifier rather than getting a sentence invented for it).

  /// `STT_CONFIG_MISSING` — the engine refused to open, by name. BOTH measured
  /// exits are named, because the phone cannot tell them apart and the frame
  /// does not say: the engine's runtime component missing from the install
  /// (sherpa addon not shipped — the P0 packaging truth) and the model files /
  /// language routing missing from the configuration. The registered protocol
  /// sentence (「该语言尚未配置识别引擎。」("no recognition engine has been
  /// configured for this language.")) covers only the router half; this
  /// mirror widens it to what the code actually reaches the wire for.
  ///
  /// ⚠️ Deliberately NOT 「on the PC」: over the cloud leg the engine runs on
  /// the relay, and a placement claim would be false there.
  String get sttStallConfigMissing => _lfSttStallConfigMissing;

  /// `STT_NO_ENGINE_REACHED` — the utterance was captured and NO speech engine
  /// ever received it (owner-approved code, ruling group #5-c 2026-08-10).
  ///
  /// 🔴 WHY THIS SENTENCE EXISTS AT ALL. Until 2026-08-12 the only stall code
  /// with a sentence here was `STT_CONFIG_MISSING`; everything else fell through
  /// to [sttStallEngineErrorCoded] and the user read a RAW IDENTIFIER. That is
  /// the 0.2.53 defect, and it was about to be re-run: the same day, the Soniox
  /// 「No audio received.」 refusal was re-pointed at THIS code (see
  /// `packages/stt-cloud/.../soniox.ts classifyNoAudio`), which would have put
  /// 「转写引擎报错（STT_NO_ENGINE_REACHED）」("transcription engine error
  /// (STT_NO_ENGINE_REACHED)") on screen.
  /// ⇒ Rule (律): re-pointing a wire code and giving it a sentence are the SAME piece of
  /// work; only the first half has a compiler behind it.
  ///
  /// Mirrors `ERROR_CODES.STT_NO_ENGINE_REACHED` (the phone cannot import TS —
  /// this mirror is hand-maintained, which is the open account named in
  /// CLAUDE.md). Leads with the ACTION because it is one the user can actually
  /// take, unlike「检查安装」("check the installation") on a machine whose
  /// install is fine.
  String get sttStallNoEngineReached => _lfSttStallNoEngineReached;

  /// `QUOTA_EXCEEDED` — the account's monthly transcription allowance is spent
  /// (QTA-1, 2026-08-15). The server refuses at the `audio:start` entry, before
  /// any engine is picked.
  ///
  /// 🔴 IT MUST NOT FALL THROUGH TO [sttStallEngineErrorCoded]. Nothing broke:
  /// the engine was never asked, the recording was fine, the network was fine.
  /// 「转写引擎报错（QUOTA_EXCEEDED）」("transcription engine error
  /// (QUOTA_EXCEEDED)") would send the user to check an engine that is in
  /// perfect health — the literal 0.2.53 / ENG-4 shape, twice repaired in this
  /// repo already, and this is the third code that would have re-run it.
  ///
  /// ⚠️ NO UPGRADE CTA, deliberately — the same restraint the LLM leg's
  /// `QUOTA_EXCEEDED` copy carries (`compose_strings.dart`). The sentence states
  /// the fact and when it lifts; a banner is not a checkout funnel.
  ///
  /// ⚠️ 「resets at the start of next month」 is a MEASURED claim, not a
  /// comforting guess: the guard reads `usage_records` keyed by
  /// `currentMonth(clock)` (server-core `db/repos/usage.repo.ts`), i.e. the
  /// calendar month — so a new month is a fresh row and a fresh budget.
  String get sttStallQuotaExceeded => _lfSttStallQuotaExceeded;

  /// An engine error whose code this build has no sentence for. States what
  /// the frame itself proves (the engine reported an error) and shows the raw
  /// identifier — never a confident cause nobody verified (0.2.53 rule), and a
  /// build that has fallen behind the protocol should LOOK like it has.
  String sttStallEngineErrorCoded(String code) => _lfSttStallEngineErrorCoded(code);

  /// The stall banner's text for a full [SttStall] event.
  ///
  /// Keyed on the WIRE code string, not a mirrored Dart enum — a second enum
  /// would be another hand-maintained copy of the protocol registry that
  /// nothing binds (the open account behind the 0.2.53 defect). Non-engine
  /// stalls and a code-less engine stall keep their existing sentences
  /// byte-for-byte ([sttStallMessage]).
  String sttStallBannerMessage(SttStall stall) {
    if (stall.reason == SttStallReason.engineError) {
      final String? code = stall.code;
      if (code == 'STT_CONFIG_MISSING') return sttStallConfigMissing;
      if (code == 'STT_NO_ENGINE_REACHED') return sttStallNoEngineReached;
      if (code == 'QUOTA_EXCEEDED') return sttStallQuotaExceeded;
      if (code != null && code.isNotEmpty) {
        return sttStallEngineErrorCoded(code);
      }
    }
    return sttStallMessage(stall.reason);
  }

  // ── card U2: mic-permission flow (ptt/mic_permission.dart, four faces) ────
  // Mirrors the camera/gallery denial pattern (pairScanDenied /
  // imageSendError's permissionDenied): NAMED, four-language, actionable.
  // Renderer: ui/mic_permission_banner.dart; wiring: chat_banner_sources.dart.

  /// U2-① rationale — shown BEFORE the first OS request ever; the banner's
  /// action button is what fires the real dialog. Explains WHY, then asks.
  String get micRationale => _lfMicRationale;

  /// The rationale/denied banner's action label — fires the REAL OS request.
  String get micAllowAction =>
      _lfMicAllowAction;

  /// U2-② denied (asked before, the OS would still ask again).
  String get micDenied => _lfMicDenied;

  /// U2-③ permanently denied (Android 「不再询问」("don't ask again") / iOS
  /// turned off in Settings) — the OS will
  /// never show the dialog again, so the ONLY way out is system settings; the
  /// paired action label below is that way out.
  String get micPermanentlyDenied => _lfMicPermanentlyDenied;

  /// U2-③'s action — invokes `openAppSettings` (the call the repo never made).
  String get micOpenSettingsAction =>
      _lfMicOpenSettingsAction;

  /// U2-④: the permission is green and capture STILL refused to start. Its own
  /// sentence on purpose — sending the user to a permission screen that is
  /// already granted would be a wrong instruction.
  String get micCaptureStartFailed => _lfMicCaptureStartFailed;

  // ── recording panel (R6 T-5d / REDESIGN §6.2 ⑤ + §6.3) ────────────────────
  /// F-7: the amplitude meter reads real dBFS; below the silence floor it goes
  /// grey and says so rather than animating a fake waveform.
  ///
  /// 🔴 Q5 (design 2026-08-13 §14, owner ㋐): this-moment time-scope, not a
  /// session-scope claim. The old wording sat next to a growing character
  /// count ("41 字" / "41 characters" and climbing) and read as "nothing was heard this whole
  /// time" — which is false the instant a word DOES land — rather than "the
  /// last window of samples was silent," which is the only thing `_silent`
  /// (recording_panel.dart:84-85, untouched) actually proves. Word swap only;
  /// the predicate and the grey/teal mechanism are unchanged.
  String get recNoSound =>
      _lfRecNoSound;

  /// 📍 soft-segment counter. Kept as the demo's technical 「seg N」label in both
  /// languages (docs/ui-design/demo/mobile.html frame 3), like [langEn].
  String recSegments(int n) => _lfRecSegments(n);

  /// 📡 link row — the panel shows the CONNECTION STATE, never an invented
  /// latency figure (there is no RTT probe on the mobile side).
  String get recLinkOk => _lfRecLinkOk;
  String get recLinkDegraded => _lfRecLinkDegraded;
  String get recLinkDown => _lfRecLinkDown;

  /// Swipe-up cancel hint inside the panel (the gesture itself is unchanged).
  String get recSwipeCancel =>
      _lfRecSwipeCancel;

  // ── PTT bar four states (四态) (R6 T-5d) ────────────────────────────────
  /// zh values are byte-identical to the frozen demo copy (.ptt / .ptt.rec /
  /// .ptt.noted / .ptt.dis); en is the new pair.
  String get pttHold => _lfPttHold;
  // 「仅记录」("record only") is interpolated from recordOnly — the term is
  // only translated once (V2-07.7).
  String get pttHoldNoted => _lfPttHoldNoted(recordOnly);

  /// P6 (0.3.1) — the transitional face between the accepted press and the
  /// recorder actually opening. It claims ONLY 「starting」: the timer and the
  /// recording face still wait for the real capture start, because words
  /// spoken before the OS microphone is open are physically lost and a face
  /// that says 「recording」 during that window would be a wrong status word
  /// with no failure anywhere (R11).
  String get pttStartingMic => _lfPttStartingMic;
  String get pttRecording => _lfPttRecording;

  /// Mock motion table: when displacement exceeds the threshold, the bar turns
  /// grey, 「松开 取消」("release to cancel"). Overlay on the
  /// recording face, not a sixth FSM state — the session stays RECORDING
  /// until the finger releases in the zone.
  String get pttCancelArmed => _lfPttCancelArmed;
  /// 🔴 T-0 (volume 15 §2.0-a law 2, contract predates this fix by five days —
  /// 2026-08-08): NOT 「识别中」/"Transcribing". This face covers segment
  /// polish (⓪ segment), where STT has already finished; "识别中" ("Transcribing")
  /// blames the
  /// wrong stage and points the user at the wrong fix ("speak louder/closer")
  /// for a wait that is actually LLM reorder latency. The phone cannot tell
  /// apart (a) the engine still flushing the terminal transcript from (b)
  /// polish already running — so this reads true for BOTH: a face-neutral
  /// "processing" word, not a claim about which stage is running.
  /// MUST NOT: invent PC-side "processing" copy here — PC's half needs a new
  /// protocol carrier, which is an owner-gated addition (volume 15 §2.0-a).
  String get pttProcessing =>
      _lfPttProcessing;
  String get pttJustDone => _lfPttJustDone;
  String get pttDisabled => _lfPttDisabled;

  // ── PA-2 (Plan A′ §5-2): the one-line caption under the PTT bar ──────────
  // Each caption promises the DELIVERY half only (MD-4): the injection half is
  // reported after the fact on the timeline row (volume 15 two-segment vocabulary).
  // ja/ko are implementer drafts pending owner-agent review (WP7 return
  // report); zh/en are the contract's fixed strings.

  /// A1 — idle, direct policy: what release will do, plus the escape hatch.
  String get pttSubDirect => _lfPttSubDirect;

  /// A2 — idle, manual policy: nothing leaves the phone until confirmed.
  String get pttSubManual => _lfPttSubManual;

  /// A9 — record-only destination: nothing goes to the PC, and saying so up
  /// front is what keeps the grey face from reading as a broken brand face.
  String get pttSubNoted => _lfPttSubNoted;

  /// A4 — processing, the in-flight utterance was direct: name the machine the
  /// words are about to land on. [pc] is the header's display name.
  String pttSubProcessingDirect(String pc) => _lfPttSubProcessingDirect(pc);

  /// A4 — processing, the in-flight utterance stays on the phone (manual
  /// policy, or a record-only destination): no delivery promise, because none
  /// is about to happen.
  String get pttSubProcessingManual => _lfPttSubProcessingManual;

  /// A8 — link down. ⚠️ NOT in the contract's §5-2 table: §4 A8 requires a
  /// 「reason caption」 without fixing its copy, so this sentence is an
  /// implementer draft (flagged in the WP7 return report). It promises nothing
  /// mechanical — no 「自动重连」("auto-reconnect") claim, no queue claim — only
  /// the condition and
  /// what becomes possible when it clears.
  String get pttSubDisabled => _lfPttSubDisabled;
}
