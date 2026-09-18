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

// 800-line cap (this file sat exactly at 800/800 — the next comment added
// here would go red; see verify/lint/file-size.mjs). Split VERBATIM at the
// file's own section boundaries into three `part` files, each carrying one
// coherent family: scale/theme-engine, palettes, dock+channel tokens. Every
// existing `import 'tokens.dart'` keeps resolving every name unchanged — see
// each part's header for the detailed reasoning, following this file family's
// own established precedent (chat_message_tile.dart / chat_flow_page.dart).
part 'tokens_scale.dart';
part 'tokens_palette.dart';
part 'tokens_dock.dart';
