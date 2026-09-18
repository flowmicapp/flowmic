// VERBATIM MOVE out of tokens.dart (800-line cap — see tokens_scale.dart's
// header for the full reasoning; same split, same `part of`). This part
// carries the theme palettes: FlowMicDarkColors (the frozen demo contract),
// FlowMicLightColors (its light retune, contrast-verified in
// theme_tokens_test.dart), and FlowMicColors (the theme-resolving entry point
// every widget actually reads).
//
// 🔴 Diff discipline: the body below is byte-identical to what stood at
// tokens.dart:192-442 before the split. No rename, no reflow, no comment edit.
// Any other diff is a bug.

part of 'tokens.dart';


/// DARK palette — the frozen demo contract (58f44c3), values UNCHANGED.
///
/// These constants are the anchor for the "dark stays pixel-identical"
/// criterion: `test/theme_tokens_test.dart` pins every getter against these
/// exact literals. Never retune them here; a retune is a redesign.
class FlowMicDarkColors {
  const FlowMicDarkColors._();

  // brand
  static const Color brand = Color(0xFF818CF8);
  static const Color brandDeep = Color(0xFF4F46E5);
  static const Color brandSoft = Color(0x24818CF8); // rgba(129,140,248,.14)
  // teal (inject / lan)
  static const Color teal = Color(0xFF2DD4BF);
  static const Color tealSoft = Color(0x212DD4BF); // rgba(45,212,191,.13)
  // amber (cached / organize)
  static const Color amber = Color(0xFFFBBF24);
  static const Color amberSoft = Color(0x21FBBF24);
  // red (failed / recording)
  static const Color red = Color(0xFFF87171);
  static const Color redSoft = Color(0x24F87171); // rgba(248,113,113,.14)
  // green (injected)
  static const Color green = Color(0xFF4ADE80);
  static const Color greenSoft = Color(0x214ADE80);
  // slate (noted — the fifth badge colour, master-plan §4.0 D)
  static const Color slate = Color(0xFF94A3B8);
  static const Color slateSoft = Color(0x2994A3B8); // rgba(148,163,184,.16)

  // Banner faces (ui/banner_slot.dart). Tokens rather than the literals that
  // used to sit in that file — its `_BannerFace.of` records what one hard-coded
  // face cost. These five are that retune's values, byte for byte.
  static const Color bannerBlockingFill = Color(0x59F87171);
  static const Color bannerBlockingBorder = Color(0xB3F87171);
  static const Color bannerBlockingInk = Color(0xFFFFF1F2);
  static const Color bannerDegradedBorder = Color(0x4DFBBF24);
  static const Color bannerInfoBorder = Color(0x4D818CF8);
  // surfaces
  static const Color canvas = Color(0xFF0B0D14);
  static const Color body = Color(0xFF06080F);
  static const Color surface = Color(0xFF12151F);
  static const Color surface2 = Color(0xFF181C2B);
  static const Color line = Color(0xFF232839);
  // text
  static const Color t1 = Color(0xFFE6E9F2);
  static const Color t2 = Color(0xFF9AA1B5);

  /// NR-23 2026-09-13: was #5C6377 — 2.83/3.04/3.24/3.34:1 on surface2/
  /// surface/canvas/body, all under AA. Now 4.61/4.96/5.28/5.45, same hue.
  static const Color t3 = Color(0xFF7E859B);

  // PTT gradients
  static const List<Color> pttIdle = <Color>[Color(0xFF5B54E8), Color(0xFF7C74F2)];
  static const List<Color> pttRec = <Color>[Color(0xFFDC4C4C), Color(0xFFF87171)];
  static const List<Color> pttNoted = <Color>[Color(0xFF4B5163), Color(0xFF5C6377)];

  // R6 T-5d: the two FSM faces the demo never drew (PROCESSING amber (琥珀) /
  // JUST_DONE green-check (绿勾)). Deliberately SOLID and reusing the existing
  // amber/green tokens — no
  // hex outside the frozen demo palette is invented here.
  static const Color pttProcessingBg = amber;
  static const Color pttDoneBg = green;

  /// Ink for the amber/green PTT faces — the near-black canvas colour, because
  /// white-on-amber fails contrast.
  static const Color pttOnLightInk = body;

  /// Ink on a FILLED BRAND surface (the primary/confirm button face).
  ///
  /// 🔴 White in BOTH palettes, and that is a contrast fact rather than an
  /// oversight: `brandDeep`'s own note above records 「white ink on it: 8.3:1」,
  /// and the light palette's §note (§注) says 「a deep brand button with white ink is
  /// the normal affordance」. It is a NAMED token instead of `Colors.white`
  /// because the widget must not have to know which of those two facts it is
  /// relying on — if a future retune darkens the brand face far enough to need
  /// dark ink, this one line changes and every filled brand button follows.
  /// (P-7 first-launch onboarding (首开引导) 2026-08-07: added when the guide's primary button was the
  /// first new code to reach for `Colors.white` — new code should not spend
  /// the token lint's ALLOWLIST budget.)
  static const Color onBrandInk = Color(0xFFFFFFFF);

  /// Shadow under a FLOATING surface (owner ruling #4, 2026-08-11: the FB-8
  /// confirm card now floats over the timeline's bottom edge — the first
  /// surface in this app that hovers rather than sits in flow, and the first
  /// caller of any shadow). On the near-black canvas a soft grey shadow reads
  /// as nothing, so this one is dense black at two radii: the wide/low pass
  /// separates the card from the canvas, the tight pass draws its lift edge.
  static const List<BoxShadow> floatShadow = <BoxShadow>[
    BoxShadow(color: Color(0x8A000000), blurRadius: 24, offset: Offset(0, 8)),
    BoxShadow(color: Color(0x59000000), blurRadius: 6, offset: Offset(0, 2)),
  ];

  /// Scrim over the timeline while the edit sheet is up (PA-4, Plan A′ §5-1).
  /// Dense black at ~54% — the same base the floatShadow uses on this canvas,
  /// for the same reason: grey washes read as nothing on near-black.
  static const Color scrim = Color(0x8A000000);
}

/// LIGHT palette — same 27 semantic roles, retuned for a near-white canvas.
///
/// Design rules (verified programmatically in theme_tokens_test.dart):
///  * SAME hue family per role (brand stays indigo, recording stays red, …) —
///    a light theme that re-colors "recording" to teal would be a different
///    product, not a light version of this one.
///  * Text roles t1/t2/t3 keep ≥ 4.5:1 against canvas/surface/surface2 (WCAG
///    AA body text); the semantic text colours (brand/teal/amber/red/green/
///    slate, used for status words like 「已注入」("injected")「未注入」("not
///    injected") on light fills)
///    keep ≥ 4.5:1 against surface. Achieving that on white forces every
///    accent several Tailwind shades darker than its dark-theme counterpart
///    (e.g. amber-400 #FBBF24 → amber-800 #92400E: bright amber on white is
///    ~2:1 and can NEVER pass, so "amber" deepens rather than washes out).
///  * The soft fills keep the dark version's exact alpha (13/14/16%) — only
///    the RGB base follows the accent, so badge contrast math stays uniform.
///  * body keeps the dark version's DIRECTION (one step deeper than canvas);
///    it currently has no direct caller beyond the pttOnLightInk alias.
class FlowMicLightColors {
  const FlowMicLightColors._();

  // brand (indigo-600/700 — the dark version's indigo-400/600, stepped down)
  static const Color brand = Color(0xFF4F46E5); // 6.3:1 on surface
  static const Color brandDeep = Color(0xFF4338CA); // white ink on it: 8.3:1
  static const Color brandSoft = Color(0x244F46E5); // same .14 alpha
  // teal (teal-700; teal-600 #0D9488 would be only 3.75:1 on white)
  static const Color teal = Color(0xFF0F766E); // 5.4:1 on surface
  static const Color tealSoft = Color(0x210F766E); // same .13 alpha
  // amber (amber-800 — see class doc; nothing brighter can pass on white)
  static const Color amber = Color(0xFF92400E); // 7.1:1 on surface
  static const Color amberSoft = Color(0x2192400E); // same .13 alpha
  // red (red-700; red-600 #DC2626 = 4.8:1 passes on white but drops under
  // 4.5:1 on its own redSoft fill, which the delete banner pairs it with)
  static const Color red = Color(0xFFB91C1C); // 6.5:1 on surface
  static const Color redSoft = Color(0x24B91C1C); // same .14 alpha
  // green (green-800; green-700 #15803D lands at 4.47:1 on its greenSoft
  // badge fill — a hair under AA, so one more shade down)
  static const Color green = Color(0xFF166534); // 7.1:1 on surface
  static const Color greenSoft = Color(0x21166534); // same .13 alpha
  // slate (slate-600)
  static const Color slate = Color(0xFF475569); // 7.6:1 on surface
  static const Color slateSoft = Color(0x29475569); // same .16 alpha

  // Banner faces. Fill and border are the dark values verbatim: over this
  // canvas `0x59F87171` composites to #F5C7CA, the same visible red strip. Only
  // the INK moves, and it has to — near-white on #F5C7CA is 1.37:1, red-900 is
  // 6.64:1 (and 10.0:1 on `surface`, where the near-white dot was 1.10:1).
  static const Color bannerBlockingFill = FlowMicDarkColors.bannerBlockingFill;
  static const Color bannerBlockingBorder = FlowMicDarkColors.bannerBlockingBorder;
  static const Color bannerBlockingInk = Color(0xFF7F1D1D); // red-900
  static const Color bannerDegradedBorder = Color(0x4D92400E);
  static const Color bannerInfoBorder = Color(0x4D4F46E5);
  // surfaces — white card on a faintly cool page; surface2 stays one step
  // OFF white (input fills / chips), line is a hairline, not a text colour.
  static const Color canvas = Color(0xFFF4F5FA);
  static const Color body = Color(0xFFE8EAF2);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surface2 = Color(0xFFF0F1F7);
  static const Color line = Color(0xFFDDE1EC);
  // text (15.2 / 7.3 / 4.9 : 1 on canvas — all ≥ AA body)
  static const Color t1 = Color(0xFF1A1E2E);
  static const Color t2 = Color(0xFF4A5165);
  static const Color t3 = Color(0xFF646B7C);

  // PTT gradients. The two BRANDED action faces (idle indigo / recording red)
  // keep the dark values verbatim: their on-face ink is hard-coded white
  // (ptt_bar.dart), and a deep brand button with white ink is the normal
  // light-theme shape (Material FilledButton) — paling them would BOTH break
  // the white ink AND make "recording" less alarming.
  static const List<Color> pttIdle = FlowMicDarkColors.pttIdle;
  static const List<Color> pttRec = FlowMicDarkColors.pttRec;
  // noted is the exception: its ink is t1 (dark text in light mode), so the
  // face itself must go light — a muted grey pair, same "quiet" role.
  static const List<Color> pttNoted = <Color>[Color(0xFFD8DBE6), Color(0xFFC3C8D8)];

  // Same aliases as the dark palette: PROCESSING = amber, JUST_DONE = green.
  static const Color pttProcessingBg = amber;
  static const Color pttDoneBg = green;

  /// Ink for the amber/green PTT faces. The dark palette reuses `body`
  /// (near-black on bright amber); here the accents have deepened instead,
  /// so the ink inverts to white (7.1:1 on both faces).
  static const Color pttOnLightInk = Color(0xFFFFFFFF);

  /// Ink on a FILLED BRAND surface. Same value as the dark palette — see that
  /// one's note; the light palette's brand is `#4338CA` (brandDeep), which the
  /// header above records as carrying white ink at 8.3:1.
  static const Color onBrandInk = Color(0xFFFFFFFF);

  /// Shadow under a FLOATING surface — same two-pass shape as the dark token,
  /// retuned for a white card on a near-white canvas: dense black there would
  /// read as a hole, so the base follows t1 (the slate ink) at low alpha, the
  /// standard Material-on-light direction.
  static const List<BoxShadow> floatShadow = <BoxShadow>[
    BoxShadow(color: Color(0x2E1A1E2E), blurRadius: 24, offset: Offset(0, 8)),
    BoxShadow(color: Color(0x1F1A1E2E), blurRadius: 6, offset: Offset(0, 2)),
  ];

  /// Scrim over the timeline while the edit sheet is up. The slate ink at ~38%
  /// — the same base as this palette's floatShadow, denser because a scrim has
  /// to read as 「the page stepped back」, not as a shadow.
  static const Color scrim = Color(0x611A1E2E);
}

/// Theme-resolving entry point — the ONLY name callers know.
///
/// `FlowMicColors.x` used to be `static const`; it is now a static getter
/// over the active palette. That is why ~80 call sites that wrote
/// `const TextStyle(color: FlowMicColors.t1 …)` had to drop `const`: Dart
/// const expressions require compile-time values, and a runtime-switchable
/// colour cannot be one. Dropping `const` is the ENTIRE caller-side change —
/// values are identical, only const-canonicalization is lost.
class FlowMicColors {
  const FlowMicColors._();

  static Color get brand => FlowMicTheme.isLight ? FlowMicLightColors.brand : FlowMicDarkColors.brand;
  static Color get brandDeep => FlowMicTheme.isLight ? FlowMicLightColors.brandDeep : FlowMicDarkColors.brandDeep;
  static Color get brandSoft => FlowMicTheme.isLight ? FlowMicLightColors.brandSoft : FlowMicDarkColors.brandSoft;
  static Color get teal => FlowMicTheme.isLight ? FlowMicLightColors.teal : FlowMicDarkColors.teal;
  static Color get tealSoft => FlowMicTheme.isLight ? FlowMicLightColors.tealSoft : FlowMicDarkColors.tealSoft;
  static Color get amber => FlowMicTheme.isLight ? FlowMicLightColors.amber : FlowMicDarkColors.amber;
  static Color get amberSoft => FlowMicTheme.isLight ? FlowMicLightColors.amberSoft : FlowMicDarkColors.amberSoft;
  static Color get red => FlowMicTheme.isLight ? FlowMicLightColors.red : FlowMicDarkColors.red;
  static Color get redSoft => FlowMicTheme.isLight ? FlowMicLightColors.redSoft : FlowMicDarkColors.redSoft;
  static Color get green => FlowMicTheme.isLight ? FlowMicLightColors.green : FlowMicDarkColors.green;
  static Color get greenSoft => FlowMicTheme.isLight ? FlowMicLightColors.greenSoft : FlowMicDarkColors.greenSoft;
  static Color get slate => FlowMicTheme.isLight ? FlowMicLightColors.slate : FlowMicDarkColors.slate;
  static Color get slateSoft => FlowMicTheme.isLight ? FlowMicLightColors.slateSoft : FlowMicDarkColors.slateSoft;
  static Color get bannerBlockingFill => FlowMicTheme.isLight ? FlowMicLightColors.bannerBlockingFill : FlowMicDarkColors.bannerBlockingFill;
  static Color get bannerBlockingBorder => FlowMicTheme.isLight ? FlowMicLightColors.bannerBlockingBorder : FlowMicDarkColors.bannerBlockingBorder;
  static Color get bannerBlockingInk => FlowMicTheme.isLight ? FlowMicLightColors.bannerBlockingInk : FlowMicDarkColors.bannerBlockingInk;
  static Color get bannerDegradedBorder => FlowMicTheme.isLight ? FlowMicLightColors.bannerDegradedBorder : FlowMicDarkColors.bannerDegradedBorder;
  static Color get bannerInfoBorder => FlowMicTheme.isLight ? FlowMicLightColors.bannerInfoBorder : FlowMicDarkColors.bannerInfoBorder;
  static Color get canvas => FlowMicTheme.isLight ? FlowMicLightColors.canvas : FlowMicDarkColors.canvas;
  static Color get body => FlowMicTheme.isLight ? FlowMicLightColors.body : FlowMicDarkColors.body;
  static Color get surface => FlowMicTheme.isLight ? FlowMicLightColors.surface : FlowMicDarkColors.surface;
  static Color get surface2 => FlowMicTheme.isLight ? FlowMicLightColors.surface2 : FlowMicDarkColors.surface2;
  static Color get line => FlowMicTheme.isLight ? FlowMicLightColors.line : FlowMicDarkColors.line;
  static Color get t1 => FlowMicTheme.isLight ? FlowMicLightColors.t1 : FlowMicDarkColors.t1;
  static Color get t2 => FlowMicTheme.isLight ? FlowMicLightColors.t2 : FlowMicDarkColors.t2;
  static Color get t3 => FlowMicTheme.isLight ? FlowMicLightColors.t3 : FlowMicDarkColors.t3;

  static List<Color> get pttIdle => FlowMicTheme.isLight ? FlowMicLightColors.pttIdle : FlowMicDarkColors.pttIdle;
  static List<Color> get pttRec => FlowMicTheme.isLight ? FlowMicLightColors.pttRec : FlowMicDarkColors.pttRec;
  static List<Color> get pttNoted => FlowMicTheme.isLight ? FlowMicLightColors.pttNoted : FlowMicDarkColors.pttNoted;

  static Color get pttProcessingBg => FlowMicTheme.isLight ? FlowMicLightColors.pttProcessingBg : FlowMicDarkColors.pttProcessingBg;
  static Color get pttDoneBg => FlowMicTheme.isLight ? FlowMicLightColors.pttDoneBg : FlowMicDarkColors.pttDoneBg;
  static Color get pttOnLightInk => FlowMicTheme.isLight ? FlowMicLightColors.pttOnLightInk : FlowMicDarkColors.pttOnLightInk;
  static Color get onBrandInk => FlowMicTheme.isLight ? FlowMicLightColors.onBrandInk : FlowMicDarkColors.onBrandInk;
  static List<BoxShadow> get floatShadow => FlowMicTheme.isLight ? FlowMicLightColors.floatShadow : FlowMicDarkColors.floatShadow;
  static Color get scrim => FlowMicTheme.isLight ? FlowMicLightColors.scrim : FlowMicDarkColors.scrim;
}
