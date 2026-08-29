// The `<optgroup>` heading for a preset group — ONE definition, read by both
// engine pages (0.3.43, owner 2026-08-28; contract 06 §7.1 ②).
//
// 🔴 WHY THIS IS A MODULE AND NOT A TERNARY IN EACH SFC. LlmSettings.vue and
// SttSettings.vue render the same four headings over the same four group ids. Two
// copies is how the STT page ends up calling a section 「本地自托管」 while the LLM
// page calls it 「自托管」 — a difference no test would fail on and every user
// would read as two different kinds of thing. Same stance the repo already takes
// for the channel visual identity (one definition, a test that pins it).
//
// 🔴 IT IS A FUNCTION, NOT A TABLE BUILT AT MODULE LOAD. `S` is a reactive object
// whose contents are swapped in place by setLocale(); a `const LABELS = {cloud:
// S.preset_group_cloud, …}` would read every string once, at import time, and
// freeze the boot locale into the menu forever — the status.ts BADGES bug class
// this repo has already paid for. Called during render, it is tracked, and the
// headings change with the language like everything else.

import type { PresetGroup } from '@flowmic/protocol';
import { S } from './strings';

export function presetGroupLabel(group: PresetGroup): string {
  switch (group) {
    case 'builtin': return S.preset_group_builtin;
    case 'cloud':   return S.preset_group_cloud;
    case 'local':   return S.preset_group_local;
    case 'custom':  return S.preset_group_custom;
    // 🔴 NO `default:` ARM, ON PURPOSE. `PresetGroup` is a closed union, so a
    // new group added to the catalogue becomes a COMPILE error here — which is
    // the only mechanism that stops it shipping as a section with a blank
    // heading. A friendly `default: return group` would render the raw wire id
    // at the user, which is exactly defect ③ on this card, reintroduced one
    // layer down.
  }
}

/** Human name for an `LlmProtocol` wire value (defect ③).
 *
 *  ⚠️ THE VALUE STAYS THE ENUM. This translates the LABEL only — the `<option>`
 *  still carries `openai-compatible` / `anthropic`, because that string is what
 *  `llm.config.protocol` stores and what server-core's adapter switch reads.
 *  Renaming it would be a wire change wearing a copy change's clothes. */
export function llmProtocolLabel(protocol: string): string {
  return protocol === 'anthropic' ? S.llm_protocol_anthropic : S.llm_protocol_openai;
}
