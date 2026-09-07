// Capsule speaking-form live stats: HOW LONG this recording has been running and
// HOW MANY segments the server has finalised so far — the pair owner asked for on
// 2026-09-07 (「转录中，PC 胶囊小图标那一行右侧加上时长·数量」), phrased there as
// 「那边多长时间，这边多长时间」: the number on this PC must mean the same thing as
// the number the speaker is watching on the phone.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHERE THE DEFINITIONS COME FROM — AND WHY THEY ARE NOT A SESSION TOTAL
// ═══════════════════════════════════════════════════════════════════════════
// The card that commissioned this asked for a SESSION aggregate: Σ duration_ms
// over the utterances delivered since the phone joined, plus a count of those
// utterances, with an additive `inject:request` field added if the PC could not
// derive it. That design was dropped after measuring the phone, and the reason
// is the whole point of this file:
//
//   🔴 THE PHONE HAS NO SESSION-LEVEL AGGREGATE ANYWHERE. Not while recording,
//   not after. There is no running total of duration and no running count of
//   utterances on any phone surface (swept 2026-09-07: no accumulator exists —
//   `PttSession` (apps/mobile/lib/src/ptt/ptt_session.dart) carries no stats
//   fields, and the Settings → Data 「统计与清空」 sheet is an `AssetInventory`
//   walk of the whole stored database, computed on open, not a live figure).
//
// So a session total could not have satisfied 「那边多长时间，这边多长时间」: there
// would have been nothing on the phone for it to agree WITH, and the PC would
// have been showing a number that exists nowhere else in the product — the exact
// shape of a value that answers a question nobody asked.
//
// What the phone DOES show while transcribing, on all three of its live
// surfaces, is the same pair this file computes:
//
//   · apps/mobile/lib/src/ui/recording_panel.dart — the push-to-talk strip:
//       `elapsed`      「Time since audio:start (local clock)」
//       `segmentCount` 「Soft segments observed on the wire」
//   · apps/mobile/lib/src/ui/continuous_live_bar.dart — the long-recording bar:
//       `segmentCount` 「Segments the SERVER has finalised so far」
//   · apps/mobile/lib/src/ui/chat_article_tile.dart — the article card, shown
//     WHILE the recording is being made:
//       `articleCardMeta(formatEntryDuration(durationMs), segmentsCount)`,
//       whose i18n template is literally 「$clock · $n 段」 — owner's requested
//       「时长 · 数量」, already shipped, on the phone.
//
// ⇒ The unit of both numbers is ONE audio:start → settle. In push-to-talk that
//   is one utterance; in a long continuous recording it is the whole recording
//   (the capsule stays in the `speaking` form throughout — the latch watchdog is
//   fed by `stt:level` heartbeats, see speaking-watchdog.ts). That is the phone's
//   own boundary, adopted rather than invented, and it is why this file is named
//   for the speaking form and not for a "session".
//
// 🔴 NO PROTOCOL CHANGE, AND THAT IS A CONSEQUENCE, NOT A CONVENIENCE. Both
// numbers are already derivable from frames this PC receives: the clock starts on
// the `audio:start` this capsule already handles, and the count is the `stt:final`
// frames it already counts into `state.segs`. `inject:request.duration_ms` (0.2.43)
// is deliberately NOT used here — it lands once, at the END of an utterance, so it
// can answer 「how long WAS that one」 but never 「how long has this one been
// running」, which is the question a live row is asking.
//
// ⚠️ THE ONE HONEST DISCREPANCY, STATED RATHER THAN HIDDEN: the phone starts its
// clock when the user presses; this PC starts its clock when `audio:start`
// ARRIVES. The two therefore differ by one network hop plus the phone's own
// start latency — order tens of milliseconds. It is a CONSTANT OFFSET, not
// drift: both are wall clocks ticking at the same rate, so a 30-minute recording
// ends the same fraction of a second apart as a 3-second one. At the display
// grammar below (tenths under a second, whole seconds above) the two ends read
// identically in every case except a sub-second sliver at a tick boundary. There
// is no way to do better without a timestamp on `audio:start`, which the schema
// does not carry (packages/protocol/src/protocol-schemas-audio.ts).

/** Live milliseconds since the `audio:start` that opened the current speaking
 *  form, or `null` when this delivery never had one.
 *
 *  🔴 `null` is not "zero" and the caller must not render it as a duration. It is
 *  the E2 guard (controller.ts, 2026-09-02) expressed for the live row: an image
 *  send and a manual-text inject never run `onAudioStart`, so `startedAt` is
 *  whatever a PRIOR utterance left behind — or its initial 0, which would print
 *  as roughly 1.7e9 seconds of elapsed time. That defect has already shipped once
 *  on the settled card's sub-line; the guard is repeated here rather than trusted
 *  to be far away.
 *
 *  Clamped at 0: a clock that has gone backwards (an NTP step mid-utterance) must
 *  read 「0」 and not a negative duration — the count beside it is still true, and
 *  the whole row staying honest matters more than this one field. */
export function speakingElapsedMs(input: {
  hadAudio: boolean;
  startedAt: number;
  now: number;
}): number | null {
  if (!input.hadAudio) return null;
  return Math.max(0, input.now - input.startedAt);
}
