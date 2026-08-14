// ── WHY THIS FILE EXISTS: THE 800-LINE CAP, AND NOTHING ELSE ─────────────────
//
// `verify:lint` file-size (SRC_MAX = 800) — plus_panel.dart sat at 765 before
// REQ-12-09 09-D/09-F/09-G added the tick boxes and the send bar. Splitting now,
// rather than under the pressure of the edit after this one, is the precedent
// this tree has already set three times (manual_delivery_host.dart,
// timeline_sqlite_schema.dart, ptt_wire_keepalive.dart).
//
// 🔴 **THIS IS A MOVE**, with ONE mechanical change, listed here so the claim
// stays checkable. `_ImageTile` and `_ImageTileState` are otherwise byte-for-byte
// what they were in plus_panel.dart, doc comments included — no member added,
// removed, renamed or re-typed.
//
//   (1) the tile's border was the raw ARGB literal 0x66818CF8 and is now
//       `FlowMicColors.brand.withValues(alpha: 0.4)`. NOT a tidy-up: the
//       `design-token-literals` gate is keyed on `file|literal`, so a pinned
//       debt that MOVES becomes a NEW hit and the gate goes red — correctly, it
//       is doing its job. The substitution is the one 5b902db already made twice
//       in this very panel with its reasoning stated: 0x66818CF8 is dark-brand
//       @ .4, so **dark is pixel-identical** and light stops freezing at
//       indigo-400 where brand deepens to indigo-600 (settings_widgets.dart:110).
//       ⚠️ The two are identical in dark and DIFFERENT in light. That is a real
//       (intended) behaviour change on one theme, and calling this a pure move
//       without saying so is exactly the kind of quiet edit this header exists
//       to prevent.
//
// A `part` and NOT a second library, deliberately: the class is private
// (`_ImageTile`), so a separate library would have forced a rename to a public
// name, and a rename inside a 「pure relocation, no edits」 split is exactly the
// edit that makes the
// claim above uncheckable. Privacy in Dart is per-library and a part is the same
// library, so the move needed no rename and edited zero call sites.
//
// Stated explicitly because a split is the easiest place to smuggle a change
// into: if a future reader diffs these declarations against the git history and
// finds a difference, that difference is a BUG, not an intention.

part of 'plus_panel.dart';

/// R6 T-4 album picture (§6.1 B3) + the original-image tick box (owner 2026-08-01).
///
/// ── WHY THE TICK IS HERE AND NOT AFTER THE PICKER ────────────────────────────
/// The flow is 「pick the picture and send directly」 — there is no confirmation
/// step, and adding one is
/// the more expensive change in the wrong place: the picked bytes would have to
/// survive another UI round trip, and that round trip lands inside exactly the
/// window RCA-v3/RV-60 measured (the system picker backgrounds the app, EMUI
/// severs the idle TCP, and the process is killable for up to 30 s). Deciding
/// BEFORE the tap keeps the send one uninterrupted step, and the panel already
/// closes itself before the picker opens.
///
/// ── WHY STATEFUL, AND WHY THAT IS THE 「DEFAULT OFF」 GUARANTEE ────────────────
/// owner chose 「tick it each time a picture is sent」 over a settings switch,
/// giving the reason: a
/// switch left on quietly eats the send budget forever. So the tick must not
/// survive a panel open. It is local State on a widget that `showPlusPanel`
/// constructs fresh every time ⇒ 「unticked by default」 is STRUCTURAL — there
/// is no stored
/// value anywhere that someone could forget to reset, and no settings key to
/// drift. Do not lift this into a store to make it 「sticky」 without a ruling.
class _ImageTile extends StatefulWidget {
  const _ImageTile({
    required this.strings,
    required this.noPcTarget,
    required this.imageSending,
    required this.onPickImage,
    required this.originalBlock,
  });

  final AppStrings strings;
  final bool noPcTarget;
  final bool imageSending;
  final Future<void> Function(bool original) onPickImage;

  /// Null ⇒ the original image is on offer (LAN). Non-null ⇒ it is not, and
  /// this says why —
  /// rendered in the tick box's own place (owner 2026-08-01 / red line R8).
  final ImageOriginalBlock? originalBlock;

  @override
  State<_ImageTile> createState() => _ImageTileState();
}

class _ImageTileState extends State<_ImageTile> {
  /// The original-image flag. Starts false on every panel open — see the class doc.
  bool _original = false;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = widget.strings;
    final bool on = !widget.imageSending;
    final String sub = widget.imageSending
        ? strings.imageSending
        : widget.noPcTarget
        ? strings.imageTileSubLocal
        : strings.imageTileSub;
    return Container(
      decoration: BoxDecoration(
        color: on ? FlowMicColors.brandSoft : FlowMicColors.surface2,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          // Mechanical change (1) — see the file header for why the literal
          // could not travel with the rest of the move.
          color: on
              ? FlowMicColors.brand.withValues(alpha: 0.4)
              : FlowMicColors.line,
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          InkWell(
            key: const ValueKey<String>('plus.image.pick'),
            onTap: on
                ? () async {
                    // Close the sheet FIRST: the OS photo picker is a
                    // full-screen activity, and leaving our bottom sheet stacked
                    // behind it leaves the user on a stale panel when they come
                    // back. `_original` is read HERE, before the pop, so the
                    // value that travels is the one that was on screen.
                    final bool original = _original;
                    Navigator.of(context).pop();
                    await widget.onPickImage(original);
                  }
                : null,
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              child: Row(
                children: <Widget>[
                  if (widget.imageSending)
                    SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: FlowMicColors.t3,
                      ),
                    )
                  else
                    Icon(
                      Icons.image_outlined,
                      size: 18,
                      color: on ? FlowMicColors.brand : FlowMicColors.t3,
                    ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          strings.imageTile,
                          style: TextStyle(
                            color: on ? FlowMicColors.t1 : FlowMicColors.t2,
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          sub,
                          style: TextStyle(
                            color: FlowMicColors.t3,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (widget.originalBlock != null)
            _originalUnavailable(widget.originalBlock!)
          else
            _originalTick(on),
        ],
      ),
    );
  }

  /// owner 2026-08-01: the original image is LAN-only. The box is gone, its
  /// reason is not —
  /// it stands in the same place (red line R8 + the B3-9 precedent), so the user
  /// reads 「not on this channel」 rather than 「this feature is gone」.
  ///
  /// Not a disabled tick box: a box you can see but never tick is the control
  /// that changes nothing, which is the thing R8 actually forbids.
  Widget _originalUnavailable(ImageOriginalBlock block) => Padding(
    key: const ValueKey<String>('plus.image.original.blocked'),
    padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Icon(Icons.info_outline, size: 16, color: FlowMicColors.t3),
        const SizedBox(width: 9),
        Expanded(
          child: Text(
            widget.strings.imageOriginalUnavailable(block),
            style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
          ),
        ),
      ],
    ),
  );

  Widget _originalTick(bool on) {
    final AppStrings strings = widget.strings;
    // A SEPARATE tap target from the tile itself: tapping 「send the original
    // image」 must
    // set the option, never open the picker with the previous value.
    return InkWell(
            key: const ValueKey<String>('plus.image.original'),
            onTap: on ? () => setState(() => _original = !_original) : null,
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(
                    _original
                        ? Icons.check_box_outlined
                        : Icons.check_box_outline_blank,
                    size: 17,
                    color: !on
                        ? FlowMicColors.t3
                        : _original
                        ? FlowMicColors.brand
                        : FlowMicColors.t3,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          strings.imageOriginal,
                          style: TextStyle(
                            color: on ? FlowMicColors.t1 : FlowMicColors.t2,
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 1),
                        Text(
                          strings.imageOriginalHint,
                          style: TextStyle(
                            color: FlowMicColors.t3,
                            fontSize: 10.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}
