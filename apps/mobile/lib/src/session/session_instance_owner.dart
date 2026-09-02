// V2-06a-1 — reads the live session so a row is stamped with whoever the phone
// was actually connected to when it was spoken.
//
// Moved VERBATIM out of main.dart (AUD-D B2-C, 2026-09-02): main.dart sat
// EXACTLY on the 800-line cap (`verify:lint file-size`) before this task's
// keyring-partitioning wiring added a handful of lines, and this class was the
// smallest fully self-contained family in the file — no other symbol in
// main.dart references it except the one construction call site. Comments and
// all, unchanged (the repo's own precedent for the 800-line cap is a
// STRUCTURAL split — take a coherent family out whole — rather than trimming
// the reasoning prose a comment carries; see retained_audio_boot.dart's header
// for the same move done once before).

import '../ptt/ptt_session.dart';
import '../timeline/timeline_store.dart';

/// Reads on EVERY call rather than caching: the connection changes under the
/// store's feet (pair / resume / leave), and a cached identity is how rows end
/// up attributed to the previous machine.
class SessionInstanceOwner implements InstanceOwnerProbe {
  const SessionInstanceOwner(this._session);
  final PttSession _session;

  @override
  String? get instanceId => _session.connectedInstanceId;

  @override
  String? get instanceName => _session.pcDisplayName;
}
