// SPEC-REF:
//   T-5b-mobile — tap the chat-header connection dot → honest diagnostics.
//   Only REAL fields are shown; missing values omit the row (no placeholders).

import 'package:flutter/material.dart' hide ConnectionState;

import '../auth/token_storage.dart' show LanPinSource;
import '../destination/destination_controller.dart';
import '../diag/diag_upload.dart';
import '../ptt/ptt_session.dart';
import '../session/instance_probe.dart';
import '../session/local_engine_status.dart';
import '../settings/app_strings.dart';
import '../signaling/socket_core.dart' show LinkEncryption;
import '../signaling/state_machine.dart';
import 'status_badge.dart';
import 'time_label.dart';
import 'tokens.dart';

/// Bottom sheet of live connection facts. Every row is gated on a real value.
Future<void> showConnectionDiagnostics(
  BuildContext context, {
  required ConnectionState connection,
  required PttSession session,
  required DestinationController destination,
  required AppStrings strings,
}) {
  final ConnDotMeta meta = connDotMeta(connection, strings);
  final String? endpoint = session.reconnect.url;
  final String device = session.connectedDeviceName.value;
  final String? lastError = session.transport.lastConnectError;
  // v0.2.1: same correction as the header chip — the channel is what the SERVER
  // says it is (`/api/health.mode`), not what kind of destination we are talking
  // to. `destination.isFixed` answers 「对端是不是虚拟云端实例」("whether the
  // peer is a virtual cloud instance"), so a real PC
  // reached through the relay read as 「local LAN」 on a diagnostics sheet,
  // which is
  // the one screen that exists to be believed. Unknown → the row is OMITTED,
  // which this sheet's own rule already demands ("missing values omit the row").
  final ServerChannel? channelValue = session.serverChannel.value;
  final String? channel = switch (channelValue) {
    ServerChannel.cloudRelay => strings.cloudRelay,
    ServerChannel.lan => strings.localLan,
    null => null,
  };
  // ── P-8「本地引擎」("local engine") ───────────────────────────────────────
  // owner's own words scoped this section to **the local channel only**, so
  // the whole section's switch is that already-measured channel value
  // — not `destination.isFixed` (which answers a different question, see the
  // v0.2.1 correction above),
  // and not 「guess one」: `null` (didn't get an answer) draws **the whole
  // section not at all**, same as cloud does.
  // 🔴 There is deliberately no second criterion here: a section that
  // should only ever appear on the local channel, if it were also drawn
  // when the channel is unknown, would no longer be saying 「本地引擎」
  // ("local engine") but 「某个引擎」("some engine").
  final bool engineChannelIsLan = channelValue == ServerChannel.lan;
  final LocalEngineObservation? engineObservation = session.engineStatus
      .readFor(
        channelIsLan: engineChannelIsLan,
        endpoint: endpoint ?? '',
        pcId: session.pcId,
      );

  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: FlowMicColors.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (BuildContext ctx) {
      // 🔴 After P-8 added the 「local engine」 section, this `Column`
      // **overflowed by 31 pixels** against the modal sheet's height ceiling
      // (measured: `A RenderFlex overflowed by 31 pixels on the
      // bottom.`, at an 800×600 test viewport the sheet's ceiling is 305.5).
      // `showModalBottomSheet`'s default height ceiling is roughly half the
      // screen, and this sheet's row count was always going to
      // **vary dynamically with how many real values there are** (every row
      // is gated on a non-null value) — meaning it was already a
      // 「content that can grow」 container, it just happened to never grow
      // past the edge before.
      // ⚠️ The consequence of overflow is the same class as the 0.2.53 cut:
      // **content the user cannot read**. That time it was half a sentence
      // clipped by ellipsis, this time the whole row is clipped outside the
      // box, and **there is not even an ellipsis** — a diagnostics screen
      // that exists in order to 「be believed」, silently giving fewer rows
      // is the worst way to fail.
      // ⇒ Made scrollable, instead of removing a row or shrinking the text:
      // how much can be shown is decided by the screen,
      // what is shown is decided by 「is there a real value」, and these two
      // things must never trade off against each other.
      return SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: meta.color,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      strings.diagTitle,
                      style: TextStyle(
                        color: FlowMicColors.t1,
                        fontSize: 14.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                _row(strings.diagState, meta.label),
                // 2026-08-01: was a plain-text `_row` — now the SAME icon+colour
                // ChannelBadge (tokens.dart) chat_header.dart / connections_page.dart
                // wear, so "which channel" reads as one visual identity everywhere,
                // not text here and a coloured pill elsewhere.
                if (channel != null && channelValue != null)
                  _channelRow(strings.diagChannel, channel, channelValue),
                if (endpoint != null && endpoint.isNotEmpty)
                  _row(strings.diagEndpoint, endpoint),
                if (device.isNotEmpty) _row(strings.diagDevice, device),
                if (lastError != null && lastError.isNotEmpty)
                  _row(strings.diagLastError, lastError),
                // D2LAN-B3/B4 —— drawn only on **the local channel**, same
                // reason as the 「本地引擎」("local engine") section above:
                // the cloud leg goes over the real CA chain's
                // `https://flowmic.app`,
                // and drawing a self-signed-pinned badge there would be
                // answering a question the other channel never asked.
                if (engineChannelIsLan)
                  DiagnosticsEncryptionSection(
                    strings: strings,
                    encryption: session.transport.lastLinkEncryption,
                    pinSource: session.lanPinSource,
                  ),
                if (engineChannelIsLan)
                  DiagnosticsEngineSection(
                    strings: strings,
                    observation: engineObservation,
                  ),
                // owner 2026-07-29:「手机拿日志不方便」("getting logs off the
                // phone is inconvenient")— the phone's half of a
                // delivery story, shipped to where the PC's half already lives.
                // It sits on THIS sheet because this is the screen someone opens
                // when something did not work.
                const SizedBox(height: 4),
                _UploadDiagnosticsButton(
                  strings: strings,
                  endpoint: endpoint,
                  device: device,
                  // Same token the socket / image upload already dial with
                  // (`ReconnectCoordinator.token`). Null/empty is fine — the
                  // upload still goes; the PC just marks it unverified.
                  token: session.reconnect.token,
                  // D2LAN-B3 — the trail goes out under that token, so on a
                  // pinned pairing it verifies who is receiving it.
                  pin: session.lanPin,
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

/// 「把手机诊断日志发到电脑」("send the phone's diagnostic log to the PC"). Every outcome gets its own sentence — an upload
/// that silently did nothing would defeat the entire purpose of the feature.
class _UploadDiagnosticsButton extends StatefulWidget {
  const _UploadDiagnosticsButton({
    required this.strings,
    required this.endpoint,
    required this.device,
    required this.token,
    required this.pin,
  });

  final AppStrings strings;
  final String? endpoint;
  final String device;
  final String? token;
  final String? pin;

  @override
  State<_UploadDiagnosticsButton> createState() =>
      _UploadDiagnosticsButtonState();
}

class _UploadDiagnosticsButtonState extends State<_UploadDiagnosticsButton> {
  bool _busy = false;

  Future<void> _send() async {
    if (_busy) return;
    setState(() => _busy = true);
    final DiagUploadResult r = await uploadDiagnostics(
      endpoint: widget.endpoint,
      deviceLabel: widget.device.isEmpty ? 'phone' : widget.device,
      token: widget.token,
      pin: widget.pin,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    final AppStrings s = widget.strings;
    final String message = switch (r.outcome) {
      DiagUploadOutcome.delivered => s.diagUploadDone(r.lines),
      DiagUploadOutcome.empty => s.diagUploadEmpty,
      DiagUploadOutcome.noEndpoint => s.diagUploadNoEndpoint,
      DiagUploadOutcome.noSink => s.diagUploadNoSink,
      DiagUploadOutcome.unreachable => s.diagUploadUnreachable,
      DiagUploadOutcome.refused => s.diagUploadRefused(r.detail ?? ''),
    };
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        OutlinedButton.icon(
          onPressed: _busy ? null : _send,
          icon: Icon(_busy ? Icons.hourglass_top : Icons.upload_file, size: 16),
          label: Text(s.diagUpload, style: const TextStyle(fontSize: 13)),
          style: OutlinedButton.styleFrom(
            foregroundColor: FlowMicColors.t1,
            side: BorderSide(color: FlowMicColors.line),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          s.diagUploadHint,
          style: TextStyle(color: FlowMicColors.t2, fontSize: 11, height: 1.35),
        ),
      ],
    );
  }
}

/// P-8 —— the 「local engine」 section on the diagnostics sheet.
///
/// Public (rather than `_Private`) for exactly one reason: 0.2.53's rule
/// requires 「can the user read this sentence」's
/// acceptance test to **assert on the rendered result**
/// (`didExceedMaxLines` / intrinsic width vs. actual box), and that kind of
/// assertion
/// has to be able to mount this section **on its own** in a fixed-width box
/// to measure it. Measuring through the whole sheet cannot do it —
/// `showModalBottomSheet`'s box is sized by the screen, and the
/// four-language loop cannot each control its own width.
///
/// 🔴 [observation] being null ≠ 「the engine is broken」. It only means
/// **during this App run, on this channel, against this PC, not a single
/// `stt:engine-status` frame has been received yet**. So that tier draws
/// the sentence
/// 「there's nothing to say yet + how to make it have something to say」,
/// not a grey dot, and certainly not a green dot.
/// The criteria and the identity triple all live in [LocalEngineStatusStore].
///
/// ⚠️ This section **does NOT include** the endpoint / model ID / preset
/// name, nor **the AI-organize-engine half**, even though owner's
/// P-8 ruling asks for those. The reason is not an oversight: those three
/// have **no data source on the phone side at all today** (not on the
/// frame,
/// not on `/api/health` either), filling them in needs a new authenticated
/// HTTP route. The design doc, the route
/// contract, and the itemized debt are recorded in
/// `docs/strategy/2026-08-07-p8-local-engine-status-design-and-handoff.md`.
/// **The 「probe now」 button is likewise not drawn** — a button that does
/// nothing when pressed is worse than no button.
class DiagnosticsEngineSection extends StatelessWidget {
  const DiagnosticsEngineSection({
    super.key,
    required this.strings,
    required this.observation,
    this.now,
  });

  final AppStrings strings;
  final LocalEngineObservation? observation;

  /// The clock the instant label is judged against. Not passed in
  /// production (the real clock is used); tests pin it, so the
  /// four-language assertions do not drift with the run
  /// instant — the same technique `timelineTimeLabel` itself uses with its
  /// `{DateTime? now}`.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final LocalEngineObservation? o = observation;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            strings.diagEngineSection,
            style: TextStyle(
              color: FlowMicColors.t2,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          if (o == null)
            Text(
              strings.diagEngineNoObservation,
              style: TextStyle(
                color: FlowMicColors.t2,
                fontSize: 12,
                height: 1.35,
              ),
            )
          else ...<Widget>[
            // The name the engine self-reports. It is an **identifier**, so
            // it is allowed to wrap onto a new line rather than being
            // clipped: clipping off the back half of an identifier would
            // leave the reader unable to tell `funasr-ws` from `funasr-wss`
            // apart.
            Text(
              '${strings.diagEngineStt} · ${o.provider}',
              style: TextStyle(color: FlowMicColors.t1, fontSize: 13),
            ),
            const SizedBox(height: 2),
            // 🔴 The status word and 「凭什么」("what grounds") are **two
            // lines of the SAME widget**, with no condition in between.
            // R11: a status word with no source, no instant, is not allowed
            // to appear on this sheet — writing them as
            // two separate `if`s that could each be deleted independently
            // is handing this rule off to the next person's memory.
            Text(
              _outcomeWord(strings, o.outcome),
              style: TextStyle(
                color: switch (o.outcome) {
                  // `ready` is deliberately **not painted green**: it only
                  // proves the engine connection came up, not that it can
                  // produce transcribed text (the reasoning and source are
                  // in local_engine_status.dart file header ③). A green dot
                  // would turn a measurement about connectivity into a
                  // promise about capability.
                  LocalEngineOutcome.ready => FlowMicColors.t1,
                  LocalEngineOutcome.reconnecting => FlowMicColors.amber,
                  LocalEngineOutcome.failed => FlowMicColors.red,
                },
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              strings.diagEngineObservedAt(
                timelineTimeLabel(o.atUtc, now: now),
              ),
              style: TextStyle(
                color: FlowMicColors.t2,
                fontSize: 11,
                height: 1.35,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// D2LAN-B3/B4 —— the 「connection encryption」 section on the diagnostics
/// sheet.
///
/// 🔴 [encryption] MUST come from **this connection itself**
/// (`SocketTransport.lastLinkEncryption`,
/// written by the pinning connector inside the TLS callback), **never**
/// 「did we configure TLS」: the sidecar's single port
/// answers BOTH plaintext and TLS (server-core `lan-tls/dual-listener.ts`),
/// so 「the server has
/// TLS turned on」 says **nothing at all** about this particular connection.
/// That file itself names `req.socket.encrypted` as its
/// side's only honest answer; here we read the other end of the same TCP
/// connection.
///
/// 🔴 [pinSource] answers **a different question** — 「what grounds do we
/// have to trust that key is right」. Two values,
/// because they are two questions (design §4-4: QR scan = verified /
/// hand-typed = unverified, must not share one badge).
///
/// Public rather than private, for exactly the same reason as
/// [DiagnosticsEngineSection]: 0.2.53's rule requires
/// 「can the user read this sentence」 to be asserted on the **rendered
/// result**, and that kind of assertion must be able to mount this section
/// on its own in a
/// fixed-width box to measure it.
class DiagnosticsEncryptionSection extends StatelessWidget {
  const DiagnosticsEncryptionSection({
    super.key,
    required this.strings,
    required this.encryption,
    required this.pinSource,
  });

  final AppStrings strings;
  final LinkEncryption encryption;

  /// How this pairing's pin came to be (`MobileSession.lanTlsFpSource`).
  /// `null` = no pin.
  final LanPinSource? pinSource;

  @override
  Widget build(BuildContext context) {
    final AppStrings s = strings;
    // 🔴 `unknown` ⇒ the whole section is not drawn. It means 「we could
    // not measure it」, and this sheet's rule has always been
    // 「no real value, no row drawn」 — drawing it as 「unencrypted」 would
    // turn a measurement that never happened into a conclusion.
    if (encryption == LinkEncryption.unknown) return const SizedBox.shrink();
    final bool encrypted = encryption == LinkEncryption.pinnedTls;
    final String verdict = !encrypted
        ? s.diagEncryptionPlain
        : (pinSource == LanPinSource.qr
              ? s.diagEncryptionVerified
              : s.diagEncryptionTofu);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            s.diagEncryptionSection,
            style: TextStyle(
              color: FlowMicColors.t2,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            verdict,
            style: TextStyle(
              // 🔴 Encrypted **is also not painted green**, same reason as
              // `LocalEngineOutcome.ready`: a green dot would
              // turn 「nobody can eavesdrop」 into 「nobody can impersonate」,
              // and we cannot deliver that second half.
              color: encrypted ? FlowMicColors.t1 : FlowMicColors.amber,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          // 🔴 The disclosure sentence and the status word are **two
          // adjacent lines of the SAME widget, with no condition in
          // between** (the same
          // R11 rule as in DiagnosticsEngineSection): if the TOFU tier were
          // left with only the four
          // characters above, it would differ from the QR-scan tier on
          // screen by only two characters, while the guarantee behind them
          // differs by an entire threat model.
          if (encrypted && pinSource != LanPinSource.qr) ...<Widget>[
            const SizedBox(height: 2),
            Text(
              s.diagEncryptionTofuNote,
              style: TextStyle(
                color: FlowMicColors.t2,
                fontSize: 11,
                height: 1.35,
              ),
            ),
          ],
          if (encrypted) ...<Widget>[
            const SizedBox(height: 2),
            Text(
              s.diagEncryptionScopeNote,
              style: TextStyle(
                color: FlowMicColors.t2,
                fontSize: 11,
                height: 1.35,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Three states → four languages. The `switch` expression has no `default`,
/// so one more state in the future is a **compile error** rather than a
/// state
/// silently omitted — same reasoning as AppStrings's `_t` exhaustive switch.
String _outcomeWord(AppStrings s, LocalEngineOutcome o) => switch (o) {
  LocalEngineOutcome.ready => s.diagEngineConnected,
  LocalEngineOutcome.reconnecting => s.diagEngineReconnecting,
  LocalEngineOutcome.failed => s.diagEngineConnectFailed,
};

Widget _row(String label, String value) => Padding(
  padding: const EdgeInsets.only(bottom: 10),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      Text(
        label,
        style: TextStyle(
          color: FlowMicColors.t2,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
      const SizedBox(height: 2),
      Text(value, style: TextStyle(color: FlowMicColors.t1, fontSize: 13)),
    ],
  ),
);

/// Same label-then-value shape as [_row], but the value is the shared
/// [ChannelBadge] (tokens.dart) instead of plain text — 2026-08-01 owner:
/// 颜色+图标组合，不能只靠颜色 ("colour + icon combination, never colour
/// alone"). This sheet used to be the one place「通道」("channel") was a bare
/// word with no colour or icon at all.
Widget _channelRow(String label, String value, ServerChannel channel) =>
    Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: TextStyle(
              color: FlowMicColors.t2,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 3),
          ChannelBadge(
            label: value,
            cloud: channel == ServerChannel.cloudRelay,
          ),
        ],
      ),
    );
