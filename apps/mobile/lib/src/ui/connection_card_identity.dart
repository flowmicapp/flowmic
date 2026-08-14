// REQ-12-10 — connection-list **identity** face (notes vs PC), separate from
// channel (lan/relay) and liveness (online/offline). Design:
// docs/strategy/2026-08-12-req1210-connection-list-identity-design.md
//
// Pure helpers live here so unit tests can pin the machine-uid → lane mapping
// without pumping the whole ConnectionsPage. Widget keys below are the only
// production grep anchors for "this row claims to be notes / PC lane N".

import 'package:flutter/material.dart';

import 'tokens.dart';

/// What kind of destination this card is answering for.
///
/// Distinct from [ServerChannel] / transport face: a saas **pairing row** and
/// the dashed **entry** card are both notes-identity; a PC reached over the
/// cloud relay is still `pc`.
enum ConnectionCardKind {
  /// Dashed-intent entry before a saas session exists.
  notesEntry,

  /// Remembered `channel == 'saas'` pairing (virtual light-notes PC).
  notesSession,

  /// Real computer pairing (standalone or relayed).
  pc,
}

/// Colours + keys for the 4px identity lane on each connection card.
abstract final class ConnectionCardIdentity {
  static const Key notesLaneKey = ValueKey<String>('conn.identity.notes');
  static const Key pcNeutralLaneKey =
      ValueKey<String>('conn.identity.pc.neutral');

  static Key pcLaneKey(int index) =>
      ValueKey<String>('conn.identity.pc.$index');

  /// Stable lane in `0..3` from `pc_machine_uid`. Empty/null ⇒ no claim.
  static int? machineLaneIndex(String? machineUid) {
    if (machineUid == null || machineUid.isEmpty) return null;
    var h = 0;
    for (final int c in machineUid.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return h % 4;
  }

  /// Ink for the left strip (+ leading glyph for notes).
  static Color laneInk(ConnectionCardKind kind, String? machineUid) {
    switch (kind) {
      case ConnectionCardKind.notesEntry:
      case ConnectionCardKind.notesSession:
        // Amber = 「仅记录 / organize」("record-only / organize") family — deliberately NOT channel indigo.
        return FlowMicColors.amber;
      case ConnectionCardKind.pc:
        final int? i = machineLaneIndex(machineUid);
        if (i == null) return FlowMicColors.t3;
        return FlowMicMachineLaneColors.ink[i];
    }
  }

  /// Soft fill behind the leading icon (and notes card wash).
  static Color laneSoft(ConnectionCardKind kind, String? machineUid) {
    switch (kind) {
      case ConnectionCardKind.notesEntry:
      case ConnectionCardKind.notesSession:
        return FlowMicColors.amberSoft;
      case ConnectionCardKind.pc:
        final int? i = machineLaneIndex(machineUid);
        if (i == null) return FlowMicColors.surface2;
        return FlowMicMachineLaneColors.soft[i];
    }
  }

  static Key laneKey(ConnectionCardKind kind, String? machineUid) {
    switch (kind) {
      case ConnectionCardKind.notesEntry:
      case ConnectionCardKind.notesSession:
        return notesLaneKey;
      case ConnectionCardKind.pc:
        final int? i = machineLaneIndex(machineUid);
        if (i == null) return pcNeutralLaneKey;
        return pcLaneKey(i);
    }
  }

  /// Card surface: notes get a wash; PC stays plain surface.
  static Color cardFill(ConnectionCardKind kind) {
    switch (kind) {
      case ConnectionCardKind.notesEntry:
      case ConnectionCardKind.notesSession:
        return Color.alphaBlend(FlowMicColors.amberSoft, FlowMicColors.surface);
      case ConnectionCardKind.pc:
        return FlowMicColors.surface;
    }
  }

  /// Entry card: thicker amber border (honest stand-in for the unused `dashed`).
  static BorderSide borderSide(ConnectionCardKind kind) {
    if (kind == ConnectionCardKind.notesEntry) {
      return BorderSide(color: FlowMicColors.amber.withValues(alpha: 0.65), width: 1.5);
    }
    return BorderSide(color: FlowMicColors.line);
  }
}
