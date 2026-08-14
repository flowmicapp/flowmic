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

  /// Client-facing label for a dictionary-pack id. The id is the protocol
  /// contract; [englishLabel] is the protocol's English SSOT label, which is
  /// ALSO the answer for an unknown id (both locales) — a pack the catalogue
  /// does not know shows what the protocol says, never an invented translation.
  String packLabel(String id, String englishLabel) {
    switch (id) {
      case 'tech-dev':
        return _t(zh: '编程 / 开发术语', en: englishLabel, ja: 'プログラミング / 開発用語', ko: '프로그래밍 / 개발 용어');
      case 'medical':
        return _t(zh: '医学术语', en: englishLabel, ja: '医学用語', ko: '의학 용어');
      case 'legal':
        return _t(zh: '法律术语', en: englishLabel, ja: '法律用語', ko: '법률 용어');
      case 'finance':
        return _t(zh: '金融术语', en: englishLabel, ja: '金融用語', ko: '금융 용어');
      case 'proper-noun':
        return _t(zh: '产品 / 品牌名', en: englishLabel, ja: '製品 / ブランド名', ko: '제품 / 브랜드명');
      case 'code-switch':
        return _t(zh: '中英混用词', en: englishLabel, ja: '中英混在語', ko: '중영 혼용어');
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
  String get langZh => _lfLangZh;
  String get langEn => 'EN';
  // Language names always use their endonym, never translated by the UI
  // language — the same existing ruling as langEn.
  String get langJa => '日本語';
  String get langKo => '한국어';

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
  /// The language names reuse the same endonym set as [langZh] etc. (an
  /// existing ruling: language names are not translated by the UI language).
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
  String spokenLangLabel(String tag) => switch (tag) {
    'zh' => '$langZh ($tag)',
    'en' => '$langEn ($tag)',
    'ja' => '$langJa ($tag)',
    'ko' => '$langKo ($tag)',
    _ => tag,
  };

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
  String get textScaleTitle =>
      _lfTextScaleTitle;
  String get textScaleLarge => _lfTextScaleLarge;
  String get textScaleMedium => _lfTextScaleMedium;
  String get textScaleSmall => _lfTextScaleSmall;

  /// 🔴 This sentence is this row's **duty to be honest**: the tier
  /// multiplies on top of the system setting, it does not replace it.
  /// Without it, a user who has enlarged the system font would think
  /// 「picking 'small' here can override the system」 — and mechanically it
  /// cannot (and should not: that is an accessibility setting).
  String get textScaleNote => _lfTextScaleNote;

  String get logout => _lfLogout;

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
          en: '${r.refusedCount} lines could not be imported: ${reasons.join('; ')}',
          ja: '${r.refusedCount} 行を取り込めませんでした：${reasons.join('、')}',
          ko: '${r.refusedCount}줄을 가져오지 못했습니다: ${reasons.join(', ')}',
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
      en: 'records.jsonl — one JSON object per line; the first line says what this file is.'
          '${hasAttachments ? '\natt/ — the pictures the records point at (file names are content hashes).' : ''}',
      ja: 'records.jsonl —— 1 行 1 件の JSON。先頭行がこのファイルの説明です。'
          '${hasAttachments ? '\natt/ —— 記録が参照する画像（ファイル名は内容のハッシュ）。' : ''}',
      ko: 'records.jsonl — 한 줄에 하나의 JSON. 첫 줄이 이 파일의 설명입니다.'
          '${hasAttachments ? '\natt/ — 기록이 가리키는 사진(파일 이름은 내용 해시).' : ''}',
    );
    final String howBack = _lfPortableReadme__3;
    final String counts = _t(
      zh: '导出时间：$exportedAt\n条数：$entryCount'
          '${hasAttachments ? '\n图片：$attachmentCount 张' : '\n图片：未包含'}'
          '${appVersion == null ? '' : '\n导出时的应用版本：$appVersion'}',
      en: 'Exported at: $exportedAt\nRecords: $entryCount'
          '${hasAttachments ? '\nPictures: $attachmentCount' : '\nPictures: not included'}'
          '${appVersion == null ? '' : '\nApp version at export: $appVersion'}',
      ja: '書き出し日時：$exportedAt\n件数：$entryCount'
          '${hasAttachments ? '\n画像：$attachmentCount 枚' : '\n画像：含まれていません'}'
          '${appVersion == null ? '' : '\n書き出し時のアプリのバージョン：$appVersion'}',
      ko: '내보낸 시각: $exportedAt\n건수: $entryCount'
          '${hasAttachments ? '\n사진: $attachmentCount장' : '\n사진: 포함되지 않음'}'
          '${appVersion == null ? '' : '\n내보낼 때의 앱 버전: $appVersion'}',
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
