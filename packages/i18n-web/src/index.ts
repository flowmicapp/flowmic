// @flowmic/i18n-web — the message subset the browser clients render.
//
// Everything under `generated/` is produced by scripts/i18n/gen-i18n-web.mjs from
// i18n/web/subset.json (which keys) x i18n/mobile/<locale>.json (what they say).
// This file is the only hand-written source in the package, and it deliberately
// contains no sentences: a string typed here would be exactly the second copy the
// generator exists to prevent.

export { WEB_LOCALES, DEFAULT_WEB_LOCALE, BASE_WEB_LOCALE } from './generated/locales.js';
export type { WebLocaleCode } from './generated/locales.js';
export { MESSAGE_PARAMS } from './generated/keys.js';
export type { WebMessageKey, WebMessages } from './generated/keys.js';
export { MESSAGES } from './generated/catalogue.js';

import { MESSAGES } from './generated/catalogue.js';
import { MESSAGE_PARAMS } from './generated/keys.js';
import type { WebMessageKey } from './generated/keys.js';
import { BASE_WEB_LOCALE, WEB_LOCALES } from './generated/locales.js';
import type { WebLocaleCode } from './generated/locales.js';

/** Whether `value` is one of the nine codes this catalogue carries.
 *
 *  A hand-written type predicate is a claim the compiler does not check
 *  (anti-facade (5)), so this one is written as a lookup in the generated table
 *  rather than as a list repeated here. */
export function isWebLocaleCode(value: unknown): value is WebLocaleCode {
  return typeof value === 'string' && WEB_LOCALES.some((row) => row.code === value);
}

/** The placeholder names one message takes — `never` when it takes none. */
export type MessageParamsOf<K extends WebMessageKey> = (typeof MESSAGE_PARAMS)[K][number];

/** Nothing to pass for a hole-free sentence; an exact-keyed object otherwise. */
type FormatArgs<K extends WebMessageKey> = [MessageParamsOf<K>] extends [never]
  ? []
  : [params: Readonly<Record<MessageParamsOf<K>, string | number>>];

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Render one message.
 *
 * The parameter object is required exactly when the sentence has holes, and its
 * keys must be that sentence's hole names — both enforced by [FormatArgs] above,
 * which reads the generated MESSAGE_PARAMS tuples. A caller that forgets one gets
 * a type error at the call site rather than a `{count}` on screen.
 *
 * The runtime check below is therefore not a duplicate of the type: it is what
 * answers a JavaScript caller, and a hole with no value THROWS. Both alternatives
 * are worse in a way this repo has already paid for — leaving `{count}` in place
 * ships an internal token to a user (owner 2026-08-22 iron rule), and substituting
 * an empty string produces a sentence that reads as finished and is wrong.
 */
export function formatMessage<K extends WebMessageKey>(
  locale: WebLocaleCode,
  key: K,
  ...rest: FormatArgs<K>
): string {
  const params = (rest[0] ?? {}) as Readonly<Record<string, string | number>>;
  const catalogue = MESSAGES[locale] ?? MESSAGES[BASE_WEB_LOCALE];
  const template = catalogue[key];
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      const declared = (MESSAGE_PARAMS[key] as readonly string[]).join(', ');
      throw new Error(
        `@flowmic/i18n-web: '${key}' needs {${name}} (declared: ${declared || 'none'}) — ` +
          'refusing to render the placeholder.',
      );
    }
    return String(value);
  });
}
