// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer — dual channels always
//     resident: primary + presence background socket, a phone join on either
//     channel promotes it to primary)
//   docs/rebuild/02-FEATURE-INVENTORY.md L75 (PC dual-socket resident presence ✅)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-28/GA-29
//   docs/decisions/2026-07-26-dual-channel-spec-misref.md
//   CLAUDE.md red line: no silent failure · a latch closed by a remote event must have a local watchdog
//
// WHO OWNS THE CAPSULE — the one place that can answer it.
//
// The desktop keeps BOTH channels resident (07 §6). Each channel talks to a
// DIFFERENT server (the LAN sidecar / the cloud relay) and those two servers
// cannot see each other: the relay has no idea whether a phone is in the room on
// someone's local sidecar, and vice versa. So the rule owner stated —
// 「胶囊窗口只允许有且只有一台手机连接」("the capsule window may only ever have
// exactly one phone connected") — is NOT enforceable server-side. This
// process is the only vantage point that sees both channels at once, which is
// why the latch lives here.
//
// Three properties this type exists to guarantee:
//
//   · ONE OWNER. The first phone to join takes the capsule; a second phone (on
//     EITHER channel) is REFUSED, and the refusal is returned to the caller so it
//     can be said out loud on the wire. Silently dropping the second phone's
//     frames would show it a session that is recording into nothing — the exact
//     silent failure the red line forbids.
//   · PRIMARY FOLLOWS THE OWNER. The owner's channel is primary (it carries the
//     runtime: stt fan-out, inject, the control keys). With no owner there is
//     nothing to derive it FROM, so it falls back to the handshake-ROSTER evidence
//     ([`Admission::observe_roster`]) and only then to the process's construction
//     default (LAN — see lib.rs). owner 2026-07-30 ② deleted the user-settable
//     「主通道」("primary channel") that used to sit there: primary was never a
//     preference, it is a
//     CONSEQUENCE of「哪台手机被准入」("which phone was admitted"), and the timeline (the one surface a user
//     could tell the difference on) no longer asks this question at all.
//   · A LOCAL WATCHDOG THAT IS THE LATCH'S OWN. Ownership is released by a REMOTE
//     event (pc:mobile-left). A dead relay never sends one, so [`Admission::tick`]
//     releases an owner whose own channel has not been heard from for
//     [`OWNER_GRACE`] — the latch can never be held open by a peer that stopped
//     talking.
//
//     🔴 F8① — WHERE THAT WATCHDOG MAY NOT LIVE, and it cost a whole-app restart to
//     learn. The eviction used to be a line INSIDE the pump loop
//     (`pump.rs`, `admission.tick(channel, connected, now)`), i.e. the clock that
//     expires the latch ran on the thread owned by the very socket the latch was
//     waiting for. A cloud auth failure tears that socket down
//     (`shell/cloud.rs` → `sidecar_ctl::drop_socket` → `set_socket(.., None)` →
//     `DesktopSocket::drop` → `disconnect()` joins the pump thread), so the last
//     thing the teardown did was DELETE THE ONLY CALLER THAT COULD EVER FREE THE
//     CAPSULE. The 30 s grace never elapsed, the phone that owned the machine could
//     not be evicted, and the same phone arriving over LAN was met with
//     `Verdict::Refused` forever. Only restarting the app cleared it.
//
//     ⇒ THE RULE, which is the repo's own catalogue entry (「远端事件闭合的 latch
//     必须有本地看门狗」, "a latch closed by a remote event must have a local
//     watchdog") read one level stricter: **a watchdog that only ticks while
//     the thing it guards is alive is not a watchdog.** So the two halves are split
//     and they are split by OWNERSHIP, not by politeness:
//       · a channel's pump REPORTS its own socket health ([`Admission::observe_link`])
//         — it decides nothing, and it is allowed to disappear;
//       · the latch DECIDES ([`Admission::tick`]), driven by its own thread
//         ([`Admission::ensure_watchdog`]) which outlives every session.
//     And the decision reads the reports as PERISHABLE ([`LINK_REPORT_TTL`]):
//     silence is not「一切正常」("everything is fine"), it is evidence that the reporter is gone. That is
//     what makes this shape unable to repeat the defect — a future teardown path
//     that forgets to say anything is exactly the case the latch already handles.
//
// Tauri-free, and the decision is a pure function of (state, now): every rule above
// is unit-testable without a socket, a window, or a server. The one thread this
// module spawns is a 15-line wrapper that does nothing but call `tick` on a timer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use crate::socket::Channel;

/// How long the owning channel may be disconnected before the capsule is freed.
/// Deliberately longer than the socket ladder's first retries (1s→30s backoff, so
/// a healthy blip returns well inside this) and shorter than a user's patience:
/// the point is that a phone whose PC-side channel died cannot keep the capsule
/// reserved forever.
pub const OWNER_GRACE: Duration = Duration::from_secs(30);

/// F8① — how long ONE liveness report from a channel's pump stays meaningful.
///
/// The pump reports every tick (500 ms) for as long as it exists, so 2 s is four
/// missed reports: comfortably past an ordinarily busy tick, and far short of
/// [`OWNER_GRACE`]. Past this window the latch stops believing the last thing it
/// was told and reads the channel as DOWN.
///
/// 🔴 This constant is the entire reason the fix cannot rot. Without it the latch
/// would be trusting a value whose freshness depends on a reporter it does not own,
/// so 「泵没了」("the pump is gone") and 「泵刚说一切正常」("the pump just said
/// everything is fine") would be the same state — which is precisely
/// how the capsule stayed reserved for a phone nobody could reach.
pub const LINK_REPORT_TTL: Duration = Duration::from_secs(2);

/// How often the latch's own watchdog thread re-evaluates. RESOLUTION ONLY: the
/// deadline is [`OWNER_GRACE`] and it is measured from the reports themselves, so
/// this number can change without moving a single user-visible behaviour.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(1);

/// Who holds the capsule right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub channel: Channel,
    pub mobile_id: String,
}

/// The answer to「这台手机能不能用胶囊」("can this phone use the capsule").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// This mobile owns the capsule (it just took it, or already held it).
    Granted,
    /// Someone else holds it. The caller MUST tell the refused phone — see the
    /// module header on why a silent drop is not an option.
    Refused { holder: Owner },
}

struct Inner {
    owner: Option<Owner>,
    /// Which channel carries the runtime while NO phone owns the capsule.
    ///
    /// IMMUTABLE after construction, and deliberately so (owner 2026-07-30 ②): it
    /// used to be a user setting (`set_preferred`, the device page's channel
    /// select), i.e. a value the user was asked to choose that answered a question
    /// only the phones can answer. There is no phone to derive it from in this
    /// state, so it stays the process default and no UI pretends otherwise.
    no_owner_fallback: Channel,
    /// When this latch came into existence. Its ONLY use is the unreachable arm of
    /// [`Inner::quiet_since`] — see there for why the fallback leans toward freeing
    /// the capsule rather than holding it.
    born: Instant,
    /// F8① — the last thing each channel's pump said about its OWN socket, and WHEN
    /// it said it. `None` = that channel has never reported.
    ///
    /// The INSTANT is the load-bearing half. A bare bool would answer 「上次报告说什
    /// 么」("what did the last report say") and be silently reused as 「现在怎么样」
    /// ("how is it right now") — one value answering two
    /// questions, the repo's headline bug shape — and it is exactly that reuse that
    /// let a channel whose pump had been joined read as healthy forever.
    link_lan: Option<(bool, Instant)>,
    link_cloud: Option<(bool, Instant)>,
    /// RV-新C — did the LAST handshake ack on the LAN / cloud channel report a
    /// NON-EMPTY room? Written only by [`Admission::observe_roster`].
    ///
    /// NOT a presence set: `Reconciler` owns「这条通道的房里有哪些手机」("which
    /// phones are in this channel's room"), one per
    /// session, and copying it here would be a second answer to its question. This
    /// is the single BIT the latch needs in order to COMPARE the two channels, and
    /// this process is the only vantage point that sees both at once.
    roster_lan: bool,
    roster_cloud: bool,
    /// RV-新C — the channel the roster evidence points at, derived from the two
    /// flags above (see [`Admission::observe_roster`] for the rule and why a tie
    /// resolves to `None`). Consulted by [`Admission::primary`] ONLY while no phone
    /// owns the capsule; it is deliberately NOT an owner.
    inferred_channel: Option<Channel>,
}

impl Inner {
    fn link_of(&self, channel: Channel) -> Option<(bool, Instant)> {
        match channel {
            Channel::Lan => self.link_lan,
            Channel::Cloud => self.link_cloud,
        }
    }

    fn set_link(&mut self, channel: Channel, connected: bool, at: Instant) {
        match channel {
            Channel::Lan => self.link_lan = Some((connected, at)),
            Channel::Cloud => self.link_cloud = Some((connected, at)),
        }
    }

    /// 「这条通道从什么时候起就没动静了」("since when has this channel been quiet") — the ONE place that interprets a report, so
    /// no two readers can disagree about the same one.
    ///
    /// 🔴 F8① — this is derived ENTIRELY from the reports, never from the watchdog's
    /// own tick history. That is deliberate: an expiry that accumulated across ticks
    /// would answer differently depending on WHEN the watchdog started and HOW OFTEN
    /// it runs — i.e. the verdict would once again depend on somebody else's
    /// liveness, one level up from the defect this card closes.
    fn quiet_since(&self, channel: Channel, now: Instant) -> Instant {
        match self.link_of(channel) {
            // 「我连着」("I'm connected"), and then silence: it stopped counting when the report went
            // stale, not when we got round to looking.
            Some((true, at)) => at + LINK_REPORT_TTL,
            // It told us it was down. That is the ordinary reconnect blip, and the
            // grace runs from the moment it said so.
            Some((false, at)) => at,
            // Unreachable for an OWNER: `join` seeds a report from the join itself.
            // If that ever stops being true this leans toward FREEING the capsule
            // (a phone can always re-join) rather than holding a machine hostage on
            // the strength of never having heard anything — which is the exact
            // mistake F8① was.
            None => self.born.min(now),
        }
    }
}

/// The process-wide capsule-ownership latch. One instance is shared (Arc) by both
/// channel sessions; `None` in headless builds means「无闸门」("no gate"), which is exactly the
/// single-socket behaviour every existing test and the golden example already have.
pub struct Admission {
    inner: Mutex<Inner>,
    /// F8① — whether [`Admission::ensure_watchdog`] has already started this latch's
    /// thread. Outside the mutex because it is not part of the ownership decision.
    watchdog_started: AtomicBool,
}

impl Admission {
    /// `no_owner_fallback` is the channel [`Admission::primary`] answers with while
    /// there is neither an owner NOR roster evidence (lib.rs passes the LAN default).
    /// There is no setter — see [`Inner::no_owner_fallback`].
    pub fn new(no_owner_fallback: Channel) -> Self {
        Self {
            inner: Mutex::new(Inner {
                owner: None,
                no_owner_fallback,
                born: Instant::now(),
                link_lan: None,
                link_cloud: None,
                roster_lan: false,
                roster_cloud: false,
                inferred_channel: None,
            }),
            watchdog_started: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A phone joined `channel`'s room. Grants the capsule when it is free (or
    /// already this phone's), refuses otherwise.
    pub fn join(&self, channel: Channel, mobile_id: &str) -> Verdict {
        let mut g = self.lock();
        match &g.owner {
            Some(o) if o.channel == channel && o.mobile_id == mobile_id => Verdict::Granted,
            Some(o) => Verdict::Refused { holder: o.clone() },
            None => {
                g.owner = Some(Owner { channel, mobile_id: mobile_id.to_string() });
                // F8① — a phone arriving over this channel is first-hand evidence
                // that the channel is up RIGHT NOW, so seed the report with it. The
                // alternative is a window between the join and the channel's first
                // pump report in which the latch would read「从来没人报告过」("nobody has ever reported") as down
                // and start counting the grace against a phone that just walked in.
                g.set_link(channel, true, Instant::now());
                Verdict::Granted
            }
        }
    }

    /// A phone left. Releases the capsule ONLY when the departing phone is the
    /// holder — a non-owner leaving (the refused second phone giving up) must not
    /// hand the capsule away from whoever is still speaking.
    pub fn left(&self, channel: Channel, mobile_id: &str) {
        let mut g = self.lock();
        let is_holder = matches!(&g.owner, Some(o) if o.channel == channel && o.mobile_id == mobile_id);
        if is_holder {
            g.owner = None;
        }
    }

    /// B4 (iOS-2 §2-1, 2026-08-11) — release a holder that its OWN channel's
    /// APPLIED handshake roster disproves. Returns the evicted owner so the
    /// caller can put the WHY on the record (an ownership change with no trace
    /// is unexplainable in support).
    ///
    /// THE DEFECT THIS CLOSES (real iPad + Mac mini forensic): the cloud pump
    /// printed `mobiles=0` while the latch still answered `capsule held by
    /// 698f5fe3… on cloud`, so the iPad's LAN join was refused and every inject
    /// came back 「channel not primary」 — with NO second live phone anywhere.
    /// One process held two answers to 「云端房里有没有手机」("is there a phone in the cloud room"):
    ///   · the per-channel `Reconciler` set (reconcile.rs — the pump's
    ///     `mobiles=` count is its mirror), which an ack roster replaces
    ///     wholesale;
    ///   · this latch's `owner`, which until this method could ONLY be released
    ///     by the exact `pc:mobile-left` frame ([`Admission::left`]) or by the
    ///     link watchdog ([`Admission::tick`]).
    /// A left frame that fires while this side's socket is mid-reconnect is
    /// simply gone (socket.io replays nothing), and the link watchdog guards
    /// 「通道死了」("the channel is dead"), not 「房间空了」("the room is empty") — a healthy cloud socket over an empty room
    /// keeps reporting `connected=true` forever, so the latch stayed pinned to a
    /// phone that had already gone home. This method is the missing edge: the
    /// roster fact the desktop ALREADY holds, applied to the holder it already
    /// disproves.
    ///
    /// WHY EVENT-DRIVEN AND NOT A TIMER: the roster fact only ever changes on
    /// edges that all have call sites —
    ///   (a) a matching `pc:mobile-left` → [`Admission::left`] (pre-existing);
    ///   (b) an APPLIED ack roster → HERE, from the single roster funnel
    ///       (pairing.rs `apply_connected_mobiles`);
    ///   (c) `Reconciler::reset` on dead-token / auth:expired — deliberately NOT
    ///       wired here: losing our token says nothing about who is in the room.
    ///       On LAN the very next register ack's roster flows through (b); on
    ///       cloud the auth-failure hook drops the socket, whose ensuing silence
    ///       the link watchdog already converts into a release within
    ///       [`OWNER_GRACE`] (F8①).
    /// A timer would be a second clock guessing at a fact these edges carry.
    ///
    /// THE SERVER'S ~30 s MOBILE-DROP GRACE IS MIRRORED, NOT UNDERCUT. An
    /// APPLIED empty roster is not 「我们没听见那台手机」("we didn't hear from that phone") — it is the server's own
    /// `confirmedMobiles` answer (pc.handler.ts), which sys:pings every candidate
    /// and EVICTS the non-ponging ones from ITS store before answering. So this
    /// release can never run EARLIER than the server's own store eviction: a
    /// phone merely mid-flap produces NO roster event at all (the server defers
    /// `pc:mobile-left` through the grace and no ack leg runs), and a stale-empty
    /// snapshot racing a fresh join is stopped one layer up (the Suppressed arm
    /// of `apply_connected_mobiles` never calls here — JOINED_SUPPRESS). When the
    /// probe DOES evict a flapping phone, its comeback is a fresh presence to the
    /// server ⇒ a fresh `pc:mobile-joined` ⇒ [`Admission::join`] re-grants
    /// (fix-001 re-announces on every slot-take, so that edge is guaranteed).
    ///
    /// THE SINGLE-HOLDER RULE (owner 2026-08-11:「胶囊只许一台手机」, "the capsule
    /// only allows one phone") IS NOT
    /// WEAKENED: this only RELEASES on the server's confirmed evidence about the
    /// holder's OWN channel. It never grants, never writes an owner, and a holder
    /// on the OTHER channel is untouched — that channel's roster says nothing
    /// about it.
    ///
    /// The test is 「holder absent from the roster」, not 「roster empty」: the ack
    /// roster is a WHOLE-SET replace of confirmed-live phones on this channel
    /// (GA-26), so a roster naming only OTHER phones disproves the holder exactly
    /// as hard as an empty one does.
    pub fn reconcile_holder(&self, channel: Channel, ids: &[String]) -> Option<Owner> {
        let mut g = self.lock();
        match &g.owner {
            Some(o) if o.channel == channel && !ids.iter().any(|id| id == &o.mobile_id) => {
                g.owner.take()
            }
            _ => None,
        }
    }

    /// F8① — a channel's pump REPORTING its own socket health. Pure bookkeeping: it
    /// decides nothing, returns nothing, and the caller is allowed to stop calling
    /// it at any moment (that is the whole point — see the module header). The
    /// decision it feeds is [`Admission::tick`].
    ///
    /// `now` is a parameter rather than a second `Instant::now()` inside so the
    /// tests can drive a whole session's timeline without sleeping through it.
    pub fn observe_link(&self, channel: Channel, connected: bool, now: Instant) {
        self.lock().set_link(channel, connected, now);
    }

    /// The LOCAL watchdog's ENTIRE decision, and it takes NO channel argument on
    /// purpose: 「是谁的通道」("whose channel is it") is the latch's own business, and asking the caller to
    /// name it is what let the answer disappear along with a socket. Frees the
    /// capsule once the OWNING channel has failed to show itself alive for
    /// [`OWNER_GRACE`], and returns the owner it evicted so the caller can record it
    /// (an ownership change that leaves no trace is unexplainable in support).
    ///
    /// Called by [`Admission::ensure_watchdog`]'s thread in production. Pure in
    /// `now`, so the tests below drive it at synthetic instants.
    pub fn tick(&self, now: Instant) -> Option<Owner> {
        let mut g = self.lock();
        let channel = g.owner.as_ref()?.channel;
        if now.saturating_duration_since(g.quiet_since(channel, now)) < OWNER_GRACE {
            return None;
        }
        g.owner.take()
    }

    /// F8① — start the latch's OWN watchdog thread. Idempotent, and deliberately so:
    /// the one production caller is `shell::sidecar_ctl::admission_of`, which runs
    /// every time a session is dialled, so 「表在跑吗」("is the watchdog running") stops depending on any single
    /// one of those sessions still existing.
    ///
    /// The thread holds a [`Weak`], so it belongs to the LATCH's lifetime and to
    /// nothing else: it cannot be joined by a socket teardown (that was the defect),
    /// and it cannot keep a dead latch alive either — it returns the first time the
    /// upgrade fails.
    ///
    /// ⚠️ Not called by headless callers, and they need nothing: they pass
    /// `admission: None`, so there is no latch and no capsule to arbitrate.
    pub fn ensure_watchdog(latch: &Arc<Admission>) {
        if latch.watchdog_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak: Weak<Admission> = Arc::downgrade(latch);
        let spawned = std::thread::Builder::new()
            .name("flowmic-admission-watchdog".to_string())
            .spawn(move || loop {
                std::thread::sleep(WATCHDOG_INTERVAL);
                let Some(latch) = weak.upgrade() else { return };
                if let Some(evicted) = latch.tick(Instant::now()) {
                    crate::forensic::record(
                        "admission",
                        &format!(
                            "capsule freed by watchdog — {} on {} unreachable for {}s",
                            evicted.mobile_id,
                            evicted.channel.tag(),
                            OWNER_GRACE.as_secs()
                        ),
                    );
                }
            });
        if let Err(e) = spawned {
            // Fail loud, and leave the door open for the next session to retry —
            // a latch with no watchdog is the exact state F8① describes.
            latch.watchdog_started.store(false, Ordering::SeqCst);
            crate::forensic::record(
                "admission",
                &format!("FAILED to start the capsule watchdog thread ({e}) — the capsule can be held open by a dead channel until one starts"),
            );
        }
    }

    /// RV-新C — a handshake ack's `connectedMobiles` roster, from the session on
    /// `channel` (pairing.rs `apply_connected_mobiles`, the single entry point).
    /// Returns the roster-derived channel afterwards, for the caller's forensic line.
    ///
    /// TWO QUESTIONS, AND WHY THE ROSTER MAY ANSWER ONLY ONE OF THEM.
    ///
    /// The roster answers 「这条通道的房间里现在有哪些手机」("which phones are
    /// currently in this channel's room"). [`Owner`] answers 「哪一台
    /// 手机在用这台电脑」("which phone is using this PC"). Those are different questions, and this method deliberately
    /// answers NEITHER with the other: it never writes `owner`. What it feeds is a
    /// THIRD question — 「哪条通道在带运行时」("which channel is carrying the
    /// runtime") ([`Admission::primary`]) — for which a
    /// roster is real evidence, because a phone can only be in a room it paired into
    /// on THIS machine, so a non-empty room on a channel means that channel has a
    /// phone talking to this PC.
    ///
    /// The defect this closes (RV-新C, a user-visible regression): `owner` can only
    /// be moved by `pc:mobile-joined` / `pc:mobile-left`, and a phone that is ALREADY
    /// in the room when the desktop restarts never sends a fresh join. So a pure-cloud
    /// user's whole session ran with no owner ⇒ `primary()` answered the construction
    /// default (LAN) ⇒ every inject came back `INJECT_NOT_PRIMARY` and the capsule
    /// never floated. It used to be masked by the stored「主通道」("primary channel") setting; deleting
    /// that setting (owner 2026-07-30 ②) uncovered it.
    ///
    /// THE DECIDING RULE, written down because a tie must not be resolved by
    /// whichever ack happened to land first:
    ///   · exactly ONE channel's last ack reported a non-empty room ⇒ that channel;
    ///   · BOTH did ⇒ `None`. Two rooms with phones in them do not distinguish which
    ///     one is driving this PC, and the honest answer to a question the evidence
    ///     cannot settle is the process default — i.e. exactly the pre-fix behaviour,
    ///     not a coin toss whose outcome the user would see in the HUD;
    ///   · NEITHER did ⇒ `None`, same fallback.
    /// The rule is a pure function of the two stored bits, so it is IDEMPOTENT and
    /// ORDER-INDEPENDENT: re-observing in the other sequence lands on the same answer.
    ///
    /// ABSENT ≠ EMPTY is upheld by NOT CALLING here at all: `apply_connected_mobiles`
    /// already returns before this when the server sent no roster field (RV-08), so a
    /// server too old to speak of rosters leaves both bits untouched. One semantic,
    /// one place — no second copy of that rule.
    ///
    /// STALENESS is bounded by construction rather than by bookkeeping: the evidence
    /// is only ever consulted while NO phone owns the capsule, and any phone that
    /// actually does something produces an owner (`join`), which outranks it. So the
    /// worst a stale bit can do is point `primary()` at the channel where a phone was
    /// most recently seen instead of at the construction default — with nothing
    /// injecting either way.
    pub fn observe_roster(&self, channel: Channel, ids: &[String]) -> Option<Channel> {
        let mut g = self.lock();
        match channel {
            Channel::Lan => g.roster_lan = !ids.is_empty(),
            Channel::Cloud => g.roster_cloud = !ids.is_empty(),
        }
        g.inferred_channel = match (g.roster_lan, g.roster_cloud) {
            (true, false) => Some(Channel::Lan),
            (false, true) => Some(Channel::Cloud),
            _ => None,
        };
        g.inferred_channel
    }

    /// The channel currently carrying the runtime, most-specific evidence first:
    ///   1. the OWNER's channel — 「哪台手机被准入」("which phone was admitted"), the only thing a phone announced;
    ///   2. RV-新C: the handshake ROSTER's channel — 「哪条通道的房里有手机」("which
    ///      channel's room has a phone in it"), which is
    ///      the only evidence that exists in the window where a phone was already in
    ///      the room before this process started (see [`Admission::observe_roster`]);
    ///   3. the construction fallback — no evidence at all.
    ///
    /// There is no setter for the fallback (owner 2026-07-30 ②): primary is derived,
    /// never chosen. Note that 2 does NOT make anybody an owner — [`Admission::owner`]
    /// still answers only for phones that announced themselves, which is what keeps a
    /// roster from ever refusing a real phone in [`Admission::join`].
    pub fn primary(&self) -> Channel {
        let g = self.lock();
        g.owner
            .as_ref()
            .map(|o| o.channel)
            .or(g.inferred_channel)
            .unwrap_or(g.no_owner_fallback)
    }

    pub fn is_primary(&self, channel: Channel) -> bool {
        self.primary() == channel
    }

    pub fn owner(&self) -> Option<Owner> {
        self.lock().owner.clone()
    }
}

/// The order the two slots are consulted for an OUTBOUND verb: primary first,
/// then the other channel.
///
/// The fallback is deliberate. Primary is where the timeline and settings the user
/// is looking at live, so it goes first. But if that channel has no live socket
/// while the other one does, reporting failure would be false — there IS a working
/// connection. Only when BOTH are empty does the caller get the honest 「未连接」("not connected").
pub fn fallback_order(primary: Channel) -> [Channel; 2] {
    match primary {
        Channel::Lan => [Channel::Lan, Channel::Cloud],
        Channel::Cloud => [Channel::Cloud, Channel::Lan],
    }
}

// `row_op_channel` was DELETED in 0.2.27, and the finding it enforced is recorded
// here rather than in a function with no caller.
//
// RV-01: a verb that names a ROW must travel that row's OWN channel, never `primary`
// and never a fallback — `history:update` / `:delete` / `:inject` addressed a
// `transcript_history` row and the two channels are two servers with two of those
// tables, so borrowing the other socket asked a server to edit a row it had never
// heard of (`SETTINGS_SYNC_FAIL: no such entry`) while the desktop showed the row as
// edited (owner 2026-07-29:「提示成功，但仍然还在」("it showed success, but it's
// still there"), the same defect v0.2.7 fixed on
// `pc:release-mobile`). Those three verbs were its ONLY callers and they are retired
// with the server's transcript store (owner architecture ruling) — no id-addressed WIRE verb is
// left, so keeping the router would be a rule guarding nothing, which is exactly the
// façade shape this repo keeps paying for. `(channel, id)` remains a row's only
// ADDRESS in the frontend (`bridge::tag_channel`); what is gone is the routing.

// Tests split out at the 800-line file-size cap (B4 pushed this file over) —
// the `dedup_tests.rs`/`pairing_tests.rs` move. `super::*` there IS this module.
#[cfg(test)]
#[path = "admission_tests.rs"]
mod tests;
