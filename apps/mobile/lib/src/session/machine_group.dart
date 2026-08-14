// SPEC-REF:
//   packages/protocol/src/protocol-schemas-auth.ts (`pc_machine_uid` on the
//     mobile:pair / mobile:reconnect acks)
//   apps/mobile/lib/src/auth/token_storage.dart (MobileSession.pcMachineUid)
//
// 「is this the same computer or not」, for the instance list.
//
// owner 2026-07-29:「when the phone is on an external network it accesses
// [the PC] through the cloud relay — e.g. working away from home — and when on
// the internal network it uses the local LAN environment, but it should be
// able to clearly tell whether these are the same phone and the same PC」.
//
// The list showed two rows for one computer with no way to tell — same name,
// and (until v0.2.3 fixed the channel chip) the same label too. The owner's own
// log shows what that cost: four join/leave cycles in two minutes, alternating
// between the two rows, because tapping was the only way to find out which one
// was which.
//
// The rows stay SEPARATE on purpose. They are two genuine pairings — two
// servers, two tokens, two `mobile_pairings` rows, independently revocable —
// and merging them into one tappable thing would make 「delete this entry」 ambiguous
// and 「disconnect」 unable to name which. What was missing was never the merge, it
// was the STATEMENT that they belong together. So this groups for DISPLAY:
// members are rendered adjacently under one 「the same computer」 header, and every
// row keeps its own tap, its own swipe, and its own status.
//
// ⚠️ Card F2 / ruling ④ (2026-08-04) — **THE SESSION STATE AND THE HISTORY OF THOSE
// SAME TWO ROWS ARE MERGED**, by `session/machine_key.dart`. The paragraph above
// is still true of THIS file and of the instance LIST; it is not a statement
// about the transcript screen. Two files, two questions: this one answers 「how
// is the list displayed」 (and the rows must stay separate to answer it), while
// machine_key.dart answers 「which rows does this screen read」 (and they must be
// one to answer that). Left unsaid, each file tells half the truth and the next
// reader concludes 「the same computer just never gets merged」 from here alone.
//
// Pure and widget-free so the grouping rules are unit-tested without pumping a
// frame — the same reason device_label.dart is pure.

import '../auth/token_storage.dart';

/// Rows that belong to one physical computer, in the order they appeared.
class MachineGroup {
  const MachineGroup({required this.machineUid, required this.rows});

  /// The shared `pc_machine_uid`, or null for a row that could not be grouped
  /// (an older pairing, or the virtual cloud-instance row). A null-uid group ALWAYS holds
  /// exactly one row — see [groupPairingsByMachine].
  final String? machineUid;

  final List<MobileSession> rows;

  /// Whether this computer is reachable over more than one channel — i.e.
  /// whether there is anything to explain to the user at all.
  bool get isShared => rows.length > 1;
}

/// Group [pairings] by the computer behind them, preserving list order.
///
/// The list arrives most-recent-first, and a group takes the position of its
/// EARLIEST-listed member, so a computer used moments ago does not jump to the
/// bottom because its other channel is stale.
///
/// Three rules, each of which exists because its opposite would lie:
///
///  ① a null / blank uid groups with NOTHING. Two rows that both failed to
///     report a machine are not thereby the same machine — that is 「could not
///     be determined」
///     rendered as 「yes」. Pre-0.2.4 pairings land here and simply look exactly
///     as they did before, which is the honest outcome for a row that has no
///     answer yet (one reconnect backfills it server-side).
///  ② the cloud-instance row (`channel == 'saas'`) is never grouped. It is a
///     virtual PC
///     row on the server, not a machine, so 「the same computer」 would be a category
///     error even if a uid somehow arrived on it.
///  ③ order within a group is the input order, so the newest connection of a
///     computer stays first inside its own group too.
List<MachineGroup> groupPairingsByMachine(List<MobileSession> pairings) {
  final List<String?> uids = <String?>[];
  final List<List<MobileSession>> buckets = <List<MobileSession>>[];
  final Map<String, int> indexOfUid = <String, int>{};

  for (final MobileSession p in pairings) {
    final String uid = (p.pcMachineUid ?? '').trim();
    final bool groupable = uid.isNotEmpty && p.channel != 'saas';
    final int? at = groupable ? indexOfUid[uid] : null;
    if (at != null) {
      buckets[at].add(p);
      continue;
    }
    if (groupable) indexOfUid[uid] = buckets.length;
    uids.add(groupable ? uid : null);
    buckets.add(<MobileSession>[p]);
  }

  return List<MachineGroup>.unmodifiable(<MachineGroup>[
    for (int i = 0; i < buckets.length; i++)
      MachineGroup(
        machineUid: uids[i],
        rows: List<MobileSession>.unmodifiable(buckets[i]),
      ),
  ]);
}

/// The label for a grouped computer: the first member that carries a name the
/// user recognises. Alias wins over device name (the same precedence
/// [pairingDisplayName] applies to a single row) — a group must not be labelled
/// with the raw device name when the user renamed one of its rows.
String machineGroupLabel(MachineGroup group, {String fallback = 'PC'}) {
  for (final MobileSession p in group.rows) {
    final String? alias = p.displayAlias;
    if (alias != null && alias.trim().isNotEmpty) return alias.trim();
  }
  for (final MobileSession p in group.rows) {
    final String? name = p.pcName;
    if (name != null && name.trim().isNotEmpty) return name.trim();
  }
  return fallback;
}
