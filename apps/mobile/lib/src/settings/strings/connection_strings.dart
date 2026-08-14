// AppStrings copy-catalogue shard: instance list / delete confirmation /
// alias / connection diagnostics.
// The one external entry point remains ../app_strings.dart (AppStrings
// composes this mixin via `with`; from 0.2.67 the copy leaves `_lf…` are
// implemented by the generated classes under l10n/, and this shard keeps only
// the logic and reasoning comments).
part of '../app_strings.dart';

mixin ConnectionStrings on AppStringsLeaves {
  // The one translation of the 「仅记录」("record-only") term lives in
  // ChatStrings.recordOnly (it comes after this mixin in the `with` order) —
  // here only the signature is declared (the same cross-shard pattern as
  // pairError).
  String get recordOnly;

  // ── connections / instance list (WP-R23-1) ───────────────────────────────
  String get instancesTitle => _lfInstancesTitle;
  String get addDevice => _lfAddDevice;
  // owner 2026-07-27: the resting list now reports a MEASURED /api/health verdict
  // per instance (instance_probe.dart) and names the row it is dialling, so a tap
  // stops looking like nothing happened.
  String get online => _lfOnline;
  String get offline => _lfOffline;

  /// 🔴 RV-92 (owner 2026-08-01): the cloud relay answered "I'm here," but
  /// **the relay is not that computer**.
  ///
  /// This sentence deliberately **states clearly who is reachable and who is
  /// unknown**, rather than a vague "unknown": the user needs to be able to
  /// tell at a glance between "there's a network problem" and "the computer
  /// isn't on". This line used to say [online], which mistook the relay's
  /// health check for proof the computer was present (owner's own words:
  /// "that's not right").
  String get relayUpPcUnknown => _lfRelayUpPcUnknown;

  /// 🔴 RV-92: the **explicit statement** at the top of the transcription
  /// page. In the scene the owner ran into, the PC had already quit while the
  /// top still read "connected + PC name + target window name." The
  /// connection dot still only answers for transport (it was not lying — the
  /// relay really was connected); this sentence separately answers "is that
  /// computer there" — two questions, two pieces of text.
  String get pcOfflineChip => _lfPcOfflineChip;
  String get checkingReach => _lfCheckingReach;
  String get connectingRow => _lfConnectingRow;
  String get tapToConnect =>
      _lfTapToConnect;
  // ── D2LAN-B3/B4 connection encryption (a section of the diagnostics sheet) ──
  //
  // 🔴 THREE tiers, not two, and the second tier must never be merged into the
  // first. The external wording the owner ruled on 2026-08-02 is "guards
  // against eavesdropping, not against an active attacker" — "encrypted" alone
  // only delivers the first half, so the WHO half must occupy its own line:
  // a fingerprint that came from a scanned QR code was verified face-to-face;
  // one recorded by TOFU was not. Design §4-4 states, verbatim, that the two
  // paths "must not both show the same 'encrypted' badge."
  String get diagEncryptionSection =>
      _lfDiagEncryptionSection;

  /// QR-code pairing: the fingerprint travelled from the computer's screen via
  /// the QR code, verified **out of band**.
  String get diagEncryptionVerified => _lfDiagEncryptionVerified;

  /// Manually typed address: TOFU.
  ///
  /// 🔴 The wording is pinned by the owner's ruling: **say explicitly "not
  /// verified this time"**, rather than a vague "encrypted." Design §3-4a:
  /// "must be disclosed explicitly, never silently." It also states plainly
  /// what this record will do **in future** (a swap will be blocked) —
  /// otherwise the user reads it as "why bother recording it at all."
  String get diagEncryptionTofu => _lfDiagEncryptionTofu;

  String get diagEncryptionTofuNote => _lfDiagEncryptionTofuNote;

  /// The no-encryption tier. **Contains no imperative**: the user has no
  /// actionable move at this layer (whether TLS is on is that computer's
  /// business), and a line saying "please enable encryption" would only
  /// manufacture a demand that cannot be met.
  String get diagEncryptionPlain => _lfDiagEncryptionPlain;

  /// The external wording the owner ruled on 2026-08-02, in spirit verbatim:
  /// **guards against eavesdropping, not against an active attacker**. The two
  /// encrypted tiers share this — overstating the guarantee is the easiest lie
  /// to make on this chain.
  String get diagEncryptionScopeNote => _lfDiagEncryptionScopeNote;

  String get localLan => _lfLocalLan;
  String get cloudRelay => _lfCloudRelay;
  // RV-54 — last successful probe, said as "last time" (上次) so it cannot be
  // read as now. Visually distinct chip on the page; these strings carry the
  // prefix word.
  String get lastKnownLocalLan => _lfLastKnownLocalLan;
  String get lastKnownCloudRelay => _lfLastKnownCloudRelay;
  /// v0.2.4 — the delete went through HERE but could not be told to the PC, so
  /// that PC's device page still lists this phone. Stated rather than swallowed:
  /// 「没做成的事不许说成做成了」("must not describe something that never
  /// happened as done") covers deletions too.
  String get removeDidNotReachServer => _lfRemoveDidNotReachServer;

  /// v0.2.4 — the header over the two rows of ONE computer (owner 2026-07-29:
  /// 「应能明确知道是否都是同一台手机和同一台 PC」 — "one should be able to tell
  /// for certain whether these are the same phone and the same PC"). Shown
  /// only when a machine really does have more than one connection AND the
  /// server told us its machine uid; an ungrouped row renders exactly as it
  /// did before, because 「问不到」("could not be determined") must never be
  /// drawn as 「是同一台」("is the same machine").
  String sameMachine(String name, int connections) => _lfSameMachine(name, connections);

  /// GA-33: the remembered cloud-instance row. It is NOT a PC — there is no
  /// focus window on the other end — so it must not read like one.
  /// GA-10: the PC's own name, shown under a phone-local alias.
  String originalPcName(String real) =>
      _lfOriginalPcName(real);
  // 「仅记录」("record-only") is interpolated from recordOnly — the term is
  // translated exactly once (V2-07.7).
  String get cloudInstanceRow => _lfCloudInstanceRow(recordOnly);
  String get noInstances =>
      _lfNoInstances;
  String get noInstancesHint => _lfNoInstancesHint;
  /// Locale-explicit last-connection copy. This deliberately formats without
  /// intl/device locale; a future wall-clock stamp is clamped to "just now"
  /// (刚刚) because users can move the system clock backwards.
  String lastConnectedAt(DateTime connectedAt, {DateTime? now}) {
    final DateTime t = connectedAt.toLocal();
    final DateTime ref = (now ?? DateTime.now()).toLocal();
    final Duration age = ref.difference(t);
    late final String relative;

    if (age.isNegative || age < const Duration(minutes: 1)) {
      relative = _lfLastConnectedAt__1;
    } else if (age < const Duration(hours: 1)) {
      relative = _lfLastConnectedAt__2(age.inMinutes);
    } else if (_sameLocalDay(t, ref)) {
      relative = _lfLastConnectedAt__3(age.inHours);
    } else {
      final DateTime yesterday = DateTime(
        ref.year,
        ref.month,
        ref.day,
      ).subtract(const Duration(days: 1));
      final String hhmm =
          '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
      if (_sameLocalDay(t, yesterday)) {
        relative = _lfLastConnectedAt__4(hhmm);
      } else if (t.year == ref.year) {
        relative = _lfLastConnectedAt__5(t.month, t.day, hhmm);
      } else {
        relative = _lfLastConnectedAt__6(t.year, t.month, t.day, hhmm);
      }
    }
    return _lfLastConnectedAt__7(relative);
  }

  static bool _sameLocalDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;

  String get startNoAutoConnect => _lfStartNoAutoConnect;
  String get removePairing =>
      _lfRemovePairing;

  // ── owner 2026-07-27: 「所有删除…都要二次确认」("every delete… needs a
  //    confirmation") ─────────────────────────────────────────────────────
  // Each message states what is actually LOST, not just 「确定吗？」("are you
  // sure?"). The pairing
  // one names the re-pair cost because that is the part people forget.
  String get confirmDelete => _lfConfirmDelete;
  String removePairingConfirmTitle(String name) => _lfRemovePairingConfirmTitle(name);
  String get removePairingConfirmBody => _lfRemovePairingConfirmBody;
  String get deleteEntryConfirmTitle =>
      _lfDeleteEntryConfirmTitle;
  String get deleteEntryConfirmBody => _lfDeleteEntryConfirmBody;
  /// Names the phrase being removed.
  ///
  /// The parameter was here all along and the body ignored it — the call site
  /// passed the text believing it was shown. A destructive confirm that does
  /// not say WHICH item it is about is weaker than it looks: the user is being
  /// asked to approve something the dialog declined to identify. Truncated
  /// because a favourite can be a whole paragraph and a title is one line.
  String removeFavoriteConfirmTitle(String text) {
    final String t = text.trim();
    final String shown = t.length <= 24 ? t : '${t.substring(0, 24)}…';
    return _lfRemoveFavoriteConfirmTitle(shown);
  }
  String get removeFavoriteConfirmBody => _lfRemoveFavoriteConfirmBody;

  // ── rename local display alias (T-6c) ─────────────────────────────────────
  String get renameAliasTitle => _lfRenameAliasTitle;
  String get renameAliasHint => _lfRenameAliasHint;
  String get restoreDefaultName =>
      _lfRestoreDefaultName;
  String get save => _lfSave;

  // ── connection diagnostics (T-5b-mobile) ────────────────────────────────
  String get diagTitle => _lfDiagTitle;
  String get diagEndpoint => _lfDiagEndpoint;
  String get diagChannel => _lfDiagChannel;
  String get diagState => _lfDiagState;
  String get diagDevice =>
      _lfDiagDevice;
  String get diagLastError =>
      _lfDiagLastError;

  // ── diagnostic-trail upload (owner 2026-07-29: 「手机拿日志不方便」 —
  //    "it's inconvenient to get logs off a phone") ────────────────────────
  String get diagUpload => _lfDiagUpload;
  String get diagUploadHint => _lfDiagUploadHint;
  String diagUploadDone(int lines) => _lfDiagUploadDone(lines);
  String get diagUploadEmpty =>
      _lfDiagUploadEmpty;
  String get diagUploadNoEndpoint => _lfDiagUploadNoEndpoint;
  String get diagUploadNoSink => _lfDiagUploadNoSink;
  String get diagUploadUnreachable => _lfDiagUploadUnreachable;
  String diagUploadRefused(String detail) => _lfDiagUploadRefused(detail);
}
