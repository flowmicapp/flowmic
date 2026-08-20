// SPEC-REF:
//   docs/ui-design/demo/mobile.html frame 1 (the instance list: paired PC
//     profiles + cloud instance + add device; no auto-connect on launch)
//   docs/rebuild/08-MOBILE-SPEC.md §1 (when paired → ConnectionsPage; Option B no
//     auto-connect), §4 (pairing / reconnect)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R23-1 (the instance list = the launch
//     home page; the cloud-instance entry migrated in, reusing the login
//     sheet; pair by typing a code)
//
// The instance list — the app's startup home. Lists the remembered PC pairings
// (from token_storage, never auto-connecting: a tap connects, demo Option B), the
// migrated-in cloud-instance entry (opens the REUSED login sheet), and add device
// (the add-pairing sheet). A successful connect/pair pushes the chat page; a
// failure surfaces loudly.
//
// owner 2026-07-27: the resting list also reports online/checking/offline per
// instance and
// marks the row it is dialling. Neither is fabricated — reachability is a real
// GET /api/health (instance_probe.dart) and connecting is the actual
// in-flight connect;
// what stays banned is a green dot nobody measured.

import 'dart:async';

import 'package:flutter/material.dart';

import '../auth/login_controller.dart';
import '../auth/token_storage.dart';
import '../destination/destination_controller.dart';
import '../session/connections_controller.dart';
// W8-1 — read the candidate report through the decoder that lives next to its
// encoder, rather than string-matching the code here: the file comment on
// `encodeCandidateFailure` says the pair sits together precisely so the two
// cannot drift, and a second parser on this page would be that drift.
import '../session/endpoint_candidates.dart'
    show CandidateFailure, decodeCandidateFailure;
import '../session/instance_probe.dart';
import '../session/machine_group.dart';
import '../session/pc_presence.dart';
import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import 'add_pairing_sheet.dart';
import 'cloud_signout_row.dart';
import 'confirm_dialog.dart';
import 'connection_card_identity.dart';
import 'data_flow_disclosure_entry.dart';
import 'guide/instance_guide_sheet.dart';
import 'login_sheet.dart';
import 'rename_alias_dialog.dart';
import 'tokens.dart';

// 🔴 The 800-line gate (`verify/lint/file-size.mjs` SRC_MAX=800) — the
// 「what state is this row in right now」
// family (connecting/online/offline/PC-offline/relay-reachable-PC-unknown +
// channel badge) was moved character-for-character over
// there. The fields are all still on this file's `_ConnectionsPageState`,
// only the behaviour moved.
part 'connections_row_faces.dart';
// REQ-12-10 — pairing / cloud-entry card chrome + identity lane (same split
// shape as row_faces; triggered by the same 800-line gate before adding chrome).
part 'connections_row_cards.dart';

class ConnectionsPage extends StatefulWidget {
  const ConnectionsPage({
    super.key,
    required this.connections,
    required this.appSettings,
    required this.login,
    required this.destination,
    required this.chatPageBuilder,
    required this.settingsPageBuilder,
    required this.historyPageBuilder,
    required this.updateListenable,
    required this.hasUpdate,
  });

  final ConnectionsController connections;
  final AppSettingsController appSettings;
  final LoginController login;

  /// The shared destination controller — pinned record-only for a cloud entry,
  /// freed for a LAN pairing, so the chat opens in the correct destination mode.
  final DestinationController destination;

  /// Builds the (shared) chat page to push once connected — supplied by the
  /// composition root so this page owns navigation, not wiring.
  final Widget Function() chatPageBuilder;
  final Widget Function() settingsPageBuilder;

  /// V2-06b (Requirement ④): builds the full-history page — every instance's rows in one
  /// list. Supplied by the composition root for the same reason as the chat
  /// builder: this page owns navigation, not wiring.
  final Widget Function() historyPageBuilder;

  /// 「there is a new version」 — the SAME getter the chat header's gear dot
  /// reads (`UpdateController.hasUpdate`): one owner, one more render site.
  ///
  /// 🔴 Why this page takes a LISTENABLE + getter while ChatFlowPage takes a
  /// plain bool: the chat page rebuilds under the composition root's merged
  /// ListenableBuilder; THIS page is that layer's `child:` — built once and
  /// never rebuilt by it. A plain bool here would be painted at startup and
  /// stay stale forever.
  ///
  /// Real-device origin (iPad, 2026-08-20): a fresh unpaired install lives on
  /// THIS page and never reaches the chat gear — the update reminder had no
  /// surface at all until this dot. The check chain was alive the whole time;
  /// what was missing was a place to say it.
  final Listenable updateListenable;
  final bool Function() hasUpdate;

  @override
  State<ConnectionsPage> createState() => _ConnectionsPageState();
}

class _ConnectionsPageState extends State<ConnectionsPage> {
  /// 🔴 W8-1 (ledger row, real-device measured 2026-08-10) — the row whose LAST
  /// connect was refused because the PC presented a certificate that is not the
  /// one this pairing pinned, plus the refusal code that said so.
  ///
  /// Keyed by [ConnectionsController.keyFor] and rendered inside that row's own
  /// slot, so the diagnosis can never be printed under a different computer —
  /// "never cross-wire IDs" applies to a diagnosis exactly as it does to a delivery. It also
  /// means a swipe-deleted row takes its notice with it with no extra bookkeeping
  /// here: no row, no slot.
  String? _pinMismatchKey;
  String? _pinMismatchCode;

  /// 🔴 The instance list's own re-probe tick, alive only while this page is.
  ///
  /// Before it, `refreshReachability` was called from exactly four places —
  /// `initState`, returning from chat, returning from the background, and the
  /// pull gesture — so **one** transient miss stuck on screen until the user
  /// thought to pull down. A row that can only be corrected by a gesture the
  /// user has to guess at is not answering 「此刻」 ("right now"), which is the
  /// entire value of a presence word.
  ///
  /// ⚠️ Cadence lives in [kInstanceListPresencePollInterval], not as a literal
  /// here: it is a cost decision (N pairings per tick) and the day it is tuned,
  /// exactly one line should change.
  Timer? _presencePoll;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
    _presencePoll = Timer.periodic(
      kInstanceListPresencePollInterval,
      // ⚠️ Re-probe only — deliberately NOT [_refresh]. `load()` re-reads the
      // pairing list from storage, and nothing changes that list while this
      // page is the thing on screen; re-reading it every tick would be I/O
      // bought with nothing. The four existing callers still do the full
      // refresh, because each of them follows something that CAN have changed
      // the list.
      //
      // ⚠️ No in-flight guard here: `refreshReachability` is already
      // re-entrant-safe per target (`_probing` / `_presenceProbing`), and a
      // second guard at this layer would be a second answer to one question.
      (Timer _) => unawaited(widget.connections.refreshReachability()),
    );
  }

  @override
  void dispose() {
    // 🔴 A periodic timer that outlives its page keeps probing behind a screen
    // nobody is watching — traffic we generated ourselves, and on a route that
    // carries a credential. This repo has the precedent written down twice
    // already (`_dropLink`'s reconnect ladder, `_stopPresencePoll`'s session
    // tick); a leaked timer here would be the third instance of one shape.
    _presencePoll?.cancel();
    _presencePoll = null;
    super.dispose();
  }

  /// Load the remembered pairings, then probe them. Reachability rides AFTER the
  /// load so the probe targets the rows the user can actually see.
  Future<void> _refresh() async {
    await widget.connections.load();
    if (!mounted) return;
    await widget.connections.refreshReachability();
  }

  Future<void> _enterChat() async {
    // v0.2.6 — scope the destination HERE, from the pairing we are actually
    // entering, because this is the ONE funnel every entry path goes through.
    //
    // owner 2026-07-29:「转录界面顶上没有显示 PC 的实例名称……语音发出去体现的状态
    // 是仅记录」("the transcription screen's top doesn't show the PC's
    // instance name…the state reflected when speech goes out is 'noted
    // only'"). `_connect` and `_openCloud` each set the scope themselves and
    // `_add` never did, so pairing a real PC by code inherited whatever the last
    // cloud light-note session left behind: toggle locked, delivery = none, header
    // printing cloud light-note — a PC that could receive, being told nothing.
    //
    // Setting it per-button was the defect shape: a fourth entry path would have
    // forgotten it too. Setting it on the funnel cannot be forgotten, and it
    // reads the PAIRING rather than which button was pressed.
    widget.destination.configureFixed(
      fixedRecordOnly: widget.connections.activePairingIsCloudInstance,
    );
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(builder: (_) => widget.chatPageBuilder()),
    );
    // owner 2026-07-27: leaving the transcription page must ALSO leave the room.
    // Before this the socket stayed up, so the PC still counted this phone as
    // present and its capsule kept floating over the desktop with nobody on the
    // other end — the same「无手机却浮出」("surfacing with no phone present")
    // the desktop side was fixed for, arriving
    // from the phone's direction instead. Backing out to the instance list is the
    // user saying「我不用了」("I'm done using it"), so drop the session: the
    // PC sees pc:mobile-left,
    // mobiles→0, and the capsule retreats to the tray on its own.
    await widget.connections.leaveRoom();
    // Returned from chat (user back / disconnect): refresh the list resting state
    // AND re-probe — the PC we just left is the one whose state matters most.
    if (mounted) await _refresh();
  }

  Future<void> _connect(MobileSession pairing) async {
    final String key = ConnectionsController.keyFor(pairing);
    final ConnectOutcome outcome = await widget.connections.connectTo(pairing);
    if (!mounted) return;
    if (outcome.success) {
      _clearPinMismatch(key);
      // The destination scope is set in _enterChat from the PAIRING — not here
      // from which button was pressed. See the note there.
      await _enterChat();
      return;
    }
    // 🔴 W8-1 — 「对面换了一把钥匙」("the other side changed keys") GETS A
    // SURFACE THAT IS STILL THERE WHEN THE
    // USER LOOKS. Everything else on this page stays a toast, and that is not an
    // inconsistency — it is the difference between the two kinds of failure:
    //
    //   · PAIR_RELEASED / PC_BUSY / unreachable are MOMENTS. They pass on their own,
    //     tapping again is a sensible next move, and a sentence that leaves with
    //     the moment is the right lifetime for them.
    //   · a pin mismatch is a STANDING CONDITION. Nothing about it changes until
    //     the user re-pairs, so every subsequent tap fails the same way. A 4 s
    //     SnackBar is the wrong lifetime for a permanent fact — and the device
    //     line measured exactly that outcome: 「界面无跳转、无横幅、无错误码、
    //     无任何变化」("no screen transition, no banner, no error code, no
    //     change of any kind") with the truth living only in `adb logcat`.
    //
    // 🔴 AND IT IS NOT ALSO TOASTED. One fact, one surface: two would be the same
    // sentence twice, and the transient copy would teach the user that the
    // persistent one is safe to ignore.
    //
    // 🔴 NO 「仍要连接」("connect anyway") ANYWHERE IN THIS BRANCH, and it is
    // not an oversight to be
    // helpfully filled in later: a mismatch is the one moment the pinning is
    // doing its job, and an override turns a working defence into a prompt people
    // click through. The action is to pair again, which is what the copy names.
    // (Pinned by pin_mismatch_surface_test.dart: the notice subtree must contain
    // no tappable widget at all.)
    if (_isPinMismatch(outcome.error)) {
      setState(() {
        _pinMismatchKey = key;
        _pinMismatchCode = outcome.error;
      });
      return;
    }
    // A DIFFERENT failure on the same row retires the old diagnosis rather than
    // leaving it under a row it no longer describes: 「上一次是这个原因」
    // ("last time it was this reason") must not
    // be read as 「这一次是这个原因」("this time it's this reason").
    _clearPinMismatch(key);
    _toast(AppStrings.of(widget.appSettings.locale).pairError(outcome.error));
  }

  /// Did this connect fail because the certificate did not match the pin?
  ///
  /// ⚠️ The question is about the CODE, not about the transport: by the time the
  /// page sees an outcome the socket has been torn down (`_dropLink`), so
  /// `lastDialPinMismatch` would be answering 「现在」("now") about 「刚才」("just now"). The refusal
  /// code is the one artefact that is about THIS attempt.
  bool _isPinMismatch(String? code) {
    final List<MapEntry<String, CandidateFailure>>? tried =
        decodeCandidateFailure(code);
    if (tried == null) return false;
    return tried.any(
      (MapEntry<String, CandidateFailure> e) =>
          e.value == CandidateFailure.pinMismatch,
    );
  }

  void _clearPinMismatch(String key) {
    if (_pinMismatchKey != key) return;
    setState(() {
      _pinMismatchKey = null;
      _pinMismatchCode = null;
    });
  }

  Future<void> _add() async {
    final AppStrings s = AppStrings.of(widget.appSettings.locale);
    // Pre-fill the last-used endpoint for convenience (LAN address rarely changes).
    // owner 2026-07-27: when there is nothing to reuse, fall back to the cloud
    // relay URL rather than an empty box. The relay address is a fixed constant
    // the user cannot be expected to type from memory (and mistyping it on a
    // phone keyboard is the single most common way this sheet fails), whereas a
    // LAN address is site-specific and genuinely has no sensible default.
    final String? last = widget.connections.pairings.isNotEmpty
        ? widget.connections.pairings.first.endpoint
        : null;
    final String lastEndpoint = (last != null && last.isNotEmpty)
        ? last
        : widget.connections.saasEndpoint;
    final bool ok = await showAddPairingSheet(
      context,
      controller: widget.connections,
      strings: s,
      initialEndpoint: lastEndpoint,
    );
    if (ok && mounted) await _enterChat();
  }

  Future<void> _openCloud() async {
    final AppStrings s = AppStrings.of(widget.appSettings.locale);
    // Not logged in → drive to login FIRST (fail-loud inside the sheet); never a
    // crash, never a fake cloud session.
    if (!widget.login.isLoggedIn) {
      final bool ok = await showLoginSheet(
        context,
        controller: widget.login,
        strings: s,
      );
      if (!ok || !mounted) return;
    }
    // Logged in → admit the cloud instance (connect SaaS with the JWT handshake,
    // mobile:pair {cloud_instance:true}). Fail-loud on rejection.
    final ConnectOutcome outcome = await widget.connections.enterCloud();
    if (!mounted) return;
    if (outcome.success) {
      // Pinned record-only by _enterChat, which reads this pairing's own
      // channel — a cloud instance has no PC focus target, so entries are
      // origin:'cloud', local-only, never injected (red line).
      await _enterChat();
    } else {
      _toast(s.cloudError(outcome.error));
    }
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  /// Swipe-to-delete a remembered PC.
  ///
  /// v0.2.4 — the controller has told us since v0.2.3 whether the server was
  /// actually reached (`mobile:unpair`), and NOTHING rendered it. The local
  /// entry always goes (the user asked for it, and an unreachable PC has to be
  /// cleanable), but when the server could not be told, that PC's device page
  /// still lists this phone — and 「没做成的事不许说成做成了」("a thing that
  /// wasn't done must not be said as done") applies to a
  /// deletion exactly as it does to a delivery. So say it.
  Future<void> _remove(MobileSession p) async {
    await widget.connections.remove(p);
    if (!mounted || widget.connections.lastRemoveReachedServer) return;
    _toast(AppStrings.of(widget.appSettings.locale).removeDidNotReachServer);
  }

  /// Long-press a remembered PC → rename its local display alias. Blank input
  /// (or 「恢复默认」("restore default")) clears the alias — storage already
  /// treats null/blank as clear.
  Future<void> _renameAlias(MobileSession pairing) async {
    final AppStrings s = AppStrings.of(widget.appSettings.locale);
    final String prefill = pairing.displayAlias?.isNotEmpty == true
        ? pairing.displayAlias!
        : pairingDisplayName(pairing, fallback: 'PC');
    final String? result = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => RenameAliasDialog(strings: s, initial: prefill),
    );
    if (result == null || !mounted) return;
    await widget.connections.setAlias(pairing, result);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: Listenable.merge(<Listenable>[widget.connections, widget.appSettings]),
          builder: (BuildContext context, _) {
            final AppStrings s = AppStrings.of(widget.appSettings.locale);
            return Column(
              children: <Widget>[
                _appBar(s),
                Expanded(child: _body(s)),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _appBar(AppStrings s) => Container(
    height: 50,
    padding: const EdgeInsets.symmetric(horizontal: 14),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: FlowMicColors.line)),
    ),
    child: Row(
      key: const ValueKey<String>('connections.appBarRow'),
      children: <Widget>[
        Text(
          key: const ValueKey<String>('connections.title'),
          s.instancesTitle,
          style: TextStyle(color: FlowMicColors.t1, fontSize: 16, fontWeight: FontWeight.w700),
        ),
        const Spacer(),
        // P-7 ② (owner 7-4 took option A): the 「?」 guide sits LEFTMOST of the
        // trailing cluster. The width budget was measured before it was added,
        // not after: 360dp minus the bar's 14+14 padding leaves 332, three
        // 18px glyphs in 8px pads are 34 each with 2px between them = 106, and
        // the title is the literal 'FlowMic' in ALL FOUR locales
        // (connection_strings.dart `instancesTitle`), so translation cannot
        // move the number. That is the whole argument for a third icon being
        // affordable here and it is pinned by a measurement test — the top bar
        // has been over-subscribed three times (0.2.51), every time by someone
        // redistributing this row without first doing the arithmetic.
        InstanceGuideButton(strings: s),
        const SizedBox(width: 2),
        // V2-06b (owner's ruling): the full-history entry sits LEFT of the
        // ⚙ — 「右上角的测试图标左边」("left of the top-right test icon")
        // named the chat page's test icon, but the home header's
        // right corner today IS the ⚙, and the ruling placed the entry here.
        InkWell(
          key: const ValueKey<String>('connections.history'),
          onTap: () => Navigator.of(context).push<void>(
            MaterialPageRoute<void>(builder: (_) => widget.historyPageBuilder()),
          ),
          borderRadius: BorderRadius.circular(10),
          child: Tooltip(
            message: s.historyTitle,
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Icon(Icons.history, size: 18, color: FlowMicColors.t2),
          ),
          ),
        ),
        const SizedBox(width: 2),
        InkWell(
          // Keyed for the same reason the other two are: the measurement test
          // that keeps a fourth competitor off this row has to be able to name
          // each tap cell. It was the only one without a key.
          key: const ValueKey<String>('connections.settings'),
          onTap: () => Navigator.of(context).push<void>(
            MaterialPageRoute<void>(builder: (_) => widget.settingsPageBuilder()),
          ),
          borderRadius: BorderRadius.circular(10),
          // The update dot — same 7×7, same color, same zero-width overlay as
          // the chat header's (chat_header.dart), keyed apart so a test can
          // name which surface it found it on. Wrapped in its own
          // ListenableBuilder because this page is built once — see the
          // [updateListenable] doc.
          child: ListenableBuilder(
            listenable: widget.updateListenable,
            builder: (BuildContext context, _) => Stack(
              clipBehavior: Clip.none,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: Icon(Icons.settings_outlined, size: 18, color: FlowMicColors.t2),
                ),
                if (widget.hasUpdate())
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Container(
                      key: const ValueKey<String>('connections.settings.updateDot'),
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: FlowMicColors.brand,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    ),
  );

  Widget _body(AppStrings s) {
    if (widget.connections.loading) {
      return Center(child: CircularProgressIndicator(color: FlowMicColors.brand));
    }
    final List<MobileSession> pairings = widget.connections.pairings;
    return RefreshIndicator(
      // Pull to re-probe. The verdict is a snapshot of one moment, so the user
      // needs a way to ask again without leaving the page.
      color: FlowMicColors.brand,
      backgroundColor: FlowMicColors.surface,
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 20),
        children: <Widget>[
          if (pairings.isEmpty) _emptyHint(s),
          // v0.2.4 — rows for ONE computer are rendered adjacently under a
          // header that says so. The rows themselves stay separate: they are
          // two real pairings with two tokens and independent disconnect/revoke, so a
          // merged card would make 「删掉这一条」("delete this one") ambiguous. See
          // session/machine_group.dart for the three grouping rules.
          // REQ-12-10b — a computer with MORE THAN ONE connection gets a shell
          // around its rows (owner 2026-08-12: the header line alone read as
          // three peer cards). The rows are unchanged inside it: still one
          // `Dismissible` each, still individually tappable, and the pin-mismatch
          // notice still sits directly under the row it is about. See
          // [_machineGroupRouted] for why the shell carries no tap of its own.
          for (final MachineGroup g in groupPairingsByMachine(pairings))
            _machineGroupRouted(this, s, g, <Widget>[
              for (final MobileSession p in g.rows) ...<Widget>[
                _pairingCardRouted(this, s, p),
                // 🔴 W8-1 — directly under the row it is about. See [_pinMismatchKey].
                if (_pinMismatchKey == ConnectionsController.keyFor(p))
                  _pinMismatchNotice(s),
              ],
            ]),
          // GA-33 (owner 2026-07-26, measured): the dashed 「云端实例」("cloud
          // instance") entry card and the
          // remembered cloud-instance session are the SAME thing seen twice. Once
          // the session exists it IS the entry point, so the card retires. (Nothing
          // was ever duplicated in storage — token_storage dedupes by
          // connectionIdentity — this was two representations of one row.)
          if (!pairings.any((MobileSession p) => p.channel == 'saas'))
            _cloudCardRouted(this, s),
          const SizedBox(height: 14),
          _addButton(s),
          const SizedBox(height: 12),
          Center(
            child: Text(
              s.startNoAutoConnect,
              style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
            ),
          ),
          // 0.3.0 P1 — 「where do my words go」, reachable from the FIRST screen a
          // new install shows: before any pairing exists, and therefore before
          // the user has said a word. Row + rationale: data_flow_disclosure_entry.dart.
          const SizedBox(height: 18),
          DataFlowDisclosureEntry(appSettings: widget.appSettings),
        ],
      ),
    );
  }

  Widget _emptyHint(AppStrings s) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 8, 4, 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(s.noInstances, style: TextStyle(color: FlowMicColors.t2, fontSize: 14, fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        Text(s.noInstancesHint, style: TextStyle(color: FlowMicColors.t3, fontSize: 12)),
      ],
    ),
  );

  /// 🔴 W8-1 — the pin-mismatch surface: 「这台电脑不是你配对的那一台」("this PC
  /// is not the one you paired with"), standing on
  /// the screen until the user does something about it.
  ///
  /// 🔴 WHAT THIS CARD DID AND DID NOT DO, stated because the difference is easy
  /// to misread later. The SENTENCE existed before this card, and so did the code
  /// that produces it: driven through a transport double, the instance list
  /// already toasted the full 「这个地址上的电脑不是你配对的那一台…」("the PC at
  /// this address is not the one you paired with…") on a refused
  /// dial. What this card changed is its LIFETIME and its PLACE — a standing
  /// condition now has a standing surface, under the row it is about.
  /// ⚠️ **That means the device-line reading (「无横幅」("no banner"), nothing at all) is NOT
  /// explained by anything fixed here**, and this comment must not be read as if
  /// it were: everything above the transport was already producing the code and
  /// the copy. This card originally named two below-transport suspects; both
  /// have since been MEASURED (card C1, test/lan_pin_real_handshake_test.dart),
  /// and the VM half of the gap is now closed:
  ///   (a) 「the real socket.io/TLS stack may not classify a refused handshake
  ///       into the pinMismatch fact」 — REFUTED on the VM: a real
  ///       `SecureServerSocket` serving a sidecar-shaped certificate, dialled
  ///       through `SocketCore` with its DEFAULT factory and a wrong pin, throws
  ///       promptly (connect_error, not the 12 s timeout) with
  ///       `lastDialPinMismatch == true`;
  ///   (b) a row whose `lanTlsFp` is null: split in two. A LEGACY null-fp row
  ///       stores `http://` and never does TLS at all (measured on the P30,
  ///       2026-08-10-rdreg §2-2) — for those this case is vacuous. The one
  ///       null-fp shape that DOES dial TLS is a hand-typed `https://` endpoint
  ///       (`_tofuFingerprintFor` deliberately records nothing for it); its
  ///       refusal leaves `lastDialPinMismatch` false and surfaces as
  ///       「够不着」("unreachable"), which is honest — no identity was ever
  ///       recorded, so this
  ///       branch would be a claim with no fact behind it (R11).
  /// ⚠️ Also measured there: the logcat line the device read
  /// (`CERTIFICATE_VERIFY_FAILED … handshake.cc:298`) is byte-identical between
  /// a pin refusal and a system-trust refusal, so that line alone could never
  /// have said which one W8-1 saw; the diag trail's `lan.pin outcome=mismatched`
  /// is the discriminating artefact.
  /// 🔴 What remains open is exactly and only the DEVICE half: whether the same
  /// chain holds on Android (same engine code, unproven there), and whether this
  /// notice actually renders on a real phone. Only a certificate rotation on a
  /// real LAN closes that; whoever runs it, the notice appearing closes W8-1,
  /// and a still-silent tap now points at the Android platform half or this
  /// page's wiring — no longer at the classification.
  ///
  /// 🔴 IT RENDERS `pairError`, NOT A SECOND WORDING. That function already owns
  /// the sentence for this fact in four languages (`pairing_strings.dart`
  /// `pairCandidatesFailed`, whose head and tail both change face when any
  /// address came back `pinMismatch`), it is the copy `pair()` surfaces on the
  /// add-pairing sheet, and it is consistent with the protocol's own
  /// `LAN_CERT_PIN_MISMATCH` sentence. A notice with its own string would be the
  /// same fact told twice, and the two would drift on the first edit — the
  /// reason `ptt_session.dart`'s mismatch branch reports through this same
  /// channel instead of inventing one.
  ///
  /// 🔴 UNBOUNDED LINES ON PURPOSE. The sentence names the addresses tried and
  /// the action to take, and 0.2.53 shipped a code clipped to three letters
  /// because a status line with six competing cells had to end in an ellipsis.
  /// This is a card, not a cell: nothing here competes for the width, so the
  /// whole sentence can be read. There is no `maxLines` and no
  /// `TextOverflow.ellipsis`, and pin_mismatch_surface_test.dart measures the
  /// RENDERED paragraph (line count > 1, `didExceedMaxLines` false, the box
  /// inside the viewport) rather than `Text.data`.
  Widget _pinMismatchNotice(AppStrings s) => Container(
    key: const ValueKey<String>('connections.pinMismatch'),
    margin: const EdgeInsets.only(bottom: 10),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    decoration: BoxDecoration(
      color: FlowMicColors.redSoft,
      border: Border.all(color: FlowMicColors.red),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        // 2026-08-01 owner:「颜色+图标组合，不能只靠颜色」("colour + icon
        // combination, never colour alone").
        Icon(Icons.gpp_bad_outlined, size: 18, color: FlowMicColors.red),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            key: const ValueKey<String>('connections.pinMismatch.text'),
            s.pairError(_pinMismatchCode),
            style: TextStyle(
              color: FlowMicColors.t1,
              fontSize: 12.5,
              height: 1.45,
            ),
          ),
        ),
      ],
    ),
  );

  Widget _addButton(AppStrings s) => Container(
    height: 48,
    decoration: BoxDecoration(
      gradient: LinearGradient(colors: FlowMicColors.pttIdle),
      borderRadius: BorderRadius.circular(14),
    ),
    // Same Material+InkWell pattern as _card: the primary CTA on this page was
    // the one control with NO press feedback (a bare GestureDetector).
    child: Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: widget.connections.busy ? null : _add,
        borderRadius: BorderRadius.circular(14),
        child: Center(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.add, color: Colors.white, size: 18),
              const SizedBox(width: 6),
              Text(s.addDevice, style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
      ),
    ),
  );
}

