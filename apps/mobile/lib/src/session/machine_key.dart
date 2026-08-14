// SPEC-REF:
//   docs/decisions/2026-08-04-owner-ten-rulings-0.3.0.md ruling④ (two channels to
//     ONE computer are ONE session surface and ONE history)
//   docs/strategy/2026-08-04-f2-machine-merge-design.md §2.2 §2.4 §2.5
//   apps/mobile/lib/src/auth/token_storage.dart (`MobileSession.pcMachineUid`,
//     `MobileSession.connectionIdentity`)
//
// card F2 — 「WHICH ROWS DOES THIS SCREEN READ」 and 「WHICH BUCKET DOES THIS
// COUNT GO IN」. One rule, one file, so the screen and the banner cannot drift.
//
// ── 🔴 THIS IS NOT `session/machine_group.dart`, AND THEY MUST NOT MERGE ──────
//
// `machine_group.dart` answers 「HOW IS THE LIST DISPLAYED」: two pairings to one
// computer are rendered adjacently under one 「同一台电脑」("the same computer")
// header while staying
// two separate, independently revocable rows. THIS file answers 「WHICH ROWS DO
// I READ」. One object answering two questions is this repo's #1 historical
// defect shape, and these two questions have different answers already: the
// cloud instance (云端实例) is excluded from BOTH, but a pairing the user forgot
// is gone from the
// display grouping while its rows must stay in the merged history forever.
//
// ── 🔴 DISPLAY IDENTITY AND DELIVERY ADDRESS ARE TWO VALUES, FOREVER ──────────
//
// CLAUDE.md: ID crosstalk is never allowed (绝不许串号). Nothing here may ever
// become the source of a delivery
// address. The address is minted in exactly one place — `resolveOutboxTarget`
// (session/outbox_destination.dart), which returns the LIVE connection's own
// `pc_id` in both of its branches and uses the machine uid only as an equality
// GATE. This file therefore deliberately does not import `outbox_destination
// .dart` / `outbox_item.dart`, and neither of them imports this file: 「同一台
// 电脑，那就用另一条配对的 pc_id 发」("it's the same computer, so send with the
// other pairing's pc_id") has no path through the compiler.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../auth/token_storage.dart';
import 'instance_machine_map.dart';

/// Scope keys are prefixed so 「machine M」 and 「instance whose id happens to
/// read like M」 can never collide in the same map.
const String kMachineScopePrefix = 'machine:';
const String kInstanceScopePrefix = 'instance:';

/// The cloud instance (云端实例) is a virtual PC row on the server, not a machine
/// (`machine_group.dart` rule ②). Its `connectionIdentity` is
/// `'saas|instance:…'`, which is the only channel evidence a FROZEN queue item
/// carries — items store the identity, not the channel — so the test is done on
/// the identity string and works for both the live session and the queue.
bool _isCloudIdentity(String pairingIdentity) =>
    pairingIdentity.startsWith('saas|');

/// 🔴 The one bucket key. Used by BOTH the live session surface and the frozen
/// queue item, which is what makes 「横幅数的那一屏 ＝ 用户正在看的那一屏」("the
/// screen the banner counts against = the screen the user is looking at") true
/// by construction rather than by review.
///
/// The ladder, in order (design §2.2):
///   · no identity AND no uid ⇒ null — there is no scope at all;
///   · cloud (云端) identity ⇒ instance scope even if a uid somehow arrived —
///     merging
///     the cloud into a machine would be a category error;
///   · a uid ⇒ `machine:<uid>` — the two channels of one computer land here;
///   · no uid ⇒ `instance:<identity>` — a pre-0.2.4 pairing keeps behaving
///     exactly as it did. ⚠️ Two uid-less scopes are NEVER equal on the uid:
///     they fall back to their own identities, so 「问不到」("couldn't get an
///     answer") cannot be read as
///     「是同一台」("it's the same one").
String? scopeKeyFor({String? machineUid, String? pairingIdentity}) {
  final String pairing = (pairingIdentity ?? '').trim();
  final String uid = (machineUid ?? '').trim();
  if (uid.isEmpty || _isCloudIdentity(pairing)) {
    return pairing.isEmpty ? null : '$kInstanceScopePrefix$pairing';
  }
  return '$kMachineScopePrefix$uid';
}

/// The birth-time owner ids whose rows this screen shows.
///
/// Returns a SET because that is what the read surfaces already speak: the
/// store filter and `OwnerTimelinePager.setOwners` / `loadOwnerPage(ownerIds:)`
/// (card F10 left the argument set-shaped for exactly this card).
///
/// 🔴 The rows themselves are NEVER rewritten. A row keeps the
/// `spoken_to_instance_id` it was born with forever; merging is a mapping
/// applied at READ time. Back-filling a machine column would rewrite the whole
/// table (the one migration class that can lose history) and would freeze
/// 「migration day couldn't ask」 as a permanent answer.
///
/// [pairingIdentity] is always in the result when it is non-blank — the live
/// pairing owns this screen whether or not the pairing list has been read yet.
/// A blank one is an EMPTY set, never 「everyone」: unowned rows belong to no
/// screen and stay in all-history (全部历史) labelled unknown-instance
/// (未知实例).
///
/// Members are drawn from [pairings] under the same two rules
/// `machine_group.dart` documents: a blank uid groups with nothing, and the
/// cloud instance (云端实例) groups with nothing.
///
/// phase 2 (期 2) — [learned] is the persisted `instance_id → machine_uid` table
/// (`session/instance_machine_map.dart`), UNIONED with [pairings] rather than
/// replacing them. Two sources, one question, and neither can answer it for a
/// DIFFERENT machine: both are keyed by the same uid. The union is what makes
/// 「用户删掉了那台电脑的另一条配对」("the user deleted that computer's other
/// pairing") stop shortening the merged history — the
/// pairing is gone from the list, the mapping is not. A cloud identity is
/// re-checked here even though the seed already excludes it: a table is a thing
/// other code can write to, and this is the read that must not be wrong.
Set<String> ownerIdsFor({
  String? machineUid,
  String? pairingIdentity,
  List<MobileSession> pairings = const <MobileSession>[],
  Map<String, String> learned = const <String, String>{},
}) {
  final String pairing = (pairingIdentity ?? '').trim();
  if (pairing.isEmpty) return const <String>{};
  final String? key = scopeKeyFor(
    machineUid: machineUid,
    pairingIdentity: pairing,
  );
  if (key == null || !key.startsWith(kMachineScopePrefix)) {
    return <String>{pairing};
  }
  final String uid = key.substring(kMachineScopePrefix.length);
  final Set<String> ids = <String>{pairing};
  for (final MobileSession p in pairings) {
    if ((p.pcMachineUid ?? '').trim() != uid) continue;
    if (p.channel == 'saas') continue;
    final String id = _identityOrBlank(p);
    if (id.isNotEmpty) ids.add(id);
  }
  learned.forEach((String instanceId, String learnedUid) {
    if (learnedUid.trim() != uid) return;
    if (instanceId.isEmpty || _isCloudIdentity(instanceId)) return;
    ids.add(instanceId);
  });
  return Set<String>.unmodifiable(ids);
}

/// A pairing that cannot name itself contributes nothing, rather than taking
/// the whole read surface down with it. [MobileSession.connectionIdentity]
/// throws when a row has neither an instance id, nor a token, nor a pc id —
/// unreachable for a stored pairing, but this runs on every chat repaint.
String _identityOrBlank(MobileSession p) {
  try {
    return p.connectionIdentity;
  } on StateError {
    return '';
  }
}

/// card F2 — the CURRENT connection's scope, cached because the read surfaces are
/// synchronous and the pairing list is not.
///
/// Held by [PttSession] (ptt/ptt_session.dart), which is the one place the
/// identity is learned (`applyPairedIdentity`) and cleared
/// (`clearConnectedInstance`) — the same two hooks, so the scope cannot outlive
/// the connection that justified it.
///
/// 🔴 NARROW FIRST, THEN WIDEN. [note] publishes `{identity}` synchronously and
/// only then asks storage for the rest of the machine. The alternative — wait
/// for the pairing list and publish once — leaves the PREVIOUS connection's
/// owner set on screen in the meantime, which is another instance's history
/// under this instance's header. A ChangeNotifier so the widening reaches the
/// pager even on a frame where nothing else changed.
class SessionScope extends ChangeNotifier {
  String? _key;
  Set<String> _ownerIds = const <String>{};

  /// Bumped by every [note]/[clear]/[dispose]. An answer that comes back under
  /// an old generation must not publish anything — see [OwnerTimelinePager]'s
  /// own `_generation` for the same hazard on the query side.
  int _generation = 0;

  /// Set in [dispose] before [ChangeNotifier.dispose]. In-flight [_widen] must
  /// become a NO-OP (no state write, no [notifyListeners]) — the generation
  /// bump alone is the same shape as a superseded [note], but [_disposed] also
  /// refuses a late resume that somehow still matched a generation.
  bool _disposed = false;

  /// The bucket this screen's transient state belongs to (`machine:…` /
  /// `instance:…`), or null when there is no connection.
  String? get key => _key;

  /// The birth-time owner ids this screen's history is read under.
  Set<String> get ownerIds => _ownerIds;

  void note({required MobileSession session, required TokenStorage storage}) {
    final String identity = _identityOrBlank(session);
    if (identity.isEmpty) {
      clear();
      return;
    }
    _generation += 1;
    final int gen = _generation;
    _key = scopeKeyFor(
      machineUid: session.pcMachineUid,
      pairingIdentity: identity,
    );
    _ownerIds = <String>{identity};
    notifyListeners();
    unawaited(_widen(gen, session, identity, storage));
  }

  void clear() {
    _generation += 1;
    if (_key == null && _ownerIds.isEmpty) return;
    _key = null;
    _ownerIds = const <String>{};
    notifyListeners();
  }

  @override
  void dispose() {
    // Invalidate in-flight `_widen` BEFORE the ChangeNotifier is marked dead.
    // Order alone in PttSession.dispose cannot cancel that unawaited future.
    _generation += 1;
    _disposed = true;
    super.dispose();
  }

  Future<void> _widen(
    int gen,
    MobileSession session,
    String identity,
    TokenStorage storage,
  ) async {
    // phase 2 (期 2) — the SECOND of the two writers (design §3.2). This runs inside
    // `applyPairedIdentity`'s only call to [note], i.e. next to the one place a
    // pairing ack is applied, and it writes the same ack's two values. Its
    // failure is a non-event by construction: the whole body below is already
    // guarded, and the narrow set is published before any of it runs.
    final InstanceMachineMap? map = installedInstanceMachineMap;
    final String uid = (session.pcMachineUid ?? '').trim();
    Map<String, String> learned = const <String, String>{};
    try {
      if (map != null) {
        if (uid.isNotEmpty && !_isCloudIdentity(identity)) {
          await map.put(
            instanceId: identity,
            machineUid: uid,
            source: kMachineMapSourceAck,
          );
        }
        learned = await map.readAll();
      }
    } catch (_) {
      // No mapping table this session. The pairing list below still answers the
      // same question for every pairing the user still has — phase 1's
      // behaviour (期 1 的行为).
      learned = const <String, String>{};
    }
    final List<MobileSession> pairings;
    try {
      pairings = await storage.readPairings();
    } catch (_) {
      // Storage could not say what else is on this machine. The narrow set is
      // already published, so the screen shows exactly what it showed before
      // this card — no merge (不合并), never a crash and never a guess.
      return;
    }
    // Teardown / superseded: late completion is a NO-OP — not an exception and
    // not a silent write into a disposed (or replaced) scope.
    //
    // IT-24 — this is the ONLY check between here and `notifyListeners()`
    // below, on purpose. A second copy of this same check used to sit after
    // `ownerIdsFor`/`setEquals`, but nothing between here and the end of this
    // function contains `await` (`ownerIdsFor` is a pure sync function; so is
    // `setEquals`) — so `_disposed`/`_generation` cannot change between this
    // read and the state write six lines down, and a second read could not
    // possibly answer differently. Kept as one check, not defensive depth: if a
    // future edit inserts an `await` before `notifyListeners()`, THAT edit is
    // what must re-add a second check here, not this comment going stale.
    if (_disposed || gen != _generation) return;
    final Set<String> wide = ownerIdsFor(
      machineUid: session.pcMachineUid,
      pairingIdentity: identity,
      pairings: pairings,
      learned: learned,
    );
    if (setEquals(wide, _ownerIds)) return;
    _ownerIds = wide;
    notifyListeners();
  }
}
