// SPEC-REF:
//   docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md
//     (owner, verbatim: "the original-image option for sending pictures is
//      only available on the local LAN — over the cloud relay you can only
//      send the compressed picture" 「传图的原图选项只在本地局域网才有选项，如果是
//      云端中继只能发压缩后的图」 / "the cloud relay... must never exceed 1M"
//      「云端中继……最大不能大于 1M」 / "restrict users from using this channel as
//      a way to sync phone pictures to the PC" 「限制用户利用这个通道来把它作为同步
//      手机图片到 PC 的选项」 / "the phone client must also gate it — this
//      improves the phone client's experience and saves the server's
//      connections" 「手机客户端也要拦，这是增强手机用户端的体验和节约服务器的连接」)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.1 (channel
//     criterion / image byte ceiling / original-image forking by channel), §6 G-14
//   apps/mobile/lib/src/session/image_payload.dart (kCloudImageBytesMax,
//     imageOriginalAllowed — this file invents no new criterion, it only reuses them)
//   CLAUDE.md red line: no silent failure (banned in both directions) /
//     source_text is immutable
//
// ── THE QUEUE SIDE'S CLOUD IMAGE POLICY (card B4-17, doc 15 G-14) ───────────
//
// WHAT WAS BROKEN. owner ruled the original image (原图) is a LAN-only
// capability, and 0.2.34 delivered that at the SEND site: the tick box only
// exists on the LAN leg, and the cloud leg picks at a smaller tier so its
// output is under 1 MiB naturally. But a picture does not necessarily go out
// on the channel it was picked on. The queue exists precisely because a
// delivery outlives its connection: tick "original" on the LAN, walk out of
// the building, and the drain that finally runs is on the relay. Up to 3.9 MB
// of original bytes then crossed the cloud — the exact thing owner ruled
// against, arrived at by a route nobody looked at.
//
// 🔴 WHY THIS IS A DEFECT AND NOT A NEW CAPABILITY (the G-12 governance
// ruling, which forbids giving the queue new abilities before the reduction
// audit). The test G-12 states is "letting the queue do something it
// couldn't do before = a capability; making the queue correctly do what it
// already promised = a defect" (「让队列能做以前做不到的事＝能力，让队列把已承诺
// 的事做对＝缺陷」). This promise was made in 0.2.34 and is already written on
// the user's screen — the blocked tick box says the original image cannot be
// sent over the cloud relay (云端中继下不能发原图). The queue is the one path
// that breaks it. Nothing here lets the queue do anything it could not do
// before; it declines to do one thing it was never supposed to do.
//
// ── THE SECOND DEFECT THIS CLOSES: A REFUSAL LOOP ────────────────────────────
//
// 0.2.35 gave the relay its own ceiling (`INJECT_CLOUD_IMAGE_TOO_LARGE`,
// socket/cloud-image-policy.ts). That code is deliberately NOT terminal on the
// phone (`isTerminalRefusalCode`), and rightly so: "switching to the LAN would
// let it send" (「换到局域网就能发」) is true, so stopping the item forever
// would be a lie in the other direction.
//
// ⚠️ But "retryable" + "retried on a connection that will always refuse it" is
// a loop. Without this file the item would go: drain → emit → relay refuses →
// settle back to `queued` → next reconnect → emit again, forever, each pass
// spending one relay round trip on bytes that cannot be accepted. That is the
// opposite of owner's own stated reason for wanting a phone-side gate at all
// ("saves the server's connections" 「节约服务器的连接」). Holding removes the
// emit entirely — the item is never flipped to `inflight`, so no frame is
// built, no round trip is spent, and no watchdog is armed.
//
// 🔴 THE TWO GATES STILL ANSWER DIFFERENT QUESTIONS, which is why both exist:
// the server answers "is it permitted" (允不允许) (and is the only actual
// protection — another client is not bound by any of this), the phone
// answers "is it worth wasting this trip" (要不要白跑这一趟). This file is
// the third site of the phone's half, and it is not a third
// judgement: it calls the SAME [imageOriginalAllowed] the panel and
// `image_send_controller` call.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────────
//
// ⛔ IT DOES NOT RE-COMPRESS. The obvious "fix" is to shrink the picture to the
// cloud tier and send it anyway, and it is banned: the user ticked "original",
// and silently substituting a smaller picture would deliver something other
// than what was promised while reporting success — red line F2 in its second
// direction, on the one payload where the substitution is invisible in the
// delivery report and permanent in the user's document.
// ⛔ IT DOES NOT SETTLE THE ITEM `refused`. A terminal refusal says "retrying
// cannot help"; here retrying on the LAN is exactly what helps. The item stays
// `queued`, keeps counting toward "N items still undelivered" (还有 N 条未投递),
// renders "queued" (排队中), and drains by itself the next time the phone is
// on its own network. Nothing is asked of the user and nothing is lost.
// ⛔ IT DOES NOT LOOK AT "whether the user originally ticked original-image"
// (用户当初勾没勾原图). That flag is not on the item and must not be: the rule
// is about BYTES ON A CHANNEL, not about intent. A LAN-tier compressed
// picture (3456/q92) can also exceed 1 MiB without any tick box being
// involved, and it is refused by the relay for the same reason and must be
// held for the same reason.

import 'image_payload.dart';
// `ServerChannel` arrives with `LiveConnection`'s own file, which re-exports it
// for exactly this reason — see that export's note.
import 'outbox_destination.dart';

/// 🔴 Should this queued delivery be HELD rather than sent on this connection?
///
/// Returns the refusal to hold it with, or null to let it proceed.
///
/// [byteLength] is the length of the payload the drain has already read for
/// this item —
/// **null for a text item**, which is how "text items are not bound by this
/// policy" (文字项不受这条政策约束) is structural here rather than a branch
/// someone could forget. It is passed in rather than
/// re-read: the drain reads an image's bytes exactly once per attempt (see
/// `DeliveryOutbox._attempt`'s note on why two reads would be two answers to
/// "are the bytes still there" 「字节还在吗」), and this must judge the same
/// bytes that would be sent.
///
/// [channel] is the MEASURED channel of the live connection
/// ([LiveConnection.channel]).
///
/// 🔴 FAIL-CLOSED ON UNKNOWN, and via the SAME expression the send site uses.
/// `!imageOriginalAllowed(channel)` is literally how `image_send_controller`
/// spells "this leg is cloud" (这条腿是云端) today
/// (`final bool cloud = !imageOriginalAllowed(...)`), so an unknown channel
/// counts as cloud in both places and the two can never disagree. The cost of
/// guessing the other way is an original crossing the relay, which is the
/// thing owner ruled out; the cost of guessing this way is a picture that
/// waits for one more health probe.
OutboxAddressRefused? cloudImagePolicyHold({
  required int? byteLength,
  required ServerChannel? channel,
}) {
  // Not a picture ⇒ this policy has nothing to say about it. owner's ruling is
  // about pictures (图片) and bandwidth cost (流量成本); a long sentence is not
  // a photo sync channel.
  if (byteLength == null) return null;
  // `<=` on purpose: `kCloudImageBytesMax` is the largest ACCEPTED size, and the
  // server's own comparison (`bytes > CLOUD_IMAGE_BYTES_MAX`) is the same shape.
  // An off-by-one here would hold a picture the relay would have taken.
  if (byteLength <= kCloudImageBytesMax) return null;
  if (imageOriginalAllowed(channel)) return null;
  return const OutboxAddressRefused(OutboxAddressRefusal.cloudImageOverCap);
}
