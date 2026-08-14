// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (pairing entry: 4-digit code / QR; the PC
//     endpoint the phone must dial), §2 (PAIR_NOT_CONNECTED gate)
//   docs/ui-design/demo/mobile.html frame 1 (add device)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R23-1 (4-digit code entry required; QR scan once deferred)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-30
//   CLAUDE.md red line: no silent failure
//
// The "add pairing" bottom sheet — TWO tabs, and QR scan is the first one.
//
// GA-30 (owner 2026-07-26:「scan takes priority over manual entry」) closed
// the WP-R23-1 deferral. What
// scanning adds is an INPUT, not a second pairing path: a decoded
// `flowmic://pair` link goes to the same `ConnectionsController.addByCode` that
// has accepted a pasted link since WP-R23-1, so the parse, the dial and every
// failure code stay exactly where they were.
//
// Two honesty rules the camera forced into view (both live in ../ui/scan_payload):
//   · aiming produces a stream of empty frames — that is SILENCE, not an error;
//   · a barcode that is not ours is refused BY NAME. Passing an arbitrary QR to
//     the pairing call would report 「pairing code invalid」 and send the user looking for a
//     code problem they do not have.
// And when the camera cannot be used at all, the sheet falls back to manual entry
// WITH the reason on screen — a silent fallback would just look like a form.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../session/connections_controller.dart';
import '../session/pcid.dart';
import '../settings/app_strings.dart';
import 'guide/pairing_guide_view.dart';
import 'ime_normalizer.dart';
import 'scan_payload.dart';
import 'tokens.dart';

/// Presents the add-pairing sheet. Resolves to true iff a pairing succeeded.
Future<bool> showAddPairingSheet(
  BuildContext context, {
  required ConnectionsController controller,
  required AppStrings strings,
  String? initialEndpoint,
}) async {
  controller.clearError();
  final bool? ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _AddPairingSheet(
      controller: controller,
      strings: strings,
      initialEndpoint: initialEndpoint,
    ),
  );
  return ok ?? false;
}

class _AddPairingSheet extends StatefulWidget {
  const _AddPairingSheet({
    required this.controller,
    required this.strings,
    this.initialEndpoint,
  });
  final ConnectionsController controller;
  final AppStrings strings;
  final String? initialEndpoint;

  @override
  State<_AddPairingSheet> createState() => _AddPairingSheetState();
}

class _AddPairingSheetState extends State<_AddPairingSheet> {
  late final TextEditingController _address =
      TextEditingController(text: widget.initialEndpoint ?? '');
  final TextEditingController _code = TextEditingController();
  String? _localError; // client-side validation before hitting the controller

  // ── 0.2.66 PCID (design §7-1/§7-2) ────────────────────────────────────────
  /// The relay's 9-digit address for the target PC. Cloud only: owner ruled the
  /// LAN keeps 「address + 4-digit code」 unchanged, so this field must not appear there.
  final TextEditingController _pcid = TextEditingController();
  final FocusNode _pcidFocus = FocusNode();

  /// 🔴 THE SERVER OVERRULING OUR GUESS. Set when a pair attempt comes back
  /// `PAIR_PCID_REQUIRED`, and never cleared for the life of the sheet.
  ///
  /// [addressIsCloudRelay] is a host comparison against the known relay, which
  /// answers `false` for a self-hosted relay or one reached by bare IP. Those
  /// users would otherwise face a screen with no way to supply the thing the
  /// server just asked for — a field hidden by our own heuristic, and no
  /// affordance anywhere to reveal it. So the refusal reveals it.
  bool _pcidForcedByServer = false;

  // GA-30 — scan is the default tab; manual is the second one.
  PairTab _tab = PairTab.scan;
  /// P-7 ③ — the 「?」 guide, pushed OVER the tabs inside this same sheet. Same
  /// idiom the tabs already use (a field plus setState plus a collection-`if`),
  /// so the camera goes through exactly the unmount/remount it already goes
  /// through on every tab tap, and no new navigation layer appears.
  ///
  /// 🔴 Nothing sets this except a user tap on the 「?」. In particular a
  /// pairing FAILURE must not raise it (design §4.3): the sheet is at that
  /// moment displaying the specific reason, and this would cover it.
  bool _showGuide = false;
  MobileScannerController? _scanner;
  /// Loud, transient copy for a barcode we read but cannot use.
  String? _scanNotice;
  /// Set once a pairing link has been accepted, so a camera that keeps firing
  /// cannot start a second pairing while the first is in flight.
  bool _scanConsumed = false;

  @override
  void initState() {
    super.initState();
    _startScanner();
  }

  void _startScanner() {
    // Constructing the controller is what asks Android for the camera; a refusal
    // surfaces through MobileScanner's errorBuilder below, never as a blank box.
    _scanner = MobileScannerController(
      detectionSpeed: DetectionSpeed.noDuplicates,
      formats: const <BarcodeFormat>[BarcodeFormat.qrCode],
    );
  }

  /// Fall back to manual entry and SAY WHY (the whole point of the fallback).
  void _fallbackToManual(String reason) {
    if (!mounted || _tab == PairTab.manual) return;
    setState(() {
      _tab = PairTab.manual;
      _scanNotice = reason;
    });
  }

  void _onDetect(BarcodeCapture capture) {
    if (_scanConsumed || widget.controller.busy) return;
    final AppStrings s = widget.strings;
    for (final Barcode b in capture.barcodes) {
      final ScanResult r = classifyScan(b.rawValue);
      switch (r.verdict) {
        case ScanVerdict.nothing:
          continue; // silence — this happens constantly while aiming
        case ScanVerdict.pairLink:
          _scanConsumed = true;
          unawaited(_submitScanned(r.payload!));
          return;
        case ScanVerdict.loginLink:
          _notice(s.pairScanIsLogin);
          return;
        case ScanVerdict.foreign:
          _notice(s.pairScanForeign);
          return;
      }
    }
  }

  void _notice(String message) {
    if (!mounted || _scanNotice == message) return;
    setState(() => _scanNotice = message);
  }

  /// A scanned link carries its own endpoint, so the address field is not needed
  /// — `addByCode` reads it out of the link exactly as it does for a pasted one.
  Future<void> _submitScanned(String link) async {
    final ConnectOutcome outcome =
        await widget.controller.addByCode(rawEndpoint: '', code: link);
    if (!mounted) return;
    if (outcome.success) {
      Navigator.of(context).pop(true);
      return;
    }
    // 0.2.66 — a pre-0.2.66 desktop's cloud QR has no `pcid=`, so the relay
    // refuses it exactly as it refuses a bare code. Re-scanning cannot fix that
    // (the QR will keep not carrying one), and manual entry is the way out ⇒
    // the field is revealed for when the user switches tabs.
    _noteRefusal(outcome.error);
    // Fail-loud: the controller's error renders below, and the camera is armed
    // again so the user can simply re-scan (a consumed-forever scanner after a
    // transient failure would look like the app ignoring them).
    setState(() => _scanConsumed = false);
  }

  @override
  void dispose() {
    _address.dispose();
    _code.dispose();
    _pcid.dispose();
    _pcidFocus.dispose();
    unawaited(_scanner?.dispose());
    super.dispose();
  }

  /// Is the PCID field on screen right now? Recomputed on every build, because
  /// its first input — what is currently typed in the address box — changes as
  /// the user types (see the address field's `onChanged`).
  bool get _pcidVisible =>
      _pcidForcedByServer ||
      addressIsCloudRelay(_address.text, widget.controller.saasEndpoint);

  /// 🔴 The one place a `PAIR_PCID_REQUIRED` refusal is acted on. Reached from
  /// BOTH submit paths: a scanned QR from a pre-0.2.66 desktop carries no
  /// `pcid=` and gets the same refusal, and the manual tab is where that user
  /// has to end up.
  void _noteRefusal(String? error) {
    if (!isPcidRequiredRefusal(error) || _pcidForcedByServer) return;
    setState(() => _pcidForcedByServer = true);
    // Only when the field is about to be built. A detached FocusNode would take
    // focus on its next reparent, which for the scan tab means the field
    // silently stealing focus later — a control grabbing the keyboard for a
    // reason the user can no longer see.
    if (_tab == PairTab.manual) _pcidFocus.requestFocus();
  }

  Future<void> _submit() async {
    if (widget.controller.busy) return;
    final String code = _code.text.trim();
    final String addr = _address.text.trim();
    final bool isLink = code.startsWith('flowmic://');
    // A bare code needs an address; a pasted link carries its own endpoint.
    if (!isLink && addr.isEmpty) {
      setState(() => _localError = widget.strings.pairNeedAddress);
      return;
    }
    // 0.2.66 — only when the field is actually on screen. Validating a hidden
    // field would refuse LAN pairing over a value the user was never shown.
    final String? pcid = readPcid(_pcid.text);
    final bool wantPcid = !isLink && _pcidVisible;
    if (wantPcid && pcid == null) {
      setState(() => _localError = widget.strings.pairNeedPcid);
      _pcidFocus.requestFocus();
      return;
    }
    if (!isLink && !RegExp(r'^\d{4}$').hasMatch(code)) {
      setState(() => _localError = widget.strings.pairNeedCode);
      return;
    }
    setState(() => _localError = null);
    final ConnectOutcome outcome = await widget.controller.addByCode(
      rawEndpoint: addr,
      code: code,
      // Gated on visibility, not on emptiness: a PCID typed for the relay and
      // then followed by a LAN address must not ride along to a sidecar that
      // has no idea what it is.
      pcid: wantPcid ? pcid : null,
    );
    if (!mounted) return;
    if (outcome.success) {
      Navigator.of(context).pop(true);
      return;
    }
    _noteRefusal(outcome.error);
    // On failure the controller.lastError is shown by the ListenableBuilder below;
    // the sheet stays open for a retry (fail-loud, never a fake success).
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    final double insets = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: insets),
      child: Container(
        decoration: BoxDecoration(
          color: FlowMicColors.surface,
          border: Border(top: BorderSide(color: FlowMicColors.line)),
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 22),
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (BuildContext context, _) {
            final bool busy = widget.controller.busy;
            final bool showError =
                _localError != null || widget.controller.lastError != null;
            final String error = _localError ?? s.pairError(widget.controller.lastError);
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Center(
                  child: Container(
                    width: 36,
                    height: 4,
                    margin: const EdgeInsets.only(bottom: 14),
                    decoration: BoxDecoration(
                      color: FlowMicColors.line,
                      borderRadius: BorderRadius.circular(99),
                    ),
                  ),
                ),
                Row(
                  children: <Widget>[
                    if (_showGuide) ...<Widget>[
                      InkWell(
                        key: const ValueKey<String>('pair.guide.back'),
                        onTap: () => setState(() => _showGuide = false),
                        borderRadius: BorderRadius.circular(10),
                        child: Padding(
                          padding: const EdgeInsets.all(6),
                          child: Icon(Icons.arrow_back, color: FlowMicColors.t2, size: 18),
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    Text(
                      _showGuide ? s.guidePairingTitle : s.addPairingTitle,
                      style: TextStyle(
                        color: FlowMicColors.t1,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const Spacer(),
                    // P-7 ③: the guide entry, hidden while the guide is open —
                    // an entry to the screen you are already on is the 「control
                    // that changes nothing」 shape.
                    if (!_showGuide) ...<Widget>[
                      PairingGuideButton(
                        strings: s,
                        onTap: () => setState(() => _showGuide = true),
                      ),
                      const SizedBox(width: 2),
                    ],
                    InkWell(
                      onTap: () => Navigator.of(context).pop(false),
                      child: Icon(Icons.close, color: FlowMicColors.t3, size: 18),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                if (_showGuide)
                  PairingGuideView(
                    strings: s,
                    onBack: () => setState(() => _showGuide = false),
                  )
                else ...<Widget>[
                _tabs(s),
                if (_scanNotice != null) ...<Widget>[
                  const SizedBox(height: 12),
                  _errorBanner(_scanNotice!),
                ],
                const SizedBox(height: 14),
                if (_tab == PairTab.scan) ...<Widget>[
                  _scanPane(s),
                  const SizedBox(height: 10),
                  Center(
                    child: Text(
                      s.pairScanHint,
                      style: TextStyle(color: FlowMicColors.t3, fontSize: 12),
                    ),
                  ),
                  if (showError) ...<Widget>[
                    const SizedBox(height: 12),
                    _errorBanner(error),
                  ],
                ] else ...<Widget>[
                _label(s.pcAddressLabel),
                // URL keyboard + fullwidth→halfwidth normalization: a Chinese IME
                // otherwise rewrites '.'/':' to '。'/'：' and the address never
                // parses (WP-R4-2 ⑥ real-device finding).
                _field(
                  controller: _address,
                  hint: s.pcAddressHint,
                  keyboard: TextInputType.url,
                  // 0.2.66 — the address is the input to [_pcidVisible], so an
                  // edit has to reach build. Without this the PCID field would
                  // appear only on the NEXT unrelated rebuild, i.e. it would
                  // look like it appears at random.
                  onEdited: () => setState(() {}),
                ),
                // 0.2.66 — cloud relay only (owner: 「local LAN … has no PCID」).
                // Placed ABOVE the code so it reads in the order the desktop
                // prints the two: PCID identifies the machine, the code is the
                // 5-minute secret.
                if (_pcidVisible) ...<Widget>[
                  const SizedBox(height: 12),
                  _label(s.pcidLabel),
                  _field(
                    fieldKey: const ValueKey<String>('pair.pcid'),
                    controller: _pcid,
                    focusNode: _pcidFocus,
                    hint: s.pcidInputHint,
                    keyboard: TextInputType.number,
                    digits: kPcidLength,
                  ),
                ],
                const SizedBox(height: 12),
                _label(s.pairCodeLabel),
                _field(
                  fieldKey: const ValueKey<String>('pair.code'),
                  controller: _code,
                  hint: s.pairCodeInputHint,
                  keyboard: TextInputType.number,
                ),
                if (showError) ...<Widget>[
                  const SizedBox(height: 12),
                  _errorBanner(error),
                ],
                const SizedBox(height: 16),
                _primaryButton(
                  label: busy ? s.pairing : s.pairConnect,
                  enabled: !busy,
                  onTap: _submit,
                ),
                ],
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _tabs(AppStrings s) => Row(
    children: <Widget>[
      _tabButton(s.pairTabScan, PairTab.scan),
      const SizedBox(width: 8),
      _tabButton(s.pairTabManual, PairTab.manual),
    ],
  );

  Widget _tabButton(String label, PairTab tab) {
    final bool on = _tab == tab;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() {
          _tab = tab;
          _scanNotice = null;
        }),
        child: Container(
          height: 36,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: on ? FlowMicColors.surface2 : Colors.transparent,
            border: Border.all(color: on ? FlowMicColors.brand : FlowMicColors.line),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: on ? FlowMicColors.brand : FlowMicColors.t2,
              fontSize: 13,
              fontWeight: on ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }

  /// The camera pane. `errorBuilder` is the fail-loud seam: a refused permission
  /// or a device with no camera lands there, and we move the user to manual entry
  /// WITH the reason rather than leaving a black rectangle on screen.
  Widget _scanPane(AppStrings s) {
    final MobileScannerController? c = _scanner;
    if (c == null) {
      return _errorBanner(s.pairScanNoCamera);
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: SizedBox(
        height: 240,
        child: MobileScanner(
          controller: c,
          onDetect: _onDetect,
          errorBuilder: (BuildContext context, MobileScannerException error) {
            final String reason = error.errorCode == MobileScannerErrorCode.permissionDenied
                ? s.pairScanDenied
                : s.pairScanNoCamera;
            // Deferred: setState during build is illegal, and this builder runs
            // inside one.
            WidgetsBinding.instance.addPostFrameCallback((_) => _fallbackToManual(reason));
            return _errorBanner(reason);
          },
        ),
      ),
    );
  }

  Widget _label(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(text, style: TextStyle(color: FlowMicColors.t2, fontSize: 12)),
  );

  Widget _field({
    required TextEditingController controller,
    required String hint,
    TextInputType? keyboard,
    Key? fieldKey,
    FocusNode? focusNode,
    /// Digit cap for a number field. 4 = the pairing code; 9 = the PCID
    /// ([kPcidLength]). Named rather than hardcoded because the two fields now
    /// share this chain and a single literal would have made one of them wrong.
    int digits = 4,
    /// Runs after the shared clear-the-error work, for a field whose VALUE the
    /// surrounding layout depends on.
    VoidCallback? onEdited,
  }) => TextField(
    key: fieldKey,
    controller: controller,
    focusNode: focusNode,
    keyboardType: keyboard,
    // Fullwidth normalization runs FIRST on every field so a Chinese IME's
    // '１'/'。'/'：' fold to ASCII before any further filtering. The 4-digit code
    // field then keeps only ASCII digits (so normalized '１２３４' → '1234' passes).
    // The PCID field rides the same chain, which is also what quietly absorbs
    // the display grouping ('123 456 789' → '123456789') as it is typed.
    inputFormatters: keyboard == TextInputType.number
        ? <TextInputFormatter>[
            const FullwidthAsciiInputFormatter(),
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(digits),
          ]
        : <TextInputFormatter>[const FullwidthAsciiInputFormatter()],
    onChanged: (_) {
      widget.controller.clearError();
      if (_localError != null) setState(() => _localError = null);
      onEdited?.call();
    },
    style: TextStyle(color: FlowMicColors.t1, fontSize: 13),
    decoration: InputDecoration(
      hintText: hint,
      hintStyle: TextStyle(color: FlowMicColors.t3, fontSize: 13),
      filled: true,
      fillColor: FlowMicColors.surface2,
      contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: FlowMicColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: FlowMicColors.brand),
      ),
    ),
  );

  Widget _errorBanner(String message) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: FlowMicColors.redSoft,
      border: Border.all(color: const Color(0x4DF87171)),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: <Widget>[
        const Icon(Icons.error_outline, size: 14, color: Color(0xFFFCA5A5)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            style: const TextStyle(color: Color(0xFFFCA5A5), fontSize: 12),
          ),
        ),
      ],
    ),
  );

  Widget _primaryButton({
    required String label,
    required bool enabled,
    required VoidCallback onTap,
  }) => Opacity(
    opacity: enabled ? 1 : 0.6,
    child: GestureDetector(
      onTap: enabled ? onTap : null,
      child: Container(
        height: 46,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: <Color>[Color(0xFF5B54E8), Color(0xFF7C74F2)]),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          label,
          style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
        ),
      ),
    ),
  );
}
