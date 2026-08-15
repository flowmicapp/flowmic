// AppStrings copy-catalogue shard: ComposeBand toolbar · buffer box · send
// policy / AI action row.
// The one external entry point is still ../app_strings.dart (AppStrings composes
// this mixin via `with`; from 0.2.67 on, the copy leaves `_lf…` are implemented
// by generated classes under l10n/ — this shard keeps only logic and
// argumentative comments).
part of '../app_strings.dart';

mixin ComposeStrings on AppStringsLeaves {

  // ── ComposeBand: toolbar + editable buffer box + send button (R6 T-3a / §6.2 ⑤) ─────────
  /// Placeholder inside the editable buffer. zh is byte-identical to the frozen
  /// demo copy (.buf); while an utterance streams, the live interim text takes
  /// this slot instead (§6.2 「空时叠加 interim 流字」 — "when empty, overlay the
  /// streaming interim text").
  String get composeHint =>
      _lfComposeHint;

  /// Buffer placeholder while the link is down — the whole input row is inert,
  /// and it says why rather than looking merely idle.
  String get composeDisabled => _lfComposeDisabled;

  /// 🔴 T-2 (0.2.63, owner Q3㋐ 「闲时行 2 不画 38px 假输入框」 — "the idle row 2
  /// must not paint a fake 38px input box") — the preview strip's empty-state
  /// sentence.
  ///
  /// ⚠️ **Deliberately does NOT reuse [composeHint]** (「说话或输入…」 — "speak or
  /// type…"). That sentence is the **placeholder INSIDE the box**, and it
  /// promises 「就在这里打字」 ("type right here"); whereas this slot, since T-2,
  /// is structurally **NOT** a TextField (see `ComposeBufferPreview`'s class
  /// comment) — you cannot type on top of it. Propping the old string up here
  /// — where both sentences read as equally true, and one of them no longer has
  /// a mechanism behind it — is exactly the shape this repo's second direction
  /// of 「没有静默失败」 ("no silent failure") bans.
  ///
  /// The wording deliberately names **two things**: 「输入」 ("enter text" — the
  /// face you get after tapping open IS the input face) and 「查看」 ("view" —
  /// when the buffer already has text, tapping open is to read the full text —
  /// the preview strip only gives you one line).
  String get composeEntryStrip => _lfComposeEntryStrip;

  /// The preview strip's tooltip / a11y sentence (the entry-point explanation
  /// for the T-3 expanded face).
  /// It answers **what happens if you tap** — the preview strip's own small-print
  /// line answers 「这一格是干什么的」 ("what this slot is for").
  String get composeExpandHint => _lfComposeExpandHint;

  /// 🔴 The **one and only** wording for the collapse control at the head of the
  /// T-3 expanded face (contract §5-2 line 1).
  ///
  /// ⚠️ The contract dictates both the glyph and the word here: **`chevron_down`
  /// / 「收起」 ("collapse"), never ✕**. The reason is not aesthetic — this app
  /// already has one pair of ✕ that 「name look alike, consequences are
  /// opposite」 (the floating card's [composeCardDiscard] does a local discard,
  /// while the toolbar row's ✕ clears the PC's focus window); adding a THIRD ✕
  /// would turn that debt into a three-way one. And this one's consequence
  /// differs from both of those: **it changes not a single character**, it only
  /// folds the face back up.
  String get composeCollapse =>
      _lfComposeCollapse;

  /// The two send policies (08 §5). The send button's face IS the switch, so
  /// these label the toggle confirmation, not a settings row (D4).
  String get sendPolicyDirect =>
      _lfSendPolicyDirect;
  String get sendPolicyManual =>
      _lfSendPolicyManual;

  /// One-line explanation shown when the policy flips, so the change is never
  /// silent. direct = speech goes straight to the PC; manual = it waits in the
  /// buffer for an explicit ➤.
  String get sendPolicyDirectHint => _lfSendPolicyDirectHint;
  String get sendPolicyManualHint => _lfSendPolicyManualHint;

  // PA-1 (0.2.64 line, Plan A′ SUP-2) deleted `sendPolicySwitchHint` and
  // `composeSend` here: both were the send button's own copy (its tooltip and
  // its long-press affordance), and the idle dock no longer has a send button —
  // delivering lives in the edit sheet's footer ([composeCardDeliver]). Per the
  // `INJECT_NO_RECEIPT` precedent a user-visible string leaves with its
  // producer. (`BannerIds.composeSend` in banner_queue.dart is an unrelated
  // identifier, not this string.)

  /// PA-1 (Plan A′ §5-1) — the PC key group's edge label. It names the SIDE the
  /// four keys act on, which is the one fact a first-time user cannot guess
  /// from four bare glyphs sitting under their own draft.
  String get pcKeysGroupLabel => _lfPcKeysGroupLabel;

  /// PA-1 (Plan A′ §4 A9) — the one reason line under the dimmed key group on a
  /// record-only destination. States the mechanism (no PC focus), not a vague
  /// 「不可用」 ("unavailable"): the keys act on a focused window, and this destination has none.
  String get pcKeysUnavailableNoted => _lfPcKeysUnavailableNoted;

  // The two toolbar group labels (toolsLocalGroup / toolsRemoteGroup) were
  // removed in the M1/M3 pass: neither had a caller, and M3 gave the four
  // remote keys per-key hints that say what each does ON THE PC — strictly more
  // useful than a group's name, and not dead copy.
  //
  // T-1 (0.2.63) took `punctuationHint` the same way. It named the rule that
  // picked between a punctuation key's two outcomes (「输入框有内容时插入其中，
  // 为空时补到电脑上最近一句后面」 — "inserted into the input box when it has
  // content, appended to the PC's most recent sentence when it's empty");
  // owner Q2㋐ deleted both outcomes with the
  // group, so the sentence has nothing left to describe. Per the repo's
  // `INJECT_NO_RECEIPT` precedent, a user-visible string leaves with its
  // producer rather than waiting for somebody to answer a different question
  // with it.
  String get keyEnter => _lfKeyEnter;
  String get keyBackspace =>
      _lfKeyBackspace;
  String get keyUndo => _lfKeyUndo;
  String get keyClear => _lfKeyClear;

  /// M3: per-key long-press truth for the four REMOTE keys. Each names what the
  /// key does ON THE PC — 「作用于电脑」 ("acts on the PC") is the one fact a
  /// first-time presser cannot guess from the glyph, and the four keys do four
  /// different things there, so one shared group label was not enough.
  String get keyEnterHint => _lfKeyEnterHint;
  String get keyBackspaceHint => _lfKeyBackspaceHint;
  String get keyUndoHint => _lfKeyUndoHint;
  /// 🔴 REWRITTEN BY T-1 — the SECOND user-visible sentence the decoupling made
  /// false, and the second one the design doc's §4-4 four-spot checklist did
  /// not list.
  ///
  /// It used to say 「清空电脑端文字，**并清空本地输入框**」 ("clear the PC-side
  /// text, **and also clear the local input box**"). This is the ✕'s long-press
  /// tooltip (`_controlButton`'s `hint`), i.e. **the only explanation the user
  /// can read before pressing it** ⇒ once owner's addendum #3 removed the
  /// local half, it became a lie told before the press even happens.
  /// Zero test coverage: the M3 long-press test case only verified the ⌫ key.
  ///
  /// The parenthetical half is kept deliberately: this app has two ✕'s with
  /// opposite consequences (the floating card's discard goes through
  /// `discardBuffer`), and right before pressing **this one**, the thing the
  /// user most wants to know is precisely 「我的草稿会不会没」 ("is my draft
  /// going to disappear"). This sentence now gives it a true answer.
  String get keyClearHint => _lfKeyClearHint;

  // ── REQ-12-13 remote key presses enter history (owner P0 2026-08-12;
  //    contract 15 册 §2.0-e) ─────────────────────────────────────────────
  //
  // 🔴 These sentences are **the row's face**, and the row stores no text for
  // it: `outputText` is an empty string, and the face is assembled at render
  // time from `controlKind`. Two specific reasons: ① a sentence baked in at
  // row-mint time would be **permanently frozen in whatever language it was
  // at that moment** (the row must persist to disk, and the user may switch
  // languages later); ② `outputText` is exactly the field that resend/deferred
  // delivery re-sends — a row with no text can never accidentally be re-sent by
  // anyone.

  /// The slot at the head of the row: 「⌨ 远程按键 · 清除」 ("remote key ·
  /// clear"). [key] reuses the four keys' own labels above, **no separate
  /// vocabulary invented** — the same key must have the same name on the
  /// toolbar and in history.
  String controlRowLabel(String key) => _lfControlRowLabel(key);

  /// 🔴 The ONLY status word this row can honestly say, **must never be
  /// changed to 「已投递」 ("delivered")**.
  /// `control:key` has no receipt frame ⇒ all this end can prove is 「帧离开了
  /// 本机」 ("the frame left this device"); the answer to 「电脑收到了吗 / 执行
  /// 了吗」 ("did the PC receive it / did it execute it") lives on **the PC's
  /// OWN timeline row** (15 册 §2.0-e). 「已投递」 is stage ①'s word, and its
  /// success criterion is 「拿到 PC 的回执」 ("received the PC's receipt") —
  /// there is none on this path.
  String get controlRowSent =>
      _lfControlRowSent;

  /// 🔴 REWRITTEN BY T-1, AND THIS ONE WAS ALMOST MISSED (2026-08-13).
  ///
  /// It used to say 「**已清空本机输入框**，并请电脑清除焦点窗口」 ("**the local
  /// input box has been cleared**, and the PC has been asked to clear its
  /// focus window") — it spoke to both sides, because at the time the clear
  /// key **did two things in one press** (08 §5). Once owner's addendum #3
  /// removed the local half ⇒ **the first half became false that same day**:
  /// after pressing ✕, the draft is still there, untouched.
  ///
  /// ⚠️ The design doc's §4-4 「must-change-together」 four-spot checklist did
  /// **NOT** include this spot, and this spot is the ONE of the four that is
  /// **actually readable by the user** (the other three are all comments and
  /// docs). It kept rendering on every ✕ row, in all four languages ⇒ if the
  /// decoupling cut had only followed the checklist, it would have shipped a
  /// sentence telling the user 「你的草稿被清掉了」 ("your draft has been
  /// cleared") while the draft sat there perfectly intact. **The literal shape
  /// of R11.**
  ///
  /// 🔴 Also worth recording WHY it wasn't caught by any gate:
  /// `control_key_history_test.dart`'s test case asserted **whether this
  /// sentence exists** (byKey), not **what it says** — the mirror-image
  /// counter-example to the 0.2.53 rule. The assertion has now been changed,
  /// this round, to check the content.
  ///
  /// Now it still speaks to both sides, only the second half has been swapped
  /// for the **true** answer: the draft was not touched. The two questions the
  /// user could possibly ask at this moment (「电脑那边动没动」 "did anything
  /// happen on the PC side" / 「我的草稿去哪了」 "where did my draft go") each
  /// now have a true answer.
  String get controlRowClearNote => _lfControlRowClearNote;

  // T-1 (0.2.63) deleted `toolsCollapse` / `toolsExpand` — the chevron's two
  // labels. The chevron folded the punctuation group, and the group is gone.

  /// M2: the retry affordance on a failed delivery — the send-failure banner's
  /// action button and the failed row's inline entry share the ONE word.
  String get resendAction =>
      _lfResendAction;

  /// owner 2026-07-31, real device: 「在原消息上显示一个最后的重发时间」 ("show a
  /// last-resend time on the original message") — the meta-row label
  /// for [TimelineEntry.lastResentAt]. [time] is already formatted by
  /// `timelineTimeLabel` (numeric, locale-free — the "UI does not follow OS
  /// locale" red line).
  ///
  /// Built on the ONE word this repo already uses for the act ([resendAction]),
  /// per 「别造第二套说法」 ("don't invent a second vocabulary") — but every
  /// language adds a 「上一次」 ("last time") qualifier, because
  /// on a failed row this LABEL renders a few pixels away from the tappable
  /// ACTION with the same word, and 「重发 15:20」 ("resend 15:20") next to
  /// 「重发」 ("resend") reads as a button with a time on it.
  ///
  /// It says WHEN, never WHETHER IT WORKED: the status pill beside it owns the
  /// delivery truth, and this line is deliberately mute about it (see
  /// TimelineEntry.lastResentAt).
  String resentAtLabel(String time) => _lfResentAtLabel(time);

  /// Fail-loud copy for a ComposeBand send that did not happen. Each reason
  /// reads differently — a generic 「发送失败」 ("send failed") would hide which
  /// wall was hit.
  String composeSendError(ComposeSendFailure f) {
    switch (f) {
      case ComposeSendFailure.notConnected:
        return _lfComposeSendError__1;
      case ComposeSendFailure.emptyBuffer:
        return _lfComposeSendError__2;
      case ComposeSendFailure.noPcTarget:
        return _lfComposeSendError__3;
      case ComposeSendFailure.wireFailed:
        return _lfComposeSendError__4;
      // RCA-v3: the pre-send probe found the link dead and the automatic
      // reconnect-and-retry also failed. Nothing was sent; the words are kept.
      // Deliberately NOT 「电脑没有回应」 ("the PC did not respond") — that one
      // means a frame went out.
      case ComposeSendFailure.linkDown:
        return _lfComposeSendError__5;
      // v0.2.8: names WHAT is unknown — the frame went out, the PC never
      // answered. Saying 「发送失败」 ("send failed") here would be a guess;
      // saying nothing (the old behaviour) left the row at ⏳ forever.
      case ComposeSendFailure.noResult:
        return _lfComposeSendError__6;
      // Card F4 — over `kInjectTextMaxChars`. The phone refused its own send;
      // no frame was built, so nothing was 「投递」 ("delivered") and nothing
      // is owed.
      //
      // 🔴 AN IMPERATIVE IS RIGHT HERE, and that is a departure worth naming.
      // `INJECT_PC_MISMATCH` and the deferred-delivery (补投) copy carry no
      // imperative because the user has no move to make. This failure is the
      // opposite: it is entirely user-fixable, and telling someone only 「太长
      // 了」 ("too long") turns a solvable problem
      // into a mysterious one — the same reasoning owner used for
      // `INJECT_NO_ACCESSIBILITY` (say where to go, or the sentence is useless).
      //
      // 🔴 IT MUST NOT READ AS 「再试一次就行」 ("just try again and it'll be
      // fine"). Retrying the same text hits the
      // same wall forever, so the instruction names the ONLY thing that changes
      // the outcome: send less per go. The banner backs this up structurally —
      // `sendRetryTargets` offers resend for `wireFailed`/`noResult` only, so
      // this reason grows no Resend button to contradict the words.
      //
      // ⚠️ NO NUMBER, on purpose. Three entry points share this one sentence
      // (typed ➤ / tap-to-send a favourite / 「+」panel multi-select), and the
      // quantity the user actually controls differs in each: characters typed
      // in one, items ticked in another. 「100,000 字」 ("100,000 characters")
      // is only actionable in one of the three, while
      // 「分几次发送」 ("send it in several batches") is actionable in all of
      // them. It also keeps the cap from
      // acquiring a THIRD copy on a surface no mirror test can reach.
      case ComposeSendFailure.tooLong:
        return _lfComposeSendError__7;
    }
  }

  // ── FB-8 transcript-confirmation card + FB-3 buffer hint strip ───────────
  // design doc = docs/ui-design/2026-08-06-fb8-manual-send-edit-flow.md §3;
  // demo = docs/ui-design/2026-08-06-fb3-fb8-demo.html `confirmCard()`.
  //
  // 🔴 This family **invents NO fourth message state** (FB-8 §3 「刻意不做」②
  // — "deliberately not done" #2). The resting state is still the existing
  // 「待投递」 ("pending delivery") family — the sentence below is **the card
  // header's caption**, not a status word, and must never be used to render
  // TimelineEntry's status. The split between delivery-stage vocabulary
  // (delivered/pending delivery/undelivered) and injection-stage vocabulary is
  // in docs/rebuild/15 §2.0, and this family does not touch a single word of it.

  /// The card-header line. Verbatim from the demo: 「已转录，未发送 — 可编辑后
  /// 投递」 ("transcribed, not sent — editable before delivery") (FB-8 §6-3 was
  /// not separately ruled on, implemented per the design doc). It answers 「现
  /// 在停住了、等你编辑或发送」 ("it's paused here, waiting for you to edit or
  /// send") — FB-8 §1's third real gap was precisely 「这个状态从来没有被讲出来」
  /// ("this state was never spoken out loud").
  String get composeCardHeader => _lfComposeCardHeader;

  /// PA-4 (Plan A′ §5-2) — the sheet header for a TYPED draft. Deliberately
  /// does NOT reuse [composeCardHeader]: that sentence opens with 「已转录」
  /// ("transcribed"), which is a lie for text the user typed with their own
  /// fingers (mock ⑫'s own words: it did not come from speech, don't write
  /// 「已转录」).
  String get composeSheetHeaderTyped => _lfComposeSheetHeaderTyped;

  /// PA-5 (Plan A′ §5-2) — the sheet header while an in-sheet append is
  /// recording/finalizing. No 「已转录」 ("transcribed") claim (the new words
  /// are still in flight) and no ✕/「收起」 ("collapse") beside it (the sheet
  /// is held open by the gesture).
  String get composeSheetHeaderAppending => _lfComposeSheetHeaderAppending;

  /// PA-5 (Plan A′ §5-2) — the in-sheet hold-to-append button's resting face.
  String get appendHold =>
      _lfAppendHold;

  /// PA-5 — the same button while the append hold is live. Mirrors the PTT
  /// bar's release wording family (● + release verb).
  String get appendRelease => _lfAppendRelease;

  /// Same overlay as [RecordingStrings.pttCancelArmed], on the in-sheet
  /// append button: finger is past the swipe-up threshold, release discards
  /// only the in-flight append.
  String get appendCancelArmed => _lfAppendCancelArmed;

  /// The card's primary button (sheet footer). The wording follows whichever
  /// face it lives on; the action is the same `ChatController.sendBuffer`.
  String get composeCardDeliver =>
      _lfComposeCardDeliver;

  /// P4 (0.3.1) — the same primary button when the destination is fixed
  /// (light-record / cloud instance): the action commits the typed draft as a
  /// LOCAL noted row, so the label must not promise a delivery no mechanism
  /// backs (the 「待投递」 red line, 15 §2.0). The image path made this split
  /// first (`ImageSendController.canSend` treats `noPcTarget` as a local save);
  /// this is the text half catching up.
  String get composeCardSaveNoted => _lfComposeCardSaveNoted;

  /// The card's secondary button / the card-header ✕. **What gets discarded is
  /// THIS BUFFER, not anything on the PC** — it goes through
  /// `ChatController.discardBuffer` (local), not the remote ✕
  /// (`ControlKeyKind.clear`, which clears the content of the PC's focus
  /// window). The two things have similar names and completely different
  /// consequences.
  String get composeCardDiscard =>
      _lfComposeCardDiscard;

  /// FB-3 Plan A buffer hint strip: after the confirmation dialog was
  /// cancelled, the protection 「切模式会清空缓冲」 ("switching modes clears
  /// the buffer") became a sentence that is on screen **BEFORE the fact**
  /// instead (design doc §3 line 1). ⚠️ It must be readable **before the
  /// destructive action happens** — so it is a persistent hint, not a toast
  /// shown after the switch, and its render assertion is on didExceedMaxLines
  /// (the 0.2.53 rule), not on Text.data.
  String get composeModeSwitchClearsHint => _lfComposeModeSwitchClearsHint;

  // ── translate target chip (GA-01 / D4; V2-07.7 absorbed mode_chip._labels) ─
  /// The chip beside the mode chip showing where translate is aimed. '→ EN'
  /// is Latin in both locales; the zh target keeps the native glyph under a zh
  /// UI (same call as [SettingsStrings.langZh]) and falls back to the ISO code
  /// for other UI languages — an English user cannot read 「中」. Unknown tags
  /// render as the uppercased tag itself (data, not copy).
  String translateTargetLabel(String target) {
    switch (target) {
      case 'en':
        return '→ EN';
      case 'zh':
        return _lfTranslateTargetLabel;
      default:
        return '→ ${target.toUpperCase()}';
    }
  }

  // ── AI action row (R6 T-3b ④ / §6.2 ④ / F-3) ──────────────────────────────
  /// The three buffer operations. Wire names are frozen (`draft_polish`); these
  /// are the user-facing labels.
  String aiTaskLabel(ComposeTask task) {
    switch (task) {
      case ComposeTask.draftPolish:
        return _lfAiTaskLabel__1;
      case ComposeTask.organize:
        return _lfAiTaskLabel__2;
      case ComposeTask.translate:
        return _lfAiTaskLabel__3;
    }
  }

  /// The row's standing caption (demo frame 4, right-aligned): these act on the
  /// buffer and deliver nothing. Saying so is what keeps 「AI 帮我发出去了」
  /// ("the AI sent it for me") from ever being a reasonable reading of the
  /// three buttons.
  String get aiRowNote => _lfAiRowNote;

  /// 🔴 T-6 (0.2.63, owner's addendum #5 「整理/翻译/润色点击后要能恢复，不然就
  /// 找不到原文了」 — "after tapping organize/translate/polish it must be
  /// possible to restore, otherwise the original text becomes unrecoverable")
  /// — the restore entry point on the card after a successful transform.
  ///
  /// ⚠️ The wording is **deliberately the same word** as the 「原文」
  /// ("original text") column on the timeline ([ChatStrings]'s
  /// `tl_source_label` family): both refer to the same thing — the text before
  /// the AI touched it. It is not called 「撤销」 ("undo") here, because it is
  /// not 「退一步」 ("stepping back one step"): after successive transforms it
  /// gives back the **very first** version, not the previous one
  /// (`AiComposeController._restorable`'s `??=` is the implementation of this
  /// rule).
  String get aiRestoreOriginal =>
      _lfAiRestoreOriginal;

  /// The affordance's tooltip / a11y sentence — it names WHICH text comes back,
  /// because after two transforms 「原文」 ("original text") has two plausible
  /// referents and only one of them is true.
  String get aiRestoreOriginalHint => _lfAiRestoreOriginalHint;

  /// Progress caption while a run streams.
  String aiRunning(ComposeTask task) => _lfAiRunning(aiTaskLabel(task));

  /// Fail-loud copy for an AI run that did not produce a result. Red line: an
  /// LLM failure is NEVER dressed up as success — every branch here names the
  /// failure and states that the original text was kept.
  String aiComposeError(AiComposeOutcome outcome) {
    switch (outcome.reason) {
      case AiComposeFailure.notConnected:
        return _lfAiComposeError__1;
      case AiComposeFailure.emptyBuffer:
        return _lfAiComposeError__2;
      case AiComposeFailure.wireFailed:
        return _lfAiComposeError__3;
      case AiComposeFailure.timeout:
        return _lfAiComposeError__4;
      case AiComposeFailure.aborted:
        return _lfAiComposeError__5;
      case AiComposeFailure.busy:
        // Card F3: a refusal to START, so nothing was touched — the copy says
        // what is true (the previous run owns the slot) and names no consequence.
        return _lfAiComposeError__6;
      case AiComposeFailure.serverError:
        return _lfAiComposeError__7(aiErrorCode(outcome.code));
    }
  }

  /// GA-01 fail-loud copy for a SPOKEN utterance whose transform failed. It is
  /// deliberately NOT [aiComposeError]: that one ends 「原文已保留」 (your text is
  /// still in the box), which would be a lie here — the utterance produced no
  /// delivery at all. Every branch says the same two things: nothing was sent,
  /// and the original was NOT sent in its place (red line: an LLM failure must
  /// never look like a successful translation). A long-press deferred-delivery
  /// (长按补投) is the way out, so it is named.
  String utteranceComposeError(AiComposeOutcome outcome) {
    final String why = switch (outcome.reason) {
      AiComposeFailure.notConnected => _lfUtteranceComposeError__1,
      AiComposeFailure.emptyBuffer => _lfUtteranceComposeError__2,
      AiComposeFailure.wireFailed => _lfUtteranceComposeError__3,
      AiComposeFailure.timeout => _lfUtteranceComposeError__4,
      AiComposeFailure.aborted => _lfUtteranceComposeError__5,
      AiComposeFailure.busy => _lfUtteranceComposeError__6,
      AiComposeFailure.serverError => aiErrorCode(outcome.code),
    };
    return _lfUtteranceComposeError__7(why);
  }

  /// Readable text for the compose error codes the server can return. An
  /// UNKNOWN code is surfaced VERBATIM rather than swallowed into a generic
  /// message — a code we cannot name is exactly the one worth showing.
  String aiErrorCode(String? code) {
    switch (code) {
      case 'QUOTA_EXCEEDED':
        return _lfAiErrorCode__1;
      case 'LLM_INVALID_MODEL':
        return _lfAiErrorCode__2;
      case 'LLM_AUTH_FAIL':
        return _lfAiErrorCode__3;
      case 'LLM_RATE_LIMITED':
        return _lfAiErrorCode__4;
      case 'LLM_TIMEOUT':
        return _lfAiErrorCode__5;
      case 'LLM_PROBE_FAIL':
        return _lfAiErrorCode__6;
      case 'SETTINGS_SCHEMA_INVALID':
        return _lfAiErrorCode__7;
      case 'COMPOSE_EMPTY_OUTPUT':
        return _lfAiErrorCode__8;
      // Error code 62 (owner approved 2026-08-07, docs/decisions/2026-08-07-owner-grants-
      // error-code-62-compose-output-rejected.md). The server ran the model, got an
      // answer, and REFUSED to deliver it — the output guard judged it was not a
      // translation/organization of what was said (answered instead of translating,
      // did not translate at all, or invented content).
      //
      // 🔴 Deliberately NOT folded into COMPOSE_EMPTY_OUTPUT above: that sentence
      // (「AI 返回了空结果」 — "the AI returned an empty result") is TRUE about a
      // different fact, and reusing it here
      // would trade a true sentence for a false one — the AI returned plenty, we
      // just would not hand it over. R11: a status word must be able to answer
      // 「凭什么这么说」 ("what grounds do you have for saying that").
      //
      // ⚠️ This is the phone's OWN copy table; it does not render the strings in
      // packages/protocol/src/error-codes.ts. Both faces carry this code and they
      // must be changed together — that split is why the code reached the user as
      // a bare token for the length of one window.
      case 'COMPOSE_OUTPUT_REJECTED':
        return _lfAiErrorCode__9;
      case null:
        return _lfAiErrorCode__10;
      default:
        return code;
    }
  }
}
