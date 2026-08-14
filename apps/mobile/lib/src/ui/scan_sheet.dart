// SPEC-REF:
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-30/GA-31
//   CLAUDE.md red line: no silent failures
//
// ONE camera sheet, two callers.
//
// GA-30 put a scanner in the pairing sheet; GA-31 needs one on the sign-in
// screen. Rather than a second copy of the camera lifecycle + the permission
// fail-loud path, both use this: it shows the camera, hands every decoded value
// to the caller's `onScan`, and closes when the caller says the value was
// terminal. The caller keeps the meaning — this file owns only pixels and the
// permission failure.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../settings/app_strings.dart';
import 'tokens.dart';

/// Present a full-width scan sheet. [onScan] receives each decoded value and
/// returns true when it consumed one (the sheet then closes and resolves true).
/// A false return keeps the camera running — that is how a foreign QR stays a
/// notice rather than a dead end.
Future<bool> showScanSheet(
  BuildContext context, {
  required AppStrings strings,
  required String title,
  required String hint,
  required Future<bool> Function(String value) onScan,
}) async {
  final bool? ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _ScanSheet(strings: strings, title: title, hint: hint, onScan: onScan),
  );
  return ok ?? false;
}

class _ScanSheet extends StatefulWidget {
  const _ScanSheet({
    required this.strings,
    required this.title,
    required this.hint,
    required this.onScan,
  });
  final AppStrings strings;
  final String title;
  final String hint;
  final Future<bool> Function(String value) onScan;

  @override
  State<_ScanSheet> createState() => _ScanSheetState();
}

class _ScanSheetState extends State<_ScanSheet> {
  final MobileScannerController _scanner = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const <BarcodeFormat>[BarcodeFormat.qrCode],
  );
  String? _notice;
  bool _busy = false;

  @override
  void dispose() {
    unawaited(_scanner.dispose());
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_busy) return;
    for (final Barcode b in capture.barcodes) {
      final String? raw = b.rawValue;
      if (raw == null || raw.trim().isEmpty) continue; // aiming — say nothing
      _busy = true;
      final bool consumed = await widget.onScan(raw);
      if (!mounted) return;
      if (consumed) {
        Navigator.of(context).pop(true);
        return;
      }
      // Not ours / not usable: the caller has already set its own notice via
      // [notice]; re-arm so the user can simply keep scanning.
      _busy = false;
      return;
    }
  }

  void notice(String message) {
    if (mounted) setState(() => _notice = message);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    return Container(
      decoration: BoxDecoration(
        color: FlowMicColors.surface,
        border: Border(top: BorderSide(color: FlowMicColors.line)),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 22),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                widget.title,
                style: TextStyle(color: FlowMicColors.t1, fontSize: 15, fontWeight: FontWeight.w700),
              ),
              const Spacer(),
              InkWell(
                onTap: () => Navigator.of(context).pop(false),
                child: Icon(Icons.close, color: FlowMicColors.t3, size: 18),
              ),
            ],
          ),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: SizedBox(
              height: 240,
              child: MobileScanner(
                controller: _scanner,
                onDetect: (BarcodeCapture c) => unawaited(_onDetect(c)),
                // Fail-loud: a refused permission or a camera-less device shows
                // the reason here instead of a black rectangle.
                errorBuilder: (BuildContext context, MobileScannerException error) => _banner(
                  error.errorCode == MobileScannerErrorCode.permissionDenied
                      ? s.pairScanDenied
                      : s.pairScanNoCamera,
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Center(
            child: Text(widget.hint, style: TextStyle(color: FlowMicColors.t3, fontSize: 12)),
          ),
          if (_notice != null) ...<Widget>[
            const SizedBox(height: 12),
            _banner(_notice!),
          ],
        ],
      ),
    );
  }

  Widget _banner(String message) => Container(
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
          child: Text(message, style: const TextStyle(color: Color(0xFFFCA5A5), fontSize: 12)),
        ),
      ],
    ),
  );
}
