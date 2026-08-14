// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.1 (stats), §6.2 (clear)
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4, §5-1..-6
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md G-17 / RV-96
//
// Settings → Data → "Stats & clear". owner's RV-96 — the clear function he can
// see and operate himself.
//
// 🔴 IT DOES NOT COMPUTE ANYTHING ITSELF. Every number comes from
// [AssetInventory] (the inventory layer) — the walk that serialises an export
// and the walk that selects what clear deletes are the SAME walk. So
// "stats says N rows", "export produced N rows", "clear zeroed it out" are
// STRUCTURALLY incapable of disagreeing (overview design §5-2).
//
// 🔴 §6.2-5 — "will free X" MUST be a MEASURED byte count. The number below
// comes from the inventory layer's real measurement (`metadata().len()` per
// file) of the batch of rows about to be deleted, not row count times an
// average. **A fabricated freed-byte number and a fabricated progress bar are
// the same thing.**
//
// ⚠️ D7 — preview and delete are the SAME predicate over the SAME whole-table
// source, and that is now checkable rather than asserted: the estimate below
// walks `AssetInventory` (→ `readAllRowsForInventory` → `loadAll`) through
// [planClear]; `TimelineStore.clear` selects its doomed set from
// `_persistence.loadAll()` through the same [planClear]. Before D7 the delete
// side selected from the in-memory PAGE (60 rows), so this sheet promised a
// whole-database clear and the store deleted one screenful — while still
// advancing the cutoff over the whole range. `previewClear` (the in-memory
// selector an older comment here pointed at) is deleted; do not reintroduce a
// preview that reads anything narrower than the table.

import 'dart:async';

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../session/image_payload.dart' show formatBytes;
import '../timeline/entry_metrics.dart' show formatEntryDuration;
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_purge.dart';
import '../timeline/timeline_reaper.dart';
import '../timeline/timeline_store.dart';
import '../ui/tokens.dart';
import 'asset_inventory.dart';

Future<void> showStatsClearSheet(
  BuildContext context, {
  required AssetInventory inventory,
  required TimelineStore store,
  required AppStrings strings,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext ctx) => SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: _StatsClearSheet(
          inventory: inventory,
          store: store,
          strings: strings,
        ),
      ),
    ),
  );
}

class _StatsClearSheet extends StatefulWidget {
  const _StatsClearSheet({
    required this.inventory,
    required this.store,
    required this.strings,
  });

  final AssetInventory inventory;
  final TimelineStore store;
  final AppStrings strings;

  @override
  State<_StatsClearSheet> createState() => _StatsClearSheetState();
}

class _StatsClearSheetState extends State<_StatsClearSheet> {
  AssetTally? _tally;
  List<InstanceTally> _groups = const <InstanceTally>[];

  ClearKind _kind = ClearKind.text;
  ClearWindow _window = ClearWindow.month;

  /// The **real** row count and byte count for the batch about to be
  /// deleted, from the inventory layer. null = not yet computed.
  ({int rows, int bytes})? _doomed;

  bool _busy = false;
  ReapResult? _done;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    final AssetTally t = await widget.inventory.tally();
    final List<InstanceTally> g = await widget.inventory.tallyByInstance();
    if (!mounted) return;
    setState(() {
      _tally = t;
      _groups = g;
    });
    await _recount();
  }

  /// Walk the **inventory layer** over the whole table, select rows by the
  /// same predicate as delete, and sum their bytes.
  Future<void> _recount() async {
    final DateTime? horizon = horizonOf(_window, DateTime.now().toUtc());
    int rows = 0;
    int bytes = 0;
    await for (final TimelineAsset a in widget.inventory.walk()) {
      final List<TimelineEntry> hit = planClear(
        <TimelineEntry>[a.entry],
        _kind,
        horizon,
      );
      if (hit.isEmpty) continue;
      rows += 1;
      // Text counts too: if clearing text-only reported only image bytes,
      // that number would read as 0, which reads as "this action frees
      // nothing".
      bytes += TimelineAsset.textBytesOf(a.entry) + a.imageBytes;
    }
    if (!mounted) return;
    setState(() {
      _doomed = (rows: rows, bytes: bytes);
      _done = null;
    });
  }

  Future<void> _run() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final ReapResult out = await widget.store.clear(_kind, _window);
      if (!mounted) return;
      setState(() => _done = out);
      await _refresh();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirm() async {
    final ({int rows, int bytes})? d = _doomed;
    if (d == null || d.rows == 0) return;
    final AppStrings s = widget.strings;
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: Text(s.clearConfirmTitle),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            // The confirm dialog references the **same** estimate — the
            // button lights up because of it, and the dialog speaks from it.
            Text('${_kindLabel(_kind)} · ${_windowLabel(_window)}'),
            const SizedBox(height: 8),
            Text(s.clearPreview(d.rows, d.bytes)),
            const SizedBox(height: 8),
            Text(s.clearIrreversible, style: TextStyle(color: FlowMicColors.red)),
          ],
        ),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(s.clearCancel)),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(s.clearConfirmOk)),
        ],
      ),
    );
    if (ok ?? false) await _run();
  }

  String _kindLabel(ClearKind k) => switch (k) {
    ClearKind.text => widget.strings.clearKindText,
    ClearKind.images => widget.strings.clearKindImages,
    ClearKind.both => widget.strings.clearKindBoth,
  };

  String _windowLabel(ClearWindow w) => switch (w) {
    ClearWindow.week => widget.strings.clearWinWeek,
    ClearWindow.month => widget.strings.clearWinMonth,
    ClearWindow.quarter => widget.strings.clearWinQuarter,
    ClearWindow.halfYear => widget.strings.clearWinHalfYear,
    ClearWindow.year => widget.strings.clearWinYear,
    ClearWindow.all => widget.strings.clearWinAll,
  };

  /// `2026-06-02` — day precision only. The range itself has no second-level
  /// precision, and rendering more would make it look more exact than it is.
  String _day(DateTime? at) =>
      at == null ? '' : at.toLocal().toIso8601String().substring(0, 10);

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    final AssetTally? t = _tally;
    final Cutoffs marks = widget.store.cutoffs;
    return Container(
      decoration: BoxDecoration(
        color: FlowMicColors.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
      ),
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(s.statsTitle, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(s.statsSub, style: TextStyle(fontSize: 12, color: FlowMicColors.t3)),
            const SizedBox(height: 12),
            if (t == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)),
              )
            else if (t.isEmpty)
              Text(s.statsEmpty, style: const TextStyle(fontSize: 13))
            else ...<Widget>[
              _stat(s.statsDuration, formatEntryDuration(t.durationMs)),
              // 🔴 "unknown" must never be counted as "zero seconds" — this
              // sentence must follow the total.
              if (t.withoutDurationCount > 0)
                _note(s.statsNoDurationCount(t.withoutDurationCount)),
              _stat(s.statsWords, s.statsWordsUnit(t.wordCount)),
              _stat(s.statsRows, s.statsRowsUnit(t.entryCount)),
              _stat(
                '${s.statsTranscripts} / ${s.statsImages}',
                '${t.transcriptCount} / ${t.imageCount}',
              ),
              _stat(s.statsTextSize, formatBytes(t.textBytes)),
              if (t.imageFileCount > 0)
                _stat(s.statsImageSize, formatBytes(t.imageBytes)),
              if (t.imageCount > t.imageFileCount)
                _note(s.statsMissingPictures(t.imageCount - t.imageFileCount)),
              if (t.oldest != null)
                _stat(s.statsRange, s.statsRange2(_day(t.oldest), _day(t.newest))),
              if (_groups.length > 1) ...<Widget>[
                const SizedBox(height: 10),
                Text(s.statsByPc, style: TextStyle(fontSize: 12, color: FlowMicColors.t3)),
                for (final InstanceTally g in _groups)
                  _stat(
                    g.instanceName ?? s.statsUnknownPc,
                    '${s.statsRowsUnit(g.tally.entryCount)} · ${s.statsWordsUnit(g.tally.wordCount)}',
                  ),
              ],
              // owner 2026-08-02: word-segmentation differs by language ⇒ the
              // number is for reference only — the same sentence on both
              // ends (desktop is TimelineStats.vue's st_approx). Only shown
              // when there is a number for it to qualify.
              const SizedBox(height: 6),
              _note(s.statsApprox),
            ],

            const Divider(height: 28),

            Text(s.clearTitle, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(s.clearSub, style: TextStyle(fontSize: 12, color: FlowMicColors.t3)),
            const SizedBox(height: 8),
            // 🔴 A standing warning, above the button — the user reads it
            // before pressing (same discipline as export's plain-text warning).
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: FlowMicColors.red.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                s.clearIrreversible,
                style: TextStyle(fontSize: 12, color: FlowMicColors.red, height: 1.5),
              ),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final ClearKind k in ClearKind.values)
                  _chip(_kindLabel(k), k == _kind, () {
                    setState(() => _kind = k);
                    unawaited(_recount());
                  }),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final ClearWindow w in ClearWindow.values)
                  _chip(_windowLabel(w), w == _window, () {
                    setState(() => _window = w);
                    unawaited(_recount());
                  }),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              _doomed == null || _doomed!.rows == 0
                  ? s.clearNothing
                  : s.clearPreview(_doomed!.rows, _doomed!.bytes),
              style: const TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                // The minimal button ⇔ byte-count coupling: when there is
                // nothing to delete, it must not be pressable.
                onPressed: (_doomed?.rows ?? 0) == 0 || _busy ? null : _confirm,
                style: FilledButton.styleFrom(backgroundColor: FlowMicColors.red),
                child: Text(s.clearAction),
              ),
            ),
            if (_done != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                s.clearDone(_done!.rows, _done!.bytesFreed),
                style: TextStyle(fontSize: 12, color: FlowMicColors.green),
              ),
            ],
            // §6.2-3 cleared ≠ never existed: it must be able to say what
            // range was cleared, and still say so after a restart.
            if (marks.text != null) _note(s.clearedTextBefore(_day(marks.text))),
            if (marks.images != null) _note(s.clearedImagesBefore(_day(marks.images))),
          ],
        ),
      ),
    );
  }

  Widget _stat(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: <Widget>[
        Expanded(
          child: Text(label, style: TextStyle(fontSize: 13, color: FlowMicColors.t3)),
        ),
        Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      ],
    ),
  );

  Widget _note(String text) => Padding(
    padding: const EdgeInsets.only(top: 4, bottom: 4),
    child: Text(
      text,
      style: TextStyle(fontSize: 11, color: FlowMicColors.t3, height: 1.5),
    ),
  );

  Widget _chip(String label, bool on, VoidCallback onTap) => GestureDetector(
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      // Selected = brandSoft fill + brand border + brand text, the same
      // palette as mode_chip.dart, and **introduces no color literal**
      // (design-token-literals lint gate).
      decoration: BoxDecoration(
        color: on ? FlowMicColors.brandSoft : Colors.transparent,
        border: Border.all(color: on ? FlowMicColors.brand : FlowMicColors.line),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: on ? FontWeight.w600 : FontWeight.w400,
          color: on ? FlowMicColors.brand : FlowMicColors.t3,
        ),
      ),
    ),
  );
}
