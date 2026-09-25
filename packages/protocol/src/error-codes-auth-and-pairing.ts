import type { ErrorMessage } from './error-code-types';

export const AUTH_AND_PAIRING_ERROR_CODES = {
  // Authentication / pairing
  AUTH_TOKEN_INVALID:        { zh_CN: '配对凭证已失效，请重新配对。',                en: 'Token invalid, please pair again.' },
  AUTH_TOKEN_EXPIRED:        { zh_CN: '登录已过期，请重新登录。',              en: 'Sign-in expired, please sign in again.' },
  AUTH_LOGIN_FAILED:         { zh_CN: '邮箱或密码不正确。',                    en: 'Email or password incorrect.' },
  // AUTH_USE_REST_LOGIN retired 2026-09-02 (WP-8 registry hygiene) — see the
  // "75 → 69" note near EXPECTED_ERROR_CODE_COUNT for why.
  //
  // ── 🔴 79 → 80 · NR-18's REMAINING HALF. owner approved 2026-09-15. ────────
  //
  // 「NO ACCOUNT WAS PRESENTED」 IS NOT 「THE ACCOUNT WE WERE GIVEN IS BAD」, and
  // until this entry existed those two facts left the server as one code.
  // `socket/acting-identity.ts` (2026-09-15) split the three credential states
  // apart — 'absent' / 'rejected' / 'expired' — and 'absent' had nowhere
  // truthful to go, so it borrowed AUTH_TOKEN_INVALID. This is the code it was
  // waiting for; the switch points here in the companion auth commit.
  //
  // 🔴 WHY EVERY REGISTERED NEIGHBOUR LIES HERE, one by one, because "close
  // enough" is how this table grew its two-questions-one-answer entries:
  //   · AUTH_TOKEN_INVALID  — 「配对凭证已失效，请重新配对。」 sends a caller who
  //     has never signed in off to redo a pairing. On `pc:register` the pairing
  //     IS the verb that just failed, so the sentence names the one action that
  //     cannot work. It also makes both clients DELETE a stored credential
  //     (mobile_reconnect_flow.dart, socket/pairing.rs) that was never presented.
  //   · AUTH_TOKEN_EXPIRED  — asserts a session existed and ran out. None did.
  //   · AUTH_TOKEN_UNVERIFIABLE — answers 「we could not ask」. We could; there
  //     was nothing to ask about.
  //   · PC_HANDSHAKE_PENDING — answers 「the ack for this socket has not landed
  //     yet」, a race. Nothing is racing; the caller simply has no account.
  //
  // 🔴 THE SENTENCE NAMES NO SCREEN, ON PURPOSE. It is read on two surfaces that
  // sign in differently — the desktop device page's cloud card (the refusal
  // rides the `pc:register` ack) and the phone's connections page (it rides the
  // `mobile:pair {cloud_instance}` ack) — so naming a button would make the
  // sentence false on the other one. Precedent: the ACCOUNT_RESTRICTED arm in
  // pairing_strings.dart, which names nothing for the same reason.
  //
  // ⚠️ IT CLAIMS NOTHING WAS REFUSED, and that is the whole point: nothing was
  // refused, nothing was presented. A forged or malformed credential keeps
  // AUTH_TOKEN_INVALID and must keep it — the two are not to be merged back by
  // "simplifying" either sentence.
  //
  // COPY PROVENANCE: both sentences were written by gemini-3.8-flash-high
  // through the repo's rewrite pipeline (owner ruling 2026-09-01, items 1-3 —
  // the executor does not type user-visible copy), fed the screens grepped
  // above, the condition that reaches the string, and the neighbouring entries
  // in this table; then reviewed by an independent second call (human /
  // register / meaning / safe, all true) and audited by
  // `pnpm copy:audit -- --key AUTH_ACCOUNT_REQUIRED --gate`.
  //
  // ⚠️ NO CLIENT PATH REACHES IT TODAY — measured, not assumed: the desktop
  // dials the relay only under `CloudReadiness::Ready` (which requires a key)
  // and `ConnectionsController.enterCloud` refuses locally with NOT_LOGGED_IN
  // before it dials. That is why shipping the lie was cheap, and why this is a
  // correctness fix rather than a user-visible one. ⚠️ AND THE DAY A CLIENT CAN
  // REACH IT, the phone's own table owes this code an arm:
  // `cloud_strings.dart` `cloudError` falls through to `pairError`, whose
  // `default:` renders 「配对失败，请检查网络后重试 · 诊断码 <CODE>」 — the raw
  // identifier plus an instruction that cannot help (the 0.2.53 shape). Recorded
  // in the ledger rather than patched here, because an arm for a code no path
  // can deliver is the façade this file has deleted entries for twice.
  AUTH_ACCOUNT_REQUIRED:     { zh_CN: '未登录账号，请先登录。',                en: 'Sign in to continue.' },
  // F-2327 (SB-3): per-IP registration throttle. Too many sign-ups from one IP
  // inside the window -> 429 (a throwaway-account farm mints unbounded free quota).
  REGISTER_RATE_LIMITED:     { zh_CN: '注册过于频繁，请稍后再试。',            en: 'Too many sign-ups from this network, please try again later.' },
  // 64 → 65. owner approved on 2026-08-10 (ruling group #5-d). A sign-up was refused
  // because the EMAIL STRING is not a legal address. Producer lands with card
  // fix-023 (`apps/server-core/src/auth/auth-service.ts`).
  //
  // 🔴 WHY NOT SETTINGS_SCHEMA_INVALID, which is what that path borrows today:
  // it renders 「设置内容不合法」 to somebody who is not in settings and has not
  // touched a setting — they are registering. The underlying fact ("your payload
  // did not validate") is true and the SENTENCE is false, which is the 0.2.18
  // PC_BUSY reuse again: the user is pointed at a screen they are not on, so
  // there is no action they can take that helps.
  //
  // ⚠️ IT SAYS NOTHING ABOUT WHETHER AN ACCOUNT EXISTS, and that is load-bearing
  // rather than incidental. `auth-service.ts` deliberately makes an unknown email
  // cost the same as a wrong password (a scrypt verify against a fixed dummy
  // hash) so neither timing nor copy is an enumeration oracle. Malformed is a
  // property of the STRING alone, so this refusal may be fast and specific
  // without leaking anything — but the copy must never grow a clause about the
  // account, and fix-023 is required to state what a caller can learn before and
  // after it lands.
  REGISTER_EMAIL_INVALID:    { zh_CN: '邮箱地址格式不正确，请检查后重新填写。',  en: 'This email address is not in a valid format — check it and try again.' },
  PAIR_INVALID_CODE:         { zh_CN: '配对码无效。',                          en: 'Invalid pairing code.' },
  PAIR_INVALID_PAYLOAD:      { zh_CN: '配对数据无效，请重新扫描二维码或重新输入配对码。', en: 'Invalid pairing payload; please rescan the QR code or re-enter the code.' },
  PAIR_EXPIRED_CODE:         { zh_CN: '配对码已过期，请刷新。',                en: 'Pairing code expired, please refresh.' },
  PAIR_PC_OFFLINE:           { zh_CN: '电脑离线，无法配对。',                  en: 'PC is offline, cannot pair.' },
  // PC_MOBILE_SLOT_BUSY and PAIR_NOT_CONNECTED retired 2026-09-02 (WP-8
  // registry hygiene) — see the "75 → 69" note near EXPECTED_ERROR_CODE_COUNT.
  // WP-R23-1: 4-digit-code brute-force guard. The code space is only 10^4, so an
  // unthrottled mobile:pair spray cracks the ACTIVE code within its 5-min TTL in
  // seconds. Per-socket exponential backoff (after 5 consecutive misses) + a
  // per-IP sliding-window cap reject further attempts with THIS code — an honest,
  // distinct signal (never masquerading as PAIR_INVALID_CODE). Additive, in-memory
  // only (0.1.0 single instance — no DB/schema touched).
  PAIR_RATE_LIMITED:         { zh_CN: '配对尝试过于频繁，请稍后再试。',            en: 'Too many pairing attempts, please try again later.' },
  // GA-08: the PC pressed 「断开」. The pairing is still VALID — only this
  // session ended — so a mobile:reconnect inside the 60 s suppression window is
  // refused with THIS code and not AUTH_TOKEN_INVALID: the mobile's ladder treats
  // an unknown code as transient (keeps the token, backs off, returns when the
  // window lapses), while AUTH_TOKEN_INVALID would wipe the pairing the user
  // never revoked. Distinct from PAIR_RATE_LIMITED (a brute-force verdict about
  // the caller) — this is a deliberate, operator-initiated pause.
  PAIR_RELEASED:             { zh_CN: '电脑已主动断开与本手机的连接，请稍后再试。',      en: 'The PC just disconnected this phone; please reconnect in a moment.' },
  // GA-29: the PC keeps BOTH channels resident (07 §6) but the capsule admits
  // exactly ONE phone at a time — and only the PC can see both channels, so only
  // the PC can decide. A second phone is refused with THIS code rather than being
  // left recording into a capsule that will never show it. Deliberately separate
  // from PAIR_RELEASED: nothing about this pairing is wrong and no operator
  // pressed anything, so the hold-out window is seconds, not a minute.
  PC_BUSY:                   { zh_CN: '这台电脑正被另一台手机占用。请先在那台手机上退出转录页，再从这里连接。', en: 'Another phone is using this PC. Leave the transcription page on that phone first, then connect from here.' },
  // ── 74 → 75, owner approved 2026-09-01 ───────────────────────────────────────
  // Producer apps/server-core/src/socket/handlers/pc.handler.ts `pc:list-mobiles`
  //          (the `!auth` branch only; the second branch keeps AUTH_TOKEN_INVALID)
  //
  // A socket that has connected but has not yet had its `pc:register` /
  // `pc:reconnect` ack land carries no pairing identity, so an identity-required
  // verb cannot be served. That is a fact about TIMING, not about a credential.
  //
  // 🔴 WHY AUTH_TOKEN_INVALID WAS A LIE HERE, MEASURED. Its registered sentence
  // is 「令牌无效，请重新配对」 — and on this branch the token is perfectly valid
  // and about to be accepted. Forensic from dev-pc-a (four occurrences,
  // 2026-08-30 → 2026-09-01) shows the `pc:reconnect` ack landing 56–335 ms AFTER
  // this refusal every single time. The desktop read the code as an ACCOUNT
  // verdict and deleted the user's Cloud Key, so a healthy session logged itself
  // out on a race — the repo's #1 shape (one value answering two questions) with
  // a credential on the line. The reciprocal desktop fix (a device-page verb may
  // never drop the key) lands in the same round; either half alone stops the
  // logout, which is why neither deploy order can regress.
  //
  // WHY NOT A NEIGHBOUR — each sends the user to an action that cannot help:
  //   · AUTH_TOKEN_INVALID / AUTH_TOKEN_EXPIRED — both assert the credential is
  //     bad. Re-pairing or signing in again "fixes" nothing, and the second one
  //     also makes the desktop drop a key that was never refused;
  //   · PAIR_RATE_LIMITED — invents a verdict about the caller's behaviour;
  //   · PC_BUSY / PAIR_RELEASED — both invent an ACTOR. Nobody did anything here.
  //
  // The copy names the one action that genuinely works (wait a moment, ask
  // again) and says nothing about handshakes, sockets or acks — the user never
  // chose our connection model and owes us no picture of it (owner 2026-08-22).
  // 20 characters, inside the phone's 28-char raw-code cell (0.2.53).
  PC_HANDSHAKE_PENDING:      { zh_CN: '连接还没准备好，请稍后再试。',              en: 'The connection is not ready yet, please try again in a moment.' },
  // ── AUTH_TOKEN_UNVERIFIABLE · 2026-09-02 (WP-8, A11/F2-a) ────────────────────
  //
  // The multi-node relay (2026-08-29 design) has a token this REPLICA cannot
  // find locally, and it could not get a definitive answer from the writer
  // either — the writer was unreachable, the read-through budget was spent,
  // or the writer's own rows would not land on this node yet
  // (`node/token-read-through.ts` `askAndApply`). Every one of those was
  // previously folded into `AUTH_TOKEN_INVALID` by `auth/middleware.ts` and
  // `mobile.handler.ts`'s `mobile:reconnect`, and BOTH the phone
  // (`mobile_reconnect_flow.dart`) and the desktop (`socket/pairing.rs`)
  // treat that code as "this credential is dead, delete it" — a healthy
  // pairing minted seconds ago on the writer gets wiped on a node that simply
  // has not heard about it yet.
  //
  // WHY NOT AUTH_TOKEN_INVALID — that code means "asked, and the answer is
  // no" (`token-read-through.ts`'s own words: "the writer IS the authority").
  // This code means "could not ask, or could not hear back" — a materially
  // different claim, because only the first one licenses deleting a
  // credential the user never revoked.
  //
  // WHY NOT PC_HANDSHAKE_PENDING (the code directly above, same family of
  // defect) — that one answers "the ack for THIS socket has not landed yet"
  // (an identity-required verb racing its own connection's register/reconnect
  // ack). This one answers "a different machine could not confirm this token
  // right now" — same shape (a race mistaken for a verdict), different actor,
  // and PC_HANDSHAKE_PENDING's producer (pc.handler.ts) has no reason to ever
  // emit this one instead.
  //
  // Retryable, and the copy says so: nothing the user does helps beyond
  // waiting for the next attempt — same "no imperative because there is
  // nothing to imperative about" shape as NODE_IS_REPLICA and
  // PC_HANDSHAKE_PENDING.
  AUTH_TOKEN_UNVERIFIABLE:   { zh_CN: '暂时无法确认此连接，请稍后再试。', en: 'Could not confirm this connection just now — please try again shortly.' },
  // ── PCID addressing (0.2.66) · 69 → 71, owner approved 2026-08-14 ────────────
  // Ruling   docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md
  // Design   docs/strategy/…-0266-cloud-pcid-pairing-design.md §5.3 — the full
  //          「why not a neighbour」 argument and the security account live there
  // Producer apps/server-core/src/room/registry.ts `resolvePcByPcid` (saas only;
  //          there is no PCID on the LAN)
  //
  // PCID splits ADDRESSING (public, 9 digits, stable) from the SECRET (the same
  // 4-digit, 5-minute, 20-guess code). Neither may borrow PAIR_INVALID_PAYLOAD
  // (claims a malformed frame; it is well-formed, and 「rescan」 is half the cure)
  // nor PAIR_INVALID_CODE (a claim about the CODE, which here may be perfectly
  // correct) — one value answering two questions is this repo's #1 defect shape.
  // 🔴 REQUIRED is the one refusal here a USER CAN FIX, so it names both actions;
  // it is also the phone's signal to FORCE its PCID field visible when its own
  // endpoint guess was wrong (apps/mobile/lib/src/ui/add_pairing_sheet.dart).
  PAIR_PCID_REQUIRED:        { zh_CN: '云端配对需要电脑的 PCID。请扫描电脑上的二维码，或输入电脑上显示的 PCID。', en: 'Cloud pairing needs this PC\'s PCID. Scan the QR code on the PC, or type the PCID it shows.' },
  // UNKNOWN folds 「malformed」 and 「no such PC」 together on purpose: one action
  // fixes both. ⚠️ It IS an existence oracle over the PCID space, ACCEPTED because
  // a PCID is public addressing — contrast '0000' in registry.ts, a secret.
  PAIR_PCID_UNKNOWN:         { zh_CN: 'PCID 没有对应的电脑，请核对电脑上显示的 PCID。', en: 'No PC matches that PCID — check the PCID shown on the PC.' },

  // LAN transport security
  // 65 → 66. owner approved on 2026-08-10 (ruling group #5-e). The phone dialled a PC on
  // the LAN and the TLS certificate it presented does not match the fingerprint
  // pinned when the two were paired, so the connection was refused. The surface
  // lands with card fix-024 (`apps/mobile/lib/src/signaling/lan_pinning.dart`,
  // whose `lastDialPinMismatch` already knows the difference internally).
  //
  // 🔴 TODAY THE USER IS TOLD NOTHING AT ALL — tapping the instance looks like it
  // did nothing, and the only trace is `CERTIFICATE_VERIFY_FAILED` in logcat
  // (real-device measured, ledger row W8-1). That is 没有静默失败 in its first
  // direction, and it is the expensive kind: a SOLVABLE problem (re-scan the QR
  // and pair again) turned UNSOLVABLE by silence.
  //
  // 🔴 WHY NOT ANY 「连不上」 WORDING, which is the obvious fold: the two send the
  // user to opposite places. 「连不上」 means go and check the network — and the
  // network is fine here; we reached that PC, spoke to it, and refused what it
  // presented. Folding them buys one word and spends the only action that works.
  //
  // ⚠️ THE COPY MUST NOT OFFER 「仍要连接」. A pin mismatch is the one signal that
  // the pinning is doing its job, and an override turns a working defence into a
  // prompt people click through; fix-024 carries that as a red line and this
  // sentence is written to match it — the only action it names is pairing again.
  // LAN_CERT_PIN_MISMATCH retired 2026-09-02 (WP-8 registry hygiene). This was
  // one of the four 2026-08-10 codes registered ahead of its producer, under a
  // rule written down verbatim at the time: "if the wave ships without a
  // code's producer, that code goes with it." Its three siblings
  // (REGISTER_EMAIL_INVALID / STT_NO_ENGINE_REACHED / PC_IMAGE_STORE_FAILED)
  // all landed producers within weeks; this one never did (grepped three ends
  // 2026-09-02: only error-codes.ts, inject-verdict-authorship.ts and this
  // round's own tests referenced the name — zero call sites in
  // apps/server-core, apps/desktop or apps/mobile). See the "75 → 69" note
  // near EXPECTED_ERROR_CODE_COUNT.

} as const satisfies Record<string, ErrorMessage>;
