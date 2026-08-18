// Part of connections_page.dart — the faces for **what state an instance row is
// in right now**: connecting /
// online / offline / computer offline / relay reachable but computer unknown /
// checking / never probed, plus the channel
// badge beside it (which one is live now · which one was live last · the dial
// address when neither has ever been measured).
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// connections_page.dart went over `verify/lint/file-size.mjs`'s SRC_MAX=800
// (874), and card fix-024 (ledger W8-1) needed to add a persistent
// fingerprint-mismatch card to this page. The same shape and
// the same reason apply to settings_preferences.dart / chat_flow_composer.dart /
// ptt_pair.dart.
//
// 🔴 **This cut was made along 「which question it answers」, not along line
// count.** These four members together answer
// exactly ONE question — 「what is that row's machine like right now」 — and
// they are the **most criterion-dense** block on this page:
// RV-92 (online must ask the PC side, not the relay), RV-98 (the
// `GET /api/pc/presence` question), and
// RV-54 (「last time」 must never grow into 「now」) — the implementation of all
// three rulings lives here. Putting them together means the next
// person who needs to touch 「does this row say it's online or not」 has exactly
// one file to read.
// ⚠️ **Do not read this split as an architectural statement**:
// `_ConnectionsPageState` is still one class, the fields are
// still all over there; only the behaviour moved. What triggered it was the
// 800-line gate, not a layering decision.
//
// 🔴 DIFF DISCIPLINE: the four function bodies were **moved
// character-for-character** from connections_page.dart,
// with only the one mechanical change this whole family always needs — they go
// from being `_ConnectionsPageState`'s instance methods
// to top-level functions, so they gain one extra leading `_ConnectionsPageState
// page` parameter, `widget.` in the
// body becomes `page.widget.`, and the three sibling calls are renamed to
// `*Routed`.
// **Any difference beyond that is a bug.**
// ⚠️ Top-level functions rather than an `extension`, following the precedent of
// **the same kind of State class**
// (chat_flow_composer.dart's `_plusButtonRouted(_ChatFlowPageState s, …)`);
// settings_preferences.dart's extension style takes a StatelessWidget as its
// receiver.
// ⚠️ The first parameter is named `page` rather than the precedent's `s`: on
// this page `s` means `AppStrings` throughout,
// and keeping `s` would have forced a rename in every body, which would no
// longer be a character-for-character move.

part of 'connections_page.dart';

/// The row's live status line (owner 2026-07-27). Precedence is deliberate:
/// a connect IN FLIGHT outranks any earlier reachability verdict — that is the
/// state the user is waiting on, and the reason they were tapping repeatedly.
///
/// 🔴 RV-92 (owner 2026-08-01):「对于是否在线的检测**要检测到 PC 端**，现在云端中继
/// 通道的实例会显示在线，但 PC 端已关闭，这是不对的；云端轻记录这个默认实例只需要能
/// 连接云端中继服务器就行。」("the online/offline detection **must actually
/// detect the PC side**; right now an instance on the cloud-relay channel
/// shows online even though the PC side has already shut down, and that's
/// wrong; the default cloud light-record instance just needs to be able to
/// connect to the cloud relay server — that's enough.")
///
/// This used to paint [InstanceReach] (a single `GET /api/health` ⇒ 「is
/// **this server address** unreachable」) directly as
/// 「online」; the cloud-relay row **answers for the relay**, and that PC was
/// never asked at all.
/// ⇒ **RV-98 (card B4-14) added that missing question**: `GET
/// /api/pc/presence`. The criteria and the wording table live in
/// `session/pc_presence.dart` ([instanceLivenessFaceOf]).
Widget _statusLabelRouted(
  _ConnectionsPageState page,
  AppStrings s, {
  required String key,
  required String endpoint,
  required InstanceTarget target,
  /// 🔴 RV-98 (owner 「要能正确显示 PC 端是否在线」("must correctly show
  /// whether the PC side is online")): the answer from actually having asked
  /// that computer
  /// (`GET /api/pc/presence`). Default unknown = didn't get an answer (the
  /// cloud light-record card never asks).
  PcPresence pcPresence = PcPresence.unknown,
  /// 🔴 The server's own reason for that computer being absent, when it gave
  /// one. Defaulted to null so every existing caller and test keeps the face it
  /// had; only a reason this build recognises changes anything, and only on an
  /// `offline` row.
  PcAbsentReason? pcAbsentReason,
  /// 🔴 C4 — the server refused this row's token by name. Not a fact about the
  /// computer at all, which is why it is a parameter of its own rather than a
  /// value squeezed into [pcPresence].
  bool pairingRejected = false,
}) {
  if (page.widget.connections.connectingKey == key) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        SizedBox(
          width: 10,
          height: 10,
          child: CircularProgressIndicator(strokeWidth: 1.6, color: FlowMicColors.brand),
        ),
        const SizedBox(width: 6),
        Text(
          s.connectingRow,
          style: TextStyle(color: FlowMicColors.brand, fontSize: 11.5, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
  final InstanceLivenessFace face = instanceLivenessFaceOf(
    reach: page.widget.connections.reachOf(endpoint),
    // 「what the answering server actually is」 — the `mode` field of that SAME
    // /api/health response, so it
    // **cannot possibly disagree** with reachability (instance_probe.dart's
    // HealthReading exists precisely for this).
    answeringChannel: page.widget.connections.channelOf(endpoint),
    target: target,
    pcPresence: pcPresence,
    pcAbsentReason: pcAbsentReason,
    pairingRejected: pairingRejected,
  );
  // `unmeasured` = never probed. It renders as the old neutral hint, never as a
  // colour that would claim knowledge we do not have.
  final (String label, Color color) = switch (face) {
    InstanceLivenessFace.pcOnline => (s.online, FlowMicColors.teal),
    InstanceLivenessFace.unreachable => (s.offline, FlowMicColors.red),
    // RV-98: the server answered, and said that computer is not in the room.
    // **Deliberately a different sentence from [unreachable]**
    // (reason in pc_presence.dart's face definition); reuses [pcOfflineChip], so
    // the transcription page's top bar gives the same answer to the same
    // question.
    InstanceLivenessFace.pcOffline => (s.pcOfflineChip, FlowMicColors.red),
    // 🔴 AMBER, NOT RED, and the colour is the argument. Red on this page means
    // 「够不着」("can't be reached") / 「不在」("not there") — both false here:
    // that machine is powered on and running. What lapsed is a credential, and
    // the fix is ten seconds at the keyboard. Painting it red would recruit the
    // strongest colour on the page to send someone to check a computer that has
    // nothing wrong with it.
    InstanceLivenessFace.pcSignedOut => (s.pcSignedOutChip, FlowMicColors.amber),
    // 🔴 C9 — AMBER for [pcSignedOut]'s reason and one more of its own: red
    // would be recruiting the page's strongest colour to describe a machine
    // that is powered on, in a room, and working perfectly for whoever owns it
    // now. Nothing is wrong over there; this pairing is simply pointed at a row
    // that account abandoned, and the only fix is on this phone.
    InstanceLivenessFace.pcOtherAccount => (s.pcOtherAccountChip, FlowMicColors.amber),
    // 🔴 C4 — the server said it does not know this pairing. **Deliberately not
    // [relayUpPcUnknown]**: that sentence means 「我们没问到」 ("we did not get an
    // answer"), and here we did — this row will never resolve on its own, and
    // saying 「unknown」 asks the user to keep waiting for something that has
    // already happened.
    InstanceLivenessFace.pairingRevoked => (s.pairingRevokedChip, FlowMicColors.amber),
    // 🔴 The relay answered, the computer was never asked. **Deliberately does
    // NOT reuse [AppStrings.offline]**: saying 「offline」 turns
    // 「don't know」 into 「know it's gone」, which is the lie in the other
    // direction (R2 both directions).
    InstanceLivenessFace.relayOnlyPcUnknown => (s.relayUpPcUnknown, FlowMicColors.amber),
    // 🔴 AMBER, and the colour is the argument (same one [pcSignedOut] makes).
    // Red on this page means 「够不着」("can't be reached") / 「不在」("not
    // there") — and this face asserts neither: it says we could not find out
    // this round. Painting it red recruits the page's strongest colour to send
    // someone after a server that is, as far as anyone knows, serving.
    InstanceLivenessFace.reachUnanswered => (s.reachUnanswered, FlowMicColors.amber),
    InstanceLivenessFace.checking => (s.checkingReach, FlowMicColors.t3),
    InstanceLivenessFace.unmeasured => (s.tapToConnect, FlowMicColors.t3),
  };
  final bool dotted = face == InstanceLivenessFace.pcOnline ||
      face == InstanceLivenessFace.unreachable ||
      face == InstanceLivenessFace.reachUnanswered ||
      face == InstanceLivenessFace.pcOffline ||
      face == InstanceLivenessFace.pcSignedOut ||
      face == InstanceLivenessFace.pcOtherAccount ||
      face == InstanceLivenessFace.pairingRevoked ||
      face == InstanceLivenessFace.relayOnlyPcUnknown;
  return Row(
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      if (dotted) ...<Widget>[
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 5),
      ],
      Flexible(
        child: Text(
          label,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: color, fontSize: 11.5),
        ),
      ),
    ],
  );
}

/// Live chip / 「上次」("last time") chip / dial-host hint — see call-site
/// comment.
///
/// 2026-08-01: the live branch used to draw its own `_channelChip` (colour only,
/// same lan=teal/cloud=brand pair chat_header.dart hardcoded separately) — now
/// `ChannelBadge` (tokens.dart), the ONE definition. `_lastChannelChip` below
/// stays exactly as it was: RV-54's muted-outline face is deliberately NOT the
/// live channel colour (「上次」("last time") must not look like 「现在」
/// ("now")), so it must not be
/// pulled into the channel-identity token pair either.
Widget _transportFaceRouted(
  _ConnectionsPageState page,
  AppStrings s,
  MobileSession p,
) {
  final ServerChannel? live = page.widget.connections.liveChannelOf(p.endpoint);
  if (live != null) {
    return switch (live) {
      ServerChannel.cloudRelay => ChannelBadge(label: s.cloudRelay, cloud: true),
      ServerChannel.lan => ChannelBadge(label: s.localLan, cloud: false),
    };
  }
  final ServerChannel? last = page.widget.connections.channelOf(p.endpoint);
  if (last != null) {
    return _lastChannelChipRouted(switch (last) {
      ServerChannel.cloudRelay => s.lastKnownCloudRelay,
      ServerChannel.lan => s.lastKnownLocalLan,
    });
  }
  final String host = dialHostLabel(p.endpoint);
  if (host.isEmpty) return const SizedBox.shrink();
  return _endpointHintRouted(host);
}

/// Past measurement: muted outline, never the live fill — 「上次」("last time") must not
/// look like 「现在」("now").
Widget _lastChannelChipRouted(String label) => Container(
  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
  decoration: BoxDecoration(
    color: FlowMicColors.surface2,
    borderRadius: BorderRadius.circular(99),
    border: Border.all(color: FlowMicColors.line),
  ),
  child: Text(
    label,
    style: TextStyle(
      color: FlowMicColors.t2,
      fontSize: 10,
      fontWeight: FontWeight.w600,
    ),
  ),
);

/// Dial target when no probe has ever named a channel this session.
Widget _endpointHintRouted(String host) => Text(
  host,
  overflow: TextOverflow.ellipsis,
  style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
);
