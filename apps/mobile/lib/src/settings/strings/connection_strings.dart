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

  /// 🔴 2026-08-18 — 「我们这一轮没问到」("we got no answer this round"), which is
  /// **not** [offline] and must never be worded as if it were.
  ///
  /// [offline] is a claim about the other end. This is a claim about US: two
  /// attempts inside one cycle produced nothing back. On the path this product's
  /// cloud relay takes, that happened to **7.5 % of probes while the relay was
  /// answering every one of them** (measured, tablet TB335ZC, 2026-08-18 — the
  /// numbers are in `session/instance_probe.dart`'s [InstanceReach] doc), so the
  /// old wording sent someone to check a server that was fine, several times an
  /// hour.
  ///
  /// ⚠️ Deliberately carries **no imperative**: there is nothing for the user to
  /// do, and the next tick usually answers. Same rule `INJECT_PC_MISMATCH`'s copy
  /// set — a sentence that tells someone to act on a situation they cannot act on
  /// is worse than one that just says what is true.
  String get reachUnanswered => _lfReachUnanswered;

  /// 🔴 B4 (2026-08-18) — the button that replaces 「退出再进来」 ("back out and
  /// come in again").
  ///
  /// The ladder is a pure timer, so a phone whose network came back mid-rung sat
  /// there for up to 30 s more with **no way for the user to say 「现在试」**
  /// ("try now") — and backing out to the instance list and tapping the row
  /// dials immediately, which is exactly how that became the recovery ritual.
  ///
  /// ⚠️ It is only ever offered while the ladder is actually running
  /// (`chat_banner_sources.dart` passes null otherwise). A dead token stops the
  /// ladder on purpose and belongs to the re-pair flow; a button there would be
  /// one that cannot succeed — a façade with a label.
  String get reconnectNowAction => _lfReconnectNowAction;

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

  /// 🔴 The one absence whose correct action is NOT 「去把电脑打开」("go turn
  /// the computer on"). That machine is powered on and running; its cloud
  /// sign-in lapsed, so the relay stopped admitting it to its room.
  ///
  /// 🔴 **Must stay a different sentence from [pcOfflineChip]**, for the same
  /// reason [pcOfflineChip] must stay different from [offline]: the user's next
  /// move differs. Told 「电脑已离线」 this person walks over to a computer that
  /// is working perfectly and finds nothing to do, while the ten-second fix is
  /// never named. The guide line ([GuideStrings.guideStatusPcSignedOut]) is
  /// where the fix itself is spelled out — this chip only has room to say WHICH
  /// kind of absence it is.
  String get pcSignedOutChip => _lfPcSignedOutChip;

  /// 🔴 C9 (2026-08-17) — one more step along the axis [pcSignedOutChip]
  /// travelled: that computer is on, in a room, and answering — **for a
  /// different account**. This pairing points at the row that account left
  /// behind, and nothing will ever put a PC back into it.
  ///
  /// 🔴 **Must stay a different sentence from BOTH neighbours**, and the reason
  /// is that all three imply a different next move. 「电脑已离线」 sends this user
  /// to a machine that is running; [pcSignedOutChip] sends them to re-enter a
  /// Cloud Key that would displace the account currently using it; only this one
  /// points at the phone, which is the only place the fix exists. The guide line
  /// ([GuideStrings.guideStatusPcOtherAccount]) spells the fix out — this chip
  /// only has room to say WHICH kind of absence it is.
  String get pcOtherAccountChip => _lfPcOtherAccountChip;

  /// 🔴 C4 (2026-08-17) — the server answered about the PAIRING rather than
  /// about the computer: it does not recognise this token
  /// (`401 PRESENCE_AUTH_REQUIRED`). Until this line existed that answer was
  /// painted as [relayUpPcUnknown] 「电脑是否在线未知」 ("PC status unknown"),
  /// i.e. a revoked pairing and a dropped packet said the same thing — and one
  /// of them will never resolve no matter how long the user waits.
  ///
  /// ⚠️ The full explanation is deliberately NOT duplicated here: the sentence
  /// for 「this pairing is gone, pair again」 already exists and owner ruled on
  /// its wording (`PairingStrings.pairError('AUTH_TOKEN_INVALID')`). The guide
  /// sheet renders THAT one; this is its chip-sized label.
  String get pairingRevokedChip => _lfPairingRevokedChip;
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
