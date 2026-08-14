// The **instrument** for 「can the user read this sentence」, one copy for
// the whole repo.
//
// ── Why it must exist (W5a adversarial review P1-1, 2026-08-07, [measured]) ─
//
// The 0.2.53 law is right: any acceptance of 「can the user read it」must
// land the assertion on the **rendered result**, never on `Text.data`. This
// window wrote five files to that law, and every one of them called
// `RenderParagraph.didExceedMaxLines`.
//
// 🔴 And `didExceedMaxLines` is **always false** when `maxLines == null` —
// it forwards the engine's `ui.Paragraph.didExceedMaxLines`; with no line
// cap there is no such thing as 「exceeded the line count」. So those
// assertions are **structurally unable to fail**: they are not reporting
// 「not clipped」, they are reporting 「the instrument is not hooked up」.
// Measured: `onboarding_view.dart` / `image_preview_page.dart` each have
// `maxLines` only once, in a **comment**; `instance_guide_sheet.dart` /
// `pairing_guide_view.dart` / `connection_diagnostics_sheet.dart` have it
// **zero times**.
//
// 🔴 What is more worth remembering is how it survived: this window
// **itself** wrote this failure shape down verbatim in the 「instrument
// self-check」of `diagnostics_engine_section_test.dart` (「if every Text
// in this file leaves maxLines unset, every case will pass for free
// because the instrument always reads false」), then self-checked with a
// **separately invented broken structure** (Row + Flexible + maxLines:1
// + ellipsis) — that proves 「the instrument can read a number when
// mounted on someone else」, **not 「this product stretch has the
// instrument hooked up」**. What sits between those two things is
// exactly this defect. ⇒ **An instrument self-check must check 「is
// THIS reading a real reading」, not 「can this instrument move in the
// lab」.**
//
// ── Rule: read the instrument first, then the product ─────────────────────
//
// The criterion is decided by the **product's own structure**, not picked
// by the test:
//   · The product set `maxLines` ⇒ `didExceedMaxLines` is a real reading,
//     assert it directly;
//   · The product did not set `maxLines` ⇒ assert instead the four
//     **falsifiable** facts of 「why it cannot be clipped」, see
//     [expectParagraphLegible]. Previously those four lived only in
//     production comments, and **a comment that asserts behaviour
//     elsewhere must either give a greppable anchor or be nailed by a
//     test** (anti-façade ④) — they are now nailed here.
//
// ⚠️ **Ruler**: `flutter_test` uses the Ahem placeholder font; every
// glyph is a full-em square, much wider than a real font. So 「it fits
// under Ahem ⇒ it fits on a real device」holds, **the converse does
// not**. This file answers only the 「will it be clipped」direction; do
// not use it to argue 「a given sentence happens to fit on a real
// device」.
//
// ⚠️ This file is entirely a [unit-test] instrument; **it cannot prove
// a real device**.

import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, LocaleScript;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

/// The narrow screen on a real phone. **The one number that is the
/// product criterion**, one copy for the whole repo.
const double kPhoneWidthDp = 360;

/// Under the Ahem ruler, how many px 「a 360dp real-device screen」is
/// worth for this language.
///
/// ── What it replaced, and why it had to be replaced ──────────────────────
///
/// Previously this was written `locale == AppLocale.en ? 640 : 360`
/// (this file's caller `wp5_rendered_copy_legibility_test.dart:314`,
/// and a same-shape site in `compose_preview_strip_test`). That ternary
/// is **right in spirit**: Ahem paints every glyph as a full-em square,
/// so Latin is inflated to about twice the width, and asserting it at
/// 360 is a **false red**. It is wrong in **form** — the criterion hangs
/// on a hardcoded language. After de / fr / es / ru were added on
/// 2026-08-14, those four languages fall straight onto the 360 branch
/// and produce a wall of false reds; and 「widen the threshold until it
/// stops being red」equals deleting this test (0.2.51 §3: a reverse
/// control that picked the wrong direction is worse than no reverse
/// control).
///
/// ── Where the factors come from ──────────────────────────────────────────
///
/// `packages/protocol/src/locales.ts`'s `SCRIPT_WIDTH_FACTOR`, mirrored
/// value-for-value. It is compiled by **ISO 15924 script**, not by
/// language, which is exactly why it is worth something: **adding a
/// language does not change one word of this file** (it arrives with
/// its own `script`, and that script already has a ruler), **adding a
/// script fails to compile on the spot** (the switch below is
/// exhaustive, no `_ =>` fallback). That split of labour is honest: a
/// new language in the same script really does inherit a grounded
/// ruler, and a new script really does need someone to measure once.
///
/// ⚠️ **A mirror, not an export** — nothing nails this table to the
/// registry. If the two drift, the only thing that will speak is the
/// self-check at the bottom of this file (the caller of
/// [debugScriptFactor]), and it can only prove this file is
/// self-consistent, not that it matches the TS copy. Written here in
/// the open, not hidden.
///
/// ── 🔴 The property it did not change, and must not change ───────────────
///
/// Ahem's asymmetry still holds: **「not clipped under this budget」⇒
/// 「will not be clipped on a real device」; the converse does not**.
/// It still holds because every factor is **smaller** than that
/// script's real inflation under Ahem: Latin/Cyrillic measured ~2.0
/// and here take 1.8; Hangul's inflation comes only from inter-word
/// spaces (Hangul syllables are already full-width), ~1.10 and here
/// take 1.05; Han/Kana have no spaces, Ahem and a real font are the
/// same width, 1.0 is the exact value. ⇒ the budget is uniformly
/// **tight**.
///
/// ⚠️ **These are ruler units, not a product promise.** Do not use any
/// return value of this function to argue 「this sentence happens to
/// fit on a real-device 360dp」— it only answers 「is there a layout
/// that is not clipped」.
double ahemWidthBudget(AppLocale locale) =>
    ahemWidthFor(kPhoneWidthDp, locale);

/// The arbitrary-width version of [ahemWidthBudget]: **under Ahem, how
/// many px a [productDp]-wide real-device screen is worth for this
/// language**.
///
/// Used at measure points that were never 360 — `recording_panel_widget_test.dart`
/// measures a 600dp panel, `mic_permission_denial_widget_test.dart`
/// measures a 411dp device.
/// 🔴 Each of them previously wrote a **hardcoded** number, and that
/// number carried two things at once: 「how wide a screen the product
/// must work on」and 「how much Ahem inflated this language」. Once
/// nine languages arrived, the second thing forks by language, so that
/// number had to be written separately — **after the split, the first
/// thing is still the same product criterion** (600dp is 600dp); only
/// the ruler changed.
double ahemWidthFor(double productDp, AppLocale locale) =>
    productDp * debugScriptFactor(locale.script);

/// [ahemWidthFor], but **must not be narrower than [floorPx]**.
///
/// 🔴 Why this is needed instead of using [ahemWidthFor] directly. Five
/// render cases previously wrote a **hand-picked, language-blind**
/// width (600 or 700), and their comments all explained that number
/// verbatim: 「411dp cannot hold the English status capsule, because
/// Ahem inflates 24 glyphs into 24 full-em squares」— **that is
/// exactly what `SCRIPT_WIDTH_FACTOR` is saying**, only back then one
/// language needed it, so it was folded into a constant.
///
/// Swapping directly to `ahemWidthFor(411, locale)` would do half
/// right and half wrong: Latin/Cyrillic get the 740 they are owed
/// (= a 411dp real-device screen), while **Han/Kana would drop from
/// 600 back to 411** — that is not 「the ruler was fixed」, that is
/// **incidentally tightening the criterion of four languages that are
/// green today**, and tightening a passing assertion is a change
/// nobody asked for this round and nobody has verified.
/// ⇒ the old number stays as a **floor**: nobody gets narrower;
/// scripts that need more get more, by script.
///
/// ⚠️ Cost written in the open: Han/Kana therefore keep that 46%
/// slack (600 instead of 411). It is the **conservative** direction
/// (wider ⇒ easier to pass ⇒ no false red), but it does leave this
/// case for those four languages looser than 「a 411dp real device」.
/// Tightening is another card, and it must bring its own measured
/// reverse control.
double ahemWidthAtLeast(double floorPx, double productDp, AppLocale locale) {
  final double budget = ahemWidthFor(productDp, locale);
  return budget > floorPx ? budget : floorPx;
}

/// The factor half of [ahemWidthBudget], exposed separately for one
/// reason only: so the self-check can read it. Production criteria
/// should use [ahemWidthBudget]; do not multiply it yourself.
double debugScriptFactor(LocaleScript script) => switch (script) {
  // Han and Kana: no inter-word spaces; glyphs are already near
  // full-em ⇒ Ahem and a real font are same-direction, same width.
  LocaleScript.hans => 1.0,
  LocaleScript.hant => 1.0,
  LocaleScript.jpan => 1.0,
  // Hangul: syllables are full-width; what gets inflated is only
  // inter-word space (Korean is **written with word breaks**, which
  // is exactly its boundary with Chinese/Japanese, and the same
  // reason [textWordCount] puts Hangul on the space branch).
  LocaleScript.kore => 1.05,
  // Latin and Cyrillic: German compounds and Russian inflection are
  // the long tail, so both share the widest band, rather than each
  // taking a number nobody can explain the origin of.
  LocaleScript.latn => 1.8,
  LocaleScript.cyrl => 1.8,
};

/// How wide this text is on one line when **unconstrained**. Compare
/// that to the box it actually got, and you know whether it was
/// squeezed off — harder than eyeballing a screenshot, and more
/// stable than asserting some pixel constant (it follows the copy
/// when the copy changes).
///
/// Use it on things that **must fit on one line** (machine names,
/// titles, buttons); do not use it on body text that wraps: the
/// body's unconstrained single-line width is supposed to exceed the
/// screen — that is why it wraps.
///
/// 🔴 **It cannot see `MediaQuery.textScaler`** (measured:
/// `text_scale_test.dart`'s header-bar case went red on the medium
/// step — painted 190.0px, while this function computed 202.5px from
/// the unscaled style; **what is red is the instrument, not the
/// product**). Wherever the tree under test has text-size scaling,
/// use [neededWidthOf] instead: it asks how wide **that already-laid-
/// out paragraph itself** needs to be, and scaling is naturally
/// included.
double intrinsicWidthOf(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

/// How wide this **already-laid-out** paragraph would be if it did
/// not wrap. Compare that to `tester.getSize(...).width` and you have
/// 「was it squeezed off」, and text-size scaling, theme fonts, and
/// per-span styles inside `TextSpan` are all already in — none of
/// which [intrinsicWidthOf] can see.
double neededWidthOf(RenderParagraph p) =>
    p.getMaxIntrinsicWidth(double.infinity);

/// The criterion for 「the user can read this text」, landed on the
/// **rendered result**.
///
/// See [expectParagraphLegible]: the branch is decided by the
/// structure of the text under test itself.
void expectLegible(WidgetTester tester, Finder finder, {String? reason}) {
  expectParagraphLegible(
    tester.renderObject<RenderParagraph>(finder),
    reason: reason,
  );
}

/// The render-object version of [expectLegible], for callers that need
/// to walk the whole tree themselves.
///
/// **Has `maxLines`** ⇒ `didExceedMaxLines` is a real reading; assert
/// it is false.
///
/// **No `maxLines`** ⇒ that reading is always false and has zero
/// proving power; assert these instead:
///   ① `softWrap` is true, ② `overflow` is not `ellipsis` — these two
///      **together are** the entire reason 「this text physically
///      cannot be clipped」; previously that lived only in a
///      production comment;
///   ③ it was laid out at a **finite width** — a layout done at
///      infinite width proves nothing about 「does it fit」, and ④
///      would pass for free on that kind of tree. This is ④'s
///      positive control;
///   ④ 🔴 **This function's only measurement: when the needed width
///      exceeds the box, it must actually have used more than one
///      line.** 「A stretch of text needs 769px and only got 100px,
///      yet still occupies one line」= those 669px were painted
///      outside the box, the user cannot read them — and
///      `didExceedMaxLines` reports **false** in this cell.
///      This machine [measured] three sets of readings (Ahem,
///      fontSize 14, single-line height 20):
///        · Chinese body in a 330px box: needW=498.75 ⇒ wrapped to
///          40px high (2 lines) ✅
///        · A 64-character bare identifier stuffed into 120px:
///          needW=983.25 ⇒ 180px high (9 lines) ✅
///        · **`softWrap: false`, 100px box**: needW=769.5 and height
///          **still 20px**
///          ⇒ this case goes red, while `didExceedMaxLines` reports
///          false. **That is the cell it catches.**
///
/// 🔴 **Three things deliberately not written, and why** (all same-
/// family traps of this instrument, all confirmed by measurement):
///   · **Do not assert `size.width <= constraints.maxWidth`**:
///     `RenderParagraph` itself does
///     `size = constraints.constrain(textSize)`, so that inequality
///     **always holds** — the same always-true sentence as
///     `didExceedMaxLines`.
///   · **Do not assert `getMinIntrinsicWidth <= the box`** (the first
///     version wrote this and was falsified on the spot by Chinese):
///     SkParagraph's intrinsic width is computed by **word**, and a
///     Chinese sentence has no spaces ⇒ a Chinese sentence laid out
///     just fine in a 330px box reports a **498.75px 「longest
///     word」**, going red on itself.
///   · **Do not assert 「painted glyphs did not exceed the box」**
///     (the second version wrote this and was falsified by English
///     body): `getBoxesForSelection` also counts the glyph box of
///     **the trailing space**, and it lands just outside the wrap
///     point ⇒ four otherwise perfectly normal English bodies each
///     exceeded by 0.25～12.4px.
///     That version incidentally measured a risk I thought existed:
///     stuffing a 64-character bare identifier into a 120px box, the
///     engine **hard-breaks between glyphs** (painted to 114.1 < 120)
///     ⇒ **when `softWrap` is true, it cannot be clipped
///     horizontally at all**, which is exactly the courage these
///     pages have for leaving `maxLines` unset, and why this
///     function's measurement lands on 「did it wrap」rather than
///     「did it paint outside」.
///
/// ⚠️ **It only covers the horizontal.** Being cut vertically by an
/// ancestor (stuffed into a fixed-height container) is not this
/// function's job; it belongs to the caller's
/// `expect(tester.takeException(), isNull)` — overflow throws. Saying
/// so is better than letting people think it covers everything.
void expectParagraphLegible(RenderParagraph p, {String? reason}) {
  final String tail = reason == null ? '' : '（$reason）';
  final String head = _excerpt(p);

  if (p.maxLines != null) {
    expect(
      p.didExceedMaxLines,
      isFalse,
      reason: 'clipped by maxLines=${p.maxLines}: $head$tail',
    );
    return;
  }

  expect(
    p.softWrap,
    isTrue,
    reason: 'softWrap=false and no maxLines ⇒ the whole stretch is crushed onto one line, the overflow paints outside the box, '
        'and didExceedMaxLines is still false: $head$tail',
  );
  expect(
    p.overflow,
    isNot(TextOverflow.ellipsis),
    reason: 'has ellipsis but no maxLines: $head$tail',
  );
  final double box = p.constraints.maxWidth;
  expect(
    box.isFinite,
    isTrue,
    reason: 'this text was laid out at infinite width ⇒ it proved nothing about 「does it fit」: $head$tail',
  );

  final double needed = neededWidthOf(p);
  if (needed <= box + 0.5) return; // fits on one line; nothing clip-able
  final double oneLine = p.getMaxIntrinsicHeight(double.infinity);
  expect(
    p.size.height,
    greaterThan(oneLine * 1.5),
    reason: 'this text needs ${needed.toStringAsFixed(1)}px to lay out, only got '
        '${box.toStringAsFixed(1)}px, **yet still occupies only one line**'
        ' (height ${p.size.height.toStringAsFixed(1)}px ≈ one line ${oneLine.toStringAsFixed(1)}px)'
        ' ⇒ the overflow stretch is painted outside the box, the user cannot read it, and didExceedMaxLines reports false: '
        '$head$tail',
  );
}

/// Put the start of this text in the failure message — a red that does
/// not say which sentence it is costs the next person ten minutes to
/// find (`page_guides_test.dart`'s header-bar case paid this tuition
/// once, measured).
String _excerpt(RenderParagraph p) {
  final String plain = p.text.toPlainText();
  return plain.length <= 28 ? plain : '${plain.substring(0, 28)}…';
}
