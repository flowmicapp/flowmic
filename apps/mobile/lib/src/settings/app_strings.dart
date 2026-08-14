// SPEC-REF:
//   CLAUDE.md red line: UI does not follow OS locale — language is an explicit
//   setting.
//
// Strings for the WP-R3-3 surfaces (settings screen, login sheet, cloud-instance
// entry) in the two EXPLICIT app languages. Resolved from AppSettingsController.
// locale, never from the platform locale — flipping the UI language (界面语言)
// re-renders these
// screens, which is the language setting's live consumer. The chat-flow screen's
// strings remain zh-only for now (incremental i18n); this table is the beachhead.
//
// V2-07.2: the catalogue is split into per-domain mixins under ./strings/
// (prep for the planned Chinese/English/Japanese/Korean (中/英/日/韩) i18n
// dimension — the split adds NO
// locale axis and changes NO copy). This file stays the ONLY entry point:
// AppStrings composes the shards with `with`, so every
// `AppStrings.of(locale).someKey` call site is untouched. Note ./strings/
// deliberately has no barrel file — nobody imports the shards directly.
//
// 🔴 0.2.67 — WHERE THE STRINGS LIVE NOW (architecture doc §4.1). The shards
// used to carry four literals at every call site behind a `_t(zh:,en:,ja:,ko:)`
// helper. They now carry LOGIC and REASONING only: each string is one leaf
// (`_lf…`, declared in l10n/leaves.g.dart) implemented once per language in
// l10n/app_strings_locales.g.dart, generated from i18n/mobile/<code>.json.
// Adding a language is a row in packages/protocol/src/locales.ts plus a data
// file plus a generator run — no shard, no call site, no picker, no test.
//
// The old sentence 「each shard declares the `_t` signature it resolves
// against」 is kept out of this header on purpose: it stopped being true for 16
// of the 19 shards. Three still declare it, for the 12 call sites the migration
// REFUSED — see the note above `_t` at the bottom of this file.

import '../favorites/favorites_store.dart' show FavoriteAddOutcome;
import '../session/compose_gate.dart'
    show AiComposeFailure, AiComposeOutcome, ComposeSendFailure;
import '../session/image_clipboard.dart' show ImageCopyOutcome;
// owner 2026-08-01 cloud 1M: the refusal sentence interpolates the SAME constant
// the check uses and the SAME formatter the row face uses, so the number the
// user is refused over cannot drift from the number they are shown.
import '../session/image_payload.dart' show formatBytes, kCloudImageBytesMax;
import '../session/image_send_controller.dart'
    show ImageOriginalBlock, ImageSendFailure, ImageSendOutcome;
// window B3-2b — the queue's own two terminals, as a closed vocabulary. Imported
// for the SAME reason ComposeSendFailure / ImageSendOutcome are: the session
// layer owns the FACT and this catalogue owns the four sentences for it, so a
// message never freezes into whichever language happened to be selected when
// the delivery failed.
import '../session/outbox_failure_text.dart' show OutboxTerminal;
// B4-15 — the same reason as the two imports above: the SESSION layer owns the
// fact 「试了这几个地址，每个的结果是什么」("which addresses were tried, and what
// was the result for each") and encodes it into the error code, and
// this catalogue owns the sentence. Importing the decoder (rather than
// re-parsing the string here) is what stops the format having two readings.
import '../session/endpoint_candidates.dart'
    show CandidateFailure, decodeCandidateFailure;
// 🔴 L-② — identical reasoning one layer over: the SIGNALING layer owns the fact
// 「这次重连被服务端的抑制窗挡住了，还剩多少毫秒」("this reconnect was blocked by
// the server's suppression window, how many milliseconds are left") and owns
// the decoder; this
// catalogue owns the sentence. Importing the decoder rather than re-splitting
// the string here is what stops `CODE:ms` having two readings.
import '../signaling/mobile_reconnect_flow.dart'
    show ReconnectRefusal, decodeHoldOut, decodeRestrictionReason;
// 0.2.66 PCID — same reason as every import above, applied to two CODE NAMES
// rather than a decoder: `add_pairing_sheet` reveals the PCID field off
// `isPcidRequiredRefusal`, and this catalogue writes the sentence that tells the
// user to fill it in. Spelling the code twice is how the field would one day
// appear with the generic fallback sentence beside it, or the right sentence
// with no field.
import '../session/pcid.dart' show kPairPcidRequired, kPairPcidUnknown;
// window C export/import — same reason as the four imports above: the PORTABLE
// layer owns
// the fact (「这一行为什么没能导入」("why this row failed to import")/「导出为什么
// 没产生文件」("why the export didn't produce a file")) as a closed enum, and
// this catalogue owns the sentence. Importing the enums rather than passing
// pre-built strings is what makes a missing case a COMPILE error instead of a
// refusal that quietly reads 「格式错误」("format error") — which volume 16 §5.2
// explicitly forbids.
import '../portable/fpr_record.dart' show FprFileRefusal, FprLineRefusal;
import '../portable/portable_export.dart' show ExportFailure;
import '../portable/portable_import.dart' show ImportReport;
// SEG-2 — the two LOCAL stop reasons (link death, judged on the phone; they
// never ride the wire). Imported for the same reason every enum above is: the
// AUDIO layer owns the fact and this catalogue owns the sentence, and matching
// on the shared constant instead of a re-typed literal is what stops the
// reason having two spellings.
import '../audio/local_stop_reasons.dart'
    show kLocalStopReasonLinkLoss, kLocalStopReasonLinkLossKept;
import '../signaling/state_machine.dart' show SttStall, SttStallReason;
import '../signaling/wire_payloads.dart' show ComposeTask, FlowMode;
import 'app_settings.dart';

part 'strings/settings_strings.dart';
part 'strings/cloud_strings.dart';
part 'strings/connection_strings.dart';
part 'strings/pairing_strings.dart';
part 'strings/recording_strings.dart';
part 'strings/compose_strings.dart';
part 'strings/chat_strings.dart';
part 'strings/inject_note_strings.dart'; // G-16-b: two per-code human-readable tables (originally in chat_strings)
part 'strings/favorites_strings.dart';
// REQ-12-09 09-B/09-C: the light-record (轻记录) tab of the 「+」 panel. Placed
// after favorites because it is the second tab of the same
// panel; member names are all distinct, and the position carries no override
// semantics (same as InjectNoteStrings).
part 'strings/light_record_strings.dart';
part 'strings/image_strings.dart';
part 'strings/history_strings.dart';
// Statistics + clear (window C2, docs/rebuild/16 §6.1 / §6.2).
part 'strings/stats_strings.dart';
// 0.3.0 P1 — 「where do my words go」: the core path (capture → recognition →
// optional language-model processing → injection into the PC) plus the
// privacy-policy / terms entry. Derived from docs/legal/privacy-policy.md.
part 'strings/disclosure_strings.dart';
// ── W5a scaffold (written once by the 0.3.0 W5a lead, 2026-08-07) ────────────
// 🔴 These four shards are **pre-established empty shells**, each to be filled
// in by one of this window's four parallel lanes.
// The only reason for doing it this way: this file is AppStrings' **sole
// aggregation point**, and appending a mixin
// rewrites the last line of the `with` clause ⇒ two lanes appending at the same
// time would inevitably collide on **the same physical line**.
// One shard per person, the aggregation point written once — after that no lane
// needs to touch this file again.
part 'strings/onboarding_strings.dart'; // P-7 first-launch onboarding
part 'strings/guide_strings.dart'; // P-7 the two 「?」 page guides
part 'strings/engine_status_strings.dart'; // P-8 local engine status in diagnostics
part 'strings/selection_strings.dart'; // FB-7 multi-select/batch-copy/hand off to AI to organize
// UP-2 in-app update (check + reminder). Same as above: this file is the sole
// aggregation point, written once.
part 'strings/update_strings.dart';

// ── 0.2.67 the generated locale layer (architecture doc §4.1) ────────────────
// Two parts, and it stays two parts however many languages there are: the leaf
// contract, and every language that implements it. Adding a language adds a
// class inside the second file, never a line in this one — that is the whole
// property this migration exists to buy (§2), and a `part` directive added by
// hand per language would have quietly given it back.
part 'l10n/leaves.g.dart';
part 'l10n/app_strings_locales.g.dart';

abstract class AppStrings extends AppStringsLeaves
    with
        SettingsStrings,
        CloudStrings,
        ConnectionStrings,
        PairingStrings,
        RecordingStrings,
        ComposeStrings,
        ChatStrings,
        // Split out of ChatStrings (file-size cap). Placed immediately after it
        // so the `with` order still reads as one family; the members it carries
        // (`injectVerdictNote` / `deliveryRefusalNote`) are unique to it, so the
        // position carries no override semantics either way.
        InjectNoteStrings,
        FavoritesStrings,
        LightRecordStrings,
        ImageStrings,
        HistoryStrings,
        StatsStrings,
        DisclosureStrings,
        OnboardingStrings,
        GuideStrings,
        EngineStatusStrings,
        SelectionStrings,
        UpdateStrings {
  const AppStrings.forLocale(this.locale);

  /// Kept so the existing `AppStrings(locale)` call sites read exactly as they
  /// did before. Deliberately NOT const — a const factory needs one redirect
  /// target and this one has to choose between the languages — which is why the
  /// handful of `const AppStrings(...)` sites lost their `const`.
  factory AppStrings(AppLocale locale) => AppStrings.of(locale);
  final AppLocale locale;

  /// The one place a language is turned into a catalogue. The switch itself is
  /// GENERATED (l10n/app_strings_locales.g.dart) from
  /// packages/protocol/src/locales.ts, so a new language never edits this file.
  static AppStrings of(AppLocale locale) => _appStringsFor(locale);

  // 🔴 THE RESIDUE: 12 call sites still spell their four languages out here,
  // and they are the only ones left. Every other string in this catalogue is a
  // generated leaf (l10n/), which is why this helper reads as an exception now
  // rather than as the mechanism.
  //
  // They were refused ON PURPOSE, and by ONE rule with no judgement call in it:
  // a call whose arms interpolate DIFFERENT expressions is left alone. Twelve
  // sites meet that description and they are two different shapes:
  //   · SIX carry language-specific CONTENT inside the expression — an English
  //     plural rule (`n == 1 ? '' : 'es'`), a localised fallback
  //     (`outcome.detail ?? '未知原因'`), a localised list separator
  //     (`reasons.join('、')`), whole localised sentences inside a conditional
  //     (`portableReadme`). Hoisting those into a shared parameter list would
  //     have moved translated text OUT of the locale layer, and the next
  //     language could then never supply its own plural or its own separator
  //     without editing Dart. For these six, refusing is the right answer.
  //   · SIX are `packLabel`, where the `en` arm is not a translation at all but
  //     the protocol's own SSOT label handed in by the caller. Unioning those
  //     would in fact have been safe. They are refused anyway, because the
  //     alternative is a generator that decides case by case which
  //     disagreements are benign — and a rule that has exceptions is a rule
  //     whose next exception nobody reviews.
  //
  // ⚠️ The switch stays exhaustive with no default, so this is not a quiet debt:
  // the day AppLocale gains a fifth member, these sites fail to compile, by name,
  // and whoever adds that language has to give each of them a real answer.
  // (Everything else falls back to English by construction — volume 17 §0-bis.)
  //
  // 🔴 In-place correction (原地更正, 2026-08-14): that day came — five members
  // at once — and the
  // sentence above got the mechanism right and the ANSWER wrong. It assumed the
  // real answer had to be a fifth translated argument. Owner ruled otherwise on
  // the same day (「如果一个语种没有适当的翻译，就用默认语种的文本；默认语种是
  // 英文」("if a language has no proper translation, use the default language's
  // text; the default language is English")), so the real answer for a
  // language that has not translated these
  // twelve strings is ENGLISH — which is what the generated catalogue already
  // does structurally for every other string (`AppStringsFr extends
  // AppStringsEn`). Original text kept, not deleted (原文保留不删): it was true
  // when written, and the compile
  // error it promised is exactly what surfaced this decision.
  //
  // 🔴 THE FALLBACK HERE MUST BE THE SAME FALLBACK THE CATALOGUE USES. Making
  // `_t` fall back to `zh` for zh-TW (the intuitive move — 「it is closer」)
  // would give the app TWO answers to 「what does a missing translation show」,
  // and the two would disagree inside a single screen: one sentence in
  // Traditional Chinese from this helper, the next in English from a generated
  // leaf. `AppStringsZhTw extends AppStringsEn` in the generated file is the
  // fact this line matches — grep `class AppStringsZhTw` to re-check it rather
  // than trusting this comment (anti-façade ④).
  //
  // ⚠️ DECLARED DEGRADATION, AND THE PART THAT IS NOT MEASURED. The registry's
  // red line is that falling back silently to the USER must not mean falling
  // back silently to US, and coverage.json is how that promise is kept — but
  // coverage.json is computed from `i18n/mobile/*.json`, and these twelve
  // sentences are not in those files. So they are English in six languages and
  // NO coverage number will ever say so. Registered here rather than left to be
  // discovered: closing it means hoisting these twelve into the catalogue, and
  // the paragraph above says why each was refused.
  @override
  String _t({
    required String zh,
    required String en,
    required String ja,
    required String ko,
  }) => switch (locale) {
    AppLocale.zh => zh,
    AppLocale.ja => ja,
    AppLocale.ko => ko,
    // en, and every language whose twelve are still untranslated.
    AppLocale.en ||
    AppLocale.zhTw ||
    AppLocale.fr ||
    AppLocale.es ||
    AppLocale.de ||
    AppLocale.ru => en,
  };
}

/// Client-side term-add feedback (mirrors ScenarioCard.TermAddOutcome, kept as a
/// UI-facing enum so app_strings does not import the model).
enum TermFeedback { empty, tooLong, duplicate, atCap }
