// VERBATIM MOVE out of chat_flow_page.dart (800-line cap: that file stood at
// 800/800 and card RC-H has to add a listener pair to it). The haptic receipt
// observer's body came across unchanged: the instance method became a
// top-level function taking the explicit receiver `_ChatFlowPageState s`
// first (the body reads no member, so no receiver prefix was needed), and the
// whole block lost one level of indentation. chat_flow_page.dart keeps
// `_onInjectReceipt` as a one-line delegation, so its one call site
// (`injectResults.listen`) is untouched. Any other diff is a bug.

part of 'chat_flow_page.dart';

/// V2-04: the inject:result IS the moment the PC's truth arrives — the one
/// signal the person watching the PC (not the phone) can actually feel.
/// ONE pulse = landed, TWO = failed. `cached` is NEITHER (the PC queued the
/// text for a target it does not have yet): buzzing success would claim an
/// injection that has not happened, buzzing failure would claim a loss that
/// did not occur — so it stays silent and the row badge carries the truth.
///
/// 只吵一次 ("makes noise at most once") check: a wire inject:result never coincides with a banner. The
/// banner sources (connection / auto-stopped / sttStalled / utterance /
/// send / ai / image failures) all settle WITHOUT an inject:result frame —
/// the send-side failures mean no frame ever left or returned.
void _onInjectReceiptRouted(_ChatFlowPageState s, InjectResult r) {
  if (r.ok) {
    unawaited(FlowMicHaptics.injectSuccess());
    // N2: the literal was already here, and this observer was the ONLY place
    // that read the verdict's own word — the row write-back threw it away and
    // called every ok:false a failure, which is how the buzz and the badge came
    // to describe the same frame differently. Same named constant now.
    // 🔴 Card F2 addendum (2026-08-02) — the second clause is **the same
    // leak plugged twice**, see the long comment inside
    // `timeline_store.applyInjectResult`: the `mode` the desktop stamps for
    // `INJECT_NOT_PRIMARY` (another phone is occupying this PC) is
    // **fabricated** (`socket/client.rs`'s `build_inject_result(false,
    // "sendinput", Some(error_codes::INJECT_NOT_PRIMARY), …)` stamps
    // `"sendinput"`, while it never pressed a single key).
    // The passage above already sets its own rule — 「buzzing failure would
    // claim a loss that did not occur」 — and being occupied is **precisely
    // NOT a loss**: the queue still owes it, and it will be delivered the
    // moment the other side leaves.
    // ⇒ Same category as `cached`: **stay silent**, and let the truth be
    // carried by the row's badge and that state-type banner (§2.5d).
  } else if (r.mode != TimelineStore.kWireModeCached &&
      !isPcAdmissionRefusalCode(r.error)) {
    unawaited(FlowMicHaptics.injectFailure());
  }
}
