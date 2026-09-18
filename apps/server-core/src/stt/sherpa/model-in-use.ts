// SPEC-REF:
//   NR-7 (docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md)
//   owner ruling 2026-09-02 §5 (docs/decisions/2026-09-02-owner-web-rulings-0357-prerelease.md):
//     「删除前提示大小、当前在用模型不许删」 — show the size before deleting; the
//     model currently IN USE may not be deleted.
//   LM-CAT §6 ladder (model-resolve.ts) — the definition of "would open".
//
// ── WHERE 「IN USE」 IS DEFINED, AND WHY IT IS NOT THE SELECTION FILE ─────────
//
// A pack is IN USE when either of two things is true, and they answer two
// different questions:
//
//   [MODEL_IN_USE_LADDER]      it is the pack the §6 ladder WOULD OPEN for at
//                              least one catalog spoken language;
//   [MODEL_IN_USE_RECOGNIZER]  a recognizer for it has been loaded in THIS
//                              process (sherpa-local.ts calls
//                              [noteRecognizerLoaded]) — the native handle is
//                              kept warm in that file's RECOGNIZER_CACHE and
//                              is never freed on close(), so the files are
//                              still open for the process's lifetime.
//
// 🔴 WHY NOT `readModelSelection()` ALONE. A selection is a PREFERENCE. It can
// name a pack that was never downloaded, was cancelled halfway, or failed
// verification — and it is ABSENT for every language the user never picked for,
// while the ladder's rung 2 still opens a ready pack there. Guarding on the
// selection file alone would therefore refuse deletions that are harmless and
// permit the one deletion that breaks transcription: the pack rung 2 silently
// resolves to. The card's own 「currently in use」 strip already made this
// choice for the same reason (LocalModelCard.vue `inUse` / `readyPackForLang`);
// this module is the SERVER-side twin of that decision, so the button and the
// guard cannot answer differently. An honourable selection is a SUBSET of the
// ladder's answers — rung 1 IS the selection — so nothing is lost by keying on
// the ladder.
//
// 🔴 WHY THE RECOGNIZER HOLD IS A SECOND SOURCE AND NOT A REFINEMENT OF THE
// FIRST. `sherpa-local.ts` caches the native `OfflineRecognizer` by model
// directory and `close()` deliberately does NOT free it (「kept warm for the
// next utterance」). So a pack that stopped being the ladder's answer — the user
// picked a different pack for that language a minute ago — can still have live
// file handles into its directory. On Windows removing those files fails
// mid-way and leaves a half-deleted model that reads as `partial`. Refusing is
// the fail-safe direction, and the refusal is TRUE rather than defensive.
// ⚠️ KNOWN COST, stated rather than discovered: a pack spoken with once this
// session stays undeletable until the app restarts. That is the honest
// consequence of a cache nothing evicts; making it deletable means giving
// sherpa-local a way to free a recognizer, which is a separate card.
//
// 🔴🔴 IN-PLACE CORRECTION (2026-09-15, NR-45, MEASURED on dev-pc-b,
// Windows 11, node v22.22.3, sherpa-onnx-node@1.13.4 + sherpa-onnx-win-x64).
// The paragraph above is kept word for word because it is what we believed;
// TWO of its factual claims are false on this machine, and they are the two the
// [MODEL_IN_USE_RECOGNIZER] hold rests on.
//
//   claimed: 「the native handle is kept warm … so the files are still open for
//            the process's lifetime」
//   claimed: 「On Windows removing those files fails mid-way and leaves a
//            half-deleted model that reads as `partial`」
//   measured: with a recognizer BUILT FROM THE PACK AND DECODING, `unlink` of
//            one .onnx succeeded, a recursive delete of the whole pack
//            succeeded, the directory was gone — and the SAME recognizer then
//            decoded the same audio to byte-identical text, twice, without
//            crashing the process. Both loader kinds (senseVoice 239 MB,
//            offline-transducer 70 MB). Control: a never-loaded copy of the
//            same pack also deleted cleanly, so a green delete is not just
//            「this filesystem never locks anything」.
//   why: onnxruntime reads the weights into memory when the session is built
//        and keeps no file handle afterwards. There is nothing to be open.
//
// 🔴 THE HOLD STAYS ANYWAY, and the reason is NOT the sentence above. Two:
//   1. Removing a guard changes what a user is permitted to destroy, and a
//      deleted pack is a multi-hundred-MB re-download — the undo is expensive
//      and offline machines may not have one. That is a product call with its
//      own card, not a side effect of a measurement card.
//   2. This is ONE machine, ONE onnxruntime build, ONE platform. An ORT that
//      memory-maps its weights would make the old sentence true again, and the
//      guard must not be dropped on a Windows-only reading.
// What changed is the REASON. A guard defended by a false mechanism is the
// shape CLAUDE.md's anti-façade ④/⑦ are about: the next reader would have read
// that paragraph and stopped asking.
//
// 🔴 AND THE FIX THE PARAGRAPH POINTS AT DOES NOT EXIST. 「giving sherpa-local a
// way to free a recognizer」 was measured the same day and is not available:
// sherpa-onnx-node@1.13.4 exposes no free/destroy/release on either JS class
// and none among the addon's 99 native exports (see `stt/engines/sherpa-local.ts`
// `close()`, pinned by `test/sherpa-addon-surface.test.ts`). So the route to a
// deletable warm pack is NOT eviction — it is deciding whether this hold should
// exist at all.
// Re-measure both with `scripts/drills/local-engine-lifecycle-probe.mjs`.
//
// 🔴🔴 OWNER RULING 2026-09-16 §1 (NR-49) — THE RECOGNIZER HOLD IS GONE.
// docs/decisions/2026-09-16-owner-model-delete-async-decode-ipad-and-switches.md
// 「用过的模型可以删除」 — a pack spoken with this session may be deleted.
// Everything above is kept word for word; what follows is what is true now.
//
// The 2026-09-15 measurement had already shown the hold's ORIGINAL mechanism to
// be false, and left it standing on two replacement reasons. The ruling answers
// reason 1 (「removing a guard is a product call with its own card」) — this is
// that card, and the answer is yes. Reason 2 (「one machine, one onnxruntime
// build」) is NOT answered by a ruling and is not dismissed here: it is a claim
// about a FUTURE ORT that memory-maps its weights, on which a recursive remove
// would fail partway. So it is handled where it would actually happen rather
// than by refusing every delete in advance — `handleDelete` in
// apps/server-core/src/http/stt-model-routes.ts now answers a failed removal
// with a NAMED refusal (`MODEL_DELETE_FAILED`, carrying the errno) instead of
// letting it surface as the status layer's generic 500. A guard that refuses
// thousands of safe deletions to pre-empt one hypothetical platform is not a
// fail-safe, it is a permanent cost paid for an unobserved risk.
//
// ⚠️ WHAT IS STILL REFUSED IS UNCHANGED: [MODEL_IN_USE_LADDER]. The pack the §6
// ladder would open for a catalog spoken language may not be deleted, and that
// is the hold the card's sentence (`model_delete_in_use`) describes — 「give
// that spoken language a different pack first」 — which is now the ONLY thing
// `InUseReason` can say, so sentence and reason finally answer the same
// question. A pack still serving a live session IS the ladder's answer for the
// language being spoken, so it stays refused by the remaining hold.
//
// ⚠️ KNOWN AND STATED: `sherpa-local.ts`'s RECOGNIZER_CACHE is untouched by a
// delete — nothing can free it (no free/destroy on the addon's 99 exports, see
// test/sherpa-addon-surface.test.ts), and a cache entry for a deleted pack is
// unreachable anyway because `resolveReadyModelForLanguage` asks the controller
// whether the FILES are ready before it ever looks at the cache. An engine
// instance already holding that recognizer keeps decoding until its session
// ends — measured on 2026-09-15 to be byte-identical and crash-free, and it can
// only be reached by a pack that stopped being the ladder's answer mid-session.

import { CATALOG_SPOKEN_LANGS } from './model-catalog';
import { resolveReadyModelForLanguage, type ResolveSeams } from './model-resolve';

/** WHY a pack may not be deleted. Machine-readable: the http route puts it on
 *  the refusal so the reason survives into the desktop card's technical fold
 *  instead of being flattened into one unexplained 409. */
export type InUseReason = 'would_open';

/**
 * Every pack that is in use right now, with WHY. ONE source since NR-49: the
 * §6 ladder. `InUseReason` stays a union of one so the refusal keeps naming a
 * machine-readable reason rather than an unexplained 409 — a second reason has
 * existed once and may again.
 *
 * Sequential over the catalog's spoken languages on purpose: readiness is the
 * controller's memoised verdict, so the common case is a stat-keyed memo hit
 * per language, and this runs on a delete POST — never on the status poll's
 * hot path unless the status body asks for it.
 *
 * `seams` is the same escape hatch `resolveReadyModelForLanguage` already
 * carries and for the same stated reason: exercising the LADDER against the
 * real catalog would mean staging gigabytes of byte-correct model files.
 */
export async function modelsInUse(
  env: NodeJS.ProcessEnv = process.env,
  seams: ResolveSeams = {},
): Promise<Map<string, InUseReason>> {
  const out = new Map<string, InUseReason>();
  for (const lang of CATALOG_SPOKEN_LANGS) {
    const ready = await resolveReadyModelForLanguage(lang, env, seams);
    if (ready !== null) out.set(ready.row.model_id, 'would_open');
  }
  return out;
}
