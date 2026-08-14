// owner 2026-07-27: 「on phone/web/PC alike, double-tapping a picture opens a
// full-screen preview, and double-tapping again or pressing back closes the
// preview」.
// owner 2026-08-01 (RV-93): 「after double-tapping, a relatively larger picture
// should be previewable ... both sides have two sizes」.
//
// The phone's half. The PC and the console both draw an overlay; here it is a
// real ROUTE, because on Android the system back gesture is the primary way out
// of anything full-screen and a route gets that for free — an overlay would have
// to re-implement back handling and would sit wrong in the navigation stack.
//
// Three ways out, all of them obvious: double-tap the picture, tap the backdrop,
// or press back. A full-screen view you cannot leave is a trap, so the caption
// says so rather than relying on the user guessing.
//
// ── TWO SIZES, ONE VIEW (RV-93) ──────────────────────────────────────────────
//
// ⚠️⚠️ Correction: this header used to read 「The source is the SAME bounded 256 px
// preview the row renders — there is no original anywhere on this phone
// (ImageSendController drops the picked bytes after the emit)」. The second half
// stopped being true on 2026-08-01: the delivered bytes are kept (owner revoked
// 「delete on delivery success」), so this view now opens size B — the picture
// that actually went
// into the PC's focused window.
//
// [png] (the row's 256 px thumbnail) is still REQUIRED and is what paints first:
// it is already decoded, so the view appears on the same frame as the tap and
// never flashes empty. [full] then replaces it if and when it resolves. A null /
// failed [full] is a normal outcome (a pre-RV-93 row whose bytes were deleted by
// the old ruling), and the fallback is the thumbnail — 「only the small
// picture」 is a smaller
// picture, not a broken one, so nothing here reports an error.
//
// ⚠️⚠️ Correction (Card G-18, 2026-08-07) — the paragraph above is kept WORD
// FOR WORD
// because every clause of it is still true except the consequence it drew. It is
// right that a smaller picture is not a broken one and that there is no error to
// report. It was wrong that therefore nothing needed saying: 「whether to
// report an error」 was
// never the question, 「of these two sizes, which one are you looking at right
// now」 was — and this view
// answered it silently by upscaling a 256 px preview and presenting it exactly
// like the real thing. Two measured facts turn that from a cosmetic gap into the
// misreporting half of the fail-loud red line (never swallow, never overclaim):
//   · 「A pre-RV-93 row」 stopped being the only case. A lightweight-record
//     (origin:'cloud')
//     picture keeps ONLY the bounded thumbnail — image_send_controller.dart's
//     `_saveLocal` names that as a known gap in so many words, there is no
//     `rowImages.put(...)` on that path — so for that entire class of row [full]
//     is null STRUCTURALLY, on every open, forever, not as a degraded case.
//   · The honest sentence already existed AND was already being shown — to the
//     other user. AppStrings.imagePreviewNote 「256px preview, not the original」
//     rides on the
//     copy menu's sub-line and on the copy toast. So whoever pressed 「Copy」 was
//     told and whoever double-tapped was not. That asymmetry WAS the defect.
// ⇒ [previewOnlyNote] is rendered in both thumbnail-only branches, and it is
//   REQUIRED rather than optional on purpose: an optional one lets a call site
//   skip it and leaves the sentence unreachable in production while every test
//   stays green — 「a capability defined with nobody calling it」, this repo's
//   #1 historical defect class.
//   Required makes the COMPILER the wiring test.
// 🔴 THE CRITERION IS 「did a big picture actually arrive」, NEVER 「is this row
//   cloud-origin」. If lightweight-record later starts keeping originals, this
//   criterion
//   becomes correct by itself, while an `origin == 'cloud'` test would go on
//   printing a sentence that had quietly turned false. That is also why the
//   caller does not get a say: chat_flow_page hands over the STRING, this view
//   decides WHETHER — it is the only layer that can see how [full] resolved.
// ⚠️ 「the read has not finished yet」 is a THIRD state and it stays silent.
//   While the disk read is
//   pending we do not yet know which size the user is about to get, and printing
//   「not the original」 into that gap would be a sentence we would have to take
//   back one
//   frame later. Saying nothing until [full] is `done` is the only honest option.
//
// `filterQuality: none` on the FALLBACK keeps an enlarged thumbnail crisp-edged
// instead of a smeared upscale that reads as a broken render. The full picture
// is shown at default quality: it is real resolution, and pixelating it would
// make the good case look like the degraded one.

import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import 'tokens.dart';

class ImagePreviewPage extends StatelessWidget {
  const ImagePreviewPage({
    super.key,
    required this.png,
    required this.caption,
    required this.closeHint,
    required this.previewOnlyNote,
    this.full,
  });

  /// Already-decoded THUMBNAIL bytes — the caller passes what the row is
  /// showing, so the memoised decode is reused and opening the preview costs no
  /// second decode. Painted immediately; superseded by [full] when it arrives.
  final Uint8List png;

  /// RV-93 — the delivered picture (size B), resolved lazily.
  ///
  /// A Future rather than bytes because it is a disk read and the view must not
  /// wait for it before appearing. Created ONCE by [route] (never inside
  /// `build`, which would restart the read on every rebuild and could flicker
  /// between the two sizes). Null ⇒ this host offers no big picture at all.
  final Future<Uint8List?>? full;

  /// The row's descriptor (「🖼 PNG · 78 KB」).
  final String caption;

  /// Localised 「double-tap, tap the blank area, or press back to close」.
  final String closeHint;

  /// Localised `AppStrings.imagePreviewNote` — 「256px preview, not the original」.
  ///
  /// 🔴 Passed in ALREADY RESOLVED, and required. This widget has no route to
  /// `AppStrings`: there is no InheritedWidget for it anywhere in the app (grep
  /// InheritedWidget/InheritedNotifier — zero hits), and `Localizations.localeOf`
  /// is not merely unavailable but FORBIDDEN, because 「UI does not follow OS
  /// locale」 is a
  /// red line and this app's language comes from AppSettingsController alone.
  /// So the string can only come from the caller — while the DECISION of whether
  /// to show it stays here, where [full]'s outcome is visible. One value, one
  /// question, split across the seam that can actually answer each half.
  ///
  /// ⚠️ Do NOT let this go optional to spare a call site. It is shown only in the
  /// thumbnail-only branches, so a missing one is invisible in every test that
  /// does not specifically look for it — the exact shape that keeps a promise
  /// unkept while the suite stays green. See this file's header.
  final String previewOnlyNote;

  static Route<void> route({
    required Uint8List png,
    required String caption,
    required String closeHint,
    required String previewOnlyNote,
    Future<Uint8List?>? full,
  }) => PageRouteBuilder<void>(
    opaque: false,
    barrierColor: const Color(0xE60B1020),
    pageBuilder: (_, _, _) => ImagePreviewPage(
      png: png,
      caption: caption,
      closeHint: closeHint,
      previewOnlyNote: previewOnlyNote,
      full: full,
    ),
  );

  @override
  Widget build(BuildContext context) {
    // The backdrop is a SIBLING of the content, not its ancestor. It used to
    // wrap everything, which quietly broke the picture's own gestures: a
    // GestureDetector carrying both onTap and onDoubleTap must WAIT for the
    // double-tap window before resolving, and during that wait an ancestor's
    // plain onTap wins the arena — so a single tap on the image dismissed the
    // preview the user had just deliberately opened. As siblings they never
    // compete. (Caught by image_preview_widget_test's single-tap case.)
    return Stack(
      children: <Widget>[
        Positioned.fill(
          child: GestureDetector(
            onTap: () => Navigator.of(context).maybePop(),
            behavior: HitTestBehavior.opaque,
          ),
        ),
        Center(
          // 🔴 The FutureBuilder now wraps the WHOLE column, not just the
          // picture. It has to: the caption block below has to say 「what you
          // are looking at is the preview」 exactly when the picture above it is
          // the preview, and the only
          // place both facts are in scope at once is inside this builder.
          child: full == null
              // No big picture was offered for this row at all (a
              // lightweight-record row —
              // structurally one size). Known before the first frame, so this
              // branch never has to wait to be honest.
              ? _content(context, png, previewOnly: true)
              : FutureBuilder<Uint8List?>(
                  future: full,
                  builder: (_, AsyncSnapshot<Uint8List?> snap) {
                    final Uint8List? big = snap.data;
                    // No spinner, and that is deliberate: the thumbnail is a
                    // real picture of the same thing, so the wait has nothing to
                    // announce. A spinner over an image that is already visible
                    // reads as 「broken」.
                    final bool resolved =
                        snap.connectionState == ConnectionState.done;
                    final bool thumbnailOnly = big == null || big.isEmpty;
                    return _content(
                      context,
                      thumbnailOnly ? png : big,
                      // 🔴 Three states, not two. While the read is still in
                      // flight we are ALSO painting the thumbnail — but we do
                      // not yet know whether a big one is coming, so the note
                      // stays off. Printing it here would be a claim we would
                      // have to withdraw one frame later, and a sentence that
                      // appears and vanishes reads as a glitch rather than as
                      // information (F-5 is the same family).
                      previewOnly: resolved && thumbnailOnly,
                    );
                  },
                ),
        ),
      ],
    );
  }

  /// The picture and everything said about it. One builder for all three states
  /// so the caption block and the bytes above it can never disagree.
  Widget _content(
    BuildContext context,
    Uint8List bytes, {
    required bool previewOnly,
  }) => Column(
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      Flexible(
        child: GestureDetector(
          onDoubleTap: () => Navigator.of(context).maybePop(),
          child: _image(bytes, thumbnail: previewOnly),
        ),
      ),
      const SizedBox(height: 12),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Text(
          caption,
          textAlign: TextAlign.center,
          style: TextStyle(color: FlowMicColors.t1, fontSize: 13),
        ),
      ),
      if (previewOnly) ...<Widget>[
        const SizedBox(height: 4),
        Padding(
          // Same 24 px gutter and free wrapping as the caption: this sentence
          // has no maxLines and no ellipsis, so it cannot be cut down to three
          // letters the way the 0.2.53 meta-row defect was.
          //
          // 🔴 CORRECTION IN PLACE (2026-08-07, W5a adversarial review P1-1,
          // measured). The claim above is TRUE. What was false is what the test
          // did with it: `image_preview_note_wire_test.dart` proved it with
          // `didExceedMaxLines`, and that getter is ALWAYS false when there is
          // no `maxLines` — so the assertion could not fail, and this sentence
          // was in fact unguarded. The property is now pinned by
          // `test/support/legibility.dart` (`expectLegible`), which reads the
          // instrument before it reads the product: no `maxLines` ⇒ assert the
          // four things that make clipping impossible (softWrap, no ellipsis,
          // a finite width, and the longest UNBREAKABLE run still fitting the
          // box) rather than a reading that is structurally incapable of
          // reporting a defect.
          //
          // ⇒ anti-façade ④: a comment that asserts behaviour elsewhere needs a
          // greppable anchor or a test that can actually go red. This one had a
          // test, and the test was green for a reason unrelated to the claim.
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Text(
            previewOnlyNote,
            key: const ValueKey<String>('imagePreview.previewOnlyNote'),
            textAlign: TextAlign.center,
            style: TextStyle(color: FlowMicColors.t2, fontSize: 12),
          ),
        ),
      ],
      const SizedBox(height: 4),
      Text(
        closeHint,
        style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
      ),
    ],
  );

  /// One renderer for both sizes, so the two can never drift into two different
  /// fits or two different error behaviours. `gaplessPlayback` is what makes the
  /// thumbnail→full swap a replacement rather than a blink to empty.
  Widget _image(Uint8List bytes, {required bool thumbnail}) => Image.memory(
    bytes,
    fit: BoxFit.contain,
    gaplessPlayback: true,
    filterQuality: thumbnail ? FilterQuality.none : FilterQuality.medium,
    errorBuilder: (_, _, _) => const SizedBox.shrink(),
  );
}
