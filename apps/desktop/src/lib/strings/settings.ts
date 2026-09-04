// S string catalogue shard: settings page (account / preferences / about /
// STT routing / local models / LLM / save receipts). Merged and exported by
// ../strings.ts.
//
// 🔴 SIXTY LEAVES LEFT THIS SHARD ON 2026-09-03 (owner ruling, phone-owned
// preferences): the AI-polish card, two-pass refine, the personal dictionary,
// the scenario card (professions, packs, terms) and the scenario-inference
// consent, plus the five counted `settingsMsg` sentences those two lists used.
// The screens went with them. Nothing was replaced by a read-only mirror — this
// end cannot state a current value for a setting it neither stores nor receives.
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
  // 🔴 The SECOND HALF of `set_account_hint` was deleted on 2026-08-19, all nine
  // languages at once. It read 「未接入控制台账户查询，不显示邮箱」 ("the console
  // account query is not wired in, so no email is shown") — and the account card
  // this hint sits directly on top of (SettingsPage.vue, same `<section
  // id="set-account">`) has been PRINTING THE EMAIL since the L3 rework:
  // `lib/cloud-account.ts` identityLine() returns `a.email ?? S.cloud_acct_no_email`,
  // and CloudAccountLines.vue renders it as the 「账号」 row. The sentence denied
  // what the panel one card below it displays, on the same screen, at once.
  // This is the exact defect its sibling `cloud_account_gap` was DELETED for the
  // day that card went live (see the long note in ./cloud.ts) — an honest
  // disclosure that the surface was not wired, kept past the wiring, becomes a
  // lie. That one was false end to end, so it went whole; this one was only half
  // stale, so only that half went.
  // ⚠️ The surviving clause is not filler and must not be dropped with it: it is
  // the only place that answers "what makes this PC count as signed in" —
  // SettingsPage.vue `signedIn = cloud.key_set`, i.e. the presence of the Cloud
  // Key stored locally, which is also why this page has no e-mail/password form.
  // ⚠️ Deliberately NOT replaced by a sentence about the card being live or
  // freshly fetched. The card already answers its own freshness, with a
  // timestamp and four distinct phases (`cloud_acct_live` / `_stale` /
  // `_unknown` / `cloud_err_expired`); a second sentence up here would be a
  // second answer to a question already answered — the same reasoning
  // identityLine()'s header gives for having no replacement sentence of its own.
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
  // 2026-08-30 owner defect sweep: `fetchAutostartState`/`setAutostartEnabled`
  // (lib/bridge.ts) used to bake a Chinese sentence straight into `reason` when
  // `asAutostartInfo` rejected the IPC payload's shape, so every non-zh-CN UI
  // locale showed that one Chinese sentence appended after the (already
  // localized) `set_prefs_autostart_*_failed` prefix. bridge.ts now returns a
  // stable machine CODE instead (`autostart_state_unrecognised_shape` /
  // `autostart_set_unrecognised_shape`) and lib/autostart-reason.ts maps both
  // codes to this ONE sentence — see that file for the unmapped-code fallback
  // (render the code itself, never invented prose; INJECT_FAIL_REASON's
  // policy).
  'set_prefs_autostart_unrecognised_shape',
  'set_about_title',
  // ── 「注入与输入」 (2026-08-26) — the standing disclosure that injecting text
  // borrows the clipboard. It exists because the DEFAULT inject path became the
  // clipboard that day (`inject/text_route.rs`): a side effect that used to hit
  // a minority of sentences now hits nearly all of them, and owner's ruling was
  // that the user must be told where they can act on it (back something up)
  // rather than left to notice their clipboard changing under them.
  //
  // ⚠️ These are the only strings in this shard that describe a MECHANISM, so
  // they are the ones most likely to rot. The anchor is `PasteReason` in
  // `inject/text_route.rs`: if the clipboard ever stops being the default, this
  // section is a lie the same day and must go with it.
  //
  // ⚠️ Deliberately NOT a jump target: `set_inject_*` is a place to read, and
  // `JumpableSettingsSection` (lib/settings-section-jump.ts) is deliberately a
  // closed union so nobody can jump to a section id nobody rendered.
  'set_nav_inject',
  'set_inject_title',
  'set_inject_clip_title',
  'set_inject_clip_body',
  'set_inject_clip_backup',
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
  'stt_add_lang',
  // ── owner ruling 2026-08-27 §2-1: the language cell is a fixed list ────────
  // The catch-all row's label. 🔴 THE ASTERISK IS NEVER SHOWN. It is our
  // storage format, and a settings screen that prints it has handed the reader
  // a wire value where an answer belongs — the same class of defect as the
  // bare error identifier the phone printed at a user in 0.2.53.
  'stt_lang_fallback',
  // A stored language code nothing can match — the badge, and the sentence.
  // 🔴 Two keys because the badge has to be short enough to sit in a pill and
  // the instruction has to be long enough to be an instruction; one key would
  // have been ellipsised into uselessness in the pill or turned the pill into a
  // paragraph. And the row is NOT rewritten to something valid: the owner ruled
  // that stored values are shown, badged, and replaced by the user.
  'stt_lang_unsupported',
  'stt_lang_unsupported_note',
  // 🔴 owner ruling 2026-08-27 §R2-2. It states what a duplicate DOES, not that
  // it is untidy: two rows with the same language key collide at the same rung
  // of the routing ladder and `find` settles it, so the second row is not
  // 「lower priority」 — it is unreachable. A vaguer word ("conflict",
  // "ignored") would leave the user unable to predict which one wins.
  // ⚠️ The stored array is NOT rewritten to remove it (owner ruled that
  // explicitly); the select simply refuses to CREATE another one.
  'stt_lang_duplicate',
  // ── §2-3: what the built-in engine can actually do for this row ───────────
  // 🔴 THE OWNER'S EMPTY-STATE RULING. A fresh install routes Chinese and the
  // catch-all to the built-in engine and has downloaded nothing; the table said
  // 「built-in engine」 and stopped, so two rows looked configured and could not
  // transcribe a word. This is the red half — the green half names the model
  // and is `settingsMsg.sttModelReady`, a function because it carries an id.
  //
  // ⚠️ It says 「no local model YET」 and points at the card below rather than
  // naming a file, a size or a URL: which pack the reader should take is the
  // card's question and it answers it per pack, with figures.
  'stt_model_missing',
  'stt_model_missing_action',
  'col_language',
  'col_endpoint',
  // 🔴 `dict_title` / `dict_add` / `dict_no_alias` and the whole polish and
  // two-pass-refine block used to sit here. Deleted 2026-09-03 with their cards.
  'settings_scope_lan',
  'llm_title',
  // 🔴 REQ-13-09 — 「AI 润色」("AI polish") IS ON THIS LIST, and leaving it off
  // was the exact shape the card is about: the two legs (speech vs language
  // model) told as one, or one of them silently riding on the other's page.
  //   · anchor: apps/server-core/src/engine/stt-factory.ts resolvePolishDep()
  //     resolves through the SAME resolveLlmConfigWithSource() the compose turn
  //     uses — polish has no configuration of its own, it consumes this one.
  //
  // 🔴 REWRITTEN 2026-09-03, and NOT by dropping the claim. The switch moved to
  // the phone (owner ruling, phone-owned preferences), so the old sentence's
  // reader had no way to find it; the sentence now says where it is and that the
  // phone hands the value over on each connection. What must NOT happen is the
  // feature name disappearing from this page: emptying these fields still turns
  // AI polish off, and this is the only page that can say so — the sentence that
  // used to say it beside the switch (`polish_no_llm`) went with the switch.
  // ⚠️ It names the FEATURE, never a value of its switch: whether polish is on
  // is now the phone's answer and this binary cannot read it.
  // ⚠️ The old `polish_title == llm_hint substring` equality pin went with
  // `polish_title`. Renaming the feature no longer reddens a test, so the name
  // is spelled out here as the thing to keep in step with the phone's own
  // catalogue (i18n/mobile: `settingsAiPolish`).
  'llm_hint',
  // ── card LLM-NOTICE (owner 2026-08-25 D1/D2) — ONE sentence left of three ──
  //
  // It was three statements about one missing model, never merged, because they
  // were three different truths (execution plan §1.1, measured):
  //   · Translate / Organize  → NOT SUPPORTED  (`llm_modes_unsupported`, here)
  //   · AI polish             → NOT IN EFFECT  (`polish_no_llm`, deleted 2026-09-03)
  //   · the scenario card     → its terms STILL WORK  (`scenario_terms_still_work`,
  //     deleted 2026-09-03)
  // 🔴 THE OTHER TWO WERE NOT MERGED INTO THIS ONE — their SCREENS left. The
  // polish switch and the scenario card are the phone's, so a desktop sentence
  // about either would be about a screen the reader is not on. The card's terms
  // still reach the speech engine as hotwords (stt/engine-factory.ts) exactly as
  // before; nothing about the MECHANISM changed, only who shows the control.
  // ⚠️ This one still renders ONLY on the server-supplied `capability.llm` fact
  // — never inferred from an empty endpoint (a managed cloud account has no row)
  // — and may not assert a DEFAULT VALUE of any switch (DEFAULT_VALUE_CLAIMS).
  'llm_modes_unsupported',
  // The dismissible first-run card (owner D2): a title, a body that names what
  // works without a model and what does not, two buttons that JUMP to the speech
  // model and language model configurations, and a remembered dismissal.
  // 🔴 CORRECTED 2026-08-28: this note used to end 「no 'read the guide' link:
  // that web section does not exist yet」. The chapter shipped in the
  // 2026-08-27 web round (`/guide/model`) and the owner asked for the link the
  // next day, so `llm_setup_guide` exists and opens through the one external
  // door (`openExternalUrl`). The reasoning that kept it out was right until
  // the page was there.
  'llm_setup_title',
  'llm_setup_body',
  'llm_setup_go_stt',
  'llm_setup_go_llm',
  // The label of that link. Deliberately says WHERE it goes rather than 「learn
  // more」: this button leaves the app for a browser, and a reader is entitled
  // to know that before pressing it.
  'llm_setup_guide',
  'llm_setup_dismiss',
  'llm_preset',
  'llm_protocol',
  // ── 0.3.43 vendor catalogue (owner 2026-08-28; contract 06 §7.1) ───────────
  //
  // The `<optgroup>` headings, the empty-state row, and human names for the two
  // protocol values. Shared by BOTH engine pages, which is why they are not
  // `llm_`-prefixed: one menu vocabulary, stated once. Vendor names themselves
  // (OpenAI, Groq, Ollama…) are NOT strings — they are proper nouns carried by
  // the catalogue, and translating them would invent products.
  //
  // 🔴 `preset_choose` IS THE DEFECT-① FIX AND IT IS NOT DECORATION. A `<select>`
  // whose value matches no option renders THE FIRST OPTION, so an unconfigured PC
  // sat there naming a vendor nobody had chosen. This is the row that says so.
  'preset_choose',
  'preset_group_builtin',
  'preset_group_cloud',
  'preset_group_local',
  'preset_group_custom',
  // 🔴 The protocol select used to print its raw wire values
  // (`openai-compatible` / `anthropic`) at the user — defect ③. The VALUE is
  // still the enum; only the label is human. Renaming the value would be a wire
  // change wearing a copy change's clothes.
  'llm_protocol_openai',
  'llm_protocol_anthropic',
  'llm_endpoint',
  'llm_model',
  'llm_apikey',
  'llm_apikey_ph',
  // 🔴 The scenario card's nine keys and the twelve scenario-inference keys
  // ended here on 2026-09-03, together with their two screens.
  'stt_builtin_no_endpoint',
  'stt_engine_custom',
  // 🔴 `stt_sub_on` / `stt_sub_off_default` ended here too. That pair was the
  // 「on right now / off right now」 sub-label under THREE toggles (AI polish,
  // two-pass refine, inference consent) and this end has none of them left. Its
  // long note is worth carrying forward as prose, because it is the reason the
  // pair could not simply be renamed: a shared label can only carry what is true
  // of every toggle that shows it, which is why 「off by default」 had to come out
  // of it in 2026-08-08 rather than being fixed per toggle.
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
  // The built-in speech model's six count-bearing sentences (2026-08-19 §5-A).
  // 🔴 The five term/dictionary members that used to head this list left on
  // 2026-09-03 with the scenario card and the personal dictionary. One line per
  // member is still deliberate: this list is what proves each generated arm has
  // a production reader.
  modelDownloadSize: (size) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelDownloadSize(size),
  modelResume: (pct) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelResume(pct),
  modelFiles: (done, total) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelFiles(done, total),
  modelEtaMinutes: (n) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelEtaMinutes(n),
  modelResumedFrom: (size) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelResumedFrom(size),
  sttModelReady: (model) => SETTINGS_MSG_BY_LOCALE[getLocale()].sttModelReady(model),
};

/** Test/guard surface (locale-parity.test.ts): raw per-locale function tables. */
export const SETTINGS_MSG_CATALOGUES = SETTINGS_MSG_BY_LOCALE;
