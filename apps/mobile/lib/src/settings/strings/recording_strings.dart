// AppStrings copy-catalogue shard: polish signal / recording auto-stop and
// stall banners / recording panel / PTT four states.
// The sole external entry point remains ../app_strings.dart (AppStrings
// composes this mixin via `with`;
// starting 0.2.67 the copy leaves `_lf…` are implemented by generated classes
// under l10n/, this shard keeps only logic and reasoning comments).
part of '../app_strings.dart';

mixin RecordingStrings on AppStringsLeaves {
  // WP-8 — the signature this mixin resolves against for the generated
  // protocol-sentence fallback (same cross-shard pattern as `_t`'s own
  // signature two shards over: `AppStrings.locale` lives on the concrete
  // class this mixin is applied to, not on [AppStringsLeaves], and a field
  // there satisfies an abstract getter of the same name declared here).
  AppLocale get locale;

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

  /// `kLocalStopReasonContinuousCap` — a continuous recording reached this
  /// account's per-session ceiling and the phone ended it normally.
  ///
  /// 🔴 IT SAYS THE RECORDING IS SAFE AND THAT ANOTHER ONE CAN START. Both
  /// halves are provable at the moment it is drawn: the stop went through the
  /// ordinary `stop()` path (`audio:stop` → terminal final), NOT
  /// `fenceAndStop()`, whose meaning is 「this utterance never happened」 and
  /// which would discard the last segment. A sentence claiming the recording
  /// was kept on top of a fence would be exactly the unbacked promise 15 册
  /// §2.0-b bans.
  ///
  /// ⚠️ NOT ONE DIGIT, on purpose, and the same reason
  /// [recordingAutoStoppedQuota] carries none: the ceiling lives in
  /// `billing/plans.ts`, reaches this phone at runtime, and differs per tier.
  /// Nine translations quoting 「30 分钟」 become nine lies the day a tier is
  /// re-cut, and free would be wrong on the day it shipped. The number belongs
  /// on the start button (card CR-9), read from the same value that enforced
  /// this stop.
  ///
  /// ⚠️ It must not be reworded toward 「额度用完了」("out of quota"). That is
  /// [recordingAutoStoppedQuota]'s sentence and pressing again does not help
  /// there — see `kLocalStopReasonContinuousCap`'s own doc for the W8-4
  /// account this repeats.
  String get recordingStoppedContinuousCap => _lfRecordingStoppedContinuousCap;

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
      // Card CR-6 — the per-session ceiling. Its own sentence rather than a
      // reworded quota one: this ceiling resets with the next press and that
      // one does not, so the two lead the user somewhere opposite.
      case kLocalStopReasonContinuousCap:
        return recordingStoppedContinuousCap;
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

  /// `STT_POOL_NO_ROUTE` — the PLATFORM's engine pool was consulted, refused to
  /// give this request a route, and nothing else covered the language either
  /// (owner-approved code, WP-2 card C1, 2026-08-17).
  ///
  /// 🔴 WHY IT IS NOT [sttStallConfigMissing], which is what this path answered
  /// with until today. That sentence tells the user their engine components or
  /// model files are missing and sends them to check an install. On the relay
  /// every clause of it is false — engines are configured, several of them, and
  /// the install being checked is not even the machine that refused. It is the
  /// same defect as the Soniox 「No audio received.」 mis-map two cards earlier,
  /// arriving from the other direction: there the vendor's fault was reported as
  /// a configuration fault; here OUR configuration is reported as THEIRS.
  ///
  /// 🔴 AND NOT [sttStallNoEngineReached] either, even though the two read alike.
  /// That one means a route WAS selected and the audio still reached nobody, so
  /// its instruction —「请重新说一次」("say it again") — is the right one there and
  /// exactly wrong here: no route was ever selected, so repeating the utterance
  /// re-runs the same refusal. Two codes because the actions differ.
  ///
  /// ⚠️ LEADS WITH THE FACT AND THEN CLOSES THE USER'S OWN SEARCH. The one thing
  /// they can know for certain is that nothing on this phone is the cause — the
  /// same restraint [sttStallServerFault] carries, and for the same reason: the
  /// fault is server-side by construction, so hunting through their own settings
  /// cannot help. No 「try again later」: the pool does not heal on a timer, and
  /// promising that it might is the kind of unbacked wait this repo bans.
  ///
  /// Mirrors `ERROR_CODES.STT_POOL_NO_ROUTE`. Hand-maintained — the phone cannot
  /// import TypeScript, and nothing binds the two tables (the open account in
  /// CLAUDE.md). Without this sentence the code would print as
  /// 「转写引擎报错（STT_POOL_NO_ROUTE）」, i.e. a raw identifier blaming an engine
  /// that was never even asked: the 0.2.53 shape for the sixth time in this file.
  String get sttStallPoolNoRoute => _lfSttStallPoolNoRoute;

  /// `STT_LANGUAGE_UNSUPPORTED` — an engine WAS selected and its model cannot
  /// recognise the spoken language that was asked for (owner-granted code,
  /// 2026-08-17; producer `stt/engine-factory.ts`, the `sherpa-local` arm).
  ///
  /// 🔴 THIS IS THE ONE STALL WITH A ROUTE. The other two refusals on this path
  /// both mean 「nothing was selected」 — [sttStallConfigMissing] because nothing
  /// is configured, [sttStallPoolNoRoute] because the platform's pool declined.
  /// Here the engine exists, is configured, was chosen, and simply does not know
  /// the language. Saying 「no engine is configured」 to someone looking at their
  /// configured engine is a contradiction, which is precisely why the code was
  /// minted rather than folded.
  ///
  /// ⚠️ IT NAMES TWO ACTIONS, NOT ONE, because either really works and only the
  /// user knows which suits them: point this language at a different engine, or
  /// speak one the current engine knows. A single instruction would be a guess
  /// about which of the two they would rather do.
  ///
  /// 🔴 WHAT IT REPLACES ON SCREEN, measured: on a self-hosted box the built-in
  /// engine took French and answered 「La Mer.」 — a clean exit, no error, the
  /// requested language echoed back (WP-3 §2, real audio). The user saw a
  /// two-word "transcript" of a 22-word sentence and had nothing to act on. The
  /// refusal converts silence-reporting-success into a sentence.
  ///
  /// Mirrors `ERROR_CODES.STT_LANGUAGE_UNSUPPORTED`. Hand-maintained for the
  /// usual reason (the phone cannot import TypeScript, and nothing binds the two
  /// tables — the open account in CLAUDE.md). Without it the code prints as
  /// 「转写引擎报错（STT_LANGUAGE_UNSUPPORTED）」, a raw identifier: the 0.2.53
  /// shape for the seventh time in this file.
  String get sttStallLanguageUnsupported => _lfSttStallLanguageUnsupported;

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

  /// WP-9 (2026-09-02, findings-crossend-quota.md #3) — the SAME `QUOTA_EXCEEDED`
  /// refusal, but for the OTHER account: card QTA-2 checks two ledgers (the
  /// acting phone's own, and — for a delivery that targets a PC — that PC
  /// owner's), and until this card `audio.handler.ts`'s `refuseStart` dropped
  /// WHICH one was judged before the frame left the server. A phone signed into
  /// account A, paired to a PC signed into account B, whose recording was
  /// refused because B's month is spent, used to read [sttStallQuotaExceeded]
  /// — "the monthly transcription quota is used up" — which the user reads as
  /// THEIR OWN quota. It is not; nothing they buy fixes it.
  ///
  /// Selected when the wire's additive `judged_account` field reads
  /// `'pc_owner'` (`SttErrorSchema`, `packages/protocol/src/protocol-schemas-
  /// audio.ts`) — see [SttStall.judgedAccount] for where that field lands on
  /// this phone. Absent on every build that predates this card, so old servers
  /// and old refusals keep [sttStallQuotaExceeded] exactly as before (additive
  /// field, no protocol bump).
  ///
  /// ⚠️ Same restraint as its sibling: no upgrade CTA, because upgrading THIS
  /// account would not touch the ceiling that was actually hit.
  String get sttStallQuotaExceededPcOwner => _lfSttStallQuotaExceededPcOwner;

  /// `SETTINGS_SCHEMA_INVALID` — a stored settings ROW failed validation while
  /// the server was setting this utterance up, so the press was refused at
  /// `audio:start` and no engine was ever asked.
  ///
  /// 🔴 [sttStallEngineErrorCoded] IS A FALSE SENTENCE FOR THIS CODE, not merely
  /// an ugly one. 「转写引擎报错（SETTINGS_SCHEMA_INVALID）」("transcription engine
  /// error (SETTINGS_SCHEMA_INVALID)") asserts that an engine reported
  /// something; nothing did. Measured producers on this path:
  /// `resolveReplacementRules` (a corrupt `scenario.card`) and `readSttPolish`
  /// (a corrupt `stt.polish`), both in `engine/stt-factory.ts`, both throwing
  /// before an engine exists. This is the 0.2.53 / ENG-4 shape for the fourth
  /// time in this file.
  ///
  /// ⚠️ DELIBERATELY DOES NOT NAME THE ROW. The frame carries a code, not a
  /// key, and the two known producers are two different rows — naming one would
  /// be a guess dressed as a diagnosis, and a user sent to fix the wrong row
  /// learns that the app lies. 「what you changed most recently」 is a real
  /// action that is true whichever row it was.
  String get sttStallSettingsInvalid => _lfSttStallSettingsInvalid;

  /// `SETTINGS_SYNC_FAIL` — the server's generic non-[ServerError] fallback
  /// (`errorPayload` in server-core `errors.ts`), reached when something threw
  /// that nobody classified.
  ///
  /// 🔴 Its REGISTERED sentence is 「云端同步失败，已保存本地。」("cloud sync failed,
  /// saved locally") and that is doubly wrong here: nothing was being synced,
  /// and nothing was saved locally. Falling through to
  /// [sttStallEngineErrorCoded] is wrong the other way — no engine spoke.
  ///
  /// ⚠️ Its reach GREW on 2026-08-16 (`39ce52cc`, card K-3): the fan-out emit
  /// and the session install now sit inside the try, so `sessions.put()`
  /// disposing a same-key survivor — or a bridge teardown — surfaces here
  /// instead of being dropped by `wrapSocketHandlers` with no frame at all.
  /// That is a strict improvement (a named refusal beats silence) and it is
  /// exactly why the sentence had to stop being a raw identifier.
  ///
  /// ⚠️ Says 「nothing on this phone needs changing」 rather than 「try again
  /// later」: the fault is server-side by construction (a ServerError would
  /// have carried its own code), and the one thing the user can usefully know
  /// is that hunting through their own settings will not help.
  String get sttStallServerFault => _lfSttStallServerFault;

  // Card EMPTY-1 (2026-09-04) — split into `stt_stall_strings.dart` for the
  // file-size cap, exactly as InjectNoteStrings was split out of ChatStrings.
  // The REASONING for each sentence lives with it there; these are the
  // cross-shard signatures this mixin resolves against (the `recordOnly`
  // pattern above), so the banner mapping below can stay in one piece.
  String get sttStallHeardNoWords;
  String sttStallEmptyReasonUnknown(String reason);
  String get sttStallNetworkDrop;
  String get sttStallEngineAuthFail;
  String get sttStallEngineRateLimited;
  String get sttStallEngineTimeout;

  /// An engine error whose code this build has no BESPOKE sentence for, and
  /// whose code the protocol registry ALSO does not recognise (a phone-local
  /// code, or a build that has fallen behind the protocol). States what the
  /// frame itself proves (the engine reported an error) and shows the raw
  /// identifier — never a confident cause nobody verified (0.2.53 rule).
  ///
  /// 🔴 WP-8 (2026-09-02) — this is now the SECOND fallback, not the only one.
  /// `sttStallBannerMessage`'s caller tries [protocolErrorSentence] first: a
  /// code the SERVER registered (`packages/protocol/src/error-codes.ts`) but
  /// nobody wrote phone copy for — `STT_ENGINE_AUTH_FAIL` /
  /// `STT_ENGINE_RATE_LIMITED` / `STT_ENGINE_TIMEOUT` / `STT_NETWORK_DROP` all
  /// measured this way (F1-b) — gets the registry's own zh_CN/en sentence
  /// instead of a labelled identifier. This raw-identifier form is what is
  /// left for a code NEITHER end recognises.
  String sttStallEngineErrorCoded(String code) => _lfSttStallEngineErrorCoded(code);

  /// 🔴 `AUTH_TOKEN_INVALID` on `audio:start` — 「this phone is not signed in to
  /// the relay」, which since owner ruling 2026-08-27 §R1 is a thing that can now
  /// only be learned from a server refusal (the credential no longer expires on
  /// a clock, so nothing else times out to reveal it).
  ///
  /// Until the same ruling, the phone heard NOTHING here: `audio:start` is
  /// emitted without an ack callback, and the server's auth arm filled only that
  /// ack — so a phone whose account had been deleted held the mic, recorded, and
  /// was told nothing. The server now routes it through `refuseStart`, and this
  /// sentence is why that is not 「dressing an auth failure as an engine fault」:
  /// it names the real cause and the one action that helps.
  String get sttStallNotSignedIn => _lfSttStallNotSignedIn;

  /// 🔴 `EMAIL_VERIFY_GRACE_EXPIRED` — the verification grace ran out and the
  /// cloud stopped accepting recordings.
  ///
  /// It is an ACK-LOCAL name, not a protocol `ErrorCode`
  /// (server-core auth/verification-grace.ts states why), which is exactly how it
  /// went unnamed here: nothing binds that registry to this table, so the code
  /// fell to [sttStallEngineErrorCoded] and the user read the raw identifier
  /// `EMAIL_VERIFY_GRACE_EXPIRED` in an engine-fault frame — 0.2.53's defect on
  /// the one refusal the user can actually clear themselves.
  String get sttStallVerifyEmail => _lfSttStallVerifyEmail;

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
      // Card C1: the platform pool refused. NOT an engine speaking — see its doc.
      if (code == 'STT_POOL_NO_ROUTE') return sttStallPoolNoRoute;
      // 2026-08-17: a route WAS found and the engine cannot do this language.
      // Ordered after the two 「nothing selected」 codes so the reading order of
      // this list matches the order of the questions: is anything configured,
      // did the platform give us a line, can what we got do the job.
      if (code == 'STT_LANGUAGE_UNSUPPORTED') return sttStallLanguageUnsupported;
      if (code == 'QUOTA_EXCEEDED') {
        // WP-9 — see [sttStallQuotaExceededPcOwner]: same code, two possible
        // accounts, and the wire now says which one was judged.
        return stall.judgedAccount == 'pc_owner'
            ? sttStallQuotaExceededPcOwner
            : sttStallQuotaExceeded;
      }
      // Two ACCOUNT verdicts, ordered before the engine-flavoured arms below
      // because neither is an engine speaking and neither has an engine remedy.
      // Owner ruling 2026-08-27 §R1 追加: the relay's per-call verdict is now the
      // only thing that can say「your account stopped being served」, so it may
      // not arrive as a raw identifier in a generic frame.
      //
      // REVERSE CONTROL (executed 2026-08-27). Break: delete these two lines.
      // OBSERVED `+39 -2: Some tests failed.` — exactly the two new cases in
      // banner_queue_test.dart, each failing on the FIRST locale of its loop:
      //   Expected: 'Your email address is still unverified, so the cloud
      //             service stopped accepting recordings. Verify it in the web
      //             console to carry on'
      //     Actual: 'Speech engine reported an error (EMAIL_VERIFY_GRACE_EXPIRED)'
      // — the false sentence with the raw identifier in it, verbatim, which is
      // the defect. CONTROL-ON-CONTROL: the POSITIVE CONTROL case (an unnamed
      // code still falling back to the labelled identifier) stayed GREEN, so the
      // break is two arms wide and the fallback still works.
      if (code == 'AUTH_TOKEN_INVALID') return sttStallNotSignedIn;
      if (code == 'EMAIL_VERIFY_GRACE_EXPIRED') return sttStallVerifyEmail;
      // Two ACCOUNT verdicts, ordered before the engine-flavoured arms below
      // because neither is an engine speaking and neither has an engine remedy.
      // Owner ruling 2026-08-27 §R1 追加: the relay's per-call verdict is now the
      // only thing that can say「your account stopped being served」, so it may
      // not arrive as a raw identifier in a generic frame.
      // Neither of these two is an engine speaking — see their own docs above.
      if (code == 'SETTINGS_SCHEMA_INVALID') return sttStallSettingsInvalid;
      if (code == 'SETTINGS_SYNC_FAIL') return sttStallServerFault;
      // Card EMPTY-1 — four codes that used to reach the bilingual registry
      // fallback. Ordered after the refusals above and before that fallback, so
      // the reading order still runs 「was anything configured / did the platform
      // give us a line / can what we got do the job」 and only then 「what went
      // wrong on a line we did have」.
      if (code == 'STT_NETWORK_DROP') return sttStallNetworkDrop;
      if (code == 'STT_ENGINE_AUTH_FAIL') return sttStallEngineAuthFail;
      if (code == 'STT_ENGINE_RATE_LIMITED') return sttStallEngineRateLimited;
      if (code == 'STT_ENGINE_TIMEOUT') return sttStallEngineTimeout;
      if (code != null && code.isNotEmpty) {
        // WP-8 (2026-09-02, F1-b) — a code with no BESPOKE sentence above may
        // still be one the protocol registry has real copy for
        // (STT_ENGINE_AUTH_FAIL / STT_ENGINE_RATE_LIMITED /
        // STT_ENGINE_TIMEOUT / STT_NETWORK_DROP measured this way). Try that
        // before falling all the way to the labelled raw identifier.
        final String? fromRegistry =
            protocolErrorSentence(code, preferZh: locale == AppLocale.zh);
        if (fromRegistry != null) return fromRegistry;
        return sttStallEngineErrorCoded(code);
      }
    }
    // Card EMPTY-1 — the empty-final arm. `null` is the pre-card wire and keeps
    // the old sentence byte for byte; `'no_voice'` is the SERVER saying the same
    // thing, and maps to the same string on purpose (「the server said so」 and
    // 「the phone inferred it from an empty string」 are different facts, and only
    // the first survives a future where an empty final means something else).
    if (stall.reason == SttStallReason.emptyTranscript) {
      final String? why = stall.emptyReason;
      if (why == 'heard_no_words') return sttStallHeardNoWords;
      if (why != null && why != 'no_voice') return sttStallEmptyReasonUnknown(why);
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
  /// languages (docs/ui-design/demo/mobile.html frame 3) — a deliberately
  /// untranslated technical chip (the same ruling that keeps language names
  /// as endonyms).
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

  /// NR-4 (g), 2026-08-27 — THE NAME OF AN ACTION, not the description of a
  /// state, and the difference is why this is not [pttCancelArmed] reused.
  ///
  /// SPEC-REF: docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md §4
  ///
  /// `ptt_bar.dart`'s own header booked the gap for a year: an
  /// assistive-technology user who starts a hold through
  /// `Semantics.onTap` could only END it, never DISCARD it — the swipe-up
  /// cancel had no accessible equivalent. This is that equivalent's label, and
  /// it is registered on the bar as a `CustomSemanticsAction` only while a hold
  /// is actually live (an always-present 「cancel the recording」 action with
  /// nothing to cancel is this repo's 「a control that changes nothing」 red
  /// line, wearing an accessibility costume).
  ///
  /// ⚠️ NOT a copy of 「松开 取消」. That sentence answers 「what happens if I
  /// let go NOW」 and only makes sense with a finger on the glass; a custom
  /// action is read out of a list, so it has to be a verb phrase that stands on
  /// its own.
  ///
  /// ⚠️ Deliberately NOT shared with [ComposeStrings.appendCancelSemanticAction].
  /// The mechanism underneath is literally the same function, but the two
  /// controls are two places in the product — an AT user hearing 「cancel」
  /// twice cannot tell which one they are on, and 「cancel this append」 is the
  /// answer they need in the sheet.
  String get pttCancelSemanticAction => _lfPttCancelSemanticAction;
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

  // ── F6 (2026-09-02 audit): retained-audio eviction/TTL notices ───────────
  //
  // `RetainedAudioStore` (audio/retained_audio_store.dart) already refuses to
  // drop a segment silently — every eviction and every TTL expiry is
  // announced on its `notices` stream — but until this shard the ONLY
  // listener was the diagnostics log (`retained_audio_boot.dart`). "No
  // silent failure" runs in both directions: a store that told a user their
  // audio was "留存" ("retained") and then discarded it with nothing but a
  // diag line is the exact unbacked-promise shape volume 15 §2.0-b bans, just
  // moved one step later than the original defect these words were coined
  // to fix.
  //
  // ⚠️ NOT ONE BYTE OR HOUR COUNT, on the same principle as
  // [recordingStoppedContinuousCap]: `kDefaultCapBytes` / `kDefaultTtl` are
  // compile-time constants that this store's own header says to expect to
  // move (「IF THE TIER CEILING EVER RISES AGAIN, COME BACK HERE」), and a
  // sentence that quotes today's number becomes nine translations of a wrong
  // fact the day either constant changes.

  /// [RetainedAudioNotice.codeDroppedOldest] — the store gave up an OLDER
  /// segment (this run's or an orphaned previous run's) to make room for new
  /// audio. The segment that was kept is unaffected; this states only what
  /// was lost.
  String get retainedAudioNoticeDroppedOldest =>
      _lfRetainedAudioNoticeDroppedOldest;

  /// [RetainedAudioNotice.codeCapReached] — nothing older was left to give
  /// up, so the segment being written to RIGHT NOW is the one that stopped
  /// growing. Distinct from the sentence above because the two name opposite
  /// halves of a recording (the beginning vs. the end) — collapsing them
  /// would tell the user the wrong part of what they said is missing.
  String get retainedAudioNoticeCapReached => _lfRetainedAudioNoticeCapReached;

  /// [RetainedAudioNotice.codeExpired] — the TTL backstop reaped audio nobody
  /// ever claimed (typically an app restart that orphaned it — see the
  /// store's own header). This is the one notice that can fire with no
  /// recording in progress at all.
  String get retainedAudioNoticeExpired => _lfRetainedAudioNoticeExpired;

  /// Selector for [RetainedAudioNotice.code]. Keyed on the store's own named
  /// constants (never re-typed literals) — same discipline as
  /// [recordingAutoStoppedMessage]. The default arm exists only so a future
  /// fourth code added to the store without a matching sentence here fails
  /// visibly (an unrecognised identifier survives to the diag line already
  /// written by the caller) rather than throwing past a `switch` that never
  /// expected to see one; today's three codes are the store's whole
  /// contract and this is a closed set, not open wire data.
  String retainedAudioNoticeMessage(String code) {
    switch (code) {
      case RetainedAudioNotice.codeDroppedOldest:
        return retainedAudioNoticeDroppedOldest;
      case RetainedAudioNotice.codeCapReached:
        return retainedAudioNoticeCapReached;
      case RetainedAudioNotice.codeExpired:
        return retainedAudioNoticeExpired;
      default:
        return code;
    }
  }
}
