// The phone's ONE reader of `capability.llm` — card LLM-NOTICE (2026-08-25).
//
// SPEC-REF:
//   packages/protocol/src/constants.ts SETTINGS_KEY_CAPABILITY_LLM — the fact:
//     `{ usable: boolean }`, 「能不能解出一个可用的语言模型」("can a usable
//     language model be resolved"), answered by the SAME resolver the server
//     defaults `stt.polish` from (settings.handler.ts withEffectiveDefaults).
//   apps/desktop/src/main-window/settings-model.ts (card POLISH-CFG) — the
//     desktop's reader, whose stance this file copies on purpose.
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §2-②
//
// ── WHY THIS IS ON THE WIRE AT ALL, AND WHY THE PHONE MUST NOT INFER IT ──────
// The server pushes this row on EVERY settings read (unconditional `out.push`),
// and until this card the phone read it nowhere: translate / organize were
// offered regardless and failed when picked (owner report). The tempting
// shortcut — 「is llm.config empty?」 — is wrong on the one deployment that
// matters most: the managed cloud default is env-gated and is NEVER a settings
// row, so a phone inferring from an empty endpoint would tell every working
// flowmic.app account that it has no model. The layer making the claim must
// hold the fact the claim needs (book 15 R11).
//
// ── THE THREE-VALUED ANSWER ──────────────────────────────────────────────────
// `value == null`  ⇒ the server has not said. Nothing is claimed either way
//                     (a cold start must not print 「不支持」 on a configured PC
//                     in the seconds before settings:list lands).
// `value == false` ⇒ the PC says no usable model: the mode note renders.
// `value == true`  ⇒ nothing renders.
// A malformed value leaves the last answer alone — 「cannot parse it」 is not
// 「the answer is false」 (the desktop's exact rule).
//
// 🔴 The key is referenced through the GENERATED constant, never a literal:
// verify/lint/settings-key-drift.mjs greps the constant NAME
// (SETTINGS_KEY_CAPABILITY_LLM) to prove the synthesised fact has a consumer,
// and the generated mirror carries that name in its doc comment.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../generated/flowmic_settings.g.dart';
import 'settings_client.dart';

class LlmCapability extends ValueNotifier<bool?> {
  LlmCapability({required SettingsClient settingsClient}) : super(null) {
    _sub = settingsClient.entries.listen(_onEntry);
  }

  StreamSubscription<SettingsEntry>? _sub;

  /// Pure adoption rule, exposed for the unit test: the previous answer, the
  /// incoming wire value, the answer to keep.
  @visibleForTesting
  static bool? adopt(bool? previous, Object? wire) {
    if (wire is! Map) return previous;
    final Object? usable = wire['usable'];
    return usable is bool ? usable : previous;
  }

  void _onEntry(SettingsEntry e) {
    if (e.key != FlowMicSettingsKeys.capabilityLlm) return;
    final bool? next = adopt(value, e.value);
    if (next != value) value = next;
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    _sub = null;
    super.dispose();
  }
}
