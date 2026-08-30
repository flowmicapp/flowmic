// Machine-readable → localized-sentence mapping for `bridge.ts`'s
// `fetchAutostartState` / `setAutostartEnabled` failure `reason`.
//
// 🔴 2026-08-30 owner defect sweep: those two functions used to bake a raw
// Chinese sentence ('autostart_state 返回了无法识别的形状' / 'autostart_set 返回了
// 无法识别的形状') straight into `reason` for the one failure they themselves
// diagnose (`asAutostartInfo` rejecting the IPC payload's shape).
// SettingsPage.vue's `autostartError` then appended that verbatim after an
// already-localized prefix (`S.set_prefs_autostart_read_failed` /
// `_failed`), so every UI locale but zh-CN showed one Chinese clause stitched
// onto an otherwise-translated sentence.
//
// `reason` also carries GENUINELY free-form text — 'bridge unavailable (not
// running under Tauri)' and `e.message` from a thrown Tauri IPC error — which
// this bridge has no way to translate (an OS/Tauri message is not ours to
// re-word) and is not in scope here. Only the two cases bridge.ts itself
// puts into words became CODES; everything else still reads as whatever text
// it already was.
//
// Same split as `INJECT_FAIL_REASON` (lib/strings/capsule.ts): a table maps
// known codes to a localized sentence, and an UNMAPPED code — including any
// of the free-form reasons above, and any future bridge.ts code this table
// hasn't caught up with yet — falls through to the raw string. Rendering a
// bare code/message is safer than inventing prose for a failure this layer
// does not actually understand (卡 L7's rule).
import { S } from './strings';

/** GETTER reading `S` (not a snapshot at import time) for the same reason
 *  PROFESSION_LABELS / PACK_LABELS do: a literal table would freeze whatever
 *  locale was active when this module first loaded and never follow a
 *  later `setLocale`. Both known codes land on ONE sentence — the prefix
 *  already in front of `reason` (`_read_failed` vs `_failed`) is what tells
 *  the read apart from the write; the shape-mismatch description itself is
 *  identical either way. */
const AUTOSTART_REASON: Record<string, () => string> = {
  autostart_state_unrecognised_shape: () => S.set_prefs_autostart_unrecognised_shape,
  autostart_set_unrecognised_shape: () => S.set_prefs_autostart_unrecognised_shape,
};

/** Map one `fetchAutostartState`/`setAutostartEnabled` `reason` to display
 *  text: a known code → its localized sentence; anything else (free-form
 *  bridge text, or a code this table does not (yet) know) → the input
 *  unchanged. */
export function describeAutostartReason(reason: string): string {
  const sentence = AUTOSTART_REASON[reason];
  return sentence !== undefined ? sentence() : reason;
}
