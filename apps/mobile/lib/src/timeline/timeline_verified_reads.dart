// NR-137 round 6 (review D2) — STORAGE READS A DECISION CAN STAND ON.
//
// The ordinary readers SKIP a physical row whose payload will not decode
// (`SqfliteTimelinePersistence._decode`, `SharedPrefsTimelinePersistence
// .loadAll`, `InMemoryTimelinePersistence.loadAll`). That is right for a list
// on screen — half an entry rendered as if whole is worse than a gap — and
// wrong for a proof: skipped reads as ABSENT, so a row still on disk was taken
// as removed, the press said done and the retained audio went (measured:
// nr137_unreadable_row_test.dart, both backends).
//
// 🔴 THREE ANSWERS, NOT TWO. A keyed read here is readable, absent, or
// UNREADABLE (storage holds a row under that id and cannot say what it is).
// An inventory here says which physical rows it could NOT decode, so a caller
// that needs "every row" can tell a complete answer from one with holes.
//
// ⚠️ NR-137 round 9 (review r8, B1–B4): was "unreadable is unverified, and
// every caller treats it like a read that threw". Four more false proofs got
// through that rule, each through a DEFAULT that answered a question nobody
// had evidence for: a missing `article_id` read as "no article" (B1), a store
// nobody listed (B2), a malformed key's suffix standing in for the payload's
// id (B3), and a readable tombstone answering before the residue was looked
// at (B4). Now:
//   · a decision is taken in ONE place, [TimelineProof], from one census of
//     every registered store (`timeline_row_stores.dart`) plus the keyed reads
//     it asked for, and nothing else answers for it;
//   · evidence is POSITIVE ONLY. An identity or an article counts only when a
//     source states it and no source contradicts it ([agreedRowId],
//     [agreedArticle]). Missing, malformed, unparsed or conflicting is unknown,
//     and unknown may be anything;
//   · a store that could not be read is [TimelineInventory.unread], and then
//     nothing is proven.
//
// Ordinary list views keep the lenient readers and their skip-and-report
// behaviour (`TimelineReadIssues`); nothing on screen changes.

import 'dart:convert';

import '../diag/diag_log.dart';
import 'article_view.dart' show articleMembersIn;
import 'timeline_entry.dart';
import 'timeline_persistence.dart';
import 'timeline_row_stores.dart';

/// What storage holds under one id.
enum StoredRowState { readable, absent, unreadable }

/// One keyed read: [entry] is non-null exactly when [state] is readable.
class StoredRow {
  const StoredRow.readable(TimelineEntry this.entry)
      : state = StoredRowState.readable;
  const StoredRow.absent()
      : state = StoredRowState.absent,
        entry = null;
  const StoredRow.unreadable()
      : state = StoredRowState.unreadable,
        entry = null;

  final StoredRowState state;
  final TimelineEntry? entry;
}

/// A physical item that is not a decoded row of the active store, with what
/// positive evidence says it may be. The defaults are unknown.
class UnreadableRow {
  const UnreadableRow({this.id, this.articleKnown = false, this.articleId});

  /// The one id every source agrees on, or null: it may be any row.
  final String? id;

  /// True only when a source states the article and none contradicts it
  /// (a decoded row's own `articleId`, null included, is such a statement).
  final bool articleKnown;
  final String? articleId;

  bool mayBelongTo(String article) => !articleKnown || articleId == article;
  bool mayBe(String rowId) => id == null || id == rowId;
}

/// Every row storage could decode, every physical item it could not, and every
/// registered store it could not read at all.
class TimelineInventory {
  const TimelineInventory(this.rows, this.unreadable,
      {this.unread = const <TimelineRowStore>{}});

  /// An implementation that cannot report its unreadable rows: one row of
  /// unknown identity is assumed missing, so nothing that needs "complete"
  /// can be decided on it.
  const TimelineInventory.unknown(this.rows)
      : unreadable = const <UnreadableRow>[UnreadableRow()],
        unread = const <TimelineRowStore>{};

  final List<TimelineEntry> rows;
  final List<UnreadableRow> unreadable;

  /// Registered stores this backend could not read (round 9). Any one of them
  /// may hold any row of any article.
  final Set<TimelineRowStore> unread;

  bool get complete => unreadable.isEmpty && unread.isEmpty;

  /// May a member of [articleId] be among the rows that could not be read?
  bool mayOmitMemberOf(String articleId) =>
      unread.isNotEmpty ||
      unreadable.any((UnreadableRow u) => u.mayBelongTo(articleId));
}

/// Implemented by every production persistence (SQLite, the SharedPrefs
/// fallback, the in-memory null object).
abstract interface class TimelineVerifiedReads {
  /// Decoded rows plus every other physical item, across every registered
  /// store this backend can see (`TimelineRowStore`).
  Future<TimelineInventory> loadInventory();

  /// Does storage hold a physical row under [id], readable or not? True when
  /// it cannot rule that out.
  Future<bool> mayHoldRow(String id);
}

/// The id of a physical item, from what its key and its payload say. An id
/// only when at least one source names it, every naming source names the same
/// one, and no source is malformed. A key that does not decode, a payload
/// `id` that is present but not a non-empty string, or two different ids:
/// null (round 9, review B3).
String? agreedRowId({
  String? keyId,
  bool keyMalformed = false,
  Map<Object?, Object?>? payload,
}) {
  if (keyMalformed) return null;
  String? fromPayload;
  if (payload != null && payload.containsKey('id')) {
    final Object? v = payload['id'];
    if (v is! String || v.isEmpty) return null;
    fromPayload = v;
  }
  final Set<String> named = <String>{?keyId, ?fromPayload};
  return named.length == 1 ? named.single : null;
}

/// The article of a physical item, from every source that may state one. Only
/// a non-empty string states one; null, absent or anything else states
/// nothing — a missing `article_id` is not "no article" (round 9, review B1).
/// Known only when at least one source states it and they all agree.
({bool known, String? articleId}) agreedArticle(Iterable<Object?> sources) {
  final Set<String> stated = <String>{
    for (final Object? s in sources)
      if (s is String && s.isNotEmpty) s,
  };
  return stated.length == 1
      ? (known: true, articleId: stated.single)
      : (known: false, articleId: null);
}

/// The payload of [value] as a map, when it parses as one; null otherwise.
Map<Object?, Object?>? lenientTimelineMap(Object? value) {
  Object? decoded = value;
  if (value is String) {
    try {
      decoded = jsonDecode(value);
    } on Object {
      return null;
    }
  }
  return decoded is Map ? decoded : null;
}

/// What an undecodable [value] may be. [id] is the id its storage key names;
/// [keyMalformed] says the key names none it can be read as.
UnreadableRow unreadableRowOf(Object? value,
    {String? id, bool keyMalformed = false, Iterable<Object?> articles = const <Object?>[]}) {
  final Map<Object?, Object?>? payload = lenientTimelineMap(value);
  final ({bool known, String? articleId}) article =
      agreedArticle(<Object?>[payload?['article_id'], ...articles]);
  return UnreadableRow(
    id: agreedRowId(keyId: id, keyMalformed: keyMalformed, payload: payload),
    articleKnown: article.known,
    articleId: article.articleId,
  );
}

/// What a DECODED row says it is: its id, and its article (null included).
UnreadableRow decodedRowAttribution(TimelineEntry e) =>
    UnreadableRow(id: e.id, articleKnown: true, articleId: e.articleId);

/// 🔴 NR-137 round 9 — THE ONE PLACE A REMOVAL, A ROW OR AN ARTICLE'S
/// MEMBERSHIP IS PROVEN. Every decision that removes rows or releases audio
/// asks this object (`provenGone`, `removeRowsDurably`, `storedRows`,
/// `articleMembersVerified`, `articleRowsVerified`); nothing else answers.
///
/// It holds one census ([TimelinePersistence.inventory]) and one keyed read
/// per id it was asked about. It answers yes only on positive evidence:
///   · every registered store was read, and every keyed read returned;
///   · nothing that could not be decoded may be the row, or may belong to the
///     article;
///   · every decoded copy of a row agrees, and for "absent" every one of them
///     is a tombstone.
/// There are no exceptions in here; a new kind of doubt belongs in the census.
class TimelineProof {
  TimelineProof._(this._inv, this._keyed, this._failed);

  /// Read the census and, for each of [ids], the keyed row. A read that throws
  /// is recorded, not raised: the proof is then incomplete.
  static Future<TimelineProof> take(TimelinePersistence p,
      {Iterable<String> ids = const <String>[]}) async {
    TimelineInventory? inv;
    bool failed = false;
    try {
      inv = await p.inventory();
    } on Object catch (e) {
      failed = true;
      diag('timeline.proof_read_failed', <String, Object?>{'error': e.runtimeType});
    }
    final Map<String, TimelineEntry?> keyed = <String, TimelineEntry?>{};
    for (final String id in ids.toSet()) {
      try {
        keyed[id] = await p.loadById(id);
      } on Object catch (e) {
        failed = true;
        diag('timeline.proof_read_failed',
            <String, Object?>{'row': id, 'error': e.runtimeType});
      }
    }
    return TimelineProof._(inv, keyed, failed);
  }

  final TimelineInventory? _inv;
  final Map<String, TimelineEntry?> _keyed;
  final bool _failed;

  /// Every registered store and every keyed read answered.
  bool get complete => !_failed && _inv != null && _inv.unread.isEmpty;

  /// Every decoded copy of [id] this proof read, or null when its keyed read
  /// was not taken or failed.
  List<TimelineEntry>? _copies(String id) {
    if (!_keyed.containsKey(id)) return null;
    return <TimelineEntry>[
      ?_keyed[id],
      for (final TimelineEntry e in _inv?.rows ?? const <TimelineEntry>[])
        if (e.id == id) e,
    ];
  }

  /// What storage holds under [id]. Readable is POSITIVE evidence of presence:
  /// a decoded copy every source agrees on (a caller may act on it — withdraw
  /// or fold it — and [absent] still decides afterwards whether it is gone).
  /// Absent only when [absent] proves it. Anything else is unreadable.
  StoredRow lookup(String id) {
    final List<TimelineEntry>? copies = _copies(id);
    if (copies == null) return const StoredRow.unreadable();
    if (copies.isNotEmpty) {
      final String first = jsonEncode(copies.first.toJson());
      final bool agree = copies.every((TimelineEntry e) =>
          e.id == id && jsonEncode(e.toJson()) == first);
      return agree ? StoredRow.readable(copies.first) : const StoredRow.unreadable();
    }
    return absent(id) ? const StoredRow.absent() : const StoredRow.unreadable();
  }

  /// Proven absent: every store read, nothing undecoded may be [id], and every
  /// decoded copy of it is a tombstone (review B4: a tombstone does not answer
  /// for residue that may be the same row).
  bool absent(String id) {
    final TimelineInventory? inv = _inv;
    final List<TimelineEntry>? copies = _copies(id);
    return complete &&
        inv != null &&
        copies != null &&
        !inv.unreadable.any((UnreadableRow u) => u.mayBe(id)) &&
        copies.every((TimelineEntry e) => e.id == id && e.deleted);
  }

  /// The rows of [articleId], oldest first; null unless nothing that could not
  /// be decoded may be one of them.
  List<TimelineEntry>? members(String articleId) {
    final TimelineInventory? inv = _inv;
    if (!complete || inv == null || inv.mayOmitMemberOf(articleId)) return null;
    return articleMembersIn(inv.rows, articleId);
  }

  /// Every live row (head and members) of [articleIds], and which of them may
  /// have rows this census could not decode.
  ({List<TimelineEntry> rows, Set<String> unknown}) articleRows(
      Set<String> articleIds) {
    final TimelineInventory? inv = _inv;
    return (
      rows: <TimelineEntry>[
        if (inv != null)
          for (final TimelineEntry e in inv.rows)
            if (!e.deleted && articleIds.contains(e.articleId)) e,
      ],
      unknown: <String>{
        for (final String a in articleIds)
          if (!complete || inv == null || inv.mayOmitMemberOf(a)) a,
      },
    );
  }

  /// 🔴 NR-137 round 10 (review r9 B1) — may audio whose release stands on
  /// [claim] go NOW? Every store read; every row the claim removed proven
  /// absent; every row its words now stand in present, decoded and live; and
  /// for every article it touched, nothing unresolved that may belong to it.
  /// A presence answer ([lookup]) is never enough on its own: it is what a
  /// withdrawal acts on, not what a release stands on.
  bool authorizes(TimelineReleaseClaim claim) {
    if (!complete) return false;
    for (final String id in claim.gone) {
      if (!absent(id)) return false;
    }
    for (final String id in claim.present) {
      final StoredRow r = lookup(id);
      if (r.state != StoredRowState.readable || r.entry!.deleted) return false;
    }
    for (final String a in claim.articles) {
      if (members(a) == null) return false;
    }
    return true;
  }

  /// One fresh proof of [claim], taken LAST: immediately before the commit
  /// that arms the release, so a store change since any earlier proof (a cloud
  /// retry landing between two steps of a press — review r9 B1) is seen.
  static Future<bool> authorizeRelease(
      TimelinePersistence p, TimelineReleaseClaim claim) async {
    final TimelineProof proof = await take(p,
        ids: <String>[...claim.present, ...claim.gone]);
    final bool ok = proof.authorizes(claim);
    diag('timeline.release_authorized', <String, Object?>{
      'ok': ok,
      'complete': proof.complete,
      'present': claim.present.length,
      'gone': claim.gone.length,
      'articles': claim.articles.length,
    });
    return ok;
  }

  /// A release that stands on PRESENCE alone — "this recording's words are
  /// durably stored as [id]" — and removed nothing: one keyed read, positive
  /// only. A read that throws is not a read that said absent: false.
  static Future<bool> persistedAs(TimelinePersistence p, String id,
      [bool Function(TimelineEntry stored)? test]) async {
    try {
      final TimelineEntry? e = await p.loadById(id);
      return e != null && e.id == id && (test == null || test(e));
    } on Object catch (e) {
      diag('timeline.readback_failed', <String, Object?>{
        'entry_id': id,
        'error': e.runtimeType,
      });
      return false;
    }
  }
}

/// What a release of retained audio stands on (round 10). [gone]: rows the
/// press removed, which must be proven absent. [present]: the rows its words
/// now stand in. [articles]: every article any of those rows belonged to, as
/// the DECODED rows state it — the article's membership must be resolved.
class TimelineReleaseClaim {
  const TimelineReleaseClaim({
    this.present = const <String>[],
    this.gone = const <String>[],
    this.articles = const <String>{},
  });

  /// From decoded rows: their ids, and the articles they positively state.
  factory TimelineReleaseClaim.ofRows({
    Iterable<TimelineEntry> present = const <TimelineEntry>[],
    Iterable<TimelineEntry> gone = const <TimelineEntry>[],
  }) =>
      TimelineReleaseClaim(
        present: <String>[for (final TimelineEntry e in present) e.id],
        gone: <String>[for (final TimelineEntry e in gone) e.id],
        articles: <String>{
          for (final TimelineEntry e in <TimelineEntry>[...present, ...gone])
            ?e.articleId,
        },
      );

  final List<String> present;
  final List<String> gone;
  final Set<String> articles;

  /// Does this release depend on anything having been removed?
  bool get removes => gone.isNotEmpty;

  TimelineReleaseClaim and(TimelineReleaseClaim other) => TimelineReleaseClaim(
        present: <String>{...present, ...other.present}.toList(),
        gone: <String>{...gone, ...other.gone}.toList(),
        articles: <String>{...articles, ...other.articles},
      );
}

extension TimelineVerifiedReadBack on TimelinePersistence {
  /// One row through [TimelineProof] (round 9: was the keyed read first, which
  /// let a readable tombstone answer before residue was looked at — B4).
  Future<StoredRow> lookupById(String id) async =>
      (await TimelineProof.take(this, ids: <String>[id])).lookup(id);

  /// [loadAll] with its holes named. An implementation that cannot name them
  /// answers [TimelineInventory.unknown].
  Future<TimelineInventory> inventory() async {
    final TimelinePersistence p = this;
    if (p is TimelineVerifiedReads) {
      return (p as TimelineVerifiedReads).loadInventory();
    }
    return TimelineInventory.unknown(await loadAll());
  }
}
