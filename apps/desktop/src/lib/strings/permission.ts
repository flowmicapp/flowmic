// String catalogue shard: OS permissions this app needs and cannot grant itself.
// Merged and exported by ../strings.ts.
//
// ── WHY THERE IS A SHARD FOR ONE PERMISSION ─────────────────────────────────
//
// Today it holds exactly one: macOS Accessibility. It is its own shard rather
// than a corner of `devices` or `settings` because the thing it names is not a
// feature of either page — it is a class of failure where **the product cannot
// do anything and the user can**, and the next member of that class (microphone,
// screen recording, input monitoring) will want to sit beside it, not inside
// whichever page happened to host the first one.
//
// ── WHAT THE COPY IS ALLOWED TO SAY (owner 2026-08-17) ──────────────────────
//
// 「要从用户能听得懂的原则上来展现，不要自说自话」 — say it the way the person
// reading it would say it. So: no code names, no `INJECT_NO_ACCESSIBILITY`, no
// 「辅助功能权限未授予」. It answers three questions in the order they are
// actually asked — what is wrong, what happened to what I already said, and
// what do I do — and it names the menu path in words next to the button,
// because a button that silently opens nothing leaves the reader with no second
// option.
//
// 🔴 `perm_ax_pane` IS A SECOND COPY OF A PATH THAT ALREADY EXISTS in the
// capsule's `INJECT_NO_ACCESSIBILITY` reason line, in all nine languages. Two
// copies of one fact is normally the defect this repo is loudest about — the
// justification is that the two sentences are genuinely different (a flashing
// reason on a failed utterance vs. a standing instruction) and splitting the
// existing one at a 「·」 would be worse. What makes it safe is not care:
// `permission-pane-path.test.ts` asserts, per locale, that this value occurs
// VERBATIM inside that reason line, so the two cannot drift apart without a
// test going red. (CLAUDE.md 反 façade ④: an assertion about copy elsewhere is
// either grep-anchored or pinned by a test — this is the second kind.)

import { shardCatalogue } from './shard';

export const PERMISSION_KEYS = [
  // macOS Accessibility. Shown only on macOS and only while the permission is
  // actually missing — see lib/accessibility-notice.ts for who is entitled to
  // render it, and why 「we could not ask」 renders nothing.
  //
  // The title says what does not work, not what is missing. 「没有辅助功能权限」
  // is a true sentence that answers a question nobody asked; the reader's
  // question is 「为什么我说的话没进到窗口里」.
  'perm_ax_title',
  // 🔴 The second half of this sentence is the load-bearing half: nothing was
  // lost. The delivery SUCCEEDED and only the injection did not happen — that
  // is exactly what `cached` means (15 册 §2.5e-4), and a banner that let the
  // reader believe their words were gone would be the same false alarm the
  // status red line exists to prevent.
  'perm_ax_body',
  // Label above the path. Separate from the path itself so that no locale has
  // to build one sentence out of two catalogue values in a fixed word order.
  'perm_ax_how',
  // The menu path, alone. Pinned to the capsule reason line by test — see the
  // header. Uses macOS's OWN wording per language, because the reader is
  // hunting for these exact words on their screen; a faithful translation that
  // does not match the menu is worse than no translation.
  'perm_ax_pane',
  'perm_ax_open',
  // Why there is no 「知道了」 button. The notice is state-style (owner
  // 2026-08-01, 提示生命周期匹配事实生命周期): it leaves by derivation when the
  // permission appears, so saying so removes the reader's urge to look for a
  // way to close it.
  'perm_ax_selfclears',
  // ⚠️ `open` returning ok only means the OS accepted the request. When it does
  // not, this points back at the path above rather than repeating it — the
  // instruction is already on screen.
  'perm_ax_open_failed',
] as const;

export const PERMISSION_STRINGS = shardCatalogue(PERMISSION_KEYS);
