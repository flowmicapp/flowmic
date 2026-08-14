// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §5 (user_settings KV: stt.routings / llm.config)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4 (routing selection; managed default)
//   docs/decisions/2026-08-02-production-engine-lineup-soniox-deepseek.md §3
//     (the platform-managed Soniox/DeepSeek lineup this unblocks)
//   CLAUDE.md anti-façade ④ / "one value answers only one question"
//
// WHO WROTE THIS SETTINGS ROW — the platform seeder, or the user.
//
// 🔴 THE DEFECT THIS EXISTS TO REMOVE (【measured】 by reading the code, 2026-08-06).
// `settings/defaults.ts seedDefaultSettingsForAllUsers()` runs at every boot over
// EVERY user and writes `stt.routings` (zh → LAN FunASR, '*' → LAN SenseVoice) and
// `llm.config` (the lan-vllm-qwen35 preset). Those rows were byte-for-byte
// INDISTINGUISHABLE from rows a user had authored, and both resolvers consult the
// platform managed default only AFTER the user's own rows miss. Since every
// account that has ever booted owns a seeded `'*'` routing and a seeded
// `llm.config`, the user tier never missed ⇒ **the managed-default arm was
// structurally unreachable for every real account**. `compose/llm-config.ts`
// carried a 【measured】 comment saying exactly that for the LLM half.
//
// The consequence was not academic: turning on a platform-managed engine would
// have been a silent no-op, because every account would have kept routing to the
// LAN box. The fix is to CLASSIFY (mark which rows we wrote), not to make the
// managed default outrank a user row — that second thing is still forbidden and
// is called out in every comment this change touched.
//
// ── THE MARKER ──────────────────────────────────────────────────────────────
// A field on the value itself: per-row for `stt.routings`, on the object for
// `llm.config`. It holds exactly one string, `'seed'`.
//
// 🔴 ABSENCE MEANS `user`, AND THAT IS THE SAFE FAILURE DIRECTION. If the boot
// reclassification never runs — old database, crashed boot, someone reverts the
// call — every unmarked row is judged user-authored, the user tier never misses,
// and behaviour degrades to EXACTLY today's behaviour (seed rows win, the managed
// arm stays unreachable). Nothing is mis-billed and nobody's engine changes under
// them. The opposite convention (absence ⇒ seed) would fail the other way: a
// user's own row would be silently overridden by a platform engine, which is the
// one outcome the ruling forbids. Do not invert this.
//
// 🔴 THE MARKER IS SERVER-OWNED AND CLIENT-UNFORGEABLE. Every write path re-derives
// it with [stampProvenance] and discards whatever the client sent. This is not
// defensive coding, it is load-bearing: the desktop hydrates `stt.routings` from
// `settings:list` by SPREADING each row (`apps/desktop/src/main-window/
// settings-model.ts applyServerSettings`, `(value as Routing[]).map((r) => ({...r}))`),
// so a marker WOULD survive a round trip and land back on a row the user has since
// edited — and then a platform engine would override a real user edit.
//
// ── KNOWINGLY ACCEPTED FALSE POSITIVE ───────────────────────────────────────
// A user who configures a row that is value-identical to the current default is
// classified `seed`. That is the ruling's stated rule (「byte-identical to the
// current seed value ⇒ seed」) and it is accepted deliberately: such a row asks for
// the same engine the platform would have given them anyway, and ANY deviation
// (a different endpoint, an added model, their own key) keeps it `user`. It is
// recorded here rather than left to be re-discovered.

/** The marker field. Present-and-`'seed'` ⇒ platform-seeded; absent ⇒ user. */
export const PROVENANCE_FIELD = 'provenance';
/** The only value the marker ever holds. Matches the `'seed'` member of
 *  `RoutingSource` / `LlmConfigSource` on purpose — one word, one meaning. */
export const SEED_PROVENANCE = 'seed';

/** The two provenance-bearing settings keys. Any other key passes through every
 *  function here untouched — this module has no opinion about `stt.polish`. */
export const STT_ROUTINGS_KEY = 'stt.routings';
export const LLM_CONFIG_KEY = 'llm.config';

/** One entry of `buildDefaultSettings()`. Declared structurally so this module
 *  does NOT import `./defaults` — that would be a cycle (defaults imports this),
 *  and this repo breaks cycles rather than relying on ESM tolerating them (see
 *  `stt/engine-factory.ts`'s note about `./streaming-engines`). The caller
 *  supplies the current defaults; `defaults.ts` exposes the bound convenience
 *  `stampSettingProvenance` so write paths never have to think about it. */
export interface DefaultSettingEntry {
  key: string;
  value: unknown;
}

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True when the value carries the seed marker. Answers the question the
 *  resolvers ask: "did we seed this row, or did the user write it themselves?" Anything that is not a
 *  plain object with the exact marker string is `user` — see the failure-direction
 *  note in the file header. */
export function isSeedMarked(value: unknown): boolean {
  return isPlainObject(value) && value[PROVENANCE_FIELD] === SEED_PROVENANCE;
}

/** The same object without its marker field. Returns a copy only when there was
 *  something to remove, so callers can use reference identity to detect 「no
 *  change」 (the boot reclassification relies on that to write nothing). */
function stripMarker(unit: Plain): Plain {
  if (!(PROVENANCE_FIELD in unit)) return unit;
  const out = { ...unit };
  delete out[PROVENANCE_FIELD];
  return out;
}

/**
 * Comparison form. Key order is normalised and the marker is removed, so the
 * question asked is "same set of fields, same set of values?" rather than "same byte string?".
 *
 * ⚠️ Normalising key order is deliberate and it is the SAFE direction: it can only
 * classify MORE rows as seed, never fewer, and a row whose field set and values
 * are identical to the default IS the default however its JSON happened to be
 * serialised. A client that re-serialises a row (the desktop's `{...r}` spread,
 * `JSON.parse(JSON.stringify(x))` anywhere in the chain) must not be able to
 * launder a seed row into a user row just by moving a key.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The comparison units for a key — what "one row" means for that key.
 *
 * `stt.routings` compares PER ROW, and that is the whole point of the per-row
 * marker: a user who edits only the `zh` line keeps the seeded `'*'` line as a
 * seed row, so the managed default can take over the wildcard while the user's
 * own `zh` choice still wins for Chinese. `llm.config` is a single object, so it
 * has exactly one unit.
 */
function seedUnits(key: string, defaults: readonly DefaultSettingEntry[]): unknown[] {
  const entry = defaults.find((d) => d.key === key);
  if (!entry) return [];
  if (key === STT_ROUTINGS_KEY) return Array.isArray(entry.value) ? entry.value : [];
  if (key === LLM_CONFIG_KEY) return isPlainObject(entry.value) ? [entry.value] : [];
  return [];
}

/**
 * 🔴 THE ONE AUTHORITY (D1). "Is this unit value-identical to something
 * `buildDefaultSettings()` would produce right now?" — asked by the seeder, by
 * every write path, and by the boot reclassification. Written once so those three
 * can never drift into three different answers.
 *
 * Note "right now": the defaults are resolved from presets plus the deployment's
 * `FLOWMIC_DEFAULT_*_HOST` override at call time, so this compares against the
 * defaults THIS process would seed, not against a frozen historical value. A row
 * seeded by an older default no longer matches — which is precisely why the boot
 * reclassification is ADD-ONLY and never strips an existing marker: that row is
 * still ours, it is just an older version of "ours".
 */
export function isSeedUnit(key: string, unit: unknown, defaults: readonly DefaultSettingEntry[]): boolean {
  if (!isPlainObject(unit)) return false;
  const bare = canonical(stripMarker(unit));
  return seedUnits(key, defaults).some((s) => canonical(s) === bare);
}

function stampUnit(key: string, unit: unknown, defaults: readonly DefaultSettingEntry[]): unknown {
  if (!isPlainObject(unit)) return unit; // junk: the caller's shape gate owns it
  const bare = stripMarker(unit);
  return isSeedUnit(key, bare, defaults) ? { ...bare, [PROVENANCE_FIELD]: SEED_PROVENANCE } : bare;
}

/**
 * Re-derive the provenance marker for a value about to be WRITTEN.
 *
 * 🔴 The incoming marker is discarded, always. A client cannot forge `seed` onto a
 * row it authored (that would let a platform engine override a real user edit),
 * and it cannot strip `seed` off a row it did not touch (the value is compared,
 * not trusted). The answer comes only from [isSeedUnit].
 *
 * Non-provenance keys and malformed values pass through byte-identical — this
 * function is on the generic `settings:update` path, where the key is whatever the
 * client sent.
 */
export function stampProvenance(key: string, value: unknown, defaults: readonly DefaultSettingEntry[]): unknown {
  if (key === STT_ROUTINGS_KEY && Array.isArray(value)) {
    return value.map((row) => stampUnit(key, row, defaults));
  }
  if (key === LLM_CONFIG_KEY && isPlainObject(value)) {
    return stampUnit(key, value, defaults);
  }
  return value;
}

/**
 * The one-time BACKFILL for databases written before the marker existed: give an
 * unmarked row that still matches the current default the marker it should have
 * had. Returns the new value, or `null` when there is nothing to do — so the
 * caller writes NOTHING rather than rewriting a row with itself.
 *
 * 🔴 ADD-ONLY, and the two halves of that word are both load-bearing:
 *   · it only ever ADDS a marker to a unit that has none. It never strips one and
 *     never edits one, so a row seeded by an OLDER default (different preset,
 *     different `FLOWMIC_DEFAULT_*_HOST`) keeps its `seed` marker even though it
 *     no longer matches. That row really was ours; promoting it to `user` would
 *     make a platform-authored row outrank the managed default and — if it ever
 *     carried a key — get judged BYOK.
 *   · it only touches units that MATCH. A user's own row is left byte-identical,
 *     including its key order, because unchanged units are returned by reference
 *     and only a changed unit forces a new object.
 *
 * Idempotent by construction: after one run every matching unit is marked, so the
 * second run finds nothing unmarked-and-matching and returns `null`.
 *
 * ⚠️ This is a DATA migration, not a schema one. There is no `migrations/`
 * directory in this repo (the mechanism is an inlined `INIT_SQL` + guarded
 * `reconcileSchema()`, see `db/schema.ts` and 05 §1.0), and this must not go
 * anywhere near raw SQL on `user_settings.value`: the settings repo encrypts
 * nested `api_key` as `enc:v1:` on write and decrypts on read, so JSON surgery in
 * SQL would either corrupt the envelope or write plaintext keys to disk. It runs
 * through `SettingsRepo` read/write only.
 */
export function reclassifyUnmarked(
  key: string,
  value: unknown,
  defaults: readonly DefaultSettingEntry[],
): unknown | null {
  const mark = (unit: unknown): unknown => {
    if (!isPlainObject(unit)) return unit;
    if (PROVENANCE_FIELD in unit) return unit; // already answered — never re-answered
    return isSeedUnit(key, unit, defaults) ? { ...unit, [PROVENANCE_FIELD]: SEED_PROVENANCE } : unit;
  };
  if (key === STT_ROUTINGS_KEY && Array.isArray(value)) {
    const next = value.map(mark);
    return next.some((row, i) => row !== value[i]) ? next : null;
  }
  if (key === LLM_CONFIG_KEY && isPlainObject(value)) {
    const next = mark(value);
    return next === value ? null : next;
  }
  return null;
}
