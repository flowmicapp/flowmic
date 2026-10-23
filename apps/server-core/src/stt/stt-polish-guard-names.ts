// GUARD-CJK (2026-10-15): a name may not be swapped for another name.
//
// The NR-245 content rule (stt-polish-guard-content.ts) excuses a dropped
// word when the output holds a NEAR SPELLING of it in the same place
// (meat -> meet). For a name that excuse is the hole: "Tell Anna we ship
// Monday" -> "Tell Hanna …", "Ruf Anna, dann Bob" -> "Ruf Hanna …",
// "Appelle Marie" -> "Appelle Mario" and "on Monday" -> "on Sunday" were all
// accepted (review of NR-262, 2026-10-14). The sound-alike excuse already
// refuses names (stt-polish-guard-soundalike.ts, "no capitalised word
// mid-sentence"); the near-spelling excuse never asked.
//
// Rule: a name-shaped word in the middle of a sentence (capital first letter,
// the rest lowercase: Anna, Jean-Luc, O'Brien, Monday) that the output lost,
// while the output gained a different name-shaped word in the middle of a
// sentence, is refused. Not counted:
//   · a word right after a determiner or an adjective-looking word (German
//     capitalises every noun: "die Looks" -> "die Logs" is a noun repair);
//   · a word the user's KNOWN terms, the coding default list or a short list
//     of common products explain (Cubernetes -> Kubernetes, Teens -> Teams:
//     products and tools are not people);
//   · the same name re-cased, re-accented or joined / split (Jose -> José,
//     Mac Book -> MacBook);
//   · a term spelling (all capitals or inner capitals: JSON, GitHub, iPhone):
//     those are not names, and the content rule already judges them.
// Cost, stated: a correct repair of a misheard name (Jon -> John) is refused,
// and so is a German noun repair with no article in front of it.

import { isLatinNumberWord } from './stt-polish-guard-numwords';
import { CODING_DEFAULT_TERMS } from './coding-terms';

const WORD_RE = /\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]*/gu;
const NAME_SHAPE = /^\p{Lu}[\p{Ll}\p{M}]+(?:['’-]\p{Lu}?[\p{Ll}\p{M}]+)*$/u;
const SENTENCE_START = /(?:^|[.!?:;。！？\n«»“"])[\s\p{Pi}\p{Ps}]*$/u;

/** Common work products and services people dictate by name: a misheard
 *  spelling repaired to one of these (Teens -> Teams) is a term repair. */
const PRODUCT_NAMES: readonly string[] = `Teams Figma Zoom Slack Jira Notion GitHub GitLab Docker Kubernetes Confluence
Trello Asana Linear Discord Telegram WhatsApp WeChat Outlook Excel PowerPoint Gmail Dropbox Salesforce HubSpot
Miro Loom Vercel Netlify Supabase Firebase Stripe Shopify Zendesk Intercom Canva Airtable Webex Lark Feishu
DingTalk OneDrive SharePoint Postman Grafana Sentry Datadog Bitbucket`.split(/\s+/u);

const NUMBER_WORDS: ReadonlySet<string> = new Set(`zero one two three four five six seven eight nine ten eleven
twelve twenty thirty forty fifty hundred thousand`.split(/\s+/u));

const DETERMINERS: ReadonlySet<string> = new Set(`
the a an this that these those my your his her its our their some any no every each another
le la les l un une des du de au aux ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs
el los las una unos unas del al este esta estos estas ese esa esos esas mi mis tu tus su sus nuestro nuestra
der die das den dem des ein eine einen einem einer eines kein keine keinen keinem keiner mein meine meinen meinem meiner
dein deine deinen sein seine seinen ihr ihre ihren unser unsere unseren euer eure diese dieser diesen dieses dem jede jeder
jeden jedes alle viele zum zur im am vom beim ins ans aufs
`.split(/\s+/u).filter(Boolean));

interface Word { text: string; key: string; name: boolean; mid: boolean; afterDet: boolean; at: number; end: number }

function fold(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/['’]s$/u, '').replace(/[^\p{L}\p{N}]/gu, '');
}

function words(s: string): Word[] {
  const out: Word[] = [];
  let prev = '';
  for (const m of s.matchAll(WORD_RE)) {
    const text = m[0].replace(/[-'’]+$/u, '');
    const lower = text.toLowerCase();
    // A lowercase word ending like a German / Romance adjective (neuen, alte)
    // before a capital reads as "adjective + noun", not as a name.
    const adjective = /^\p{Ll}+(?:e|en|er|es|em)$/u.test(prev) && prev.length > 3;
    // After a number it is what is counted (drei Komma, 5 Euro, zwei Blocks).
    const counted = /\d\s*$/u.test(s.slice(0, m.index)) || NUMBER_WORDS.has(prev) || isLatinNumberWord(prev);
    out.push({
      text,
      key: fold(text),
      name: NAME_SHAPE.test(text) && [...text].length >= 2,
      mid: !SENTENCE_START.test(s.slice(0, m.index)),
      afterDet: DETERMINERS.has(prev) || adjective || counted,
      at: m.index,
      end: m.index + text.length,
    });
    prev = /^\p{Ll}/u.test(text) || DETERMINERS.has(lower) ? lower : '';
  }
  return out;
}

function counts(ws: readonly Word[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of ws) out.set(w.key, (out.get(w.key) ?? 0) + 1);
  return out;
}

/** True when the output swapped a name for a different name (see above). */
export function nameSwap(
  raw: string,
  polished: string,
  known: readonly string[],
  lang?: string,
  excused: readonly (readonly [number, number])[] = [],
): boolean {
  // Command words the content check excused (comma -> ",") are not names.
  const a = words(raw).filter((w) => !excused.some(([at, end]) => w.at < end && at < w.end));
  const b = words(polished);
  const ra = counts(a);
  const rb = counts(b);
  // Joined or split (Mac Book -> MacBook, MacBook -> Mac Book): the word is
  // two adjacent words of the other side, or two adjacent words are it.
  const pairs = (ws: readonly Word[]): Set<string> => new Set(ws.slice(1).map((w, k) => ws[k]!.key + w.key));
  const rawPairs = pairs(a);
  const polPairs = pairs(b);
  const rejoined = (w: Word, at: number, ws: readonly Word[], other: Set<string>, otherWords: ReadonlyMap<string, number>): boolean =>
    other.has(w.key)
    || (at + 1 < ws.length && otherWords.has(w.key + ws[at + 1]!.key))
    || (at > 0 && otherWords.has(ws[at - 1]!.key + w.key));
  const dropped = a.filter((w, k) => w.name && w.mid && !w.afterDet && (rb.get(w.key) ?? 0) < (ra.get(w.key) ?? 0)
    && !rejoined(w, k, a, polPairs, rb));
  if (dropped.length === 0) return false;
  // The coding default list counts here in every app: it names products and
  // tools, never people, so "Cubernetes -> Kubernetes" is a term repair
  // (ML-0 fixture ml0-fr-23), not a name swap.
  const knownKeys = [...known, ...CODING_DEFAULT_TERMS, ...PRODUCT_NAMES].map((k) => fold(k)).filter((k) => k.length > 0);
  // German: two plural-looking nouns are a noun repair (die Looks -> die
  // Logs), the same reading the sound-alike excuse makes.
  const plural = (w: Word): boolean => /(?:s|en|n|e|er)$/u.test(w.key) && w.key.length > 3;
  return b.some((w, k) => w.name && w.mid && (ra.get(w.key) ?? 0) === 0
    && !knownKeys.some((t) => t === w.key || t.includes(w.key))
    && !rejoined(w, k, b, rawPairs, ra)
    && !(lang === 'de' && plural(w) && dropped.every(plural)));
}
