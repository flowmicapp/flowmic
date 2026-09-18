// VERBATIM MOVE out of tokens.dart (800-line cap — the next comment added
// there goes red; see verify/lint/file-size.mjs). This part carries the
// numeric scale tokens (kTranscriptBodySize, the NR-6 onboarding five, the
// speak-control trio) and the theme-resolution engine (AppThemeMode,
// FlowMicTheme, its platform-brightness observer) that the palettes in
// tokens_palette.dart read through `FlowMicTheme.isLight`. `part of`, not a
// standalone library, for the same reason every other split in this file
// family uses one: everything here and in the two sibling parts is one
// design-token surface, and every existing `import 'tokens.dart'` must keep
// resolving every name unchanged.
//
// 🔴 Diff discipline: the body below is byte-identical to what stood at
// tokens.dart:26-191 before the split. No rename, no reflow, no comment edit.
// Any other diff is a bug.

part of 'tokens.dart';


/// The transcript row's body size — the sentence the user actually reads word
/// by word, in `chat_message_tile.dart`.
///
/// 🔴 0.3.28: **13.5 → 15**, and it is the only base size that round moved
/// (owner 2026-08-23, reporting the transcript as too small on a small Apple
/// handset). Why this one:
///   · it is the product's content. Every other number on that row labels
///     something; this is the thing being labelled;
///   · 13.5 sat below both platforms' own body conventions — Material's
///     `bodyMedium` is 14, iOS HIG body is 17;
///   · smallest blast radius on that screen: the text wraps freely across the
///     bubble with no `maxLines`, so a larger size adds lines and cannot
///     squeeze a neighbour out.
///
/// ⚠️ The row's 10.5 META line was deliberately NOT raised with it. That is six
/// chips in one `Row` — the exact geometry that clipped a sentence to 「INJ…」
/// in 0.2.53 — and it needs a re-layout, not a bigger number. Anyone who wants
/// that line bigger has the five-rung tier ladder, which lifts everything at
/// once (`AppTextScale`, and it is what owner's report actually asked for).
///
/// ⚠️ This is ONE token, not the font-size SSOT. `text_scale_scope.dart`'s
/// header records that SSOT as an open debt across 256 `fontSize:` literals,
/// and it still is; this constant exists because the number needed a reason
/// attached to it, and `chat_message_tile.dart` is at its pinned size cap.
const double kTranscriptBodySize = 15;

// ── NR-6 · the first-run guide's five type sizes ─────────────────────────────
//
// SPEC-REF: docs/ui-design/2026-08-27-nr6-onboarding-visual-upgrade-design.md §7
//
// 🔴 THESE FIVE ARE NOT A FONT-SIZE SSOT, AND THE DESIGN SAYS SO IN §7.1. The
// SSOT does not exist (text_scale_scope.dart's header books it as an open debt
// across 256 `fontSize:` literals) and this round does not create one. What
// these buy is the same thing [kTranscriptBodySize] bought: the number stops
// being a bare literal in a build method and starts carrying the reason it is
// that number, so the next person who wants to change one can see what they
// are trading.
//
// 🔴 EACH SERVES THE GUIDE AND NOTHING ELSE — deliberately five constants
// rather than a shared ladder. A shared «body size» would make «make the
// guide's muted note smaller» and «make the transcript smaller» the same
// action, which is this repo's #1 shape (one value answering two questions).
// Values are byte-identical to the literals they replace: this is a rename,
// not a retune, and onboarding_typography_test.dart pins that.

/// Page title (`_title`). 19 is a heading tier above the 14 body and below the
/// 24 the OS text-scale ladder would reach at 1.3× — big enough to be read as
/// a title on a 360dp screen without pushing the illustration off-screen.
const double kOnboardingTitleSize = 19;

/// Body paragraph (`_body`, un-muted). Material's `bodyMedium`. The three
/// pages' sentences run 50%+ longer in en/ko than zh, and this is the largest
/// size at which the longest of them still lays out unclipped at 360dp under
/// the Ahem ruler (onboarding_first_run_test.dart group ⑧).
const double kOnboardingBodySize = 14;

/// The muted supplementary note (`_body(muted: true)` — the code-expiry line
/// and the same-network line). One step under the body so the eye reads it as
/// a footnote to the paragraph above rather than a second paragraph.
const double kOnboardingBodyMutedSize = 12.5;

/// The two footer buttons' label (`_button`). Half a point over the body: the
/// label is a short verb phrase inside a 46dp box, so it can afford the extra
/// weight the body cannot.
const double kOnboardingButtonLabelSize = 14.5;

/// The top-right «skip» label. The smallest tier on the page ON PURPOSE — it
/// is an escape hatch, not an invitation, and owner ruling 7-1 asked for it to
/// exist, not to compete with «next».
const double kOnboardingSkipSize = 13;

/// The one height the two hold-to-talk controls share — the main [PttBar] and
/// the edit sheet's [SheetAppendButton].
///
/// SPEC-REF: docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md
///   §2.2 (option B) / §5.2
///
/// 🔴 IT IS A TOKEN BECAUSE THE TWO NUMBERS MUST NOT BE ABLE TO DRIFT APART.
/// The whole point of NR-4 (d)'s option B is that the in-sheet append button
/// reads as the SAME control as the bar it covers — same height, same fill,
/// same radius, same glyph size. Written as two literals (60 and 60), the next
/// person to retune the bar retunes half of that promise and nothing goes red.
/// The bar's own constraint is a FLOOR (`minHeight`), not a fixed size, and it
/// stays one: card U12's reason (at 1.5–2.0× OS text scale the label wraps and
/// a hard height clips it) is untouched by sharing the number.
const double kSpeakControlHeight = 60;

/// The corner radius those same two controls share (`.ptt{border-radius:17px}`
/// in the Plan A′ mock). Same reason as [kSpeakControlHeight]: the append
/// button used to draw 13, which was the dashed-outline face's radius, and the
/// two are one face now.
const double kSpeakControlRadius = 17;

/// The mic glyph tier inside those two controls. Was 17 on the bar and 15 in
/// the sheet; option B makes them one.
const double kSpeakControlGlyphSize = 17;

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
