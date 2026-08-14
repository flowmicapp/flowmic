// GENERATED — DO NOT EDIT BY HAND.
// Source: i18n/desktop/*.json + i18n/desktop/leaves.json
// Regenerate: node scripts/i18n/gen-desktop-ts.mjs
//
// THE COUNT-BEARING MESSAGES. They are FUNCTIONS and not word fragments
// because WORD ORDER is a property of the language — ja/ko put the counter
// before the verb where zh/en put it after — so a composed sentence lives in
// exactly one place. The interfaces (the key contract, with the reasoning) are
// hand-written in ../contract.ts; only the arms are generated.
//
// Same English fallback as the string catalogue and for the same reason: an
// untranslated arm is inherited by spread, so it renders an English sentence
// rather than `undefined is not a function`.
//
// `CATALOGUE` is in scope because three arms read a sibling string through it
// (「已复制」 is spelled once and reused as a prefix — anti-façade wiring). The
// LOCALE IN THOSE READS IS DELIBERATE: an arm belongs to its language, so an
// inherited English arm keeps reading the English prefix and the sentence
// stays in one language.

import type { SettingsMsg, TlBatchMsg, TlRetentionMsg, TlMetricsMsg } from '../contract';
import type { UiLocale } from './locales.g';
import { CATALOGUE } from './catalogue.g';

const SETTINGS_MSG_EN: SettingsMsg = {
  termTooLong: (n) => `Over ${n} characters`,
  termsAtCap: (n) => `Already at the ${n}-term cap`,
  termsCapNote: (n) => `≤${n} chars each`,
  dictCount: (n, cap) => `${n} / ${cap}`,
  dictAliases: (aliases) => `Aliases: ${aliases.join(', ')}`,
};

// zh-CN (中文) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_ZH_CN: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `超过 ${n} 字符`,
  termsAtCap: (n) => `已达 ${n} 条上限`,
  termsCapNote: (n) => `每条 ≤${n} 字符`,
  dictCount: (n, cap) => `${n} / ${cap} 条`,
  dictAliases: (aliases) => `别名：${aliases.join('、')}`,
};

// zh-TW (繁體中文) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_ZH_TW: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `超過 ${n} 個字元`,
  termsAtCap: (n) => `已達 ${n} 筆上限`,
  termsCapNote: (n) => `每筆 ≤${n} 個字元`,
  dictCount: (n, cap) => `${n} / ${cap} 筆`,
  dictAliases: (aliases) => `別名：${aliases.join('、')}`,
};

// fr (Français) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_FR: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `Plus de ${n} caractères`,
  termsAtCap: (n) => `Limite de ${n} termes atteinte`,
  termsCapNote: (n) => `≤${n} caractères chacun`,
  dictCount: (n, cap) => `${n} / ${cap}`,
  dictAliases: (aliases) => `Alias : ${aliases.join(', ')}`,
};

// es (Español) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_ES: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `Más de ${n} caracteres`,
  termsAtCap: (n) => `Límite de ${n} términos alcanzado`,
  termsCapNote: (n) => `≤${n} caracteres cada uno`,
  dictCount: (n, cap) => `${n} / ${cap}`,
  dictAliases: (aliases) => `Alias: ${aliases.join(', ')}`,
};

// de (Deutsch) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_DE: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `Mehr als ${n} Zeichen`,
  termsAtCap: (n) => `Obergrenze von ${n} Einträgen erreicht`,
  termsCapNote: (n) => `je ≤${n} Zeichen`,
  dictCount: (n, cap) => `${n} / ${cap}`,
  dictAliases: (aliases) => `Aliase: ${aliases.join(', ')}`,
};

// ja (日本語) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_JA: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `${n}文字を超えています`,
  termsAtCap: (n) => `上限の${n}件に達しています`,
  termsCapNote: (n) => `1件あたり ≤${n}文字`,
  dictCount: (n, cap) => `${n} / ${cap}件`,
  dictAliases: (aliases) => `別名：${aliases.join('、')}`,
};

// ko (한국어) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_KO: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `${n}자를 초과했습니다`,
  termsAtCap: (n) => `최대 ${n}개에 도달했습니다`,
  termsCapNote: (n) => `항목당 ≤${n}자`,
  dictCount: (n, cap) => `${n} / ${cap}개`,
  dictAliases: (aliases) => `별칭: ${aliases.join(', ')}`,
};

// ru (Русский) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const SETTINGS_MSG_RU: SettingsMsg = {
  ...SETTINGS_MSG_EN,
  termTooLong: (n) => `Больше ${n} символов`,
  termsAtCap: (n) => `Достигнут предел: ${n}`,
  termsCapNote: (n) => `не более ${n} символов каждый`,
  dictCount: (n, cap) => `${n} / ${cap}`,
  dictAliases: (aliases) => `Псевдонимы: ${aliases.join(', ')}`,
};

export const SETTINGS_MSG_BY_LOCALE: Record<UiLocale, SettingsMsg> = {
  'en': SETTINGS_MSG_EN,
  'zh-CN': SETTINGS_MSG_ZH_CN,
  'zh-TW': SETTINGS_MSG_ZH_TW,
  'fr': SETTINGS_MSG_FR,
  'es': SETTINGS_MSG_ES,
  'de': SETTINGS_MSG_DE,
  'ja': SETTINGS_MSG_JA,
  'ko': SETTINGS_MSG_KO,
  'ru': SETTINGS_MSG_RU,
};

const TL_BATCH_MSG_EN: TlBatchMsg = {
  selCount: (n) => `${n} selected`,
  selImgHint: (selected, images) =>
    `${images} of the ${selected} selected are pictures and will be skipped on copy`,
  copiedWithSkip: (copied, skipped) =>
    `Copied ${copied} · skipped ${skipped} ${skipped === 1 ? 'picture' : 'pictures'}`,
  copied: (n) => `${CATALOGUE.en.copied} ${n}`,
  nothingToCopy: (selected) => `Nothing to copy · all ${selected} selected are pictures`,
};

// zh-CN (中文) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_ZH_CN: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `已选 ${n} 条`,
  selImgHint: (selected, images) => `选中的 ${selected} 条里有 ${images} 条是图片，复制时会跳过`,
  copiedWithSkip: (copied, skipped) =>
    `${CATALOGUE['zh-CN'].copied} ${copied} 条 · 跳过 ${skipped} 条图片`,
  copied: (n) => `${CATALOGUE['zh-CN'].copied} ${n} 条`,
  nothingToCopy: (selected) => `没有可复制的文本 · 选中的 ${selected} 条都是图片`,
};

// zh-TW (繁體中文) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_ZH_TW: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `已選 ${n} 筆`,
  selImgHint: (selected, images) =>
      `選取的 ${selected} 筆裡有 ${images} 筆是圖片，複製時會略過`,
  copiedWithSkip: (copied, skipped) =>
      `${CATALOGUE['zh-TW'].copied} ${copied} 筆 · 略過 ${skipped} 筆圖片`,
  copied: (n) => `${CATALOGUE['zh-TW'].copied} ${n} 筆`,
  nothingToCopy: (selected) => `沒有可複製的文字 · 選取的 ${selected} 筆都是圖片`,
};

// fr (Français) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_FR: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `${n} sélectionné(s)`,
  selImgHint: (selected, images) =>
      `${images} des ${selected} éléments sélectionnés sont des images et seront ignorés à la copie`,
  copiedWithSkip: (copied, skipped) =>
      `${copied} copié(s) · ${skipped} image(s) ignorée(s)`,
  copied: (n) => `${CATALOGUE.fr.copied} ${n}`,
  nothingToCopy: (selected) => `Rien à copier · les ${selected} éléments sélectionnés sont tous des images`,
};

// es (Español) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_ES: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `${n} seleccionado(s)`,
  selImgHint: (selected, images) =>
      `${images} de los ${selected} elementos seleccionados son imágenes y se omitirán al copiar`,
  copiedWithSkip: (copied, skipped) =>
      `${copied} copiado(s) · ${skipped} imagen(es) omitida(s)`,
  copied: (n) => `${CATALOGUE.es.copied} ${n}`,
  nothingToCopy: (selected) => `Nada que copiar · los ${selected} elementos seleccionados son todos imágenes`,
};

// de (Deutsch) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_DE: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `${n} ausgewählt`,
  selImgHint: (selected, images) =>
      `${images} der ${selected} ausgewählten Einträge sind Bilder und werden beim Kopieren übersprungen`,
  copiedWithSkip: (copied, skipped) =>
      `${copied} kopiert · ${skipped} Bild(er) übersprungen`,
  copied: (n) => `${CATALOGUE.de.copied} ${n}`,
  nothingToCopy: (selected) => `Nichts zu kopieren · alle ${selected} ausgewählten Einträge sind Bilder`,
};

// ja (日本語) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_JA: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `${n}件選択中`,
  selImgHint: (selected, images) =>
    `選択した${selected}件のうち${images}件は画像のため、コピー時にスキップされます`,
  copiedWithSkip: (copied, skipped) =>
    `${copied}件をコピー · 画像${skipped}件はスキップしました`,
  copied: (n) => `${n}件をコピーしました`,
  nothingToCopy: (selected) => `コピーできるテキストがありません · 選択した${selected}件はすべて画像です`,
};

// ko (한국어) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_KO: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `${n}개 선택됨`,
  selImgHint: (selected, images) =>
    `선택한 ${selected}개 중 ${images}개는 이미지이므로 복사 시 건너뜁니다`,
  copiedWithSkip: (copied, skipped) =>
    `${copied}개 복사 · 이미지 ${skipped}개는 건너뛰었습니다`,
  copied: (n) => `${n}개를 복사했습니다`,
  nothingToCopy: (selected) => `복사할 텍스트가 없습니다 · 선택한 ${selected}개가 모두 이미지입니다`,
};

// ru (Русский) — 5/5 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_BATCH_MSG_RU: TlBatchMsg = {
  ...TL_BATCH_MSG_EN,
  selCount: (n) => `Выбрано: ${n}`,
  selImgHint: (selected, images) =>
      `Среди выбранных (${selected}) изображений: ${images} — при копировании они будут пропущены`,
  copiedWithSkip: (copied, skipped) =>
      `Скопировано: ${copied} · пропущено изображений: ${skipped}`,
  copied: (n) => `${CATALOGUE.ru.copied} ${n}`,
  nothingToCopy: (selected) => `Копировать нечего · все выбранные (${selected}) — изображения`,
};

export const TL_BATCH_MSG_BY_LOCALE: Record<UiLocale, TlBatchMsg> = {
  'en': TL_BATCH_MSG_EN,
  'zh-CN': TL_BATCH_MSG_ZH_CN,
  'zh-TW': TL_BATCH_MSG_ZH_TW,
  'fr': TL_BATCH_MSG_FR,
  'es': TL_BATCH_MSG_ES,
  'de': TL_BATCH_MSG_DE,
  'ja': TL_BATCH_MSG_JA,
  'ko': TL_BATCH_MSG_KO,
  'ru': TL_BATCH_MSG_RU,
};

const TL_RETENTION_MSG_EN: TlRetentionMsg = {
  keptNote: (kept, when) =>
    `This PC keeps only the most recent entries: ${kept} are stored here, and everything before ${when} has been removed from it.`,
  searchNoneTrimmed: (kept, when) =>
    `No matching entries. The search covers only the ${kept} entries kept on this PC — everything before ${when} has been removed from it.`,
};

// zh-CN (中文) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_ZH_CN: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) => `这台电脑只保留最近的记录：现在存着 ${kept} 条，${when} 之前的已从本机清除。`,
  searchNoneTrimmed: (kept, when) =>
    `没有匹配的条目。搜索范围只有本机保留的 ${kept} 条，${when} 之前的记录已从本机清除。`,
};

// zh-TW (繁體中文) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_ZH_TW: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) =>
      `這台電腦只保留最近的記錄：目前存有 ${kept} 筆，${when} 之前的已從本機清除。`,
  searchNoneTrimmed: (kept, when) =>
      `沒有符合的項目。搜尋範圍只有本機保留的 ${kept} 筆，${when} 之前的記錄已從本機清除。`,
};

// fr (Français) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_FR: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) =>
      `Ce PC ne conserve que les entrées les plus récentes : ${kept} y sont stockées, et tout ce qui précède ${when} en a été supprimé.`,
  searchNoneTrimmed: (kept, when) =>
      `Aucune entrée correspondante. La recherche ne porte que sur les ${kept} entrées conservées sur ce PC — tout ce qui précède ${when} en a été supprimé.`,
};

// es (Español) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_ES: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) =>
      `Este PC solo conserva las entradas más recientes: hay ${kept} almacenadas aquí y todo lo anterior a ${when} se ha eliminado de él.`,
  searchNoneTrimmed: (kept, when) =>
      `No hay entradas coincidentes. La búsqueda solo abarca las ${kept} entradas conservadas en este PC; todo lo anterior a ${when} se ha eliminado.`,
};

// de (Deutsch) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_DE: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) =>
      `Dieser PC behält nur die neuesten Einträge: ${kept} sind hier gespeichert, alles vor ${when} wurde von ihm entfernt.`,
  searchNoneTrimmed: (kept, when) =>
      `Keine passenden Einträge. Die Suche umfasst nur die ${kept} auf diesem PC behaltenen Einträge — alles vor ${when} wurde entfernt.`,
};

// ja (日本語) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_JA: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) =>
    `このPCには最近の記録だけを保存しています：現在 ${kept} 件。${when} より前の記録は本機から削除されました。`,
  searchNoneTrimmed: (kept, when) =>
    `一致する項目はありません。検索対象は本機に残っている ${kept} 件のみで、${when} より前の記録は削除されています。`,
};

// ko (한국어) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_KO: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) =>
    `이 PC에는 최근 기록만 보관합니다: 현재 ${kept}개. ${when} 이전 기록은 이 PC에서 삭제되었습니다.`,
  searchNoneTrimmed: (kept, when) =>
    `일치하는 항목이 없습니다. 검색 범위는 이 PC에 남아 있는 ${kept}개이며, ${when} 이전 기록은 삭제되었습니다.`,
};

// ru (Русский) — 2/2 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_RETENTION_MSG_RU: TlRetentionMsg = {
  ...TL_RETENTION_MSG_EN,
  keptNote: (kept, when) =>
      `На этом компьютере хранятся только последние записи: сейчас их ${kept}, всё до ${when} с него удалено.`,
  searchNoneTrimmed: (kept, when) =>
      `Совпадений нет. Поиск охватывает только ${kept} записей, оставшихся на этом компьютере, — всё до ${when} удалено.`,
};

export const TL_RETENTION_MSG_BY_LOCALE: Record<UiLocale, TlRetentionMsg> = {
  'en': TL_RETENTION_MSG_EN,
  'zh-CN': TL_RETENTION_MSG_ZH_CN,
  'zh-TW': TL_RETENTION_MSG_ZH_TW,
  'fr': TL_RETENTION_MSG_FR,
  'es': TL_RETENTION_MSG_ES,
  'de': TL_RETENTION_MSG_DE,
  'ja': TL_RETENTION_MSG_JA,
  'ko': TL_RETENTION_MSG_KO,
  'ru': TL_RETENTION_MSG_RU,
};

const TL_METRICS_MSG_EN: TlMetricsMsg = {
  wordCount: (n) => `${n} ${n === 1 ? 'word' : 'words'}`,
};

// zh-CN (中文) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_ZH_CN: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `${n} 字`,
};

// zh-TW (繁體中文) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_ZH_TW: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `${n} 字`,
};

// fr (Français) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_FR: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `${n} ${n === 1 ? 'mot' : 'mots'}`,
};

// es (Español) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_ES: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `${n} ${n === 1 ? 'palabra' : 'palabras'}`,
};

// de (Deutsch) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_DE: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `${n} ${n === 1 ? 'Wort' : 'Wörter'}`,
};

// ja (日本語) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_JA: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `${n}文字`,
};

// ko (한국어) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_KO: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `${n}자`,
};

// ru (Русский) — 1/1 translated;
// the rest inherit en by construction (owner 2026-08-14, 17 册 §0-bis).
const TL_METRICS_MSG_RU: TlMetricsMsg = {
  ...TL_METRICS_MSG_EN,
  wordCount: (n) => `Слов: ${n}`,
};

export const TL_METRICS_MSG_BY_LOCALE: Record<UiLocale, TlMetricsMsg> = {
  'en': TL_METRICS_MSG_EN,
  'zh-CN': TL_METRICS_MSG_ZH_CN,
  'zh-TW': TL_METRICS_MSG_ZH_TW,
  'fr': TL_METRICS_MSG_FR,
  'es': TL_METRICS_MSG_ES,
  'de': TL_METRICS_MSG_DE,
  'ja': TL_METRICS_MSG_JA,
  'ko': TL_METRICS_MSG_KO,
  'ru': TL_METRICS_MSG_RU,
};
