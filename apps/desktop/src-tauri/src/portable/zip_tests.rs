// Unit tests for portable::zip — the container and, above all, the §3
// path-traversal guard.
//
// Every test uses an explicit temp path, so none touches the user's disk and
// none can pass because of a file another run left behind.

use super::*;

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("flowmic-zip-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("tmp dir");
    d.join("a.zip")
}

#[test]
fn crc32_matches_the_known_vector() {
    // The check value every CRC-32/ISO-HDLC implementation publishes. Without it
    // this is a hash that agrees with itself and with nothing else — and a zip
    // whose CRC is self-consistent but wrong opens everywhere and verifies
    // nowhere.
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    assert_eq!(crc32(b""), 0);
}

#[test]
fn a_written_archive_reads_back_byte_for_byte() {
    let p = tmp("roundtrip");
    let body = b"{\"fpr\":1}\n{\"fpr\":1,\"kind\":\"entry\"}\n";
    let mut w = ZipWriter::create(&p).expect("create");
    w.begin("records.jsonl", body.len() as u64, crc32(body), 1_754_000_000).expect("begin");
    // Two chunks on purpose: the streaming path (§8-1) is the production one.
    w.body(&body[..9]).expect("chunk 1");
    w.body(&body[9..]).expect("chunk 2");
    w.end().expect("end");
    let readme = "hello".as_bytes();
    w.begin("README.txt", readme.len() as u64, crc32(readme), 1_754_000_000).expect("begin 2");
    w.body(readme).expect("body 2");
    w.end().expect("end 2");
    w.finish().expect("finish");

    let mut r = ZipReader::open(&p).expect("open");
    assert_eq!(r.entries().len(), 2);
    assert_eq!(r.read_entry("records.jsonl").expect("read"), body.to_vec());
    assert_eq!(r.read_entry("README.txt").expect("read"), readme.to_vec());
    assert!(r.refused_names().is_empty());
}

#[test]
fn a_body_that_does_not_match_its_declared_size_is_refused() {
    // The writer's own honesty check: an archive that opens and then hands out
    // the wrong bytes is worse than an export that failed.
    let p = tmp("mismatch");
    let mut w = ZipWriter::create(&p).expect("create");
    w.begin("x.txt", 5, 0, 0).expect("begin");
    w.body(b"ab").expect("short body");
    assert!(matches!(w.end(), Err(ZipError::Corrupt(_))));
}

#[test]
fn a_missing_entry_is_named_not_silently_empty() {
    let p = tmp("missing");
    let mut w = ZipWriter::create(&p).expect("create");
    w.begin("a.txt", 1, crc32(b"x"), 0).expect("begin");
    w.body(b"x").expect("body");
    w.end().expect("end");
    w.finish().expect("finish");
    let mut r = ZipReader::open(&p).expect("open");
    assert_eq!(
        r.read_entry("records.jsonl"),
        Err(ZipError::NoSuchEntry("records.jsonl".to_string()))
    );
}

#[test]
fn a_file_that_is_not_a_zip_says_so() {
    let p = tmp("notzip");
    std::fs::write(&p, b"this is plainly not an archive at all, not even close").expect("write");
    assert!(matches!(ZipReader::open(&p), Err(ZipError::NotAZip)));
}

// ── §3 PATH TRAVERSAL ────────────────────────────────────────────────────────

#[test]
fn the_name_guard_refuses_every_way_out_of_the_archive() {
    for bad in [
        "",
        "../evil.txt",
        "../../evil.txt",
        "att/../../evil.png",
        "..",
        "/etc/passwd",
        "\\\\server\\share\\evil",
        "att\\evil.png",
        "C:\\Windows\\evil.exe",
        "c:evil.exe",
        "att/\0evil",
    ] {
        assert!(!entry_name_is_safe(bad), "should be refused: {bad:?}");
    }
}

#[test]
fn the_name_guard_accepts_the_names_this_product_writes() {
    // 🔴 THE POSITIVE CONTROL. A guard that refuses everything passes every
    // negative test and ships a feature that can never import anything.
    for good in [
        "records.jsonl",
        "README.txt",
        "att/0a1b2c3d4e5f6071.png",
        "att/0a1b2c3d4e5f6071.jpg",
        // `..hidden` is a SEGMENT that merely starts with two dots — a substring
        // test would refuse it, and refusing real names is how a guard gets
        // loosened by the next reader.
        "att/..hidden.png",
        "att/a..b.png",
    ] {
        assert!(entry_name_is_safe(good), "should be accepted: {good:?}");
    }
}

/// A hand-built archive with ONE entry under an arbitrary name and method — the
/// writer refuses unsafe names, so a malicious archive has to be forged here.
fn forge(path: &std::path::Path, name: &str, method: u16, body: &[u8]) {
    let nb = name.as_bytes();
    let crc = crc32(body);
    let mut f: Vec<u8> = Vec::new();
    f.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    f.extend_from_slice(&20u16.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&method.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&0x21u16.to_le_bytes());
    f.extend_from_slice(&crc.to_le_bytes());
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(&(nb.len() as u16).to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(nb);
    f.extend_from_slice(body);
    let cd_start = f.len() as u32;
    f.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    f.extend_from_slice(&20u16.to_le_bytes());
    f.extend_from_slice(&20u16.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&method.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&0x21u16.to_le_bytes());
    f.extend_from_slice(&crc.to_le_bytes());
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(&(nb.len() as u16).to_le_bytes());
    for _ in 0..4 {
        f.extend_from_slice(&0u16.to_le_bytes()); // extra / comment / disk / int
    }
    f.extend_from_slice(&0u32.to_le_bytes()); // external attrs
    f.extend_from_slice(&0u32.to_le_bytes()); // local offset
    f.extend_from_slice(nb);
    let cd_size = f.len() as u32 - cd_start;
    f.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&cd_size.to_le_bytes());
    f.extend_from_slice(&cd_start.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    std::fs::write(path, &f).expect("forged archive");
}

#[test]
fn a_forged_traversal_entry_never_becomes_readable_and_is_reported() {
    let p = tmp("traversal");
    forge(&p, "../../evil.txt", 0, b"pwned");
    let mut r = ZipReader::open(&p).expect("the archive itself still opens");
    // It is not in the readable set, so nothing downstream can select it…
    assert!(r.entries().is_empty(), "traversal entry must not be readable");
    assert_eq!(
        r.read_entry("../../evil.txt"),
        Err(ZipError::NoSuchEntry("../../evil.txt".to_string()))
    );
    // …and the user is TOLD (no silent failures: a quietly smaller import is the thing
    // this repo keeps paying for).
    assert_eq!(r.refused_names(), &["../../evil.txt".to_string()]);
}

#[test]
fn a_forged_ordinary_entry_reads_fine() {
    // 🔴 THE POSITIVE CONTROL FOR THE TEST ABOVE. Same forger, same shape, safe
    // name — so「entries() is empty」there proves the GUARD fired and not that
    // the forger produced an unreadable file.
    let p = tmp("traversal-control");
    forge(&p, "att/0a1b2c3d4e5f6071.png", 0, b"pwned");
    let mut r = ZipReader::open(&p).expect("open");
    assert_eq!(r.entries().len(), 1);
    assert_eq!(r.read_entry("att/0a1b2c3d4e5f6071.png").expect("read"), b"pwned".to_vec());
    assert!(r.refused_names().is_empty());
}

#[test]
fn a_deflated_entry_is_refused_by_name_not_read_as_garbage() {
    // The stated cost of STORE-only (see the module header): a re-zipped file
    // gets a NAMED refusal, never a half-import of compressed bytes read as text.
    let p = tmp("deflated");
    forge(&p, "records.jsonl", 8, b"\x00\x00\x00");
    let mut r = ZipReader::open(&p).expect("open");
    assert_eq!(
        r.read_entry("records.jsonl"),
        Err(ZipError::Compressed("records.jsonl".to_string()))
    );
}

#[test]
fn the_dos_timestamp_encodes_a_real_instant() {
    // 2026-08-01T09:12:32Z. DOS seconds have 2-second resolution, hence /2.
    let (time, date) = dos_datetime(1_785_575_552);
    assert_eq!((date >> 9) + 1980, 2026);
    assert_eq!((date >> 5) & 0x0F, 8);
    assert_eq!(date & 0x1F, 1);
    assert_eq!(time >> 11, 9);
    assert_eq!((time >> 5) & 0x3F, 12);
    // Anything before the DOS epoch clamps rather than wrapping into the future.
    let (_, early) = dos_datetime(0);
    assert_eq!((early >> 9) + 1980, 1980);
}
