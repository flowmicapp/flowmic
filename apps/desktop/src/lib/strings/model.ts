// String catalogue shard: the BUILT-IN SPEECH MODEL — its state, its download,
// and the one-time notice that says why a 228 MB file is about to be fetched.
// Merged and exported by ../strings.ts.
//
// SPEC-REF: docs/strategy/2026-08-19-local-model-onboarding-design.md §5.
//
// ── THE COPY DISCIPLINE FOR THIS WHOLE SHARD (§5-D) ─────────────────────────
//
// ① NO ENVIRONMENT-VARIABLE NAME IN BODY COPY. Until today the ONLY way to get
//    the model was to set one, and the sentence the user met — at the worst
//    possible moment, having just held the button and spoken — was a developer
//    line with a filesystem path and a flag in it. The name is not deleted (it
//    is still the right answer for a machine nobody is sitting at), it is
//    demoted: it lives in `model_adv_body`, inside a fold, and nowhere else.
//    `model_adv_body` is the ONE key in this shard allowed to contain it.
//
// ② NO SIZE BAKED INTO A SENTENCE. The figure comes from the snapshot's
//    `bytes_total` at render time (see lib/model-status.ts formatMbCoarse), so
//    the two keys that mention a size are FUNCTIONS taking the formatted string.
//    A 「229 MB」 typed into nine languages is nine copies of a number that
//    changes when the model does, and eight of them would be wrong quietly.
//    🔴 That is also why there are two download labels: `model_dl` is the one
//    for when the server did not tell us a total, and it says nothing about
//    size rather than guessing one.
//
// ③ NO PROMISED FINISH TIME that is not computed from a measured rate (§2-6).
//    Hence four ETA keys, not one: 「estimating」 (we are still measuring),
//    「less than a minute」, 「more than an hour」, and 「cannot be worked out
//    without the total size」 — that last one is a DIFFERENT fact from
//    「estimating」 and must not share a sentence with it, because one of them
//    resolves on its own and the other never will.
//
// ④ THE SENTENCE SAYS WHY THERE IS A DOWNLOAD AT ALL. `model_why` and
//    `model_notice_body` both carry 「the installer does not contain it」. The
//    owner's words: the user has a right to know that rather than being
//    surprised by a network request. It is the one clause in this shard that
//    may not be trimmed for length.
//
// ⑤ 🔴 NOTHING HERE MAY SAY THE DOWNLOAD CAN START BY ITSELF. The disclosure
//    page now promises, in nine languages, 「That download only ever happens
//    because you asked for it — never on its own」. Three strings in this shard
//    were rewritten on 2026-08-19 because they read as a contradiction of that
//    promise even though each was true under its own reading:
//      · `model_why` said the engine 「downloads it once」 — agentless, so it
//        reads as automatic. It now names who asks.
//      · `model_notice_body` said 「It is downloaded once」 — same passive.
//      · `model_adv_body` said the service fetches it 「on its own」, which is
//        the literal phrase the disclosure denies. It now describes the
//        environment variable as THAT SAME CONSENT GIVEN IN ADVANCE, and says
//        what happens without it.
//    ⚠️ The rule for the next sentence added here: a user reads these screens in
//    one sitting, and 「true under its own reading」 is not the bar — two
//    surfaces of one product may not appear to disagree about whether we
//    touch the network without being asked.
//
// ⚠️ WHAT THIS SHARD MAY NOT SAY, AND WHO OWNS IT. The disclosure page's
// `disc_s2_local` (../strings/disclosure.ts) still tells the reader the built-in
// engine downloads a model 「only if you explicitly set
// FLOWMIC_SHERPA_AUTO_DOWNLOAD=1」. A Download button makes that false. That key
// is owned by the disclosure lane together with its phone twin and the
// `verify:lint disclosure-copy-mirror` gate that pins the pair — it is NOT
// touched here, and this note is the hand-off.

import { shardCatalogue } from './shard';

export const MODEL_KEYS = [
  // The card's own name. 「Built-in」 rather than 「local」: 「local」 already
  // means 「on your LAN」 elsewhere in this product (本地局域网), and the LAN
  // FunASR engine is local too — two things called local on one settings page
  // is the ambiguity the channel vocabulary spent a whole window removing.
  'model_title',
  // ④ above. Present on the card even when everything is `ready`, because the
  // question 「why did this thing download 228 MB once」 outlives the download.
  'model_why',
  // ── the five states of §3, five separate words ────────────────────────────
  // 🔴 They are five keys and not a computed adjective for exactly the reason
  // §2-2 gives: `absent` and `partial` differ by whether there is something to
  // resume, and that difference is worth 228 MB of somebody's bandwidth.
  'model_state_ready',
  'model_state_absent',
  'model_state_partial',
  'model_state_downloading',
  'model_state_failed',
  // A SIXTH word, and it is not a state of the model — it is the state of our
  // knowledge (the local service did not answer). `asAccessibilityStatus`'s rule
  // in this shard's terms: 「不知道」 and 「没有」 must never share a face, since
  // one of them has a Download button under it and the other must not.
  'model_state_unknown',
  'model_unreachable',
  // What `ready` actually certifies — and, in the second sentence, what it does
  // NOT (§3's closing warning: the files being right is not the engine loading).
  // The two halves are one key because a reader who gets only the first half
  // draws the wrong conclusion, and copy that is only safe when fully quoted
  // should not be splittable.
  'model_verified',
  // ── the actions ───────────────────────────────────────────────────────────
  // `model_dl` is the no-known-total variant; the sized one is
  // SETTINGS_MSG.modelDownloadSize (see ② above).
  'model_dl',
  // Likewise `model_resume` is the variant for when we cannot say how far along
  // it is. §5-A requires the percentage where we have it — 「继续下载（已完成
  // 43%）」 — because without it the user cannot tell that resuming is cheap.
  'model_resume',
  'model_cancel',
  // Says what Stop preserves. Without it, Stop reads as 「throw away the
  // 140 MB you already fetched」 and nobody on a slow link would ever press it —
  // which is the opposite of why it is there.
  'model_cancel_note',
  // The retry label carries its own promise (it resumes) rather than deferring
  // to a note underneath: this is the button somebody presses while annoyed.
  'model_retry',
  'model_recheck',
  'model_checking',
  'model_starting',
  // §2-5 / §5-A: the second exit. A user who cannot reach any source is not out
  // of options, and naming both of them (place the files / choose another
  // engine) is what keeps a failed download from being a dead end.
  'model_manual',
  'model_dir',
  'model_copy',
  'model_copied',
  // The failure of the copy button says what still works. Same shape as
  // `perm_ax_open_failed`: the path stays on screen and stays selectable, so
  // the button breaking costs the reader nothing but a drag of the mouse.
  'model_copy_failed',
  // §2-4 requires WHICH SOURCE, and this note says why the label moves. A user
  // watching 「Hugging Face」 become 「hf-mirror.com」 is watching the failover
  // work; without the note they are watching something inexplicable happen to a
  // download they were already worried about.
  'model_source',
  'model_source_note',
  'model_downloaded',
  // 🔴 §4's null total, said in words. NEVER 0 %, never 100 % — 「I do not know
  // the total」 and 「the total is zero」 are two facts and only one of them is
  // ever true here.
  'model_total_unknown',
  // ── the four ETA answers (③ above) ────────────────────────────────────────
  'model_eta_estimating',
  'model_eta_lt_min',
  'model_eta_over_hour',
  'model_eta_no_total',
  // The fold that holds the machine truth: the error code, the message, the
  // directory. Body copy stays human; nothing is thrown away.
  'model_detail',
  'model_failed_next',
  // ① above — the ONLY key in this shard that may name the environment
  // variable, and it is inside a fold labelled for the case it serves.
  'model_adv',
  'model_adv_body',
  // ── §5-B, the main-window notice ──────────────────────────────────────────
  // 🔴 It is NOT a modal and its copy has to earn that: one sentence of what is
  // true, one of why, one action, one dismissal. Anything longer would be a
  // dialog wearing a banner's clothes.
  'model_notice_title',
  'model_notice_body',
  'model_notice_open',
  // 「Not now」 rather than 「Don't show again」: it is remembered for THIS
  // session only (lib/model-client.ts says why), and a button must not promise
  // a duration the mechanism does not keep.
  'model_notice_dismiss',
  // A pressed button that did nothing must say so — 「没有静默失败」 in its
  // smallest form.
  'model_action_failed',
] as const;

export const MODEL_STRINGS = shardCatalogue(MODEL_KEYS);
