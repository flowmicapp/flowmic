// AppStrings copy-catalogue shard: the 「+」 panel's light-record tab
// (REQ-12-09 09-B/09-C) and that panel's multi-select send
// (09-D/09-F/09-G/09-J).
//
// ⚠️ The last three sentences (`plusSelection*` / `lightRecordImageNoOriginal`)
// strictly speaking straddle the Favourites and Light-record tabs, and should
// by rights have gotten their own shard. **They did not, and the reason is
// purely mechanical**: adding a new shard means adding one line each to
// `app_strings.dart`'s `part` list and its `with` clause, and that file is
// AppStrings' one aggregation point, shared by parallel lanes (see the
// precedent in that file's W5a scaffold section).
// Two changed surfaces traded for one comment — took the comment. **This is
// NOT a domain-boundary ruling**, and the next person should not infer from it
// that 「面板文案都归轻记录」 ("all panel copy belongs to Light-record").
// The one external entry point is still ../app_strings.dart (AppStrings composes
// this mixin via `with`; from 0.2.67 on, the copy leaves `_lf…` are implemented
// by generated classes under l10n/ — this shard keeps only logic and
// argumentative comments).
//
// SPEC-REF: docs/strategy/2026-08-12-req1209-plus-panel-design.md §3-3.
//
// 🔴 WHY THESE ARE SEPARATE SENTENCES AND NOT ONE 「暂无轻记录」 ("no light
// records for now").
// Design §3-3 keeps three states apart on purpose. Merging them would answer
// two OPPOSITE questions with one sentence — 「你还没有轻记录」 ("you don't
// have any light records yet") and 「你有，但我们没在读」 ("you have some, but
// we're not reading them") — which is this repo's headline bug shape. The
// expensive one is state
// B: the phone is signed out and the rows ARE on disk. Saying 「暂无」
// ("none for now") there is a
// lie in the direction 15 册 F2 forbids just as hard as inventing data.
part of '../app_strings.dart';

mixin LightRecordStrings on AppStringsLeaves {

  /// Between opening the tab and the disk answering. Deliberately NOT 「暂无轻
  /// 记录」 ("no light records for now"): at this instant we do not yet know whether there are any, and a
  /// sentence that guesses would flip to its opposite a moment later.
  String get lightRecordsLoading => _lfLightRecordsLoading;

  /// State A — signed out AND nothing on this phone.
  ///
  /// The ONE state here that may carry an imperative, and the reason is design
  /// §3-3: signing in is an action the user can actually perform, and it is the
  /// action that resolves what they are looking at. (The refusal copy for 「no PC
  /// to send to」 is the opposite case — there the user can do nothing, so that
  /// sentence states a fact and stops.)
  String get lightRecordsSignedOutEmpty => _lfLightRecordsSignedOutEmpty;

  /// State B — signed out but this phone HAS light records.
  ///
  /// 🔴 The rows below this line are real and are listed. This sentence exists
  /// only to bound what the list claims: it is this phone's notes, not the
  /// account's. Stating that is what lets the list be shown at all.
  String get lightRecordsSignedOutNotice => _lfLightRecordsSignedOutNotice;

  /// Signed in, and this phone genuinely has none.
  String get lightRecordsEmpty => _lfLightRecordsEmpty;

  String get lightRecordsSearchHint => _lfLightRecordsSearchHint;

  /// A search that ran and matched nothing — deliberately a different sentence
  /// from [lightRecordsEmpty], because 「你没有轻记录」 ("you have no light
  /// records") and 「这个词没搜到」 ("no match for this term") are
  /// different facts and lead the user to different next moves.
  String get lightRecordsSearchNoMatch => _lfLightRecordsSearchNoMatch;

  // ── 09-D/09-F/09-J multi-select send ───────────────────────────────────────

  /// Sends whatever is currently ticked.
  ///
  /// ⚠️ 「到电脑」 ("to the computer") is not filler: this panel also has a
  /// 「存当前缓冲」 ("save current buffer") button, and both are buttons —
  /// one means **save locally**, the other means **send to that PC**. A button
  /// that just said 「发送」 ("send") would have to be told apart by its
  /// position, and position can change.
  String get plusSelectionSend => _lfPlusSelectionSend;

  /// 🔴 owner 2026-08-12: 「Images must be sendable in new line, not merging to
  /// text line.」 — text merges into **one** message, while each picture
  /// becomes **its own** message.
  ///
  /// This sentence exists for exactly one reason: the user ticks 3 text rows +
  /// 2 pictures, presses send, and receives **3 messages**,
  /// while the screen only said 「已选 5 条」 ("5 items selected"). **Saying it
  /// before the press is cheaper than explaining after the fact** (the same
  /// precedent as `selectionCopySub`'s 「只复制文字」 — "only text gets
  /// copied").
  /// ⚠️ The sentence contains **not a single number** (the M5-③ precedent:
  /// device counts/item counts never go into copy) — the count is already on
  /// the line right above it.
  String get plusSelectionImagesSeparate => _lfPlusSelectionImagesSeparate;

  /// 🔴 09-G — pre-existing light-record picture rows can **never** be sent,
  /// and this stands where the checkbox would be.
  ///
  /// The fact (RV-93, `image_send_controller.dart`'s `_saveLocal` states it in
  /// its own comment): that path **only** ever wrote the 256px thumbnail and
  /// the label — the original image bytes were **never written at all**. Not
  /// deleted, not still transferring, not a network issue.
  ///
  /// 🔴 Therefore this sentence **must not** contain any imperative, nor any
  /// word like 「暂」 ("for now") / 「稍后」 ("later") / 「重试」 ("retry")
  /// that hints things will get better if you wait — those bytes are never
  /// coming back. All four languages are pure statements of fact.
  /// (Contrast: `lightRecordsSignedOutEmpty` is the **only** slot on this
  /// panel allowed to carry an imperative, because 「去登录」 ("go sign in")
  /// is something the user can genuinely do, and it genuinely resolves the
  /// thing in front of them.)
  ///
  /// ⚠️ It also **does not apply** to light-record pictures taken after this
  /// ruling: those rows' bytes ARE written by 09-I, and they ARE selectable.
  /// This sentence describes only **the row in hand**, not the category
  /// 「轻记录图片」 ("light-record pictures") as a whole.
  String get lightRecordImageNoOriginal => _lfLightRecordImageNoOriginal;
}
