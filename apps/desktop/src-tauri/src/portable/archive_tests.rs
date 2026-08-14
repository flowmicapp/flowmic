// Unit tests for portable::archive — the export/import file layer.
//
// Every test passes an explicit picture directory (the `*_in` forms row_image
// already provides), so none of them touches `%LOCALAPPDATA%`.

use super::*;

/// The same real 2×2 PNG socket/row_image_tests.rs uses, so `validated_bytes`
/// really validates and the magic-byte check really runs.
const PNG_2X2_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAFjDAGACHtA/wSKAdxAAAAAElFTkSuQmCC";

fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("flowmic-portable-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("tmp dir");
    d
}

#[test]
fn an_export_round_trips_through_the_archive() {
    let d = tmpdir("roundtrip");
    let zip = d.join("out.zip");
    let lines = vec![
        r#"{"fpr":1,"kind":"header","count":2}"#.to_string(),
        r#"{"fpr":1,"kind":"entry","id":"req:1"}"#.to_string(),
        r#"{"fpr":1,"kind":"entry","id":"req:2"}"#.to_string(),
    ];
    let r = write_export(&zip, &lines, "readme body", &[], &d).expect("export");
    // `count` is the ENTRY count: the header line is not a record (§4.1 —
    // 「count must equal the actual number of lines; a mismatch = the export is lying」).
    assert_eq!(r.records, 2);
    assert_eq!(r.attachments, 0);
    assert!(r.bytes > 0, "the size is the finished file's own length");

    let back = read_archive(&zip).expect("read");
    assert_eq!(back.lines, lines);
    assert!(back.attachments.is_empty());
    assert!(back.refused_names.is_empty());
}

#[test]
fn a_picture_travels_and_comes_back_under_its_row_id() {
    let d = tmpdir("pictures");
    let pics = d.join("pics");
    let restored = d.join("restored");
    assert!(row_image::store_in(&pics, "req:img-1", PNG_2X2_B64, "image/png"));

    let dg = digest_of(&pics, "req:img-1").expect("digest");
    assert_eq!(dg.sha16.len(), 16, "§3 —— 内容哈希前 16 位十六进制");
    assert!(dg.sha16.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(dg.ext, "png");
    assert_eq!(dg.bytes, picture_bytes(&pics, "req:img-1").expect("size"));

    let name = format!("att/{}.{}", dg.sha16, dg.ext);
    let zip = d.join("out.zip");
    write_export(
        &zip,
        &[r#"{"fpr":1,"kind":"header"}"#.to_string()],
        "readme",
        &[Attachment { row_id: "req:img-1".into(), name: name.clone() }],
        &pics,
    )
    .expect("export");

    let back = read_archive(&zip).expect("read");
    assert_eq!(back.attachments, vec![name.clone()]);

    // The row id on the way back is a DIFFERENT one on purpose: the destination
    // is derived from the row id, never from the member name.
    let out = restore_attachments(
        &zip,
        &[Restore { name, row_id: "req:img-restored".into() }],
        &restored,
    );
    assert_eq!((out.landed, out.failed), (1, 0));
    let p = row_image::find_in(&restored, "req:img-restored").expect("restored file");
    assert_eq!(p.extension().and_then(|e| e.to_str()), Some("png"));
    assert_eq!(
        std::fs::read(&p).expect("bytes"),
        std::fs::read(row_image::find_in(&pics, "req:img-1").expect("src")).expect("src bytes"),
    );
}

#[test]
fn two_rows_sharing_one_picture_produce_one_member() {
    // §3 —「附件文件名用内容哈希…天然去重且幂等（同一张图被两行引用只存一份）」
    // ("the attachment filename uses the content hash ... naturally deduped and
    // idempotent [the same picture referenced by two rows is stored only once]").
    let d = tmpdir("dedup");
    let pics = d.join("pics");
    assert!(row_image::store_in(&pics, "req:a", PNG_2X2_B64, "image/png"));
    assert!(row_image::store_in(&pics, "req:b", PNG_2X2_B64, "image/png"));
    let a = digest_of(&pics, "req:a").expect("digest a");
    let b = digest_of(&pics, "req:b").expect("digest b");
    assert_eq!(a.sha16, b.sha16, "same bytes, same content hash");

    let name = format!("att/{}.{}", a.sha16, a.ext);
    let zip = d.join("out.zip");
    let r = write_export(
        &zip,
        &[r#"{"fpr":1}"#.to_string()],
        "readme",
        &[
            Attachment { row_id: "req:a".into(), name: name.clone() },
            Attachment { row_id: "req:b".into(), name: name.clone() },
        ],
        &pics,
    )
    .expect("export");
    assert_eq!(r.attachments, 1);
    assert_eq!(read_archive(&zip).expect("read").attachments, vec![name]);
}

#[test]
fn a_row_whose_picture_vanished_does_not_abort_the_export() {
    // The frontend decided this row's `attachment` from the digest call; a
    // picture that disappeared between then and now is rare, must not lose the
    // other 1999 rows, and must not be silent (there is a forensic line, and the
    // import side names 「N of these rows' pictures are not in this file」).
    let d = tmpdir("gone");
    let zip = d.join("out.zip");
    let r = write_export(
        &zip,
        &[r#"{"fpr":1}"#.to_string()],
        "readme",
        &[Attachment { row_id: "req:not-here".into(), name: "att/ffff.png".into() }],
        &d.join("empty"),
    )
    .expect("export still succeeds");
    assert_eq!(r.attachments, 0);
    assert!(read_archive(&zip).expect("read").attachments.is_empty());
}

#[test]
fn a_member_that_is_not_really_a_picture_never_lands() {
    // `store_in` runs `validated_bytes`, so an archive with a `.png` member
    // holding something else writes NO file — the reuse is what buys this.
    let d = tmpdir("junk");
    let zip = d.join("out.zip");
    let dest = d.join("dest");
    let mut w = crate::portable::zip::ZipWriter::create(&zip).expect("create");
    let body = b"ABCD";
    w.begin("att/deadbeefdeadbeef.png", 4, crate::portable::zip::crc32(body), 0).expect("begin");
    w.body(body).expect("body");
    w.end().expect("end");
    w.begin("records.jsonl", 2, crate::portable::zip::crc32(b"{}"), 0).expect("begin 2");
    w.body(b"{}").expect("body 2");
    w.end().expect("end 2");
    w.finish().expect("finish");

    let out = restore_attachments(
        &zip,
        &[Restore { name: "att/deadbeefdeadbeef.png".into(), row_id: "req:x".into() }],
        &dest,
    );
    assert_eq!((out.landed, out.failed), (0, 1));
    assert!(row_image::find_in(&dest, "req:x").is_none(), "no half-file left behind");
}

#[test]
fn a_traversal_member_writes_nothing_and_a_normal_one_does() {
    // 🔴 §3, at the layer that actually writes files, WITH its positive control
    // in the same test: 「cannot write out a directory」 only means something if the same call shape
    // demonstrably CAN write when the name is honest.
    let d = tmpdir("traversal");
    let zip = d.join("out.zip");
    let dest = d.join("dest");
    let outside = d.join("evil.png");

    // Forge an archive holding both a traversal member and an honest one.
    let pics = d.join("pics");
    assert!(row_image::store_in(&pics, "req:ok", PNG_2X2_B64, "image/png"));
    let dg = digest_of(&pics, "req:ok").expect("digest");
    let good = format!("att/{}.{}", dg.sha16, dg.ext);
    forge_two(&zip, "att/../../evil.png", &good, &std::fs::read(
        row_image::find_in(&pics, "req:ok").expect("src"),
    ).expect("src bytes"));

    let read = read_archive(&zip).expect("read");
    // The traversal member is not even offered as an attachment…
    assert_eq!(read.attachments, vec![good.clone()]);
    assert_eq!(read.refused_names, vec!["att/../../evil.png".to_string()]);

    let bad = restore_attachments(
        &zip,
        &[Restore { name: "att/../../evil.png".into(), row_id: "req:evil".into() }],
        &dest,
    );
    assert_eq!((bad.landed, bad.failed), (0, 1));
    assert!(!outside.exists(), "nothing was written outside the picture directory");
    assert!(!d.join("..").join("evil.png").exists());

    // POSITIVE CONTROL — same archive, same call, honest name.
    let ok = restore_attachments(&zip, &[Restore { name: good, row_id: "req:ok2".into() }], &dest);
    assert_eq!((ok.landed, ok.failed), (1, 0));
    assert!(row_image::find_in(&dest, "req:ok2").is_some());
}

/// Three-entry forger (the writer refuses unsafe names, so a malicious archive
/// has to be built by hand). All entries are STORE; `good_name` carries `body`,
/// and a real `records.jsonl` rides along so `read_archive` gets as far as the
/// attachment inventory — which is the thing under test.
fn forge_two(path: &Path, bad_name: &str, good_name: &str, body: &[u8]) {
    use crate::portable::zip::crc32;
    let records = br#"{"fpr":1,"kind":"header"}"#.as_slice();
    let mut f: Vec<u8> = Vec::new();
    let mut offsets: Vec<(u32, &str, u32, u32)> = Vec::new();
    for (name, data) in [
        (bad_name, b"pwned".as_slice()),
        (good_name, body),
        ("records.jsonl", records),
    ] {
        let off = f.len() as u32;
        let nb = name.as_bytes();
        let crc = crc32(data);
        f.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        f.extend_from_slice(&20u16.to_le_bytes());
        f.extend_from_slice(&0u16.to_le_bytes());
        f.extend_from_slice(&0u16.to_le_bytes());
        f.extend_from_slice(&0u16.to_le_bytes());
        f.extend_from_slice(&0x21u16.to_le_bytes());
        f.extend_from_slice(&crc.to_le_bytes());
        f.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.extend_from_slice(&(nb.len() as u16).to_le_bytes());
        f.extend_from_slice(&0u16.to_le_bytes());
        f.extend_from_slice(nb);
        f.extend_from_slice(data);
        offsets.push((off, name, crc, data.len() as u32));
    }
    let cd_start = f.len() as u32;
    for (off, name, crc, len) in &offsets {
        let nb = name.as_bytes();
        f.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        f.extend_from_slice(&20u16.to_le_bytes());
        f.extend_from_slice(&20u16.to_le_bytes());
        f.extend_from_slice(&0u16.to_le_bytes());
        f.extend_from_slice(&0u16.to_le_bytes());
        f.extend_from_slice(&0u16.to_le_bytes());
        f.extend_from_slice(&0x21u16.to_le_bytes());
        f.extend_from_slice(&crc.to_le_bytes());
        f.extend_from_slice(&len.to_le_bytes());
        f.extend_from_slice(&len.to_le_bytes());
        f.extend_from_slice(&(nb.len() as u16).to_le_bytes());
        for _ in 0..4 {
            f.extend_from_slice(&0u16.to_le_bytes());
        }
        f.extend_from_slice(&0u32.to_le_bytes());
        f.extend_from_slice(&off.to_le_bytes());
        f.extend_from_slice(nb);
    }
    let cd_size = f.len() as u32 - cd_start;
    f.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    f.extend_from_slice(&3u16.to_le_bytes());
    f.extend_from_slice(&3u16.to_le_bytes());
    f.extend_from_slice(&cd_size.to_le_bytes());
    f.extend_from_slice(&cd_start.to_le_bytes());
    f.extend_from_slice(&0u16.to_le_bytes());
    std::fs::write(path, &f).expect("forged archive");
}

#[test]
fn the_content_hash_is_really_sha256() {
    // Pinned against the published vector so this is not a hash agreeing with
    // itself: the phone writes the SAME names (doc 16 §1 ruling 4, same shape on both ends), and two
    // ends can only agree if both are really SHA-256.
    let d = tmpdir("sha");
    std::fs::create_dir_all(&d).expect("dir");
    // "abc" → ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    let h = crate::pc_name::sha256(b"abc");
    let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "ba7816bf8f01cfea");
}
