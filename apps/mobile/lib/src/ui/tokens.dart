// SPEC-REF:
//   docs/ui-design/demo/mobile.html :root custom properties (58f44c3 — the
//     frozen visual contract). The DARK palette below keeps those EXACT
//     hex/rgba values; the widgets must not invent colours.
//   CLAUDE.md red line: UI does NOT follow OS locale (strings are zh-CN here;
//     i18n is WP-R3-3).
//
// Design tokens — a 1:1 Dart mirror of the demo's CSS variables so a reviewer
// can diff colour-by-colour. No new dependency; plain Flutter Color/TextStyle.
//
// V2-07.3 (2026-07-28): switchable-theme skeleton. Every colour now exists as
// a (dark, light) pair; `FlowMicColors.x` resolves the pair through the global
// [FlowMicTheme] state. Default stays DARK and pixel-identical to the frozen
// demo — this change is a refactor, not a redesign.
// V2-07.4 (2026-07-28): the selector is now WIRED — [FlowMicTheme] holds the
// tri-state [AppThemeMode] (default follow-system / 跟随系统), resolves it against the platform
// brightness, and keeps re-resolving on every later OS flip (see
// [FlowMicTheme.init]). The colour getters still only care about the resolved
// [Brightness]; they did not change.

// 2026-08-01: was `package:flutter/widgets.dart`. `ChannelBadge` below needs
// `Icons` (Material's icon font), which `widgets.dart` does not export — `material.dart`
// is a superset (all of widgets.dart plus Material), so this is additive, not a
// downgrade of what this file can do.
import 'package:flutter/material.dart';

/// The tri-state theme choice shown in Settings → Preferences → Theme
/// (设置 → 偏好 → 主题).
///
/// `system` means follow-system (跟随系统): the resolved brightness tracks the OS light/dark
/// setting LIVE, not once at boot. This is the default. (The LANGUAGE setting
/// is the opposite ruling — it never follows the OS. Do not conflate the two.)
enum AppThemeMode { system, light, dark }

/// Global theme state: the user's tri-state [mode] plus the resolved
/// [brightness] the colour getters below actually read.
///
/// [brightness] is a [ValueNotifier] so the app root can rebuild on change
/// (main.dart listens). Production code narrows it through [setMode];
/// assigning `brightness.value` directly stays legal as the test seam
/// (theme_tokens_test.dart pins the palettes through it).
class FlowMicTheme {
  const FlowMicTheme._();

  static AppThemeMode _mode = AppThemeMode.system;
  static AppThemeMode get mode => _mode;

  static final ValueNotifier<Brightness> brightness =
      ValueNotifier<Brightness>(Brightness.dark);

  static bool get isLight => brightness.value == Brightness.light;

  static bool _observing = false;

  /// Apply the user's explicit choice and re-resolve [brightness] immediately.
  static void setMode(AppThemeMode next) {
    _mode = next;
    _resolve();
  }

  /// Boot wiring (main.dart, before runApp): resolve once from the CURRENT
  /// platform brightness, then register a binding observer so every LATER OS
  /// flip re-resolves live. Idempotent — the observer is registered at most
  /// once for the process's lifetime (it is global state like this class).
  static void init() {
    _resolve();
    if (_observing) return;
    _observing = true;
    WidgetsBinding.instance.addObserver(_PlatformBrightnessObserver());
  }

  static void _resolve() {
    // Read through the BINDING's dispatcher, not PlatformDispatcher.instance:
    // in widget tests that is the TestPlatformDispatcher honouring
    // platformBrightnessTestValue; in production it IS the real dispatcher.
    // Callers (setMode / init) only run with a binding up — app runtime or
    // tests; the palette-pinning unit tests assign brightness.value directly.
    brightness.value = switch (_mode) {
      AppThemeMode.light => Brightness.light,
      AppThemeMode.dark => Brightness.dark,
      AppThemeMode.system =>
        WidgetsBinding.instance.platformDispatcher.platformBrightness,
    };
  }
}

/// Re-resolves the theme on an OS light/dark flip. Registered exactly once by
/// [FlowMicTheme.init]. A binding observer (not the single-slot
/// `PlatformDispatcher.onPlatformBrightnessChanged`) so the framework's own
/// dispatch to MediaQuery et al. is never displaced.
class _PlatformBrightnessObserver extends WidgetsBindingObserver {
  @override
  void didChangePlatformBrightness() => FlowMicTheme._resolve();
}

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
  // surfaces
  static const Color canvas = Color(0xFF0B0D14);
  static const Color body = Color(0xFF06080F);
  static const Color surface = Color(0xFF12151F);
  static const Color surface2 = Color(0xFF181C2B);
  static const Color line = Color(0xFF232839);
  // text
  static const Color t1 = Color(0xFFE6E9F2);
  static const Color t2 = Color(0xFF9AA1B5);
  static const Color t3 = Color(0xFF5C6377);

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

/// Off-white base text style; every widget layers on top of this.
/// (Getter, not const: the colour must resolve per-read against the theme.)
TextStyle get kBaseText => TextStyle(
  color: FlowMicColors.t1,
  fontSize: 14,
  height: 1.5,
);

// ── 2026-08-01 channel visual identity (owner: colour+icon combination, must
//    NOT rely on colour alone; one definition,
//    unified across the whole product / 颜色+图标组合，不能只靠颜色；一处定义，
//    全产品统一) ──────────────────────────────────────────────────────────────
//
// DEDICATED tokens, not aliases onto FlowMicColors.teal/brand: those two roles are
// frozen for OTHER reasons (teal = inject/lan colour family broadly, brand = the
// primary indigo used across buttons/links) and are free to retune independently of
// what a channel badge needs. Aliasing would let a future retune of the general
// palette silently drag the channel identity along with it — the opposite of what
// "one definition" is protecting.
//
// apps/desktop/src/styles/tokens.css's `--channel-lan-ink` / `--channel-lan-soft` /
// `--channel-cloud-ink` / `--channel-cloud-soft` carry the BYTE-IDENTICAL hex, pair
// for pair, in both themes — grep both files' literals to audit drift:
//
//   role         | light     | dark      | desktop var
//   lan  ink     | #0F766E   | #2DD4BF   | --channel-lan-ink
//   lan  soft    | #E6FAF7   | #12302C   | --channel-lan-soft
//   cloud ink    | #4F46E5   | #818CF8   | --channel-cloud-ink
//   cloud soft   | #EEF0FE   | #262A4E   | --channel-cloud-soft
//
// (Contrast-verified the same way theme_tokens_test.dart verifies the rest of this
// file's palette: every ink/soft pair clears the 4.5:1 AA bar in both themes.)
class FlowMicChannelColors {
  const FlowMicChannelColors._();

  static Color get lanInk =>
      FlowMicTheme.isLight ? const Color(0xFF0F766E) : const Color(0xFF2DD4BF);
  static Color get lanSoft =>
      FlowMicTheme.isLight ? const Color(0xFFE6FAF7) : const Color(0xFF12302C);
  static Color get cloudInk =>
      FlowMicTheme.isLight ? const Color(0xFF4F46E5) : const Color(0xFF818CF8);
  static Color get cloudSoft =>
      FlowMicTheme.isLight ? const Color(0xFFEEF0FE) : const Color(0xFF262A4E);
}

/// REQ-12-10 — stable PC-row identity lanes (hashed from `pc_machine_uid`).
/// Deliberately neither channel indigo nor notes amber — those answer different
/// questions (transport vs light-notes). Soft fills keep the same hue at ~13% α.
class FlowMicMachineLaneColors {
  const FlowMicMachineLaneColors._();

  static const List<Color> ink = <Color>[
    Color(0xFFC2410C), // orange
    Color(0xFF6D28D9), // violet
    Color(0xFFBE185D), // rose
    Color(0xFF4D7C0F), // olive
  ];

  static const List<Color> soft = <Color>[
    Color(0x22C2410C),
    Color(0x226D28D9),
    Color(0x22BE185D),
    Color(0x224D7C0F),
  ];
}

/// The ONE channel badge every screen consumes (chat_header.dart,
/// connections_page.dart, connection_diagnostics_sheet.dart used to each draw their
/// own copy of this pill — 2026-08-01 channel-identity survey found three). Takes a
/// plain `bool cloud` rather than `ServerChannel` on purpose: tokens.dart is a pure
/// design-token file (no session/business-logic imports), and every call site already
/// has a `ServerChannel` or an equivalent boolean in hand to pass in.
///
/// Icon + colour TOGETHER (owner: colour+icon combination, must not rely on
/// colour alone / 颜色+图标组合，不能只靠颜色) — `Icons.wifi` (concentric
/// arcs) vs `Icons.cloud_outlined` (a cloud outline) are two REAL different
/// silhouettes, not one glyph recoloured; both read in grayscale and at small size.
/// `Icons.cloud_outlined` is the SAME icon connections_page.dart's leading-icon
/// avatar already uses for a cloud entry — reusing it here rather than picking a new
/// glyph keeps "cloud" meaning one shape across the whole app, not two.
class ChannelBadge extends StatelessWidget {
  const ChannelBadge({super.key, required this.label, required this.cloud});

  final String label;
  final bool cloud;

  @override
  Widget build(BuildContext context) {
    final Color ink = cloud ? FlowMicChannelColors.cloudInk : FlowMicChannelColors.lanInk;
    final Color soft = cloud ? FlowMicChannelColors.cloudSoft : FlowMicChannelColors.lanSoft;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: soft, borderRadius: BorderRadius.circular(99)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(cloud ? Icons.cloud_outlined : Icons.wifi, size: 11, color: ink),
          const SizedBox(width: 3),
          Text(
            label,
            style: TextStyle(color: ink, fontSize: 10, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

// ── WP8 · Plan A′ dock + unified edit sheet palette (2026-08-14) ─────────────
//
// Every literal below is transcribed from the design mock
//   docs/FlowMic 转录页三方案交付/FlowMic 转录页 · 三方案交付.dc.html
// whose `.ph{…}` / `.ph.dk{…}` rules ARE the light and dark columns — grep that
// file for `.ph{--bg:` and `.ph.dk{--bg:` and diff variable by variable. The
// same table is restated in the visual-fidelity contract
//   docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §1
// along with the ruling that produced it: the mock beats every existing
// convention of this app. That ruling is not a style preference — WP7's dock
// was rejected precisely for carrying the app's conventions over instead of the
// mock's values.

/// Plan A′ dock + unified edit sheet palette.
///
/// 🔴 DELIBERATELY SEPARATE from [FlowMicColors] rather than a retune of it.
/// The owner's 2026-08-14 scope narrowing keeps the TOP BAR and the TIMELINE
/// on the legacy palette and requires them to render byte-identically after
/// this package (contract §0 D7–D9 / §3). Those two surfaces read
/// `FlowMicColors`, so moving any of ITS values to the mock's would repaint
/// exactly what must not move. Only new dock/sheet widgets read this class.
///
/// Where the two palettes happen to agree (`pri` dark #818CF8 is today's
/// [FlowMicDarkColors.brand]; `rec` dark #F87171 is its `red`) the value is
/// still written out as its own literal. That is the same reasoning
/// [FlowMicChannelColors] above states for holding its own copies: an alias
/// would let a future retune of the general palette silently drag the mock's
/// dock along with it, which is the opposite of what "the mock is the spec"
/// is protecting.
///
/// Resolution follows [FlowMicChannelColors]: static getters over
/// `FlowMicTheme.isLight` with inline const pairs. Four roles are
/// theme-INVARIANT (`processing` / `recordOnly` / `doneFlash` / `segShadow`) —
/// each comes from a single unconditional site in the design files (three CSS
/// rules that have no `.dk` companion, plus the prototype's `pttBg='#16A34A'`,
/// which sits in no theme branch at all), so they return one const rather than
/// a ternary between two identical literals. They stay getters anyway so
/// callers never have to know which roles are invariant, and
/// `test/dock_tokens_test.dart` pins the invariance so it cannot silently
/// become a two-value token.
class FlowMicDockColors {
  const FlowMicDockColors._();

  /// Mock `--bg`. Inside the dock's scope this is not a "page" colour: it fills
  /// the PC-key GROUP container (contract §2: 「bg = page bg (not panel)」) and
  /// the AI pill faces in the sheet — both must read one step BEHIND the panel
  /// they sit on.
  static Color get bg =>
      FlowMicTheme.isLight ? const Color(0xFFF7F7FA) : const Color(0xFF131318);

  /// Mock `--panel`. Dock surface, sheet surface, each PC key panel, and the
  /// ACTIVE segment of the mode control (`.sgi.on{background:var(--panel)}`).
  static Color get panel =>
      FlowMicTheme.isLight ? const Color(0xFFFFFFFF) : const Color(0xFF1B1B23);

  /// Mock `--ink` — primary text.
  static Color get ink =>
      FlowMicTheme.isLight ? const Color(0xFF1C1B22) : const Color(0xFFECEAF4);

  /// Mock `--sub` — secondary text (inactive segments, key labels, captions,
  /// the sheet header row, the `↑ 上滑取消` ("↑ swipe up to cancel") hint).
  static Color get sub =>
      FlowMicTheme.isLight ? const Color(0xFF716E7E) : const Color(0xFF9895A8);

  /// Mock `--line` — 1dp hairline borders, and the sheet handle's fill.
  static Color get line =>
      FlowMicTheme.isLight ? const Color(0xFFE5E4EC) : const Color(0xFF2B2A37);

  /// Mock `--pri` — brand. PTT idle face, the deliver button, the policy chip,
  /// the append button's dashed border.
  static Color get pri =>
      FlowMicTheme.isLight ? const Color(0xFF4F46E5) : const Color(0xFF818CF8);

  /// Mock `--chipbg` — the segmented control's container, the `+` button fill,
  /// and the disabled PTT face.
  static Color get chipbg =>
      FlowMicTheme.isLight ? const Color(0xFFEFEEF6) : const Color(0xFF26252F);

  /// Label ink ON a `pri`-filled surface.
  ///
  /// Not white in both themes, unlike [FlowMicColors.onBrandInk]: the dark mock
  /// frames write the near-black page colour onto the indigo faces explicitly —
  /// `<div class="ptt" style="color:#131318">` (A-D1) and
  /// `<div class="pbtn" style="color:#131318">投递 ➤</div>` (A-D3) — which is
  /// contract §1's last row 「PTT label on pri (dark) = #131318」. Light keeps
  /// white (6.29:1 on #4F46E5; the dark pairing is 6.21:1 on #818CF8).
  static Color get onPri =>
      FlowMicTheme.isLight ? const Color(0xFFFFFFFF) : const Color(0xFF131318);

  /// Recording red — the recording ACCENT: the amplitude bars (`.ab`), the
  /// `m:ss` timer, the live dot, and the sheet's appending face. It lightens to
  /// #F87171 in dark because every one of those sits ON a dark surface, where
  /// #DC2626 goes muddy.
  ///
  /// ⚠️ HISTORY, KEPT: this token used to carry the PTT recording FILL too, and
  /// its dark value came from contract §1's table rather than from a `.dk`
  /// override — the mock's `.ptt.rec{background:#DC2626}` has no dark variant,
  /// while the dark frames DO recolour the bars and the live dot inline to
  /// #F87171 (A-D2). The contract collapsed both into one token at #F87171 for
  /// dark, and that discrepancy was filed rather than silently resolved.
  /// ✅ RESOLVED (WP8 VF-2 follow-up) by splitting the fill out into [recFill]:
  /// one token per question. The reason it had to be split rather than argued
  /// about is measurable — white on #F87171 is **2.77:1**, which fails even the
  /// 3:1 large-text bar, and the PTT label is white 17sp/700 on that fill.
  /// ⇒ ONE VALUE, ONE QUESTION: `rec` answers 「what colour marks recording ON
  /// a surface」, [recFill] answers 「what colour IS the recording surface」.
  static Color get rec =>
      FlowMicTheme.isLight ? const Color(0xFFDC2626) : const Color(0xFFF87171);

  /// The PTT recording bar's FILL — `.ptt.rec{background:#DC2626}`.
  ///
  /// THEME-INVARIANT, and that is the mock read literally rather than a
  /// simplification: `.ptt.rec` has NO `.dk` override, so the dark board A-D2
  /// renders the recording bar at #DC2626 exactly like the light one. Only the
  /// accents around it (`.ab` bars, the timer, the live dot) are recoloured
  /// inline to #F87171 there — see [rec].
  ///
  /// ⚠️ MEASURED, and this is why the split exists at all: the bar's label is
  /// white 17sp/700, and white on #DC2626 is **4.83:1 in BOTH themes** (clears
  /// the 4.5:1 AA body bar), where white on #F87171 was **2.77:1** — under even
  /// the 3:1 large-text bar. Following the mock literally is what fixes it;
  /// no value here was retuned away from the design.
  static Color get recFill => const Color(0xFFDC2626);

  /// Amber PTT face while the final transcript is being produced
  /// (`.ptt.amb{background:#D97706}`). THEME-INVARIANT: the mock has no `.dk`
  /// override for it, and contract §1 lists the same value in both columns.
  static Color get processing => const Color(0xFFD97706);

  /// The mock's `.ptt.gry{background:#8B8996}`. Since 0.3.1 this is the
  /// swipe-cancel ARMED overlay and the record-only header dot (A-11) ONLY —
  /// the record-only PTT face itself moved to [notedSoft]/[notedInk] (owner
  /// 2026-08-15: a live control must not wear the app's 「off」 grey; see
  /// there). THEME-INVARIANT for the same reason as [processing].
  static Color get recordOnly => const Color(0xFF8B8996);

  /// P5 (0.3.1, owner 2026-08-15: 「轻记录…说话的按钮默认是灰色的…看起来是
  /// 不能用的状态」/ the record-only talk button looks disabled). The mock's
  /// `.ptt.gry{#8B8996}` put a LIVE control in the same grey vocabulary the
  /// dock reserves for the genuinely dead face ([chipbg]+[sub]) — a named
  /// deviation from the WP8 VF-2 fidelity contract, ordered by the owner.
  ///
  /// The replacement stays in the hue this app already gives light-notes
  /// facts (plus_panel paints `noPcTarget` amber; timeline noted markers are
  /// amber): a translucent amber wash with the theme's AA-verified amber ink
  /// ([FlowMicColors.amber] — #92400E light / #FBBF24 dark, both pinned by
  /// theme_tokens_test). Distinct from every other face by construction:
  /// solid pri (idle), solid #DC2626 (recording), solid #D97706 (processing),
  /// pale grey (disabled). MODE identity is still carried by the label +
  /// header dot; the fill only answers 「can this be pressed」 — yes.
  static Color get notedSoft => FlowMicColors.amberSoft;

  /// Ink + border for the [notedSoft] face — see there.
  static Color get notedInk => FlowMicColors.amber;

  /// Green flash face after a delivery lands. Its source is the interactive
  /// prototype rather than the static boards —
  /// `docs/FlowMic 转录页三方案交付/FlowMic 原型 · 对话流.dc.html`:
  /// `if(P==='flash'){pttBg='#16A34A';…}` — which is what contract §1 means by
  /// 「#16A34A (prototype)」. THEME-INVARIANT there too.
  static Color get doneFlash => const Color(0xFF16A34A);

  /// Restore-original strip fill (sheet, after an AI transform). Light is the
  /// mock's inline `background:#F0FDFA` in frame A-08 (editing surface · 3 AI
  /// chips + restore original text / 编辑面·AI三枚+恢复原文).
  ///
  /// ⚠️ DARK IS IMPLEMENTER-PICKED — the mock draws this strip only in the
  /// light frames, and contract §1 says merely 「keep teal family legible」.
  /// #12302C is not invented: it is this app's already-proven dark teal soft,
  /// byte-identical to [FlowMicChannelColors.lanSoft]'s dark value, whose
  /// legibility against #2DD4BF theme_tokens_test.dart already pins at the
  /// 4.5:1 AA bar (measured 7.60:1).
  static Color get restoreBg =>
      FlowMicTheme.isLight ? const Color(0xFFF0FDFA) : const Color(0xFF12302C);

  /// Restore strip border. Light is the same A-08 inline's `1px solid #99F6E4`.
  ///
  /// ⚠️ DARK IS IMPLEMENTER-PICKED — teal-900 #134E4A, one step deeper than the
  /// [restoreBg] fill so the strip keeps an edge on the dark panel. A border is
  /// not text, so it carries no contrast bar; it is pinned by the test only so
  /// a later retune has to be deliberate.
  static Color get restoreBorder =>
      FlowMicTheme.isLight ? const Color(0xFF99F6E4) : const Color(0xFF134E4A);

  /// Restore strip text (`恢复原文` / "restore original text"). Light is that same A-08 inline's
  /// `color:#0E9384`. DARK is contract §1's `ok` dark column (#2DD4BF) rather
  /// than a measurement of this strip — the mock never draws the strip in dark;
  /// #2DD4BF is what its dark frames put on the `.ok` class elsewhere.
  ///
  /// This is NOT the `ok` token: `ok` answers 「did it deliver / inject」 on the
  /// timeline, which is out of scope and keeps `FlowMicColors`. Same hex today,
  /// different question — see the not-landed note under this class.
  ///
  /// ⚠️ MEASURED, NOT ASSERTED: the LIGHT pair (#0E9384 on #F0FDFA) is 3.64:1 —
  /// under the 4.5:1 AA body bar, over the 3:1 large/AA-large bar. That is the
  /// mock's own value and this card has no authority to retune it, so it is
  /// recorded here rather than quietly "fixed"; the dark pair is 7.60:1.
  static Color get restoreText =>
      FlowMicTheme.isLight ? const Color(0xFF0E9384) : const Color(0xFF2DD4BF);

  /// Wash behind the span that was just appended in the sheet — the mock's
  /// inline `background:#EEF2FF` on the appended `<span>` (A-07, and the same
  /// span in the prototype's live text).
  ///
  /// ⚠️ DARK IS IMPLEMENTER-PICKED — the mock only draws the wash in light.
  /// #262A4E is this app's proven dark indigo soft, byte-identical to
  /// [FlowMicChannelColors.cloudSoft]'s dark value; [ink] over it measures
  /// 11.58:1 (light: 15.28:1).
  static Color get appendHighlight =>
      FlowMicTheme.isLight ? const Color(0xFFEEF2FF) : const Color(0xFF262A4E);

  /// Lift under the ACTIVE segment of the mode control — the mock's
  /// `.sgi.on{…box-shadow:0 1px 3px rgba(0,0,0,.14)}`. `.14 × 255 ≈ 36 = 0x24`,
  /// the same alpha convention [FlowMicDarkColors.brandSoft] documents.
  ///
  /// THEME-INVARIANT: the mock declares this shadow once, and contract §1 ends
  /// with 「no heavier shadows in dark — hierarchy via panel/line」, so the dark
  /// segment lifts by exactly the same amount rather than more.
  static List<BoxShadow> get segShadow => const <BoxShadow>[
    BoxShadow(color: Color(0x24000000), blurRadius: 3, offset: Offset(0, 1)),
  ];

  /// Lift under the edit sheet. Light = the mock's
  /// `.sheet{…box-shadow:0 -10px 30px rgba(28,27,50,.14)}` (28,27,50 = #1C1B32,
  /// alpha 0x24); dark = the dark frame's inline
  /// `box-shadow:0 -10px 30px rgba(0,0,0,.5)` (alpha 0x80).
  ///
  /// Upward offset, not downward: the sheet rises from the bottom edge, so the
  /// shadow has to fall on the timeline ABOVE it. This is why it cannot reuse
  /// [FlowMicColors.floatShadow], whose two passes both push down.
  static List<BoxShadow> get sheetShadow => FlowMicTheme.isLight
      ? const <BoxShadow>[
          BoxShadow(color: Color(0x241C1B32), blurRadius: 30, offset: Offset(0, -10)),
        ]
      : const <BoxShadow>[
          BoxShadow(color: Color(0x80000000), blurRadius: 30, offset: Offset(0, -10)),
        ];
}

// DELIBERATELY NOT LANDED from contract §1 — recorded so nobody reads the gap as
// an oversight and re-adds them "for completeness":
//   * `ok` #0E9384/#2DD4BF — its only in-scope consumer is the restore strip,
//     which [FlowMicDockColors.restoreText] already carries. Its other consumer
//     (timeline delivery/injection status words) is out of scope this round and
//     keeps FlowMicColors.
//   * `warn` #B45309 and the errCard trio (#FFFBEB / #FDE68A / #92400E) — both
//     live on timeline / top-bar surfaces, which this package does not touch
//     (contract §0 ⛔ D7–D9, §3).
// This is the repo's #1 historic bug class in its cheapest form: a token defined
// with no consumer is a capability that exists only in the file that declares
// it. They land in the round that draws the surface that needs them.
