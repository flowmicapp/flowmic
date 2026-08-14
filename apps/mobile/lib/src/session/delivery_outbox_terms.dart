// 800-line cap (card B4-17): the three top-level declarations of
// delivery_outbox.dart, moved VERBATIM so the cloud-image policy hold could be
// added without deleting a word of the reasoning already there (lead's card:
// "what gets squeezed out is always the reasoning prose, and that's the most
// expensive thing in this repo" 「压掉的都是说理文字，那是本仓最贵的东西」).
//
// 🔴 NOTHING WAS CHANGED — same names, same values, same docs, same order, same
// privacy. This is a `part`, not a separate library, and that is what keeps the
// move invisible: `_Attempt` stays library-private and both constants stay
// exported by `delivery_outbox.dart` itself, so not one caller — production or
// suite — has to be edited. **Any diff here beyond "moved" is a bug.**
//
// ⚠️ WHY THE CONTENTS LOOK ARBITRARY, said out loud so nobody looks for a design
// that is not here: Dart cannot split a CLASS across files, so a file that is
// one 700-line class can only be relieved by moving its TOP-LEVEL declarations —
// and these three are all of them. The common property is "the vocabulary
// delivery_outbox.dart speaks in" (its two bounds and its per-item verdict),
// not a module boundary.

part of 'delivery_outbox.dart';

/// The lead's own self-imposed limit, 2000 (owner defined "opened up long"
/// (「开得长」) and gave the reasoning, which is the
/// design input and not just a permission: "failed deliveries generally
/// won't be numerous — once delivery fails, the user stops talking"
/// (「投递不成功的一般不会很多——投递不成功用户就不会继续说了」) ⇒ the bound is
/// set by human behaviour, not by
/// capacity planning, so the number only has to be big enough never to be hit).
const int kOutboxCapacity = 2000;

/// How long an item may sit at `inflight` before the LOCAL watchdog takes it
/// back. Deliberately longer than `kInjectResultTimeout` (20 s): the row's own
/// watchdog should be the one that reports a missing verdict to the user, and
/// this one exists only so an item can never be stranded at `inflight` by a
/// process that died between the emit and the result.
const Duration kOutboxInflightTimeout = Duration(seconds: 45);

/// What one attempt did with one item. Private because it is the drain loop's
/// internal vocabulary; [OutboxDrainReport] is the public shape.
class _Attempt {
  const _Attempt.sent() : held = null, refusedCode = null;
  const _Attempt.held(OutboxAddressRefusal this.held) : refusedCode = null;
  const _Attempt.refused(String this.refusedCode) : held = null;

  final OutboxAddressRefusal? held;
  final String? refusedCode;
}
