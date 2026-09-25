// SPEC-REF: Linux L-3 actual GTK owner/requestor acceptance. This ignored test
// deliberately requires an explicit native session and separately built peer.
use super::*;
use std::path::PathBuf;
use std::process::{Child, Command};

pub(super) struct Peer {
    pub child: Child,
    pub directory: PathBuf,
}
impl Peer {
    pub fn start() -> Self {
        let executable = std::env::var("FLOWMIC_LINUX_GTK_PEER")
            .expect("build gtk_peer.c and set FLOWMIC_LINUX_GTK_PEER");
        let directory = std::env::temp_dir().join(format!("flowmic-gtk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let child = Command::new(executable).arg(&directory).spawn().unwrap();
        let peer = Self { child, directory };
        peer.wait_file("ready");
        peer
    }
    pub fn wait_file(&self, name: &str) -> Vec<u8> {
        let start = Instant::now();
        loop {
            if let Ok(bytes) = std::fs::read(self.directory.join(name)) {
                return bytes;
            }
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "GTK peer did not produce {name}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub fn command(&self, command: &str) {
        let _ = std::fs::remove_file(self.directory.join("ack"));
        std::fs::write(self.directory.join("command"), command).unwrap();
    }
    pub fn wait_ack(&self, owner: &mut Owner) {
        let start = Instant::now();
        while !self.directory.join("ack").exists() {
            owner.pump().unwrap();
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "GTK command timed out"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    pub(super) fn read(&self, owner: &mut Owner, target: &str) -> (Vec<u8>, i32) {
        let _ = std::fs::remove_file(self.directory.join("result"));
        self.command(&format!("read:{target}"));
        self.wait_ack(owner);
        let bytes = self.wait_file("result");
        let width = String::from_utf8(self.wait_file("format"))
            .unwrap()
            .parse()
            .unwrap();
        (bytes, width)
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "requires an isolated real GTK X11 peer; see Linux delivery report"]
fn linux_clipboard_real_gtk_round_trip_and_new_owner_survives() {
    let peer = Peer::start();
    let mut owner = Owner::open().unwrap();
    let snapshot = owner
        .save()
        .expect("snapshot real GTK owner including INCR");
    assert_eq!(
        snapshot.skipped.len(),
        2,
        "DELETE and PIXMAP are named, never requested"
    );
    assert!(snapshot.skipped.iter().all(|id| *id >= 0x8000_0000));
    assert!(!peer.directory.join("unsafe-request").exists());
    assert_eq!(
        snapshot.formats.len(),
        6,
        "five formats plus transaction token"
    );
    owner.begin_paste("replacement 中文 😀").unwrap();
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        "replacement 中文 😀".as_bytes()
    );
    owner.restore(snapshot).unwrap();
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        "original 中文 😀".as_bytes()
    );
    assert_eq!(peer.read(&mut owner, "text/html").0, b"<b>original</b>");
    let (shorts, width) = peer.read(&mut owner, "application/x-flowmic16");
    assert_eq!(width, 16);
    assert_eq!(shorts, [0x34, 0x12, 0xDC, 0xFE, 0, 0]);
    let (longs, width) = peer.read(&mut owner, "application/x-flowmic32");
    assert_eq!(width, 32);
    // The external GTK peer normalizes each native-long slot to its wire u32.
    assert_eq!(
        longs,
        [0x12345678u32, 0xFEDCBA98, 0]
            .iter()
            .flat_map(|v| v.to_ne_bytes())
            .collect::<Vec<_>>()
    );
    let (large, width) = peer.read(&mut owner, "application/x-flowmic-large");
    assert_eq!(width, 8);
    assert_eq!(large.len(), 1024 * 1024);
    assert!(large.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
    let snapshot = owner.save().unwrap();
    owner.begin_paste("borrowed").unwrap();
    peer.command("copy:user copied during paste");
    peer.wait_ack(&mut owner);
    owner.restore(snapshot).unwrap();
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        b"user copied during paste"
    );
    // Same XID but different generation: the native copy button also wins.
    let snapshot = owner.save().unwrap();
    owner.begin_paste("borrowed again").unwrap();
    owner.write_text("copy button wins").unwrap();
    owner.restore(snapshot).unwrap();
    assert_eq!(peer.read(&mut owner, "UTF8_STRING").0, b"copy button wins");
    // Production adapter, not a fake: the persistent service owns and serves
    // this copy after write_text returns to its shell caller.
    crate::inject::linux::write_text("production native copy 中文").unwrap();
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        "production native copy 中文".as_bytes()
    );
    let snapshot = crate::inject::clipboard_snapshot::save_clipboard().unwrap();
    crate::inject::clipboard_snapshot::restore_clipboard(snapshot).unwrap();
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        "production native copy 中文".as_bytes()
    );
    println!("GTK_CLIPBOARD: five formats round-trip; INCR=1048576 bytes; unsafe conversions=0; new owner and native copy survive");
    println!("GTK_PEER_ARTIFACTS={}", peer.directory.display());
}

#[test]
#[ignore = "requires the real GTK clipboard owner"]
fn linux_clipboard_same_xid_new_copy_is_not_replaced() {
    let peer = Peer::start();
    let mut owner = Owner::open().unwrap();
    let original = owner.owner();
    let snapshot = owner.save().unwrap();
    peer.command("copy-same-timestamp:new data from same GTK owner");
    peer.wait_ack(&mut owner);
    assert_eq!(owner.owner(), original, "fixture must retain the same XID");
    let result = owner.begin_paste("must never overwrite new copy");
    assert!(
        result.is_err(),
        "same-XID clipboard replacement must be refused"
    );
    owner.restore(snapshot).unwrap();
    assert_eq!(
        peer.read(&mut owner, "UTF8_STRING").0,
        b"new data from same GTK owner"
    );
    println!("GTK_SAME_XID: owner={original}; new generation refused before clipboard replacement");
}
