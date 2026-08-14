// Part of connections_page.dart — REQ-12-10 card chrome (pairing / cloud entry /
// shared shell). Split because connections_page.dart sat at SRC_MAX=800 and this
// card needs an identity lane. Same discipline as connections_row_faces.dart:
// top-level *Routed helpers, first arg is the State; bodies moved with the
// mechanical `widget.` → `page.widget.` rewrite only, plus the identity strip.

part of 'connections_page.dart';

/// The widget key on a same-machine group's SHELL container.
///
/// Public because it is the only grep anchor a test (or a later reader) has for
/// 「this group is really wrapped together」 — the shell is otherwise pure decoration, and
/// decoration is exactly the kind of change that can vanish without anything
/// failing. Keyed by uid so two shelled groups on one screen are separable.
Key machineGroupShellKey(String? machineUid) =>
    ValueKey<String>('conn.group.shell.${machineUid ?? ''}');

/// REQ-12-10b — one computer's rows, and (only when there is more than one) a
/// SHELL that says they belong together.
///
/// 🔴 THE SHELL STATES A RELATION AND DOES NOTHING ELSE. It has no `onTap`, no
/// `InkWell`, no gesture of any kind, and that is a hard constraint rather than
/// an omission: `session/machine_group.dart` records that these rows are two
/// genuine pairings — two tokens, two `mobile_pairings` rows, independently
/// revocable — so a tappable container around them would make 「delete this one」
/// ambiguous and 「disconnect」 unable to name which. What was missing was never the
/// merge; it was the STATEMENT. A clickable shell IS the merge, wearing
/// different markup.
///
/// 🔴 TINTED, NOT NEUTRAL — and this is where the phone deliberately parts from
/// the desktop half that landed the same day (`PairedList.vue`, 0450b0a). That
/// shell is neutral because the desktop has no identity colour, and inventing
/// one there would have been a second identity language agreeing with nothing.
/// The phone DOES have one: REQ-12-10 hashes `pc_machine_uid` to one of four
/// lanes, every row of this group already wears it on its left edge, and the
/// card (§2.1「outlined in the same color as the group's color band」) asks the shell to speak that same language.
/// Two surfaces, two right answers, because the premise differs.
///
/// ⚠️ A shared group ALWAYS has a non-null uid — `groupPairingsByMachine` rule ①
/// puts every unidentified row in a group of its own — so the tint here is never
/// the neutral `t3` fallback.
///
/// ⚠️ A SINGLE row gets no shell at all (card §2.4). Chrome with no information
/// in it is worse than none: a box around one thing says 「this group」 about a group
/// that does not exist.
Widget _machineGroupRouted(
  _ConnectionsPageState page,
  AppStrings s,
  MachineGroup g,
  List<Widget> rows,
) {
  if (!g.isShared) {
    // Unshelled groups render exactly as they did before this card — same
    // widgets, same margins, no wrapper introducing a layout of its own.
    return Column(mainAxisSize: MainAxisSize.min, children: rows);
  }
  final Color lane = ConnectionCardIdentity.laneInk(
    ConnectionCardKind.pc,
    g.machineUid,
  );
  return Container(
    key: machineGroupShellKey(g.machineUid),
    // 🔴 Card §2.2 — the gap INSIDE the group must be smaller than the gap
    // between the group and whatever sits next to it, or the container is
    // decoration that does not group anything. The rows carry a 10px bottom
    // margin of their own (`_identityCardRouted`), so this outer margin has to
    // clear 10 by enough to read as a different distance: 18/6 measured, and
    // `connections_group_shell_widget_test.dart` measures the RENDERED gaps
    // rather than these numbers.
    margin: const EdgeInsets.only(top: 6, bottom: 18),
    padding: const EdgeInsets.fromLTRB(8, 0, 8, 2),
    decoration: BoxDecoration(
      // A wash DARKER than the cards it holds, so the container reads as the
      // ground the rows sit on. `surface2` would have been lighter than
      // `surface` and inverted that.
      color: Color.alphaBlend(lane.withValues(alpha: 0.07), FlowMicColors.canvas),
      border: Border.all(color: lane.withValues(alpha: 0.45)),
      borderRadius: BorderRadius.circular(20),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _sameMachineHeaderRouted(page, s, g),
        ...rows,
      ],
    ),
  );
}

/// 「same computer」 line above a group's rows. Only ever drawn for a group the
/// server actually identified (machine_group.dart rule ①), and since REQ-12-10b
/// only ever from inside [_machineGroupRouted]'s shell — it is that shell's top
/// bar, not a free-floating line above three peer cards, which is the shape
/// owner read as 「three peer-level cards」.
Widget _sameMachineHeaderRouted(
  _ConnectionsPageState page,
  AppStrings s,
  MachineGroup g,
) {
  final Color lane = ConnectionCardIdentity.laneInk(
    ConnectionCardKind.pc,
    g.machineUid,
  );
  return Container(
    padding: const EdgeInsets.fromLTRB(2, 10, 2, 8),
    margin: const EdgeInsets.only(bottom: 8),
    decoration: BoxDecoration(
      border: Border(
        bottom: BorderSide(color: lane.withValues(alpha: 0.28)),
      ),
    ),
    child: Row(
      children: <Widget>[
        // REQ-12-10: same colour as the rows below — colour + icon (owner).
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: lane, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Icon(Icons.link, size: 13, color: FlowMicColors.t3),
        const SizedBox(width: 5),
        Expanded(
          child: Text(
            s.sameMachine(machineGroupLabel(g, fallback: 'PC'), g.rows.length),
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: FlowMicColors.t3,
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}

Widget _pairingCardRouted(_ConnectionsPageState page, AppStrings s, MobileSession p) {
  // `channel == 'saas'` is the CLOUD INSTANCE (the server's pseudo-PC row,
  // registry.ts CLOUD_INSTANCE_PC_NAME) — not merely 「reached over the relay」.
  final bool cloud = p.channel == 'saas';
  final ConnectionCardKind kind =
      cloud ? ConnectionCardKind.notesSession : ConnectionCardKind.pc;
  return Dismissible(
    key: ValueKey<String>('pair-${p.token}'),
    direction: DismissDirection.endToStart,
    background: Container(
      alignment: Alignment.centerRight,
      padding: const EdgeInsets.only(right: 18),
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: FlowMicColors.redSoft,
        // Matches the card's 18 so no square corner peeks out mid-swipe.
        borderRadius: BorderRadius.circular(18),
      ),
      child: Icon(Icons.delete_outline, color: FlowMicColors.red, size: 20),
    ),
    // owner 2026-07-27: a swipe used to delete the pairing outright. One
    // careless flick and the credential was gone — and getting it back needs
    // physical access to the PC for a new code. confirmDismiss gates the
    // animation itself, so declining leaves the card in place rather than
    // sliding it away and putting it back.
    confirmDismiss: (_) => confirmDestructive(
      page.context,
      title: s.removePairingConfirmTitle(pairingDisplayName(p)),
      message: s.removePairingConfirmBody,
      confirmLabel: s.confirmDelete,
      cancelLabel: s.cancel,
    ),
    onDismissed: (_) => page._remove(p),
    child: _identityCardRouted(
      page,
      kind: kind,
      machineUid: cloud ? null : p.pcMachineUid,
      onTap: page.widget.connections.busy ? null : () => page._connect(p),
      onLongPress: page.widget.connections.busy ? null : () => page._renameAlias(p),
      child: Row(
        children: <Widget>[
          // GA-33: a cloud instance rendered with a computer icon and a PC name
          // looks like a machine that does not exist — and the user has not
          // even set up a cloud-relay PC yet. Same row, honest iconography.
          _leadingIconRouted(
            kind: kind,
            machineUid: cloud ? null : p.pcMachineUid,
            icon: cloud ? Icons.cloud_outlined : Icons.computer,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  cloud ? s.cloudInstance : pairingDisplayName(p, fallback: 'PC'),
                  style: TextStyle(
                    color: FlowMicColors.t1,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                // GA-10 (owner's iron rule ③): a phone-local rename never leaves this
                // device, so this is the ONLY place the two names can differ —
                // the PC's own name stays visible in small type, or the user
                // cannot tell which machine they are about to speak into.
                if (pairingOriginalName(p) != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Text(
                      s.originalPcName(pairingOriginalName(p)!),
                      style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
                    ),
                  ),
                // Rows written before last_connected_at existed stay silent:
                // there is no honest instant to show and `now` is not evidence.
                if (p.lastConnectedAt != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Text(
                      s.lastConnectedAt(p.lastConnectedAt!),
                      style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
                    ),
                  ),
                const SizedBox(height: 3),
                Row(
                  children: <Widget>[
                    // v0.2.3 / RV-54 — THREE faces, never conflated:
                    //   · cloud instance → its own chip (virtual PC, not a transport);
                    //   · live measurement while online → cloud relay / local LAN;
                    //   · last measurement while offline → 「last time…」 (different face);
                    //   · never measured → dial host (LAN IP vs relay domain), so
                    //     two offline rows to one PC stay addressable without
                    //     pretending a past probe is current.
                    if (cloud)
                      ChannelBadge(label: s.cloudInstanceRow, cloud: true)
                    else
                      _transportFaceRouted(page, s, p),
                    const SizedBox(width: 8),
                    Flexible(
                      child: _statusLabelRouted(
                        page,
                        s,
                        key: ConnectionsController.keyFor(p),
                        endpoint: p.endpoint,
                        // RV-92: read from the PAIRING (`channel == 'saas'`),
                        // never from the transport — 「is the other end that
                        // virtual instance」
                        // and 「which channel this trip took」 are the two questions the
                        // v0.2.3 channel-chip bug conflated one layer up.
                        target: instanceTargetOf(p),
                        // RV-98: whether this row's own computer is present (the list-domain PcPresence).
                        pcPresence: page.widget.connections.presenceOf(p),
                      ),
                    ),
                  ],
                ),
                // A2 (device-found 2026-08-11): GA-33 retires [_cloudCard] the
                // moment any `channel=='saas'` row exists — and that card was
                // the ONLY host of [CloudSignOutRow]. Signed-in + remembered
                // cloud session ⇒ 「sign out」 vanished from the accessibility tree
                // and from the screen. Same widget, surviving host; still one
                // `signOutCloud` verb (ruling: do not build a second logout).
                if (cloud)
                  CloudSignOutRow(
                    login: page.widget.login,
                    connections: page.widget.connections,
                    strings: s,
                  ),
              ],
            ),
          ),
          Icon(Icons.chevron_right, color: FlowMicColors.t3, size: 20),
        ],
      ),
    ),
  );
}

Widget _cloudCardRouted(_ConnectionsPageState page, AppStrings s) =>
    _identityCardRouted(
      page,
      kind: ConnectionCardKind.notesEntry,
      machineUid: null,
      onTap: page.widget.connections.busy ? null : page._openCloud,
      child: Row(
        children: <Widget>[
          _leadingIconRouted(
            kind: ConnectionCardKind.notesEntry,
            machineUid: null,
            icon: Icons.cloud_outlined,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  s.cloudInstance,
                  style: TextStyle(
                    color: FlowMicColors.t1,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  s.cloudInstanceSub,
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
                ),
                const SizedBox(height: 3),
                // The cloud relay gets the same honest treatment as a LAN PC
                // (owner 2026-07-27:「including the cloud instance too」).
                // owner 2026-08-01:「this default instance for cloud light
                // records just needs to be able to connect to the cloud
                // relay server.」 —— this dashed card is that instance's
                // entry point, and it has no PC target.
                _statusLabelRouted(
                  page,
                  s,
                  key: ConnectionsController.cloudEntryKey,
                  endpoint: page.widget.connections.saasEndpoint,
                  target: InstanceTarget.cloudNotes,
                ),
                // L3 (owner 2026-08-02): where signing out of the cloud login lands is the devices page, not the settings page.
                // GA-33 retires THIS card once a saas row exists — the same
                // [CloudSignOutRow] is then hosted on that row (see pairing).
                // At most one of the two hosts is mounted; still one verb.
                CloudSignOutRow(
                  login: page.widget.login,
                  connections: page.widget.connections,
                  strings: s,
                ),
              ],
            ),
          ),
          Icon(Icons.chevron_right, color: FlowMicColors.t3, size: 20),
        ],
      ),
    );

/// Shared card shell with REQ-12-10 identity lane. Replaces the old `_card`
/// whose `dashed:` flag was never painted (façade closed here via entry border).
Widget _identityCardRouted(
  _ConnectionsPageState page, {
  required ConnectionCardKind kind,
  required String? machineUid,
  required Widget child,
  VoidCallback? onTap,
  VoidCallback? onLongPress,
}) {
  final BorderRadius radius = BorderRadius.circular(18);
  return Container(
    margin: const EdgeInsets.only(bottom: 10),
    decoration: BoxDecoration(
      color: ConnectionCardIdentity.cardFill(kind),
      border: Border.fromBorderSide(ConnectionCardIdentity.borderSide(kind)),
      // 18, not 14: the demo's `.card{border-radius:18px}` is the contract, and
      // both settingsCard and the chat tiles already follow it — these rows
      // were the only 14s left, which read as a different component family.
      borderRadius: radius,
    ),
    child: ClipRRect(
      borderRadius: radius,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Container(
              key: ConnectionCardIdentity.laneKey(kind, machineUid),
              width: 4,
              color: ConnectionCardIdentity.laneInk(kind, machineUid),
            ),
            Expanded(
              child: Material(
                color: Colors.transparent,
                child: InkWell(
                  onTap: onTap,
                  onLongPress: onLongPress,
                  child: Padding(
                    // `.dev-card{padding:15px 16px}` — was 14/13, noticeably
                    // tighter than the demo and than the settings rows.
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 15,
                    ),
                    child: child,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Demo `.dic{width:42px;height:42px;border-radius:13px}` with a 20px glyph —
/// was 38/r10/19, which made the row's anchor noticeably weaker than the demo.
Widget _leadingIconRouted({
  required ConnectionCardKind kind,
  required String? machineUid,
  required IconData icon,
}) {
  final Color ink = ConnectionCardIdentity.laneInk(kind, machineUid);
  return Container(
    width: 42,
    height: 42,
    decoration: BoxDecoration(
      color: ConnectionCardIdentity.laneSoft(kind, machineUid),
      borderRadius: BorderRadius.circular(13),
    ),
    child: Icon(icon, color: ink, size: 20),
  );
}
