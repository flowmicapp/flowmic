// Capsule shared runtime instances + reactive `state` — moved VERBATIM out of
// controller.ts on 2026-09-02 (WP-7d E2 follow-up), same rule as recent-line.ts /
// session-title.ts (800-line cap, verify/lint/file-size.mjs SRC_MAX=800).
//
// 🔴 THIS split exists for a SECOND reason the other two did not have: E1
// (connection-directory.ts) needs `state` and `vis` to implement the GA-28
// primary-channel gate, and importing them straight from controller.ts made
// controller.ts import connection-directory.ts's functions back — a genuine
// import cycle that `verify:lint circular` caught (it counts real cycles, not
// hypothetical ones; see that lint's own header). Pulling `state`/`vis`/`morph`/
// `watchdog` into this LEAF module (no import from controller.ts or
// connection-directory.ts) breaks the cycle: both of the other two files import
// FROM here, neither is imported BY here.
//
// controller.ts re-exports every name here, so every existing import site
// (CapsuleApp.vue, capsule-copy.ts, controller.test.ts, connection-directory.ts,
// initCapsule) is untouched.

import { reactive } from 'vue';
import { CapsuleMorph, type Morph } from '../lib/capsule-morph';
import { CapsuleVisibility } from '../lib/capsule-visibility';
import { SpeakingWatchdog } from '../lib/speaking-watchdog';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from '../lib/channel';
import { S } from '../lib/strings';
import type { ChannelTag } from '../lib/types';
import type { RecentLine } from './recent-line';

export const morph = new CapsuleMorph();
export const vis = new CapsuleVisibility();
export const watchdog = new SpeakingWatchdog();

/** Honest STT engine health for the capsule diagnostic (R6-R2). `known` stays
 *  false until a real stt:engine-status arrives — the row then shows "undetected" (未探测)
 *  rather than a fabricated green "ready · FunASR" (就绪 · FunASR). */
type EngineStatus = 'ready' | 'reconnecting' | 'failed';

export const state = reactive({
  form: 'idle' as Morph,
  visible: false,
  /** An utterance is in flight (owner 2026-07-27) — the × is disabled, because a
   *  capsule that vanishes mid-transcription takes away the only view of what is
   *  being typed. Mirrors CapsuleVisibility.isSpeaking(). */
  speaking: false,
  /** Desktop socket-to-sidecar transport (the "Socket transport" (Socket 传输) diag row). */
  connected: false,
  /** `Credentials::is_registered()` — survives socket drop (T-5b). */
  registered: false,
  mobiles: 0,
  /** Real phone presence, mobiles>0 (R6-C1 — drives surfacing + the "phone present" (手机在场) row).
   *  Distinct from `connected`: the socket is up from boot before any phone pairs. */
  phonePresent: false,
  // `as string` is load-bearing: strings.ts is `as const`, so the catalog value is
  // the literal type '手机' (phone) and would narrow this field — but `deriveSessionTitle`
  // overwrites it with an arbitrary pairing name from pc:list-mobiles. Do not "clean
  // up". (卡 D-a: the reason used to be cited as audio:start's device_label, a field
  // that does not exist on AudioStartSchema — the annotation is still needed, its
  // justification was not.)
  session: S.cap_session_default as string,
  /** RV-01 / RV-新B — the channel currently carrying the runtime, learned from the
   *  CONNECTION frames/seed (which is where `primary` / admission lives). THE one
   *  answer to "which channel is current" on this window, used for three things:
   *  (1) the "current channel" diag label; (2) which endpoint that diag row shows;
   *  (3) the "delivered-in record" (转入记录) strip filter — the main window now accepts both channels
   *  (owner: timeline = all messages for this PC), so without a capsule-side filter the strip
   *  would interleave two servers.
   *
   *  It used to be `state.cloud.channel`, the device-page PREFERENCE — a flag with no
   *  writer since owner 2026-07-30 ②, hence a constant 'lan' (RV-新B). */
  channel: 'lan' as ChannelTag,
  /** Full cloud status for deriveConnDot (T-5b four-state connection dot). */
  cloud: { ...EMPTY_CLOUD_STATUS } as CloudStatus,
  /** Sidecar lifecycle phase for LAN loud-fault red (null = not yet probed). */
  sidecarPhase: null as string | null,
  /** The LAN sidecar's address when it has resolved one ('' = not yet). The diag row
   *  picks between this and `cloud.endpoint` by `channel` AT RENDER TIME — it used to
   *  be one latched `endpoint` field written by whichever of the two pushes arrived
   *  last, which now that `channel` really does move at runtime would show the other
   *  channel's address until one of those pushes happened to fire again. */
  sidecarEndpoint: '' as string,
  /** The window the NEXT utterance would land in (GA-25). Live from
   *  `flowmic://focus-changed` while unlocked, frozen while `locked`, and
   *  overwritten by `inject:result` (delivered truth outranks observation).
   *  `''` → the view renders "—"; we never fabricate a destination. */
  target: '',
  locked: false,
  interim: '',
  finalText: '',
  level: 0,
  segs: 0,
  /** Live ms since the `audio:start` that opened this speaking form — the left
   *  half of the ministat pair owner asked for on 2026-09-07, and the SAME
   *  quantity the phone's recording strip calls `elapsed`
   *  (apps/mobile/lib/src/ui/recording_panel.dart: 「Time since audio:start
   *  (local clock)」). `null` ⇒ this delivery never ran onAudioStart (an image
   *  send / a manual-text inject) and there is no clock to show; the view must
   *  omit the duration rather than print 0. Written ONLY by controller.tick()
   *  through `speakingElapsedMs` — see capsule/session-stats.ts for why this is
   *  a per-recording clock and not a session total. */
  speakElapsedMs: null as number | null,
  /** 🔴 `confirmed` = 甲-3's ③evidence, reduced to the one bit this face needs
   *  (owner 2026-08-07). `true` ⇒ the green card says "injected" (已注入); anything else ⇒ "delivered" (已送入).
   *  A BOOLEAN, not the raw three-value reading, because this face asks exactly one
   *  question ("which word") — the three-way fact lives on the row (TimelineRow
   *  .focus_evidence) where the tooltip/parenthetical can tell "asked but couldn't answer" (问了答不出来)
   *  from "never asked" (没问). ⚠️ It must default to `false`: "we never asked" (我们没问过) may not license "confirmed" (已确认). */
  /** `metrics` is `null` when this utterance never went through onAudioStart (an
   *  image send or a manual-text inject) — see E2 below. Rendering must not invent
   *  a char count or a duration for a delivery that was never spoken. */
  injected: null as {
    target: string;
    metrics: { chars: number; seconds: number } | null;
    confirmed: boolean;
  } | null,
  /** The truthful non-injected outcome (R6-R1 / RV-43 §4).
   *  cached = ok:false+mode:cached → 📥 "not injected · cached" (amber); otherwise
   *  ✗ not injected (red; the word was "unsuccessful" until owner deleted "failed"-class wording on
   *  2026-08-07 — `cap_inject_failed` now references `st_failed`).
   *  The retired readback-uncertain face is gone (0.2.22).
   *  ⚠️ 卡 L7 — this line originally read "📥 not delivered …… and it matches the phone",
   *  **both halves were the defect itself**: this PC had already received that frame
   *  (otherwise this face would not appear), so saying "not delivered" used a
   *  segment-① word on segment ②; and "matches the phone" was exactly the reason
   *  it got copied over here in the first place. See
   *  lib/strings/capsule.ts's file header and docs/rebuild/15 §2.0. */
  injectFailed: null as {
    target: string;
    cached: boolean;
    reason: string;
    /** 🔴 book 15 §2.5e-4 — WHICH of `cached`'s three causes, in words; `null` when the
     *  cause adds nothing the badge does not say. A SEPARATE field from `reason`, not
     *  "reason, but also shown when cached": they answer different questions ("why did this
     *  attempt fail" vs "why didn't this one get injected") and their code sets differ on purpose —
     *  `INJECT_FOCUS_LOST` is a reason and is NOT a named cached cause. One value, one question. */
    cachedCause: string | null;
  } | null,
  diagOpen: false,
  /** V2-15: structured "delivered-in record" (转入记录) rows (was string[]). Written ONLY by the
   *  history wire handlers below — never by inject:result, whose `mode` is the
   *  DELIVERY mode (sendinput|clipboard|cached), not the content state. */
  recent: [] as RecentLine[],
  /** pairing_id → phone name (手机名) (V2-15 row sender / V2-16 pre-utterance title). A
   *  FAILED refresh keeps the previous map: "we could not ask" is not "the
   *  phone has no name" (paired-mobiles.ts honesty rule). */
  mobileNames: {} as Record<string, string>,
  engineProvider: '',
  engineStatus: '' as '' | EngineStatus,
  engineKnown: false,
  /** Last non-null loud reason observed (diag "most recent fault" (最近一次故障); omit until first).
   *  Latched on purpose — the row outlives recovery so the card can explain what
   *  happened, which is why the label says "most recent" (最近一次) and not "fault reason" (故障原因). */
  lastLoudReason: null as string | null,
});
