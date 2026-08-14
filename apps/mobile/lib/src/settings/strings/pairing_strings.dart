// AppStrings copy-catalogue shard: add-pairing / scan-to-pair·login / pairError.
// The sole external entry point remains ../app_strings.dart (AppStrings composes
// this mixin via `with`;
// starting 0.2.67 the copy leaves `_lf…` are implemented by generated classes
// under l10n/, this shard keeps only logic and reasoning comments).
part of '../app_strings.dart';

mixin PairingStrings on AppStringsLeaves {

  // ── add-pairing sheet ─────────────────────────────────────────────────────
  String get addPairingTitle => _lfAddPairingTitle;
  String get pcAddressLabel => _lfPcAddressLabel;
  String get pcAddressHint => _lfPcAddressHint;
  // ── 0.2.66 PCID (cloud relay only) ────────────────────────────────────────
  // owner 2026-08-14: 「云端中继不支持直接输入配对码建立连接，一定是扫码或输入一个
  // PCID+配对码；本地局域网……没有 PCID」("the cloud relay does not support
  // establishing a connection by directly typing a pairing code — it must be
  // scan-to-pair or typing a PCID+pairing code; the local LAN… has no PCID").
  // The token 「PCID」 is left untranslated in
  // all four languages ON PURPOSE — it is the identifier the DESKTOP prints next
  // to the number, and a phone that calls it something else would leave the user
  // matching two names to one nine-digit string.
  String get pcidLabel => _lfPcidLabel;
  /// Grouped so the hint itself teaches the `XXX XXX XXX` shape the desktop
  /// displays; the field accepts the spaces back and strips them ([readPcid]).
  String get pcidInputHint => _lfPcidInputHint;
  String get pairCodeLabel => _lfPairCodeLabel;
  String get pairCodeInputHint => _lfPairCodeInputHint;
  String get pairConnect =>
      _lfPairConnect;
  String get pairing => _lfPairing;
  // ── GA-30 scan-to-pair (owner 2026-07-26:「scan takes priority over manual
  // typing」) ────────────────────
  String get pairTabScan => _lfPairTabScan;
  String get pairTabManual => _lfPairTabManual;
  String get pairScanHint => _lfPairScanHint;
  /// A readable barcode that is not ours. Named on purpose: handing a Wi-Fi QR to
  /// the pairing call would surface 「配对码无效」("invalid pairing code") and send
  /// the user hunting for a
  /// code problem that does not exist.
  String get pairScanForeign => _lfPairScanForeign;
  /// The right app, the wrong screen.
  String get pairScanIsLogin => _lfPairScanIsLogin;
  String get pairScanNoCamera => _lfPairScanNoCamera;
  // GA-31 scan-to-login (the WEB-side scope of owner's 2026-07-26 ruling).
  String get loginScanTitle => _lfLoginScanTitle;
  String get loginScanOpen => _lfLoginScanOpen;
  String get loginScanHint => _lfLoginScanHint;
  /// A pairing code scanned on the LOGIN screen — right app, wrong screen.
  String get loginScanIsPair => _lfLoginScanIsPair;
  String get pairScanDenied => _lfPairScanDenied;
  String get pairNeedAddress =>
      _lfPairNeedAddress;
  String get pairNeedCode => _lfPairNeedCode;
  /// Local validation for the PCID field — same shape and same rule as
  /// [pairNeedCode]: raised only when the field is on screen, and no frame is
  /// emitted. It names the LENGTH because that is the only thing this layer can
  /// actually check (whether the PC exists is the server's answer,
  /// `PAIR_PCID_UNKNOWN`).
  String get pairNeedPcid => _lfPairNeedPcid;

  /// B4-15 — 「这几个地址都试过了」("all these addresses were tried"). One line per
  /// address, with what it answered.
  ///
  /// WHY IT IS NOT JUST 「无法连接到电脑」("cannot connect to the computer"): with
  /// several NICs on the PC that
  /// sentence hides the only actionable fact there is. The user can see which
  /// address their phone is on, so naming the ones we tried is what turns a dead
  /// end into 「哦，它给的是 VPN 那个」("oh, it's giving me the VPN one"). The
  /// addresses are printed VERBATIM (not
  /// prettified) because this is a diagnostic the owner may screenshot.
  String pairCandidatesFailed(List<MapEntry<String, CandidateFailure>> tried) {
    final String unreachable =
        _lfPairCandidatesFailed__1;
    final String dialFailed =
        _lfPairCandidatesFailed__2;
    // D2LAN-B3 — 「the peer isn't that computer」. The wording deliberately
    // avoids the word "network": its remedy is
    // the exact opposite of the other two, and the user's first instinct on
    // reading 「can't connect」 is to go check Wi-Fi.
    final String pinMismatch = _lfPairCandidatesFailed__3;
    // 🔴 An exhaustive switch, not a ternary. This used to be
    // `e.value == CandidateFailure.dialFailed ? dialFailed : unreachable`,
    // and that phrasing would quietly paint **any newly-added enum value** as
    // 「unreachable」 — the one this card just added happens
    // to be exactly the one where 「calling it unreachable would be telling a
    // lie」. A switch expression turns the next added value into a compile
    // error.
    final String lines = tried
        .map(
          (MapEntry<String, CandidateFailure> e) =>
              '· ${e.key}（${switch (e.value) {
                CandidateFailure.dialFailed => dialFailed,
                CandidateFailure.pinMismatch => pinMismatch,
                CandidateFailure.unreachable => unreachable,
              }}）',
        )
        .join('\n');
    // D2LAN-B3 — the moment one identity mismatch shows up, the whole message
    // changes face:
    // the first sentence no longer says 「none of them connected」 (it did
    // connect), and the closing sentence no longer sends the user to check the
    // network (the network is fine).
    final bool anyPinMismatch =
        tried.any((MapEntry<String, CandidateFailure> e) =>
            e.value == CandidateFailure.pinMismatch);
    final String head = anyPinMismatch
        ? _lfPairCandidatesFailed__4
        : _lfPairCandidatesFailed__5;
    final String tail = anyPinMismatch
        // 「it might just be that the computer got swapped」 is true, and also
        // the most common case; so this sentence neither accuses nor
        // brushes it off — it only states clearly **the one useful action**.
        ? _lfPairCandidatesFailed__6
        : _lfPairCandidatesFailed__7;
    return '$head\n$lines\n$tail';
  }

  /// Fail-loud message for a pairing/connect failure. Known codes get readable
  /// copy; anything else gets a generic-but-honest sentence (never a fabricated
  /// specific cause, never a silent / generic success) with the RAW code kept as
  /// a secondary, clearly-labelled diagnostic detail — see the comment on the
  /// final `default:` arm below for why it is neither of the two extremes.
  String pairError(String? code) {
    // B4-15 — checked BEFORE the switch: this code carries a payload, so it can
    // never be an exact `case` label. Decoding here (rather than in the default
    // arm) also keeps `cloudError`'s delegation to this method working, since
    // its default arm calls straight through.
    final List<MapEntry<String, CandidateFailure>>? tried =
        decodeCandidateFailure(code);
    if (tried != null) return pairCandidatesFailed(tried);
    // 🔴 L-② (2026-08-02) — a hold-out refusal arrives as `CODE:ms`, so unpack it
    // BEFORE the switch for the same reason B4-15 does above: a code carrying a
    // payload can never be an exact `case` label. `decodeHoldOut` only touches
    // the two codes that actually have a budget, so `PAIR_TIMEOUT…` and friends
    // fall through with their colons intact.
    final ReconnectRefusal holdOut = decodeHoldOut(code);
    final int? holdOutMs = holdOut.retryAfterMs;
    // 🔴 Q2 (2026-08-12) — a restriction refusal carries an ENUMERATED reason
    // beside its code, unpacked here for the same reason the two decodes above
    // are: a code carrying a payload can never be an exact `case` label. Every
    // other code comes back untouched, so this line cannot change any existing
    // arm — `PAIR_TIMEOUT: …` and `CONNECT_FAILED_CANDIDATES:…` keep their own
    // colons (and the latter has already returned, further up).
    final ({String? code, String? reasonKey}) restricted =
        decodeRestrictionReason(holdOut.code);
    final String? restrictionReasonKey = restricted.reasonKey;
    switch (restricted.code) {
      case 'PAIR_INVALID_CODE':
      case 'PAIR_INVALID_PAYLOAD':
        return _lfPairError__1;
      case 'PAIR_EXPIRED_CODE':
        return _lfPairError__2;
      // ── 0.2.66 PCID (design §5.3 / §7-4) ──────────────────────────────────
      //
      // 🔴 THIS IS THE ONE CODE ON THIS SCREEN THE USER CAN FIX THEMSELVES, so
      // the sentence NAMES THE ACTION — both of them, because there are two and
      // they cost different amounts (scanning is one tap; typing nine digits is
      // the fallback when the QR is not in front of them). Precedent for naming
      // the action rather than stating the fact: `PC_BUSY` below.
      //
      // ⚠️ It deliberately does NOT say 「切换到局域网」("switch to the LAN"). The relay is often the
      // only route the two machines have, and sending someone to a network that
      // may not exist is the `INJECT_CLOUD_IMAGE_TOO_LARGE` mistake in reverse.
      //
      // Reaching this arm ALSO force-shows the field the user needs
      // (`isPcidRequiredRefusal` → `add_pairing_sheet.dart`), so the action this
      // sentence names is on screen by the time it is read. A sentence naming a
      // control that is not there would be the promise-this-screen-cannot-keep
      // shape (`INJECT_PC_MISMATCH`).
      //
      // ⚠️ ja/ko written to the register of the neighbouring entries, NOT by a
      // native speaker — flagged for owner ratification with the rest of this
      // code's copy.
      //
      // ⚠️ NOT byte-identical to the registered protocol string
      // (`packages/protocol/src/error-codes.ts` PAIR_PCID_REQUIRED, which the
      // desktop and console render). Same two actions, same order; this face
      // adds 「9 位」("9 digits") because the phone is the ONLY surface where those digits get
      // typed, so the length is actionable here and nowhere else. Recorded
      // rather than left to be noticed: the neighbouring `ACCOUNT_RESTRICTED`
      // arm deliberately DOES match its protocol string, and the difference
      // between the two decisions has to be readable.
      //
      // ⚠️ These two arms match a CONSTANT where their neighbours match a
      // literal, and that is deliberate: `kPairPcidRequired` is the same value
      // the sheet tests to reveal the field, so one spelling serves both. The
      // neighbours have no second reader and gain nothing from the ceremony.
      case kPairPcidRequired:
        return _lfPairError__3;
      // 🔴 A SEPARATE CODE FROM THE ONE ABOVE, AND IT MUST STAY SEPARATE: this
      // one means the address was supplied and pointed nowhere, so 「扫码或补输」
      // ("scan again or re-type") would send the user to do again what they
      // just did. The server folds
      // 「格式不对」("bad format") and 「查无此机」("no such machine found") into
      // this one code because BOTH have the same
      // remedy — re-read the number off the PC (design §5.3).
      //
      // Says nothing about the pairing code: the code may be perfectly correct
      // here, and 「配对码无效」("invalid pairing code") is precisely the
      // wrong-cause-right-action failure
      // this repo keeps paying for (一码两问 / "one code, two questions" is a red
      // line).
      case kPairPcidUnknown:
        return _lfPairError__4;
      case 'PAIR_RATE_LIMITED':
        return _lfPairError__5;
      case 'PAIR_PC_OFFLINE':
        return _lfPairError__6;
      case 'PAIR_NOT_CONNECTED':
        // Admission is real now (WP-R4-1): this is a genuine no-connection, not
        // the retired 「暂未开放」("not yet available") placeholder.
        return _lfPairError__7;
      // 🔴 owner 2026-08-03 —— 「pairing failed: unknown error」 should speak like
      // a human.
      //
      // In **this function**, this code has only one source: this phone's
      // `mobile_pairings` row on the computer
      // no longer exists. Pressing 「revoke pairing」 on the PC deletes exactly
      // this row (`pc.handler.ts`'s
      // `registry.revokeMobile(...)` call),
      // after which the phone's token is rejected at the **handshake
      // middleware** (`auth/middleware.ts`'s
      // `AUTH_TOKEN_INVALID` branch).
      // ⚠️ The cloud path **does not go through here**: `cloudError` has its own
      // `AUTH_TOKEN_INVALID` arm
      // (「your login status is invalid, please log in again」), which is about
      // the JWT, not the pairing — two different things, two different
      // sentences.
      //
      // The old copy, 「your login has expired, please re-pair」, read this as
      // an **account** problem, when there is no account involved here at all;
      // the action was right, the reason was wrong, and the user would go
      // check their login. Now both the reason and the action are stated in
      // full.
      //
      // ⚠️ **It is NOT 100% guaranteed to only mean 「revoked」**: the computer
      // being reinstalled / the database being reset / a different computer
      // taking over the same address would all produce the same refusal, and
      // this layer **cannot tell them apart** (that would need the server to
      // leave a tombstone, i.e. a DB migration). This sentence was chosen
      // because **the action needed is identical in all three cases**, and
      // 「re-pair」 genuinely solves the problem in all three — **this sentence
      // never sends the user on a wild goose chase in any of them**. owner
      // 2026-08-03 explicitly asked for this sentence.
      case 'AUTH_TOKEN_INVALID':
        return _lfPairError__8;
      // 🔴 L-② (2026-08-02) — 「PC 上刚点了断开」("disconnect was just pressed on
      // the PC"). The pairing is INTACT and the
      // token was deliberately kept (`mobile_reconnect_flow.dart:75`): the only
      // useful action is to wait, so the sentence says how long and never
      // 「请重新配对」("please re-pair"). Until this case existed the whole path
      // answered with a
      // fabricated `AUTH_TOKEN_INVALID`, i.e. the copy directly above — the
      // opposite of the truth, and owner's 「过了一会又能连了，看不懂怎么回事」
      // ("after a while it connects again, and I can't tell what's going on").
      //
      // 🔴 THE NUMBER IS THE SERVER'S, AND IT IS A ONE-SHOT STATEMENT, NOT A
      // LIVE COUNTDOWN. The window lives only in the relay's memory
      // (`release-suppression.ts:21-26`) and a server restart clears it, so a
      // ticking clock that reached 0 would be the phone ASSERTING 「可以连了」
      // ("it's connectable now")
      // from a stale reading — the very 「问不到时沿用上一次的答案」("reusing the
      // previous answer when you can't get a new one") that volume 15
      // §1.4.1 bans for PcPresence. What the user does next (tap again) re-asks
      // the server, which is the only thing that can answer it.
      //
      // The first clause is BYTE-IDENTICAL to `image_strings.dart:304-310`: one
      // fact, one sentence, on whichever path it surfaces.
      case 'PAIR_RELEASED':
        if (holdOutMs == null) {
          return _lfPairError__9;
        }
        final int secs = (holdOutMs / 1000).ceil();
        return _lfPairError__10(secs);
      case 'PC_BUSY':
        // GA-29: the PC keeps both channels open but the capsule admits ONE
        // phone. Nothing is wrong with this pairing and nobody pressed
        // disconnect (断开) —
        // the machine is simply taken — so the copy says「稍后再试」("try again
        // later") and the
        // ladder keeps the token (an unknown code would too, but the user would
        // read a raw error string instead of a fact about the PC).
        // owner 2026-07-27:「让另外来连接这个 PC 的手机用户知道，我应该去把
        // 他那边退出，然后再去连接」("let the other phone user trying to connect
        // to this PC know that I should go make them exit their side, and then
        // go connect") — 「稍后再试」 states the fact and leaves the
        // user with nothing to do about it. Name the action instead.
        return _lfPairError__11;
      case 'PAIR_NO_TOKEN':
      case 'PAIR_BAD_ACK':
        return _lfPairError__12;
      // 🔴 card U5 [measured] —— today this code falls through in the
      // `default:` branch to a bare identifier,
      // 「pairing failed: MOBILES_LIMIT_EXCEEDED」, and it's the exact line an
      // **already-paying** user reads when pairing their Nth+1
      // phone (0.2.53 was the patch for the exact same class of incident).
      //
      // SSOT: packages/protocol/src/error-codes.ts `MOBILES_LIMIT_EXCEEDED`
      // (`zh_CN: '已达套餐手机数量上限。'`("plan's phone-count limit reached.")),
      // and the comment right after it (F-2325 / SB-1) states
      // 「only an admin may change a plan... Surfaced to the console Upgrade
      // CTA」 — changing a plan/device is an **admin** action on the **web
      // console**; the phone-side App has
      // no such thing, and should not pretend to have an "upgrade" or "manage
      // devices" entry point (grepped
      // `apps/mobile/lib` for plan/billing/upgrade/device-management,
      // zero hits).
      //
      // ⇒ This sentence states only two true facts: the quota is full, and
      // where to resolve it (the account admin on the web console), without
      // inventing a button or page this App does not have.
      case 'MOBILES_LIMIT_EXCEEDED':
        return _lfPairError__13;
      // F1 (2026-08-12) — 「限制使用」("usage restricted") reaches the phone as
      // of this round: the
      // socket admission gates (`mobile:pair` in all three shapes, and
      // `mobile:reconnect`) refuse a restricted account by name. Without this
      // case the `default:` arm below renders 「配对失败，请检查网络后重试 · 诊断码
      // ACCOUNT_RESTRICTED」("pairing failed, please check your network and
      // retry · diagnostic code ACCOUNT_RESTRICTED"), which is worse than a
      // bare identifier: the code is
      // exposed AND the sentence instructs the user to do something that cannot
      // possibly help. Checking the network is not the remedy for a moderation
      // decision, and retrying is not either. Same defect family as card U5
      // above and as 0.2.53.
      //
      // 🔴 NO IMPERATIVE, ON PURPOSE. There is nothing the user can do here —
      // owner ruled there is no appeal channel. The two things they MAY still do
      // (export their data, close the account) are reachable in the web console
      // and have no entry point in this app, so naming them here would be a
      // promise this screen cannot keep — the `INJECT_PC_MISMATCH` precedent.
      //
      // The first clause matches the registered protocol string for this code
      // (`packages/protocol/src/error-codes.ts` `ACCOUNT_RESTRICTED`), so the
      // account face and the pairing face cannot drift into two answers.
      // ⚠️ ja/ko written to the register of the neighbouring entries, NOT by a
      // native speaker — flagged for owner ratification with the rest of this
      // code's copy.
      //
      // 🔴 Q2 (2026-08-12) — AND THE REASON, WHEN THE SERVER SENT ONE. The
      // refusal now arrives as `ACCOUNT_RESTRICTED:<reason_key>` (see
      // [decodeRestrictionReason]); the key is rendered by
      // [restrictionReasonNote] and appended as a SECOND sentence. Absent /
      // unrecognised ⇒ this first sentence alone, unchanged.
      case 'ACCOUNT_RESTRICTED':
        final String head = _lfPairError__14;
        final String? why = restrictionReasonNote(restrictionReasonKey);
        if (why != null) return '$head\n$why';
        if (restrictionReasonKey == null || restrictionReasonKey.isEmpty) {
          return head;
        }
        // 🔴 A REASON KEY WE DO NOT RECOGNISE IS NOT SWALLOWED AND NOT INVENTED.
        // The server may enumerate a sixth reason before this table learns about
        // it (nothing binds the two — see [restrictionReasonNote]). Guessing a
        // sentence would tell a real person something nobody decided about them;
        // dropping the key silently would hide the one artefact they could quote
        // to a maintainer. So it takes exactly the shape the `default:` arm below
        // gives an unknown ERROR code: kept, demoted, and labelled as an
        // identifier — 0.2.53's rule, applied to the value beside the code.
        return '$head${_diagTail(restrictionReasonKey)}';
      default:
        if (code != null && code.startsWith('CONNECT_FAILED')) {
          return _lfPairError__15;
        }
        if (code != null && code.startsWith('PAIR_TIMEOUT')) {
          return _lfPairError__16;
        }
        // 🔴 card U5 remainder —— this return used to be 「pairing failed:
        // ${code}」, i.e. the entire
        // user-readable text was literally a protocol-internal identifier,
        // which is exactly the hole U5's 「the default branch must not print a
        // bare identifier」
        // is meant to plug. But this repo's 0.2.53 precedent is equally valid
        // and not stale: 「an unrecognised error code's behaviour is
        // unchanged, character for character — still print the bare
        // identifier, don't make up a sentence for it」 — what THAT rule bans
        // is **inventing a specific-sounding reason for an unrecognised code
        // that is actually just a guess** (the family of defects 0.2.53 fixed
        // was the opposite: six **recognised** codes each get a true
        // sentence, and the seventh, unrecognised code is deliberately left
        // un-invented, because guessing wrong is a new incident).
        //
        // The two rules govern two different things within the same sentence,
        // and the answer isn't an either/or:
        //   · what the user needs is a human sentence — 「what happened, what
        //     can I do」 — not a string of codes;
        //   · but which specific kind of failure this is, this layer
        //     genuinely does not know right now (the SSOT is
        //     packages/protocol/src/error-codes.ts, and the server can add a
        //     code with no case written here at any time), so inventing a
        //     specific reason would be guessing.
        // Hence: the main sentence only promises the two things it can
        // currently guarantee are true (pairing did not succeed + what can be
        // done), and never fabricates 「why」; the raw code is neither deleted
        // nor rewritten, but demoted to a **secondary tail explicitly
        // labelled 「diagnostic code」**, for the user to read aloud to a
        // maintainer or screenshot. This way neither precedent is violated:
        // the screen no longer shows only a bare code (satisfies U5), and the
        // code itself is neither replaced by the 0.2.53-banned 「made-up
        // specific reason」 nor swallowed (satisfies 0.2.53).
        // 🔴 Q2 — the four hand-rolled tails this arm used to build were folded
        // into [_diagTail], which already resolves the locale itself. One
        // vocabulary for 「这是一个标识符，不是给你读的话」("this is an
        // identifier, not a sentence meant to be read"): the restriction arm
        // above needed exactly the same tail, and two copies of it is how the
        // two would have come to label the same thing with different words.
        final String diag = code == null ? '' : _diagTail(code);
        return _lfPairError__17(diag);
    }
  }

  /// 「这串东西是个标识符」("this string of stuff is an identifier") — the
  /// labelled, demoted tail an identifier gets when
  /// this layer has nothing truer to say about it.
  ///
  /// Used by BOTH the unknown-error-code arm and the unknown-restriction-reason
  /// arm of [pairError]. It is a function rather than two inline literals
  /// because those two are one decision (0.2.53: keep the identifier, never
  /// invent a sentence for it), and a decision written twice is a decision that
  /// will be changed once.
  String _diagTail(String identifier) => _lf_diagTail(identifier);

  /// Q2 (owner 2026-08-12:「枚举原因给用户；运营自由文本只进审计」("enumerated
  /// reasons go to the user; operator free text goes only into the audit
  /// log")) — the
  /// user-facing sentence for ONE enumerated restriction reason, or null when
  /// this table does not know the key.
  ///
  /// SSOT: `packages/protocol/src/restriction-reasons.ts`. That file is the
  /// server half and it says so; the phone cannot import TypeScript, so this is
  /// a HAND-MIRRORED copy — the same standing gap CLAUDE.md records as 「仍然开着
  /// 的根因」("the root cause that's still open") for error codes (「没有任何机制把
  /// 协议注册表与手机那张表绑在一起」("there is no mechanism binding the protocol
  /// registry to the phone's own table")).
  /// `test/restriction_reason_copy_mirror_test.dart` reads that .ts as TEXT and
  /// fails when a key exists there with no copy here, which is the only thing
  /// standing between a new reason and a bare identifier on a real person's
  /// screen. It is a guard, not a binding: the two tables are still two tables.
  ///
  /// 🔴 WHY THE SERVER SENDS A KEY AND NOT THIS SENTENCE. The server would have
  /// to choose the reader's language to send a sentence, and 「UI 不跟随 OS
  /// locale」("UI does not follow OS locale") (CLAUDE.md red line) puts that
  /// choice on the client. So the wire
  /// carries a stable identifier and each client renders it from its own table.
  ///
  /// 🔴 WHAT THIS SENTENCE IS NOT. It is NOT the operator's note. That value —
  /// free text, one language, possibly naming another account or an internal
  /// ticket — lives in `ops_audit_log.detail` and never crosses to a user
  /// surface (`auth/account-restriction.ts` is built so no gate can assemble a
  /// body containing it). Two values, two questions.
  ///
  /// 🔴 NULL FOR UNKNOWN, AND NEVER A FALLBACK SENTENCE. Substituting `other`
  /// 's copy for a key we do not recognise would tell a specific person a
  /// sentence nobody decided about them — the same reason the server omits the
  /// field entirely rather than defaulting it. The caller degrades to the
  /// labelled identifier instead.
  ///
  /// ⚠️ ja/ko carried over from the protocol table's own entries, NOT written by
  /// a native speaker — flagged for owner ratification with the rest of this
  /// code's copy.
  String? restrictionReasonNote(String? key) {
    switch (key) {
      // The ordinary case: use that breaches the Terms.
      case 'terms_violation':
        return _lfRestrictionReasonNote_terms_violation;
      // 🔴 Deliberately NOT sharing copy with `terms_violation`. The protocol
      // table's own note says why, and it survives translation: this one says
      // 「你用得太猛」("you're using it too aggressively"), that one says 「你做了
      // 不该做的事」("you did something you shouldn't have"), and telling
      // somebody the
      // wrong one of those is a real harm even though both end in a restriction.
      case 'automated_or_bulk_use':
        return _lfRestrictionReasonNote_automated_or_bulk_use;
      // The one reason on this list where the restriction is FOR the account
      // holder rather than against them — which is why it shares copy with
      // nothing above it.
      case 'account_security':
        return _lfRestrictionReasonNote_account_security;
      // Says nothing about WHICH law, on purpose: the Terms promise 「we will
      // tell you why UNLESS THE LAW PREVENTS US」, and this is how that exception
      // is expressed without pretending no reason exists.
      case 'legal_requirement':
        return _lfRestrictionReasonNote_legal_requirement;
      // 🔴 NOT a fallback this code picks — an operator chooses it deliberately,
      // and it is honest: a human reviewed the account and decided, which is
      // exactly what happened. An unknown key does NOT land here (see the
      // `default` arm); if it did, this table would be inventing.
      case 'other':
        return _lfRestrictionReasonNote_other;
      default:
        return null;
    }
  }
}
