// 0.3.0 P1 — the in-product disclosure of the CORE path.
//
// The measurement this card started from: `soniox` and `deepseek` appeared ZERO
// times in either end's source, there was no privacy or terms surface anywhere,
// and the only screen explaining what leaves the device was the scenario-
// inference consent panel — which covers one optional feature. So the assertions
// here are not style checks; each one pins a sentence that did not exist.
//
// Three of them are shaped by mistakes this repo has already paid for:
//
//  · 【rendered-result】 the copy is asserted through renderToString, not by
//    reading the catalogue. A string that exists and is never mounted is the
//    façade this repo has caught more than once.
//  · 【DeepSeek is a PRESENT FACT】 this bullet used to say the opposite, and the
//    guard below used to enforce the opposite: while the platform language model
//    still ran on machines we operate, the vendor name could appear only beside
//    a not-yet marker. The engine switch made the plan the fact, so the guard
//    was INVERTED in the same edit as the copy — the vendor that processes the
//    text must be named, and every 「planned / not yet」 phrasing must be gone.
//  · 【live legal links】 owner 2026-08-14: privacy and terms open the published
//    website pages. The previous guard banned every anchor because those pages
//    did not exist; that sentence expired the day they returned HTTP 200. The
//    replacement asserts the two live URLs are mounted, and that the expired
//    「unpublished / docs/legal/」 copy cannot come back.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import DataFlowDisclosure from './components/DataFlowDisclosure.vue';
import { S_BY_LOCALE, setLocale } from '../lib/strings';
import { DISCLOSURE_PRIVACY_URL, DISCLOSURE_TERMS_URL } from '../lib/strings/disclosure';

// All nine shipped languages, from the generated registry — hardcoding four
// here is how the five 2026-08-14 locales ran for a day with every guard in
// this file silently not covering them.
import { UI_LOCALES, type UiLocale } from '../lib/strings/generated/locales.g';

const LOCALES = UI_LOCALES;
type Loc = UiLocale;

async function renderIn(loc: Loc): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp(DataFlowDisclosure));
  setLocale('zh-CN');
  return html;
}

/** Vue's SSR text escaping. Catalogue strings with apostrophes (fr) or straight
 *  quotes (de „…") are entity-escaped in the serialized markup, so asserting a
 *  RAW catalogue string against `renderIn`'s output would fail for exactly the
 *  languages this file exists to cover. Same table as scripts elsewhere use. */
function ssrEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One phrase per locale that only the intended sentence can satisfy. Kept as
 *  tables rather than 「contains the English word」 because a half-translated
 *  catalogue is exactly the failure four-language copy is supposed to prevent. */
const STEP_MARKERS: Record<Loc, readonly string[]> = {
  'zh-CN': ['手机采集音频', '语音识别', '语言模型处理', '打进当前输入框', '留下什么'],
  en: ['records audio', 'Speech recognition', 'Language-model processing', 'typed into the focused box', 'left behind'],
  ja: ['音声を取得', '音声認識', '言語モデル処理', 'フォーカス中の入力欄', '何が残るのか'],
  ko: ['음성을 수집', '음성 인식', '언어 모델 처리', '포커스된 입력창', '무엇이 남는가'],
  'zh-TW': ['擷取音訊', '語音辨識', '語言模型處理', '取得焦點的輸入框', '留下什麼'],
  fr: ['votre téléphone capte', 'Reconnaissance vocale', 'Traitement par le modèle de langage', 'saisi dans le champ actif', 'Ce qui reste'],
  es: ['capta el audio', 'Reconocimiento de voz', 'Procesado por el modelo de lenguaje', 'se escribe en el campo enfocado', 'Qué queda guardado'],
  de: ['nimmt dein Handy Audio auf', 'Spracherkennung', 'Verarbeitung durch das Sprachmodell', 'in das fokussierte Feld getippt', 'Was zurückbleibt'],
  ru: ['записывает звук', 'Распознавание речи', 'Обработка языковой моделью', 'вводится в активное поле', 'Что остаётся'],
};

/** The vendors that actually process the data, per stage. Both are proper nouns
 *  and are NOT translated, so one literal each covers all four catalogues; the
 *  per-locale loop is what proves no language dropped the sentence. */
const SPEECH_VENDOR = 'Soniox';
const MODEL_VENDOR = 'DeepSeek';

/** Phrasings that assert WHICH VALUE the polish switch has. Each is a real
 *  fragment of the copy this card replaced, per locale — so the table is a record
 *  of what was actually said, not a guess at what someone might write. */
const DEFAULT_VALUE_CLAIMS: Record<Loc, readonly string[]> = {
  'zh-CN': ['默认关闭', '默认开启', '缺省关', '缺省开', '你若自己打开'],
  en: ['off by default', 'on by default', 'unless you switch it on', 'switched on', 'you turned on'],
  ja: ['デフォルトはオフ', 'デフォルトはオン', '既定ではオフ', '有効にしている場合'],
  ko: ['기본 꺼짐', '기본 켜짐', '기본값은 꺼', '직접 켜 두었다면'],
  'zh-TW': ['預設關閉', '預設開啟', '預設為關', '你若自己開啟'],
  fr: ['désactivé par défaut', 'activé par défaut'],
  es: ['desactivado por defecto', 'activado por defecto'],
  de: ['standardmäßig deaktiviert', 'standardmäßig aktiviert', 'standardmäßig aus', 'standardmäßig ein'],
  ru: ['по умолчанию включ', 'по умолчанию выключ', 'включён по умолчанию'],
};

/** The clause that replaces them: where the reader can see the current value.
 *  This is the POSITIVE control for the ban above. */
const WHERE_TO_SEE_IT: Record<Loc, string> = {
  'zh-CN': '设置 → 语音识别',
  en: 'Settings → Speech recognition',
  ja: '設定 → 音声認識',
  ko: '설정 → 음성 인식',
  'zh-TW': '設定 → 語音辨識',
  fr: 'Paramètres → Reconnaissance vocale',
  es: 'Ajustes → Reconocimiento de voz',
  de: 'Einstellungen → Spracherkennung',
  ru: 'Настройки → Распознавание речи',
};

/** Phrasings that would turn the present-tense claim back into a plan.
 *
 *  🔴 THIS TABLE USED TO BE `NOT_YET` + `OPERATED_BY_US` AND THE ASSERTIONS
 *  REQUIRED THEM. Until the engine switch the platform language model really did
 *  run on our own machines, so a bare 「DeepSeek」 would have been a lie told
 *  early and the guard demanded a not-yet marker beside the name. The switch
 *  made the plan the fact; the guard was INVERTED in the same edit as the copy,
 *  not deleted. The old strings are kept verbatim as the first entries of each
 *  row, so literally restoring the previous sentence fails loudly. */
const PLAN_HEDGES: Record<Loc, readonly string[]> = {
  'zh-CN': ['尚未启用', '我们自己运营的服务器', '计划', '将来', '目前跑在'],
  en: ['not in use yet', 'runs on servers we operate', 'plan to', 'will change to the present tense'],
  ja: ['まだ稼働していません', '当社が運用するサーバー上で動作', '計画', '将来'],
  ko: ['아직 사용하지 않습니다', '우리가 운영하는 서버에서 돌아갑니다', '계획', '앞으로'],
  'zh-TW': ['尚未啟用', '計畫', '將來'],
  fr: ['pas encore en service', 'prévoyons', "à l'avenir"],
  es: ['aún no está en uso', 'planeamos', 'en el futuro'],
  de: ['noch nicht im Einsatz', 'geplant', 'in Zukunft'],
  ru: ['ещё не используется', 'планируем', 'в будущем'],
};

// ── The LAN leg: ONE claim became THREE (DISC-1, 0.2.61) ────────────────────
//
// 🔴 THIS BLOCK REPLACED A SINGLE TABLE CALLED `LAN_PLAINTEXT`, and the reason
// it is three tables is the whole card. The old copy said the LAN leg is not
// encrypted and that the warning would stay until encryption shipped. 0.2.60
// shipped it — so the sentence expired on deploy day, and the obvious repair
// (say it is encrypted now) would have been a lie in the OTHER direction for
// two populations at once: pairings made before 0.2.60, and any deployment
// running the kill switch. A test that only banned the old sentence would grade
// that second lie as a pass, which is why every group below is a POSITIVE
// marker and the ban is scoped underneath them.

/** ① A QR-made pairing is TLS AND the pin is re-checked on every later dial —
 *  not just at pairing time. Backed by apps/mobile/lib/src/signaling/
 *  lan_pinning.dart (`PinnedHttpClient._judge`) reached from four dial sites,
 *  enforced by apps/mobile/test/lan_pin_enforced_on_every_dial_test.dart. The
 *  second marker of each row is the 「every later connection」 half specifically:
 *  a copy that only promised encryption AT PAIRING would satisfy the first. */
const LAN_PINNED: Record<Loc, readonly string[]> = {
  'zh-CN': ['二维码里带着这台电脑的身份', '每一次连接都核对'],
  en: ['carries the identity of the computer', 'checks it on every later connection'],
  ja: ['PC の身元が入っている', '接続ごとに照合'],
  ko: ['컴퓨터의 신원이 실려 있는', '연결마다 대조'],
  'zh-TW': ['帶有該電腦的身分識別', '每次連線時都會檢查'],
  fr: ["porte l'identité de l'ordinateur", 'à chaque connexion ultérieure'],
  es: ['lleve la identidad del ordenador', 'en cada conexión posterior'],
  de: ['die Identität des Computers trägt', 'bei jeder späteren Verbindung'],
  ru: ['несёт в себе идентификатор компьютера', 'при каждом последующем подключении'],
};

/** ② The old warning is STILL TRUE for pairings made before 0.2.60, and there is
 *  exactly one action that upgrades them. apps/mobile/lib/src/ptt/
 *  ptt_session.dart:566-569 — `pinFingerprint: session.lanTlsFp` is 「Null for an
 *  unpinned row, which is every pre-D2-LAN pairing」 and that dial is 「byte-for-
 *  byte the old one」; no auto-upgrade path exists.
 *  🔴 THIS GROUP IS THE GUARD AGAINST THE OPPOSITE LIE. Deleting it would let a
 *  blanket 「the LAN is encrypted now」 paragraph pass every other assertion in
 *  this file. */
const LAN_LEGACY_PLAINTEXT: Record<Loc, readonly string[]> = {
  'zh-CN': ['仍然是明文', '重新配对'],
  en: ['still in the clear', 'pairing again'],
  ja: ['今も平文', 'ペアリングし直す'],
  ko: ['지금도 평문', '다시 페어링'],
  'zh-TW': ['仍然是未加密的', '重新配對'],
  fr: ['restent en clair', 'nouvel appairage'],
  es: ['siguen sin cifrar', 'volver a emparejar'],
  de: ['weiterhin unverschlüsselt', 'erneutes Koppeln'],
  ru: ['остаются незашифрованными', 'повторное сопряжение'],
};

/** ③ The kill switch, and what it costs. `FLOWMIC_LAN_TLS` is an env var name,
 *  so one literal covers all four catalogues — the per-locale loop is what
 *  proves no language dropped the sentence, exactly as with the vendor names.
 *  server-core config.ts `resolveLanTls` branch ② is the mechanism. */
const LAN_KILL_SWITCH = 'FLOWMIC_LAN_TLS';

/** ③b W6R's ruling: the switch is NOT a rollback, and that half must travel
 *  with the first half wherever the switch is described. A pairing created under
 *  TLS stored `https://` + the pin; `resumePairing` has no plaintext fallback,
 *  and with no certificate seen `lastDialPinMismatch` is false — so the phone
 *  can only report a failed connection, and delete-and-re-pair is the only way
 *  out. Without these two markers the copy could name the switch and leave the
 *  user stranded, which is the state this card found the product in. */
const LAN_KILL_SWITCH_COST: Record<Loc, readonly string[]> = {
  'zh-CN': ['连不上', '删掉这台电脑再配一次'],
  en: ['can no longer connect', 'deleting the computer on the phone and pairing again'],
  ja: ['接続できなくなります', '削除してペアリングし直します'],
  ko: ['연결되지 않습니다', '삭제하고 다시 페어링'],
  'zh-TW': ['無法再連線', '刪除該電腦並重新配對'],
  fr: ['ne peuvent plus se connecter', "supprimer l'ordinateur sur le téléphone"],
  es: ['ya no pueden conectarse', 'eliminar el ordenador en el teléfono'],
  de: ['nicht mehr verbinden', 'auf dem Telefon gelöscht und erneut gekoppelt'],
  ru: ['больше не смогут подключиться', 'удалить компьютер на телефоне'],
};

/** The phone section the paragraph sends the reader to, for the current value of
 *  a thing this copy deliberately refuses to assert. Verbatim
 *  `diagEncryptionSection` from apps/mobile/lib/src/settings/strings/
 *  connection_strings.dart:57.
 *  ⚠️ Desktop has NO encryption indicator of its own 【measured: across
 *  apps/desktop/src/** the only files matching 加密|encrypt|암호화|暗号化 are this
 *  disclosure copy, the component that renders it, this test, and comments in
 *  pairing.ts — there is no status row, badge or setting】, so this side can only
 *  pin the literal. The binding to the live getter is
 *  asserted in apps/mobile/test/data_flow_disclosure_test.dart — the one end
 *  where both strings are in scope — so renaming the section fails a test
 *  instead of silently orphaning this sentence. */
const PHONE_ENCRYPTION_SECTION: Record<Loc, string> = {
  'zh-CN': '连接加密',
  en: 'Connection encryption',
  ja: '接続の暗号化',
  ko: '연결 암호화',
  'zh-TW': '連線加密',
  fr: 'Chiffrement de la connexion',
  es: 'Cifrado de la conexión',
  de: 'Verschlüsselung',
  ru: 'Шифрование связи',
};

/** ④ The sentences this card replaced, as verbatim fragments per locale.
 *
 *  🔴 KEPT RATHER THAN DELETED, for the same reason PLAN_HEDGES is kept: the
 *  failure mode is not 「someone writes a new wrong sentence」, it is 「someone
 *  restores the old one」 — during a revert, a merge, or a translation refresh
 *  that pulls from an older catalogue. A marker table alone would go red with a
 *  message about a missing phrase; this one names what actually happened. */
const LAN_EXPIRED_CLAIMS: Record<Loc, readonly string[]> = {
  'zh-CN': ['局域网这条路目前没有加密', '加密还在做'],
  en: ['route is not encrypted today', 'Encryption for this leg is in development'],
  ja: ['現在暗号化されていません', 'この区間の暗号化は開発中'],
  ko: ['현재 암호화되어 있지 않습니다', '이 구간의 암호화는 개발 중'],
  'zh-TW': ['目前沒有加密', '加密還在開發'],
  fr: ['pas chiffrée aujourd', 'chiffrement est en développement'],
  es: ['no está cifrada hoy', 'cifrado está en desarrollo'],
  de: ['heute nicht verschlüsselt', 'Verschlüsselung ist in Entwicklung'],
  ru: ['сегодня не зашифрован', 'шифрование ещё разрабатывается'],
};

describe('P1 — the product says where the user’s words go', () => {
  it('renders all five stages of the core path, in every UI language', async () => {
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      for (const marker of STEP_MARKERS[loc]) {
        expect(html, `${loc} is missing the stage 「${marker}」`).toContain(ssrEscape(marker));
      }
    }
  });

  it('names both vendors — the words that appeared ZERO times before this card', async () => {
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      expect(html, `${loc} never names the speech provider`).toContain(SPEECH_VENDOR);
      expect(html, `${loc} never names the language-model provider`).toContain(MODEL_VENDOR);
    }
  });

  it('each stage names ITS OWN processor and no other', async () => {
    // 「Soniox」 alone would read as 「everything you say goes to Soniox」, which is
    // false for a user key and false for a local engine. The three destinations
    // are one claim, so they are asserted as one. The cross-checks matter for
    // the same reason in the other direction: a vendor named under the wrong
    // stage tells the user their data goes somewhere it does not, which is the
    // disclosure failing at its one job.
    for (const loc of LOCALES) {
      const cat = S_BY_LOCALE[loc];
      const html = await renderIn(loc);
      for (const key of ['disc_s2_cloud', 'disc_s2_byok', 'disc_s2_local'] as const) {
        expect(html, `${loc}.${key} not rendered`).toContain(ssrEscape(cat[key]));
      }
      expect(cat.disc_s2_cloud, `${loc}: Soniox must be on the CLOUD branch`).toContain(SPEECH_VENDOR);
      expect(cat.disc_s2_local, `${loc}: the local branch must not name a vendor`).not.toContain(SPEECH_VENDOR);
      expect(cat.disc_s2_byok, `${loc}: the BYOK branch must not name our vendor`).not.toContain(SPEECH_VENDOR);
      expect(cat.disc_s3_body, `${loc}: the model step must name its processor`).toContain(MODEL_VENDOR);
      expect(cat.disc_s3_body, `${loc}: the speech vendor does not belong in the model step`).not.toContain(
        SPEECH_VENDOR,
      );
      for (const key of ['disc_s2_cloud', 'disc_s2_byok', 'disc_s2_local'] as const) {
        expect(cat[key], `${loc}.${key}: the model vendor does not belong on a speech branch`).not.toContain(
          MODEL_VENDOR,
        );
      }
    }
  });

  it('🔴 DeepSeek is stated as a PRESENT FACT — no 「planned / not yet」 hedge survives', async () => {
    // 🔴 THIS GUARD WAS INVERTED, NOT DELETED. Its previous form required a
    // not-yet marker beside the name and was correct while the platform model
    // still ran on our own machines. The engine switch made the plan the fact,
    // so the assertion turned around in the same edit as the copy: the vendor
    // that processes the text must be NAMED, and every phrasing that would sell
    // it back as a plan must be absent. Drifting backwards is now as loud a
    // failure as jumping ahead used to be.
    //
    // ⚠️ Two levels on purpose. `renderIn` proves the sentence is MOUNTED (a
    // catalogue string nobody renders is this repo's oldest façade); the hedge
    // ban is asserted against `disc_s3_body` specifically, because banning a
    // phrase page-wide would eventually forbid an honest sentence somewhere else
    // — the exact mistake narrowed out of scenario-inference-consent.test.ts.
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      // Unconditional, where the old version had `if (!html.includes(...)) continue;`
      // — a dropped name used to be caught by a counter at the end, and is now
      // caught here, one locale at a time, with the locale in the message.
      expect(html, `${loc} does not tell the user whose servers process their text`).toContain(MODEL_VENDOR);
      const body = S_BY_LOCALE[loc].disc_s3_body;
      expect(body, `${loc}: vendor not in the LLM step`).toContain(MODEL_VENDOR);
      for (const hedge of PLAN_HEDGES[loc]) {
        expect(body, `${loc}: the LLM sentence slid back into a plan (「${hedge}」)`).not.toContain(hedge);
      }
    }
  });

  it('🔴 the polish sentence is true at BOTH values of the switch — no default is claimed', async () => {
    // 0.3.0 L2. owner ruled "AI polish is on by default" (AI 改顺默认全开) on
    // 2026-08-08, and step ③ used to say "only if you switched on AI polish
    // YOURSELF" / "not every sentence goes through it" (不是每句话都会经过) in
    // four languages. Those sentences encoded ONE value of `stt.polish`'s default
    // (server-core stt/stt-polish-settings.ts) into strings compiled into a
    // shipped binary — so flipping a `const` on the server would have made four
    // languages lie simultaneously, on disks the server cannot reach. That is
    // C-1's exact mechanism, and it is what disclosure.ts's own header rule forbids:
    // 「DO NOT WRITE A USER-FACING SENTENCE WHOSE TRUTH DEPENDS ON THE CURRENT
    // VALUE OF A SERVER-SIDE SWITCH.」
    //
    // ⚠️ Asserted on the RENDERED page, not on the catalogue — 0.2.53's lesson
    // was that `Text.data` is not what the user reads. Here it also matters that
    // the sentence is mounted at all.
    // ⚠️ The ban is scoped to `disc_s3_body`, not to the page: 「默认」/「default」
    // is a legitimate word elsewhere (a default engine, a default endpoint), and
    // a page-wide ban would eventually forbid an honest sentence — the same
    // narrowing the DeepSeek guard above already had to make.
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      const body = S_BY_LOCALE[loc].disc_s3_body;
      expect(html, `${loc}: step ③ is not mounted`).toContain(ssrEscape(body));
      for (const claim of DEFAULT_VALUE_CLAIMS[loc]) {
        expect(
          body,
          `${loc}: step ③ claims a default value (「${claim}」). Flipping stt.polish's DEFAULT makes this sentence false in a binary the server cannot reach — state the CONDITION and where the value is shown instead.`,
        ).not.toContain(claim);
      }
      // Positive control: banning phrases would also pass on an EMPTY paragraph,
      // so the replacement clause must actually be there. Without this the test
      // would grade silence as honesty.
      expect(
        body,
        `${loc}: step ③ dropped the clause telling the reader where the current value is shown`,
      ).toContain(WHERE_TO_SEE_IT[loc]);
    }
  });

  it('🔴 the LAN leg is told as THREE truths — 0.2.60 pairings, older ones, and the kill switch', async () => {
    // ⚠️ Two levels, same as the DeepSeek and polish guards above: `renderIn`
    // proves the paragraph is MOUNTED (a catalogue string nobody renders is this
    // repo's oldest façade), and the markers are asserted against
    // `disc_s4_lan_plain` specifically so the next test's ban can be scoped to
    // the same key without ever reaching a legitimate sentence elsewhere.
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      const line = S_BY_LOCALE[loc].disc_s4_lan_plain;
      expect(html, `${loc}: the LAN paragraph is not mounted`).toContain(ssrEscape(line));

      for (const m of LAN_PINNED[loc]) {
        expect(
          line,
          `${loc}: the LAN paragraph does not say the pairing is encrypted AND re-checked (「${m}」). The pin is verified on every dial (lan_pinning.dart), and a copy that only promises it at pairing time undersells what the phone actually does.`,
        ).toContain(m);
      }
      for (const m of LAN_LEGACY_PLAINTEXT[loc]) {
        expect(
          line,
          `${loc}: the LAN paragraph dropped the pre-0.2.60 half (「${m}」). Those pairings are still plaintext — ptt_session.dart:566-569, no auto-upgrade — so a blanket 「it is encrypted now」 is a NEW lie, not a fix for the old one, and re-pairing is the only action that moves them.`,
        ).toContain(m);
      }
      // 🔴 In-place correction (WP3 C16, 2026-08-18): the REQUIRED kill-switch
      // assertions that stood here are retired, not weakened by stealth.
      // Owner 2026-08-17 ruled the disclosure surfaces down to a diagram with
      // short captions, with the fine print behind the web links; the
      // FLOWMIC_LAN_TLS=0 mechanics — an operator-side env toggle, its lockout
      // cost, and the delete-and-re-pair recovery — moved to
      // docs/legal/privacy-policy.md (its LAN channel section already carried
      // all three), and `disc_more_on_site` is the on-screen pointer. Claim ①
      // keeps its referent without the switch: the condition is now 「how the
      // pairing was made」, which the copy states directly.
      //
      // ⚠️ What survives of W6R's rule is the TRAVEL-TOGETHER half, as a
      // conditional: if a future copy edit brings the switch's name back onto
      // this screen, its cost must come back with it — naming the switch
      // without the cost is the exact stranded-user state W6R found.
      if (line.includes(LAN_KILL_SWITCH)) {
        for (const m of LAN_KILL_SWITCH_COST[loc]) {
          expect(
            line,
            `${loc}: the switch came back without what it costs (「${m}」). W6R: it is NOT a rollback — phones paired under TLS can no longer connect, and delete-and-re-pair is the only recovery.`,
          ).toContain(m);
        }
      }
      // The pointer to where the moved fine print lives must itself be real.
      expect(
        S_BY_LOCALE[loc].disc_more_on_site.trim(),
        `${loc}: the moved LAN fine print has no on-screen pointer`,
      ).not.toHaveLength(0);
      expect(
        line,
        `${loc}: the paragraph refuses to assert the current value (correctly) but no longer says where it IS shown — the same clause stage ③ carries.`,
      ).toContain(PHONE_ENCRYPTION_SECTION[loc]);
    }
  });

  it('🔴 the expired 「not encrypted」 sentence cannot come back', async () => {
    // The positive markers above already fail if the old copy returns, so this
    // is not redundancy for its own sake: it is the test that names WHAT
    // happened. A revert, a merge, or a translation refresh pulled from an older
    // catalogue produces exactly this, and 「missing phrase X」 sends the reader
    // hunting while 「the pre-0.2.60 sentence is back」 does not.
    //
    // ⚠️ Scoped to `disc_s4_lan_plain`, never page-wide — 「未加密」 / 「not
    // encrypted」 are honest words elsewhere (the phone's own status tier says
    // exactly that), and a page-wide ban would eventually forbid a true
    // sentence. Same narrowing the two guards above already had to make.
    for (const loc of LOCALES) {
      const line = S_BY_LOCALE[loc].disc_s4_lan_plain;
      for (const stale of LAN_EXPIRED_CLAIMS[loc]) {
        expect(
          line,
          `${loc}: the LAN paragraph is back to the pre-0.2.60 claim (「${stale}」). LAN TLS shipped in 0.2.60; this sentence expired the day it deployed.`,
        ).not.toContain(stale);
      }
    }
  });

  it('🔴 the seeded tier is named without claiming it is local (REQ-13-09)', async () => {
    // The ORDER paragraph used to end 「…failing that, the two LOCAL engine
    // routes we seeded for you at first boot」. That adjective is a claim about
    // whose hardware those two engines run on, and NOTHING on this side decides
    // it: apps/server-core/src/settings/defaults.ts buildDefaultSettings() takes
    // the seed preset ids from FLOWMIC_DEFAULT_STT_ZH_PRESET /
    // FLOWMIC_DEFAULT_STT_WILDCARD_PRESET and accepts any id in
    // packages/protocol/src/engine-presets.ts — a catalogue that contains
    // `cloud-deepgram` (wss://api.deepgram.com) and `cloud-openai-realtime`, and
    // whose LAN entries are then re-pointed by FLOWMIC_DEFAULT_STT_HOST at a
    // machine the OPERATOR runs. True of a stock install, false of the hosted
    // deployment `disc_scope_note` says this section describes. It is this
    // file's own rule — never a user-facing sentence whose truth depends on the
    // current value of a server-side switch — applied to a clause that predates
    // it.
    //
    // ⚠️ SCOPED TO `disc_s2_body`, and the positive control below is why: the
    // word 「local」 is honest one string over, in `disc_s2_local`, which is the
    // branch that explains what a local engine IS. A page-wide ban would delete
    // the honest sentence to punish the dishonest one — the same narrowing the
    // LAN guards above had to make.
    // The BARE locality word, not the old phrase. Banning 「local engine routes」
    // verbatim would pass for 「the two local routes」 and for every rewording a
    // future edit invents; the claim is the adjective, so the adjective is what
    // is banned — inside this one string.
    const LOCALITY_WORD: Record<Loc, string> = {
      'zh-CN': '本地',
      en: 'local',
      ja: 'ローカル',
      ko: '로컬',
      // zh-TW says 本機; ru's word is capitalized at the bullet start
      // (「Локальный движок」), so the fragment is case-robust on purpose.
      'zh-TW': '本機',
      fr: 'local',
      es: 'local',
      de: 'lokal',
      ru: 'окальн',
    };
    const SEEDED_LOCALITY_CLAIM: Record<Loc, readonly string[]> = {
      'zh-CN': [LOCALITY_WORD['zh-CN']],
      en: [LOCALITY_WORD.en],
      ja: [LOCALITY_WORD.ja],
      ko: [LOCALITY_WORD.ko],
      'zh-TW': [LOCALITY_WORD['zh-TW']],
      fr: [LOCALITY_WORD.fr],
      es: [LOCALITY_WORD.es],
      de: [LOCALITY_WORD.de],
      ru: [LOCALITY_WORD.ru],
    };
    // The tier must still be NAMED — dropping it entirely would restore the W1.5
    // defect (the 「stops with an error」 clause becomes false when the seeded
    // rows that serve first are not mentioned).
    const SEEDED_TIER_MARKER: Record<Loc, string> = {
      'zh-CN': '首次开机时替你预置',
      en: 'we seeded for you at first boot',
      ja: '初回起動時に用意した',
      ko: '첫 실행 때 미리 넣어 둔',
      'zh-TW': '第一次啟動時為你預先設定',
      fr: 'préconfigurées pour vous au premier démarrage',
      es: 'preconfiguramos para ti en el primer arranque',
      de: 'beim ersten Start für dich voreingestellt',
      ru: 'предварительно настроили для вас при первом запуске',
    };
    for (const loc of LOCALES) {
      const body = S_BY_LOCALE[loc].disc_s2_body;
      expect(
        body,
        `${loc}: the seeded tier vanished from the engine order — W1.5's defect, not this card's fix`,
      ).toContain(SEEDED_TIER_MARKER[loc]);
      for (const claim of SEEDED_LOCALITY_CLAIM[loc]) {
        expect(
          body,
          `${loc}: the engine order grades the seeded tier as 「${claim}」. Which engines get seeded is an env var (FLOWMIC_DEFAULT_STT_*_PRESET) and can be a cloud vendor — this side cannot promise where they run.`,
        ).not.toContain(claim);
      }
      // Positive control: the word is still doing honest work on the branch that
      // owns it, so this test bans a CLAIM and not a vocabulary item. Without
      // this line, deleting 「local」 everywhere — including from the sentence
      // whose whole job is to define it — would pass.
      expect(
        S_BY_LOCALE[loc].disc_s2_local,
        `${loc}: the local-engine BRANCH lost the word 「${LOCALITY_WORD[loc]}」 — the ban leaked out of disc_s2_body`,
      ).toContain(LOCALITY_WORD[loc]);
      // …and it really reaches the screen, not just the catalogue (0.2.53).
      const html = await renderIn(loc);
      expect(html, `${loc}: disc_s2_body is not rendered`).toContain(ssrEscape(body));
    }
  });

  it('🔴 the local-engine line scopes its claim to speech and points text at ③ (REQ-13-09 / Q12㋐)', async () => {
    // The line used to end at 「什么都不离开你自己的设备」 / 「nothing leaves your
    // own hardware」. Inside ②'s numbering that is TRUE — this bullet is one
    // branch of 「which engine hears you」, and where the TEXT goes afterwards is
    // ③'s subject. The audit graded it accurate for exactly that reason
    // (docs/strategy/2026-08-13-req1309-stt-llm-audit.md A2).
    //
    // 🔴 SO WHY GUARD A TRUE SENTENCE: the numbering is not part of the sentence.
    // This line is quotable on its own — a screenshot, a support reply, a review
    // — and alone it says the words never leave the device, which is false the
    // moment Translate/Organize run or "AI polish" (AI 润色) is on:
    //   apps/server-core/src/engine/stt-factory.ts resolvePolishDep() resolves
    //   through the same resolveLlmConfigWithSource() as compose/llm-config.ts,
    //   and packages/protocol/src/engine-presets.ts lets that endpoint be a
    //   cloud vendor.
    // owner ruled ㋐ (0.2.63 task book §14 Q12): one clause is cheap for a
    // promise sentence that survives being quoted alone.
    //
    // ⚠️ TWO MARKERS PER LOCALE, because the clause makes two moves and either
    // alone is a worse sentence than the original: [0] names the leg (a scope
    // with no forwarding leaves a question with no address), [1] forwards the
    // other question to ③ (a pointer with no scope reads as if ③ contradicts
    // this line). Dropping either must go red.
    //
    // ⚠️ ③'s BODY IS NOT ASSERTED HERE. It already says where text goes, better
    // than a duplicate would; the clause forwards, it does not re-state.
    const TEXT_DESTINATION_QUALIFIER: Record<Loc, readonly string[]> = {
      'zh-CN': ['说的是语音', '文字之后去哪，见 ③'],
      en: ['that is about your voice', 'where the text goes next is step 3'],
      ja: ['これは音声の話です', 'テキストがその後どこへ行くかは ③'],
      ko: ['음성에 대한 이야기', '텍스트가 그다음 어디로 가는지는 ③'],
      'zh-TW': ['只關乎你的語音', '文字接下來要送去哪裡是第 3 步'],
      fr: ['cela concerne votre voix', "c'est l'étape 3"],
      es: ['eso concierne a tu voz', 'a dónde va el texto después es el paso 3'],
      de: ['das betrifft deine Stimme', 'ist Schritt 3'],
      ru: ['это касается вашего голоса', 'решается на шаге 3'],
    };
    // 🔴 IN-PLACE CORRECTION (2026-08-19, local-model onboarding batch) — the
    // assertion below was INVERTED, not weakened by stealth.
    //
    // It used to require the literal 「FLOWMIC_SHERPA_AUTO_DOWNLOAD=1」, because
    // owner's 2026-08-11 opt-in sentence named that environment variable and
    // the variable was the ONLY way to consent to the download. The desktop now
    // ships a download button in settings
    // (docs/strategy/2026-08-19-local-model-onboarding-design.md §5-A), so the
    // old sentence became FALSE the day the button existed: setting a variable
    // stopped being the only way to say yes, and a disclosure that lags the
    // mechanism is this repo's most expensive failure shape.
    //
    // What owner's ruling actually bought was the CONSENT PROMISE — 「it does
    // not download unless you asked for it」 — and that survives untouched; only
    // the mechanism of asking widened. So the promise is pinned POSITIVELY per
    // locale, and the identifier is BANNED from the body copy (§5-D: the
    // variable is the unattended/CI path, and naming it in a privacy paragraph
    // a phone user reads is noise, not disclosure). Dropping the assertion
    // instead of turning it round would have retired a guard along with the
    // sentence it guarded — the exact move the LAN block above refuses to make.
    //
    // ✅ REVERSE CONTROL — BOTH NEW READINGS HAVE BEEN SEEN RED (2026-08-19, the
    // machine is named in the private window log; en mutated in the catalogue,
    // regenerated, run, restored, `git diff` back to the single intended line):
    //   · consent promise replaced by 「when the built-in engine is first used」
    //     ⇒ 「the consent promise … left the local-engine line」;
    //   · 「from settings on the computer」 replaced by 「by setting
    //     FLOWMIC_SHERPA_AUTO_DOWNLOAD=1 on the computer」
    //     ⇒ 「the environment variable is back in the body copy」.
    // The phone's twin was mutated in the same runs and went red identically.
    const CONSENT_PROMISE: Record<Loc, string> = {
      'zh-CN': '只在你要求之后',
      en: 'because you asked for it',
      ja: 'あなたが求めたときにだけ',
      ko: '당신이 요청했을 때만',
      'zh-TW': '只在你要求之後',
      fr: "parce que vous l'avez demandé",
      es: 'porque tú la has pedido',
      de: 'weil du ihn verlangt hast',
      ru: 'вы об этом попросили',
    };
    // The bare NAME, not the `=1` form: a rewrite that mentioned the variable
    // without its value would slip past the longer string and put developer
    // configuration back into a user-facing privacy paragraph.
    const OPT_IN_FLAG_NAME = 'FLOWMIC_SHERPA_AUTO_DOWNLOAD';
    for (const loc of LOCALES) {
      const line = S_BY_LOCALE[loc].disc_s2_local;
      for (const marker of TEXT_DESTINATION_QUALIFIER[loc]) {
        expect(
          line,
          `${loc}: the local-engine line dropped 「${marker}」. Read on its own — and it will be, this is a promise surface — 「nothing leaves your device」 is false for the TEXT once Translate/Organize run or AI polish is on. The clause is what makes the sentence survive being quoted without its ② heading.`,
        ).toContain(marker);
      }
      expect(
        line,
        `${loc}: the consent promise (「${CONSENT_PROMISE[loc]}」) left the local-engine line. The download button widened HOW you consent; it did not remove the promise that nothing is fetched until you do. Without this sentence the paragraph describes an app that reaches out on its own.`,
      ).toContain(CONSENT_PROMISE[loc]);
      expect(
        line,
        `${loc}: the environment variable is back in the body copy. It is the unattended path now (design §5-D) — say WHO asked for the download, not which variable was set.`,
      ).not.toContain(OPT_IN_FLAG_NAME);
      // 🔴 And it is MOUNTED, not merely present in the catalogue — a string
      // nobody renders is this repo's oldest façade. The phone carries the same
      // four strings byte-for-byte (disclosure_strings.dart `discStep2Local`)
      // and measures the rendered paragraph at 360dp; this end has no layout to
      // measure, so it asserts presence in the serialized markup instead.
      const html = await renderIn(loc);
      expect(html, `${loc}: disc_s2_local is not rendered`).toContain(ssrEscape(line));
    }
  });

  it('🔴 legal block opens the published website pages — not repo files, not unpublished', async () => {
    // Inverted, not deleted: the old guard banned every <a> because the pages
    // were unpublished. They are live (measured HTTP 200, 2026-08-14). Restoring
    // the 「not yet published」 / docs/legal/ sentences is now the failure.
    expect(DISCLOSURE_PRIVACY_URL).toBe('https://flowmic.app/privacy');
    expect(DISCLOSURE_TERMS_URL).toBe('https://flowmic.app/terms');
    for (const loc of LOCALES) {
      const html = await renderIn(loc);
      expect(html, `${loc} is missing the privacy URL`).toContain(`href="${DISCLOSURE_PRIVACY_URL}"`);
      expect(html, `${loc} is missing the terms URL`).toContain(`href="${DISCLOSURE_TERMS_URL}"`);
      // 🔴 REPLACED 0.3.24, and what these two lines USED to demand is the
      // point: `target="_blank"` — the attribute that opens NOTHING in this
      // app. A WebView2 window declared in tauri.conf.json drops every
      // new-window request (src-tauri/src/shell/external_open.rs carries the
      // measured chain), so this assertion was green for exactly as long as the
      // product's only in-app route to the privacy policy was dead, and it
      // would have gone RED on the day somebody fixed it. That is the shape
      // CLAUDE.md records from 0.2.52: a control assertion pointed the wrong
      // way does not miss a defect, it writes the defect into the acceptance
      // criteria — and the question to ask of a negative assertion is 「如果我
      // 错了，谁会来告诉我」 ("if I am wrong, who comes and tells me"). Nobody was
      // going to, because the machine that publishes releases never clicks these.
      //
      // What replaces it asserts what a user can observe: the click is
      // intercepted and handed to the one door that can open a browser. `href`
      // stays, and stays the published URL (asserted just above) — it is what
      // the link MEANS and what copy-link yields.
      for (const [name, url] of [
        ['privacy', DISCLOSURE_PRIVACY_URL],
        ['terms', DISCLOSURE_TERMS_URL],
      ] as const) {
        const esc = url.replace(/[.*+?^${}()|[]\]/g, '\$&');
        expect(
          html,
          `${loc}: the ${name} link still relies on target=_blank, which opens nothing in this app`,
        ).not.toMatch(new RegExp(`href="${esc}"[^>]*target="_blank"`));
      }
      expect(html, `${loc}: expired unpublished-docs sentence is back`).not.toContain('docs/legal/');
      expect(html, `${loc}: expired privacy-policy.md path is back`).not.toContain('privacy-policy.md');
      expect(html, `${loc}: expired terms-of-service.md path is back`).not.toContain('terms-of-service.md');
      const cat = S_BY_LOCALE[loc];
      expect(html, `${loc}: privacy label not mounted`).toContain(ssrEscape(cat.disc_legal_privacy));
      expect(html, `${loc}: terms label not mounted`).toContain(ssrEscape(cat.disc_legal_terms));
      // Do not claim the opened page is in the UI language — the site stores its
      // own language choice and does not take a locale from this URL.
      expect(cat.disc_more_on_site, `${loc}: copy claimed the policy is in the UI language`).not.toMatch(
        /your language|你的语言|你的語言|あなたの言語|당신의 언어|in your language|votre langue|tu idioma|deiner Sprache|вашем языке/i,
      );
    }
  });

  it('anti-façade: the component is MOUNTED and its nav entry exists', () => {
    // A disclosure nobody can open is the same as no disclosure. The production
    // call site is asserted here rather than described in a comment (④).
    const page = readFileSync(
      fileURLToPath(new URL('./SettingsPage.vue', import.meta.url)),
      'utf8',
    );
    expect(page).toContain("import DataFlowDisclosure from './components/DataFlowDisclosure.vue'");
    expect(page).toContain('<DataFlowDisclosure />');
    expect(page).toContain('id="set-privacy"');
    // scrollTo() resolves `set-${id}`, so the nav entry and the section id are
    // two halves of one mechanism — a nav item with no section scrolls nowhere.
    expect(page).toMatch(/\{ id: 'privacy', label: S\.disc_nav \}/);
    expect(page).toMatch(/type Sec =[^\n]*'privacy'/);
  });
});
