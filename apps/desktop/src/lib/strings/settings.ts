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
  // ─── R-2乙 (owner 2026-08-29): smooth's supervision used to be weaker
  //     outside zh/en; WP8 P1-2 extended the closed-class tables to the
  //     spoken set, so the sentence now states that coverage rather than
  //     the old zh/en-only gap ──────────────────────────────────────────────
  //
  // The meaning-preservation guard behind polish has TWO parts. The cardinality
  // bound (§3.1) is language-independent. The closed-class check (§3.2) — the
  // one that catches a dropped negation — is the table in
  // `CLOSED_CLASS_GUARDED_LANGS` (stt-polish-guard-terms.ts), kept honest by
  // `stt-polish-guard-coverage.test.ts`.
  //
  // 🔴 SHOWN ONLY WHEN `smooth` IS SELECTED, because that is when the
  // cardinality bound is the looser of the two strengths; the closed-class
  // half is strength-independent and this sentence is what it can see.
  //
  // ⚠️ Statement of fact, no imperative, and NO claim about the default — same
  // discipline as `polish_strength_hint` above (data-flow-disclosure.test.ts's
  // DEFAULT_VALUE_CLAIMS exists to catch the latter). It does not say which
  // strength to choose; it says what the check can and cannot see.
  //
  // ⚠️ Deliberately NOT conditioned on the user's own routing rows. The desktop
  // can hold several language rows at once, so 「your language is covered」 would
  // be a claim about a set, not about this utterance. Naming the spoken set
  // is true regardless of what happens to be configured.
  'polish_strength_smooth_coverage',
  // owner 2026-07-26 ⑤ — where these settings actually apply. Stated on the LLM
  // section and the scenario-inference consent section, whose keys
  // (`llm.config` / `scenario.inference`) are STILL LAN-only today (verified by
  // grep: neither is in `PREFERENCE_SETTING_KEYS`,
  // apps/desktop/src-tauri/src/shell/settings_route.rs).
  //
  // ⚠️ IT USED TO ALSO BE TRUE OF `SttSettings.vue`'s note (see
  // `stt_settings_scope_note` below for why that page no longer uses this key).
  'settings_scope_lan',
  // E6 (2026-09-02) — `SttSettings.vue` renders FOUR sections on one page: the
  // routing table (`stt.routings`, still LAN-only) plus the dictionary/AI-polish/
  // two-pass-refine controls (`stt.dictionary`/`stt.polish`/`stt.refine`), which
  // owner 2026-08-24 moved onto BOTH legs (verified by grep:
  // `PREFERENCE_SETTING_KEYS` in settings_route.rs lists exactly those three plus
  // `scenario.card`). The page used to show `settings_scope_lan` above ALL FOUR
  // sections, so since 08-24 it told a cloud-relay user their dictionary/polish/
  // refine choices "have no effect on the cloud relay" while the wire sent them
  // there anyway — the opposite of true, and exactly the shape CLAUDE.md's
  // 反 façade ④ names (a sentence asserting behaviour elsewhere that stopped
  // being true when that elsewhere changed). This key names both facts
  // instead of the one that stopped being universal.
  'stt_settings_scope_note',
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
  // ── card LLM-NOTICE (owner 2026-08-25 D1/D2) — three sentences, three subjects ──
  //
  // THREE SEPARATE STATEMENTS, NEVER MERGED, because they are three different
  // truths about one missing model (execution plan §1.1, measured):
  //   · Translate / Organize  → NOT SUPPORTED  (`llm_modes_unsupported`, LLM section)
  //   · AI polish             → NOT IN EFFECT  (`polish_no_llm`, already above)
  //   · the scenario card     → its terms STILL WORK: stt/engine-factory.ts feeds
  //     `scenario.card.terms` to the SPEECH engine as hotwords/replacements; only
  //     the half that rides into the polish prompt (stt-polish.ts) goes down
  //     (`scenario_terms_still_work`, on the card itself). Calling the card
  //     "not supported" would be false, and a wrong status word is R11 territory.
  // All three render ONLY on the server-supplied `capability.llm` fact — never
  // inferred from an empty endpoint (a managed cloud account has no row).
  // None may assert a DEFAULT VALUE of any switch (DEFAULT_VALUE_CLAIMS rule).
  'llm_modes_unsupported',
  'scenario_terms_still_work',
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
  // 2026-08-30 owner defect: the profession chip row rendered its stored
  // value (then Chinese text, doubling as both id and label) directly, so
  // every UI locale but zh-CN showed Chinese chips. W-i18n-B (2026-08-31)
  // switched the stored ids to the phone's English slugs
  // (profession-ids.ts / kProfessionPresets); these remain pure display
  // overrides, same split PACK_LABELS already draws above.
  // `profession_writing` is the overlay for the phone-only id
  // `writing / editing` — the eight older chips reuse the keys below.
  'profession_swdev',
  'profession_cloud_ops',
  'profession_product_design',
  'profession_finance',
  'profession_healthcare',
  'profession_law',
  'profession_education',
  'profession_research',
  'profession_writing',
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
  // The built-in speech model's five count-bearing sentences (2026-08-19 §5-A).
  // Same one-line-per-member shape as the five above, and the same reason it is
  // written out rather than spread: this list is what proves each generated arm
  // has a production reader.
  modelDownloadSize: (size) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelDownloadSize(size),
  modelResume: (pct) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelResume(pct),
  modelFiles: (done, total) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelFiles(done, total),
  modelEtaMinutes: (n) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelEtaMinutes(n),
  modelResumedFrom: (size) => SETTINGS_MSG_BY_LOCALE[getLocale()].modelResumedFrom(size),
  sttModelReady: (model) => SETTINGS_MSG_BY_LOCALE[getLocale()].sttModelReady(model),
};

/** Test/guard surface (locale-parity.test.ts): raw per-locale function tables. */
export const SETTINGS_MSG_CATALOGUES = SETTINGS_MSG_BY_LOCALE;
