// 800-line cap (CARD-UI pushed chat_message_tile.dart to 818): line 2's
// flexible tail moved here VERBATIM from the tile's build; no behaviour change.
part of 'chat_message_tile.dart';

/// CARD-UI — the ONE flexible item of the tile's second meta line: the
/// resent time, the reason / failure-code line and the picture note, each
/// single-line and ellipsized, in that order. See `chat_message_meta.dart`.
List<Widget> _metaTail({
  required TimelineEntry entry,
  required AppStrings strings,
  required DeliveryFace face,
  required bool explainNoImageResend,
}) => <Widget>[
  // owner 2026-07-31 real device: 「如果是重发，最好是在手机端也显示一下重发的
  // 时间，这样好识别区分，但原时间也要保留，即在原消息上显示一个最后的
  // 重发时间」("if it's a resend, it would be best to also show the
  // resend time on the phone side, so it's easy to tell apart, but
  // the original time should also be kept, i.e. show a last-resend
  // time on the original message").
  //
  // Sits IMMEDIATELY after the spoken time so the two instants are
  // read side by side — that adjacency is what makes 「哪个是原时间、
  // 哪个是重发时间」("which is the original time, which is the resend
  // time") a glance instead of a comparison. The original is
  // the bare dim one (unchanged, t3); this one is labelled and one
  // shade brighter (t2), so neither can be mistaken for the other.
  //
  // ⚠️ ONLY on a row that was actually re-sent. Null ⇒ nothing is
  // built at all — no placeholder, no 「—」. A field that always
  // renders is a field that tells you nothing.
  //
  // CARD-UI (MAIN 2026-10-14): a fact (owner 07-31: both instants stay on
  // the row). It used to be Flexible + ellipsis and vanished on most narrow
  // cards; now it sits on line 2 when it fits and on the overflow line
  // otherwise, never cut (chat_message_meta.dart `MetaFact`).
  if (entry.lastResentAt case final DateTime resentAt?) ...<Widget>[
    MetaFact(
      child: Text(
        strings.resentAtLabel(timelineTimeLabel(resentAt)),
        style: TextStyle(color: FlowMicColors.t2, fontSize: 10.5),
      ),
    ),
  ],
  // RV-14: surface the named failure code next to the bare ✗ so the
  // carefully minted codes (LINK_DOWN / INJECT_NO_RESULT / …) are
  // not evaporated at the store door. Raw identifier, never i18n —
  // error codes are identifiers, not copy. Truncate so a long
  // detail string cannot blow the meta row.
  //
  // N2: ✗ only. RV-43 §4 gives undelivered no reason line —
  // 「没投递，可补投」("not delivered, can be backfilled")
  // is the whole story there, and a row may carry a code from an
  // earlier attempt (copyWith cannot clear one), so showing it here
  // would attach a stale failure to a state that is not a failure.
  //
  // 🔴 window B3-2b / RV-67 — ⛔ JOINS ✗ HERE, and this line is half the
  // fix. The stale-code argument above is exactly why the gate was
  // written as 「failed only」, and it is exactly why a terminal
  // refusal was invisible: `INJECT_PC_MISMATCH` arrives with
  // `mode:'cached'`, so the row settles `cached`, the face was
  // undelivered, and the carefully minted code sat in the store being
  // shown to nobody — 「一条红线级事故」("a red-line-grade incident")
  // rendered as a routine wait.
  // ⛔ is not exposed to the stale-code hazard: unlike undelivered it is
  // DERIVED FROM the code (deliveryFaceOf reads it), so the face
  // cannot exist without the very code being printed.
  //
  // 🔴 window B4-5 — `DeliveryFace.noFocus` is DELIBERATELY ABSENT FROM
  // THIS CONDITION, and for the opposite reason ⛔/✗ are in it. ✗ and
  // ⛔ each cover MULTIPLE codes under one word (LINK_DOWN vs.
  // INJECT_NO_RESULT vs. INJECT_SENDINPUT_FAIL all say 未成功
  // ("unsuccessful"); six
  // different terminal codes all say 投递被拒("delivery refused")),
  // so the code is the
  // ONLY thing that says WHICH one happened. `noFocus` exists for
  // exactly ONE code (`INJECT_NO_TEXT_TARGET`) and its word already
  // says the whole fact in Chinese — printing the raw identifier
  // beside it would repeat the same information less legibly, not
  // add any. If a second code is ever folded into `noFocus`, THAT
  // is the moment to add it back here (the ✗/⛔ shape, not this one).
  //
  // 🔴 Card B4-12 (Book 15 G-16 partial) — 📥 UNDELIVERED CAN NOW
  // ALSO CARRY A
  // LINE, but only for `INJECT_CLOUD_IMAGE_TOO_LARGE` /
  // `INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED`
  // (`AppStrings.cloudImageRelayErrorNote`), and this is a real
  // exception to the paragraph three above, not a silent widening
  // of it. Both codes arrive with `mode:'cached'`
  // (relay.handler.ts `answerReject` always sends it) and are NOT
  // in `isTerminalRefusalCode` (outbox_item.dart) — retrying
  // genuinely can succeed once the phone is on a different link or
  // once the 24 h window has rolled, which is clause ① of that
  // predicate's own test — so `deliveryFaceOf` correctly settles
  // them `undelivered`, never `refused`/`failed`. Left at
  // undelivered's
  // ordinary blanket silence, a quota refusal would render 「📥
  // 未投递」("undelivered") with a live resend button and NO
  // explanation for up to
  // 24 h — worse than the raw identifier this card exists to
  // replace, and arguably its own silent failure. Every OTHER code that
  // reaches undelivered (`INJECT_FOCUS_LOST` etc.) is UNCHANGED: (see
  // [_reasonLineFor] for the one place that decides this).
  if (_reasonLineFor(face, entry.failureReason, strings)
      case final String line?) ...<Widget>[
    // CARD-UI (MAIN 2026-10-14): a fact, not a tail that gives way. It used
    // to be Flexible + ellipsis (so it vanished on most narrow cards); now it
    // sits on line 2 when it fits and on the overflow line otherwise, never
    // cut (chat_message_meta.dart `MetaFact`).
    MetaFact(
      child: Text(
        line,
        style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
      ),
    ),
  ],
  if (explainNoImageResend) ...<Widget>[
    // window B3-9 / Book 15 G-11 — occupies the EXACT slot
    // [canResend]'s
    // underlined resend would sit in. That adjacency is the
    // point: a
    // picture row that showed this button while queued and shows
    // NOTHING once delivered is 「有的图能重发、有的不能，没人说为什么」
    // ("some pictures can be resent and some can't, and nobody
    // says why")
    // — the gap the card was opened to close. Plain text, not a
    // button: R8's own rule is a control that changes nothing is
    // worse than no control, so this must never be tappable.
    MetaFact(
      child: Text(
        strings.imageResendUnavailableNote,
        key: ValueKey<String>('entry.imageResendNote.${entry.id}'),
        style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
      ),
    ),
  ],
];
