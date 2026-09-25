// SPEC-REF: L-4 actual external GTK editor, actual XTEST events and buffer reads.
use super::tests::Peer;
use super::*;
use crate::inject::{self, ClipboardFallbackClient};

fn activate(peer: &Peer, owner: &mut Owner) -> u64 {
    peer.command("focus");
    peer.wait_ack(owner);
    let target = String::from_utf8(peer.wait_file("xid"))
        .unwrap()
        .parse::<u64>()
        .unwrap();
    // Independent fixture focuses the real external GTK window. The subject's
    // expected-target check reads the X server; no focus result is faked here.
    unsafe {
        (owner.connection.api.XSetInputFocus)(
            owner.connection.display,
            target as _,
            xlib::RevertToParent,
            xlib::CurrentTime,
        );
    }
    owner.connection.sync().unwrap();
    assert!(owner.connection.contains_focus(target as _).unwrap());
    target
}
fn buffer(peer: &Peer, owner: &mut Owner, text: &str) {
    peer.command(&format!("buffer:{text}"));
    peer.wait_ack(owner);
}
fn text_is(peer: &Peer, expected: &str) {
    let start = Instant::now();
    loop {
        let got = std::fs::read(peer.directory.join("buffer")).unwrap_or_default();
        if got == expected.as_bytes() {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(4),
            "GTK actual buffer {:?}, expected {:?}",
            String::from_utf8_lossy(&got),
            expected
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "requires a real GTK X11 peer and exclusive keyboard focus"]
fn linux_paste_real_gtk_buffer_delayed_target_and_restore() {
    let peer = Peer::start();
    let mut owner = Owner::open().unwrap();
    let target = activate(&peer, &mut owner);
    buffer(&peer, &mut owner, "");
    let result = ClipboardFallbackClient::for_linux_target(target)
        .paste_text("production 中文 😀\nsecond line")
        .unwrap();
    assert!(!result.confirmed);
    assert_eq!(
        result.landing,
        inject::readback::LandingEvidence::Unavailable
    );
    text_is(&peer, "production 中文 😀\nsecond line");
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        "original 中文 😀".as_bytes()
    );
    // Snapshot first; the target then deliberately stops its own event loop.
    buffer(&peer, &mut owner, "");
    let snapshot = owner.save().unwrap();
    owner.requests.clear();
    peer.command("block:1600");
    peer.wait_file("blocked");
    let start = Instant::now();
    let result = owner
        .paste(
            "delayed 中文 😀",
            inject::clipboard_paste::PASTE_HOLD,
            target,
        )
        .unwrap();
    owner.restore(snapshot).unwrap();
    // The restored owner must keep serving while the delayed external GTK
    // request arrives; production's persistent actor does this automatically.
    let wait = Instant::now();
    loop {
        owner.pump().unwrap();
        let got = std::fs::read(peer.directory.join("buffer")).unwrap_or_default();
        if got == "delayed 中文 😀".as_bytes() { break; }
        assert!(wait.elapsed() < Duration::from_secs(4), "delayed GTK actual buffer {:?}", String::from_utf8_lossy(&got));
        std::thread::sleep(Duration::from_millis(2));
    }
    println!("GTK_PASTE: immediate actual text exact; delayed target blocked=1600ms; hold={}ms; buffer-change-ms={}; wall={}ms; confirmed=false landing=Unavailable", result.held_ms, String::from_utf8(peer.wait_file("buffer-ms")).unwrap(),start.elapsed().as_millis());
    let blocked=String::from_utf8(peer.wait_file("blocked-ms")).unwrap().parse::<u64>().unwrap();
    let changed=String::from_utf8(peer.wait_file("buffer-ms")).unwrap().parse::<u64>().unwrap();
    println!("GTK_BUFFER_AFTER_BLOCK={}ms",changed-blocked);
    for (at,target,requestor) in &owner.requests {
        println!("X11_SELECTION_REQUEST at={}ms target={target} requestor={requestor}",at.saturating_duration_since(start).as_millis());
    }
    println!("GTK_PEER_ARTIFACTS={}", peer.directory.display());
}

#[test]
#[ignore = "requires a real GTK X11 peer and exclusive keyboard focus"]
fn linux_keys_real_gtk_six_keys_preserve_modifiers_and_target() {
    let peer = Peer::start();
    let mut owner = Owner::open().unwrap();
    let target = activate(&peer, &mut owner);
    buffer(&peer, &mut owner, "abc");
    for (kind, expected) in [
        ("backspace", "ab"),
        ("space", "ab "),
        ("enter", "ab \n"),
        ("tab", "ab \n\t"),
        ("clear", ""),
    ] {
        inject::send_chords(&inject::key_sequence_for(kind).unwrap(), target).unwrap();
        text_is(&peer, expected);
    }
    // The GTK peer provides an ordinary editor undo binding; assert real buffer.
    inject::send_chords(&inject::key_sequence_for("undo").unwrap(), target).unwrap();
    text_is(&peer, "ab \n\t");
    buffer(&peer, &mut owner, "safe");
    let wrong = unsafe {
        (owner.connection.api.XCreateSimpleWindow)(
            owner.connection.display,
            owner.connection.root,
            0,
            0,
            1,
            1,
            0,
            0,
            0,
        )
    };
    let result = inject::send_chords(&inject::key_sequence_for("clear").unwrap(), wrong);
    let wrong_text = inject::pipeline::inject_text_with_probe("must not land", Some(wrong), None,
        |_| true, inject::target_probe::focused_input_state, inject::self_focus::never_ours);
    assert_eq!(wrong_text.error_code, Some(crate::error_codes::INJECT_FOCUS_LOST));
    unsafe {
        (owner.connection.api.XDestroyWindow)(owner.connection.display, wrong);
    }
    assert!(matches!(
        result,
        Err(inject::FlowKeyError::TargetChanged(_))
    ));
    text_is(&peer, "safe");
    let api = x11_dl::xtest::Xf86vmode::open().unwrap();
    let shift = unsafe {
        (owner.connection.api.XKeysymToKeycode)(
            owner.connection.display,
            x11_dl::keysym::XK_Shift_L as _,
        )
    };
    unsafe {
        (api.XTestFakeKeyEvent)(owner.connection.display, shift as _, 1, 0);
    }
    owner.connection.sync().unwrap();
    let sent = inject::send_chords(&inject::key_sequence_for("backspace").unwrap(), target);
    let mut state = [0i8; 32];
    unsafe {
        (owner.connection.api.XQueryKeymap)(owner.connection.display, state.as_mut_ptr());
        (api.XTestFakeKeyEvent)(owner.connection.display, shift as _, 0, 0);
    }
    owner.connection.sync().unwrap();
    sent.unwrap();
    assert_ne!(
        state[shift as usize / 8] as u8 & (1 << (shift % 8)),
        0,
        "user's held Shift must survive"
    );
    text_is(&peer, "saf");
    println!("GTK_KEYS: six real keys changed actual editor text; held Shift restored; changed target refused before events");
    println!("GTK_PEER_ARTIFACTS={}", peer.directory.display());
}

#[test]
#[ignore = "requires a real GTK X11 peer and exclusive keyboard focus"]
fn linux_submission_real_xerror_after_keys_is_uncertain_without_duplicate() {
    let peer = Peer::start();
    let mut owner = Owner::open().unwrap();
    let target = activate(&peer, &mut owner);
    buffer(&peer, &mut owner, "");
    crate::inject::linux::keys::TEST_POST_SUBMISSION_XERROR
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let out = inject::pipeline::inject_text_with_probe(
        "one copy 中文",
        Some(target),
        None,
        |_| true,
        inject::target_probe::focused_input_state,
        inject::self_focus::never_ours,
    );
    assert!(!out.ok);
    assert_eq!(
        out.error_code,
        Some(crate::error_codes::INJECT_SUBMISSION_UNCERTAIN)
    );
    assert_eq!(out.mode, inject::InjectMode::Clipboard);
    text_is(&peer, "one copy 中文");
    // Replay inside the retention window, through the production deduper and
    // the real injection pipeline. A broken dedup branch actually types a
    // second copy into this external process before the buffer assertion fails.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap().as_millis() as u64;
    let mut dedup = crate::socket::dedup::InjectDeduper::default_spec();
    dedup.record("manual", Some("gtk-retention-replay"), "one copy 中文",
        &serde_json::json!({"ok": false, "mode": "clipboard",
            "error": crate::error_codes::INJECT_SUBMISSION_UNCERTAIN}), now);
    let replay = dedup.classify("manual", Some("gtk-retention-replay"), "one copy 中文", now + 45_000);
    if replay == crate::socket::dedup::InjectDecision::Proceed {
        let _ = inject::pipeline::inject_text_with_probe("one copy 中文", Some(target), None,
            |_| true, inject::target_probe::focused_input_state, inject::self_focus::never_ours);
    }
    text_is(&peer, "one copy 中文");
    assert!(matches!(replay, crate::socket::dedup::InjectDecision::SubmissionUncertainRemembered { .. }));
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        "original 中文 😀".as_bytes()
    );
    println!("GTK_UNCERTAIN: real X error after actual keys; pipeline reports uncertain; one exact buffer copy; original clipboard restored");
}
