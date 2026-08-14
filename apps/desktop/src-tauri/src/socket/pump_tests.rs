// Unit tests for the pump's pure decision cores — the tray-state map, the two
// focus sinks, the SPEAKING-lock watchdog predicate, the RV-26/RV-34 register-ack
// watchdog ladder and the CONNECTION frame — kept in a sibling file so pump.rs
// stays under the 800-line source cap.
//
// Same move, and the same reason, as client.rs -> client_tests.rs: the subject
// under test did not change, only where the assertions live.

use super::*;

/// U6 — the tests pin zh-CN explicitly (the product default) instead of reading
/// the process-wide locale, so they cannot race a test that moves it.
fn tray_state_zh(
    connected: bool,
    registered: bool,
    mobiles: usize,
    recording: bool,
) -> (&'static str, String, String) {
    tray_state(crate::ui_i18n::UiLocale::ZhCn, connected, registered, mobiles, recording)
}

#[test]
fn tray_state_three_derivable_states_never_fabricate() {
    // Only the three signals the pump actually has: connected+registered,
    // mobiles count, recording (SPEAKING lock). No device-name / owner /
    // observer / grace fabrication (07 §7 gaps stay gaps).
    let (id, tip, status) = tray_state_zh(false, false, 0, false);
    assert_eq!(id, "disconnected");
    assert!(tip.contains("未连接"));
    assert_eq!(status, "● 未连接");

    let (id, tip, status) = tray_state_zh(true, true, 2, false);
    assert_eq!(id, "connected-idle");
    assert!(tip.contains("2"));
    assert_eq!(status, "● 已连接 · 2 台手机");

    let (id, tip, status) = tray_state_zh(true, true, 1, true);
    assert_eq!(id, "recording");
    assert!(tip.contains("录音"));
    assert_eq!(status, "● 录音中");

    // registered=false while socket is up still counts as disconnected —
    // pairing incomplete is not "idle".
    let (id, _, _) = tray_state_zh(true, false, 3, true);
    assert_eq!(id, "disconnected");
}

/// U6 — the tray speaks the app language. Same three states, every supported
/// locale: the strings come from the ui_i18n table keyed by the SAME tags the
/// frontend persists, and the `{n}` placeholder is really substituted (a
/// translation that lost it would render a literal "{n}" on the tray).
#[test]
fn tray_state_is_localized_in_every_supported_language() {
    use crate::ui_i18n::UiLocale;

    // en spot checks — the audit's user story is "an English user sees Chinese".
    let (_, tip, status) = tray_state(UiLocale::En, false, false, 0, false);
    assert_eq!(tip, "FlowMic — not connected");
    assert_eq!(status, "● Not connected");
    let (_, tip, status) = tray_state(UiLocale::En, true, true, 2, false);
    assert_eq!(tip, "FlowMic — connected (2 phone(s) online)");
    assert_eq!(status, "● Connected · 2 phone(s)");
    let (_, tip, status) = tray_state(UiLocale::En, true, true, 1, true);
    assert_eq!(tip, "FlowMic — recording");
    assert_eq!(status, "● Recording");

    // Every locale: the state ids are locale-independent (the icon keys off
    // them), no un-substituted placeholder ever reaches the tray, and the
    // count really appears in the connected strings.
    for locale in UiLocale::ALL.iter().copied() {
        for (conn, reg, mob, rec) in
            [(false, false, 0, false), (true, true, 3, false), (true, true, 1, true)]
        {
            let (id, tip, status) = tray_state(locale, conn, reg, mob, rec);
            assert!(matches!(id, "disconnected" | "connected-idle" | "recording"));
            assert!(!tip.contains('{') && !status.contains('{'), "unfilled placeholder in {locale:?}: {tip:?} / {status:?}");
        }
        let (_, tip, status) = tray_state(locale, true, true, 3, false);
        assert!(tip.contains('3') && status.contains('3'), "{locale:?} lost the phone count");
    }
}

#[test]
fn one_foreground_change_feeds_both_the_wire_mirror_and_the_frontend() {
    // GA-25 core: a single change judgment drives BOTH sinks when a phone is
    // present — the capsule stops showing the last injection's target.
    assert_eq!(
        focus_emits(true, true, true, false),
        FocusEmits { to_frontend: true, to_server: true }
    );
}

#[test]
fn frontend_sink_is_never_mobile_gated_but_the_wire_mirror_is() {
    // No phone (or not registered) → the F-3113 PRIVACY gate silences the wire,
    // and ONLY the wire. The frontend channel still fires: it is Tauri IPC to
    // our own WebView, so it has no privacy face.
    let e = focus_emits(true, true, false, true);
    assert!(e.to_frontend, "frontend must update with no phone present");
    assert!(!e.to_server, "the window title must not travel with no receiver");
}

#[test]
fn unchanged_foreground_emits_nothing_except_a_stale_wire_re_mirror() {
    // Same throttle for both sinks: no change → no frontend push.
    let quiet = focus_emits(false, true, true, false);
    assert_eq!(quiet, FocusEmits::default(), "change-only throttle holds");
    // …but a room that was empty since the last mirror must be re-fed on join
    // even though the foreground never moved (pre-GA-25 `last_focus = None`).
    let rejoin = focus_emits(false, true, true, true);
    assert!(rejoin.to_server, "mobile join re-mirrors the current focus");
    assert!(!rejoin.to_frontend, "…without a redundant frontend push");
}

#[test]
fn absent_foreground_reaches_the_frontend_but_never_the_wire() {
    // Null HWND → no target. The capsule needs the (empty) sample so it can
    // fall back to "—" instead of freezing on a stale window title; the wire
    // mirror stays silent exactly as it did before GA-25.
    let e = focus_emits(true, false, true, true);
    assert!(e.to_frontend);
    assert!(!e.to_server);
}

#[test]
fn watchdog_expired_only_on_a_reached_armed_deadline() {
    let now = Instant::now();
    assert!(!watchdog_expired(None, now), "no deadline → never expired");
    assert!(
        !watchdog_expired(Some(now + Duration::from_secs(5)), now),
        "future deadline → not yet"
    );
    assert!(
        watchdog_expired(Some(now - Duration::from_millis(1)), now),
        "past deadline → expired"
    );
}

#[test]
fn the_connection_frame_no_longer_calls_a_token_a_registration() {
    // The literal 0.2.19 forensic shape: `connected=false registered=true`. The
    // frame now answers both questions separately, so the UI can tell "the server
    // recognized me" from "this machine has paired before" instead of one word doing both jobs.
    let mut creds = Credentials::fresh("Test PC");
    creds.accept_registration("fm_tok", Some("pc-1".into()), Some("room-7".into()));
    let shared: SharedCreds = Arc::new(Mutex::new(creds));

    let down = build_connection(&shared, false, false, 0, "pump", Channel::Cloud, false);
    assert_eq!(down["connected"], false);
    assert_eq!(down["registered"], false, "a socket that is DOWN is not registered");
    assert_eq!(down["has_token"], true, "…and the token is still reported, by name");
    assert_eq!(down["room_uuid"], "room-7");

    // Connected but the handshake has not landed: yellow, not green (conn-dot.ts).
    let waiting = build_connection(&shared, true, false, 0, "pump", Channel::Lan, true);
    assert_eq!(waiting["registered"], false);
    assert_eq!(waiting["has_token"], true);

    let up = build_connection(&shared, true, true, 2, "pump", Channel::Lan, true);
    assert_eq!(up["registered"], true);
    assert_eq!(up["mobiles"], 2);
}

// ── F3 (owner 2026-08-02: "the tray is always a red dot, but I'm not speaking") ────────────────────
//
// Every assertion below lands on the TRAY STATE ID or the FSM STATE — never on
// "some function was called". The bug being fixed is precisely that a function WAS called
// (`force_release` exists, `watchdog_expired` exists) and the icon stayed red
// anyway, so "it got called" is exactly the evidence that proves nothing here.
//
// They also drive `speaking_watchdog_tick` — THE function the pump loop calls —
// rather than re-implementing its branch in the test body, so neutering the real
// watchdog turns these red instead of leaving them green against a pump that no
// longer has one.

/// One pump tick of the SPEAKING-lock watchdog, at an injected `now`. Returns what
/// the tray is told this tick.
fn tick(
    fsm: &Mutex<FocusStateMachine>,
    deadline: &Mutex<Option<Instant>>,
    liveness: &SpeakLiveness,
    since: &mut Option<Instant>,
    now: Instant,
    cap: Duration,
) -> bool {
    speaking_watchdog_tick(fsm, deadline, liveness, since, now, cap, "test")
}

/// 🔴 THE GAP 0.2.48 SHIPPED. `lock_deadline` has exactly ONE arming site —
/// `audio:start` in client.rs — but `Injecting` is "recording" to the tray too and
/// is reachable straight from `Idle` with that deadline still `None`: a local reinject
/// (`local_inject::reinject_locally` → `inject_ops::run_inject` → `InjectStarted`),
/// or any `inject:request` that lands after the deadline already fired and disarmed.
#[test]
fn an_injecting_lock_that_no_audio_start_armed_was_watched_by_nothing() {
    use crate::focus::FocusEvent;

    // The OLD watchdog's own unit test says it: "no deadline → never expired".
    // That is not a corner case here — it is the state a timeline reinject lives in.
    assert!(
        !watchdog_expired(None, Instant::now()),
        "the event-armed watchdog is structurally blind to an unarmed lock"
    );

    let fsm = Arc::new(Mutex::new(FocusStateMachine::new(300)));
    {
        let mut m = fsm.lock().unwrap();
        m.handle(
            FocusEvent::ForegroundChanged {
                hwnd: 0x42,
                app_name: "notepad".into(),
                window_title: "n".into(),
            },
            0,
        )
        .unwrap();
        // No audio:start anywhere in this sequence — this is the reinject shape.
        m.handle(FocusEvent::InjectStarted, 1).unwrap();
        assert!(matches!(m.state(), FocusState::Injecting { .. }));
    }
    // …and the tray calls that recording. With no deadline armed, on 0.2.48, forever.
    assert_eq!(
        tray_state_zh(true, true, 1, fsm_is_recording(&fsm)).0,
        "recording",
        "an unarmed Injecting lock still paints the tray red"
    );

    // Drive the SHIPPING watchdog. It needs no arming site: it times the state.
    let deadline: Mutex<Option<Instant>> = Mutex::new(None); // nothing ever armed it
    let liveness = SpeakLiveness::new(); // never signalled — there was no utterance
    let cap = Duration::from_secs(32);
    let mut since = None;
    let t0 = Instant::now();

    let rec = tick(&fsm, &deadline, &liveness, &mut since, t0, cap);
    assert_eq!(tray_state_zh(true, true, 1, rec).0, "recording", "not yet at the cap");

    let rec = tick(&fsm, &deadline, &liveness, &mut since, t0 + cap, cap);
    assert_eq!(
        tray_state_zh(true, true, 1, rec).0,
        "connected-idle",
        "the tray stops claiming recording once the watchdog releases an UNARMED lock"
    );
    assert_eq!(fsm.lock().unwrap().state(), &FocusState::Idle);
}

/// The owner-visible symptom end to end: `audio:start` locked the FSM, then the link
/// died mid-utterance. No `stt:*`, no final, no `inject:request` — nothing that could
/// close the latch ever arrives again (red line: "a latch closed by a remote event must have a local watchdog").
#[test]
fn a_link_that_dies_mid_utterance_stops_painting_the_tray_red() {
    let fsm = Arc::new(Mutex::new(FocusStateMachine::new(300)));
    fsm.lock().unwrap().force_lock(0xABCD, "chrome".into(), "x".into());
    let cap = Duration::from_secs(32);
    let t0 = Instant::now();
    // audio:start armed the deadline and was the last signal this utterance gets.
    let deadline: Mutex<Option<Instant>> = Mutex::new(Some(t0 + cap));
    let liveness = SpeakLiveness::new();
    liveness.signal_at(t0);
    let mut since = Some(t0);

    // Inside the cap the lock is respected: a real utterance must not be killed.
    let rec = tick(&fsm, &deadline, &liveness, &mut since, t0 + Duration::from_secs(31), cap);
    assert_eq!(tray_state_zh(true, true, 1, rec).0, "recording");

    // Past the cap with total signal starvation → released. The assertion is on the
    // TRAY, because the tray is what the owner was looking at.
    let rec = tick(&fsm, &deadline, &liveness, &mut since, t0 + Duration::from_secs(33), cap);
    assert_eq!(tray_state_zh(true, true, 1, rec).0, "connected-idle");
    assert_eq!(fsm.lock().unwrap().state(), &FocusState::Idle);
    assert!(deadline.lock().unwrap().is_none(), "the armed deadline is disarmed with it");
}

/// The other half of the red line: a watchdog that fixes the red dot by killing real
/// utterances is not a fix. Audio still flowing ⇒ the lock is never touched.
#[test]
fn a_long_utterance_that_keeps_streaming_is_never_force_released() {
    let fsm = Arc::new(Mutex::new(FocusStateMachine::new(300)));
    fsm.lock().unwrap().force_lock(0x1, "word".into(), "doc".into());
    let cap = Duration::from_secs(32);
    let t0 = Instant::now();
    let deadline: Mutex<Option<Instant>> = Mutex::new(Some(t0 + cap)); // armed at audio:start
    let liveness = SpeakLiveness::new();
    let mut since = Some(t0);
    let mut now = t0;

    // Three minutes of speech at one stt:level / stt:interim every 500 ms.
    for _ in 0..360 {
        liveness.signal_at(now);
        now += Duration::from_millis(500);
        let rec = tick(&fsm, &deadline, &liveness, &mut since, now, cap);
        assert_eq!(
            tray_state_zh(true, true, 1, rec).0,
            "recording",
            "the lock must hold while audio is still arriving"
        );
    }
    // 🔴 WHAT THIS PROVES ABOUT 0.2.48 — hole ②. The deadline armed at `audio:start`
    // reached its cap 2.5 minutes ago, and on 0.2.48 that ALONE force-released the
    // lock: mid-sentence, with audio still arriving, 07 §3's SPEAKING-lock invariant
    // silently stopped holding and a later window switch could move the inject
    // target. It is evidence in the forensic line now, not the verdict.
    assert!(watchdog_expired(*deadline.lock().unwrap(), now), "the armed deadline HAS expired");
    assert!(matches!(fsm.lock().unwrap().state(), FocusState::SpeakingLocked { .. }));

    // …and the moment the audio stops, the cap runs from the LAST signal.
    let rec = tick(&fsm, &deadline, &liveness, &mut since, now + cap, cap);
    assert_eq!(tray_state_zh(true, true, 1, rec).0, "connected-idle");
}

/// 🔴 The SECOND F3 mechanism, which needs no wedged FSM at all: the tray's
/// "only on change" memo used to be PER PUMP THREAD while the tray is ONE icon
/// (`shell/tray.rs` builds a single TrayIconBuilder and TRAY_STATE has exactly one
/// listener), and `primary` FLIPS at runtime (`Admission::primary`).
#[test]
fn a_primary_flip_cannot_leave_the_tray_showing_the_other_channels_last_truth() {
    // Cloud is primary and its phone is speaking → the icon goes red.
    let (_, recording_tip, _) = tray_state_zh(true, true, 1, true);
    let cloud_last_sent = Some(recording_tip.clone());
    let icon_is_showing = recording_tip.clone();

    // The phone leaves cloud; primary falls back to LAN. Nothing changed on the LAN
    // channel this whole time, so LAN's OWN memo already equals its current tooltip.
    let (_, lan_tip, _) = tray_state_zh(true, true, 0, false);
    let lan_last_sent = Some(lan_tip.clone());
    assert_ne!(icon_is_showing, lan_tip, "the icon and the truth have diverged");

    // 🔴 With the per-pump memo the new primary forwards NOTHING…
    assert!(
        !tray_forward_needed(true, lan_last_sent.as_deref(), &lan_tip),
        "0.2.48: LAN's own memo suppresses the only frame that could fix the icon"
    );
    // …so the icon keeps showing what CLOUD last said. Red, with nobody speaking.
    assert_eq!(icon_is_showing, cloud_last_sent.unwrap());

    // ✅ With the process-wide memo the throttle asks "what's the tray currently showing", which
    // is the only question one icon can be asked.
    assert!(tray_forward_needed(true, Some(icon_is_showing.as_str()), &lan_tip));
    // …and it is still a real throttle: no change ⇒ no forward.
    assert!(!tray_forward_needed(true, Some(lan_tip.as_str()), &lan_tip));
    // …and a non-primary channel still never writes to the tray (GA-28 unchanged).
    assert!(!tray_forward_needed(false, Some(icon_is_showing.as_str()), &lan_tip));
}

/// The property the test above CANNOT check: that the memo is actually shared.
/// Reverting it to a pump-thread local would leave every assertion above green and
/// the icon stale again, so this one drives the real seam twice — once as each pump.
///
/// ⚠️ Sole user of the process-wide `TRAY_SHOWING`; if a second test ever touches it,
/// they must be serialised or this becomes flaky under the parallel test runner.
#[test]
fn the_tray_change_memo_is_shared_by_both_pumps_because_there_is_one_icon() {
    use std::sync::mpsc;

    let (_, red, _) = tray_state_zh(true, true, 1, true);
    let (_, green, _) = tray_state_zh(true, true, 0, false);

    // TWO REAL THREADS, because that is the axis the bug lived on: a memo that is
    // per-PUMP is per-THREAD, and a single-threaded version of this test stays green
    // against exactly the implementation being fixed.
    let (lan_go, lan_wait) = mpsc::channel::<()>();
    let (lan_said, lan_answer) = mpsc::channel::<bool>();
    let g = green.clone();
    let lan = std::thread::spawn(move || {
        // LAN is primary at startup and paints the idle tooltip.
        lan_said.send(tray_take_forward(true, &g)).unwrap();
        lan_wait.recv().unwrap();
        // …primary came back to LAN. Nothing changed on THIS channel in the meantime,
        // so a per-pump memo would say "what I sent last time is exactly this" and stay silent.
        lan_said.send(tray_take_forward(true, &g)).unwrap();
    });
    assert!(lan_answer.recv().unwrap(), "LAN's first paint goes out");

    // primary flips to CLOUD, whose phone is speaking → the icon goes red.
    let r = red.clone();
    std::thread::spawn(move || {
        assert!(tray_take_forward(true, &r), "cloud paints the icon red");
        assert!(!tray_take_forward(true, &r), "…and is still throttled on repeat");
    })
    .join()
    .unwrap();

    lan_go.send(()).unwrap();
    assert!(
        lan_answer.recv().unwrap(),
        "the returning primary MUST be able to correct an icon it did not paint — \
         this is the assertion a per-pump memo fails, leaving the tray red with \
         nobody speaking"
    );
    lan.join().unwrap();

    // A non-primary pump never writes, however wrong the icon looks to it (GA-28).
    assert!(!tray_take_forward(false, &red));
}

#[test]
fn expired_watchdog_force_releases_a_wedged_lock_and_disarms() {
    // Replicates the pump's expiry branch: an armed lock past its deadline is
    // force-released back to Idle and the deadline cleared (07 §3 / ruling 2).
    let fsm = Arc::new(Mutex::new(FocusStateMachine::new(300)));
    let deadline: Arc<Mutex<Option<Instant>>> =
        Arc::new(Mutex::new(Some(Instant::now() - Duration::from_millis(1))));
    fsm.lock().unwrap().force_lock(0xABCD, "notepad".into(), "n".into());
    assert!(matches!(fsm.lock().unwrap().state(), FocusState::SpeakingLocked { .. }));

    let expired = watchdog_expired(*deadline.lock().unwrap(), Instant::now());
    assert!(expired, "deadline is in the past");
    if expired {
        fsm.lock().unwrap().force_release();
        *deadline.lock().unwrap() = None;
    }
    assert_eq!(fsm.lock().unwrap().state(), &FocusState::Idle, "lock self-released");
    assert!(deadline.lock().unwrap().is_none(), "watchdog disarmed");
}
