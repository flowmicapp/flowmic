// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.4 (「在线」("online")
//     answers which question)
//   docs/rebuild/15-… §4 R3 (a remote latch must have a local watchdog) / R4 (one
//     value answers only one question)
//   two spots in apps/server-core/src/socket/handlers/mobile.handler.ts
//   `pc_online: store.getPc(pc.room_uuid) !== null`（one each in pair and reconnect）
//   the one in apps/server-core/src/socket/handlers/relay.handler.ts
//   `answerReject('INJECT_PC_OFFLINE', …)`
//
// RV-92 — 「the relay can be reached」 was treated as 「my computer is online」.
//
// owner 2026-08-01 real-device original words: 「云端中继模式下，退出 PC 端，仍然会显示连接状态且有 PC
// 端的实例名和目标窗口名」("in cloud-relay mode, after quitting the PC side, it still
// shows a connected state along with the PC side's instance name and target window
// name"); additional ruling: 「在连接实例清单，对于是否在线的检测要检测到 PC
// 端……云端轻记录这个默认实例只需要能连接云端中继服务器就行。」("in the connected-instance
// list, the online/offline detection needs to actually detect the PC side… the
// default cloud-light-record instance just needs to be able to connect to the cloud
// relay server — that's enough.")
//
// This is this repo's #1 shape (R4: one value answering two questions). `InstanceReach`
// (instance_probe.dart) naturally answers **「is this server address unreachable」** —
// it is a single `GET /api/health`. The LAN row
// happens to be correct, because **the server answering IS that PC itself**
// (the standalone sidecar runs on the PC); the cloud-relay row is wildly wrong,
// because **the one answering is the relay, and the PC was never asked at all**.
//
// So this file sets up two values, each uniquely its own, neither one able to answer
// for the other:
//   · [PcPresence]           —— 「is that PC in its room right now」 (session-scope,
//     written from wire facts)
//   · [InstanceLivenessFace] —— 「which word should this row of the instance list say」
//     (a pure projection, never persisted, no writer)
//
// [InstanceLivenessFace] uses the same admission criterion volume 15 §2.1 sets for
// `DeliveryFace`: **a face may never also introduce a new field at the same time**.
// Both inputs it computes from are measurements that already existed
// (`InstanceReach` + `/api/health.mode`), so deleting it and recomputing it again
// tomorrow gives the same answer.

import 'package:flutter/foundation.dart';

import '../auth/token_storage.dart' show MobileSession;
import 'instance_probe.dart' show InstanceReach, ServerChannel;

/// 「**the paired PC**, is it in its room right now」.
///
/// ⚠️ This is **two different questions** from [InstanceReach]: the latter answers
/// 「is this server address unreachable」. When the cloud relay is online but the PC
/// has been shut down, the two answers are online / offline — exactly the scene
/// owner ran into.
///
/// [unknown] is the value that is **the default and that everything must be able to
/// fall back to**: this repo has no periodic PC→phone liveness signal at all
/// (the desktop's `focus:state` is change-only, `heartbeat` only goes to the
/// server), so "don't know" is a
/// genuine and frequently correct state, and must never be replaced with online.
enum PcPresence {
  /// Nobody has said anything, or whatever was said has already expired along with
  /// the connection that said it (R3 local watchdog).
  unknown,

  /// There is **measured** evidence it is here: the ack's `pc_online:true` /
  /// receiving `focus:state` /
  /// receiving an `inject:result` that the PC itself produced.
  online,

  /// There is **measured** evidence it is not here: the ack's `pc_online:false` /
  /// `INJECT_PC_OFFLINE` / `INJECT_NOT_IN_ROOM`.
  offline,
}

/// The two codes the server sends back to the phone when 「there is no PC in the
/// room」. Receiving them IS **measured evidence the PC is absent** —
/// this is currently the only path that **actively tells the phone mid-session that
/// the PC left**
/// (`relay.handler.ts`'s `answerReject('INJECT_PC_OFFLINE', …)` /
/// the `error: 'INJECT_PC_OFFLINE'` in `inject-routes.ts`).
///
/// ⚠️ Deliberately does **NOT** include `INJECT_NO_RESULT`: that is the phone's own
/// local 20s watchdog timeout
/// (`compose_gate.dart:79`), and what it says is 「we don't know」, not 「it's not
/// here」.
/// Also deliberately does not include `PC_BUSY` — that code's whole premise IS that
/// the **PC is online** (some other phone is occupying it).
const Set<String> kPcAbsentInjectCodes = <String>{
  'INJECT_PC_OFFLINE',
  'INJECT_NOT_IN_ROOM',
};

/// The **testimony** one `inject:result` gives on the question 「is the PC here or
/// not」, `null` = this one has no testimony.
///
/// This is a **read** function, not a second definition of the criterion: it only
/// reads [kPcAbsentInjectCodes] back out.
PcPresence? pcPresenceFromInjectResult({required bool ok, String? error}) {
  if (ok) return PcPresence.online; // only the PC itself can produce a successful receipt
  final String? code = error;
  if (code == null || code.isEmpty) return null;
  if (kPcAbsentInjectCodes.contains(code)) return PcPresence.offline;
  // The remaining refusal codes (frame too large / ID crosstalk / no focus …) are
  // all cases where **the PC or the server said something**,
  // but only the ones the PC itself produced can prove it is present. A
  // server-boundary rejection proves nothing ⇒ gives no testimony.
  return null;
}

/// 🔴 owner 2026-08-01 ruling, see
/// `docs/decisions/2026-08-01-idle-pc-presence-poll-interval.md`: the polling
/// interval for 「is the computer still there」 when the session is **idle but
/// connected**. The lead
/// recommended 30 seconds; after reading the cost (connection volume is 3× the 30s
/// tier)
/// owner explicitly chose this denser tier instead ⇒ **an informed ruling — the
/// implementation must not "optimise" it back to 30 seconds**.
///
/// A named constant rather than a bare literal `10` scattered at the call site —
/// this number will be tuned by owner in the future, and that day only this line
/// should
/// change. The caller is the `Timer.periodic` started in `PttSession`'s constructor
/// (`ptt/ptt_session.dart`).
const Duration kIdlePcPresencePollInterval = Duration(seconds: 10);

/// [PcPresence]'s **sole writer**, living alongside it — so 「who can write this
/// value」 is answered **structurally**,
/// rather than by a comment asking everyone else not to write it (`PttSession` only
/// holds a private instance of it, exposing only a
/// `ValueListenable` outward).
///
/// | Trigger (all wire facts **already live in production today**) | Value | Criterion coordinate |
/// |---|---|---|
/// | pair / reconnect ack's `pc_online` | online/offline | `mobile.handler.ts:195,250` = `store.getPc(room)!==null` |
/// | receiving `focus:state` | online | the desktop's `pump.rs` is the sole sender; the server only replays the last frame it stored, and `store.leavePc` clears that frame |
/// | receiving `inject:result` | see [pcPresenceFromInjectResult] | `relay.handler.ts`'s `answerReject('INJECT_PC_OFFLINE', …)` |
/// | socket no longer connected | unknown | 🔴 **R3 local watchdog** |
/// | left the room (`clearConnectedInstance`) | unknown | same as above |
///
/// ⚠️ **There is deliberately no duration-based constant here.** This repo has no
/// periodic PC→phone liveness signal at all
/// (`focus:state` is change-only; `heartbeat` only goes to the server and its ack
/// carries no room state —
/// `heartbeat.handler.ts`'s `registerHeartbeatHandler` only replies with
/// `{ok,last_seen_at}`) ⇒ any TTL would be a number pulled out of thin air.
/// So the watchdog is **event-scoped** (it lapses the instant the connection
/// drops), not time-scoped. **The gap this leaves**:
/// when the session is idle, the PC quietly quits, and the user hasn't said a word
/// — the phone has no structural way to know. Closing that gap needs a
/// PC→phone presence surface (a protocol change), which is the lead's/owner's job.
class PcPresenceTracker {
  final ValueNotifier<PcPresence> _value =
      ValueNotifier<PcPresence>(PcPresence.unknown);

  /// Read-only externally. Writes may only go through this class's named note*
  /// methods.
  ValueListenable<PcPresence> get listenable => _value;
  PcPresence get value => _value.value;

  /// 🔴 `pc_online` has **been live in production the whole time**
  /// (`MobilePairAck.pc_online` in
  /// `packages/protocol/src/types.ts`), while **the phone just dropped it on the
  /// floor**: before this round
  /// `grep pc_online --include=*.dart` under `lib/` hit count = 0, except for one
  /// test fixture.
  /// This is the 「truth that already existed」 this card needed — not a new
  /// field, not a new event, not new polling.
  ///
  /// Field missing (old server) ⇒ **do nothing**: a missing field must never be
  /// backfilled into a value that merely looks plausible.
  void noteAck(Map<dynamic, dynamic> ack) {
    final Object? v = ack['pc_online'];
    if (v is bool) _set(v ? PcPresence.online : PcPresence.offline);
  }

  /// Received a `focus:state` frame — only the PC can produce it.
  void noteFocusState() => _set(PcPresence.online);

  /// The testimony of one `inject:result` (do nothing if there is no testimony).
  void noteInjectResult({required bool ok, String? error}) {
    final PcPresence? says = pcPresenceFromInjectResult(ok: ok, error: error);
    if (says != null) _set(says);
  }

  /// 🔴 R3 local watchdog: anything the remote side has said **must never outlive
  /// the connection it was said on**.
  /// Returns to [PcPresence.unknown] rather than offline — we simply don't know
  /// any more, we don't know that it's gone.
  void noteLinkNotLive() => _set(PcPresence.unknown);

  /// 🔴 owner 2026-08-01 (G-15①) — where the idle-session periodic poll
  /// (`GET /api/pc/presence`) lands. It is the same class of writer as [noteAck] /
  /// [noteFocusState] / [noteInjectResult]
  /// (all wire evidence); the only difference is that this evidence comes from
  /// **actively asking** rather than **passively waiting**.
  ///
  /// 🔴 When [reading] is [PcPresence.unknown], write it through unconditionally
  /// too — 「couldn't get an answer」 IS
  /// this poll's answer, and it must never be skipped just because 「the answer
  /// looks bad」, letting the previous
  /// online/offline keep hanging on screen as 「right now」 (decision-log
  /// implementation constraint ②, the session-scope version of the
  /// same iron rule as volume 15 §1.4.1's list-scope one). The caller
  /// (`PttSession._pollPcPresenceIfIdle`) has already done the
  /// ID-crosstalk check at its own layer — what comes in here is already the
  /// 「checked answer」.
  void notePresencePoll(PcPresence reading) => _set(reading);

  void dispose() => _value.dispose();

  void _set(PcPresence next) {
    if (_value.value == next) return;
    _value.value = next;
  }
}

/// **What the destination of this instance-list row is.** Owner's exception lands
/// exactly on this fork.
///
/// The criterion is `MobileSession.channel == 'saas'` (fixed at pairing time by
/// `PairEntry.cloud`,
/// `ptt_session.dart:352`), **NOT** 「which channel it arrived over」 — the latter
/// is the transport question `/api/health.mode`
/// answers, and the v0.2.3 channel-chip bug was exactly this pair getting mixed up.
enum InstanceTarget {
  /// A real PC (regardless of whether it arrives via LAN or via the cloud relay).
  pc,

  /// The virtual cloud light-record instance: **it has no PC target**.
  /// owner 2026-08-01: 「云端轻记录这个默认实例只需要能连接云端中继服务器就行。」
  /// ("the default cloud light-record instance just needs to be able to connect to
  /// the cloud relay server — that's enough.")
  cloudNotes,
}

/// The judgement [instanceTargetOf] makes, pulled out on its own because
/// **session-scope polling**
/// (`ptt_session.dart`'s `_pollPcPresenceIfIdle`, G-15①) only has the bare
/// `channel`
/// string in hand (`PttSession._channel`, set down at the same moment as
/// `_pcId`/`_pcMachineUid` inside
/// `applyPairedIdentity`), with no whole [MobileSession] to pass along.
/// The two spots must ask the exact same question, or the answer will say two
/// different things in the two scopes (R4).
InstanceTarget instanceTargetOfChannel(String? channel) =>
    channel == 'saas' ? InstanceTarget.cloudNotes : InstanceTarget.pc;

/// A row's destination type. Centralised here rather than scattering
/// `channel == 'saas'` around the pages:
/// this is the exact cut owner's ruling forked on, and it may only have one
/// definition.
InstanceTarget instanceTargetOf(MobileSession pairing) =>
    instanceTargetOfChannel(pairing.channel);

/// 「**which word should this row of the instance list** say」 — a pure
/// projection (volume 15 §2.1's face admission criterion).
enum InstanceLivenessFace {
  /// Never probed.
  unmeasured,

  /// Currently probing.
  checking,

  /// That PC is online: the server was **asked and answered 「it's in the
  /// room」**, or this row was the cloud light-record instance to begin with.
  pcOnline,

  /// Cannot even reach the server address ⇒ the PC obviously cannot be reached
  /// either. **offline can be propagated through, online cannot.**
  unreachable,

  /// 🔴 RV-98 addition: the server **answered, and said that computer is not in
  /// its room**.
  ///
  /// **Deliberately kept separate** from [unreachable]: the two sentences mean
  /// two different things to the user, and the actionable steps differ too
  /// (「go turn on the computer」 vs 「check the network」). Collapsing them into
  /// one 「offline」 sentence would send a user to fix their network while the
  /// computer is perfectly on, or the other way around.
  pcOffline,

  /// 🔴 The relay answered 「I'm here」, but **this time it could not ask that
  /// computer** — 「is the computer here or not」 has no answer.
  ///
  /// After RV-98 this **is no longer the normal case** (`GET /api/pc/presence`
  /// will answer it), but this face **must not be removed**: an old server
  /// (404), a rejected token (401), a flaky network this time, a field that
  /// isn't a bool — any 「couldn't ask」 situation lands here. 🔴 **Must never be
  /// degraded into [pcOffline]**: that would be turning 「don't know」 into 「know
  /// it's gone」.
  relayOnlyPcUnknown,
}

/// Four **independently measured** inputs → one sentence. There is no fifth
/// source of truth, and nothing is written anywhere.
///
/// ⚠️ [answeringChannel] is `/api/health`'s `mode`, i.e. **what the answering
/// server actually is**:
/// `standalone` ⇒ it IS some PC's own sidecar; `saas` ⇒ it's the relay.
///
/// ⚠️ [pcPresence] is `GET /api/pc/presence`'s answer (list-scope, see volume 15
/// §1.4.1),
/// [PcPresence.unknown] = didn't get an answer this round. **It and [reach] are
/// two independent requests, two independent tables**,
/// read-only here — RV-92's 「two questions, two values」 has not been collapsed
/// back into one value by this round.
InstanceLivenessFace instanceLivenessFaceOf({
  required InstanceReach reach,
  required ServerChannel? answeringChannel,
  required InstanceTarget target,
  required PcPresence pcPresence,
}) {
  switch (reach) {
    case InstanceReach.unknown:
      return InstanceLivenessFace.unmeasured;
    case InstanceReach.checking:
      return InstanceLivenessFace.checking;
    case InstanceReach.offline:
      return InstanceLivenessFace.unreachable;
    case InstanceReach.online:
      // owner's exception: this row has no PC target, relay-reachable is its
      // whole meaning.
      // owner 2026-08-01: 「云端轻记录这个默认实例只需要能连接云端中继服务器就行。」
      // ("the default cloud light-record instance just needs to be able to
      // connect to the cloud relay server — that's enough.")
      // ⚠️ This branch comes **before** [pcPresence]: that virtual PC row never
      // enters a room, a real probe would always answer
      // false, and owner explicitly said this row should not be bound by it (so
      // the caller never even sends that question).
      if (target == InstanceTarget.cloudNotes) return InstanceLivenessFace.pcOnline;
      // 🔴 RV-98: now **that computer itself has been asked**. This branch is
      // ordered before the channel check because it is
      // a direct measurement, while the one below is an inference — **when
      // there is a measurement, never use an inference**.
      switch (pcPresence) {
        case PcPresence.online:
          return InstanceLivenessFace.pcOnline;
        case PcPresence.offline:
          return InstanceLivenessFace.pcOffline;
        case PcPresence.unknown:
          break; // couldn't get an answer ⇒ fall back to the old criterion below
      }
      // The fallback for when there is no answer (old server / this attempt
      // didn't get one):
      // on the LAN, the sidecar that answers runs on that very PC, so
      // 「reachable」 at least proves that machine is powered on.
      // ⚠️ This is an **inference, not a measurement**: it skews optimistic when
      // the sidecar is alive but the desktop process is dead (an orphan
      // sidecar, this repo has precedent) — that is exactly why the question
      // above exists, not a reason to keep this as the primary criterion.
      if (answeringChannel == ServerChannel.lan) return InstanceLivenessFace.pcOnline;
      return InstanceLivenessFace.relayOnlyPcUnknown;
  }
}
