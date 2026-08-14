// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 L64 (QR payload:
//     flowmic://pair?endpoint=<ws-url>&code=NNNN&channel=standalone|saas)
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (F-2346: standalone + loopback endpoint →
//     QR is suppressed, only the short code is shown)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R23-1 (ruling 2: QR rendered from a LOCAL
//     dep — no CDN; loopback endpoints suppress the QR)
//
// Pure, Tauri-free, DOM-free helpers for the device-page "添加手机" ("Add phone")
// modal so the QR-payload construction + loopback suppression are unit-testable
// in isolation. The Vue component only renders what derivePairingModal returns;
// the QR image itself is produced by the local `qrcode` npm dep at the call site.
//
// N5 (owner 需求② ["requirement ②"]) — the modal picks its pairing channel
// itself, so this module also owns the two honesty gates that come with a
// per-QR choice:
//   • `cloudPairBlock` — a cloud channel with no usable Cloud Key cannot pair at
//     all, so its option is DISABLED with the reason stated. The forbidden
//     alternative is an empty or relay-less QR that simply never scans.
//   • the `pending` reason — a snapshot describing the OTHER channel can answer
//     none of this modal's questions, so nothing is drawn from it (see below).

import type { CloudReadiness } from './channel';
import type { ChannelTag } from './types';

export interface PairingInfo {
  /** The current 4-digit code, or null after a token reconnect (needs refresh). */
  short_code: string | null;
  /** The server URL the desktop dials (e.g. http://127.0.0.1:41879). */
  endpoint: string;
  /** This PC's display name (pc:register.device_name). */
  pc_name: string;
  /** Whether the desktop has an active registration (a code can be minted). */
  connected: boolean;
  /** Mobiles currently present in the room. */
  mobiles: number;
  /** GA-21: every LAN IPv4 this host has, in the server's default order. Empty
   *  before the first /api/network read and on the cloud channel (where a local
   *  NIC is not a pairing destination at all). */
  lan_candidates?: string[];
  /** GA-18: ms until `short_code` expires, as the Rust side computed it from the
   *  deadline the minting ack established. `null`/absent = no code, or a server
   *  that sent no TTL — the modal then shows its static 「5 分钟内有效」("valid
   *  within 5 minutes") line instead of a countdown nothing backs. */
  expires_in_ms?: number | null;
  /** v0.2.4 — THIS MACHINE's cross-channel identity (Rust `pc_name::machine_uid`).
   *  The same value on the LAN channel and the relay, which is what makes 「是不是
   *  同一台 PC」("is it the same PC") answerable at all. `null`/absent = the
   *  machine id could not be read; the diagnostics row then says so rather than
   *  showing a placeholder. */
  machine_uid?: string | null;
  /** v0.2.4 — THIS MACHINE's LAN address, whatever the primary channel is.
   *
   *  `endpoint` above deliberately FOLLOWS the primary channel: it answers 「手机
   *  现在该拨哪里去配对」("where should the phone dial right now to pair"), and on
   *  the cloud channel that is the relay. The 本地局域网 ("local LAN") card asks a
   *  different question — 「这条通道的地址是什么」("what is this channel's
   *  address") — and was reading `endpoint`, so with cloud primary it printed the
   *  relay URL (owner 2026-07-29 设备页截图, "device-page screenshot"). Empty
   *  until the sidecar resolves one. */
  lan_endpoint?: string;
  /** N5 — WHICH channel this whole snapshot describes (Rust `PairingInfo.channel`).
   *
   *  The modal's channel switch re-reads asynchronously, so between the click and
   *  the answer this object still belongs to the PREVIOUS channel. Rendering it
   *  under the new tab would put server A's 4-digit code inside a payload whose
   *  `channel=` names server B — one frame of exactly the pairing mismatch RV-27
   *  removed. `derivePairingModal` therefore draws nothing until this tag matches
   *  the tab. `undefined` = an older shell that does not report it; the check then
   *  cannot run and the pre-N5 behaviour stands. */
  channel?: ChannelTag;
  /** D2-LAN — the sidecar's LAN TLS public-key fingerprint, for the QR's `fp=`.
   *
   *  ✅ PRODUCER (card D2LAN-B2b — this used to read 【未接线】("[not wired]") and
   *  name the two missing links; both now exist). The value travels:
   *    server `BootstrapHandle.lanTlsFingerprint`
   *      → `/api/network` key `lan_tls_fp` (server-core `http/router.ts`, symbol
   *        `publishableLanTlsFingerprint`)
   *      → the shell's LAN poll (`sidecar/io.rs`, symbol
   *        `parse_lan_tls_fingerprint`; stored on `SidecarState`)
   *      → Rust `PairingInfo.lan_tls_fp` (`shell/connection.rs`)
   *      → `asPairingInfo` (`lib/bridge.ts`) → here.
   *
   *  Absent/null on every hop that has nothing to say — a sidecar serving plain,
   *  an older shell, the cloud channel — and the payload is then byte-for-byte the
   *  pre-D2-LAN one.
   *
   *  ⚠️ What this does NOT deliver: the PHONE does not read `fp=` yet (card
   *  D2LAN-B3). The fingerprint reaches the QR; nothing pins it. */
  lan_tls_fp?: string | null;
  /** 0.2.66 — the relay's PUBLIC ADDRESSING id for this PC, nine decimal digits
   *  (Rust `PairingInfo.pcid`; design docs/strategy/
   *  2026-08-14-0266-cloud-pcid-pairing-design.md §4).
   *
   *  🔴 CLOUD ONLY. owner 2026-08-14:「本地局域网扫码或输入配对码，没有 PCID」
   *  ("scanning or entering a pairing code on the local LAN has no PCID"). The
   *  Rust snapshot already blanks it on the LAN channel (`shell/connection.rs`,
   *  symbol `pcid_for_channel`); `derivePairingModal` below refuses it a second
   *  time, the same two-gate shape `lan_tls_fp` has in the opposite direction.
   *
   *  It is NOT a secret and NOT a credential — it says WHICH pc a phone means,
   *  while the 4-digit code stays the only thing proving it may have it.
   *
   *  Absent/null = a relay older than this round (or LAN). No `pcid=` is then
   *  appended and the payload is byte-for-byte the pre-0.2.66 one. */
  pcid?: string | null;
}

/** 0.2.66 — nine digits are unreadable in one run; the display groups them
 *  `XXX XXX XXX` (ToDesk's grouping, design §4).
 *
 *  🔴 DISPLAY ONLY. The value that goes on the CLIPBOARD, into the QR and into the
 *  phone's input box is the raw nine digits — this function's output is not a PCID
 *  and must never be fed back into anything that addresses a PC. A caller that
 *  copies what it renders is the bug this comment exists to prevent, and
 *  `pairing-pcid.test.ts` pins that the modal's view carries the RAW value.
 *
 *  A value that is not exactly nine digits is returned VERBATIM rather than
 *  chopped into groups of three: this function's job is legibility, and inventing
 *  a grouping for something that is not a PCID would dress a wrong value as a
 *  right one. (The wire parser already refuses those — `socket/wire.rs`, symbol
 *  `parse_pcid` — so this branch is a boundary, not an expectation.) */
export function formatPcid(pcid: string): string {
  if (!/^\d{9}$/.test(pcid)) return pcid;
  return `${pcid.slice(0, 3)} ${pcid.slice(3, 6)} ${pcid.slice(6)}`;
}

export type PairChannel = 'standalone' | 'saas';

/** The QR payload's channel word for a machine channel tag (04 §3.1 L64). ONE
 *  mapping, so「哪条通道」("which channel") and「载荷里写什么」("what the payload
 *  says") can never disagree. */
export function pairChannelOf(tag: ChannelTag): PairChannel {
  return tag === 'cloud' ? 'saas' : 'standalone';
}

/** Why the QR is (not) shown — drives the modal's copy.
 *  `pending` = the snapshot on hand belongs to the other channel (N5). */
export type PairingReason = 'ok' | 'loopback' | 'no-code' | 'disconnected' | 'pending';

export interface PairingModalView {
  /** The 4-digit code to display big, or null when none is available yet. */
  code: string | null;
  /** The QR payload string to render, or null when the QR is suppressed. */
  qrPayload: string | null;
  /** True → render the loopback/short-code-only hint instead of a QR. */
  qrSuppressed: boolean;
  reason: PairingReason;
  /** 0.2.66 — the PCID to show above the code, RAW (nine digits, no grouping),
   *  or null on the LAN tab / an older relay / a snapshot from the other channel.
   *
   *  Raw because this is also the value the copy button puts on the clipboard: a
   *  spaced form typed into the phone's digits-only field would lose its spaces at
   *  best and be refused at worst. The view renders `formatPcid(view.pcid)`; it
   *  never copies what it rendered.
   *
   *  Carried on EVERY non-pending branch, including `no-code`: the PCID answers
   *  「这是哪台电脑」("which computer is this") and is true whether or not a code
   *  happens to be alive. */
  pcid: string | null;
}

/** Prefix a scheme so the URL parser can read a bare `host:port`. */
function withScheme(endpoint: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
}

/** Extract the host from an http(s)/ws(s)/bare endpoint; '' if unparseable. */
export function endpointHost(endpoint: string): string {
  const e = endpoint.trim();
  if (e === '') return '';
  try {
    return new URL(withScheme(e)).hostname;
  } catch {
    return '';
  }
}

/** A host reachable only from this machine — a QR carrying it is useless to a
 *  phone on the LAN, so the modal shows the code only (F-2346). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** True when the endpoint is loopback / wildcard / unparseable (→ suppress QR). */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const host = endpointHost(endpoint);
  return host === '' || isLoopbackHost(host);
}

/** Normalize any endpoint form to a ws(s):// URL for the QR payload. */
export function toWsUrl(endpoint: string): string {
  const e = endpoint.trim();
  if (/^wss:\/\//i.test(e)) return e;
  if (/^ws:\/\//i.test(e)) return e;
  if (/^https:\/\//i.test(e)) return `wss://${e.slice('https://'.length)}`;
  if (/^http:\/\//i.test(e)) return `ws://${e.slice('http://'.length)}`;
  return `ws://${e}`;
}

/** B4-15 — how many EXTRA addresses ride the QR beside the primary one.
 *
 *  A bound exists because the payload is a picture: every address is ~16 more
 *  characters, and a host with a stack of virtual NICs (VMware, Hyper-V, WSL,
 *  Docker) can offer eight. The QR still has to scan from a phone held in front
 *  of a monitor. Five extra covers every physical machine seen in this project
 *  (owner's has two); a machine that really has more still shows the FULL list
 *  as text in the modal, so nothing this drops is unreachable — it is just not
 *  automatic. NOT a silent truncation: the modal's address list is the
 *  companion to this cap and must stay next to it. */
export const QR_ALT_MAX = 5;

/** The `alt=` hosts for a QR: every OTHER address this host listens on, in the
 *  server's own order, capped at [QR_ALT_MAX].
 *
 *  Hosts only, not URLs. One sidecar means one port and one scheme, so the phone
 *  rebuilds each candidate from the primary endpoint — which also makes it
 *  impossible for an alternate to disagree with the primary about the port.
 *
 *  The endpoint's own host is dropped: it is already in `endpoint=`, and the
 *  phone puts that first by construction. */
export function qrAltHosts(endpoint: string, candidates?: readonly string[]): string[] {
  if (!candidates || candidates.length === 0) return [];
  const own = endpointHost(endpoint).toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>([own]);
  for (const raw of candidates) {
    const host = (raw ?? '').trim();
    // A comma would split one address into two on the phone; an empty string
    // would expand to a scheme-less URL. Both are refused rather than emitted
    // in a shape the parser has to guess about.
    if (host === '' || host.includes(',') || host.includes('&')) continue;
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(host);
    if (out.length >= QR_ALT_MAX) break;
  }
  return out;
}

/** D2-LAN — is this string safe to carry as a QR value?
 *
 *  ONLY the separator property is checked here, deliberately NOT the length or
 *  the alphabet. Those belong to the value's producer
 *  (`apps/server-core/src/lan-tls/fingerprint.ts`, symbol `spkiFingerprint`,
 *  which guarantees base64url with no padding), and re-stating them in a second
 *  package would be a copy that drifts the day FP_BYTES changes. What this file
 *  legitimately owns is the payload GRAMMAR: `,` splits an `alt=` list and `&`
 *  starts a new key, so either one silently turns one value into two. `qrAltHosts`
 *  above refuses exactly the same two characters for exactly this reason.
 *
 *  Whitespace is refused too: it cannot survive a URL round-trip intact and a
 *  fingerprint that compares unequal only because of a trailing space is the
 *  worst kind of pinning failure — the phone would be right to refuse, and no one
 *  would be able to see why. */
function isQrSafeValue(value: string): boolean {
  return value !== '' && !/[,&\s]/.test(value);
}

/** Build the exact QR payload (04 §3.1 L64). The endpoint is emitted as a raw
 *  ws-url (matching the legacy/spec literal form the mobile PairEntry parser
 *  reads back verbatim).
 *
 *  B4-15 — `alt=` is APPENDED LAST and is additive-optional: a phone that does
 *  not know the key still reads `endpoint`/`code`/`channel` exactly as before,
 *  and the SERVER never parses the payload beyond `/code=(\d{4})/` (the only
 *  place it is parsed rather than forwarded: `Registry.resolvePcForPair` in
 *  `apps/server-core/src/room/registry.ts`), so this needs no protocol change and
 *  no relay deploy. Last on purpose: that regex takes the FIRST match, so nothing
 *  appended after `code=` can ever be mistaken for the code.
 *
 *  ⚠️ ANCHOR IS A SYMBOL, NOT A LINE (DOC-HYG, 2026-08-09 【实测·dev-pc-b】,
 *  "[measured · dev-pc-b]").
 *  This cited `registry.ts:260`, and line 260 is `stampMachineUid` — a method that
 *  writes a machine uid onto a PC row and never touches a QR payload. The regex it
 *  meant is ~36 lines further down. The citation did not merely age: it had come to
 *  point at working code that plausibly belongs to this file's subject and answers
 *  a different question, which is the failure mode line numbers have and symbols
 *  do not. `coordinate-anchors` already carried this coordinate as a baselined
 *  debt («no anchor within ±3 lines»); dropping the `:NNN` clears it with no
 *  baseline edit, per that file's own header.
 *
 *  Why it exists: the desktop resolves ONE pairing endpoint and picks it by the
 *  server's ranking, which is a guess about which NIC the phone shares. On a
 *  machine with a LAN address and a VPN address it guessed the VPN three rounds
 *  running, and the phone had no way to learn the other one — a QR that scans
 *  and then cannot connect, with no path forward.
 *
 *  D2-LAN (design docs/strategy/2026-08-08-design-d2lan-light-encryption.md §4-1)
 *  — `fp=` is the SAME additive-optional trick, one key further along, and it is
 *  APPENDED AFTER `alt=` for the SAME reason `alt=` is appended after `code=`:
 *  `resolvePcForPair` takes the FIRST `/code=(\d{4})/` match, so every key added
 *  from here on must go behind it. A phone that does not know `fp` reads
 *  `endpoint`/`code`/`channel` byte-for-byte as before and keeps dialing `ws://`
 *  — the failure direction is 「退回现状」("fall back to the status quo"), never
 *  「连不上」("cannot connect").
 *
 *  🔴 What `fp=` is: the SHA-256 of the sidecar's TLS public key (SPKI), NOT of
 *  its certificate. The certificate can be renewed and the machine can change
 *  NICs without moving this value, which is what lets ONE fingerprint cover all
 *  six hosts a single QR can name (`alt=` + the phone's `expandCandidates`, which
 *  inherits scheme and port from the primary endpoint). Pinning the certificate
 *  instead would have required every one of those bare IPs in an IP SAN.
 *
 *  ⚠️ The producer arrived in card D2LAN-B2b — `PairingInfo.lan_tls_fp` names the
 *  whole chain.
 *
 *  🔴 THIS PARAGRAPH USED TO END 「What is still absent is the CONSUMER: the phone
 *  does not read `fp=` yet (card D2LAN-B3), so this key is currently written and
 *  read by nobody on the other end.」 That was true the day it was written and has
 *  been FALSE since `c4a5e94` (2026-08-09, 「the phone pins the LAN key the QR
 *  named」) — and nothing about the sentence changed on the day the consumer
 *  landed. That is 反 façade ④ in its purest form: a comment asserting behaviour
 *  in another app, whose truth moved while its text did not. The ordering it
 *  described (producer first, consumer second) did happen; it is simply finished.
 *
 *  The consumers now exist, and are named here so this claim is greppable rather
 *  than remembered — there are TWO readers of the same link, which is why one
 *  symbol would not have covered it:
 *    · `PairEntry.parse` — apps/mobile/lib/src/signaling/wire_payloads.dart.
 *      Reads `fp=` for the pairing frame and REJECTS the whole payload when it is
 *      malformed (`isWellFormedLanTlsFingerprint`), rather than silently pairing
 *      unpinned.
 *    · `qrFingerprint` / `qrDialCandidates` — apps/mobile/lib/src/session/
 *      endpoint_candidates.dart (`kQrFingerprintKey = 'fp'`). Reads the SAME link
 *      to build the dial list: with `fp=` present the primary endpoint is upgraded
 *      to `wss://` before expansion, so all six candidates inherit the secure
 *      scheme by the mechanism that already makes them inherit the port.
 *
 *  What is still true is the sentence above: a phone that does not know `fp`
 *  reads `endpoint`/`code`/`channel` byte-for-byte as before.
 *
 *  0.2.66 — `pcid=` is the THIRD key on that same append-only list and goes at the
 *  very END, behind `fp=`, for the reason the paragraph above gives twice: the
 *  server reads the code with the FIRST `/code=(\d{4})/` match, so a nine-digit
 *  run added anywhere ahead of `code=` could be read as the code. It is the mirror
 *  image of `alt=`/`fp=` in channel terms — those are LAN-only, this one is
 *  relay-only (owner 2026-08-14) — so in production the two never co-occur; the
 *  ORDER still has to hold, because the rule is structural and not statistical.
 *
 *  ⚠️ THE CHANNEL GATE IS THE CALLER'S, exactly as it is for `fp`/`alt`
 *  (`derivePairingModal` below). Kept that way deliberately rather than re-checked
 *  here: one gate per fact means a reverse control can actually see it fail. */
export function buildQrPayload(opts: {
  endpoint: string;
  code: string;
  channel?: PairChannel;
  /** Every LAN IPv4 this host listens on (`PairingInfo.lan_candidates`). */
  candidates?: readonly string[];
  /** D2-LAN: the sidecar's SPKI fingerprint. Absent/blank → no `fp=` at all, and
   *  the payload is byte-identical to the pre-D2-LAN one. */
  fingerprint?: string | null;
  /** 0.2.66: the relay's PCID for this PC. Absent/blank → no `pcid=` at all, and
   *  the payload is byte-identical to the pre-0.2.66 one. */
  pcid?: string | null;
}): string {
  const ws = toWsUrl(opts.endpoint);
  const channel = opts.channel ?? 'standalone';
  const alt = qrAltHosts(opts.endpoint, opts.candidates);
  const altPart = alt.length > 0 ? `&alt=${alt.join(',')}` : '';
  // A fingerprint that cannot be carried intact is DROPPED, not emitted broken:
  // a truncated/split pin makes the phone refuse a server that is in fact the
  // right one, whereas a missing pin falls back to today's plain connection.
  // Between a false alarm and a known-honest downgrade, the downgrade is the one
  // the user can act on — and the phone still shows which of the two it got
  // (design §4-4: 扫码=已验证 / 手输=未验证 ["scanned=verified / typed=unverified"]
  // must never share one badge).
  const fp = (opts.fingerprint ?? '').trim();
  const fpPart = isQrSafeValue(fp) ? `&fp=${fp}` : '';
  // 0.2.66 — same filter, same reason: a value carrying `&` or `,` would silently
  // become two keys on the phone, and a PCID split in half addresses no PC at all.
  // Dropped rather than emitted broken — the relay then answers PAIR_PCID_REQUIRED,
  // which is a sentence the user can act on, instead of PAIR_PCID_UNKNOWN, which
  // sends them off to check a number that was right on the screen.
  const pcid = (opts.pcid ?? '').trim();
  const pcidPart = isQrSafeValue(pcid) ? `&pcid=${pcid}` : '';
  return `flowmic://pair?endpoint=${ws}&code=${opts.code}&channel=${channel}${altPart}${fpPart}${pcidPart}`;
}

/** B4-15 — what the modal prints beside the QR so the MANUAL path is possible.
 *
 *  owner 2026-08-01 (真机截图, "real-device screenshot"): the phone's manual-entry
 *  tab showed a single
 *  `ws://10.0.0.78:41879` and offered nothing else, so a user whose phone
 *  cannot reach that NIC had no address to type. The QR now carries the
 *  alternates for the phone to pick automatically — this is the same fact for
 *  the HUMAN, because a QR is unreadable to someone typing into a phone.
 *
 *  `dropped` is the anti-silent-truncation half: addresses past [QR_ALT_MAX] are
 *  NOT in the picture, and the modal has to say so rather than let a machine
 *  with nine NICs look fully covered. */
export interface PairAddressView {
  /** The host the QR's `endpoint=` carries. '' when the endpoint is unparseable. */
  primary: string;
  /** The other addresses this host listens on, in the server's order. */
  others: string[];
  /** Those of `others` that did not fit in the QR — typing them is the only way. */
  dropped: string[];
}

export function derivePairAddresses(endpoint: string, candidates?: readonly string[]): PairAddressView {
  const primary = endpointHost(endpoint);
  const others: string[] = [];
  const seen = new Set<string>([primary.toLowerCase()]);
  for (const raw of candidates ?? []) {
    const host = (raw ?? '').trim();
    if (host === '') continue;
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    others.push(host);
  }
  // Derived from the SAME function the payload uses, so 「哪些进了码」("which ones
  // made it into the code") can never be computed twice with two answers.
  const inQr = new Set(qrAltHosts(endpoint, candidates).map((h) => h.toLowerCase()));
  return { primary, others, dropped: others.filter((h) => !inQr.has(h.toLowerCase())) };
}

/** Why the cloud option cannot be offered at all (machine tag), N5 ③.
 *  Deliberately NOT a UI string: the component maps these onto the copy the device
 *  page already uses for the same three facts, so there is one wording per fact. */
export type PairBlock = 'rejected' | 'no-endpoint' | 'no-key';

/** Can the phone be paired over the cloud relay right now? `null` = yes.
 *
 *  The red line (N5 ③): without a usable Cloud Key there is no relay session, so
 *  there is no code and no account to join — the option is disabled WITH ITS REASON
 *  rather than handed a QR that cannot possibly scan.
 *
 *  Priority: an explicit refusal first (a key the relay rejected needs re-pasting,
 *  not an endpoint), then「没登录」("not logged in"), then「没地址」("no address").
 *  That is deliberately NOT Rust `CloudConfig::readiness`'s order, which puts
 *  NoEndpoint above NoKey: a fresh install has neither, and telling that user
 *  「尚未填写中继地址」("the relay address has not been filled in yet") points
 *  them at a box the device page pre-fills for them. `cloudLoudReason` already
 *  made the same
 *  judgement (it suppresses the no-endpoint line entirely while no key is set), so
 *  this keeps one story rather than adding a second. */
export function cloudPairBlock(input: {
  keySet: boolean;
  endpoint: string;
  readiness: CloudReadiness;
}): PairBlock | null {
  const { keySet, endpoint, readiness } = input;
  if (readiness === 'rejected' || readiness === 'key_expired') return 'rejected';
  if (readiness === 'no_key' || !keySet) return 'no-key';
  if (readiness === 'no_endpoint' || endpoint.trim() === '') return 'no-endpoint';
  return null;
}

/** Which channel the modal OPENS on: the active one — unless that is a cloud
 *  channel that cannot pair, in which case LAN. `cloud_clear_key` keeps the cloud
 *  channel selected while logged out (deliberately, T-2 ⑤), so without this the
 *  modal would open on its own disabled tab and show nothing at all. */
export function initialPairTab(active: ChannelTag, cloudBlocked: boolean): ChannelTag {
  return active === 'cloud' && cloudBlocked ? 'lan' : active;
}

/** Derive the whole modal state from a pairing snapshot. This is the tested
 *  decision core: pending / disconnected / no-code / loopback all suppress the QR;
 *  only a connected, coded, LAN-reachable endpoint on the SELECTED channel renders
 *  one. */
export function derivePairingModal(info: PairingInfo, channel: PairChannel = 'standalone'): PairingModalView {
  // N5 — first gate, because a snapshot from the other channel answers none of the
  // questions below: its `connected` is that channel's link, its code was minted by
  // that channel's server. Nothing (not even the big code) is drawn from it.
  if (info.channel !== undefined && pairChannelOf(info.channel) !== channel) {
    return { code: null, qrPayload: null, qrSuppressed: true, reason: 'pending', pcid: null };
  }
  // 0.2.66 — THE PCID GATE, and the only one on this side. owner 2026-08-14:「本地
  // 局域网……没有 PCID」("the local LAN … has no PCID"). Computed once, above the
  // branches, because it feeds two
  // different surfaces (the modal's own row and the QR's `pcid=`) and those must
  // not be able to disagree about whether this channel has one. Rust blanks it too
  // (`shell/connection.rs`, symbol `pcid_for_channel`) — two gates, same reason the
  // fingerprint has two: that snapshot is a public command result, and only this
  // function knows which tab is on screen.
  const pcid = channel === 'saas' ? info.pcid ?? null : null;
  if (!info.connected) {
    return { code: info.short_code, qrPayload: null, qrSuppressed: true, reason: 'disconnected', pcid };
  }
  if (!info.short_code) {
    // No code, but the PCID still answers 「这是哪台电脑」("which computer is
    // this") — it is not derived from the code and does not expire with it.
    return { code: null, qrPayload: null, qrSuppressed: true, reason: 'no-code', pcid };
  }
  if (isLoopbackEndpoint(info.endpoint)) {
    return { code: info.short_code, qrPayload: null, qrSuppressed: true, reason: 'loopback', pcid };
  }
  return {
    code: info.short_code,
    pcid,
    qrPayload: buildQrPayload({
      endpoint: info.endpoint,
      code: info.short_code,
      channel,
      // B4-15 — LAN ONLY. On the relay there is exactly one address the phone can
      // dial and a local NIC is not a pairing destination at all (Rust already
      // sends an empty list there — `connection.rs:219`); offering one would tell
      // the phone to try reaching this machine directly, which is the opposite of
      // what choosing the cloud channel means.
      //
      // D2-LAN — the fingerprint is LAN ONLY for a second, independent reason:
      // the cloud relay is reached over real `https://flowmic.app` with a real
      // CA chain, so a self-signed pin there would be answering a question that
      // channel does not ask. Same guard, two reasons, one condition.
      ...(channel === 'standalone'
        ? { candidates: info.lan_candidates, ...(info.lan_tls_fp ? { fingerprint: info.lan_tls_fp } : {}) }
        : {}),
      // 0.2.66 — the same conditional spread in the OTHER direction, from the one
      // `pcid` computed above: whatever the modal renders as this PC's id is exactly
      // what the QR tells the phone to address, and the LAN payload keeps its bytes.
      ...(pcid ? { pcid } : {}),
    }),
    qrSuppressed: false,
    reason: 'ok',
  };
}
