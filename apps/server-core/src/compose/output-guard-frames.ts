// The assistant-frame detector for the compose output guard.
//
// 800-line cap (`verify/lint/file-size.mjs` SRC_MAX): `output-guard.ts` was at
// 794 lines, so the section it already titled 「─── rule 3: assistant frames ───」
// moved out whole. Same method as the earlier `output-guard-text.ts` and
// `output-guard-volume.ts` splits — the cut follows a section header the file had
// drawn itself, not one invented for the occasion.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every declaration below — body, comment and
// literal — is byte-for-byte what it was in `output-guard.ts`, with exactly ONE
// mechanical edit, listed so the claim stays checkable:
//   (1) `assistantFrame` gained the `export` keyword, because `output-guard.ts`
//       now calls it across a module boundary. `ASSISTANT_FRAMES`,
//       `SELF_IDENTIFICATION_FRAMES`, `foldForFrame` and `sourceIsFramed` are
//       deliberately NOT exported: they had no caller outside this family before
//       the move, and exporting them would invent one.
// **Any diff beyond that one is a bug.**
//
// This file answers 「is the model talking ABOUT the task instead of doing it?」.
// It does not answer 「may this be delivered?」 — that stays in `output-guard.ts`,
// which is the only place a `ComposeGuardVerdict` is ever minted. The public
// surface of the guard is unchanged, so no caller, test or
// `verify/eval/run-eval.mjs` import path moves.

// ─── rule 3: assistant frames ───────────────────────────────────────────────

/**
 * Delivery/refusal frames — the model talking ABOUT the task instead of doing it.
 *
 * ⚠️ Every entry is justified individually below, and the list is deliberately
 * tiny. This is the one rule made of literal strings, so it is the one that can
 * rot into a blocklist nobody can reason about.
 *
 * Two structural properties keep it from rejecting correct work:
 *
 *  1. PREFIX-ANCHORED. A delivery frame is a preface by nature. Anchoring kills
 *     the obvious false rejects: a faithful translation of "我不能去" is "I
 *     cannot go", which contains no entry here, and even a sentence that
 *     mentions a translation mid-text cannot trip it.
 *  2. SOURCE-EXEMPT. If the folded source already contains the marker, the
 *     output is allowed to contain it — that is the case where the user's own
 *     words are about this phrasing, and echoing them is the correct answer.
 *
 * 🔴 CORRECTED (2026-08-08, ledger 2026-08-06-w25 §9.3 cause ②). This paragraph
 * used to read: "the source-exempt escape cannot fire across a language
 * boundary … that is a real false reject and it is accepted knowingly." It was
 * true of the OLD per-marker check (`hay.startsWith(marker) && !src.includes(
 * marker)`) and is now false. `assistantFrame` exempts an output whenever the
 * SOURCE contains a frame marker in ANY recognised language (`sourceIsFramed`),
 * so a Chinese source that is itself a frame ("以下是翻译：" / "here is the
 * translation:", "作为一个语言模型，" / "as a language model,") translated into
 * English is no longer rejected for carrying the frame it faithfully renders. The knowingly-accepted false reject
 * is retired, not merely re-measured — see `sourceIsFramed` for why the old
 * check structurally could not fire on the translate path.
 *
 * ⚠️ The residual that REMAINS, stated rather than hidden: `sourceIsFramed`
 * matches the union of both vocabularies, so a source framed in one shape
 * exempts an output framed in another (source "以下是翻译" / "here is the
 * translation", output "As an AI, …"). That is a hole in the SAFE direction — a
 * source already talking about the task is the exact case where an unusual
 * output is plausibly the user's own words — and it is vanishingly rare in
 * dictated speech. The COMMON failure is untouched: a genuine model frame on an
 * UNFRAMED source ("把窗户打开。" / "Open the window." → "As an AI, I've
 * opened it") still rejects, because the source contains no marker. Measured
 * against the corpus at 0 false rejects, and against ledger §9.3's cause ② at 0.
 *
 * 🔴 Deliberately NOT included: any phrase that reads like a plausible answer to
 * a question the user might have dictated. In particular no bare "I cannot",
 * "sorry", or "I don't have access to real-time …" — the first two are ordinary
 * sentences, and the third is a string this repo's eval corpus uses as test
 * data, so hardcoding it would make the guard true of the test rather than of
 * the product.
 */
const ASSISTANT_FRAMES: readonly string[] = [
  // Delivery frames: name the artefact of the task, which only the assistant
  // ever does — a translation does not announce itself.
  'here is the translation',
  "here's the translation",
  'here is the translated',
  "here's the translated",
  'here is the edited',
  "here's the edited",
  'here is the organized',
  'here is the organised',
  'here is a translation',
  'translated text:',
  'edited text:',
  // Compliance openers: only the forms that continue into a delivery ("here"),
  // never bare "sure"/"of course", which are ordinary words.
  'sure, here',
  'sure! here',
  'of course, here',
  'of course! here',
  'certainly, here',
  'certainly! here',
  // Task-referring refusals. "translate"/"assist"/"help with" make these about
  // the request rather than about anything a speaker would dictate.
  'i cannot translate',
  "i can't translate",
  'i cannot assist',
  "i can't assist",
  'i cannot help with',
  "i can't help with",
  'i am unable to assist',
  "i'm unable to assist",
  // zh delivery frames. Each names the task artefact explicitly; "以下是" / "here is" alone
  // is deliberately absent because it is ordinary Chinese.
  '以下是翻译',
  '以下是译文',
  '翻译如下',
  '译文如下',
  '以下是整理',
  '整理如下',
  '以下是编辑后的',
];

/**
 * Self-identification as an assistant, matched ANYWHERE rather than only as a
 * prefix — the observed shape buries it mid-output ("OK\n\n…作为一个AI，我现在
 * 可以按你的新要求继续回答。", i.e. "OK … as an AI, I can now continue answering
 * per your new request.").
 *
 * 🔴 The trailing comma is load-bearing, not punctuation noise. "As an AI" is an
 * ordinary noun phrase that a faithful translation can legitimately produce
 * ("He thinks of himself as an AI"); "As an AI, …" is the model turning to
 * address the user about itself. Requiring the comma is what separates the two,
 * and without it this rule would reject correct translations of any sentence
 * that happens to mention an AI. Both comma forms are listed because the model
 * writes the zh sentence with a full-width one.
 */
const SELF_IDENTIFICATION_FRAMES: readonly string[] = [
  'as an ai,',
  'as a language model,',
  '作为一个ai，',
  '作为一个ai,',
  '作为人工智能，',
  '作为人工智能,',
  '作为一个语言模型，',
  '作为一个语言模型,',
];

function foldForFrame(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Is the SOURCE itself a frame — in ANY language this guard recognises?
 *
 * 🔴 This is the fix for ledger §9.3 cause ②. The previous shape was a per-marker
 * `!src.includes(marker)` guard that compared the folded source against the SAME
 * (target-language) marker the OUTPUT matched. On the translate path source and
 * output are different languages, so that marker can never appear in the source
 * verbatim ⇒ the exemption never fired, and the correct English rendering of a
 * Chinese sentence that is itself framed ("作为一个语言模型，…" → "As a language
 * model, …") was rejected as though the model had produced the frame. Checking
 * the whole multilingual vocabulary answers the real question — "are the user's
 * own words about this phrasing?" — regardless of which language they are in.
 */
function sourceIsFramed(foldedSource: string): boolean {
  for (const marker of ASSISTANT_FRAMES) if (foldedSource.includes(marker)) return true;
  for (const marker of SELF_IDENTIFICATION_FRAMES) if (foldedSource.includes(marker)) return true;
  return false;
}

export function assistantFrame(source: string, output: string): string | null {
  const hay = foldForFrame(output);
  // SOURCE-EXEMPT across the language boundary. If the user's own words are a
  // frame, translating/echoing that frame is the correct answer. This global
  // check subsumes the old per-marker `!src.includes(marker)` guard (which only
  // ever saw the same-language marker, so it was inert on the translate path)
  // and additionally fires when source and output are different languages.
  if (sourceIsFramed(foldForFrame(source))) return null;
  for (const marker of ASSISTANT_FRAMES) {
    if (hay.startsWith(marker)) return marker;
  }
  for (const marker of SELF_IDENTIFICATION_FRAMES) {
    if (hay.includes(marker)) return marker;
  }
  return null;
}
