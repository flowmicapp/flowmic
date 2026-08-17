// S string catalogue shard: settings page (account / preferences / about /
// STT / dictionary / polish / two-pass refine / LLM / scenario cards / save
// receipts). Merged and exported by ../strings.ts.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en).
import { getLocale, type UiLocale } from './locale';
import { shardCatalogue } from './shard';
import type { SettingsMsg } from './contract';
import { SETTINGS_MSG_BY_LOCALE } from './generated/msg.g';

export const SETTINGS_KEYS = [
  // settings
  'settings_title',
  'settings_savehint',
  'set_nav_account',
  'set_nav_stt',
  'set_nav_llm',
  'set_nav_prefs',
  'set_nav_about',
  'set_account_title',
  'set_account_hint',
  'set_account_channel',
  'set_account_signed_out',
  'set_account_goto_devices',
  'set_prefs_title',
  // The original sentence read 「仅列出本机构已实现的偏好项；主题 / 界面语言未实现，
  // 不在此出现。」("only preferences this build has actually implemented are
  // listed; theme / UI language are not implemented and don't appear
  // here.") V2-07.8a implemented both of those, which instantly turned that
  // sentence from an honest disclosure into a stale lie, so it was changed
  // in the same batch as the implementation (the same category as the
  // mobile side's "only the most recent 100 are kept" footnote).
  'set_prefs_hint',
  'set_prefs_capsule_reset',
  'set_prefs_capsule_reset_hint',
  'set_prefs_capsule_reset_done',
  // V2-07.8a UI language + theme (the two new preference entries this card
  // ships; applied and persisted immediately on change).
  'set_prefs_language',
  // 🔴 The second half of `set_prefs_language_hint` was changed on
  // 2026-08-14, all four languages at once: the original text read
  // 「未选择时默认中文」("when nothing is selected the default is Chinese") /
  // "the default is Chinese," and owner ruled the same day that "a fresh
  // install starts in English" ⇒ from that moment on, that half was
  // **false, and printed right on the user's screen**. The first half
  // (「只认显式选择、从不读系统语言」, "recognizes only an explicit choice,
  // never reads the system language") hasn't changed a single character —
  // that red line hasn't moved; only which language it falls back to has.
  'set_prefs_language_hint',
  'set_prefs_theme',
  'set_prefs_theme_hint',
  'set_theme_system',
  'set_theme_light',
  'set_theme_dark',
  // 🔴 `set_lang_zh` / `set_lang_en` / `set_lang_ja` / `set_lang_ko` DELETED
  // (2026-08-14). Their note read 「语言名一律用自称（endonym），不随界面语言翻译，
  // 四份目录同值」("language names always use the endonym, never translated
  // by UI language, identical across all four catalogues") — and that note
  // is the argument for deleting them: a value that
  // is the same in every language is not a translated string, it is DATA about the
  // language. It now lives once per language in the registry
  // (packages/protocol/src/locales.ts `endonym`), read by both pickers through
  // LOCALE_ENDONYM. Four keys × nine languages = 36 copies of nine facts avoided.
  // V2-10 launch-on-startup — status is read from the system registry
  // (criterion 4), not a locally stored setting value.
  'set_prefs_autostart',
  'set_prefs_autostart_hint',
  'set_prefs_autostart_path',
  'set_prefs_autostart_dead',
  'set_prefs_autostart_failed',
  'set_prefs_autostart_read_failed',
  'set_about_title',
  'set_about_version',
  'set_about_log_title',
  'set_about_log_hint',
  'set_about_log_path',
  'set_about_log_open',
  'set_about_log_opening',
  'set_about_log_open_failed',
  'stt_title',
  'stt_hint',
  'stt_preset',
  'stt_routings',
  'stt_add_lang',
  'col_language',
  'col_engine',
  'col_endpoint',
  'dict_title',
  'dict_add',
  'polish_title',
  'polish_hint',
  'polish_toggle',
  // Card POLISH-CFG — the Chinese original is owner's word-for-word ruling
  // from 2026-08-09.
  //
  // 🔴 It answers the question the toggle itself can't answer. The toggle
  // only says "on / off"; once the server wires `stt.polish`'s default to
  // "is there a usable language model," an account with no model
  // configured sees a toggle that's "on" and does nothing — the exact
  // status-surface shape of the red line "don't describe something
  // unfinished as done." This sentence supplies the "why."
  //
  // ⚠️ A statement of fact, no imperative, no "go configure it in
  // settings": this layer only has `capability.llm`'s usable boolean, and
  // it doesn't know which one to configure (the locally self-hosted
  // `llm.config`? or the key behind the platform-managed env gate?) —
  // inventing a pointer would mean inventing a fact we don't have.
  // Precedent = `INJECT_PC_MISMATCH`'s copy discipline.
  // ⚠️ Also may not be written as an assertion of the default value, like
  // "off by default" / "on by default": that default lives in a constant
  // on the server, while this sentence is compiled into a binary the
  // server can't reach (data-flow-disclosure.test.ts's DEFAULT_VALUE_CLAIMS
  // exists precisely for this rule).
  'polish_no_llm',
  // ─── card C8: the correction-strength dial (owner ruling 2026-08-17) ───────
  //
  // 🔴 `polish_strength_hint` MUST STATE THE TRADE, and the trade is not a
  // quality ranking. `smooth` is not "better polish": it buys readability by
  // giving up the guarantee that the text on screen is word-for-word what was
  // said. Someone dictating a quotation, a name list, or evidence needs to be
  // able to read that off the screen and choose `strict`, so the sentence names
  // both halves ("easier to read, but no longer word-for-word") rather than
  // describing smooth as an improvement.
  //
  // ⚠️ Statement of fact, no imperative — the same copy discipline as
  // `polish_no_llm` above and `INJECT_PC_MISMATCH`. This layer knows what the
  // two values do; it does not know which one this user should want.
  //
  // ⚠️ Deliberately NOT a claim about the default. The effective value comes
  // from the server on every `settings:list`, and a sentence like "strict by
  // default" compiled into this binary is exactly the shape
  // data-flow-disclosure.test.ts's DEFAULT_VALUE_CLAIMS exists to catch.
  'polish_strength_label',
  'polish_strength_strict',
  'polish_strength_smooth',
  'polish_strength_hint',
  // owner 2026-07-26 ⑤ — where these settings actually apply. Stated on both
  // model sections because the alternative is a user tuning a dictionary here
  // and wondering why the phone-on-relay ignores it.
  'settings_scope_lan',
  // GA-14 two-pass refine
  'refine_title',
  'refine_hint',
  'refine_toggle',
  'refine_precondition',
  'llm_title',
  // 🔴 REQ-13-09 — 「AI 润色」("AI polish") IS ON THIS LIST, and leaving it off
  // was the exact shape the card is about: the two legs (speech vs language
  // model) told as one, or one of them silently riding on the other's page.
  //   · anchor: apps/server-core/src/engine/stt-factory.ts resolvePolishDep()
  //     resolves through the SAME resolveLlmConfigWithSource() the compose turn
  //     uses — polish has no configuration of its own, it consumes this one.
  // Before this line, the ONLY place the dependency was stated was
  // `polish_no_llm` on the OTHER page (Speech Recognition), which fires
  // after the fact and deliberately carries no imperative. So a reader on
  // this page could not learn that emptying these fields also turns polish off.
  // ⚠️ It names the FEATURE, not a value of its switch: whether polish is on
  // lives in a server-side default this binary cannot read (the same rule that
  // governs `stt_sub_off_default` and disclosure step ③). The literal is
  // 「AI 润色」 = `polish_title` verbatim, and polish-capability-notice.test.ts
  // asserts that equality per locale, so renaming the feature reddens a test
  // rather than orphaning this sentence.
  'llm_hint',
  'llm_preset',
  'llm_protocol',
  'llm_endpoint',
  'llm_model',
  'llm_apikey',
  'llm_apikey_ph',
  'scenario_title',
  'scenario_hint',
  'scenario_professions',
  'scenario_packs',
  'scenario_terms',
  'scenario_add_term',
  'scenario_term_ph',
  // V2-08 scenario-inference consent screen. All three sentences are
  // mandatory: what is collected / what is not collected / where it is sent.
  // RV-55 (owner 2026-07-30): the classifier answers 「is this INSIDE the
  // private ranges (RFC1918 + optional deployment overlay)?」, not 「is this
  // yours?」 and not 「is this a third party」. The two copy branches name the
  // standard ranges; D1 may flip which branch an address takes, but must not
  // rewrite these sentences or invent a third-party warning.
  'infer_title',
  'infer_hint',
  'infer_collect',
  'infer_no_screen',
  'infer_sends_to',
  // Why clarify "standard ranges": a bare 「是私网」("this is a private
  // network") hides the rule the other
  // branch has to explain; naming the ranges keeps both verdicts symmetric.
  'infer_dest_private',
  'infer_dest_unprovable',
  // 0.3.0 P3. Rendered ONLY on the unprovable branch, never on the private one.
  // It names the consequence the verdict above stops short of: an address the
  // classifier cannot place may belong to someone else, and if it does, this is
  // a real third party. Saying so is honest here and would be a lie one branch
  // over — which is exactly the line scenario-inference-consent.test.ts draws.
  'infer_dest_unprovable_note',
  'infer_endpoint_unset',
  'infer_toggle',
  'infer_off_note',
  'infer_widened_note',
  // V2-07.8a hardcoded-value extraction (originally inline Chinese in the
  // SttSettings / ScenarioCard templates).
  'stt_builtin_no_endpoint',
  'stt_engine_custom',
  'stt_sub_on',
  // 🔴 THE KEY NAME IS LEGACY — the copy no longer claims a default, and must
  // not go back to claiming one. This ONE string is rendered under THREE
  // different toggles (SttSettings.vue polish + refine, ScenarioInference.vue),
  // so 「off by default」 was a per-toggle fact riding on a shared label: it was
  // right for two of them and became wrong for polish the moment owner ruled
  // 「AI 改顺默认全开」("AI polish reordering defaults to fully on") (2026-08-08). A shared label can only carry what is true
  // of every toggle that shows it — here, that the switch is off right now.
  // Renaming the key would touch ScenarioInference.vue, which is not this
  // lane's file; the name is inert, the sentence was not.
  'stt_sub_off_default',
  'dict_no_alias',
  'scenario_term_exists',
  // V2-07.8a built-in term-pack labels (originally the PACK_LABELS
  // hardcoded table in settings-model.ts).
  'pack_tech_dev',
  'pack_medical',
  'pack_legal',
  'pack_finance',
  'pack_proper_noun',
  'pack_code_switch',
  'saved',
  'saved_local',
  // SETTINGS_SYNC_FAIL fail-loud note
  // RV-94 (B4-11): the other half of 「已存本地」("saved locally") — when the
  // reason it didn't sync is that the locally hosted server-core simply
  // never started, it isn't enough to just say "saved"; state clearly
  // "why" + "what to do."
  'saved_local_no_service_hint',
  'saving',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] See the note on the zh side: the original sentence claimed theme/UI
// language were unimplemented; changed in the same batch this card
// implemented them.
// [en] Endonyms: the same in all four catalogues (see the zh note above).

export const SETTINGS_STRINGS = shardCatalogue(SETTINGS_KEYS);


export const SETTINGS_MSG: SettingsMsg = {
  termTooLong: (n) => SETTINGS_MSG_BY_LOCALE[getLocale()].termTooLong(n),
  termsAtCap: (n) => SETTINGS_MSG_BY_LOCALE[getLocale()].termsAtCap(n),
  termsCapNote: (n) => SETTINGS_MSG_BY_LOCALE[getLocale()].termsCapNote(n),
  dictCount: (n, cap) => SETTINGS_MSG_BY_LOCALE[getLocale()].dictCount(n, cap),
  dictAliases: (aliases) => SETTINGS_MSG_BY_LOCALE[getLocale()].dictAliases(aliases),
};

/** Test/guard surface (locale-parity.test.ts): raw per-locale function tables. */
export const SETTINGS_MSG_CATALOGUES = SETTINGS_MSG_BY_LOCALE;
