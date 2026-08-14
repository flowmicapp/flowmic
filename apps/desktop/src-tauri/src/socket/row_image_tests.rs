// Unit tests for socket::row_image — size B on the PC (RV-93). Sibling file for the
// same reason row_transit_tests.rs is one (800-line source cap).
//
// Every test runs against an explicit base directory (the `*_in` forms), so none
// of them touches `%LOCALAPPDATA%` and none can pass because of a file another
// test left behind.

use super::*;

/// A real 2×2 PNG (the same payload inject/image.rs's own tests use), so
/// `validated_bytes` really validates and the magic-byte check really runs.
const PNG_2X2_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAFjDAGACHtA/wSKAdxAAAAAElFTkSuQmCC";

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("flowmic-rowimg-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn a_delivered_picture_is_kept_and_comes_back_as_a_data_url() {
    let d = tmp("keep");
    assert!(store_in(&d, "req:i0-1", PNG_2X2_B64, "image/png"));
    // The file is a REAL png on disk — the user can find it in the one directory
    // this product points them at.
    let p = find_in(&d, "req:i0-1").expect("stored");
    assert_eq!(p.extension().and_then(|e| e.to_str()), Some("png"));
    let url = data_url_in(&d, "req:i0-1").expect("readable");
    assert!(url.starts_with("data:image/png;base64,"), "{url}");
    // 🔴 ROUND TRIP: what comes back is byte-identical to what the frame carried.
    // Without this the encoder and the decoder are two independent guesses.
    let back = url.trim_start_matches("data:image/png;base64,");
    assert_eq!(
        crate::inject::image::decode_b64(back).expect("canonical"),
        crate::inject::image::decode_b64(PNG_2X2_B64).expect("canonical"),
    );
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn base64_round_trips_for_every_tail_length() {
    // 0/1/2 bytes of padding — the three shapes `encode_b64` has to get right.
    for n in 1..=9usize {
        let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
        let s = encode_b64(&bytes);
        assert_eq!(s.len() % 4, 0, "canonical base64 is a multiple of 4: {s}");
        assert_eq!(
            crate::inject::image::decode_b64(&s).expect("our own decoder accepts it"),
            bytes,
            "n={n}"
        );
    }
}

#[test]
fn a_junk_payload_leaves_no_file_and_the_row_is_told() {
    let d = tmp("junk");
    // Valid base64, not a picture: `validated_bytes` refuses on the magic bytes.
    assert!(!store_in(&d, "req:bad", "QUJDRA==", "image/png"));
    assert!(find_in(&d, "req:bad").is_none(), "no half-file left behind");
    assert!(data_url_in(&d, "req:bad").is_none());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_declared_mime_that_lies_is_refused() {
    let d = tmp("mimelie");
    // Real PNG bytes announced as JPEG — the same disagreement the inject path
    // refuses. Storing it would make the `data:` prefix on the way out a lie.
    assert!(!store_in(&d, "req:lie", PNG_2X2_B64, "image/jpeg"));
    assert!(find_in(&d, "req:lie").is_none());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_row_id_can_never_address_a_path_outside_the_directory() {
    // 🔴 The id can be a string a REMOTE PEER chose (`entry_id` verbatim, when the
    // frame carried no request_id — row_transit::row_id). A traversal here would
    // let a phone write anywhere this process can.
    let d = tmp("escape");
    let hostile = "../../../../evil";
    assert!(store_in(&d, hostile, PNG_2X2_B64, "image/png"));
    let p = find_in(&d, hostile).expect("stored");
    // The proof is the PARENT, not the spelling: the traversal is neutralised by
    // being collapsed into ONE file-name component (`_.._.._.._.._evil.png`), which
    // is an odd name and a harmless one. Asserting on the absence of the two
    // characters would be asserting on cosmetics.
    assert_eq!(p.parent(), Some(d.as_path()), "written INSIDE the directory: {p:?}");
    let name = p.file_name().unwrap().to_string_lossy().to_string();
    assert!(!name.contains('/') && !name.contains('\\'), "one component only: {name}");
    // …and a dotfile name cannot be produced either.
    assert!(store_in(&d, ".hidden", PNG_2X2_B64, "image/png"));
    let h = find_in(&d, ".hidden").expect("stored");
    assert!(
        !h.file_name().unwrap().to_string_lossy().starts_with('.'),
        "{h:?}"
    );
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn trimming_a_row_takes_its_picture_with_it_and_leaves_the_others() {
    let d = tmp("drop");
    assert!(store_in(&d, "req:a", PNG_2X2_B64, "image/png"));
    assert!(store_in(&d, "req:b", PNG_2X2_B64, "image/png"));
    assert_eq!(drop_in(&d, &["req:a".to_string()]), 1);
    assert!(find_in(&d, "req:a").is_none(), "the trimmed row's picture is gone");
    // positive control: the OTHER row is untouched — a delete that took everything would
    // pass a test that only looked at the victim.
    assert!(find_in(&d, "req:b").is_some());
    // Dropping an id with no picture is a no-op, not an error (a transcript row).
    assert_eq!(drop_in(&d, &["req:never".to_string()]), 0);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn the_production_directory_sits_beside_the_forensic_log() {
    // [`dir`] answers a temp path under `cargo test` (see its doc for why), so the
    // PRODUCTION expression would otherwise be the one line of this module nothing
    // ever looks at. Asserted through the same helper it uses, so a change to where
    // this product writes its diagnostics moves both together.
    let expected = crate::forensic::sibling_path(DIR_NAME);
    assert_eq!(expected.file_name().and_then(|s| s.to_str()), Some(DIR_NAME));
    assert_eq!(
        expected.parent(),
        crate::forensic::sibling_path("window-forensics.log").parent(),
        "the pictures live beside the forensic log, in the one directory users are pointed at",
    );
}

#[test]
fn a_row_with_no_picture_answers_none_rather_than_an_empty_string() {
    let d = tmp("absent");
    assert!(find_in(&d, "req:nothing").is_none());
    assert!(data_url_in(&d, "req:nothing").is_none());
}

// ── IMG-1: WHY it was not kept, not merely THAT it was not ───────────────────
//
// Four ways to fail, and they do not have one answer. Three of them are this PC's
// disk — the thing `PC_IMAGE_STORE_FAILED` describes and the user can fix — and one
// of them is a payload that was never a picture, which would fail just as hard on an
// empty disk. Until `StoreOutcome` existed all four arrived at the caller as `false`,
// so the layer that has to speak to the user could not have told them apart.
//
// The sabotage below is deliberately made of ORDINARY filesystem states (a file where
// a directory belongs, a directory where a file belongs) rather than permissions:
// permission bits behave differently on Windows and on CI, and a test that only fails
// on one of them is a test that goes quiet on the other.

/// The `.part` name `store_outcome_in` writes to for this row — the ONE entry that
/// can be sabotaged without disturbing anything else in the directory.
fn part_path(base: &Path, row_id: &str) -> PathBuf {
    base.join(format!("{}.png.part", safe_stem(row_id)))
}

fn failure(outcome: StoreOutcome) -> StoreFailure {
    match outcome {
        StoreOutcome::NotKept(f) => f,
        StoreOutcome::Kept(p) => panic!("expected a refusal, but the picture was kept at {p:?}"),
    }
}

#[test]
fn a_payload_that_was_never_a_picture_is_not_blamed_on_this_pcs_disk() {
    let d = tmp("why-payload");
    // Valid base64 that is not a picture, and a real picture announced as the wrong
    // mime — the two shapes `validated_bytes` refuses.
    for (b64, mime, want) in [
        ("QUJDRA==", "image/png", ImageError::Decode(
            "payload matches no supported image signature".to_string(),
        )),
        (PNG_2X2_B64, "image/jpeg", ImageError::MimeMismatch {
            declared: "image/jpeg",
            sniffed: "image/png",
        }),
    ] {
        let f = failure(store_outcome_in(&d, "req:bad", b64, mime));
        // 🔴 THE ASSERTION THAT MATTERS IS THE NEGATIVE ONE. Free disk space and write
        // permission are the whole of `PC_IMAGE_STORE_FAILED`'s advice, and neither of
        // them can make these bytes into a picture — telling this user to clear space
        // is an instruction that cannot work.
        assert!(
            !matches!(f, StoreFailure::Disk { .. }),
            "a payload refusal must never present as a disk refusal: {f:?}"
        );
        assert_eq!(f, StoreFailure::Payload(want), "the exact reason survives the return");
    }
    // positive control: nothing was written on the way to either refusal.
    assert!(find_in(&d, "req:bad").is_none(), "no half-file left behind");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_directory_that_cannot_be_made_is_a_disk_refusal_at_mkdir() {
    let d = tmp("why-mkdir");
    // A FILE where the pictures directory belongs — `create_dir_all` cannot proceed.
    std::fs::create_dir_all(d.parent().expect("temp dir")).expect("parent");
    std::fs::write(&d, b"not a directory").expect("sabotage");
    let f = failure(store_outcome_in(&d, "req:mk", PNG_2X2_B64, "image/png"));
    match &f {
        StoreFailure::Disk { stage, path, err } => {
            assert_eq!(*stage, DiskStage::Mkdir);
            assert_eq!(path, &d, "the log names the directory it could not make");
            assert!(!err.is_empty(), "the OS's own words are carried, not swallowed");
        }
        other => panic!("expected a mkdir refusal, got {other:?}"),
    }
    assert!(f.reason().starts_with("mkdir "), "{}", f.reason());
    let _ = std::fs::remove_file(&d);
}

#[test]
fn bytes_that_cannot_be_written_are_a_disk_refusal_at_write() {
    let d = tmp("why-write");
    std::fs::create_dir_all(&d).expect("dir");
    // A DIRECTORY occupying the `.part` name — the write refuses, the directory
    // itself is healthy, so this isolates the second step from the first.
    let part = part_path(&d, "req:w");
    std::fs::create_dir_all(&part).expect("sabotage");
    let f = failure(store_outcome_in(&d, "req:w", PNG_2X2_B64, "image/png"));
    match &f {
        StoreFailure::Disk { stage, path, err } => {
            assert_eq!(*stage, DiskStage::Write);
            assert_eq!(path, &part, "the log names the file it could not write");
            assert!(!err.is_empty());
        }
        other => panic!("expected a write refusal, got {other:?}"),
    }
    assert!(f.reason().starts_with("write "), "{}", f.reason());
    assert!(find_in(&d, "req:w").is_none(), "the row's real name was never created");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_finished_file_that_cannot_be_moved_into_place_is_a_disk_refusal_at_rename() {
    let d = tmp("why-rename");
    std::fs::create_dir_all(&d).expect("dir");
    // A non-empty DIRECTORY occupying the row's real name: the `.part` write
    // succeeds and the move onto it does not — the one failure that happens AFTER
    // bytes have already hit the disk.
    let occupied = d.join(format!("{}.png", safe_stem("req:r")));
    std::fs::create_dir_all(&occupied).expect("sabotage");
    std::fs::write(occupied.join("keep-me"), b"x").expect("sabotage");
    let f = failure(store_outcome_in(&d, "req:r", PNG_2X2_B64, "image/png"));
    match &f {
        StoreFailure::Disk { stage, path, err } => {
            assert_eq!(*stage, DiskStage::Rename);
            assert_eq!(path, &occupied, "the log names the destination, not the .part");
            assert!(!err.is_empty());
        }
        other => panic!("expected a rename refusal, got {other:?}"),
    }
    assert!(f.reason().starts_with("rename "), "{}", f.reason());
    // 🔴 AND THE HALF-WRITTEN NAME IS GONE. Nothing else in this module ever probes
    // or deletes a `.part` (see `EXTS` and `drop_in`), so one left behind would be
    // bytes no reader can reach and no eviction can remove.
    assert!(!part_path(&d, "req:r").exists(), "the .part went with the failure");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn the_four_ways_to_fail_are_four_different_answers_and_the_old_one_is_unchanged() {
    // All four, side by side. Any test above could pass while the OTHERS collapsed
    // onto it; this one is the statement that they are four values, not one.
    let d = tmp("why-all");
    std::fs::create_dir_all(&d).expect("dir");
    std::fs::create_dir_all(part_path(&d, "req:w")).expect("write sabotage");
    let occupied = d.join(format!("{}.png", safe_stem("req:r")));
    std::fs::create_dir_all(&occupied).expect("rename sabotage");
    let missing = d.join("a-file-not-a-dir");
    std::fs::write(&missing, b"x").expect("mkdir sabotage");

    let outcomes = [
        store_outcome_in(&d, "req:bad", "QUJDRA==", "image/png"),
        store_outcome_in(&missing, "req:mk", PNG_2X2_B64, "image/png"),
        store_outcome_in(&d, "req:w", PNG_2X2_B64, "image/png"),
        store_outcome_in(&d, "req:r", PNG_2X2_B64, "image/png"),
    ];
    for (i, a) in outcomes.iter().enumerate() {
        // ① The answer the two callers outside this module still take is IDENTICAL
        // to what it was before the widening — this card added a fact, it did not
        // change a verdict.
        assert!(!a.kept(), "#{i} is still a refusal to the boolean callers");
        for (j, b) in outcomes.iter().enumerate().skip(i + 1) {
            assert_ne!(a, b, "#{i} and #{j} are the same value — that is the bare `false` again");
            assert_ne!(
                failure(a.clone()).reason(),
                failure(b.clone()).reason(),
                "#{i} and #{j} read the same in the log"
            );
        }
    }
    // positive control: the same directory still keeps a healthy picture, so a green run above
    // cannot mean "this directory was simply broken for everything".
    let ok = store_outcome_in(&d, "req:fine", PNG_2X2_B64, "image/png");
    assert!(ok.kept(), "{ok:?}");
    // …and the outcome names the file the READER goes on to find — one path, agreed
    // on by the writer and by `find_in`, rather than two guesses.
    assert_eq!(ok, StoreOutcome::Kept(find_in(&d, "req:fine").expect("stored")));
    let _ = std::fs::remove_dir_all(&d);
}

/// 🔴 THE GUARD AGAINST THE WRONG FIX — it must go red if anyone ever "fixes" a
/// failed store by flipping the delivery verdict.
///
/// The store runs AFTER the inject: by the time it is called the picture has already
/// been pasted into the focused window. `ok` answers "did this frame's delivery succeed", and the
/// answer is yes even when the disk then refuses to keep a copy — so a store failure
/// that turned `ok:true` into `ok:false` would report a successful delivery as a
/// failure, a brand-new lie pointing the opposite way, and would strand the phone's
/// queue item on a delivery that really happened.
///
/// It is driven through `row_transit::mint_row` rather than asserted structurally,
/// because the value that could be corrupted is the one that goes on the socket, and
/// that value only exists on the far side of the mint.
///
/// ⚠️ IT LIVES HERE, in the picture store's own tests, although the code it guards is
/// in `row_transit.rs`: this is the failure whose surface IMG-1 is about, and a guard
/// filed next to the module that could break it is a guard nobody reads when editing
/// the module that would trip it.
#[test]
fn a_store_that_could_not_keep_the_picture_does_not_change_the_delivery_verdict() {
    use crate::socket::bridge::{self, BridgeSink};
    use crate::socket::channel::Channel;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    let log: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let l = log.clone();
    let sink: Option<BridgeSink> = Some(Arc::new(move |ch: &str, p: Value| {
        l.lock().unwrap().push((ch.to_string(), p));
    }));

    // The sabotage is ONE entry inside the shared test directory, addressed by this
    // row's own id, so `mint_row` fails for this row and for no other — the pictures
    // directory itself stays healthy for every test running beside this one.
    let rid = "img1-storefail";
    let id = format!("req:{rid}");
    let base = dir();
    std::fs::create_dir_all(&base).expect("test dir");
    if let Some(stale) = find_in(&base, &id) {
        let _ = std::fs::remove_file(stale);
    }
    let doomed = part_path(&base, &id);
    let _ = std::fs::remove_file(&doomed);
    std::fs::create_dir_all(&doomed).expect("sabotage");

    let verdict = json!({ "ok": true, "mode": "sendinput", "entry_id": "en-1" });
    let f = json!({
        "text": "", "source": "image", "request_id": rid,
        "image_b64": PNG_2X2_B64, "image_mime": "image/png",
        "entry_type": "image", "thumb_b64": "QUJDRA==",
    });
    let req = crate::socket::wire::parse_inject_request(&f).expect("parses");
    let minted = crate::socket::row_transit::mint_row(
        &sink,
        Channel::Lan,
        &f,
        &req,
        Some(verdict.clone()),
    )
    .expect("one result ⇒ one row");

    // ① positive control FIRST: the store really did fail on this mint. Without it a green
    // run below could mean "the sabotage missed" rather than "the verdict held".
    assert!(find_in(&base, &id).is_none(), "the picture was NOT kept: that is the premise");
    // ② 🔴 …and the verdict that goes on the socket is byte-for-byte what the inject
    // produced. `ok:true` is the truthful answer to the question `ok` asks.
    assert_eq!(minted.result, verdict, "a failed store must not touch the delivery verdict");
    assert_eq!(crate::socket::row_transit::row_status(&minted.result), "injected");

    let item = log
        .lock()
        .unwrap()
        .iter()
        .find(|(ch, _)| ch == bridge::channel::HISTORY_UPDATED)
        .map(|(_, p)| p["item"].clone())
        .expect("a row reached the window");
    assert_eq!(item["status"], json!("injected"), "the row says the delivery succeeded");
    // ③ …while the row still does not CLAIM a picture it does not have. The two
    // halves are asserted together on purpose: they are the two ways to get this
    // wrong, and each of them is green while the other is broken.
    assert!(item.get("full_image").is_none(), "omitted, never a false claim");
    assert_eq!(item["thumb_b64"], json!("QUJDRA=="), "the smaller picture is untouched");

    let _ = std::fs::remove_dir_all(&doomed);
}
