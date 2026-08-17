// 0.3.0 P1 — the in-product disclosure of the CORE path, on the phone.
//
// The measurement the card started from: `soniox` and `deepseek` appeared ZERO
// times in either end's source, neither app had a privacy / terms / consent
// surface, and the only screen describing what leaves the device covered one
// optional PC-side feature. So each assertion below pins a sentence that did not
// exist, not a style preference.
//
// 🔴 RENDERED-RESULT, NOT `Text.data`. 0.2.53's lesson (see
// inject_verdict_note_test.dart's header) was that a suite can be green while
// the screen shows three letters: it asserted the widget's own data and the user
// reads what survives layout. So the disclosure assertions run through
// `pumpWidget` + `find.textContaining`, and the 「is it readable」 clause measures
// the rendered paragraph rather than the string it was built from.
//
// ⚠️ `flutter_test` uses the Ahem placeholder font — every glyph is a full em
// square, so this file is CONSERVATIVE about overflow: not clipped under Ahem
// ⇒ not clipped with a real font. The reverse does NOT follow, and nothing here
// may be read as 「it fits on a real device」.

import 'dart:io' show File;

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/support/legal_urls.dart';
import 'package:flowmic/src/ui/data_flow_disclosure_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart' show MethodCall, SystemChannels;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart' show LaunchMode;

import 'support/legibility.dart';

/// A 360 dp Android phone, the narrowest common width. `flutter_test`'s default
/// 800x600 surface is a tablet and would hide the layout question entirely —
/// precedent: `autostop_reason_wire_test.dart`'s `_narrowPhone`.
void _narrowPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

const List<AppLocale> kLocales = <AppLocale>[
  AppLocale.zh,
  AppLocale.en,
  AppLocale.ja,
  AppLocale.ko,
  AppLocale.zhTw,
  AppLocale.fr,
  AppLocale.es,
  AppLocale.de,
  AppLocale.ru,
];

/// The five stages, one unmistakable phrase per language. Written as a table
/// rather than 「contains the English word」 because a half-translated catalogue
/// is precisely what nine-language copy exists to prevent.
const Map<AppLocale, List<String>> kStageMarkers = <AppLocale, List<String>>{
  AppLocale.zh: <String>['采集音频', '语音识别', '语言模型处理', '打进当前输入框', '留下什么'],
  AppLocale.en: <String>[
    'records audio',
    'Speech recognition',
    'Language-model processing',
    'typed into the focused box',
    'left behind',
  ],
  AppLocale.ja: <String>['音声を取得', '音声認識', '言語モデル処理', 'フォーカス中の入力欄', '何が残るのか'],
  AppLocale.ko: <String>['음성을 수집', '음성 인식', '언어 모델 처리', '포커스된 입력창', '무엇이 남는가'],
  AppLocale.zhTw: <String>['採集音訊', '語音辨識', '語言模型處理', '打進目前輸入框', '留下什麼'],
  AppLocale.fr: <String>[
    'téléphone enregistre',
    'Reconnaissance vocale',
    'modèle de langue',
    'saisi dans le champ actif',
    'Ce qui reste',
  ],
  AppLocale.es: <String>[
    'graba audio',
    'Reconocimiento de voz',
    'modelo de idioma',
    'escritura en el campo activo',
    'Qué queda detrás',
  ],
  AppLocale.de: <String>[
    'nimmt Audio auf',
    'Spracherkennung',
    'Sprachmodell',
    'ins Fokusfeld eingefügt',
    'Was bleibt',
  ],
  AppLocale.ru: <String>[
    'записывает звук',
    'Распознавание речи',
    'языковой моделью',
    'вставлено в активное поле',
    'Что остаётся',
  ],
};

/// The vendors that actually process the data, per stage. Both are proper nouns
/// and are NOT translated, so one literal each covers all nine catalogues; the
/// per-locale loop is what proves no language dropped the sentence.
const String kSpeechVendor = 'Soniox';
const String kModelVendor = 'DeepSeek';

/// Phrasings that would turn the present-tense claim back into a plan.
///
/// 🔴 THIS TABLE USED TO BE `kNotYet` + `kOperatedByUs` AND THE ASSERTIONS
/// REQUIRED THEM. Until the engine switch the platform language model really did
/// run on our own machines, so a bare 「DeepSeek」 would have been a lie told
/// early and the guard demanded a not-yet marker beside the name. The switch
/// made the plan the fact; the guard was INVERTED in the same edit as the copy,
/// not deleted. The old strings are kept here verbatim as the first entry of
/// each row so that literally restoring the previous sentence fails loudly.
const Map<AppLocale, List<String>> kPlanHedges = <AppLocale, List<String>>{
  AppLocale.zh: <String>['尚未启用', '我们自己运营的服务器', '计划', '将来', '目前跑在'],
  AppLocale.en: <String>[
    'not in use yet',
    'runs on servers we operate',
    'plan to',
    'will change to the present tense',
  ],
  AppLocale.ja: <String>['まだ稼働していません', '当社が運用するサーバー上で動作', '計画', '将来'],
  AppLocale.ko: <String>['아직 사용하지 않습니다', '우리가 운영하는 서버에서 돌아갑니다', '계획', '앞으로'],
  // The five locales below never shipped the pre-switch sentence, so their rows
  // are authored plausible back-slides rather than verbatim history: the most
  // natural 「not yet in service」 / 「our own servers」 phrasings a translation
  // refresh or a well-meaning edit would reach for in each language.
  AppLocale.zhTw: <String>['尚未啟用', '我們自己運營的伺服器', '計劃', '計畫', '將來'],
  AppLocale.fr: <String>[
    'pas encore en service',
    'pas encore utilisé',
    'prévoyons de',
    'nos propres serveurs',
  ],
  AppLocale.es: <String>[
    'aún no está en uso',
    'todavía no',
    'planeamos',
    'nuestros propios servidores',
  ],
  AppLocale.de: <String>[
    'noch nicht im Einsatz',
    'noch nicht genutzt',
    'geplant',
    'auf unseren eigenen Servern',
  ],
  AppLocale.ru: <String>[
    'ещё не используется',
    'пока не',
    'планируем',
    'на наших собственных серверах',
  ],
};

// ── The LAN leg: ONE claim became THREE (DISC-1, 0.2.61) ────────────────────
//
// 🔴 THIS BLOCK REPLACED A SINGLE TABLE CALLED `kLanPlaintext`, and the reason it
// is three tables is the whole card. The old copy said the LAN leg is not
// encrypted and that the warning would stay until encryption shipped. 0.2.60
// shipped it — so the sentence expired on deploy day, and the obvious repair
// (say it is encrypted now) would have been a lie in the OTHER direction for two
// populations at once: pairings made before 0.2.60, and any deployment running
// the kill switch. A test that only banned the old sentence would grade that
// second lie as a pass, which is why every group below is a POSITIVE marker and
// the ban is scoped underneath them.

/// ① A QR-made pairing is TLS AND the pin is re-checked on every later dial —
/// not just at pairing time. Backed by lib/src/signaling/lan_pinning.dart
/// (`PinnedHttpClient._judge`) reached from four dial sites, enforced by
/// test/lan_pin_enforced_on_every_dial_test.dart. The second marker of each row
/// is the 「every later connection」 half specifically: a copy that only promised
/// encryption AT PAIRING would satisfy the first.
const Map<AppLocale, List<String>> kLanPinned = <AppLocale, List<String>>{
  AppLocale.zh: <String>['二维码里带着这台电脑的身份', '每一次连接都核对'],
  AppLocale.en: <String>[
    'carries the identity of the computer',
    'checks it on every later connection',
  ],
  AppLocale.ja: <String>['PC の身元が入っている', '接続ごとに照合'],
  AppLocale.ko: <String>['컴퓨터의 신원이 실려 있는', '연결마다 대조'],
  AppLocale.zhTw: <String>['帶著這臺電腦的身分', '每一次連線都核對'],
  AppLocale.fr: <String>[
    'porte l\'identité du PC',
    'vérifie à chaque connexion suivante',
  ],
  AppLocale.es: <String>[
    'lleva la identidad del PC',
    'comprueba en cada conexión posterior',
  ],
  AppLocale.de: <String>[
    'die Identität des PC trägt',
    'bei jeder späteren Verbindung',
  ],
  AppLocale.ru: <String>[
    'в коде есть личность компьютера',
    'при каждом следующем подключении',
  ],
};

/// ② The old warning is STILL TRUE for pairings made before 0.2.60, and there is
/// exactly one action that upgrades them. lib/src/ptt/ptt_session.dart, in
/// `resumePairing` — `pinFingerprint: session.lanTlsFp` is 「Null for an unpinned
/// row, which is every pre-D2-LAN pairing」 and that dial is 「byte-for-byte the
/// old one」; no auto-upgrade path exists.
///
/// ⚠️ The line number that used to be here (`:566-569`) is gone on purpose, not
/// lost: fix-026 added prose to `autoStopped`'s doc ~90 lines above it and the
/// dial slid to 583-587, reddening `coordinate-anchors` in a window that had
/// nothing to do with LAN pinning. The symbol names the same place and does not
/// move when somebody edits the file above it (IT-50 / IT-43's own header).
///
/// 🔴 THIS GROUP IS THE GUARD AGAINST THE OPPOSITE LIE. Deleting it would let a
/// blanket 「the LAN is encrypted now」 paragraph pass every other assertion here.
const Map<AppLocale, List<String>> kLanLegacyPlaintext = <AppLocale, List<String>>{
  AppLocale.zh: <String>['仍然是明文', '重新配对'],
  AppLocale.en: <String>['still in the clear', 'pairing again'],
  AppLocale.ja: <String>['今も平文', 'ペアリングし直す'],
  AppLocale.ko: <String>['지금도 평문', '다시 페어링'],
  AppLocale.zhTw: <String>['仍然是明文', '重新配對'],
  AppLocale.fr: <String>['restent en clair', 'un nouvel appairage'],
  AppLocale.es: <String>['siguen en claro', 'volver a emparejar'],
  AppLocale.de: <String>['noch im Klartext', 'erneut koppeln'],
  AppLocale.ru: <String>['всё ещё открыты', 'повторное сопряжение'],
};

/// ③ The kill switch. An env var name, so one literal covers all nine
/// catalogues — the per-locale loop is what proves no language dropped the
/// sentence, exactly as with the vendor names. apps/server-core/src/config.ts
/// `resolveLanTls` branch ② is the mechanism.
const String kLanKillSwitch = 'FLOWMIC_LAN_TLS';

/// ③b W6R's ruling: the switch is NOT a rollback, and that half must travel with
/// the first half wherever the switch is described. A pairing created under TLS
/// stored `https://` + the pin; `resumePairing` has no plaintext fallback, and
/// with no certificate seen `lastDialPinMismatch` is false — so this phone can
/// only report a failed connection, and delete-and-re-pair is the only way out.
/// Without these markers the copy could name the switch and leave the user
/// stranded, which is the state this card found the product in.
const Map<AppLocale, List<String>> kLanKillSwitchCost = <AppLocale, List<String>>{
  AppLocale.zh: <String>['连不上', '删掉这台电脑再配一次'],
  AppLocale.en: <String>[
    'can no longer connect',
    'deleting the computer on the phone and pairing again',
  ],
  AppLocale.ja: <String>['接続できなくなります', '削除してペアリングし直します'],
  AppLocale.ko: <String>['연결되지 않습니다', '삭제하고 다시 페어링'],
  AppLocale.zhTw: <String>['連不上', '刪掉這臺電腦再配一次'],
  AppLocale.fr: <String>[
    'ne peuvent plus se connecter',
    'supprimez le PC sur le téléphone et appariez à nouveau',
  ],
  AppLocale.es: <String>[
    'ya no pueden conectar',
    'borrando el PC en el teléfono y emparejando de nuevo',
  ],
  AppLocale.de: <String>[
    'kommen nicht mehr durch',
    'den PC auf dem Handy löschen und neu koppeln',
  ],
  AppLocale.ru: <String>[
    'больше не подключатся',
    'удалить компьютер на телефоне и сопрячь снова',
  ],
};

/// ④ The sentences this card replaced, as verbatim fragments per locale.
///
/// 🔴 KEPT RATHER THAN DELETED, for the same reason `kPlanHedges` is kept: the
/// failure mode is not 「someone writes a new wrong sentence」, it is 「someone
/// restores the old one」 — during a revert, a merge, or a translation refresh
/// pulled from an older catalogue. A marker table alone goes red with a message
/// about a missing phrase; this one names what actually happened.
const Map<AppLocale, List<String>> kLanExpiredClaims = <AppLocale, List<String>>{
  AppLocale.zh: <String>['局域网这条路目前没有加密', '加密还在做'],
  AppLocale.en: <String>[
    'route is not encrypted today',
    'Encryption for this leg is in development',
  ],
  AppLocale.ja: <String>['現在暗号化されていません', 'この区間の暗号化は開発中'],
  AppLocale.ko: <String>['현재 암호화되어 있지 않습니다', '이 구간의 암호화는 개발 중'],
  // The five locales below were born after 0.2.60, so the expired sentence
  // never existed in them; their rows are the phrasings a translation refresh
  // seeded from the four pre-D2-LAN catalogues would most plausibly produce.
  AppLocale.zhTw: <String>['區域網路這條路目前沒有加密', '加密還在做'],
  AppLocale.fr: <String>['pas encore chiffré', 'en cours de développement'],
  AppLocale.es: <String>['no está cifrada hoy', 'cifrado está en desarrollo'],
  AppLocale.de: <String>['heute nicht verschlüsselt', 'Verschlüsselung ist in Arbeit'],
  AppLocale.ru: <String>['сегодня не шифруется', 'ещё в разработке'],
};

Future<void> _pumpPage(
  WidgetTester tester,
  AppLocale locale, {
  DisclosureUrlLauncher? urlLauncher,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController settings = AppSettingsController(prefs: prefs);
  await settings.load();
  settings.setLocale(locale);
  await tester.pumpWidget(
    MaterialApp(
      home: DataFlowDisclosurePage(
        appSettings: settings,
        urlLauncher: urlLauncher ??
            ((Uri url, {required LaunchMode mode}) async => true),
      ),
    ),
  );
  await tester.pumpAndSettle();
  // Positive control on the harness itself: if the locale did not take, every
  // per-language assertion below would be measuring the default catalogue.
  expect(settings.locale, locale, reason: 'locale did not take on the controller');
}

Future<void> _scrollToLegal(WidgetTester tester) async {
  // ListView is lazy: the legal card is below the five-step card and
  // is not in the tree until it has been scrolled into view. Jump, don't
  // scrollUntilVisible: extra Scrollables appear once snackbars mount.
  final ScrollableState scroll = tester.state<ScrollableState>(
    find.byType(Scrollable).first,
  );
  scroll.position.jumpTo(scroll.position.maxScrollExtent);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders all five stages of the core path, in every UI language', (
    WidgetTester tester,
  ) async {
    for (final AppLocale loc in kLocales) {
      await _pumpPage(tester, loc);
      for (final String marker in kStageMarkers[loc]!) {
        expect(
          find.textContaining(marker, findRichText: true),
          findsWidgets,
          reason: '$loc is missing the stage 「$marker」',
        );
      }
    }
  });

  testWidgets('names both vendors — the words that appeared ZERO times before this card', (
    WidgetTester tester,
  ) async {
    for (final AppLocale loc in kLocales) {
      await _pumpPage(tester, loc);
      expect(
        find.textContaining(kSpeechVendor),
        findsWidgets,
        reason: '$loc never names the speech provider',
      );
      expect(
        find.textContaining(kModelVendor),
        findsWidgets,
        reason: '$loc never names the language-model provider',
      );
    }
  });

  test('each stage names ITS OWN processor and no other', () {
    // 「Soniox」 with no branches would read as 「everything you say goes to
    // Soniox」, which is false for a user key and false for a local engine.
    // The cross-checks matter for the same reason in the other direction: a
    // vendor named under the wrong stage tells the user their voice goes
    // somewhere it does not, which is the disclosure failing at its one job.
    for (final AppLocale loc in kLocales) {
      final AppStrings s = AppStrings.of(loc);
      expect(s.discStep2Cloud, contains(kSpeechVendor), reason: '$loc: cloud branch');
      expect(s.discStep2Byok, isNot(contains(kSpeechVendor)), reason: '$loc: BYOK branch');
      expect(s.discStep2Local, isNot(contains(kSpeechVendor)), reason: '$loc: local branch');
      expect(s.discStep3Body, contains(kModelVendor), reason: '$loc: model step');
      expect(s.discStep3Body, isNot(contains(kSpeechVendor)), reason: '$loc: speech vendor in the model step');
      for (final String branch in <String>[s.discStep2Cloud, s.discStep2Byok, s.discStep2Local]) {
        expect(branch, isNot(contains(kModelVendor)), reason: '$loc: model vendor on a speech branch');
      }
    }
  });

  testWidgets('🔴 the seeded tier is named without claiming it is local (REQ-13-09)', (
    WidgetTester tester,
  ) async {
    // The ORDER paragraph used to end 「…都没有时，用首次开机时替你预置的那两条
    // 本地引擎路由」 / 「the two LOCAL engine routes we seeded for you at first
    // boot」. That adjective is a claim about whose hardware those two engines
    // run on, and nothing this app can see decides it:
    //   apps/server-core/src/settings/defaults.ts buildDefaultSettings() takes
    //   the seed preset ids from FLOWMIC_DEFAULT_STT_ZH_PRESET /
    //   FLOWMIC_DEFAULT_STT_WILDCARD_PRESET and accepts any id in
    //   packages/protocol/src/engine-presets.ts — a catalogue holding
    //   `cloud-deepgram` (wss://api.deepgram.com) and `cloud-openai-realtime`,
    //   whose LAN entries are additionally re-pointed by
    //   FLOWMIC_DEFAULT_STT_HOST at a machine the OPERATOR runs.
    // True of a stock install; false of the hosted service `discScopeNote` says
    // this page describes. It is the shard header's own law — never a user-facing
    // sentence whose truth depends on the current value of a server-side switch
    // — applied to a clause written before that law existed.
    //
    // ⚠️ SCOPED TO `discStep2Body`. 「本地 / local」 is honest one string over, in
    // `discStep2Local`, which is the branch that says what a local engine IS —
    // so the positive control asserts the word SURVIVES there. Without it,
    // deleting the word everywhere (including from the sentence whose whole job
    // is to define it) would pass this test.
    const Map<AppLocale, String> localityWord = <AppLocale, String>{
      AppLocale.zh: '本地',
      AppLocale.en: 'local',
      AppLocale.ja: 'ローカル',
      AppLocale.ko: '로컬',
      AppLocale.zhTw: '本地',
      AppLocale.fr: 'local',
      AppLocale.es: 'local',
      // Substring of both 'lokale' and 'lokal' — case-sensitively lowercase,
      // which is what the copy uses ('Eine lokale Engine').
      AppLocale.de: 'lokal',
      // 'Локальный' opens the bullet capitalized; the fragment is case-robust
      // (matches 'Локальн…' and 'локальн…' alike) so a mid-sentence rewrite
      // cannot dodge the ban by changing case.
      AppLocale.ru: 'окальн',
    };
    // The tier must still be NAMED — dropping it outright would restore the W1.5
    // defect (the 「转录直接报错停止」 clause goes false when the seeded rows that
    // are served BEFORE the error are left out of the list).
    const Map<AppLocale, String> tierMarker = <AppLocale, String>{
      AppLocale.zh: '首次开机时替你预置',
      AppLocale.en: 'we seeded for you at first boot',
      AppLocale.ja: '初回起動時に用意した',
      AppLocale.ko: '첫 실행 때 미리 넣어 둔',
      AppLocale.zhTw: '首次開機時替你預置',
      AppLocale.fr: 'préparées au premier démarrage',
      AppLocale.es: 'preparamos al primer arranque',
      AppLocale.de: 'beim ersten Start angelegt',
      AppLocale.ru: 'заданные при первом запуске',
    };
    for (final AppLocale loc in kLocales) {
      final AppStrings s = AppStrings.of(loc);
      expect(
        s.discStep2Body,
        contains(tierMarker[loc]!),
        reason: "$loc: the seeded tier vanished from the engine order — that is W1.5's defect, not this card's fix",
      );
      expect(
        s.discStep2Body,
        isNot(contains(localityWord[loc]!)),
        reason: '$loc: the engine order grades the seeded tier as 「${localityWord[loc]}」. '
            'Which engines get seeded is an env var (FLOWMIC_DEFAULT_STT_*_PRESET) and can be a '
            'cloud vendor — this page cannot promise where they run.',
      );
      expect(
        s.discStep2Local,
        contains(localityWord[loc]!),
        reason: '$loc: the local-engine BRANCH lost the word 「${localityWord[loc]}」 — the ban leaked out of discStep2Body',
      );
      // …and the paragraph really reaches the screen, not just the catalogue.
      await _pumpPage(tester, loc);
      expect(
        find.textContaining(tierMarker[loc]!),
        findsWidgets,
        reason: '$loc: the engine-order paragraph is not rendered',
      );
    }
  });

  testWidgets('🔴 the local-engine line scopes its claim to speech and points text at ③ (REQ-13-09 / Q12㋐)', (
    WidgetTester tester,
  ) async {
    // The line used to end at 「什么都不离开你自己的设备」 / 「nothing leaves your
    // own hardware」. Inside ②'s numbering that is TRUE — this bullet is one
    // branch of 「which engine hears you」, and where the TEXT goes afterwards is
    // ③'s subject. The audit graded it accurate for exactly that reason
    // (docs/strategy/2026-08-13-req1309-stt-llm-audit.md A2).
    //
    // 🔴 SO WHY GUARD A TRUE SENTENCE: because the numbering is not part of the
    // sentence. This line is quotable on its own — a screenshot, a support
    // reply, a review — and alone it says the words never leave the device,
    // which is false the moment Translate/Organize run or 「AI polish」 is on:
    //   apps/server-core/src/engine/stt-factory.ts resolvePolishDep() resolves
    //   through the same resolveLlmConfigWithSource() as compose/llm-config.ts,
    //   and packages/protocol/src/engine-presets.ts lets that endpoint be a
    //   cloud vendor.
    // owner ruled ㋐ (task book §14 Q12): pay one clause for a sentence that
    // survives being quoted alone.
    //
    // ⚠️ TWO MARKERS PER LOCALE, NOT ONE, because the clause makes two moves and
    // either one alone is a worse sentence than the original: [0] names the leg
    // (a scope with no forwarding leaves the reader with a question and no
    // address), [1] forwards the other question to ③ (a pointer with no scope
    // reads as if ③ contradicts this line). A rewrite that keeps one and drops
    // the other must go red.
    //
    // ⚠️ THIS TEST DOES NOT ASSERT ③'s BODY. ③ already says where text goes and
    // says it better than a duplicate here would; the clause forwards, it does
    // not re-state. Asserting ③ from here would make one card own two sentences
    // — the shape the repo keeps paying for.
    const Map<AppLocale, List<String>> textDestinationQualifier =
        <AppLocale, List<String>>{
      AppLocale.zh: <String>['说的是语音', '文字之后去哪，见 ③'],
      AppLocale.en: <String>[
        'that is about your voice',
        'where the text goes next is step 3',
      ],
      AppLocale.ja: <String>['これは音声の話です', 'テキストがその後どこへ行くかは ③'],
      AppLocale.ko: <String>['음성에 대한 이야기', '텍스트가 그다음 어디로 가는지는 ③'],
      AppLocale.zhTw: <String>['說的是語音', '文字之後去哪，見 ③'],
      AppLocale.fr: <String>[
        'il s\'agit de votre voix',
        'où va le texte ensuite, voir l\'étape 3',
      ],
      AppLocale.es: <String>[
        'eso es tu voz',
        'a dónde va el texto después es el paso 3',
      ],
      AppLocale.de: <String>[
        'das betrifft Ihre Stimme',
        'wohin der Text danach geht, ist Schritt 3',
      ],
      AppLocale.ru: <String>[
        'речь о голосе',
        'куда дальше идёт текст, см. шаг 3',
      ],
    };
    // owner's verbatim opt-in sentence (ruling 2026-08-11 / deferred-batch #12).
    // The clause was inserted BEFORE it; if a future edit rewrites the bullet and
    // loses this, that is a separate owner-ruled sentence going missing, and it
    // should not hide behind a green qualifier assertion.
    const String optInFlag = 'FLOWMIC_SHERPA_AUTO_DOWNLOAD=1';
    for (final AppLocale loc in kLocales) {
      final AppStrings s = AppStrings.of(loc);
      final String line = s.discStep2Local;
      for (final String marker in textDestinationQualifier[loc]!) {
        expect(
          line,
          contains(marker),
          reason: '$loc: the local-engine line dropped 「$marker」. Read on its own — '
              'and it will be, this is a promise surface — 「nothing leaves your '
              'device」 is false for the text once Translate/Organize run or AI '
              'polish is on. The clause is what makes the sentence survive being '
              'quoted without its ② heading.',
        );
      }
      expect(
        line,
        contains(optInFlag),
        reason: "$loc: owner's opt-in sentence (2026-08-11) vanished from the "
            'local-engine line — the REQ-13-09 clause goes BEFORE it, never instead of it',
      );

      // …and the qualified sentence really reaches a 360 dp screen. 0.2.53's law:
      // the assertion lands on the RENDERED paragraph, because a suite can be
      // green while the user reads three letters. The clause makes an already
      // long bullet longer, so this is the measurement that says the cost was
      // affordable.
      //
      // ⚠️ Ahem: every glyph is a full em square, far wider than a real font ⇒
      // 「not clipped here ⇒ not clipped on a device」 holds, and the converse
      // does NOT. Nothing here may be read as 「it fits on a real phone」.
      _narrowPhone(tester);
      await _pumpPage(tester, loc);
      expectLegible(
        tester,
        find.text(line),
        reason: '$loc: the qualified local-engine line at 360dp',
      );
    }
  });

  testWidgets('🔴 DeepSeek is stated as a PRESENT FACT — no 「planned / not yet」 hedge survives', (
    WidgetTester tester,
  ) async {
    // 🔴 THIS GUARD WAS INVERTED, NOT DELETED. Its previous form required a
    // not-yet marker beside the name, and was correct while the platform model
    // still ran on our own machines. The engine switch made the plan the fact,
    // so the assertion turned around in the same edit as the copy: the vendor
    // that processes the text must be NAMED, and every phrasing that would sell
    // it back as a plan must be absent. Drifting backwards is now as loud a
    // failure as jumping ahead used to be.
    //
    // ⚠️ Two levels on purpose. `find.textContaining` proves the sentence is
    // MOUNTED (a catalogue string nobody renders is this repo's oldest façade);
    // the hedge ban is asserted against `discStep3Body` specifically, because
    // banning a word page-wide would eventually forbid an honest sentence
    // somewhere else — the exact mistake narrowed out of
    // scenario-inference-consent.test.ts.
    for (final AppLocale loc in kLocales) {
      await _pumpPage(tester, loc);
      // Unconditional, where the old version had `if (…isEmpty) continue;` — a
      // dropped name used to be caught by a counter at the end, and is now
      // caught here, one locale at a time, with the locale in the message.
      expect(
        find.textContaining(kModelVendor),
        findsWidgets,
        reason: '$loc does not tell the user whose servers process their text',
      );
      final AppStrings s = AppStrings.of(loc);
      expect(s.discStep3Body, contains(kModelVendor), reason: '$loc: vendor not in the LLM step');
      for (final String hedge in kPlanHedges[loc]!) {
        expect(
          s.discStep3Body,
          isNot(contains(hedge)),
          reason: '$loc: the LLM sentence slid back into a plan (「$hedge」)',
        );
      }
    }
  });

  testWidgets('🔴 the LAN leg is told as THREE truths — 0.2.60 pairings, older ones, and the kill switch', (
    WidgetTester tester,
  ) async {
    // ⚠️ Two levels, same as the DeepSeek guard above: the pump proves the
    // paragraph is MOUNTED (a catalogue string nobody renders is this repo's
    // oldest façade), and the markers are asserted against `discStep4LanPlain`
    // specifically so the ban below can be scoped to the same getter without
    // ever reaching a legitimate sentence elsewhere.
    for (final AppLocale loc in kLocales) {
      await _pumpPage(tester, loc);
      final AppStrings s = AppStrings.of(loc);
      final String line = s.discStep4LanPlain;
      expect(
        find.textContaining(line, findRichText: true),
        findsWidgets,
        reason: '$loc: the LAN paragraph is not mounted',
      );

      for (final String m in kLanPinned[loc]!) {
        expect(
          line,
          contains(m),
          reason:
              '$loc: the LAN paragraph does not say the pairing is encrypted AND '
              're-checked (「$m」). The pin is verified on every dial '
              '(lan_pinning.dart), and a copy that only promises it at pairing '
              'time undersells what this phone actually does.',
        );
      }
      for (final String m in kLanLegacyPlaintext[loc]!) {
        expect(
          line,
          contains(m),
          reason:
              '$loc: the LAN paragraph dropped the pre-0.2.60 half (「$m」). Those '
              'pairings are still plaintext — ptt_session.dart:566-569, no '
              'auto-upgrade — so a blanket 「it is encrypted now」 is a NEW lie, '
              'not a fix for the old one, and re-pairing is the only action that '
              'moves them.',
        );
      }
      // 🔴 In-place correction (WP3 C16, 2026-08-18): the two REQUIRED
      // kill-switch assertions that stood here are retired, not weakened by
      // stealth. Owner 2026-08-17 ruled the disclosure surfaces down to a
      // diagram with short captions, with the fine print behind the web
      // links; the FLOWMIC_LAN_TLS=0 mechanics — an operator-side env toggle,
      // its lockout cost, and the delete-and-re-pair recovery — moved to
      // docs/legal/privacy-policy.md (its LAN channel section already carried
      // all three), and `discDetailsOnSite` is the on-screen pointer. Claim ①
      // keeps its referent without the switch: the condition is now 「how the
      // pairing was made」, which the copy states directly.
      //
      // ⚠️ What survives of W6R's rule is the TRAVEL-TOGETHER half, as a
      // conditional: if any future copy edit brings the switch's name back
      // onto this screen, its cost must come back with it — naming the switch
      // without the cost is the exact stranded-user state W6R found.
      if (line.contains(kLanKillSwitch)) {
        for (final String m in kLanKillSwitchCost[loc]!) {
          expect(
            line,
            contains(m),
            reason:
                '$loc: the switch came back without what it costs (「$m」). W6R: '
                'it is NOT a rollback — phones paired under TLS can no longer '
                'connect, and delete-and-re-pair is the only recovery.',
          );
        }
      }
      // The pointer to where the moved fine print lives must itself be real.
      expect(
        s.discDetailsOnSite.trim(),
        isNotEmpty,
        reason: '$loc: the moved LAN fine print has no on-screen pointer',
      );
    }
  });

  testWidgets('🔴 the paragraph points at a section that really exists, by its real name', (
    WidgetTester tester,
  ) async {
    // The copy deliberately refuses to assert the CURRENT value of the LAN
    // encryption (the law in disclosure_strings.dart's header: a sentence whose
    // truth depends on a switch is a lie waiting for the switch to move), and
    // instead says where the value IS shown — the same shape stage ③ uses for
    // AI polish.
    //
    // 🔴 That makes it anti-façade ④: a user-facing string asserting the behaviour
    // of a DIFFERENT screen. Per the law 「an assertion about behaviour elsewhere
    // must either give a greppable anchor or be pinned by a test」, this is the
    // test. Asserting the live getter rather than a literal is the entire point:
    // renaming the section in connection_strings.dart now fails HERE instead of
    // silently orphaning the sentence — which is exactly how the desktop's
    // pairing.ts 「the phone does not read fp= yet」 comment survived being false.
    for (final AppLocale loc in kLocales) {
      await _pumpPage(tester, loc);
      final AppStrings s = AppStrings.of(loc);
      expect(
        s.discStep4LanPlain,
        contains(s.diagEncryptionSection),
        reason:
            '$loc: the LAN paragraph sends the reader to a section named '
            '「${s.diagEncryptionSection}」 that it does not actually name. Either '
            'the section was renamed or the pointer was dropped; a pointer to a '
            'heading the user cannot find is worse than no pointer.',
      );
      // Positive control on the anchor itself: an empty getter would make the
      // `contains` above vacuously true for every locale.
      expect(
        s.diagEncryptionSection.trim(),
        isNotEmpty,
        reason: '$loc: diagEncryptionSection is empty — the anchor proves nothing',
      );
    }
  });

  test('🔴 the expired 「not encrypted」 sentence cannot come back', () {
    // The positive markers above already fail if the old copy returns, so this
    // is not redundancy for its own sake: it is the test that names WHAT
    // happened. A revert, a merge, or a translation refresh pulled from an older
    // catalogue produces exactly this, and 「missing phrase X」 sends the reader
    // hunting while 「the pre-0.2.60 sentence is back」 does not.
    //
    // ⚠️ Scoped to `discStep4LanPlain`, never page-wide — 「未加密」 / 「not
    // encrypted」 are honest words elsewhere (this app's own connection-status
    // tier says exactly that), and a page-wide ban would eventually forbid a
    // true sentence. Same narrowing the two guards above already had to make.
    for (final AppLocale loc in kLocales) {
      final String line = AppStrings.of(loc).discStep4LanPlain;
      for (final String stale in kLanExpiredClaims[loc]!) {
        expect(
          line,
          isNot(contains(stale)),
          reason:
              '$loc: the LAN paragraph is back to the pre-0.2.60 claim (「$stale」). '
              'LAN TLS shipped in 0.2.60; this sentence expired the day it '
              'deployed.',
        );
      }
    }
  });

  test('🔴 the legal URLs are the live site paths — no locale guess, no repo path', () {
    // The site is a four-language SPA; locale lives in localStorage, not
    // the path. A `?lang=` the site does not read would be a guess.
    expect(kPrivacyPolicyUrl, 'https://flowmic.app/privacy');
    expect(kTermsOfServiceUrl, 'https://flowmic.app/terms');
    expect(kPrivacyPolicyUrl.contains('lang='), isFalse);
    expect(kTermsOfServiceUrl.contains('lang='), isFalse);
    expect(kPrivacyPolicyUrl.contains('docs/legal'), isFalse);
    expect(kTermsOfServiceUrl.contains('docs/legal'), isFalse);
  });

  testWidgets('🔴 the legal block offers the live site pages, not the unpublished lie', (
    WidgetTester tester,
  ) async {
    // INVERTED, not deleted. The previous form required no URL and a
    // docs/legal/ path because those pages were unpublished. They are live
    // (HTTP 200, 2026-08-14). Restoring the old sentences must go red.
    //
    // ⚠️ Rendered result, not Text.data: the user reads what survives
    // layout. The destination stays on screen so a failed open still
    // leaves the address readable; the tap itself is proven by the
    // launcher-call tests below, not by a widget existing.
    for (final AppLocale loc in kLocales) {
      await _pumpPage(tester, loc);
      final AppStrings s = AppStrings.of(loc);
      await _scrollToLegal(tester);
      expect(
        find.text(s.discLegalPrivacy),
        findsWidgets,
        reason: '$loc: privacy label not on screen',
      );
      expect(
        find.text(s.discLegalTerms),
        findsWidgets,
        reason: '$loc: terms label not on screen',
      );
      expect(
        find.text(s.discOpenInBrowser),
        findsWidgets,
        reason: '$loc: open-in-browser label not on screen',
      );
      expect(
        find.text(kPrivacyPolicyUrl),
        findsWidgets,
        reason: '$loc: privacy URL not rendered',
      );
      expect(
        find.text(kTermsOfServiceUrl),
        findsWidgets,
        reason: '$loc: terms URL not rendered',
      );
      expect(
        find.textContaining('docs/legal/'),
        findsNothing,
        reason: '$loc: the repo-path sentence came back',
      );
      expect(
        find.textContaining('privacy-policy.md'),
        findsNothing,
        reason: '$loc: the unpublished-file sentence came back',
      );
      expect(
        find.textContaining('not yet published'),
        findsNothing,
        reason: '$loc: the unpublished lie came back',
      );
    }
  });

  testWidgets('tapping each legal affordance calls the launcher with that page\'s URL', (
    WidgetTester tester,
  ) async {
    final List<({Uri url, LaunchMode mode})> launches =
        <({Uri url, LaunchMode mode})>[];
    Future<bool> launcher(Uri url, {required LaunchMode mode}) async {
      launches.add((url: url, mode: mode));
      return true;
    }

    await _pumpPage(tester, AppLocale.en, urlLauncher: launcher);
    await _scrollToLegal(tester);

    await tester.tap(find.byKey(const ValueKey<String>('disclosure.legal.privacy')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('disclosure.legal.terms')));
    await tester.pump();

    expect(launches, hasLength(2), reason: 'each legal row must call the launcher');
    expect(launches[0].url.toString(), kPrivacyPolicyUrl);
    expect(launches[1].url.toString(), kTermsOfServiceUrl);
    expect(
      launches.every((({Uri url, LaunchMode mode}) c) =>
          c.mode == LaunchMode.externalApplication),
      isTrue,
      reason: 'owner asked to link out — in-app WebView is the wrong mode',
    );
    expect(
      find.text(AppStrings.of(AppLocale.en).discOpenFailed),
      findsNothing,
      reason: 'a successful open must not surface the failure path',
    );
  });

  testWidgets('🔴 a failed launch tells the user and leaves copy reachable', (
    WidgetTester tester,
  ) async {
    final List<MethodCall> platformCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (MethodCall call) async {
        platformCalls.add(call);
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    Future<bool> launcher(Uri url, {required LaunchMode mode}) async => false;
    await _pumpPage(tester, AppLocale.en, urlLauncher: launcher);
    await _scrollToLegal(tester);
    await tester.tap(find.byKey(const ValueKey<String>('disclosure.legal.privacy')));
    await tester.pump();

    final AppStrings s = AppStrings.of(AppLocale.en);
    expect(
      find.text(s.discOpenFailed),
      findsWidgets,
      reason: 'launchUrl returned false — the user must be told, not left with a dead tap',
    );
    final Finder copy = find.byKey(
      const ValueKey<String>('disclosure.legal.privacy.copy'),
    );
    expect(copy, findsOneWidget, reason: 'copy fallback must appear after a failed open');
    expect(find.text(s.discCopyLink), findsWidgets);

    await tester.ensureVisible(copy);
    await tester.tap(copy);
    await tester.pump();
    final Iterable<MethodCall> setData =
        platformCalls.where((MethodCall c) => c.method == 'Clipboard.setData');
    expect(setData, hasLength(1), reason: 'exactly one clipboard write');
    final Map<Object?, Object?> args =
        setData.single.arguments as Map<Object?, Object?>;
    expect(args['text'], kPrivacyPolicyUrl);
    await tester.pump();
    expect(find.text(s.discLinkCopied), findsOneWidget);
  });

  testWidgets('🔴 a throwing launch is the same failure, never a silent no-op', (
    WidgetTester tester,
  ) async {
    Future<bool> launcher(Uri url, {required LaunchMode mode}) async {
      throw Exception('no activity to handle VIEW');
    }

    await _pumpPage(tester, AppLocale.en, urlLauncher: launcher);
    await _scrollToLegal(tester);
    await tester.tap(find.byKey(const ValueKey<String>('disclosure.legal.privacy')));
    await tester.pump();

    final AppStrings s = AppStrings.of(AppLocale.en);
    expect(
      find.text(s.discOpenFailed),
      findsWidgets,
      reason: 'a throwing launchUrl must surface the same failure the false-return path does',
    );
    expect(
      find.byKey(const ValueKey<String>('disclosure.legal.privacy.copy')),
      findsOneWidget,
      reason: 'copy fallback must appear when the opener throws',
    );
    expect(find.text(s.discCopyLink), findsWidgets);
  });

  test('anti-façade: the deleted unpublished sentences have no remaining call site', () {
    final String shard = File('lib/src/settings/strings/disclosure_strings.dart').readAsStringSync();
    final String page = File('lib/src/ui/data_flow_disclosure_page.dart').readAsStringSync();
    expect(shard.contains('discLegalStatus'), isFalse, reason: 'status getter survived');
    expect(shard.contains('discLegalWhere'), isFalse, reason: 'where getter survived');
    expect(page.contains('discLegalStatus'), isFalse);
    expect(page.contains('discLegalWhere'), isFalse);
    expect(page.contains('kPrivacyPolicyUrl'), isTrue, reason: 'page must read the constant');
    expect(page.contains('kTermsOfServiceUrl'), isTrue);
    expect(page.contains('package:url_launcher/url_launcher.dart'), isTrue);
    expect(page.contains('LaunchMode.externalApplication'), isTrue);
  });

  testWidgets('🔴 rendered-result: no disclosure paragraph is clipped away', (
    WidgetTester tester,
  ) async {
    // 0.2.53's lesson, applied: the sentences on this page are long, they sit in
    // a scrolling column, and 「the user can read them」 is the whole point of the
    // card. Assert the rendered paragraph, not the string it came from.
    await _pumpPage(tester, AppLocale.zh);
    final Iterable<RenderParagraph> paragraphs = tester
        .renderObjectList<RenderParagraph>(find.byType(RichText));
    var checked = 0;
    for (final RenderParagraph p in paragraphs) {
      final String plain = p.text.toPlainText();
      if (plain.length < 20) continue; // titles/labels, not prose
      checked += 1;
      // 🔴 W5a §8-2 fix: `didExceedMaxLines` alone is vacuous here —
      // `data_flow_disclosure_page.dart` never sets `maxLines` on any of its
      // Text widgets, so the getter is structurally false whether or not a
      // sentence actually got clipped. `expectParagraphLegible`
      // (support/legibility.dart) picks its criterion from the paragraph's
      // own structure instead of assuming `maxLines` is set (same fix
      // `page_guides_test.dart` applied under W5a P1-1 for the identical
      // shape).
      expectParagraphLegible(
        p,
        reason: 'clipped: ${plain.substring(0, plain.length < 24 ? plain.length : 24)}…',
      );
    }
    // Positive control: a page that rendered nothing would satisfy the loop
    // above without a single character being examined.
    expect(checked, greaterThan(8), reason: 'too few paragraphs — did the page render?');
  });

  test('anti-façade: the home screen really constructs and opens this page', () {
    // A disclosure nobody can reach is the same as no disclosure, and 「it is
    // wired」 is exactly the kind of claim this repo has been burned by. The
    // production call site is READ, not described: connections_page.dart is the
    // home screen (the first screen a new install shows, before any pairing
    // exists), and it must import the page, build the entry, AND mount it.
    //
    // 🔴 THE LAST CLAUSE IS NOT DECORATION — the reverse control for this test
    // found it missing. With only the first three assertions, deleting
    // `_disclosureEntry(s)` from the ListView children left the whole file GREEN:
    // the builder method still existed, still constructed the page, still carried
    // the key — and nothing rendered. That is book 13 §7 F1 ① exactly (a lost call
    // site has no new symbol to grep), reproduced inside the guard written to
    // prevent it.
    //
    // ⚠️ What this does NOT prove: that the row is visible without scrolling, or
    // that it is tappable on a real device. It proves the widget tree contains
    // it. The rendered-result clause above covers legibility of the page itself.
    final String home = File('lib/src/ui/connections_page.dart').readAsStringSync();
    final String entry = File('lib/src/ui/data_flow_disclosure_entry.dart').readAsStringSync();
    expect(home, contains("import 'data_flow_disclosure_entry.dart';"));
    // 🔴 The MOUNT, not just the import. The row itself lives in its own file
    // (connections_page.dart crossed the 800-line cap), so 「the entry exists」
    // and 「the home screen renders it」 are now two different files' worth of
    // truth and both are asserted.
    expect(
      home,
      contains('DataFlowDisclosureEntry(appSettings: widget.appSettings)'),
      reason: 'entry is MOUNTED on the home screen',
    );
    expect(entry, contains('class DataFlowDisclosureEntry'));
    expect(entry, contains('DataFlowDisclosurePage(appSettings: appSettings)'));
    expect(entry, contains("ValueKey<String>('connections.disclosure')"));
    // The entry renders the label AND the one-line summary, so a user who never
    // taps still learns the shape of the path.
    expect(entry, contains('s.discEntry'));
    expect(entry, contains('s.discEntrySub'));
    for (final AppLocale loc in kLocales) {
      final AppStrings s = AppStrings.of(loc);
      expect(s.discEntry.trim(), isNotEmpty, reason: '$loc entry label');
      expect(s.discEntrySub.trim(), isNotEmpty, reason: '$loc entry subtitle');
    }
  });
}
