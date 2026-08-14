// E-CL — the timeline side of the blind store, and the pull cursor.
//
// SPEC-REF: docs/strategy/2026-08-08-design-e-blindstore-client.md §3.1
//   (only upload the phone's own light records), §3.2 (merge is idempotent by id).
//
// ── WHY A BRIDGE INSTEAD OF METHODS ON TimelineStore ────────────────────────
// Two reasons, and the second is the real one:
//   · `timeline_store.dart` sits at 751 of the 800-line cap (verify/lint/
//     file-size.mjs), so this card cannot grow it without a split it did not
//     come to do;
//   · more importantly, TimelineStore is the in-memory owner of what the UI is
//     looking at, with its own ordering rules and its own notification
//     discipline. A cloud sync writing into it directly would be a second
//     mutation authority over the same list. Here the sync writes through the
//     persistence the store reads from, and then asks the store to reload — one
//     owner, one refresh, and 「why did the UI change」 keeps a single answer.
//
// 🔴 DELETION STILL GOES THROUGH THE ONE DELETER. timeline_reaper.dart's header
// says every row's disappearance passes through `TimelineReaper.reap`, and
// applying a remote tombstone is a row disappearing. It is routed there — with
// `queueCloudTombstones: false`, because a row deleted BECAUSE the cloud said so
// must not turn around and ask the cloud to delete it again.

import 'package:shared_preferences/shared_preferences.dart';

import '../timeline_entry.dart';
import '../timeline_persistence.dart';
import '../timeline_reaper.dart';

/// `TimelineEntry.origin` for a record the phone authored for itself rather than
/// for a PC.
///
/// ⚠️ A mirror of a bare string literal, and worth naming as such: the two
/// producers spell it inline — `chat_utterance_settle.dart`
/// (`origin: c.destination.isFixed ? 'cloud' : 'paired'`) and
/// `image_send_controller.dart` (`origin: 'cloud'`). Both are in another lane's
/// territory this wave, so this card mirrors rather than extracts. If that
/// spelling ever changes, `blind_store_timeline_bridge_test.dart` fails — it
/// asserts against an entry built by the real `TimelineStore.buildFromUtterance`
/// with a fixed destination, not against this constant.
const String kBlindStoreCloudOrigin = 'cloud';

/// Is this row a light record the product still has anything to say about?
///
/// REQ-12-09 09-A — the predicate lives here, beside the constant, and is SHARED
/// with `LightRecordQuery` (light_record_query.dart) rather than copied into it.
/// 「what counts as a light record」 must have exactly one answer, or the panel that lists them
/// and the sync that uploads them can disagree about the same row.
///
/// The [TimelineEntry.deleted] half is not decoration. That flag means the row
/// is gone as far as the product is concerned, so including it would upload
/// something the user deleted (sync) and list something the user deleted (panel)
/// — the same mistake wearing two faces.
bool isLightRecord(TimelineEntry e) =>
    e.origin == kBlindStoreCloudOrigin && !e.deleted;

/// The slice of the timeline the blind store owns, plus the ability to write
/// back what other devices wrote.
class BlindStoreTimelineBridge {
  BlindStoreTimelineBridge({
    required TimelinePersistence persistence,
    required TimelineReaper reaper,
    required Future<void> Function() reload,
  }) : _persistence = persistence,
       _reaper = reaper,
       _reload = reload;

  final TimelinePersistence _persistence;
  final TimelineReaper _reaper;
  final Future<void> Function() _reload;

  /// Every phone-authored light record currently on this device.
  ///
  /// A full scan and a filter in Dart, deliberately: the same argument
  /// `timeline_sqlite.dart` makes for `LIKE` over FTS5 — at private-domain scale
  /// this is a few thousand rows and milliseconds, and a projected `origin`
  /// column would be a schema change (and a second place the value lives) bought
  /// for nothing measurable.
  ///
  /// Rows already marked [TimelineEntry.deleted] are excluded: that flag means
  /// the row is gone as far as the product is concerned, and pushing it would
  /// upload something the user deleted.
  ///
  /// The membership test itself moved to [isLightRecord] (REQ-12-09 09-A) so the
  /// 「+」 panel reads rows by the same rule this sync uploads them by. Behaviour
  /// here is unchanged — same two clauses, same order.
  Future<List<TimelineEntry>> lightRecords() async {
    final List<TimelineEntry> all = await _persistence.loadAll();
    return <TimelineEntry>[
      for (final TimelineEntry e in all)
        if (isLightRecord(e)) e,
    ];
  }

  /// Write a record another device authored (or a newer version of one of ours).
  Future<void> upsertFromCloud(TimelineEntry entry) =>
      _persistence.upsert(entry);

  /// Apply a tombstone another device raised.
  ///
  /// Routed through the reaper so the row's picture bytes and its side-table
  /// entry go with it — doc 16 §6.2-2「deleting a row = deleting all its
  /// bytes」 does not stop
  /// applying because the instruction arrived over a wire.
  Future<void> applyRemoteTombstone(TimelineEntry entry) =>
      _reaper.reap(<TimelineEntry>[entry], queueCloudTombstones: false);

  /// Refresh what the user is looking at, once per sync rather than per row.
  Future<void> reload() => _reload();
}

/// Where the `timeline:pull` cursor lives.
///
/// 🔴 KEYED BY ACCOUNT, and that is not tidiness. The cursor is a position in
/// ONE account's server-side seq sequence. Reusing another account's cursor
/// after a logout/login would start the pull above rows that were never read,
/// and those records would never be fetched again — an empty history that looks
/// like a working sync. Keying by account makes a switched account a fresh
/// cursor by construction rather than by someone remembering to reset it.
abstract interface class BlindStoreCursorStore {
  int read(String accountKey);

  Future<void> write(String accountKey, int seq);
}

class SharedPrefsBlindStoreCursorStore implements BlindStoreCursorStore {
  SharedPrefsBlindStoreCursorStore(this._prefs);

  final SharedPreferences _prefs;

  static const String kPrefix = 'flowmic.timeline.cloud.cursor.v1.';

  @override
  int read(String accountKey) => _prefs.getInt('$kPrefix$accountKey') ?? 0;

  @override
  Future<void> write(String accountKey, int seq) async {
    await _prefs.setInt('$kPrefix$accountKey', seq);
  }
}

class InMemoryBlindStoreCursorStore implements BlindStoreCursorStore {
  final Map<String, int> _byAccount = <String, int>{};

  @override
  int read(String accountKey) => _byAccount[accountKey] ?? 0;

  @override
  Future<void> write(String accountKey, int seq) async {
    _byAccount[accountKey] = seq;
  }
}
