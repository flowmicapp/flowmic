// SPEC-REF:
//   docs/decisions/2026-08-01-image-two-sizes-both-ends.md (owner's dictated
//     final ruling +
//     amendment「delete on successful delivery, changed to: keep it」— THE
//     RULING THIS FILE NOW OBEYS)
//   docs/decisions/2026-07-31-owner-b2-outbox-rulings.md ① (compressed image:
//     delete on successful delivery
//     — **REVOKED** by the amendment above; kept in the SPEC-REF list because the
//     next reader will find it and has to be told it was superseded, not missed)
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md ③
//     (「pictures also go through the queue, and are saved locally by default」)
//   docs/strategy/2026-07-30-image-transit-rca-v3-round-report.md (RV-60 real root cause)
//
// Where a picture row's COMPRESSED bytes live.
//
// ── 🔴 WHOSE BYTES THESE ARE (RV-93, owner 2026-08-01) ───────────────────────
//
// THE FILE IS OWNED BY **THE TIMELINE ROW**, NOT BY THE QUEUE ITEM. The queue is
// one USER of it (the drain reads it to build a frame); the row is another
// (the tap-to-enlarge view renders it); a future timeline clear-out (RV-96)
// is the third and is what will
// delete it.
//
// ⚠️ THE CLASS NAME STILL SAYS `Outbox`, AND THAT IS A KNOWN, DELIBERATE LIE OF
// OMISSION — owner's ruling allows either a rename or this note, and the rename
// would have had to touch ~20 test files, three of which parallel lanes are
// editing right now. So: **`OutboxBlobStore` is the ROW's picture store; the
// queue merely uses it.** The card report carries the same sentence, and RV-96
// (which will own deletion) is where the rename belongs.
//
// WHY OWNERSHIP HAD TO BE WRITTEN DOWN AT ALL: owner has ruled the queue over-
// designed and opened an audit window to shrink it (doc 15 G-12). If these bytes
// were understood to belong to the QUEUE, that audit would delete a user's
// pictures as a side effect of simplifying a delivery mechanism. Stating it now
// is cheaper than untangling it later.
//
// THE ROW'S OWN DOOR IS [pathFor] — it takes the `request_id`, which for a
// picture row IS `TimelineEntry.clientId` (image_send_controller builds the row
// with `clientId: requestId`), so a row can reach its picture with NO queue item
// in existence. That is what makes the ownership claim above structural rather
// than a comment.
//
// ── WHY THE BYTES GO TO DISK AT ALL (this IS the RV-60 fix) ──────────────────
// RCA-v3's real root cause: choosing a photo pushes the app to the background,
// EMUI severs the idle TCP, and the send then lands in a 「dead but
// undetected」 window up
// to 30 s wide. No amount of retrying at send time helps, because the thing to
// be sent only exists in RAM inside a process the OS is willing to kill. Putting
// the compressed bytes on disk BEFORE the picker is what makes the picture
// survive that window — coming back to the foreground becomes a DRAIN rather
// than 「where did that send just go」.
//
// ⚠️ NOT a red-line change. What lands here is the COMPRESSED payload, never the
// original pixels — the 「the original-image pixels never touch disk」 line is
// about the camera original, and
// owner stated the reasoning when ruling images into the queue: 「there can't
// be that many pictures,
// and they're compressed too, so it basically won't take up much space」.
//
// ── ⚠️⚠️ THE BLOCK THAT USED TO SIT HERE WAS RIGHT UNTIL 2026-08-01 AND IS NOW
//    WRONG. Kept verbatim, then corrected — anti-façade ④: a comment that argues
//    for a design is a greppable claim, and a superseded one that is quietly
//    retyped leaves nobody able to see that the rule changed.
//
//   「🔴 ONE DELETION POINT, ON PURPOSE
//     owner ① ruled 「delete on successful delivery」 (the queue is for
//     delivering, not an album), and
//     owner then added 「stop looking for the original image, just manage
//     whichever copy is still there」 ⇒ the FINAL shape is exactly
//     two states, and the presence of the file IS the state:
//
//         bytes on disk  ⇔ not yet delivered ⇔ resendable
//         bytes gone     ⇔ delivered          ⇔ no button offered, a clear reminder instead
//
//     For that equivalence to hold, [discard] must be the ONLY thing in the app
//     that removes a queued picture, and it must be called from exactly one place
//     (DeliveryOutbox's settle-on-delivered).」
//
// 🔴 THE CORRECTION (owner amendment: 「delete on successful delivery, changed
// to: keep it」). A delivered
// picture KEEPS its bytes — they are what the tap-to-enlarge view shows, on
// this phone and on the
// PC, and they are the same bytes that were injected into the focused window
// (docs/decisions/2026-08-01-image-two-sizes-both-ends.md: size B, one set of
// bytes, three uses).
// ⇒ `DeliveryOutbox` no longer calls [discard] AT ALL — not on success, not on a
// terminal refusal, not on overflow.
// ⚠️ 【Amended 2026-08-04】the original text went on to say 「Grep `discard(` :
// in production it has ZERO
// callers today, and that is the correct state until RV-96 … becomes its caller」
// —— **that sentence has since expired**: a caller really did show up later.
// `TimelineReaper` (constructed in production at
// `main.dart` as `reaper: TimelineReaper(...)`, whose field type is precisely
// `OutboxBlobStore`) calls
// `_images.discard(path)` inside `timeline/timeline_reaper.dart`,
// following the path of 「delete a row ⇒ delete its bytes along with it」
// (doc 15 G-21).
// ⇒ **The true statement now is: production has exactly one caller, and it
// is the very reason this verb exists.**
// This note is amended per anti-façade ④: a comment asserting another
// location's behavior has a truth value that changes as that other code
// changes,
// while the comment itself does not — so a grep-able anchor is given here
// (`\.discard(` occurs exactly once under `lib/`).
//
// 🔴 THE INVARIANT THE UI MUST USE INSTEAD — and this is the half that is easiest
// to get wrong, because 「button ⇔ bytes」 does not fail loudly once the
// bytes are
// permanent, it just becomes VACUOUSLY TRUE and puts a resend button on a picture
// that already landed:
//
//     resend button ⇔ this item has not yet been delivered successfully
//                      (item is queued/inflight — never delivered,
//                                    never a terminal refusal)  ∧  the bytes are still there
//
// The state half is the gate; the byte half only keeps the button from being one
// that cannot work (R8). See OutboxPendingView.resendableImageEntryIds, which is
// where both halves are computed, and ChatMessageTile, which renders them.
//
// ⚠️ 「no silent cap is allowed」 (owner, same amendment): nothing in this
// file may evict,
// cap or expire a picture. Storage growth is a MONOTONE, ACKNOWLEDGED debt until
// RV-96 ships a clear-out the user can see and operate — a silent cap would make
// a user's picture vanish without a word, which is silent failure in its storage form.

import 'dart:io';
import 'dart:typed_data';

/// Directory name (under the app-private databases path) holding the timeline's
/// pictures. A sibling of the timeline database, so it needs no new dependency
/// and no new permission.
///
/// ⚠️ THE VALUE IS FROZEN even though the name now reads wrong (RV-93 moved
/// ownership from the queue to the row). It is the address of pictures already
/// sitting in users' installs: renaming the directory would strand every one of
/// them, which is a worse lie than a stale word — the same reasoning that keeps
/// the desktop's `flowmic.history.cache` key un-renamed.
const String kOutboxBlobDirName = 'flowmic_outbox_images';

/// The extensions [FileOutboxBlobStore.pathFor] probes, i.e. every extension
/// [put] can produce.
///
/// 🔴 THE ONE PRODUCER IS `imageBlobExtension` (image_payload.dart). This list is
/// NOT imported from there on purpose — that module pulls in the whole payload /
/// mime layer and this file is deliberately dependency-free — so the agreement is
/// held by a TEST instead of by an import (`outbox_test.dart`: every `ImageMime`'s
/// extension is in this list). Without that test the drift would be invisible: a
/// new mime would simply make its pictures un-findable by the row, with nothing
/// to grep and no error anywhere.
const List<String> kRowImageExtensions = <String>['png', 'jpg', 'webp'];

/// The blob seam. Production is [FileOutboxBlobStore]; tests pass the in-memory
/// double so the whole image-queue contract is provable without a filesystem.
abstract class OutboxBlobStore {
  /// Persist [bytes] for [requestId]. Returns the path to store on the item, or
  /// null when the bytes could not be written.
  ///
  /// A null is NOT swallowed by the caller: an image that cannot reach disk must
  /// not be enqueued as if it had, because the item would then be a promise with
  /// no payload behind it. See DeliveryOutbox.enqueueImage.
  Future<String?> put({
    required String requestId,
    required Uint8List bytes,
    required String extension,
  });

  Future<Uint8List?> read(String path);

  /// 🔴 THE ROW'S OWN DOOR (RV-93) — 「where is this row's full-size
  /// picture」, asked with NOTHING but
  /// the row's own identity.
  ///
  /// [requestId] is `TimelineEntry.clientId` for a picture row: the row and the
  /// delivery are born together in `ImageSendController._send`
  /// (`buildDeliveryRow(clientId: requestId)`), so this is ONE identity being
  /// read back, not a second one that could drift.
  ///
  /// It exists so the row does NOT have to go through the queue for its own
  /// picture. The queue item is deleted-shaped by nature (owner has ruled it
  /// over-designed and will shrink it — doc 15 G-12); the row is permanent, so
  /// 「tap to enlarge」 must not be reachable only via a queue lookup that a later
  /// simplification could remove.
  ///
  /// Null ⇒ this row has no picture on this phone (a transcript row, a row from
  /// before RV-93, or a picture whose file is genuinely gone).
  Future<String?> pathFor(String requestId);

  /// Whether the bytes are still there.
  Future<bool> exists(String path);

  /// How many bytes are there, or **null when they cannot be measured** (the
  /// file is gone, or the read failed).
  ///
  /// 窗口C (doc 16 §6-2 / §8-2) added this. It exists so the asset inventory can
  /// answer 「how many bytes the pictures take up」 WITHOUT reading every picture into memory — the
  /// export sheet shows that number the moment it opens, and [read] would make
  /// opening the sheet cost a full decode of every picture on the phone.
  ///
  /// 🔴 Null is 「unknown」, never 0. A zero would be indistinguishable from
  /// 「this file exists,
  /// and it's empty」, and the inventory turns 「unknown」 into 「this row has
  /// no picture」
  /// rather than into a size it made up (doc 16 §8-2: 「a fake byte count and
  /// a fake
  /// progress bar are the same thing」).
  Future<int?> sizeOf(String path);

  /// Remove a picture. ⚠️ PRODUCTION CALLERS TODAY: **NONE** — see the header.
  /// RV-96 (owner's visible timeline clear-out) is the caller this waits for; until then
  /// nothing in the app may delete a picture, and a new caller added without that
  /// card is a silent data loss.
  Future<void> discard(String path);
}

class FileOutboxBlobStore implements OutboxBlobStore {
  FileOutboxBlobStore(this.directory);

  /// Resolved by the composition root from sqflite's `getDatabasesPath()` — the
  /// same app-private area the timeline database already lives in, so the queue
  /// needs no new dependency and no new permission.
  final String directory;

  Future<Directory> _dir() async {
    final Directory d = Directory(directory);
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  /// `request_id` is the file name because it is already unique per delivery and
  /// already the queue's primary key — one identity, not a second one to keep in
  /// step. Sanitised because it reaches a filesystem: the minted ids are
  /// `[a-z]\d+-\d+` today, and a future prefix must not be able to escape the
  /// directory.
  String _pathFor(String requestId, String extension) {
    final String safe = requestId.replaceAll(RegExp(r'[^A-Za-z0-9_.-]'), '_');
    return '$directory/$safe.$extension';
  }

  @override
  Future<String?> put({
    required String requestId,
    required Uint8List bytes,
    required String extension,
  }) async {
    try {
      await _dir();
      final String path = _pathFor(requestId, extension);
      // Written to a temp name and renamed: a process death midway through the
      // write would otherwise leave a TRUNCATED picture at the real path, and
      // the item would look deliverable while carrying half a file. Rename is
      // atomic on the platforms this ships to.
      final File tmp = File('$path.part');
      await tmp.writeAsBytes(bytes, flush: true);
      await tmp.rename(path);
      return path;
    } on Object {
      // The caller turns this into a visible failure. Never a silent 「pretend it was saved anyway」.
      return null;
    }
  }

  @override
  Future<Uint8List?> read(String path) async {
    try {
      final File f = File(path);
      if (!await f.exists()) return null;
      return await f.readAsBytes();
    } on Object {
      return null;
    }
  }

  @override
  Future<String?> pathFor(String requestId) async {
    // Probed rather than remembered: the extension is a property of the BYTES
    // (`imageBlobExtension(payload.mime)`) and lives on the queue item, which is
    // precisely the thing a row must not have to consult (see the interface's
    // doc). Three `File.exists` on an app-private directory is a few hundred
    // microseconds and runs once per tap-to-enlarge — never per frame.
    for (final String ext in kRowImageExtensions) {
      final String path = _pathFor(requestId, ext);
      if (await exists(path)) return path;
    }
    return null;
  }

  @override
  Future<bool> exists(String path) async {
    try {
      return await File(path).exists();
    } on Object {
      return false;
    }
  }

  @override
  Future<int?> sizeOf(String path) async {
    try {
      final File f = File(path);
      if (!await f.exists()) return null;
      return await f.length();
    } on Object {
      // 「unknown」, not 0 — see the interface doc.
      return null;
    }
  }

  @override
  Future<void> discard(String path) async {
    try {
      final File f = File(path);
      if (await f.exists()) await f.delete();
      // The .part sibling is removed too: a crashed write would otherwise leave
      // bytes on disk that nothing will ever deliver or clean up.
      final File part = File('$path.part');
      if (await part.exists()) await part.delete();
    } on Object {
      // A file we cannot delete is a storage nuisance, not a delivery failure.
      // ⚠️ That swallow was safe while the ONLY caller was settle-on-delivered
      // (nothing downstream depended on it). RV-96 will call this to honour a
      // user's 「clear-out」, and a clear-out that silently fails to remove the bytes is
      // a different, louder problem — **that card must give this a return value
      // rather than inherit this silence.**
    }
  }
}

/// A legitimate test double. Never used in production (DeliveryOutbox requires
/// its blob store explicitly).
class InMemoryOutboxBlobStore implements OutboxBlobStore {
  final Map<String, Uint8List> blobs = <String, Uint8List>{};

  /// Set true to make [put] fail, so the 「a disk-write failure must be
  /// reported out loud」 branch is testable.
  bool failWrites = false;

  @override
  Future<String?> put({
    required String requestId,
    required Uint8List bytes,
    required String extension,
  }) async {
    if (failWrites) return null;
    final String path = 'mem://$requestId.$extension';
    blobs[path] = bytes;
    return path;
  }

  @override
  Future<Uint8List?> read(String path) async => blobs[path];

  /// Mirrors [FileOutboxBlobStore.pathFor] over the same `mem://<id>.<ext>` key
  /// shape [put] mints — the probe, not a map lookup, so a test that proves the
  /// row can find its picture is proving the same mechanism production runs.
  @override
  Future<String?> pathFor(String requestId) async {
    for (final String ext in kRowImageExtensions) {
      final String path = 'mem://$requestId.$ext';
      if (blobs.containsKey(path)) return path;
    }
    return null;
  }

  @override
  Future<bool> exists(String path) async => blobs.containsKey(path);

  @override
  Future<int?> sizeOf(String path) async => blobs[path]?.length;

  @override
  Future<void> discard(String path) async {
    blobs.remove(path);
  }
}
