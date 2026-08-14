// SPEC-REF:
//   docs/decisions/2026-08-12-owner-needle-closure-and-default-authority.md
//     §Stamp Q2 (owner: 「枚举原因给用户；运营自由文本只进审计」)
//   docs/strategy/2026-08-12-a2-3-restricted-use-design.md §6 (the four-language
//     copy rules: no 「封/ban/suspend」, no promise anyone will reply, no
//     imperative for an action that does not exist)
//   docs/legal/terms-of-service.md 「We will tell you why unless the law
//     prevents us」 — the promise this file makes keepable
//   src/auth/account-restriction.ts (server) — what a restriction IS
//
// WHY A CLOSED SET OF REASONS EXISTS AT ALL.
//
// The Terms already promise a restricted user will be told WHY. The restriction
// route already requires the operator to type a `reason` — but that string is
// an OPERATOR'S NOTE: it is free text written for an audit trail, in one
// language, possibly naming another user, an internal ticket, or a suspicion. It
// answers 「我们内部为什么这么做」. Handing it to the account holder would be
// answering a user-facing question with an internal artefact — this repo's
// number-one shape wearing a text field.
//
// So there are TWO values, and they answer two questions:
//   · `RestrictionReason` (this file) — the ENUMERATED, translatable, publishable
//     reason the USER is shown;
//   · the operator's free text — audit row only, and it never crosses to a user
//     surface. `test/account-restriction.test.ts` asserts that with a canary
//     string that IS in the audit row and is NOT in any refusal body.
//
// 🔴 WHY THE WIRE CARRIES THE KEY AND NEVER THE SENTENCE. The four-language copy
// below is the SOURCE OF TRUTH for what each reason means, but a server that
// shipped a rendered sentence would be choosing the reader's language — and this
// product's rule is 「UI 不跟随 OS locale」 (CLAUDE.md 红线), i.e. the CLIENT owns
// that choice. So `publicUser.restricted_reason` and the refusal frames carry
// `RestrictionReason`, a stable identifier, and each client renders it from its
// own table.
//
// ⚠️ THIS FILE IS THE SERVER HALF. The phone does not read TypeScript: its copy
// lives in `apps/mobile/lib/src/settings/strings/*` and has to be mirrored by
// hand, which is the exact gap CLAUDE.md records as 「仍然开着的根因」 for error
// codes (「没有任何机制把协议注册表与手机那张表绑在一起」). Naming it here does not
// close it — the mobile/web display half is REMAINING WORK, reported by name.
//
// ⚠️ NOT `ERROR_CODES`, and deliberately not. A reason is not a refusal: the
// refusal is `ACCOUNT_RESTRICTED` (one code, already registered), and these are
// values that ride ALONGSIDE it. Minting five error codes for one refusal would
// grow the code table by five for a distinction no client dispatches on, and
// every one of them would land in the 28-character name budget that exists
// because code names reach the screen. The count guard and the i18n lint both
// scan `error-codes.ts` only; this file carries its own guard
// (`packages/protocol/test/restriction-reasons.test.ts`), which is stricter —
// it demands FOUR languages, not two.

/**
 * Every reason an account may be shown for its own restriction.
 *
 * 🔴 CLOSED, AND SMALL ON PURPOSE. Each entry has to be a sentence we are
 * willing to publish, in four languages, to the person it is about — that is a
 * much higher bar than an operator's note, and it is why this list is not a
 * catalogue of everything that can go wrong. When none of these fits, the honest
 * choice is `other`: 「we restricted this account after a review」 is a true and
 * complete statement, and it is far better than picking a neighbouring reason
 * that says something slightly false about a real person.
 */
export const RESTRICTION_REASONS = {
  /**
   * Use that breaches the Terms — the ordinary case, and the one the Terms'
   * own 「causing harm to the Service or to others」 sentence describes.
   */
  terms_violation: {
    zh_CN: '这个账号的使用方式违反了服务条款。',
    en: 'This account was used in a way that breaches the Terms of Service.',
    ja: 'このアカウントの利用方法が利用規約に違反していました。',
    ko: '이 계정의 사용 방식이 서비스 약관을 위반했습니다.',
  },
  /**
   * Automated or bulk use far beyond what the product is for. Kept apart from
   * `terms_violation` because the two are heard completely differently: this one
   * says 「你用得太猛」, that one says 「你做了不该做的事」, and telling somebody the
   * wrong one of those is a real harm even though both end in a restriction.
   */
  automated_or_bulk_use: {
    zh_CN: '这个账号出现了自动化或超出正常使用范围的大量请求。',
    en: 'This account showed automated or bulk activity beyond normal use.',
    ja: 'このアカウントで、自動化された、または通常の利用を超える大量のリクエストが確認されました。',
    ko: '이 계정에서 자동화된 요청 또는 정상적인 사용 범위를 넘는 대량 요청이 확인되었습니다.',
  },
  /**
   * The account itself looks compromised or is being used by somebody other than
   * its owner. 🔴 The one reason on this list where the restriction is FOR the
   * account holder rather than against them, which is why it does not share
   * copy with anything above it.
   */
  account_security: {
    zh_CN: '为保护账号安全，这个账号已被限制使用。',
    en: 'This account was restricted to protect its security.',
    ja: 'アカウントの安全を保護するため、このアカウントの利用を制限しました。',
    ko: '계정 보안을 보호하기 위해 이 계정의 사용을 제한했습니다.',
  },
  /**
   * A legal or regulatory requirement. Deliberately says nothing about WHICH
   * one: the Terms' promise is 「we will tell you why UNLESS THE LAW PREVENTS
   * US」, and this value is how that exception is expressed without pretending
   * no reason exists.
   */
  legal_requirement: {
    zh_CN: '出于法律或合规要求，这个账号已被限制使用。',
    en: 'This account was restricted to meet a legal or regulatory requirement.',
    ja: '法令上または規制上の要請により、このアカウントの利用を制限しました。',
    ko: '법률 또는 규제 요건에 따라 이 계정의 사용을 제한했습니다.',
  },
  /**
   * None of the above. 🔴 NOT A FALLBACK THE CODE PICKS — an operator chooses it
   * deliberately, and it is honest: it says a human reviewed the account and
   * decided, which is exactly what happened. A list with no `other` forces the
   * operator to file a real case under a wrong label, and the wrong label is
   * what the user reads.
   */
  other: {
    zh_CN: '经审核，这个账号已被限制使用。',
    en: 'This account was restricted following a review.',
    ja: '審査の結果、このアカウントの利用を制限しました。',
    ko: '검토 결과 이 계정의 사용을 제한했습니다.',
  },
} as const;

/** The reason keys, as a type. A value outside this set is unrepresentable —
 *  which is what makes 「运营随手写的一句话跑到用户屏幕上」 a compile error rather
 *  than a review comment. */
export type RestrictionReason = keyof typeof RESTRICTION_REASONS;

/** The keys as a runtime array, for the write route's validation and for the
 *  guard test. Derived from the table rather than re-typed: two hand-written
 *  lists is how one of them gains a member. */
export const RESTRICTION_REASON_KEYS = Object.keys(RESTRICTION_REASONS) as RestrictionReason[];

/**
 * 「这个串是不是一个合法的限制原因」 — the ONE conversion from an untrusted string
 * to the type.
 *
 * Used by the ops write route on a body field. It is a real membership test and
 * not a cast: a hand-written type predicate that merely asserts is an assertion
 * the compiler does not check (13 册 §7 F1 ⑤ — the `asPairingInfo` account).
 */
export function isRestrictionReason(v: unknown): v is RestrictionReason {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RESTRICTION_REASONS, v);
}
