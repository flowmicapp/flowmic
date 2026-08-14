// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (the cloud does not store
//     transcripts ⇒ there is nothing left to search server-side; the PC timeline is
//     now entirely local, so search follows it there)
//
// The LOCAL timeline search predicate.
//
// WHY IT MOVED HERE. Until 0.2.25 the search was `history:list{query}` and the
// SERVER ran a LIKE, which was the honest thing to do while the server owned the
// rows: "no match" was then a statement about the whole table rather than about the
// page in hand. owner 2026-07-31 removed the table — the server stores no
// transcripts at all — so the same sentence now has to be true about THIS PC's
// rows, because those rows are the timeline. Asking a server that holds nothing
// would answer "no match" to every query ever typed.
//
// ⚠️ WHAT THIS FILE IS ALIGNED WITH, NOW THAT THE SQL IS GONE. It was written as a
// deliberate mirror of `history.repo.ts`'s `SEARCH_CLAUSE`, and that file was DELETED
// in 0.2.27 with the table it queried — so the four rules below no longer have a
// second implementation to agree with. They are not thereby arbitrary: each one is
// justified by what the ROWS and the SURFACES are (see ①–④), and the two that used to
// be pure compatibility choices are the ones to read carefully — ② and ⑤ were adopted
// because SQLite behaved that way, and they are KEPT because a search whose reach
// changes under the user is worse than one that stops at ASCII. There is nothing left
// to drift from; what remains is a promise to the user about what "no results found"
// means, and the tests below/alongside are now its only guard.
//
// THE SEMANTICS:
//
//   ① SUBSTRING, not tokens, not FTS. A timeline row is one utterance and the user is
//      looking for a phrase they remember saying; tokenising would make「会议室」
//      (meeting room) miss 「会议室的」(meeting room's) on some segmenters and not others.
//   ② The term is a LITERAL — `includes` has no metacharacters at all, so searching
//      "100%" finds those four characters. (The retired SQL had to `escapeLikeLiteral`
//      the `%` / `_` to get here; this side never had the hazard.)
//   ③ TWO FIELDS, and exactly the two a surface RENDERS: `output_text` (every row's
//      display face) and `source_text` (the source text — immutable, expandable on
//      translate / organize rows, and what the user remembers having said). A hit on
//      text no surface shows would be search claiming "this row contains the word you
//      searched for" about something the user cannot see, which is why there is no
//      third field to add: the PC's row (lib/types.ts TimelineRow) has no other text.
//   ④ `source_text === null` does not match, rather than throwing or matching
//      everything — a row with no source text simply has one fewer place to look.
//
// ⑤ CASE FOLDING IS ASCII-ONLY, ON PURPOSE (0.2.22 ruling, and unchanged by the SQL's
//    retirement). `toLowerCase()` was rejected and must not be reached for: it is
//    Unicode-aware, so it folds 「İ」/「Ä」/「Σ」— and the moment ONE surface folds
//    non-ASCII while another does not, "no results found" stops being an answer about
//    the text and becomes an answer about which folding table happened to run. Folding
//    A–Z and nothing else is the rule that is the same everywhere. CJK has no case, so
//    the practical surface is unchanged; the difference shows on 「Ä」/「ä」, which do
//    not match each other — a stated limit, not a silent one.

/** The two fields a query is compared against — the row shape this file needs and
 *  no more, so the predicate is testable without building a whole TimelineRow. */
export interface SearchableRow {
  output_text: string;
  source_text: string | null;
}

/** Fold A–Z to a–z and leave every other code point ALONE.
 *
 *  Deliberately not `toLowerCase()`: that is Unicode-aware and would fold 「İ」,
 *  「Ä」, 「Σ」… which SQLite's LIKE does not. Matching the server's reach exactly is
 *  what keeps "no results found" an answer about the text rather than about which of
 *  two case-folding tables happened to run. */
export function foldAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Build the predicate for one query, with the term folded ONCE.
 *
 *  A factory rather than `matchesQuery(row, q)` because the caller runs it over
 *  every row it holds; re-folding the term per row would be the same answer
 *  computed a thousand times. One entry point, so there is no second
 *  implementation of "whether this row counts as a hit" to drift.
 *
 *  An EMPTY query matches everything, exactly as `LIKE '%%'` does. The store never
 *  calls it that way (an empty box is "not searching", not "searching for an empty
 *  string"), and mirroring the SQL here means the boundary rule lives in one place
 *  instead of two. */
export function makeQueryMatcher(query: string): (row: SearchableRow) => boolean {
  const needle = foldAscii(query);
  if (needle === '') return () => true;
  return (row) => {
    if (foldAscii(row.output_text).includes(needle)) return true;
    return row.source_text !== null && foldAscii(row.source_text).includes(needle);
  };
}
