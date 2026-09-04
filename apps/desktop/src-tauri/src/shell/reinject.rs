// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (owner architecture
//     ruling: the cloud does not store transcripts ⇒ the re-injected text is
//     supplied by the row's owner)
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//   docs/decisions/2026-07-30-rv45-is-an-optional-enhancement-not-a-prerequisite.md
//     (hard constraint: the two delivery paths must never let `injected` carry two meanings)
//   docs/rebuild/07-DESKTOP-SPEC.md §9 (the timeline's four operations — three of the four are LOCAL now)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Re-inject, locally. This module replaces `shell::history`, which held the
// timeline's four outbound wire verbs (`history:list` / `:update` / `:delete` /
// `:inject`). All four are gone in 0.2.27:
//
//   · list / update / delete — the server stores no transcripts, so there is no row
//     to read, edit or remove there. The PC has OWNED its rows since 0.2.26; an edit
//     or a delete is now a write to this machine's own store and nothing else, so it
//     needs no command at all.
//   · inject — kept as a VERB, dropped as a round trip. `history:inject{id}` made the
//     PC send an id so the server could look the text up and hand it straight back to
//     the same PC as an `inject:request`. The text has been in the PC's hands since
//     0.2.26 and the PC is the machine that types it, so the whole journey was
//     answering a question nobody had: 「谁知道这一行写的是什么」("who knows what this line says").
//
// WHY THIS IS ONE COMMAND AND NOT A SECOND PIPELINE. `injected` means one thing
// (owner 2026-07-30 ruling) and the RV-45 ruling makes that a hard constraint across
// delivery paths. So this command does not decide anything about injection: it
// resolves the session handle and calls `DesktopSocket::reinject_locally`, which runs
// the SAME `inject_ops::run_inject` on the SAME focus FSM, SPEAKING-lock deadline,
// dedup table and smoke allowlist that an inbound `inject:request` uses. Every rule
// the pipeline enforces — the process-wide injection gate, Stage-1 focus, Stage-1b
// 「可证明地不可输入就拒绝」("if it's provably not able to accept input, refuse"), cached-not-injected when there is no reachable target —
// applies here because it IS that pipeline.

use serde_json::Value;
use tauri::State;
use crate::socket::blocking::run_blocking;

use crate::socket::local_inject::{reinject_image_with_handles, reinject_text_with_handles, InjectHandles};

use super::{with_socket, SocketState};

/// Re-inject one row's text into this machine's focused window — no server, no round trip.
///
/// `text` is supplied by the row's OWNER (the PC's local timeline). `id` is the row's
/// own id, echoed onto the result as the A-58 correlation key (`entry_id`) so the store
/// can put the verdict on the right row. Both parameters are SINGLE WORDS: this
/// boundary's standing rule, so no camelCase-to-snake_case mapping is ever involved.
///
/// Returns the truthful `inject:result` payload, or `None` when NOTHING WAS TYPED —
/// which the page must state rather than re-render as a success (red line: a thing
/// that did not happen must never be said to have happened, 没做成的事不许说成做成了). `None` has exactly two causes and both are in the forensic log:
/// neither channel has a live session (so there is no focus FSM to resolve a target
/// against — see below), or `run_inject` deduped the request away — which TWO
/// independent facts prevent for this builder (RV-29 round, 2026-07-31: the old
/// phrasing 「`source:'history'` is on the bypass list」 named only the second and
/// the list no longer means what that sentence assumed):
///   · it mints NO `request_id`, so INJ-3 has no key to look up; and
///   · `source:'history'` skips the INJ-1 byte window
///     (`dedup::skips_the_inj1_byte_window`, renamed from `is_bypass_source`
///     because that name read as 「skips dedup」 — it only ever exempted INJ-1).
///
/// ⚠️ WHY A SESSION IS STILL REQUIRED, when the act itself needs no network.
/// The FSM that decides「往哪个窗口打」("which window to type into") is created per socket session
/// (`socket::client::connect`), and it is the ONLY holder of the SPEAKING lock: while
/// a phone is dictating, the target is the locked window, not whatever is in front
/// right now. Handing this command a fresh FSM would make it answer that question
/// differently from the socket path — a second meaning for `injected`, which is the
/// one thing the RV-45 ruling forbids. So it borrows the real one instead, and if no
/// session exists it refuses OUT LOUD. (The residual — that the inject-decision state
/// is session-owned at all, when a focused window is a machine-level fact — is
/// registered in the A1b report; lifting it means moving the FSM to process scope,
/// which is a change to the audited focus path and not this card's.)
///
/// `with_socket` (primary first, then the other resident channel) is deliberate and is
/// NOT the retired `row_op_channel` question. That one asked「这一行住在哪台服务器上」
/// ("which server does this row live on")
/// and could never fall back, because the wrong server would act on the wrong table.
/// Nothing here addresses a server: the question is「这台机器的注入状态在哪」("where is
/// this machine's injection state"), both
/// sessions' FSMs receive the same foreground fan-out (`focus::tracker` fans every
/// event to every resident channel), and only the PRIMARY channel is ever allowed to
/// lock one (`PrimaryGate` refuses a non-primary `audio:start`/`inject:request`), so
/// primary-first picks up the locked FSM whenever a lock exists.
///
/// P1-2 (2026-09-02 audit §3-D): the `SocketState` mutex is held only long enough to
/// clone the session's `InjectHandles` (four Arcs — microseconds), NOT for the whole
/// pipeline. The old shape ran `reinject_locally` (SendInput / clipboard-paste-and-hold,
/// up to 1.5s of PASTE_HOLD) inside `with_socket`'s closure, i.e. inside the lock guard —
/// freezing every other Tauri command that touches `SocketState` (settings, pairing, the
/// device page, every inbound socket handler) for that whole run. Marked `async` on top
/// of that so the wait itself is off the Tauri main thread (D1).
#[tauri::command(async)]
pub fn timeline_reinject(
    state: State<'_, SocketState>,
    text: String,
    id: String,
) -> Option<Value> {
    // P0 2026-09-03 — `#[tauri::command(async)]` puts this on a tokio
    // worker, and the body blocks on the inject pipeline (up to 1.5 s of PASTE_HOLD). See `socket::blocking`.
    run_blocking(|| {
        // The OUTER Option answers「有会话跑了这次补投吗」("did a session run this
        // re-inject") and the inner one「跑出结果了吗」("did it produce a result").
        // Two options rather than one because `with_socket`'s fallback is evaluated
        // eagerly: collapsing them would log 「没有会话」("no session") on every successful injection —
        // a forensic line that lies is worse than no line (vol. 13 §7).
        //
        // The lock is dropped as soon as this line returns — it only had to clone the
        // handle bundle, not run anything.
        let handles: Option<InjectHandles> = with_socket(&state, |s| Some(s.inject_handles()), None);
        let ran: Option<Option<Value>> = handles.map(|h| reinject_text_with_handles(&h, &text, &id));
        match ran {
            // A session ran it; `reinject_text_with_handles` already recorded the true outcome.
            Some(result) => result,
            None => {
                crate::forensic::record(
                    "timeline",
                    &format!(
                        "local re-inject REFUSED entry_id={id} — no resident session, so no focus \
                         state machine exists to resolve a target against; NOTHING was typed"
                    ),
                );
                None
            }
        }
    })
}

/// Re-inject one row's PICTURE into this machine's focused window (0.3.36 — the
/// 15-vol §2.5e-7 ① gap's PC half: read the file → clipboard → paste).
///
/// THE ORIGINAL ONLY, refused by name when it is gone. `picture_bytes_in` is
/// called with `thumb: None` on purpose: pasting the 256 px preview into the
/// user's document while the row reads as a re-send of the picture would be a
/// success claim the bytes do not support (R11). A missing original returns
/// `None` — nothing was pasted — with the cause on the forensic record, which
/// is the same contract `timeline_reinject` keeps for its own nothing-typed
/// cases. (The capsule's gate additionally withholds the button when the row
/// kept no original — `full_image` — so this arm is the store-level guard, not
/// the everyday path.)
///
/// Everything else is [`timeline_reinject`]'s doc verbatim: one pipeline, one
/// meaning of `injected`, no wire emission, session required and refused OUT
/// LOUD when absent.
#[tauri::command(async)]
pub fn timeline_reinject_image(state: State<'_, SocketState>, id: String) -> Option<Value> {
    // P0 2026-09-03 — `#[tauri::command(async)]` puts this on a tokio
    // worker, and the body blocks on the inject pipeline (up to 1.5 s of PASTE_HOLD). See `socket::blocking`.
    run_blocking(|| {
        let (mime, bytes, _which) = match crate::shell::clipboard_image::picture_bytes_in(
            &crate::socket::row_image::dir(),
            &id,
            None,
        ) {
            Ok(loaded) => loaded,
            Err(reason) => {
                crate::forensic::record(
                    "timeline",
                    &format!(
                        "local re-inject IMAGE REFUSED entry_id={id} — {reason}; NOTHING was pasted \
                         (original-only by design: a preview must not impersonate the picture)"
                    ),
                );
                return None;
            }
        };
        let b64 = crate::socket::row_image::encode_b64(&bytes);
        // Same P1-2 shape as `timeline_reinject`: the lock is held only to clone the
        // handle bundle, then dropped before the (potentially 1.5s) paste-and-hold runs.
        let handles: Option<InjectHandles> = with_socket(&state, |s| Some(s.inject_handles()), None);
        let ran: Option<Option<Value>> =
            handles.map(|h| reinject_image_with_handles(&h, &b64, mime.wire(), &id));
        match ran {
            Some(result) => result,
            None => {
                crate::forensic::record(
                    "timeline",
                    &format!(
                        "local re-inject IMAGE REFUSED entry_id={id} — no resident session, so no focus \
                         state machine exists to resolve a target against; NOTHING was pasted"
                    ),
                );
                None
            }
        }
    })
}
