// SPEC-REF:
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md
//     (owner architecture ruling "both channels pass through without storing": **a new PC timeline row must be produced by the delivery frame**)
//   packages/protocol/src/protocol-schemas-inject.ts (card P — the six additive
//     optional fields that make ONE delivery frame carry a whole row)
//   apps/desktop/src/lib/timeline-store.ts (`onHistoryUpdated` — the OTHER end of
//     this pipe. It was kept, producer-less and saying so, through 0.2.27 for
//     exactly this card; this module is its producer.)
//   docs/decisions/2026-07-31-owner-b2-outbox-rulings.md ② (RV-72 "one re-delivery
//     = one new row on the PC" — the row's address is now answered by `request_id`,
//     and `entry_id` reverts to a pure receipt correlation)
//   docs/strategy/2026-07-31-b3-protocol-round-plan.md (RV-68: `entry_caption` —
//     an image row's WORDS. The PC renders them and never types them: [`row_face`])
//   docs/rebuild/07-DESKTOP-SPEC.md §9 (timeline)
//   CLAUDE.md red line: status only records the delivery truth / no silent failures / three modes locked, never a fourth mode
//
// ONE `inject:result` ⇔ ONE ROW — and the row is minted WITH the verdict.
//
// ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────
// The server stopped storing transcripts on 2026-07-31, and with it went
// `history:updated` — which was the ONLY way a new row ever reached the PC
// timeline. So from 0.2.28 the timeline kept every old row and could not gain a
// new one. owner's model closes it: the two channels hand a message over without
// storing it, so the PC's row is made by the DELIVERY FRAME itself.
//
// ── ruling 1: A ROW IS NEVER CREATED WITHOUT ITS VERDICT ────────────────────────
// [`mint_row`] takes the outcome of `run_inject` — it CANNOT be called earlier,
// and [`build_row`] cannot be called without a result at all. That is deliberate
// and it is the whole design: minting a `status:'cached'` row first and patching
// it when the verdict lands would, for that instant, publish a row that says
// "not injected · cached" when nothing was cached and nothing had been decided. One
// value answering two questions ("what is the delivery result" and "the result hasn't come back yet") is this
// repo's #1 bug shape. Born-with-the-verdict means that state is never created,
// so no new status enum has to be invented to name it.
//
// ── ruling 2: ONE RESULT, ONE ROW ───────────────────────────────────────────────
// The rule is stated once, here, because it settles all three edges at once:
//   · DEDUPED (`run_inject` → None): no result frame goes to the phone, and no
//     row is minted. The original frame already made its row; a second one for
//     the same utterance would be a duplicate line in the user's timeline.
//   · REFUSED (non-primary channel, socket/client.rs): a result IS sent, so a row
//     IS minted, carrying the refusal as its status. "the timeline = all messages
//     delivered to this PC" (owner 2026-07-30 ①) — the message really did arrive here and
//     really was not typed, and both halves have to be visible.
//   · NORMAL: one result, one row.
//
// ── WHAT IS *NOT* CHECKED HERE, NAMED SO NOBODY READS SILENCE AS SAFETY ───────
// `target_pc_id` (the 🔴 no-crosstalk red line) is NOT read by this module and NOT
// checked anywhere on this desktop. Enforcement lives at the two SERVER ingresses
// and only there — server-core socket/handlers/relay.handler.ts and
// http/inject-routes.ts, which since 0.2.33 refuse both a wrong address
// (INJECT_PC_MISMATCH) and a missing one (INJECT_PC_UNSPECIFIED).
// ⚠️ CORRECTION (0.2.33): this paragraph used to end "Until it lands, a frame
// addressed to another PC that reaches this socket is TYPED". That sentence
// outlived the card it was waiting for — the check landed in 0.2.29, in the same
// wave — and a stale "still missing" note is worse than none, because the next
// reader budgets work for it. What remains TRUE and is the reason the paragraph
// stays: this end verifies nothing itself, so anything that reaches this socket
// without passing one of those two gates (a non-conforming relay, a direct
// connection) is still typed. The row is not the thing to fix if that ever
// happens.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::forensic;
use crate::socket::bridge::{self, BridgeSink};
use crate::socket::channel::Channel;
use crate::socket::wire::InjectRequest;

/// The three modes, as a RUNTIME whitelist. red line "three modes locked, never a fourth mode": a frame
/// claiming a fourth mode must not be able to put it on a row, because the
/// frontend's own whitelist would then silently rewrite it to `realtime`
/// (lib/timeline-normalize.ts) and the disagreement would be invisible. Refused
/// here instead, and recorded.
const ROW_MODES: [&str; 3] = ["realtime", "translate", "organize"];
/// The two row kinds (05 §1 / `EntryTypeSchema`).
const ROW_ENTRY_TYPES: [&str; 2] = ["transcript", "image"];

/// Sequence for locally-minted row ids — see [`RowIdOrigin::Local`].
static LOCAL_ROW_SEQ: AtomicU64 = AtomicU64::new(0);

/// WHERE THE ROW'S ADDRESS CAME FROM. It is a real distinction, not bookkeeping —
/// each variant says something different about who can name this row again.
///
/// ⚠️ RV-72 FLIPPED THE FIRST TWO (owner 2026-07-31 ruling ② "one re-delivery = one
/// new row on the PC"). `entry_id` used to answer BOTH "which content" and "which
/// row on the PC", this repo's #1 bug shape: a re-delivery keeps the phone's
/// `entry_id` (mobile session/manual_delivery.dart's reinject preserves it
/// deliberately, A-58), so the second delivery folded onto the
/// first row and the words that were really typed had NO visible record on this PC.
/// `request_id` is "this delivery" by construction — minted at PTT-down and re-minted per
/// re-delivery (`chat_utterance.dart`: `'${entry.clientId}-rp{micros}'`) — so it is the
/// row's ADDRESS now, and `entry_id` went back to being a pure correlation echo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::socket) enum RowIdOrigin {
    /// `request_id`, prefixed. THE NORMAL CASE. Prefixed so it can never collide with
    /// a phone-minted `entry_id`, and DERIVED rather than random so an INJ-3 replay of
    /// the SAME delivery (a reconnect flap re-sending one frame) upserts the same row
    /// instead of adding a second one — that is the same key the desktop deduper uses.
    Request,
    /// `entry_id` verbatim — only when the frame carried no `request_id`. The row is
    /// then addressed by its CONTENT id, so a later re-delivery of that same content
    /// lands on this row instead of adding one (the RV-72 behaviour, for a sender too
    /// old to stamp a delivery id). Recorded as a gap by [`minted_line`].
    Entry,
    /// Neither id was present. A fresh local address: there is nothing on the
    /// frame to be stable against, and inventing stability would be a lie. The
    /// only duplication mode this case has is a byte-identical re-send, which the
    /// INJ-1 window already suppresses before any result exists (socket/dedup.rs).
    Local,
}

impl RowIdOrigin {
    fn tag(self) -> &'static str {
        match self {
            RowIdOrigin::Request => "request_id",
            RowIdOrigin::Entry => "entry_id",
            RowIdOrigin::Local => "local",
        }
    }
}

/// A wire field declared `nullable().optional()` — THREE states that must not be
/// collapsed, because they answer different questions (RV-75).
///
/// `source_text` is the one that matters: `null` is "this row has no original text"
/// (realtime says the words ARE the output), while ABSENT is "this sender doesn't
/// speak this field at all". Both make
/// the row's original-text column empty, and until this existed the log could not tell them apart —
/// so "the original-text column is empty" had two possible causes and no evidence for either.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::socket) enum Stated {
    /// The key is not on the frame at all: this SENDER does not speak the field.
    #[default]
    Absent,
    /// The key is there and says there is none (explicit `null`, or `""` — for a row
    /// those are the same statement). Also where a non-string lands: a malformed
    /// value is not an answer, and reading it as content is how junk reaches a row.
    Null,
    /// A real value.
    Value(String),
}

impl Stated {
    fn read(v: Option<&Value>) -> Self {
        match v {
            None => Stated::Absent,
            Some(Value::String(s)) if !s.is_empty() => Stated::Value(s.clone()),
            Some(Value::Null) | Some(Value::String(_)) => Stated::Null,
            // A number/array/object: the frame said something unusable. Treated as
            // "didn't say" rather than "said empty" so the log does not report a malformed
            // sender as a well-behaved realtime one.
            Some(_) => Stated::Absent,
        }
    }

    /// What the ROW gets. Absent and Null are the same to a row (both render as no
    /// original text); they are only different to the person reading the log.
    fn value(&self) -> Option<&str> {
        match self {
            Stated::Value(s) => Some(s.as_str()),
            _ => None,
        }
    }

    /// The three states, as three distinguishable tokens for [`minted_line`].
    fn tag(&self) -> String {
        match self {
            Stated::Absent => "absent".to_string(),
            Stated::Null => "null".to_string(),
            Stated::Value(s) => format!("{}chars", s.chars().count()),
        }
    }
}

/// The row half of an `inject:request`: the card P fields that say WHAT THIS ROW IS,
/// as opposed to [`InjectRequest`], which says what to TYPE.
///
/// Two structs over one frame on purpose — they answer two different questions and
/// have two different failure modes (a bad `text` must refuse an injection; a bad
/// `mode` must only cost a badge). Every field is `Option`: a 0.2.28 phone sends
/// none of them, and "this frame didn't say" must stay distinguishable from "this frame said empty".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::socket) struct RowFacts {
    /// How the entry was PRODUCED (realtime/translate/organize). Never
    /// `inject:result.mode` — that is the delivery PATH (sendinput/clipboard/
    /// cached), a different question with a different domain, and reading one for
    /// the other is the exact mistake this repo keeps making.
    pub mode: Option<String>,
    /// When it was SPOKEN. Absent ⇒ the row can only be stamped with the moment
    /// this PC received it, which is a different fact (see [`build_row`]).
    pub created_at: Option<String>,
    /// The original text when `text` is a product (translate/organize two-column).
    /// [`Stated`], not `Option`: "not sent" and "sent null" are the two answers RV-75
    /// exists to keep apart, and the row treats them identically.
    pub source_text: Stated,
    /// transcript | image — they render completely differently.
    pub entry_type: Option<String>,
    /// The bounded inline preview an image row keeps after the paste is done.
    pub thumb_b64: Option<String>,
    /// RV-68: the WORDS an image row shows. An image frame's `text` is `''` by
    /// design (the phone must not send the descriptor as text — an older PC would
    /// TYPE 「🖼 PNG · 214 KB」 into the user's document), so without this the row
    /// this module mints has a thumbnail and not one character under it, while the
    /// phone's own row for the same picture reads 「🖼 PNG · 214 KB」.
    ///
    /// 🔴 RENDERED, NEVER TYPED. It reaches the row's `output_text` and nothing
    /// else — see [`row_face`] for the two properties that keep that true.
    pub entry_caption: Option<String>,
    /// WHICH PHONE said it. The delivery frame carries no `mobile_id` (the relay
    /// forwards `parsed.data` verbatim — server-core relay.handler.ts), so this is
    /// the ONLY sender identity a minted row can have.
    pub device_label: Option<String>,
    /// How long the utterance took to SAY, in ms (0.2.43, owner "voice duration must be recovered").
    /// The phone's engine-reported number, passed through untouched. Absent for
    /// typed/manual/image rows, pre-0.2.43 phones, and any frame that crossed a
    /// pre-0.2.43 relay (zod strips unknown fields in flight) — the row then keeps
    /// null, which the stats layer counts as "no duration", never as 0 (doc 16 §6.1).
    pub duration_ms: Option<u64>,
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// A string field constrained to a fixed whitelist. Off-whitelist reads as ABSENT
/// (the caller then applies its stated default) — never as the raw value, and
/// never silently: [`mint_row`] records every field it had to fall back on.
fn one_of(v: Option<&Value>, allowed: &[&str]) -> Option<String> {
    non_empty(v).filter(|s| allowed.contains(&s.as_str()))
}

impl RowFacts {
    /// Read the row half off the raw `inject:request` object.
    pub(in crate::socket) fn read(frame: &Value) -> Self {
        Self {
            mode: one_of(frame.get("mode"), &ROW_MODES),
            created_at: non_empty(frame.get("created_at")),
            source_text: Stated::read(frame.get("source_text")),
            entry_type: one_of(frame.get("entry_type"), &ROW_ENTRY_TYPES),
            thumb_b64: non_empty(frame.get("thumb_b64")),
            entry_caption: non_empty(frame.get("entry_caption")),
            device_label: non_empty(frame.get("device_label")),
            // Non-negative integers only; anything else reads as ABSENT (the same
            // posture one_of takes — a malformed metadata field costs the badge,
            // never the delivery).
            duration_ms: frame.get("duration_ms").and_then(Value::as_u64),
        }
    }
}

/// The row's id, and the honest answer to "what gives it this name".
///
/// ⚠️ NOT A PURE FUNCTION of the frame — the [`RowIdOrigin::Local`] branch mints a
/// fresh address on every call. Callers that need the id AFTER minting must take the
/// one [`Minted`] hands back; asking a second time would name a row that does not exist.
pub(in crate::socket) fn row_id(req: &InjectRequest) -> (String, RowIdOrigin) {
    // RV-72: "this delivery" addresses the row, so a re-delivery is a NEW row and a
    // reconnect replay of the SAME delivery is the same one.
    if let Some(rid) = &req.request_id {
        return (format!("req:{rid}"), RowIdOrigin::Request);
    }
    if let Some(eid) = &req.entry_id {
        return (eid.clone(), RowIdOrigin::Entry);
    }
    let n = LOCAL_ROW_SEQ.fetch_add(1, Ordering::Relaxed);
    (format!("local:{}-{n}", crate::socket::client::now_millis()), RowIdOrigin::Local)
}

/// The row's `status`, read off the truthful `inject:result` this PC just built.
///
/// ONE SOURCE, TWO RENDERINGS — not two answers. The frontend performs the same
/// mapping on the same two fields of the same value when it reconciles a result
/// onto a row (`lib/timeline-store.ts` `onInjectResult`); both read `ok` and
/// `mode` off the verdict, so they cannot disagree about a delivery, only about
/// how to spell it. This one exists because ruling 1 requires the status to be on
/// the row the instant it is created.
///
/// red line "status only records the delivery truth": there is no branch here that can produce a status
/// from anything other than the verdict.
pub(in crate::socket) fn row_status(result: &Value) -> &'static str {
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        return "injected";
    }
    match result.get("mode").and_then(Value::as_str) {
        // `cached` is the ONE non-ok outcome that means "preserved, can be redelivered".
        Some("cached") => "cached",
        _ => "failed",
    }
}

/// What the row SHOWS — its `output_text` (RV-68).
///
/// ONE FIELD, ONE QUESTION. `output_text` answers "what this row displays" and that is the
/// only question it answers here; the row's face is `text` for every row whose
/// `text` means something, and for the ONE kind whose `text` is deliberately empty
/// it is the caption the sender prepared. There is never a row with two candidate
/// faces: the protocol refuses `entry_caption` on anything but an image row
/// (protocol-schemas-inject.ts superRefine), so the two are mutually exclusive by
/// construction rather than by a precedence rule invented here.
///
/// 🔴 THE CAPTION IS NEVER TYPED, and that rests on two properties rather than on
/// good intentions:
///   ① it can only land on a row this frame explicitly declared `entry_type:'image'`
///      — the `source == "image"` FALLBACK below deliberately does NOT unlock it,
///      because that fallback is this PC's guess about someone else's row and a
///      guess must not put words on it; and
///   ② an image row has no reinject button (`rowCanReinject` in
///      main-window/TimelinePage.vue → `entry_type !== 'image'`, which is what
///      gates the button), the only path from a row's `output_text` back into the
///      typer (`TimelineStore.reInject` in lib/timeline-store.ts → bridge.ts
///      `reInjectLocally`).
///      ⚠️ NAMED BY SYMBOL, NOT BY LINE (2026-08-07): this cited `:149-151`/`:514`
///      and `timeline-store.ts:635-641`, and an ordinary edit in the Vue file made
///      THIS file's citation the failing one. 「a citation that rots is worse than
///      none」 — the same rule `target_pc_id` states in the protocol schema.
/// ⚠️ Property ② is a UI guard, not a store invariant — `TimelineStore.reInject`
/// itself does not look at `entry_type`. That was already true before this field
/// existed (an image row's descriptor has lived in `output_text` on the PHONE's
/// side all along), and it is not this module's to fix; it is written down here so
/// the next person to touch either end knows the two halves are load-bearing
/// together. See the card report.
fn row_face(req: &InjectRequest, facts: &RowFacts, entry_type: &str) -> String {
    if entry_type == "image" {
        if let Some(caption) = facts.entry_caption.as_deref() {
            // Only when the FRAME said 'image' (see ① above): `entry_type` here is
            // the frame's own value in that case, never the fallback.
            if facts.entry_type.as_deref() == Some("image") {
                return caption.to_string();
            }
        }
    }
    req.text.clone()
}

/// Assemble the wire-shaped row item (`WireHistoryItem`, apps/desktop/src/lib/types.ts).
///
/// `received_at` is this PC's clock and is used ONLY as `created_at`'s fallback.
/// Standing in for the spoken instant is acceptable — there is no better answer on
/// a frame that omits it — but doing so WITHOUT SAYING SO is not, which is why
/// [`mint_row`] records every fallback it applied.
fn build_row(id: &str, req: &InjectRequest, facts: &RowFacts, result: &Value, received_at: &str) -> Value {
    let created_at = facts.created_at.clone().unwrap_or_else(|| received_at.to_string());
    // This PC decoded and pasted the bytes, so "whether this is a picture" is a fact it owns —
    // the same reasoning that puts `entry_kind` on the forwarded inject:result.
    // The frame's own `entry_type` still wins when it has one.
    let entry_type = facts.entry_type.clone().unwrap_or_else(|| {
        if req.source == "image" { "image" } else { "transcript" }.to_string()
    });
    let mut item = json!({
        "id": id,
        // Absent ⇒ 'realtime'. It is a GUESS and it is recorded as one; a 0.2.28
        // phone sends no mode and TimelineRow has no "unknown" to render.
        "mode": facts.mode.clone().unwrap_or_else(|| "realtime".to_string()),
        "status": row_status(result),
        // A row that was just delivered has never been edited. `edited` is about
        // the USER changing the output here, and nobody has yet.
        "edited": false,
        // Absent and explicit-null are both "no original text" to a row (realtime rows
        // have none), so both land on null — the DIFFERENCE between them is recorded
        // in the log instead ([`Stated`], RV-75). `source_text` is write-once
        // immutable (doc 05) — this is the only moment it is ever set.
        "source_text": facts.source_text.value().map_or(Value::Null, Value::from),
        // The row's display face: what was delivered, or — for the one row kind
        // whose `text` is deliberately empty — the caption the sender prepared for
        // it (RV-68). [`row_face`] owns that rule and the reason it can never be
        // typed. Before it existed an image row on this PC showed a thumbnail with
        // nothing under it while the phone's row read 「🖼 PNG · 214 KB」.
        "output_text": row_face(req, facts, &entry_type),
        "created_at": created_at,
        // Nothing has happened to this row since it was created. A local edit moves
        // it (TimelineStore.edit); this is its birth.
        "updated_at": created_at,
        "entry_type": entry_type,
    });
    // OMITTED, never null/"": the frontend narrows `typeof … === 'string'` and an
    // empty string would be a claim that the phone sent an empty label.
    if let Some(t) = &facts.thumb_b64 {
        item["thumb_b64"] = json!(t);
    }
    // 🔴 RV-93 — size B. The frame already carries the full picture (it is what was
    // just typed into the focused window); this keeps it so opening the full image can show the
    // real thing rather than an enlarged thumbnail.
    //
    // ⚠️ THE FLAG IS THE WRITE'S OWN VERDICT, never an intention. `store` returns
    // false when the payload did not validate or the disk refused, and the row
    // then says it has no big picture — a row claiming one it does not have would
    // offer a double-click that opens nothing, i.e. "a control that changes nothing".
    // The failure is recorded by `store` itself; nothing is swallowed here.
    //
    // Only on an IMAGE row, and only from the frame's own bytes: `entry_type` may
    // have been GUESSED from `source == "image"` a few lines up, but `req.image()`
    // is `Some` only when both `image_b64` and `image_mime` are really there.
    if entry_type == "image" {
        if let Some((b64, mime)) = req.image() {
            if super::row_image::store(id, b64, mime) {
                item["full_image"] = json!(true);
            }
        }
    }
    if let Some(l) = &facts.device_label {
        item["device_label"] = json!(l);
    }
    // OMITTED when the frame had none — the frontend normaliser turns absence into
    // null, and null is the honest value (none ≠ 0 seconds).
    if let Some(d) = facts.duration_ms {
        item["duration_ms"] = json!(d);
    }
    item
}

/// The one greppable line a minted row leaves behind (red line: no silent failures), built as a
/// PURE FUNCTION so it can be asserted on.
///
/// That is not tidiness: `forensic::record` writes to a process-wide sink that is a
/// no-op under `cargo test`, so a line formatted inline is a line no test can read —
/// and "you can't tell from the log" is exactly the failure RV-75 is about. The
/// primary controller read this line off a real machine on 2026-07-31 and could not
/// answer "did the original-text column not appear because it wasn't sent, or
/// because it was sent but not rendered", because the two fields that carry a row's CONTENT were the two the
/// line never mentioned.
///
/// ⚠️ WHY `source_text` IS **NOT** IN `gaps=[…]`. `gaps` is a list of FALLBACKS —
/// values this PC had to substitute — and a list can only be read by absence.
/// `source_text` has no fallback (there is nothing to fall back to) and three states,
/// so absence-from-the-list could not separate "sent null" from "sent content, but the render lost it":
/// the very question that has to be answerable. It gets its own token with all three
/// states spelled out. `thumb_b64` has two states and only matters on an image row, so
/// it IS a gap and stays silent on every transcript.
fn minted_line(
    id: &str,
    origin: RowIdOrigin,
    channel: Channel,
    req: &InjectRequest,
    facts: &RowFacts,
    item: &Value,
) -> String {
    let entry_type = item["entry_type"].as_str().unwrap_or("?");
    let mut gaps: Vec<&str> = Vec::new();
    if facts.created_at.is_none() {
        gaps.push("created_at→received_at");
    }
    if facts.mode.is_none() {
        gaps.push("mode→realtime(guess)");
    }
    if facts.device_label.is_none() {
        gaps.push("device_label→none(row cannot name its phone)");
    }
    match origin {
        // The normal case: this row's address IS this delivery (RV-72).
        RowIdOrigin::Request => {}
        RowIdOrigin::Entry => gaps.push(
            "request_id→absent(row addressed by entry_id: a RE-DELIVERY of this content \
             would land on THIS row instead of adding one — RV-72)",
        ),
        RowIdOrigin::Local => gaps.push(
            "request_id+entry_id→absent(local-only address: nothing can name this row again)",
        ),
    }
    // RV-75: only an image row can miss a preview, and when it does the user cannot
    // tell WHICH picture the row is — the row's whole content is the picture.
    if entry_type == "image" && facts.thumb_b64.is_none() {
        gaps.push("thumb_b64→absent(image row has no preview — it cannot be recognised)");
    }
    // RV-68, same rule and same reason as the preview above: only an image row can
    // miss its words, and when it does the row shows a picture with NOTHING under
    // it — which is the exact symptom that opened this card. It must self-report,
    // or the next time someone reads "that row on the PC has no words at all" off a real machine the
    // log will again be unable to say whether the sender omitted the caption or
    // this PC dropped it. (That is not hypothetical: this whole line exists
    // because it once could not answer that question about `source_text` — RV-75.)
    if entry_type == "image" && facts.entry_caption.is_none() {
        gaps.push("entry_caption→absent(image row has no words — nothing renders under the thumbnail)");
    }
    // RV-93, same rule again: only an image row can miss its FULL picture, and when
    // it does opening the full image silently degrades to an enlarged 256 px thumbnail. That is an
    // acceptable fallback and an unacceptable silence — the difference between
    // "this machine couldn't store it" and "this version simply never did it" is exactly what this line answers.
    if entry_type == "image" && item.get("full_image").is_none() {
        gaps.push("full_image→absent(picture not kept — opening the full image falls back to the thumbnail)");
    }
    format!(
        "row minted id={id} id_from={} channel={} status={} source={} entry_type={entry_type} \
         chars={} source_text={} gaps=[{}]",
        origin.tag(),
        channel.tag(),
        item["status"].as_str().unwrap_or("?"),
        req.source,
        req.text.chars().count(),
        facts.source_text.tag(),
        gaps.join(", "),
    )
}

/// What one delivery frame produced: the verdict to answer with, and the ADDRESS of
/// the row that was minted for it.
pub(in crate::socket) struct Minted {
    /// The verdict, byte-for-byte as handed in — this is what goes on the socket.
    pub result: Value,
    /// The id of the row [`mint_row`] just forwarded to the window. Handed back
    /// rather than recomputed because [`row_id`] is not pure (see its note), and
    /// because ONE producer of "what this row is called" is the whole point: the window must not
    /// re-derive the address from the echoed ids, or the rule would exist twice.
    pub row_id: String,
}

/// Mint the timeline row for one delivery frame and hand the verdict straight back.
///
/// The verdict is returned untouched, so the caller's control flow is unchanged and
/// there is no way to forget the row: the ONLY expression that yields the result is
/// the one that also mints the row.
///
/// `None` (the frame was deduped) ⇒ no row, and the dedup is recorded here rather
/// than at the call site so "why is there no row" and "why is there no receipt" are one line.
pub(in crate::socket) fn mint_row(
    sink: &Option<BridgeSink>,
    channel: Channel,
    frame: &Value,
    req: &InjectRequest,
    outcome: Option<Value>,
) -> Option<Minted> {
    let Some(result) = outcome else {
        forensic::record(
            "inject",
            &format!(
                "inject:request DEDUPED as a duplicate (request_id={:?}) — no result \
                 frame and NO TIMELINE ROW by design (ruling 2: one inject:result ⇔ one row); \
                 if this was NOT a duplicate the phone's watchdog will report \"the PC did not respond\"",
                req.request_id
            ),
        );
        return None;
    };
    let (id, origin) = row_id(req);
    let facts = RowFacts::read(frame);
    let received_at = forensic::fmt_utc(crate::socket::client::now_millis());
    let item = build_row(&id, req, &facts, &result, &received_at);
    // no silent failures: one greppable line per minted row that NAMES every value that
    // did not come off the frame. A row whose timestamp is really the receive time,
    // or whose mode is really a default, must be discoverable as such — "using the
    // receive time to stand in for the spoken time" is acceptable (there is no better answer), "pretending it IS the spoken time"
    // is not.
    forensic::record("timeline", &minted_line(&id, origin, channel, req, &facts, &item));
    // ONE implementation of "which channel brought this row" — the same stamp the (now
    // producer-less) server timeline frames carried, so the frontend keeps exactly
    // one narrowing for it. `tag_channel` can only fail on a non-object, and the
    // object is built on the line above; it is written as a record rather than an
    // unwrap so a later refactor cannot turn it into a panic — or into silence.
    let envelope = json!({ "item": item });
    match bridge::tag_channel(&envelope, channel.tag()) {
        Some(tagged) => bridge::forward(sink, bridge::channel::HISTORY_UPDATED, tagged),
        None => forensic::record(
            "timeline",
            &format!("row {id} could NOT be channel-stamped — the window never received it"),
        ),
    }
    Some(Minted { result, row_id: id })
}

/// Forward the verdict to THIS window, carrying the three CLIENT-LOCAL stamps the wire
/// frame cannot (`InjectResultSchema` has none of them; the copy emitted on the socket
/// stays exactly that schema). Lives here, beside the producer of the row they address,
/// rather than inline in the socket lifecycle.
///
///   · `channel` — owner 2026-07-30 ①. The timeline holds BOTH servers' rows, so
///     an id alone stopped being an address (RV-01) and only this machine knows which
///     of its two sockets carried the frame.
///   · `row_id` — RV-72. The verdict has to find the row this delivery just made, and
///     since the address is derived (`req:{request_id}`, or the local branch, which is
///     not reproducible at all) the ONE place that rule may live is [`row_id`]. The
///     window reads the answer; it must never re-derive it from the echoed ids, which
///     is how one rule becomes two implementations that drift.
///   · `entry_kind` — R6 T-4. `entry_type` is not on the frozen history wire shape, so
///     this PC's own knowledge of what it pasted is the only honest source for the image
///     chip.
pub(in crate::socket) fn forward_verdict(
    sink: &Option<BridgeSink>,
    channel: Channel,
    req: &InjectRequest,
    minted: &Minted,
) {
    let mut forwarded = minted.result.clone();
    if let Some(map) = forwarded.as_object_mut() {
        map.insert("channel".into(), Value::from(channel.tag()));
        map.insert("row_id".into(), Value::from(minted.row_id.clone()));
        if req.source == "image" {
            map.insert("entry_kind".into(), Value::from("image"));
        }
    }
    bridge::forward(sink, bridge::channel::INJECT_RESULT, forwarded);
}

#[cfg(test)]
#[path = "row_transit_tests.rs"]
mod row_transit_tests;
