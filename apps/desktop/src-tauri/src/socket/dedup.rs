// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (duplicate-injection guard: INJ-3 request_id LRU(256)
//     for EVERY source, INJ-1 1500ms byte window, source∈manual|history|image
//     skip the INJ-1 byte window ONLY)
//   docs/legacy-reference/shared-contract/protocol-schemas-inject.ts
//     (F-2221/INJ-3: request_id minted at PTT-down, constant across frame-level
//      duplication of one utterance; A-58: two inject:result frames sharing a
//      request_id collapse to one pending-target claim on the mobile)
//   docs/decisions/2026-07-23-wp-r2-1-inject-review-rulings.md (deferred INJ-3)
//   docs/decisions/2026-07-31-dedup-bypass-downgrade.md (RV-29 real fix (真修) — the
//     correction block below; owner 2026-07-31 persistent outbox queue (持久发件队列) ruling)
//   docs/decisions/2026-08-01-dedup-is-machine-scoped-not-channel-scoped.md
//     (G-13 — the SCOPE block below; why the table is per MACHINE and why the
//      credential slots stay per channel)
//   docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// De-duplication decision for an inbound inject:request, so a reconnect-flap
// replay of the SAME delivery is physically typed exactly once.
//
//   INJ-3 (request_id present — ANY source, including manual/history/image):
//     LRU(256) keyed by request_id. First sight → Proceed; the caller runs the
//     pipeline and calls `record` with the TRUTHFUL inject:result, which is
//     cached. A later frame with the same request_id → Replay(cached): re-send
//     the byte-identical first result WITHOUT typing again (ruling 3: status
//     only ever reports the delivery truth; the mobile collapses
//     same-request_id result frames — A-58 — so re-sending is safe and is NOT a
//     silent ack-swallow).
//
//   INJ-1 (no request_id, AUTO source stt/llm): a 1500ms byte window. A repeat
//     of the SAME text within the window → Suppress: discard, type nothing, and
//     send NO result. Deliberately no result is re-sent here — without a
//     request_id the mobile can only collapse by the D-207 FIFO, and emitting a
//     duplicate untagged result would drain a SECOND FIFO slot (the pre-A-58
//     storm-leak). The first (non-duplicate) frame already delivered its truth.
//
//   source ∈ manual|history|image with NO request_id: always Proceed — they are
//     exempt from the INJ-1 byte window, and from nothing else.
//
// ── ⚠️ Correction (更正) (RV-29 real fix, 真修) — this block REPLACES prose that used to live here ──
//
// WHAT IT USED TO SAY, verbatim:
//     「source ∈ manual|history|image: bypasses ALL dedup (a deliberate re-send
//      — re-inject from history / manual Send / image paste), never cached,
//      never suppressed.」
//   and `classify` implemented it as an early `return Proceed` placed BEFORE the
//   request_id lookup, with `record` returning without caching. So `manual` and
//   `image` arrived CARRYING a request_id and had it thrown away unread.
//
// WHY THAT REASONING NO LONGER HOLDS. It is this repo's #1 bug shape (一个值答
// 两个问题 — "one value answers two questions"):
//   `source` answers 「did a human deliberately ask for this delivery?」 and was
//   used to answer 「is this frame the SAME delivery I already typed?」. The
//   first answer earns exemption from INJ-1 — whose byte window is a HEURISTIC
//   ("identical text this fast is probably one utterance duplicated"), and two
//   deliberate sends of identical text really are two deliveries. It says
//   nothing about a TRANSPORT-level re-emission of ONE deliberate send, which is
//   exactly the question `request_id` was minted to answer.
//
// WHY IT BECAME LOAD-BEARING NOW. owner 2026-07-31 ruled the mobile must deliver
//   PERSISTENTLY (after a disconnect, reconnecting must make up for it, 断网后重连要补上) ⇒ window B3's outbox re-emits a queued item under
//   the id it was born with (manual_delivery.dart:377-387 states this rule for
//   the queue it is waiting on). With the old ordering the queue would have been
//   a duplicate-delivery generator: a drain retry types the same sentence into
//   the user's document twice, with no gate anywhere on the socket leg (the
//   server's request_id ledger, inject-pending.ts:78-80, self-declares it
//   "covers the http ingress alone").
//
// WHY COLLAPSING BY ID CANNOT MERGE TWO DELIBERATE SENDS — verified, not assumed:
//   every producer mints a FRESH unique id per user action. `mintRequestId` is
//   `'{prefix}{_seq++}-{microsecondsSinceEpoch}'` (manual_delivery.dart:388) and
//   all three call sites mint inside the send (manual ➤ :252, image :356/:430,
//   re-inject :542 — one per click). Two re-injects of the same row get two ids and both
//   type. Only a RETRY of one send reuses an id, which is the whole point.
//
// THE HALF THAT SURVIVES, and why the list still exists at all: a source on that
//   list with NO request_id must still always Proceed. The desktop-local re-inject
//   mints none by design (wire.rs `local_reinject_request`), so two clicks of re-inject
//   inside 1500ms are two deliveries whose bytes are identical — under INJ-1 the
//   second would be Suppressed with NO result frame at all, i.e. the button does
//   nothing and says nothing (red line F2: no silent failure, 没有静默失败). wire.rs has an assertion
//   nailing that down; so does `bypass_sources_with_no_request_id_always_proceed`
//   below.
//
// THE PREDICATE WAS RENAMED with this fix: `is_bypass_source` →
//   `skips_the_inj1_byte_window`. The old name named a CATEGORY (「这是个 bypass
//   source」, "this is a bypass source") instead of the single decision it makes, so it read as a licence to
//   skip whatever the reader had in mind — and an early `return Proceed` in front
//   of the request_id lookup is exactly what that reading licenses. The lead
//   controller (主控) authorized the rename on 2026-07-31
//   (same root cause as RV-79 「一个名字答两个问题」, "one name answers two
//   questions"): renaming is worth more than adding a comment (改名比加注释值钱), because a
//   comment saying「read the name as X」 leaves the misleading name in every call
//   site, which is where the next mistake gets made.
//
// ── ⚠️ RV-83 (window B4-3, owner 2026-08-01 ruling) — the restart boundary above is
//    CLOSED, and the paragraph that used to describe it as open is replaced
//    here rather than quietly deleted, because the shape of the fix matters:
//
//    owner's own words, verbatim, choosing between three options a re-inject-style
//    "keep everything" cache, doing nothing, and this one:
//      「电脑把『哪些已经打过』记到磁盘。重启后手机再发同一条，电脑不重复打字，
//       直接回『这条打过了』，手机显示已注入。不回放重启前的旧结果，所以不会
//       对着一个已经关掉的窗口宣称投递。」("The PC records to disk 'which ones
//       have already been typed'. After a restart, if the phone re-sends the
//       same item, the PC does not type it again — it directly replies 'this
//       one has already been typed', and the phone shows it as injected. It
//       does not replay old results from before the restart, so it will never
//       claim delivery against a window that has already been closed.")
//
//    THE TRAP THIS RULING NAMES BY NAME: the tempting "complete" fix is to
//    persist the FULL cached `Value` (window title, injected_at, everything)
//    and replay it verbatim after a restart, the same way an in-process
//    reconnect-flap replay does. Owner explicitly rejected that option — a
//    replayed window title/injected_at describes a PLACE AND TIME this NEW
//    process never observed (the window may since be closed, minimized,
//    replaced), so repeating them would be exactly the red-line failure
//    (「没有静默失败」's other half, "no silent failure": you must never say
//    you know something you don't know, 不许把不知道的说成知道) applied to a stale
//    fact instead of a missing one.
//
//    WHAT IS ACTUALLY PERSISTED, therefore, is the bare minimum that answers
//    「这条打过了吗」("has this one already been typed") and nothing else: the request_id, and which physical
//    `mode` (sendinput/clipboard — the wire enum has no third value once
//    `cached` is excluded, see below) it went out under. On a disk hit,
//    `InjectDecision::AlreadyTypedOnDisk` carries only that mode; the caller
//    (`inject_ops::run_inject`) builds a FRESH `inject:result` from THIS
//    retry's own request_id/entry_id — never a stored one — with no
//    `target_window`/`inject_target` at all. See that call site for the honest
//    field-by-field accounting the task asked for.
//
//    SCOPE DELIBERATELY NARROWER THAN "every non-Cached record": only an
//    `ok:true` (a keystroke or paste that actually WENT OUT) is written to
//    disk. A recorded `ok:false` (Stage-1b refusal, the char-length cap, a
//    Clipboard-after-SendInput double failure) is NOT persisted — repeating
//    that pipeline after a restart is safe (nothing was typed either time,
//    so nothing can be duplicated) and may even do BETTER the second time
//    (the target could have changed), so there is nothing here worth
//    freezing across a restart. Persisting it would also require inventing a
//    wire `mode` for "an ok:false verdict with no known window", which
//    doesn't exist and isn't owner's ask. This mirrors — not widens — the
//    in-memory `record` guard just above (`mode != Cached`), which already
//    treats "no target at all" as never-cache-worthy for the same reason.
//
//    THE BOUND IS NOT A NEW NUMBER. The on-disk snapshot is DERIVED from the
//    same `order`/`results` LRU(256) this file has had since GA — it is never
//    a second, independently-sized table. A file that is a filtered view of
//    an already-256-capped list can itself never exceed 256 short records
//    (two short strings each), so there is no separate TTL to invent: the
//    existing owner-approved 07 §2 constant is the judge of the disk bound
//    too, just relocated from RAM to `%LOCALAPPDATA%`.
//
//    SCOPE — ⚠️ THIS PARAGRAPH WAS REWRITTEN BY G-13 (window B4-16, owner
//    2026-08-01 authorization, 授权). It used to say「PER CHANNEL」and it is now「PER
//    MACHINE」; the old text is quoted below rather than deleted, because the
//    reasoning that produced a knowingly-incomplete scope is the part worth
//    keeping.
//
//    WHAT IT USED TO SAY, in substance: `socket::client::connect` builds one
//      `InjectDeduper` per resident channel session (07 §6 dual-channel-
//      resident), so the disk file is per channel too — a sibling of that
//      channel's `credentials*.bin` under the SAME isolation rule. It named
//      its own hole out loud: 「a cross-channel gap (an id typed answering
//      channel A, retried on channel B) already exists in the in-memory table
//      today and is unchanged by this card」, and registered it as vol. 15
//      **G-13** rather than widening a human-audit-sensitive fix unasked.
//      That call was right — the gap was pre-existing, and RV-83 neither
//      created nor enlarged it.
//
//    WHY IT NO LONGER HOLDS. The scope was copied from the SHAPE OF THE CODE
//      (「connect builds one per session, so the file follows」) instead of
//      from the QUESTION THE KEY ANSWERS. `request_id` is minted by the phone,
//      once per delivery, BEFORE any channel is chosen; the outbox then drains
//      over whichever link is up, because 「目的地是一台机器，`pc_id` 只是它在
//      某条通道上的别名」("the destination is a machine; `pc_id` is only its
//      alias on a particular channel")(docs/decisions/2026-07-31-queue-destination-is-a-
//      machine-not-a-connection.md). So 「这条打过了吗」("has this one already
//      been typed") is a question about a
//      MACHINE, and answering it out of a per-channel table means answering it
//      with a table that structurally cannot contain the answer: LAN types the
//      sentence, the phone never gets the receipt, the queue retries over
//      cloud, the cloud table has never heard of that id — and the sentence
//      lands in the user's document a second time. No restart needed; this is
//      the ordinary drain path, which is itself correct, already-ruled-on
//      behaviour (裁定过的正确行为).
//      Contrast `credentials*.bin`, which stays per channel and must: a
//      `device_token` is minted BY a server and answers 「这台服务器认不认
//      我」("does this server recognize me") — a genuinely channel-scoped question (channel.rs states both).
//
//    WHAT THAT MEANS MECHANICALLY: BOTH channel sessions now decide on ONE
//      `InjectDeduper` — `machine_deduper()` below, a process-wide `OnceLock`
//      reached only through `session_deduper`, which `socket::client::connect`
//      calls once per session. Sharing is therefore not something a call site
//      has to REMEMBER to do; the wrong shape is not constructible, because a
//      second table does not exist to be handed out. (`SocketConfig::deduper`
//      can override it, and exactly one caller does: the golden example, which
//      wants a throwaway ledger instead of the developer's real one.) And there
//      is ONE file: `socket::channel::typed_ledger_path()`, which takes no
//      channel because there is nothing to choose. The pre-G-13 per-channel
//      files are merged in once and retired by
//      [`InjectDeduper::load_machine_ledger`].
//
//    WHAT G-13 DOES **NOT** CHANGE: every rule above it. The LRU(256) bound,
//      the ok:true-only disk filter, the「不回放旧结果」("do not replay old results") reply shape, the
//      plaintext-JSON judgement — all unchanged. Sharing the table widens WHO
//      CAN HIT an entry; it does not widen what an entry contains or what a
//      hit is allowed to claim.
//
//    A REPLAY THAT CROSSES CHANNELS IS STILL THE RIGHT REPLY, and the reply
//      goes out on WHICHEVER channel asked. An `inject:result` says ok / mode /
//      target / injected_at and echoes the frame's request_id + entry_id
//      (`wire::build_inject_result`); not one of those fields names a channel,
//      a room or a socket, so the cached `Value` is as true on the cloud leg as
//      it was on the LAN leg. The transport carries it: `client.rs` emits on
//      the socket the frame ARRIVED on, so the answer goes back to the asker.
//      The one field that could in principle mismatch is `entry_id` (replayed
//      from the first frame, not re-read from the retry). It cannot in
//      practice: a retry is the SAME outbox item re-emitted under the id it was
//      born with (`manual_delivery.dart` `mintRequestId`), so its request_id
//      and entry_id travel as a pair — and if a future producer ever broke that
//      pairing, the in-memory same-channel replay this file has shipped since
//      GA would already have been wrong, so it is not a G-13 property.
//
//    Plaintext JSON, not DPAPI (contrast `credentials.bin`): the file carries
//    no secret — no token, no window title, no message text, only opaque
//    request_id strings (mint shape is `'{prefix}{seq}-{micros}'`, see
//    `manual_delivery.dart`'s `mintRequestId` — no PII) and a 2-value mode
//    tag. DPAPI would protect nothing here that plaintext doesn't already.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// A dedup table by shared reference. `pub` because the table is reached from
/// outside this module: every socket session decides on one, and a re-inject with no
/// wire at all decides on the SAME one (`socket::local_inject`).
pub type SharedDeduper = Arc<Mutex<InjectDeduper>>;

/// **G-13** — THE dedup table for this machine, built on first use and never
/// again. Both resident channel sessions (07 §6) and the desktop-local re-inject all
/// decide 「这条 request_id 打过了吗」("has this request_id already been typed") out of this one object.
///
/// WHY A PROCESS-WIDE SINGLETON, given that 「进程级单例撞双通道」("a
/// process-wide singleton collides with dual channels") is one of this
/// repo's four named structural defect families. That family is a singleton
/// holding a value that has a DIFFERENT correct answer per channel (「当前是哪
/// 条通道」, "which channel is current", 「这个 token 好使吗」, "is this token
/// any good") — one slot, two truths, so one of them is
/// always wrong. This is the exact inverse: 「这台机器打过这条 id 了吗」("has
/// this machine already typed this id") has ONE
/// correct answer per machine, and the pre-G-13 code kept it in a per-session
/// table precisely because `connect` happens to run twice. Making it a
/// singleton is what makes the wrong shape unrepresentable — you cannot pass
/// the LAN session a different table than the cloud session, because there is
/// only one.
///
/// ⚠️ NEVER call this from a test. It reads (and, once, MIGRATES + deletes) the
/// real files under `%LOCALAPPDATA%\FlowMic`. Tests build `InjectDeduper`
/// directly against temp paths; see dedup_tests.rs.
///
/// Private on purpose: [`session_deduper`] is the only way to get a table, so
/// there is exactly one code path to audit. A `pub` here would be an export
/// with no caller — and the next caller it invited would be one more place that
/// could get the scope wrong.
fn machine_deduper() -> SharedDeduper {
    static MACHINE: OnceLock<SharedDeduper> = OnceLock::new();
    MACHINE
        .get_or_init(|| {
            Arc::new(Mutex::new(InjectDeduper::load_machine_ledger(
                crate::socket::channel::typed_ledger_path(),
                &crate::socket::channel::legacy_typed_ledger_paths(),
            )))
        })
        .clone()
}

/// The table ONE socket session decides on: whatever the caller handed it, else
/// this machine's (`machine_deduper`, private just below).
///
/// The override exists for exactly one caller — the golden example, which wants
/// a throwaway per-run ledger under its own temp path instead of reading and
/// writing the developer's real 「打过了」("already typed") facts. It is deliberately NOT the
/// production seam: production takes the default, and the default is the
/// singleton, so no call site can accidentally give one channel its own table.
///
/// anti-façade ② (反 façade ②): the default here is the real implementation (disk-backed,
/// machine-scoped), never a friendly in-memory stub — a silently
/// non-persistent deduper would repeal RV-83 with no new symbol to grep.
pub fn session_deduper(supplied: Option<SharedDeduper>) -> SharedDeduper {
    supplied.unwrap_or_else(machine_deduper)
}

/// The dedup verdict for one inject:request, decided BEFORE the pipeline runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InjectDecision {
    /// Run the real three-stage pipeline; caller must `record` the result after.
    Proceed,
    /// A request_id LRU hit — re-send this cached result, do NOT type again.
    Replay(Value),
    /// RV-83: a request_id hit that came from the ON-DISK ledger, not this
    /// process's own memory — a PRIOR process life typed it, this one never ran
    /// the pipeline for it, so there is no byte-identical `Value` to replay.
    /// Carries only the wire `mode` token that was recorded ("sendinput" |
    /// "clipboard" — never "cached", see `record`'s guard). The caller MUST
    /// build the reply from THIS retry frame's own request_id/entry_id and
    /// MUST NOT invent a target_window/injected_at — this process never
    /// observed them (see the RV-83 block above `InjectDeduper`).
    AlreadyTypedOnDisk { mode_wire: String },
    /// An INJ-1 byte-window duplicate — discard: no typing, no result frame.
    Suppress,
}

/// What a repeated request_id resolves to, internally. `Full` is a same-process
/// cache — the entire truthful `Value` this process itself built and can replay
/// byte-for-byte. `TypedOnly` is a fact loaded from the RV-83 disk ledger: this
/// exact request_id was typed (mode=sendinput|clipboard) by a PRIOR process
/// life, and that is the whole of what survived — no target, no timestamp, no
/// error detail, because this process never witnessed them. Both variants share
/// ONE `order`/`results` table and ONE LRU(256) cap — RV-83 does not introduce a
/// second, separately-sized cache; it gives the existing one a way to start
/// non-empty after a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CachedEntry {
    Full(Value),
    TypedOnly(String),
}

/// Sources exempt from the INJ-1 byte window — and from NOTHING else (see the
/// correction (更正) block at the top of this file). A deliberate re-send may legitimately
/// repeat the same bytes within 1500ms, so the heuristic window must not judge
/// it; whether it is the same DELIVERY is INJ-3's question, answered by
/// `request_id`, which these sources go through like everybody else.
///
/// ⚠️ RENAMED from `is_bypass_source` with the RV-29 fix. The old name answered
/// 「is this source exempt?」 without saying FROM WHAT, and that ambiguity is
/// what let the early-return grow in front of the request_id lookup — the name
/// read as「bypasses dedup」and the code obliged. The name now states the one
/// thing it decides.
fn skips_the_inj1_byte_window(source: &str) -> bool {
    matches!(source, "manual" | "history" | "image")
}

fn hash_text(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

pub struct InjectDeduper {
    cap: usize,
    /// request_id recency (front = most-recently-touched); eviction pops the back.
    order: VecDeque<String>,
    /// request_id → the cached entry to answer a hit with (see [`CachedEntry`]).
    results: HashMap<String, CachedEntry>,
    /// INJ-1: (text hash, last-seen monotonic ms) of the most recent AUTO inject.
    last_auto: Option<(u64, u64)>,
    inj1_window_ms: u64,
    /// RV-83: where the "already typed" ledger lives on disk, or `None` for an
    /// in-memory-only instance. `None` for every existing test and for `new`/
    /// `default_spec` — production is the ONLY caller that sets this, via
    /// [`InjectDeduper::load_spec_default`], so every pre-RV-83 test stays
    /// disk-free and deterministic exactly as it was.
    ledger_path: Option<PathBuf>,
}

impl InjectDeduper {
    /// 07 §2: LRU(256) for INJ-3, 1500ms byte window for INJ-1.
    pub const LRU_CAP: usize = 256;
    pub const INJ1_WINDOW_MS: u64 = 1500;

    pub fn new(cap: usize, inj1_window_ms: u64) -> Self {
        Self {
            cap,
            order: VecDeque::new(),
            results: HashMap::new(),
            last_auto: None,
            inj1_window_ms,
            ledger_path: None,
        }
    }

    /// Spec-default deduper (LRU 256 / 1500ms), no disk persistence. Used by
    /// every test in this file and by [`Self::load_spec_default`] as its base.
    pub fn default_spec() -> Self {
        Self::new(Self::LRU_CAP, Self::INJ1_WINDOW_MS)
    }

    /// RV-83: load whatever the on-disk ledger at `path` remembers, seed it into
    /// a fresh spec-default deduper, then remember `path` so every future
    /// `record` keeps the file in sync.
    ///
    /// `path` need not exist yet — a missing/corrupt/foreign-shaped file loads
    /// as empty (see [`TypedLedgerFile::load`]), same posture as
    /// `Credentials::load`: never a crash loop, worst case this launch simply
    /// starts with an empty ledger, i.e. exactly pre-RV-83 behaviour.
    ///
    /// This is the ONE-FILE form. Production goes through
    /// [`Self::load_machine_ledger`] instead (it also carries the retired
    /// per-channel ledgers forward); this one serves the golden example, which
    /// deliberately wants a throwaway per-run ledger under its own temp path,
    /// and the tests.
    pub fn load_spec_default(path: PathBuf) -> Self {
        Self::load_into(Self::default_spec(), path, &[])
    }

    /// **G-13 (window B4-16)** — the production constructor: ONE dedup table for
    /// this MACHINE, living at `path`, seeded from that file AND (once, on
    /// upgrade) from every pre-G-13 per-channel ledger in `legacy`, which is
    /// then retired.
    ///
    /// The caller builds exactly one of these and hands the SAME
    /// `Arc<Mutex<…>>` to both resident channel sessions — see the SCOPE block
    /// above for why a per-channel table structurally cannot answer 「这条打过
    /// 了吗」("has this one already been typed"). Both path arguments come from `socket::channel`
    /// (`typed_ledger_path` / `legacy_typed_ledger_paths`), never assembled at
    /// a call site.
    pub fn load_machine_ledger(path: PathBuf, legacy: &[PathBuf]) -> Self {
        Self::load_into(Self::default_spec(), path, legacy)
    }

    /// Test-only seam for the loaders with a non-default cap, so the disk-bound
    /// tests can exercise eviction with a handful of ids instead of 256.
    #[cfg(test)]
    fn load_with_cap(cap: usize, inj1_window_ms: u64, path: PathBuf, legacy: &[PathBuf]) -> Self {
        Self::load_into(Self::new(cap, inj1_window_ms), path, legacy)
    }

    /// Shared body: seed `base` from `path` merged with any `legacy` ledgers,
    /// remember `path` so future `record` calls keep it in sync, and — only
    /// when a legacy file actually existed — finish the one-time migration.
    fn load_into(mut base: Self, path: PathBuf, legacy: &[PathBuf]) -> Self {
        let mut entries = TypedLedgerFile::load(&path).entries;
        // G-13 migration. `retired` stays EMPTY on every launch after the
        // first, so the normal path is byte-for-byte the RV-83 one: read one
        // file, seed, done.
        let mut retired: Vec<PathBuf> = Vec::new();
        for old_path in legacy {
            // Defensive: merging the live file into itself would double every
            // entry and then schedule the live ledger for deletion.
            if *old_path == path || !old_path.exists() {
                continue;
            }
            entries = merge_by_alternating(entries, TypedLedgerFile::load(old_path).entries);
            retired.push(old_path.clone());
        }
        // The file is stored front=most-recent (see TypedLedgerFile). Feeding
        // OLDEST-first means the LAST one fed ends up at the front of `order`
        // (`insert_entry` always pushes to the front) — i.e. the restored
        // recency order matches what was on disk, not reversed. `insert_entry`
        // also collapses an id present in BOTH merged files, which is exactly
        // the id G-13 is about (typed on one channel, retried on the other).
        for entry in entries.into_iter().rev() {
            base.seed_typed_from_disk(entry.request_id, entry.mode);
        }
        base.ledger_path = Some(path);
        if !retired.is_empty() {
            base.finish_migration(&retired);
        }
        base
    }

    /// G-13 one-time migration tail: persist the MERGED table to the live
    /// ledger and, **only if that write succeeded**, delete the per-channel
    /// files it just absorbed.
    ///
    /// The order is the whole safety argument. A delete that ran before a
    /// durable write would destroy facts nothing else holds, and 「这条打过
    /// 了」("already typed") is precisely the fact whose loss retypes a sentence into the user's
    /// document. A failed write therefore leaves both files exactly where they
    /// were and the next launch simply tries again — the migration is
    /// idempotent by construction (merging is a set union collapsed by
    /// `insert_entry`, so running it twice is running it once).
    fn finish_migration(&self, retired: &[PathBuf]) {
        let Some(path) = &self.ledger_path else { return };
        if let Err(e) = self.derive_ledger_file().save(path) {
            eprintln!(
                "[flowmic] G-13 typed-ledger merge could NOT be persisted ({path:?}): {e} — the \
                 retired per-channel ledgers are LEFT IN PLACE and will be merged again next \
                 launch; this process is running on the correctly merged in-memory table"
            );
            crate::forensic::record(
                "startup",
                &format!("G-13 typed-ledger merge NOT persisted ({path:?}): {e} — legacy kept"),
            );
            return;
        }
        for old in retired {
            match std::fs::remove_file(old) {
                Ok(()) => crate::forensic::record(
                    "startup",
                    &format!("G-13 typed-ledger merged and retired {old:?} → {path:?}"),
                ),
                // Merged and durable, just not deleted: harmless and
                // self-healing (next launch merges the same ids again and
                // `insert_entry` collapses them), but say so — a file that
                // was supposed to disappear and did not is exactly the kind
                // of thing a later reader would misread as still live.
                Err(e) => crate::forensic::record(
                    "startup",
                    &format!(
                        "G-13 typed-ledger merged into {path:?} but could not delete {old:?}: {e} \
                         — harmless, it will be merged (and collapsed) again next launch"
                    ),
                ),
            }
        }
    }

    /// Decide the verdict for an inbound request. `now_ms` is a monotonic-ish
    /// timestamp (wall-clock ms is acceptable for the 1500ms window).
    pub fn classify(
        &mut self,
        source: &str,
        request_id: Option<&str>,
        text: &str,
        now_ms: u64,
    ) -> InjectDecision {
        // INJ-3 FIRST, and for every source. A request_id names ONE delivery;
        // who asked for that delivery (`source`) does not change whether this
        // frame is a re-emission of it. Ordering matters and is the whole of
        // RV-29: this lookup used to sit BEHIND a bypass early-return, so
        // manual/image handed over an id that was never read.
        if let Some(rid) = request_id {
            if let Some(entry) = self.results.get(rid).cloned() {
                self.touch(rid);
                return match entry {
                    CachedEntry::Full(v) => InjectDecision::Replay(v),
                    // RV-83: no full Value survived a restart for this id —
                    // only the fact that it was typed, and under which mode.
                    CachedEntry::TypedOnly(mode_wire) => {
                        InjectDecision::AlreadyTypedOnDisk { mode_wire }
                    }
                };
            }
            return InjectDecision::Proceed;
        }
        // No request_id. Deliberate sends are exempt from the byte window (two
        // clicks of re-inject on one row are two deliveries; suppressing the second
        // would make the button do nothing and say nothing).
        if skips_the_inj1_byte_window(source) {
            return InjectDecision::Proceed;
        }
        // INJ-1 byte window — AUTO stt/llm with no id.
        let h = hash_text(text);
        if let Some((last_h, last_ms)) = self.last_auto {
            if last_h == h && now_ms.saturating_sub(last_ms) <= self.inj1_window_ms {
                return InjectDecision::Suppress;
            }
        }
        InjectDecision::Proceed
    }

    /// Record the truthful result AFTER a `Proceed` run so a future replay of the
    /// same request_id re-sends it, and refresh the INJ-1 byte window.
    ///
    /// Mirrors `classify` exactly, and must keep doing so — a verdict this table
    /// can produce but never store is a `Replay` branch that can never fire.
    pub fn record(
        &mut self,
        source: &str,
        request_id: Option<&str>,
        text: &str,
        result: &Value,
        now_ms: u64,
    ) {
        // Cache under the id for EVERY source (RV-29): the id is what a retry
        // will arrive under.
        if let Some(rid) = request_id {
            self.insert(rid.to_string(), result.clone());
            // RV-83: keep the on-disk ledger in sync with whatever `insert`
            // just did to `order`/`results` (including any eviction it
            // triggered). A no-op when `ledger_path` is `None` — every
            // pre-RV-83 test, and this call, never touches disk.
            self.save_ledger_best_effort();
            return;
        }
        // An id-less deliberate send must NOT arm the INJ-1 window. That window
        // is only ever consulted for stt/llm, so writing bypass bytes into it
        // could only ever do one thing: suppress a LATER auto utterance that
        // happens to carry the same text as a re-inject the user just clicked. That
        // is a cross-source suppression nobody asked for, and it would be
        // silent (Suppress sends no result frame at all).
        if skips_the_inj1_byte_window(source) {
            return;
        }
        self.last_auto = Some((hash_text(text), now_ms));
    }

    fn insert(&mut self, rid: String, result: Value) {
        self.insert_entry(rid, CachedEntry::Full(result));
    }

    /// RV-83: seed one id loaded from the on-disk ledger as an ALREADY-typed
    /// fact with no full result to replay. Routes through the SAME
    /// `insert_entry` as a same-process `record` — RV-83 does not add a second
    /// insert path with its own eviction rule, it reuses the one this file has
    /// always had.
    fn seed_typed_from_disk(&mut self, rid: String, mode_wire: String) {
        self.insert_entry(rid, CachedEntry::TypedOnly(mode_wire));
    }

    /// The one LRU insert/evict path, shared by a same-process `record`
    /// (`Full`) and a disk-loaded seed (`TypedOnly`).
    fn insert_entry(&mut self, rid: String, entry: CachedEntry) {
        if self.results.contains_key(&rid) {
            self.results.insert(rid.clone(), entry);
            self.touch(&rid);
            return;
        }
        if self.order.len() >= self.cap {
            if let Some(evicted) = self.order.pop_back() {
                self.results.remove(&evicted);
            }
        }
        self.order.push_front(rid.clone());
        self.results.insert(rid, entry);
    }

    fn touch(&mut self, rid: &str) {
        if let Some(pos) = self.order.iter().position(|x| x == rid) {
            if let Some(k) = self.order.remove(pos) {
                self.order.push_front(k);
            }
        }
    }

    /// RV-83: re-derive the on-disk ledger from the CURRENT `order`/`results`
    /// and write it, or do nothing when this instance has no `ledger_path`.
    ///
    /// Deliberately DERIVED, not incrementally patched: the disk file is always
    /// "whatever `classify`/`record` would answer from memory right now,
    /// filtered to the ok:true typed facts", so it can never drift out of sync
    /// with an eviction `insert_entry` just performed — there is no second
    /// bookkeeping structure to fall out of step with the first.
    ///
    /// Best-effort: an IO failure is logged, never propagated. The keystroke
    /// this `record` call is reporting on ALREADY HAPPENED; a write hiccup must
    /// degrade only the NEXT restart's dedup, never this delivery's result.
    fn save_ledger_best_effort(&self) {
        let Some(path) = &self.ledger_path else { return };
        if let Err(e) = self.derive_ledger_file().save(path) {
            eprintln!(
                "[flowmic] RV-83 typed-ledger save FAILED ({path:?}): {e} — this process's own \
                 dedup is unaffected; only a FUTURE restart's duplicate-guard is degraded for \
                 this one write"
            );
        }
    }

    /// The on-disk snapshot as it should look RIGHT NOW: the current
    /// `order`/`results`, filtered to the ok:true typed facts. Split out of
    /// [`Self::save_ledger_best_effort`] by G-13 so the one-time migration can
    /// write the same derived shape and, unlike a `record`, actually *check*
    /// whether the write landed before it deletes anything.
    fn derive_ledger_file(&self) -> TypedLedgerFile {
        let entries: VecDeque<TypedLedgerEntry> = self
            .order
            .iter()
            .filter_map(|rid| match self.results.get(rid) {
                Some(CachedEntry::TypedOnly(mode)) => Some(TypedLedgerEntry {
                    request_id: rid.clone(),
                    mode: mode.clone(),
                }),
                // Only an ok:true Full entry is a "this was actually typed"
                // fact worth surviving a restart — see the RV-83 block above
                // this struct for why an ok:false one is deliberately excluded.
                //
                // The `filter` below is a defensive belt-and-braces check, not
                // a case this file's own call sites can currently produce:
                // today `ok:true` only ever pairs with mode sendinput/clipboard
                // (`InjectOutcome::ok()` never constructs a Cached success —
                // see pipeline.rs). But `record` is `pub fn` and nothing in
                // ITS type signature enforces that pairing, so a future caller
                // that got it wrong must not be able to write "mode":"cached"
                // ok:true to disk — the truth-table comment at the top of this
                // file only defines ok=true for sendinput/clipboard, and
                // writing an undefined combination to a file a FUTURE process
                // will trust is exactly the kind of thing this file exists to
                // prevent.
                Some(CachedEntry::Full(v)) if v.get("ok").and_then(Value::as_bool) == Some(true) => {
                    v.get("mode")
                        .and_then(Value::as_str)
                        .filter(|m| *m == "sendinput" || *m == "clipboard")
                        .map(|m| TypedLedgerEntry {
                            request_id: rid.clone(),
                            mode: m.to_string(),
                        })
                }
                _ => None,
            })
            .collect();
        TypedLedgerFile { entries }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.results.len()
    }
}

/// **G-13** migration helper: fold a retired per-channel ledger into the live
/// one, front=most-recent preserved on both sides.
///
/// Both lists are front=most-recent, but NEITHER carries a timestamp — the
/// on-disk record is deliberately `{request_id, mode}` and nothing else (owner
/// 2026-08-01「不回放旧结果」("do not replay old results"), RV-83 block above). So a true global recency
/// order ACROSS the two files does not exist and must not be invented.
/// Alternating is the honest answer to that: it keeps the newest of BOTH files
/// at the front, so if the merged set exceeds the LRU(256) cap the eviction
/// falls on the tail of each rather than erasing one file wholesale because it
/// happened to be merged second.
///
/// Getting this order "wrong" costs at most a re-type of a very old id — i.e.
/// exactly the pre-G-13 behaviour for that one id — and can never produce the
/// opposite error (a false 「这条打过了」, "already typed"), because nothing is invented here:
/// every entry in the result was written by a real ok:true delivery on this
/// machine. Ids present in BOTH files (the very case G-13 describes) are
/// collapsed downstream by `insert_entry`, not here.
fn merge_by_alternating(
    live: VecDeque<TypedLedgerEntry>,
    retired: VecDeque<TypedLedgerEntry>,
) -> VecDeque<TypedLedgerEntry> {
    let mut out = VecDeque::with_capacity(live.len() + retired.len());
    let mut live = live.into_iter();
    let mut retired = retired.into_iter();
    loop {
        match (live.next(), retired.next()) {
            (Some(a), Some(b)) => {
                out.push_back(a);
                out.push_back(b);
            }
            (Some(a), None) => out.push_back(a),
            (None, Some(b)) => out.push_back(b),
            (None, None) => return out,
        }
    }
}

/// RV-83 on-disk shape — see the block above [`InjectDeduper`] for the full
/// reasoning. One record per request_id this machine has physically typed
/// (`ok:true`, mode ≠ cached): NOT `InjectOutcome`, NOT the wire `Value` — no
/// window title, no injected_at, no error detail, no text. Just enough to
/// answer 「这条打过了吗」("has this one already been typed") honestly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TypedLedgerEntry {
    request_id: String,
    /// Wire `mode` token — "sendinput" | "clipboard" only, mirroring
    /// `InjectMode::wire()`'s two non-cached values. Never "cached": a cached
    /// (untouched) utterance is never recorded here, on disk any more than in
    /// memory (`record`'s existing `mode != Cached` guard, unchanged by RV-83).
    mode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TypedLedgerFile {
    /// Front = most recently typed. Bounded at [`InjectDeduper::LRU_CAP`] by
    /// construction — this is DERIVED from that same LRU on every save (see
    /// `save_ledger_best_effort`), never a second independently-sized table —
    /// so this file can never hold more than 256 short records no matter how
    /// long the process runs. The bound is the existing owner-approved 07 §2
    /// constant, not a new one invented for this file.
    entries: VecDeque<TypedLedgerEntry>,
}

impl TypedLedgerFile {
    /// Absent / unreadable / corrupt / a shape this build no longer recognises
    /// → empty, never a crash loop. The worst case is this launch simply not
    /// getting the restart-survival benefit — i.e. exactly today's (pre-RV-83)
    /// behaviour, not a new failure mode.
    fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Plaintext JSON — deliberately NOT DPAPI, unlike `credentials.bin`. This
    /// file carries no secret: no token, no window title, no message text —
    /// only opaque request_id strings (`mintRequestId`'s
    /// `'{prefix}{seq}-{micros}'` shape, no PII) and a 2-value mode tag. DPAPI
    /// would wrap a value that has nothing in it worth wrapping.
    fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        std::fs::write(path, json)
    }
}

#[cfg(test)]
#[path = "dedup_tests.rs"]
mod tests;
