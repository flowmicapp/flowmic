// SPEC-REF:
//   packages/protocol/src/protocol-schemas-auth.ts (TargetCapsSchema,
//     TargetCapsAckFieldsSchema — the wire shape)
//   docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3
//   card S2-01
//
// What the TARGET at the other end of this room can receive, read off the
// `mobile:pair` / `mobile:reconnect` ack.
//
// 🔴 THREE STATES, AND THE THIRD IS THE COMMON ONE.
//   · undeclared — the ack carried no `target_caps`. Every FLOWMIC-PC built
//     before this card is here, and so is every relay that predates the field.
//     The rule is ALLOW: refusing would stop image delivery for every install on
//     the day this ships.
//   · declared yes — `{image: true}`.
//   · declared no — `{image: false}`. The microphone end says so BEFORE sending
//     and does not queue the picture (design §3: 「不入队、不计配额」).
// Collapsing undeclared into "no" is the tempting simplification and it is a
// regression; collapsing it into "yes" loses the ability to ever say no.
//
// 🔴 A DIFFERENT QUESTION FROM `ServerCapabilities`, which rides the same acks.
// That one says what the SERVER can do; this says what the TARGET can receive.
// The two even fail in opposite directions — an unknown server capability is
// read fail-CLOSED (hold the audio), an unknown target capability fail-OPEN
// (send the picture) — so one type carrying both would be a value answering two
// questions with two right answers.
//
// ⚠️ STORED, NOT YET ACTED ON. Nothing reads [canSendImage] in production yet:
// the image UI that asks before sending is card S3-02. That is deliberate and it
// is why this file ships with the reader — a capability the phone cannot see is
// a capability the phone cannot start honouring.

import 'package:flutter/foundation.dart' show immutable;

/// What one ack said about the target.
@immutable
class TargetCaps {
  const TargetCaps._(this.image, this.imageNote, this.declared);

  /// No ack read yet, or an ack that carried no `target_caps` key.
  const TargetCaps.undeclared()
      : image = null,
        imageNote = null,
        declared = false;

  /// Can the target receive a picture? `null` means it has not said.
  final bool? image;

  /// The target's OWN words for why not (a third-party site's setting), shown
  /// beside our sentence. Null unless the target supplied one — we never invent
  /// a reason on its behalf.
  final String? imageNote;

  /// Did the ack carry the key at all? See the file header for why this is not
  /// the same question as [image] being false.
  final bool declared;

  /// The rule the sending path will use (card S3-02): send unless the target
  /// has DECLARED it cannot. Undeclared allows, because that is where every
  /// installed target sits and because degrading to today's product is the only
  /// safe direction for a field a relay may strip.
  bool get canSendImage => image != false;

  @override
  String toString() => declared
      ? 'TargetCaps(image: $image${imageNote == null ? '' : ', note: $imageNote'})'
      : 'TargetCaps(undeclared)';
}

/// Read `target_caps` off a pair / reconnect ack.
///
/// TOLERANT IN ONE DIRECTION ONLY, the same way `parseServerCapabilities` is: a
/// missing key, a non-map, or a `image` that is not a real boolean all come back
/// as [TargetCaps.undeclared] rather than throwing — a malformed capability must
/// never break a pairing that is otherwise fine, and it must never be mistaken
/// for a refusal. What this will NOT do is invent a declaration: `image` has to
/// arrive as a genuine `true`/`false` to be one.
TargetCaps parseTargetCaps(Object? ack) {
  if (ack is! Map) return const TargetCaps.undeclared();
  final Object? raw = ack['target_caps'];
  if (raw is! Map) return const TargetCaps.undeclared();
  final Object? image = raw['image'];
  if (image is! bool) return const TargetCaps.undeclared();
  // TRIMMED, and a note that is only whitespace is dropped. The wire schema
  // accepts it (`NonEmpty` counts characters, and a space is one), so this is
  // the side that has to notice — a blank reason rendered beside our sentence
  // looks like a target that explained itself and said nothing.
  final Object? note = raw['image_note'];
  final String trimmed = note is String ? note.trim() : '';
  return TargetCaps._(image, trimmed.isEmpty ? null : trimmed, true);
}
