// E-CL — what a light record looks like INSIDE the envelope.
//
// SPEC-REF: docs/strategy/2026-08-08-design-e-blindstore-client.md §3.1
//   (「序列化为条目 JSON → AEAD 封装 → timeline:push」("serialize to entry JSON →
//   AEAD-seal → timeline:push");「本卡只上行文本条目与元数据,
//   不上行图片字节」("this card only uploads text entries and metadata, it does
//   not upload image bytes")), §3.2 (read back → decrypt → merge by id).
//
// The server never sees any of this. `timeline_blobs.ciphertext` is opaque to it
// by construction, so this shape answers to nobody but the phones of one
// account — which is why it is the device-local [TimelineEntry.toJson] shape
// rather than a second, parallel wire format someone would have to keep in step.
//
// 🔴 THE ONE SUBTRACTION: `thumb_b64` is stripped. Design §3.1 draws the line
// at 「不上行图片字节」("do not upload image bytes"), and the thumbnail IS
// image bytes — inline base64 of a
// 256px preview. Uploading it would walk straight into the already-ruled cloud
// image policy (owner 2026-08-01: original images stay LAN-only / cloud ≤1M /
// guard against being used as an image-sync channel — 原图只在局域网 / 云端
// ≤1M / 防被当成图片同步通道), which is another card's ground. The picture ROW
// still travels, so a
// second device learns 「这里有过一张图」("there used to be a picture here")
// with its label and its place in the
// timeline; the pixels stay on the phone that took them.
//
// ⚠️ Stripping it here is also what makes [blindStorePayloadHash] stable for a
// picture row: the hash cannot move when a thumbnail is regenerated, so a
// re-thumbnailed row does not masquerade as an edit and burn a fresh `seq`.

import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../timeline_entry.dart';

/// Version of the plaintext envelope BODY (not of `e2e:v1:`, which is the
/// crypto envelope, and not of `schema_ver` on the wire row).
///
/// Bumped when this body's shape changes in a way a reader must know about. A
/// reader that meets a HIGHER version than it understands must say so rather
/// than guess — see [decodeBlindStorePayload].
const int kBlindStorePayloadVersion = 1;

/// Wire-row `schema_ver` for blobs this build pushes.
///
/// The protocol requires a positive int and the server stores it verbatim; it
/// describes the payload this file produces, so it tracks
/// [kBlindStorePayloadVersion] rather than the socket protocol's schema version
/// (two different questions — the socket one is already negotiated at handshake).
const int kBlindStoreBlobSchemaVer = kBlindStorePayloadVersion;

/// The key stripped on the way out. Named so the test can assert on the same
/// string the code uses, instead of a copy that could drift.
const String kBlindStoreStrippedImageKey = 'thumb_b64';

/// Entry → the plaintext that goes inside the AEAD envelope.
///
/// Deterministic: `TimelineEntry.toJson` builds a map literal, Dart maps keep
/// insertion order, and `jsonEncode` walks that order — so the same entry always
/// produces the same string, which is what makes [blindStorePayloadHash] usable
/// as 「云端那份是不是当前内容」("whether the cloud copy is the current content").
String encodeBlindStorePayload(TimelineEntry entry) {
  final Map<String, Object?> body = entry.toJson()
    ..remove(kBlindStoreStrippedImageKey);
  return jsonEncode(<String, Object?>{
    'v': kBlindStorePayloadVersion,
    'entry': body,
  });
}

/// The plaintext → an entry, or null if this is not something we can read.
///
/// Null means 「读不懂」("cannot be understood") and the caller MUST count it
/// and speak about it (design
/// §3.2: entries that cannot be decrypted are counted and reported (解不开的
/// 条目计数并出声)). It must never be treated as 「云端没有这一条」("the cloud
/// doesn't have this entry").
TimelineEntry? decodeBlindStorePayload(String plaintext) {
  final Object? decoded;
  try {
    decoded = jsonDecode(plaintext);
  } on FormatException {
    return null;
  }
  if (decoded is! Map) return null;
  final Map<String, Object?> j = decoded.cast<String, Object?>();
  final Object? v = j['v'];
  // A payload from a NEWER build is refused, not partially read. Reading the
  // fields we recognise and dropping the rest would silently discard whatever
  // the newer build considered important, and then push the truncated row back
  // up as an edit — data loss dressed as a sync.
  if (v is! int || v > kBlindStorePayloadVersion) return null;
  final Object? body = j['entry'];
  if (body is! Map) return null;
  return TimelineEntry.fromJson(body.cast<String, Object?>());
}

/// The fingerprint of an entry's cloud copy.
///
/// Answers exactly one question: 「云端那一份是不是这一份?」("is the cloud copy
/// this one?") It is compared
/// against the hash recorded when the push was ACKED, so a re-push happens iff
/// the content really changed.
///
/// 🔴 Why a hash of the PLAINTEXT and not of the ciphertext: every seal draws a
/// fresh random nonce (it must — a repeated (key,nonce) in GCM is catastrophic),
/// so sealing the same entry twice yields two different ciphertexts. Comparing
/// ciphertexts would report 「changed」 every single time, and since the server
/// treats a different ciphertext for a known id as an EDIT with a fresh `seq`,
/// every launch would re-upload the whole timeline and make every other device
/// re-pull it. The plaintext hash is the only stable thing in the pipeline.
String blindStorePayloadHash(String payload) =>
    sha256.convert(utf8.encode(payload)).toString();
