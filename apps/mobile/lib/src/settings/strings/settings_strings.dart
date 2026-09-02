// AppStrings copy-catalogue shard: settings-page shell / scenario card
// terminology / sync / preferences.
// The one external entry point is still ../app_strings.dart (AppStrings
// composes this mixin with `with`; as of 0.2.67 the copy leaves `_lf…` are
// implemented by the generated classes under l10n/; `_t` is only still used
// by the handful of spots that **refused** migration — see the block above
// `_t` in app_strings.dart for why).
part of '../app_strings.dart';

mixin SettingsStrings on AppStringsLeaves {
  String _t({
    required String zh,
    required String en,
    required String ja,
    required String ko,
    required String zhTw,
    required String fr,
    required String es,
    required String de,
    required String ru,
  });
  // The ONE translation of the 「仅记录」("record only") term lives in
  // ChatStrings.recordOnly (later than this mixin in the `with` order) —
  // this only declares the signature, and the concrete implementation is
  // provided there (the same cross-shard pattern as pairError).
  String get recordOnly;

  // ── settings shell ──────────────────────────────────────────────────────
  String get settingsTitle => _lfSettingsTitle;
  String get secAccount => _lfSecAccount;
  String get secScenario =>
      _lfSecScenario;
  String get secCustomTerms =>
      _lfSecCustomTerms;
  String get secPreferences =>
      _lfSecPreferences;
  // card U9 —— the 「About」 section has always been in frame 7's anchored
  // section list (the SPEC-REF comment at the top of this file is copied
  // from that very spec), but the settings page never implemented it: on the
  // phone, package_info was only ever read once, for export metadata
  // (portable_export.dart's `App version at export`) — the user never sees,
  // in settings itself, which version is currently installed. Word-of-mouth
  // support (「what version are you on?」) has no way to be answered.
  String get secAbout => _lfSecAbout;
  String get appVersionLabel =>
      _lfAppVersionLabel;
  /// [v] comes straight from [AppVersionPort.appVersion] (pubspec's `version:`
  /// via package_info) — never hardcoded, so there is no second number to drift.
  /// Kept as a real four-language sentence (not a bare echo of [v]) so the
  /// surrounding word is still translated even though the number itself is not.
  String appVersionValue(String v) => _lfAppVersionValue(v);
  /// [AppVersionPort.appVersion] genuinely returned null — never make up a
  /// version number (Book 13 D5: a version number that, the moment it is
  /// installed, no longer corresponds to any build is more dangerous than
  /// saying 「unknown」).
  String get appVersionUnknown =>
      _lfAppVersionUnknown;
  // card U7 (mobile half) —— label for the help/support row, rendered only when
  // `kHelpUrl` (lib/src/support/help_link.dart) is non-empty. See that file's
  // comment for why it is empty today: no help/FAQ page has ever been verified
  // to exist, only the SaaS account console (a different destination).
  String get helpLabel => _lfHelpLabel;

  // ── scenario card ───────────────────────────────────────────────────────
  String get profession => _lfProfession;
  String get domain => _lfDomain;
  String get scenarioHint => _lfScenarioHint;
  String get syncPendingNote => _lfSyncPendingNote;

  /// GA-11: a server value (connect-time snapshot or a desktop edit) replaced a
  /// card the user could already see. Shown instead of silently swapping it.
  String get scenarioRemoteNote => _lfScenarioRemoteNote;
  String get addTerm => _lfAddTerm;
  String get termInputHint => _lfTermInputHint;
  String termCounter(int n, int max) => '$n / $max';
  String get termMaxHint => _lfTermMaxHint;
  String get add => _lfAdd;
  String get cancel => _lfCancel;

  String termAddError(TermFeedback f) {
    switch (f) {
      case TermFeedback.empty:
        return _lfTermAddError__1;
      case TermFeedback.tooLong:
        return _lfTermAddError__2;
      case TermFeedback.duplicate:
        return _lfTermAddError__3;
      case TermFeedback.atCap:
        return _lfTermAddError__4;
    }
  }

  // ── scenario presets / dictionary packs (V2-07.7 absorbed a shadow
  //    catalogue) ────────────────────────────────────────────────────────
  // This used to be two separate locale branches living outside AppStrings:
  // ScenarioPreset carried its own zh/en fields + label(locale), and
  // _packLabel had a zh Map built in. Structurally that hard-coded 「only two
  // languages」, and would have silently fallen back to English once the
  // four-language rollout landed — so it was folded back into the
  // catalogue. value/id are the protocol contract (the stored value), not
  // copy; an unknown value is returned as-is (data, not copy).
  /// Label for a kProfessionPresets value (settings_widgets.dart).
  String professionLabel(String value) {
    switch (value) {
      case 'software development':
        return _lfProfessionLabel_software_development;
      case 'product design':
        return _lfProfessionLabel_product_design;
      case 'devops / SRE':
        return _lfProfessionLabel_devops___SRE;
      case 'research':
        return _lfProfessionLabel_research;
      case 'writing / editing':
        return _lfProfessionLabel_writing___editing;
      case 'teaching':
        return _lfProfessionLabel_teaching;
      case 'medicine':
        return _lfProfessionLabel_medicine;
      case 'law':
        return _lfProfessionLabel_law;
      case 'finance':
        return _lfProfessionLabel_finance;
      default:
        return value;
    }
  }

  /// Label for a kDomainPresets value (settings_widgets.dart).
  String domainLabel(String value) {
    switch (value) {
      case 'cloud native':
        return _lfDomainLabel_cloud_native;
      case 'frontend':
        return _lfDomainLabel_frontend;
      case 'backend':
        return _lfDomainLabel_backend;
      case 'data / ML':
        return _lfDomainLabel_data___ML;
      case 'healthcare':
        return _lfDomainLabel_healthcare;
      case 'legal':
        return _lfDomainLabel_legal;
      case 'education':
        return _lfDomainLabel_education;
      case 'e-commerce':
        return _lfDomainLabel_e_commerce;
      default:
        return value;
    }
  }

  /// One-line description of a pack's sample terms, looked up by protocol id.
  /// [generatedPreview] is the first-four-seed-terms string from
  /// `gen_protocol.mjs` — those terms are STT hotwords, not UI copy. It is
  /// the answer for an unknown id so a newly-added pack never renders blank.
  String packPreview(String id, String generatedPreview) {
    switch (id) {
      case 'tech-dev':
        return _lfPackPreview_tech_dev;
      case 'medical':
        return _lfPackPreview_medical;
      case 'legal':
        return _lfPackPreview_legal;
      case 'finance':
        return _lfPackPreview_finance;
      case 'proper-noun':
        return _lfPackPreview_proper_noun;
      case 'code-switch':
        return _lfPackPreview_code_switch;
      default:
        return generatedPreview;
    }
  }

  /// Client-facing label for a dictionary-pack id. The id is the protocol
  /// contract; [englishLabel] is the protocol's English SSOT label, which is
  /// ALSO the answer for an unknown id (both locales) — a pack the catalogue
  /// does not know shows what the protocol says, never an invented translation.
  String packLabel(String id, String englishLabel) {
    switch (id) {
      case 'tech-dev':
        return _t(
          zh: '编程 / 开发术语',
          zhTw: '程式設計 / 開發術語',
          en: englishLabel,
          ja: 'プログラミング / 開発用語',
          ko: '프로그래밍 / 개발 용어',
          fr: 'Termes de programmation / développement',
          es: 'Términos de programación / desarrollo',
          de: 'Programmier-/Entwicklungsbegriffe',
          ru: 'Термины программирования / разработки',
        );
      case 'medical':
        return _t(
          zh: '医学术语',
          zhTw: '醫學術語',
          en: englishLabel,
          ja: '医学用語',
          ko: '의학 용어',
          fr: 'Termes médicaux',
          es: 'Términos médicos',
          de: 'Medizinische Begriffe',
          ru: 'Медицинские термины',
        );
      case 'legal':
        return _t(
          zh: '法律术语',
          zhTw: '法律術語',
          en: englishLabel,
          ja: '法律用語',
          ko: '법률 용어',
          fr: 'Termes juridiques',
          es: 'Términos legales',
          de: 'Rechtsbegriffe',
          ru: 'Юридические термины',
        );
      case 'finance':
        return _t(
          zh: '金融术语',
          zhTw: '金融術語',
          en: englishLabel,
          ja: '金融用語',
          ko: '금융 용어',
          fr: 'Termes financiers',
          es: 'Términos financieros',
          de: 'Finanzbegriffe',
          ru: 'Финансовые термины',
        );
      case 'proper-noun':
        return _t(
          zh: '产品 / 品牌名',
          zhTw: '產品 / 品牌名',
          en: englishLabel,
          ja: '製品 / ブランド名',
          ko: '제품 / 브랜드명',
          fr: 'Noms de produits / marques',
          es: 'Nombres de productos / marcas',
          de: 'Produkt-/Markennamen',
          ru: 'Названия продуктов / брендов',
        );
      case 'code-switch':
        return _t(
          zh: '中英混用词',
          zhTw: '中英混用詞',
          en: englishLabel,
          ja: '中英混在語',
          ko: '중영 혼용어',
          fr: 'Termes mixtes chinois-anglais',
          es: 'Términos mixtos chino-inglés',
          de: 'Chinesisch-Englisch gemischte Begriffe',
          ru: 'Смешанные китайско-английские термины',
        );
      default:
        return englishLabel;
    }
  }

  // A1c (2026-07-31): the `notedSyncTitle` / `notedSyncSub` pair that used to
  // live here (the settings-page 「仅记录条目也同步到 PC」("record-only
  // entries sync to PC too") row, styled with the
  // `── sync ──` section) is DELETED, not disabled. Card A1 retired the toggle's
  // only reader (TimelineSyncGate's emit-side gate) under the owner's
  // no-cloud-sync ruling — the toggle changed nothing while its copy still
  // promised to sync, the red line's second direction. `recordOnly` below stays;
  // it is the chat UI's term for a 「仅记录」 entry, not specific to this toggle.

  // ── preferences (WP-R4-3: language = an explicit choice, never follows
  //    the OS locale) ──────────────────────────────────────────────────────
  String get uiLanguage => _lfUiLanguage;
  // WP3 C11 (2026-08-18): the four hand-written language-name getters that
  // used to sit here (`langZh`/`langEn`/`langJa`/`langKo`) are DELETED, not
  // moved. Their last production reader was [spokenLangLabel], which now
  // reads endonyms from [AppLocale] — the registry-generated set every other
  // picker already uses. Keeping a parallel four-name table beside a
  // nine-name enum would be this repo's #1 defect shape (two tables
  // answering one question), and the 2026-08-14 comment in
  // settings_page_widget_test.dart that once justified keeping `langEn`
  // (「it still serves spokenLangLabel」) stopped being true the moment that
  // reader switched source.

  // ── Spoken language (the source_lang that ships on the wire — a
  //    DIFFERENT question from the row above; don't conflate them) ─────────
  //
  // 🔴 uiLanguage above answers 「what script does the UI render in」; this
  // one answers 「what language am I speaking in」. The latter ships as
  // `audio:start.source_lang`, the lookup key into the server's STT routing
  // table. The two rows sit right next to each other, so the titles must
  // each spell out what they govern.
  String get spokenLangTitle =>
      _lfSpokenLangTitle;

  /// 🔴 The user-visible face of owner's ruling: this item only governs
  /// transcription on the **cloud relay** path. When connected to your own
  /// PC, which engine is used is decided by that PC's own engine settings
  /// (`stt.routings`) — without this sentence, a LAN user would think this
  /// setting could swap out the recognition engine on their own machine.
  String get spokenLangNote => _lfSpokenLangNote;

  /// The spoken-language chip's copy = **endonym + the tag it ships as**,
  /// e.g. 「中文 (zh)」("Chinese (zh)").
  ///
  /// WP3 C11 (2026-08-18): the endonyms come from [AppLocale] — the enum the
  /// registry (`packages/protocol/src/locales.ts`) mirrors — via `l.name ==
  /// tag`, which holds for every value [kSpokenLangs] offers (bare codes; the
  /// one enum member whose name is NOT a wire tag, `zhTw`, is deliberately
  /// not a spoken value — the decision is written at [kSpokenLangs]). The
  /// hand-written four-arm switch this replaces was a second name table, and
  /// authoring a nine-arm one was exactly the card's named trap.
  /// ⚠️ What is shared is the **copy**, not the value — the storage key, the
  /// type, and the value space are each independent.
  ///
  /// 🔴 Why this row shows the tag while the UI-language row does not:
  ///   ① what this row picks **IS the tag itself** — it ships as
  ///      `audio:start.source_lang`, the lookup key into the server's STT
  ///      routing table (`stt.routings`). A user running their own PC has to
  ///      match what they pick here against their own routing table, and
  ///      with the key not visible on screen all they can do is guess;
  ///   ② the UI language is pure local rendering, with no external table to
  ///      line up against, so showing the tag would just be noise;
  ///   ③ an incidental hard benefit: with the two rows right next to each
  ///      other and the same endonym, 「中文」("Chinese") alone cannot tell
  ///      you which row it's from — true for the user, and equally true for
  ///      every `find.text('中文')` (measured this round: without the
  ///      distinction, three assertions across the existing settings_page /
  ///      settings_theme tests would hit 「Found 2 widgets」).
  ///      **The ambiguity is real, not a test artifact.**
  /// An unknown tag is returned as-is (it is data, not copy).
  String spokenLangLabel(String tag) {
    final AppLocale? l = appLocaleForLanguageTag(tag);
    return l != null ? '${l.endonym} ($tag)' : tag;
  }

  // ── theme (V2-07.4: the theme CAN follow the system — a DIFFERENT ruling
  //    from language; don't conflate them) ────────────────────────────────
  String get themeTitle => _lfThemeTitle;
  String get themeSystem => _lfThemeSystem;
  String get themeLight => _lfThemeLight;
  String get themeDark => _lfThemeDark;

  // ── FB-4 three-tier font scale (owner's 2026-08-06 ruling D3; **phone
  //    only**, not done on the PC side) ───────────────────────────────────
  //
  // ⚠️ The three tier names deliberately carry **no number** (not 「85%」):
  // the coefficient is our own implementation detail, and all the user can
  // judge is 「is it legible or not」. Writing a percentage would also make a
  // false promise — that number is multiplied **on top of** the system
  // scale, so 「85%」 does not mean 85% at all for someone who has turned on
  // the system's large-text setting.
  //
  // 🔴🔴 IN-PLACE CORRECTION (owner ruling 2026-08-27,
  // `docs/decisions/2026-08-27-owner-text-scale-slider.md`). The paragraph
  // above is kept verbatim — it was written for a row of five chips, and for
  // that row its argument held. **Its own recommendation is what failed on
  // glass**: with five rungs the adjectives ran out. owner, on an English
  // device, read `Large` / `Larger` / `Largest` as the same word three times
  // and reported 「two Large entries」. Adjectives are not a scale; five of
  // them do not order themselves in the reader's head.
  //
  // ⇒ The row is now ONE SLIDER, and the current rung reads as a
  // **percentage** (`AppTextScale.percent`, medium = 100%, derived from the
  // real `factor`). The five name strings
  // (`textScaleSmall`/`Medium`/`Large`/`Xlarge`/`Xxlarge`) had this row as
  // their only consumer, so they are **DELETED through the i18n pipeline**
  // (leaves.json + nine locale files + a regen) rather than left behind for
  // someone to hang a second meaning on — the slider's accessibility label is
  // `textScaleTitle` and its announced value is that same percentage, so
  // nothing is left needing them.
  //
  // ⚠️ **The old paragraph's warning survives the ruling and is now carried
  // by [textScaleNote] instead**: the percentage is a percentage of OUR rung,
  // NOT of the glyphs on the glass — it multiplies on top of the system
  // curve. That is why the note takes the number as an argument (below)
  // rather than the row printing a bare figure with no sentence beside it.
  String get textScaleTitle =>
      _lfTextScaleTitle;

  /// 🔴 This sentence is this row's **duty to be honest**: the tier
  /// multiplies on top of the system setting, it does not replace it.
  /// Without it, a user who has enlarged the system font would think
  /// 「picking the smallest rung here can override the system」 — and
  /// mechanically it cannot (and should not: that is an accessibility
  /// setting).
  ///
  /// 🔴 [pct] is **passed in, not written into the nine translations**: it is
  /// 「which rung matches how the app looked before 0.3.28」, i.e.
  /// `AppTextScale.large.percent`, and the day a factor moves, a number typed
  /// into nine JSON files would go on claiming the old one in nine languages
  /// at once. Same rule as `AppTextScale.percent` itself: derive it, never
  /// copy it.
  String textScaleNote(String pct) => _lfTextScaleNote(pct);

  String get logout => _lfLogout;

  // ── ST-2 (2026-08-19): the way to the account page, beside the identity ────
  //
  // 🔴 The link exists because both stores expect a deletion path reachable
  // from inside the app, and this app has no sign-up of its own — registration
  // is on the website (owner 2026-08-11), so the account lives there too.
  //
  // ⚠️ The note is not decoration: it says the deleting happens on the site,
  // NOT in the app. Without it the row promises an in-app action it does not
  // have, and 「一个改变不了任何东西的控件比没有控件更坏」 (a control that
  // changes nothing is worse than no control) applies to a link that arrives
  // somewhere the user did not expect just as much as to a dead button.
  String get accountManageLink => _lfAccountManageLink;

  String get accountManageNote => _lfAccountManageNote;

  /// 「Signed in as `<masked address>`」 — the SCREEN-READER half of the identity
  /// line the cloud card now always shows (owner 2026-08-27 UAT ②).
  ///
  /// 🔴 IT IS A SEMANTICS LABEL AND NOT THE PAINTED TEXT, ON PURPOSE, AND THE
  /// REASON IS MEASURED. The visible face is the masked address alone
  /// (`bit***a@gmail.com`) because the whole defect being fixed is a line that
  /// did not fit: at 360dp the card's inner column is ~250dp, the masked
  /// address needs ~195dp in the test font, and prefixing it with 「Signed in
  /// as 」 pushes it past the width and back into the ellipsis it came from.
  /// Sighted users get the context from the card the line sits in; a screen
  /// reader, which has no card, gets it from here.
  ///
  /// ⚠️ [account] is ALWAYS the masked form (`maskAccountEmail`). Reading the
  /// full address aloud would defeat the ruling in the one channel nobody
  /// thinks to check.
  String accountSignedInAs(String account) => _lfAccountSignedInAs(account);

  // ── L3 account card (0.2.48, owner's 2026-08-02 shape ruling) ───────────
  //
  // 🔴 A dangerous action has exactly ONE landing spot. The settings page's
  // cloud block does **NOT** hold the sign-out action itself, only a
  // navigation button that says where it's going; the real sign-out lives on
  // the device page's (instance list's) cloud-instance card, and
  // `login.logout()` still has that ONE call site across the whole app.
  //
  // ⚠️ The copy must say exactly where it's going (owner's own words: not a
  // bare 「go to…」).
  String get manageCloudOnDevices => _lfManageCloudOnDevices;

  /// The sign-out confirmation dialog (owner 2026-07-27: 「every deletion…
  /// needs a confirmation dialog」).
  /// Spells out the consequence: the local sign-in is cleared, and the cloud
  /// instance needs a fresh sign-in to be usable again; it is **NOT**
  /// deleting the account.
  ///
  /// 🔴 REQ-12-01 (owner's 2026-08-12 requirement ①): **not one of these
  /// three sentences may be dropped** — ①「the local sign-in is cleared」
  /// ②「records are unaffected」 ③「the account will not be deleted」. What
  /// changes is only **how they're shown**: they used to be crammed into one
  /// block of grey text saying **two opposite things** (what you'll lose /
  /// what you won't lose), rendered identically ⇒ someone skimming would
  /// read neither half. Now ① stays in the body text, ②③ go into the
  /// separate [confirmUnaffectedLabel] panel (`confirmDestructive`'s
  /// `unaffected`).
  /// ⚠️ Anyone who deletes ②③ for a shorter dialog has made it **worse than
  /// before**, not prettier.
  String get logoutConfirmTitle =>
      _lfLogoutConfirmTitle;
  String get logoutConfirmBody => _lfLogoutConfirmBody;

  /// The confirmation panel's title (generic, not specific to sign-out).
  String get confirmUnaffectedLabel =>
      _lfConfirmUnaffectedLabel;

  /// The first half of what was the second half of the original
  /// `logoutConfirmBody` sentence, meaning preserved verbatim.
  String get logoutConfirmKeepsRecords => _lfLogoutConfirmKeepsRecords;

  /// The second half of the second sentence. **This one matters most**: in
  /// many products, 「sign out」 IS deleting the account. Without this
  /// sentence, the user reads an action we neither performed nor are able to
  /// perform.
  String get logoutConfirmKeepsAccount => _lfLogoutConfirmKeepsAccount;

  /// The button label at the moment of confirmation. Deliberately **does
  /// NOT reuse** [logout] (「登出」"sign out"): that word is the label on
  /// the **trigger**, saying 「I want to do this」; this word is the
  /// **verdict**, saying 「go ahead」. The same word answering two questions
  /// is exactly this repo's #1 bug shape, and that's just as true in the UI.
  /// ⚠️ Incidentally keeps `find.text('登出')` matching only the trigger
  /// while the dialog is open.
  String get logoutConfirmAction =>
      _lfLogoutConfirmAction;

  // ── Window C export / import (Book 16 §7's explicit duty to warn +
  //    §5.2's per-line results must be explainable) ───────────────────────
  //
  // 🔴 §7-1's hard constraint lands here: the warning must state the
  // consequence (「anyone who gets it can read it」), ⛔ never write 「keep it
  // somewhere safe」 — that sentence carries no audible consequence, it's a
  // disclaimer, not a warning. All four languages must be able to state the
  // consequence, not just translate the Chinese sentence into a politer
  // version.

  String get secData => _lfSecData;

  String get exportTitle =>
      _lfExportTitle;
  String get exportSub => _lfExportSub;

  String get importTitle =>
      _lfImportTitle;
  String get importSub => _lfImportSub;

  /// 🔴 §7-1 —— must state plainly, before exporting, what this actually
  /// is. ⛔ Never swap it for 「keep it somewhere safe」.
  String get exportPlaintextWarning => _lfExportPlaintextWarning;

  /// 🔴 The user-visible face of §4.1's `scope`: what gets exported is never
  /// 「everything you've ever said」.
  String get exportScopeNote => _lfExportScopeNote;

  String exportScopeCount(int n) => _lfExportScopeCount(n);

  String exportRange(String from, String to) => '$from — $to';

  /// §8-2 —— the number comes from the inventory layer; it is really
  /// computed, not estimated.
  String exportIncludeImages(int count, int bytes) => _lfExportIncludeImages(count, formatBytes(bytes));

  String get exportNoImages => _lfExportNoImages;

  /// §8-3 —— with the box unticked, picture rows still export as usual, just
  /// without the image file. Say so, or the user will think the whole row
  /// is gone.
  String get exportWithoutImagesNote => _lfExportWithoutImagesNote;

  String get exportAction => _lfExportAction;

  String get exportRunning =>
      _lfExportRunning;
  String get importRunning =>
      _lfImportRunning;

  /// §7-3 —— the success notice must state where the file landed.
  String exportDone(int count, String where) => _lfExportDone(count, where);

  String get exportCancelled =>
      _lfExportCancelled;

  String exportFailedText(ExportFailure f, String? detail) {
    final String head = switch (f) {
      ExportFailure.nothingToExport => _lfExportFailedText__1,
      ExportFailure.buildFailed => _lfExportFailedText__2,
      ExportFailure.saveFailed => _lfExportFailedText__3,
    };
    // The platform's own words ride along rather than being swallowed — a
    // failure the user cannot describe is a failure nobody can fix.
    return detail == null || detail.isEmpty ? head : '$head（$detail）';
  }

  String get importAction =>
      _lfImportAction;

  String get importCancelled => _lfImportCancelled;

  /// Book 16 §5.3 —— a named refusal for a cross-end file. `otherEnd` is the
  /// end the file itself claims to be from.
  String importFileRefusal(FprFileRefusal r, String? otherEnd, String? detail) {
    final String head = switch (r) {
      FprFileRefusal.notAnArchive => _lfImportFileRefusal__1,
      FprFileRefusal.missingRecords => _lfImportFileRefusal__2,
      FprFileRefusal.compressedMember => _lfImportFileRefusal__3,
      FprFileRefusal.missingHeader => _lfImportFileRefusal__4,
      FprFileRefusal.unknownFprVersion => _lfImportFileRefusal__5,
      FprFileRefusal.crossEnd => _endMismatch(otherEnd),
      FprFileRefusal.countMismatch => _lfImportFileRefusal__6,
    };
    return detail == null || detail.isEmpty ? head : '$head（$detail）';
  }

  String _endMismatch(String? otherEnd) {
    final String where = otherEnd == 'desktop'
        ? _lf_endMismatch__1
        : _lf_endMismatch__2;
    return _lf_endMismatch__3(where);
  }

  /// Book 16 §5.2 —— a refusal must be named, never just 「format error」.
  String importLineRefusal(FprLineRefusal r) => switch (r) {
    FprLineRefusal.notJson => _lfImportLineRefusal__1,
    FprLineRefusal.unknownFprVersion => _lfImportLineRefusal__2,
    FprLineRefusal.unknownKind => _lfImportLineRefusal__3,
    FprLineRefusal.strayHeader => _lfImportLineRefusal__4,
    FprLineRefusal.missingId => _lfImportLineRefusal__5,
    FprLineRefusal.badCreatedAt => _lfImportLineRefusal__6,
    FprLineRefusal.badMode => _lfImportLineRefusal__7,
    FprLineRefusal.badStatus => _lfImportLineRefusal__8,
    FprLineRefusal.badEntryType => _lfImportLineRefusal__9,
  };

  /// Book 16 §5.2 —— each of the four outcomes is counted separately;
  /// **a partial success is reported as a partial success**.
  ///
  /// 🔴 Every counter in [ImportReport] appears in this sentence. That is the
  /// point: a report that mentioned only 「N added」 would let refused lines be
  /// swallowed while the screen said 「import complete」, which is the red line.
  String importReportText(ImportReport r) {
    final List<String> parts = <String>[
      _lfImportReportText__1(r.added),
      if (r.skippedExisting > 0)
        _lfImportReportText__2(r.skippedExisting),
    ];
    if (r.refusedCount > 0) {
      final List<String> reasons = <String>[
        for (final MapEntry<FprLineRefusal, int> e in r.refusedLines.entries)
          '${importLineRefusal(e.key)} ×${e.value}',
      ];
      parts.add(
        _t(
          zh: '有 ${r.refusedCount} 行没能导入：${reasons.join('、')}',
          zhTw: '有 ${r.refusedCount} 行未能匯入：${reasons.join('、')}',
          en: '${r.refusedCount} lines could not be imported: ${reasons.join('; ')}',
          ja: '${r.refusedCount} 行を取り込めませんでした：${reasons.join('、')}',
          ko: '${r.refusedCount}줄을 가져오지 못했습니다: ${reasons.join(', ')}',
          fr: "${r.refusedCount} lignes n'ont pas pu être importées : "
              "${reasons.join('; ')}",
          es: '${r.refusedCount} líneas no se pudieron importar: '
              '${reasons.join('; ')}',
          de: '${r.refusedCount} Zeilen konnten nicht importiert werden: '
              '${reasons.join('; ')}',
          // AUD-D P1-4: sidesteps Russian's count-noun agreement (「строка」
          // inflects differently for 1 / 2-4 / 5+, same family as
          // [_ruMatchesWord] two mixins over) by naming the count once, as a
          // label, rather than inflecting a noun around it.
          ru: 'Не удалось импортировать строк: ${r.refusedCount} — '
              '${reasons.join('; ')}',
        ),
      );
    }
    if (r.missingAttachments > 0) {
      // 🔴 §5.2 table row four —— two situations, two sentences. The
      // criterion is the file header's own `has_attachments`, not a guess.
      parts.add(
        r.fileDeclaredAttachments
            ? _lfImportReportText__4(r.missingAttachments)
            : _lfImportReportText__5(r.missingAttachments),
      );
    }
    return parts.join(' · ');
  }

  /// Book 16 §3 —— `README.txt` is not decoration: a user opening this zip
  /// three months later needs to be able to tell what it is. All four things
  /// belong in it: ① what this is ② the plaintext warning ③ how to import it
  /// back ④ the export time and record count.
  String portableReadme({
    required String exportedAt,
    required int entryCount,
    required int attachmentCount,
    required bool hasAttachments,
    required String? appVersion,
  }) {
    final String what = _lfPortableReadme__1;
    final String contents = _t(
      zh: 'records.jsonl —— 每行一条 JSON，第一行说明这份文件是什么。'
          '${hasAttachments ? '\natt/ —— 记录里引用的图片（文件名是内容哈希）。' : ''}',
      zhTw: 'records.jsonl —— 每行一條 JSON，第一行說明這份檔案是什麼。'
          '${hasAttachments ? '\natt/ —— 記錄裡引用的圖片（檔名是內容雜湊）。' : ''}',
      en: 'records.jsonl — one JSON object per line; the first line says what this file is.'
          '${hasAttachments ? '\natt/ — the pictures the records point at (file names are content hashes).' : ''}',
      ja: 'records.jsonl —— 1 行 1 件の JSON。先頭行がこのファイルの説明です。'
          '${hasAttachments ? '\natt/ —— 記録が参照する画像（ファイル名は内容のハッシュ）。' : ''}',
      ko: 'records.jsonl — 한 줄에 하나의 JSON. 첫 줄이 이 파일의 설명입니다.'
          '${hasAttachments ? '\natt/ — 기록이 가리키는 사진(파일 이름은 내용 해시).' : ''}',
      fr: "records.jsonl — un objet JSON par ligne ; la première ligne indique ce qu'est ce fichier."
          "${hasAttachments ? '\natt/ — les images référencées par les enregistrements (les noms de fichiers sont des empreintes du contenu).' : ''}",
      es: 'records.jsonl — un objeto JSON por línea; la primera línea indica qué es este archivo.'
          '${hasAttachments ? '\natt/ — las imágenes a las que apuntan los registros (los nombres de archivo son hashes del contenido).' : ''}',
      de: 'records.jsonl — ein JSON-Objekt pro Zeile; die erste Zeile beschreibt, was diese Datei ist.'
          '${hasAttachments ? '\natt/ — die Bilder, auf die die Einträge verweisen (Dateinamen sind Inhalts-Hashes).' : ''}',
      ru: 'records.jsonl — по одному объекту JSON на строку; первая строка описывает, что это за файл.'
          '${hasAttachments ? '\natt/ — изображения, на которые ссылаются записи (имена файлов — это хеши содержимого).' : ''}',
    );
    final String howBack = _lfPortableReadme__3;
    final String counts = _t(
      zh: '导出时间：$exportedAt\n条数：$entryCount'
          '${hasAttachments ? '\n图片：$attachmentCount 张' : '\n图片：未包含'}'
          '${appVersion == null ? '' : '\n导出时的应用版本：$appVersion'}',
      zhTw: '匯出時間：$exportedAt\n筆數：$entryCount'
          '${hasAttachments ? '\n圖片：$attachmentCount 張' : '\n圖片：未包含'}'
          '${appVersion == null ? '' : '\n匯出時的應用程式版本：$appVersion'}',
      en: 'Exported at: $exportedAt\nRecords: $entryCount'
          '${hasAttachments ? '\nPictures: $attachmentCount' : '\nPictures: not included'}'
          '${appVersion == null ? '' : '\nApp version at export: $appVersion'}',
      ja: '書き出し日時：$exportedAt\n件数：$entryCount'
          '${hasAttachments ? '\n画像：$attachmentCount 枚' : '\n画像：含まれていません'}'
          '${appVersion == null ? '' : '\n書き出し時のアプリのバージョン：$appVersion'}',
      ko: '내보낸 시각: $exportedAt\n건수: $entryCount'
          '${hasAttachments ? '\n사진: $attachmentCount장' : '\n사진: 포함되지 않음'}'
          '${appVersion == null ? '' : '\n내보낼 때의 앱 버전: $appVersion'}',
      fr: 'Exporté le : $exportedAt\nEnregistrements : $entryCount'
          "${hasAttachments ? '\nImages : $attachmentCount' : '\nImages : non incluses'}"
          "${appVersion == null ? '' : "\nVersion de l'application à l'export : $appVersion"}",
      es: 'Exportado el: $exportedAt\nRegistros: $entryCount'
          '${hasAttachments ? '\nImágenes: $attachmentCount' : '\nImágenes: no incluidas'}'
          '${appVersion == null ? '' : '\nVersión de la app al exportar: $appVersion'}',
      de: 'Exportiert am: $exportedAt\nEinträge: $entryCount'
          '${hasAttachments ? '\nBilder: $attachmentCount' : '\nBilder: nicht enthalten'}'
          '${appVersion == null ? '' : '\nApp-Version beim Export: $appVersion'}',
      ru: 'Экспортировано: $exportedAt\nЗаписей: $entryCount'
          '${hasAttachments ? '\nИзображений: $attachmentCount' : '\nИзображения: не включены'}'
          '${appVersion == null ? '' : '\nВерсия приложения при экспорте: $appVersion'}',
    );
    return <String>[
      'FlowMic',
      '',
      what,
      '',
      // 🔴 §7-1 in the file itself, not just on screen: the zip outlives the
      // dialog that warned about it.
      exportPlaintextWarning,
      '',
      contents,
      '',
      howBack,
      '',
      counts,
      '',
    ].join('\n');
  }
}
