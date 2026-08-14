// 🔴 Card G-16-b — THE BINDING between the protocol's error-code registry and
// the phone's hand-maintained copy tables.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// There was no mechanism. The registry
// (`packages/protocol/src/error-codes.ts`) and the phone's three copy switches
// were two hand-maintained lists that agreed only as long as somebody
// remembered. The history of that seam, all of it paid for in shipped
// releases:
//
//   · 0.2.53 — `INJECT_SELF_WINDOW_NO_INPUT` reached a user's screen as
//     「INJ…」: a raw identifier, clipped to three letters. Every gate was
//     green and 1259 mobile tests passed, because the tests asserted
//     `Text.data` while the user reads the glyphs left after layout.
//   · Card U5's own doc records that ~53 of the registry's codes have exactly
//     one fate on this phone today: `_reasonLineFor` truncates the identifier
//     to 28 characters and puts it in the meta row.
//   · The 62→64 window wrote the prophecy down verbatim: 「没有任何机制把协议
//     注册表与手机那张表绑在一起 —— 下一个新码会以同样的方式变成用户屏幕上的
//     裸标识符，而所有门禁全绿」.
//
// This file is that missing mechanism. It fails at the moment a NEW code that
// can ride `inject:result` is registered without copy — naming the code and
// naming the table it belongs in.
//
// ── 🔴 WHAT THIS GATE DOES **NOT** DO, AND WHY ──────────────────────────────
//
// It does not demand copy for all 64 codes. Most of them cannot reach this
// surface at all (login, pairing, STT, billing, timeline), and authoring 53
// sentences for codes no user can see would be fake completeness — it would
// also bury the handful that matter. The gate's whole design rests on being
// able to answer 「can this code reach the phone's row surface」 MECHANICALLY
// rather than by opinion, which it can:
//
//   `inject-verdict-authorship.ts` already declares, for every registry code,
//   whether the code rides `inject:result` and who authored the verdict. That
//   table is compiler-enforced exhaustive over `ErrorCode`
//   (`satisfies Record<ErrorCode, InjectVerdictAuthor>`), so it cannot fall
//   behind the registry. `author != 'none'` IS the reachability predicate, and
//   it is the protocol's own answer, not this test's guess.
//
// ── HOW A CODE BECOMES VISIBLE (the chain this gate protects) ───────────────
//
//   1. code arrives on `inject:result.error`      (⟺ author != 'none')
//   2. the outbox settles, the row keeps `failureReason`
//   3. `deliveryFaceOf` → a face                  (status_badge.dart)
//   4. `_faceSpeaksReason` → does this face say 「凭什么」  (chat_message_tile)
//   5. if it speaks:  human copy  ??  THE RAW IDENTIFIER
//
// Step 5 is the defect. Step 4 is where judgement legitimately lives — some
// faces are deliberately silent because the face's own word already IS the
// explanation. That judgement is NOT re-derived here; it is recorded per code
// in [kCopyGapAllowlist], with the greppable anchor for each claim.
//
// ── SEGMENT-AWARENESS IS PART OF THE CONTRACT, NOT A DETAIL ─────────────────
//
// The three tables are deliberately separate and their code sets are
// disjoint (each table's own doc says so in prose — this file is the first
// thing that MEASURES it). 投递 ≠ 注入 (docs/rebuild/15 §2.0): a delivery-segment
// refusal must not be answered by an injection-segment sentence, and the reverse.
// So the gate does not merely ask 「is there copy somewhere」 — it asks
// 「is there copy in the table this code's SEGMENT belongs to」.
//
// SPEC-REF:
//   packages/protocol/src/error-codes.ts                 (the registry)
//   packages/protocol/src/inject-verdict-authorship.ts   (segment truth)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0 / §2.0.1
//   CLAUDE.md 红线 R11 (状态词要能回答「凭什么这么说」) / 没有静默失败

import 'dart:io';

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

// ── The three tables, by name ────────────────────────────────────────────────
//
// These are the exact three `_humanNoteFor` composes, in its order. A test
// below reads that function's source and fails if the composition ever grows a
// fourth table this gate does not know about — because a table the gate cannot
// see is a table whose codes it would report as missing copy (noise) or, far
// worse, whose WRONG-SEGMENT copy it would never notice.
enum CopyTable {
  /// [ImageStrings.cloudImageRelayErrorNote] — the two cloud-relay image
  /// policy refusals. A relay-authored delivery-segment sub-family that predates
  /// `deliveryRefusalNote` and keeps its own table because its sentences
  /// interpolate the live caps (`kCloudImageBytesMax` / quota constants).
  cloudImage,

  /// [ChatStrings.injectVerdictNote] — PC-authored INJECTION-segment verdicts.
  /// The frame reached the PC; the PC tried and said why it did not land.
  injectVerdict,

  /// [ChatStrings.deliveryRefusalNote] — relay-authored DELIVERY-segment refusals.
  /// The frame never reached any PC.
  deliveryRefusal,
}

/// Which table is allowed to answer for a code with this authorship.
///
/// 🔴 This map IS the segment rule, and it is derived from each table's own
/// documented charter — not invented here:
///   · `injectVerdictNote`'s doc: 「那个函数覆盖的六个码全部是 PC 亲口答的注入段
///     裁决（帧确实到了 PC，PC 试了才拒绝）」;
///   · `deliveryRefusalNote`'s doc: 「这里的四个全部是 relay/协议层的投递段裁决
///     （帧压根没到 PC，PC 从未参与判决）」, and its own 「绝不许进 injectVerdictNote」.
///
/// `pc-admission` deliberately maps to NO table: the frame did reach the PC,
/// but the PC refused before the injection stage, so neither charter covers it.
/// Its one member is allowlisted below rather than forced into a table whose
/// sentence would be false about which segment finished.
const Map<String, Set<CopyTable>> kTableForAuthor = <String, Set<CopyTable>>{
  'pc-injection': <CopyTable>{CopyTable.injectVerdict},
  'relay': <CopyTable>{CopyTable.deliveryRefusal, CopyTable.cloudImage},
  'pc-admission': <CopyTable>{},
};

/// Why a reachable code legitimately has no copy.
enum CopyGapKind {
  /// 🟢 The code has its OWN [DeliveryFace] whose word IS the explanation, and
  /// `_faceSpeaksReason` excludes that face on purpose. Adding copy would say
  /// the same fact twice.
  ownFaceSpeaksForIt,

  /// 🟡 The code lands on a face that stays SILENT for every code
  /// (`undelivered` without recognised copy) under the long-standing
  /// RV-14/RV-67 rule. No raw identifier reaches the user — but no explanation
  /// does either. A candidate for the treatment `INJECT_PC_OFFLINE` got in
  /// card G-16-a; not decided by this gate.
  silentFaceByRule,

  /// 🔴 OPEN DEFECT — this code DOES reach a face that speaks, so a user sees
  /// the raw identifier today. Allowlisted only so this gate can be born green
  /// (repo law: a gate that starts red is a gate everyone learns to ignore),
  /// and PRINTED loudly by [main] so it is a named debt rather than a silent
  /// omission (the FB-5b precedent).
  openDefect,
}

class CopyGap {
  const CopyGap(this.kind, this.reason);

  final CopyGapKind kind;

  /// 🔴 Every reason must carry a GREPPABLE anchor (symbol, not line number —
  /// IJ-01: a line-numbered citation turns somebody else's ordinary edit into
  /// this file's failing gate). 反 façade ④: a comment asserting behaviour
  /// elsewhere is a claim whose truth changes when that code changes.
  final String reason;
}

/// 🔴 THE NAMED ALLOWLIST — reachable codes that deliberately have no copy.
///
/// Silence is the anti-pattern; a named list the gate prints is the fix. Every
/// entry states WHICH mechanism makes the absence correct (or, for the one
/// `openDefect`, states plainly that it is not correct).
///
/// ⚠️ Adding an entry here is a product decision, not a way to quiet the gate.
/// The gate also fails on a STALE entry (a code listed here that has since been
/// given copy), so the list cannot rot in the other direction either.
const Map<String, CopyGap> kCopyGapAllowlist = <String, CopyGap>{
  'INJECT_NO_TEXT_TARGET': CopyGap(
    CopyGapKind.ownFaceSpeaksForIt,
    'Has its own face: DeliveryFace.noFocus, whose SOLE trigger is this code '
    '(status_badge.dart `_isNoFocusReason`). `_faceSpeaksReason` excludes '
    'noFocus, so no raw identifier is rendered. The face word carries owner '
    "2026-08-01's verbatim action 「点进输入框再重发就能落」 — a second sentence "
    'would state the same fact twice.',
  ),
  'INJECT_DEFERRED_NOT_AUTOINJECTED': CopyGap(
    CopyGapKind.ownFaceSpeaksForIt,
    'Has its own face: DeliveryFace.deferredNotInjected '
    '(status_badge.dart `_isDeferredNotInjectedReason`, its only trigger). '
    'chat_message_tile.dart `_reasonLineFor` argues the exclusion in three '
    'numbered points, including ③ 「不许把 ERROR_CODES 里那句长话搬到这里」 — the '
    "registry sentence is written for the PC's reader, not the phone's.",
  ),
  'INJECT_NOT_PRIMARY': CopyGap(
    CopyGapKind.silentFaceByRule,
    'pc-admission ⇒ the queue still owes the item (owner 2026-08-02 「被占用时行'
    '=待投递」), so the row lands on DeliveryFace.undelivered, which stays silent '
    'unless copy exists (chat_message_tile.dart `_faceSpeaksReason`). No raw '
    'identifier reaches the user. Giving it copy would be the G-16-a move and '
    'is a product decision this gate does not make.',
  ),
  'INJECT_NOT_IN_ROOM': CopyGap(
    CopyGapKind.silentFaceByRule,
    'relay-authored and NOT terminal (outbox_item.dart `isTerminalRefusalCode` '
    '⇒ false) ⇒ requeued ⇒ DeliveryFace.undelivered ⇒ silent. Its silence is '
    'already PINNED as a deliberate reverse control by two existing tests '
    '(cloud_image_error_copy_test.dart 「反向对照: 别的未投递码…照旧不给任何理由行」 '
    'and chat_ui_widget_test.dart) — so copy here would redden those on purpose, '
    'which is a decision for the card that authors it, not for this gate.',
  ),
  // ⚠️ `INJECT_SERVER_BUSY` WAS HERE, as this gate's one `openDefect`, and is
  // deliberately NOT replaced by a comment-shaped placeholder: it now has copy
  // in `deliveryRefusalNote` (card G-16-b follow-up), so the gate protects it
  // like every other reachable code. Recorded here only because the sequence is
  // the point — the mechanism NAMED a live defect that no person had spotted,
  // and the fix then had to satisfy the gate's own placement rule
  // (relay ⇒ delivery segment). Judged by `test/server_busy_note_test.dart`.
};

// ── Reading the protocol SSOT from Dart ─────────────────────────────────────
//
// Dart cannot import TypeScript, so the mirror is read as SOURCE TEXT. This is
// not a new technique for this repo: `inject_verdict_authorship_mirror_test`
// does exactly this, and so does the Rust side
// (`error_codes.rs::desktop_error_codes_are_a_subset_of_the_protocol_ssot`).
// `flutter test`'s working directory is always this package root (apps/mobile).

final File _registryFile = File('../../packages/protocol/src/error-codes.ts');
final File _authorshipFile = File(
  '../../packages/protocol/src/inject-verdict-authorship.ts',
);
final File _tileFile = File('lib/src/ui/chat_message_tile.dart');

/// 🔴 Card fix-015 — the structural pin below reads `_humanNoteFor` as SOURCE,
/// and that function no longer lives in [_tileFile]: the 800-line cap forced the
/// reason-copy family out into the `part` file `chat_row_reason.dart`
/// (verbatim move, same library, same privacy, zero behaviour change).
///
/// A LIST rather than a second hard-coded path, and that is the point: the gate
/// broke the moment a file was split, which is a thing this repo does routinely
/// (`live_draft_tile.dart` before it, `chat_transient_banner_timers.dart`,
/// `ptt_wire_keepalive.dart`). Searching the library's own files means the NEXT
/// split does not take this gate down with it. The pin below still requires
/// EXACTLY ONE of them to define the function, so a copy-paste duplicate — two
/// definitions drifting apart — fails just as loudly as a rename.
final List<File> _tileLibraryFiles = <File>[
  _tileFile,
  File('lib/src/ui/chat_row_reason.dart'),
  File('lib/src/ui/live_draft_tile.dart'),
];

/// Registry rows look like `  CODE_NAME:  { zh_CN: '…', en: '…' },`.
/// Anchored at two-space indent + requiring `{ zh_CN:` so that prose mentions
/// of a code inside the file's (very long) comments cannot match.
final RegExp _registryEntry = RegExp(
  r'^\s{2}([A-Z][A-Z0-9_]*):\s*\{\s*zh_CN:',
  multiLine: true,
);

/// Authorship rows: `  CODE_NAME: 'author',` — same shape the existing mirror
/// test parses. Comment mentions never match (they are prefixed by `//`/`*`)
/// and the union-type arms (`| 'pc-injection'`) have no `CODE:` prefix.
final RegExp _authorshipEntry = RegExp(
  r"^\s*([A-Z][A-Z0-9_]*)\s*:\s*'(pc-injection|pc-admission|relay|none)'\s*,",
  multiLine: true,
);

String _read(File f) {
  // A guard that silently passes when its input is missing is not a guard.
  expect(
    f.existsSync(),
    isTrue,
    reason:
        'Protocol SSOT not found at ${f.path} — `flutter test` must run with '
        'apps/mobile as the working directory.',
  );
  return f.readAsStringSync();
}

Set<String> _registryCodes() => _registryEntry
    .allMatches(_read(_registryFile))
    .map((RegExpMatch m) => m.group(1)!)
    .toSet();

Map<String, String> _authorship() {
  final Map<String, String> out = <String, String>{};
  for (final RegExpMatch m in _authorshipEntry.allMatches(
    _read(_authorshipFile),
  )) {
    out[m.group(1)!] = m.group(2)!;
  }
  return out;
}

/// The production copy functions, asked exactly as `_humanNoteFor` asks them.
/// 🔴 This calls the REAL tables — it does not re-parse the Dart switches. A
/// gate that read the source text of the thing it guards would go green on a
/// `case` that returns an empty string.
Set<CopyTable> _tablesAnswering(String code, AppStrings s) => <CopyTable>{
  if (s.cloudImageRelayErrorNote(code) != null) CopyTable.cloudImage,
  if (s.injectVerdictNote(code) != null) CopyTable.injectVerdict,
  if (s.deliveryRefusalNote(code) != null) CopyTable.deliveryRefusal,
};

const AppStrings _zh = AppStringsZh();

void main() {
  group('G-16-b · registry ↔ phone copy-table binding', () {
    // ── ① POSITIVE CONTROLS ────────────────────────────────────────────────
    //
    // Every assertion below is a claim about a SET. A regex that silently
    // stopped matching would make all of them vacuously green — the failure
    // mode this repo has already been burned by (「负向/相等断言必须自带正向对照」).
    test('positive control: both SSOT files parse, and richly', () {
      final Set<String> registry = _registryCodes();
      final Map<String, String> authorship = _authorship();

      expect(
        registry.length,
        greaterThanOrEqualTo(60),
        reason: 'registry parser drifted — got ${registry.length} codes',
      );
      expect(
        authorship.length,
        greaterThanOrEqualTo(60),
        reason: 'authorship parser drifted — got ${authorship.length} rows',
      );
      // All four authorship values must be observed, or the reachability
      // predicate below could be filtering on a value that no longer exists.
      expect(
        authorship.values.toSet(),
        containsAll(<String>['pc-injection', 'pc-admission', 'relay', 'none']),
      );
      // And the copy tables themselves must be non-empty, or "has copy"
      // would be trivially false everywhere.
      expect(_zh.injectVerdictNote('INJECT_FOCUS_LOST'), isNotNull);
      expect(_zh.deliveryRefusalNote('INJECT_PC_MISMATCH'), isNotNull);
      expect(
        _zh.cloudImageRelayErrorNote('INJECT_CLOUD_IMAGE_TOO_LARGE'),
        isNotNull,
      );
    });

    test('every registry code has an authorship row', () {
      // TS `satisfies Record<ErrorCode, …>` already enforces this at compile
      // time. Asserted again here because THIS gate's reachability predicate
      // reads the authorship table: if a code were ever missing from it, the
      // code would be invisible to the gate — i.e. it would fail OPEN, which
      // is the one failure direction a guard must never have.
      final Map<String, String> authorship = _authorship();
      final List<String> missing = _registryCodes()
          .where((String c) => !authorship.containsKey(c))
          .toList();
      expect(
        missing,
        isEmpty,
        reason:
            'These registry codes have no row in inject-verdict-authorship.ts, '
            'so this gate cannot see them: $missing',
      );
    });

    // ── ② THE GATE ─────────────────────────────────────────────────────────
    test(
      '🔴 every code that can ride inject:result has copy in its segment\'s '
      'table, or is named in the allowlist',
      () {
        final Map<String, String> authorship = _authorship();
        final List<String> reachable =
            authorship.entries
                .where((MapEntry<String, String> e) => e.value != 'none')
                .map((MapEntry<String, String> e) => e.key)
                .toList()
              ..sort();

        // Positive control on the predicate itself: if this ever went to zero
        // (or to "everything"), the loop below would prove nothing.
        expect(reachable.length, inInclusiveRange(5, 40));

        final List<String> failures = <String>[];
        for (final String code in reachable) {
          final String author = authorship[code]!;
          final Set<CopyTable> answering = _tablesAnswering(code, _zh);
          final Set<CopyTable> allowed =
              kTableForAuthor[author] ?? const <CopyTable>{};

          if (answering.isEmpty) {
            if (!kCopyGapAllowlist.containsKey(code)) {
              failures.add(
                '$code (author: $author) — NO user-facing copy anywhere. '
                'It can arrive on inject:result, so a user can be shown the '
                'bare identifier. Add a `case \'$code\':` to '
                '${allowed.isEmpty ? '(no table matches this authorship — see kTableForAuthor)' : allowed.map(_tableName).join(' or ')}'
                ', or declare it in kCopyGapAllowlist with a reason.',
              );
            }
            continue;
          }

          // Copy exists — it must be in the RIGHT segment's table.
          final Set<CopyTable> wrong = answering.difference(allowed);
          if (wrong.isNotEmpty) {
            failures.add(
              '$code (author: $author) — copy lives in '
              '${wrong.map(_tableName).join(', ')}, which is the wrong '
              'segment. 投递 ≠ 注入 (15 册 §2.0): allowed here is '
              '${allowed.isEmpty ? '(none)' : allowed.map(_tableName).join(' or ')}.',
            );
          }
        }

        expect(
          failures,
          isEmpty,
          reason:
              '\n🔴 REGISTRY ↔ COPY BINDING BROKEN:\n  ${failures.join('\n  ')}\n',
        );
      },
    );

    test('the three tables stay disjoint (each code answered once)', () {
      // Each table's doc asserts this in prose ("三张表互斥"). Nothing measured
      // it until now — and `_humanNoteFor`'s `??` chain means a code answered
      // by two tables silently takes whichever comes first, i.e. the ORDER
      // would quietly become the contract.
      final Map<String, String> authorship = _authorship();
      final List<String> doubled = <String>[];
      for (final String code in authorship.keys) {
        final Set<CopyTable> answering = _tablesAnswering(code, _zh);
        if (answering.length > 1) {
          doubled.add('$code → ${answering.map(_tableName).join(' + ')}');
        }
      }
      expect(doubled, isEmpty, reason: 'codes answered by >1 table: $doubled');
    });

    test('no copy exists for a code that cannot arrive on inject:result', () {
      // The mirror direction of the gate. A `case` for a code whose authorship
      // is 'none' is copy nothing can ever render — a façade on the copy face,
      // and (worse) a sentence someone later reuses to answer a different
      // question. Same reasoning that retired INJECT_NO_RECEIPT and
      // CLOUD_SESSION_NO_HISTORY from the registry itself.
      final Map<String, String> authorship = _authorship();
      final List<String> dead = <String>[];
      for (final MapEntry<String, String> e in authorship.entries) {
        if (e.value != 'none') continue;
        final Set<CopyTable> answering = _tablesAnswering(e.key, _zh);
        if (answering.isNotEmpty) {
          dead.add('${e.key} → ${answering.map(_tableName).join(', ')}');
        }
      }
      expect(
        dead,
        isEmpty,
        reason:
            'copy for codes that never ride inject:result (nothing can render '
            'it): $dead',
      );
    });

    // ── ③ THE ALLOWLIST CANNOT ROT ─────────────────────────────────────────
    test('allowlist has no stale or unreachable entries', () {
      final Map<String, String> authorship = _authorship();
      final List<String> problems = <String>[];

      for (final MapEntry<String, CopyGap> e in kCopyGapAllowlist.entries) {
        final String? author = authorship[e.key];
        if (author == null) {
          problems.add(
            '${e.key} is not a registry code at all (renamed or deleted?)',
          );
          continue;
        }
        if (author == 'none') {
          problems.add(
            '${e.key} is authorship \'none\' ⇒ it cannot reach this surface, '
            'so it does not need an exemption. Delete the row.',
          );
          continue;
        }
        if (_tablesAnswering(e.key, _zh).isNotEmpty) {
          problems.add(
            '${e.key} NOW HAS COPY — the exemption is stale. Delete the row '
            'so the gate protects it like every other code.',
          );
        }
        expect(
          e.value.reason.trim().length,
          greaterThan(40),
          reason: '${e.key}: an exemption without a real reason is a silent '
              'omission wearing a name.',
        );
      }

      expect(problems, isEmpty, reason: 'allowlist rot: $problems');
    });

    // ── ④ STRUCTURAL PIN ON THE COMPOSITION ────────────────────────────────
    test('_humanNoteFor still composes exactly the three known tables', () {
      // If a fourth copy table joins that `??` chain, this gate would report
      // its codes as missing copy (noise) or — far worse — never notice copy
      // authored into the WRONG segment, because it would not know the table
      // exists. Read the source rather than trusting memory: the function is
      // private, so it cannot be called from here.
      // 🔴 Card fix-015 — searched across the library's files, not read from one
      // path: the function moved to `chat_row_reason.dart` when the 800-line cap
      // forced a split. EXACTLY ONE file must define it, so a duplicated
      // definition fails here as loudly as a rename would.
      final List<File> defining = _tileLibraryFiles
          .where((File f) => _read(f).contains('String? _humanNoteFor('))
          .toList();
      expect(
        defining.length,
        1,
        reason: defining.isEmpty
            ? '_humanNoteFor not found in ${_tileLibraryFiles.map((File f) => f.path).join(', ')} '
                  '— renamed, or moved out of the chat_message_tile library?'
            : '_humanNoteFor is defined in ${defining.length} files '
                  '(${defining.map((File f) => f.path).join(', ')}) — two copies '
                  'of the composition is exactly what this gate exists to stop.',
      );
      final String src = _read(defining.single);
      final int start = src.indexOf('String? _humanNoteFor(');
      final int end = src.indexOf(';', start);
      final String body = src.substring(start, end);

      const List<String> known = <String>[
        'cloudImageRelayErrorNote',
        'injectVerdictNote',
        'deliveryRefusalNote',
      ];
      for (final String table in known) {
        expect(
          body.contains(table),
          isTrue,
          reason: '_humanNoteFor no longer consults $table',
        );
      }
      // Count the `strings.<x>(` calls: exactly three, no more.
      final int calls = RegExp(r'strings\.\w+\(').allMatches(body).length;
      expect(
        calls,
        known.length,
        reason:
            '_humanNoteFor now consults $calls copy tables, but this gate knows '
            'about ${known.length} (${known.join(', ')}). Teach CopyTable / '
            'kTableForAuthor about the new one — an unknown table is a table '
            'whose wrong-segment copy nothing checks.\nBody:\n$body',
      );
    });

    // ── ⑤ COVERED CODES ARE COVERED IN ALL FOUR LANGUAGES ──────────────────
    test('every covered code has non-empty copy in all four locales', () {
      // The i18n lint (`verify:lint i18n-error-keys`) guards the REGISTRY's
      // zh_CN+en. Nothing guarded these phone-side tables, which carry four
      // languages and are hand-written.
      final Map<String, String> authorship = _authorship();
      final List<String> bad = <String>[];
      for (final AppLocale loc in AppLocale.values) {
        final AppStrings s = AppStrings(loc);
        for (final String code in authorship.keys) {
          for (final CopyTable t in _tablesAnswering(code, _zh)) {
            final String? note = switch (t) {
              CopyTable.cloudImage => s.cloudImageRelayErrorNote(code),
              CopyTable.injectVerdict => s.injectVerdictNote(code),
              CopyTable.deliveryRefusal => s.deliveryRefusalNote(code),
            };
            if (note == null || note.trim().isEmpty) {
              bad.add('$code/${loc.name}/${_tableName(t)}');
            }
          }
        }
      }
      expect(bad, isEmpty, reason: 'missing/empty localisations: $bad');

      // Positive control: zh and en must actually differ for a known code, or
      // the loop above could be reading one locale four times.
      expect(
        AppStrings(AppLocale.zh).injectVerdictNote('INJECT_FOCUS_LOST'),
        isNot(
          equals(
            AppStrings(AppLocale.en).injectVerdictNote(
              'INJECT_FOCUS_LOST',
            ),
          ),
        ),
      );
    });

    // ── ⑥ PRINT THE DEBT (FB-5b: a named list the gate prints) ─────────────
    test('report: reachable-code copy coverage', () {
      final Map<String, String> authorship = _authorship();
      final List<String> reachable = authorship.entries
          .where((MapEntry<String, String> e) => e.value != 'none')
          .map((MapEntry<String, String> e) => e.key)
          .toList();
      final int covered = reachable
          .where((String c) => _tablesAnswering(c, _zh).isNotEmpty)
          .length;

      final StringBuffer b = StringBuffer()
        ..writeln('')
        ..writeln('── G-16-b coverage ──────────────────────────────────────')
        ..writeln('registry codes            : ${_registryCodes().length}')
        ..writeln('reachable on inject:result: ${reachable.length}')
        ..writeln('  with copy               : $covered')
        ..writeln('  declared gaps           : ${kCopyGapAllowlist.length}');
      for (final CopyGapKind kind in CopyGapKind.values) {
        final Iterable<String> codes = kCopyGapAllowlist.entries
            .where((MapEntry<String, CopyGap> e) => e.value.kind == kind)
            .map((MapEntry<String, CopyGap> e) => e.key);
        if (codes.isEmpty) continue;
        final String mark = switch (kind) {
          CopyGapKind.ownFaceSpeaksForIt => '🟢',
          CopyGapKind.silentFaceByRule => '🟡',
          CopyGapKind.openDefect => '🔴',
        };
        b.writeln('    $mark ${kind.name}: ${codes.join(', ')}');
      }
      b.writeln('─────────────────────────────────────────────────────────');
      // ignore: avoid_print
      print(b.toString());

      // Every reachable code is accounted for, one way or the other. This is
      // the invariant the printout describes, asserted rather than eyeballed.
      expect(covered + kCopyGapAllowlist.length, reachable.length);
    });
  });
}

String _tableName(CopyTable t) => switch (t) {
  CopyTable.cloudImage => 'cloudImageRelayErrorNote',
  CopyTable.injectVerdict => 'injectVerdictNote',
  CopyTable.deliveryRefusal => 'deliveryRefusalNote',
};
