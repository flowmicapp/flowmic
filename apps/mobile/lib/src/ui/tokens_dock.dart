// VERBATIM MOVE out of tokens.dart (800-line cap — see tokens_scale.dart's
// header for the full reasoning; same split, same `part of`). This part
// carries kBaseText, the channel-identity tokens (FlowMicChannelColors,
// FlowMicMachineLaneColors, the ChannelBadge widget), and the Plan A′ dock +
// unified edit sheet palette (FlowMicDockColors) plus the trailing note on
// what contract §1 deliberately did not land.
//
// 🔴 Diff discipline: the body below is byte-identical to what stood at
// tokens.dart:443-800 before the split. No rename, no reflow, no comment edit.
// Any other diff is a bug.

part of 'tokens.dart';


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
  /// NR-23: light was #716E7E, 4.31:1 on chipbg; now 4.63. Dark unmoved.
  static Color get sub =>
      FlowMicTheme.isLight ? const Color(0xFF6C6979) : const Color(0xFF9895A8);

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

  // ── P5's `notedSoft` / `notedInk` LIVED HERE AND ARE GONE (P5b, same day) ──
  //
  // They were the amber wash + amber ink of the record-only PTT face. owner
  // 2026-08-15: 「土黄色有边框的按钮看起来与整个 APP 的设计语言不一致」, and the
  // face went back to the solid [pri]+[onPri] every other resting face uses
  // (ptt_bar.dart carries the full argument, including the trade it accepts).
  //
  // 🔴 REMOVED rather than left sitting here unused, on this repo's own
  // precedent (`INJECT_NO_RECEIPT`): a named thing with zero consumers is a
  // façade waiting for someone to answer a different question with it — and a
  // *colour* token is the easiest of all to reach for by name without reading
  // why it exists. The hue itself is not gone: [FlowMicColors.amber] /
  // [FlowMicColors.amberSoft] are the real tokens, still worn by the timeline's
  // noted markers and plus_panel's `noPcTarget`, which is where the light-notes
  // hue actually belongs.

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
