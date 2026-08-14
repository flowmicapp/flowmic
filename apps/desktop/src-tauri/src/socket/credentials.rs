// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer — pc:reconnect uses the stored
//     token; E2EE MasterKey is DPAPI-protected at rest, and the pairing token
//     gets the SAME user-scoped DPAPI wrapping)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:register → token; pc:reconnect{token})
//   *** HUMAN-AUDIT SENSITIVE (pairing/auth) ***
//
// Local pairing-credential store. The token returned by pc:register is the
// desktop's bearer credential, so the whole credential file is DPAPI-protected
// (CryptProtectData, user-scoped — only the same Windows user on the same
// machine can unprotect it), mirroring apps/desktop's E2EE MasterKey at-rest
// path. It is never a cloud API key (no-cloud-keys) nor a settings key
// (settings-key-drift) — it is the desktop's own pairing state.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Persisted pairing credential. `token` is present once registered; the
/// device_name + client_instance_id are stable identity used across reconnects.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credentials {
    pub device_name: String,
    pub client_instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pc_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub room_uuid: Option<String>,
}

impl Credentials {
    /// A fresh credential with a stable identity and no token yet.
    pub fn fresh(device_name: impl Into<String>) -> Self {
        Self {
            device_name: device_name.into(),
            client_instance_id: format!("pc-{}", uuid::Uuid::new_v4()),
            token: None,
            pc_id: None,
            room_uuid: None,
        }
    }

    /// 「本机存着一个 token 吗」("does this machine have a token stored") — and ONLY that question.
    ///
    /// RV-34: this is the right question in exactly one place — deciding whether a
    /// fresh connection emits `pc:register` or `pc:reconnect{token}`. It was ALSO
    /// being read as 「服务器认了我」("the server recognized me") by the CONNECTION frame, the tray and the
    /// focus:state gate, which it cannot answer: a token is written to disk once and
    /// survives every socket drop, every server restart and every relay outage. The
    /// 0.2.19 forensic has the literal proof — `CONNECTION → ui (connected=false
    /// registered=true)`, i.e. 「没连上，但已挂号」("not connected, but already registered").
    ///
    /// 「服务器在这条连接上认了我吗」("did the server recognize me on THIS
    /// connection") is [`crate::socket::pairing::Pairing::handshake_acked`].
    /// Two judgments, one question each; neither is a substitute for the other.
    pub fn is_registered(&self) -> bool {
        self.token.is_some()
    }

    /// Record the pc:register ack (token + resolved ids), ready to persist.
    pub fn accept_registration(
        &mut self,
        token: impl Into<String>,
        pc_id: Option<String>,
        room_uuid: Option<String>,
    ) {
        self.token = Some(token.into());
        self.pc_id = pc_id;
        self.room_uuid = room_uuid;
    }

    /// Forget the token + resolved ids (auth:expired / dead-token recovery) so
    /// the next connection re-registers fresh instead of reconnect-looping a
    /// dead token. Identity (device_name / client_instance_id) is preserved.
    pub fn clear_token(&mut self) {
        self.token = None;
        self.pc_id = None;
        self.room_uuid = None;
    }

    /// Default on-disk location: %LOCALAPPDATA%/FlowMic/credentials.bin
    /// (a DPAPI blob, not JSON). Falls back to the OS temp dir when
    /// LOCALAPPDATA is unset (e.g. tests / non-Windows dev).
    ///
    /// 🔴 In-place correction (原地更正, MAC-01, 2026-08-07) — 「Falls back to the
    /// OS temp dir …
    /// (e.g. tests / non-Windows dev)」**the original text is kept**: when it was
    /// written it genuinely served only tests and
    /// non-Windows dev. **On a macOS product it becomes 「the pairing credential
    /// gets periodically deleted by the system」**
    /// ⇒ a phone the user paired last week has to be re-paired this week, and
    /// neither side says why.
    /// The platform decision is now answered exclusively by
    /// `crate::app_dirs::local_home()`. Windows is unchanged, byte for byte.
    /// ⚠️ This only changes **where it lands**; **"what protects it" is MAC-08's
    /// account**, see this file's
    /// `dpapi_protect` `cfg(not(windows))` branch — that half is plaintext on macOS.
    pub fn default_path() -> PathBuf {
        crate::app_dirs::local_home().join("credentials.bin")
    }

    /// Load + DPAPI-unprotect from `path`, or `None` when absent / unreadable /
    /// undecryptable / corrupt (any of these → re-pair, never a crash loop; a
    /// file written by a different Windows user simply fails to unprotect).
    ///
    /// On unix, a successful read is followed by [`ensure_user_only`]: upgrades
    /// keep a pre-MAC-08 `0644` file until something rewrites it, and the
    /// Devices-page claim that the file is owner-only would otherwise be false
    /// for the whole session.
    ///
    /// 🔴 A tighten failure MUST NOT become a `None`. The four cases above all
    /// mean "there is no usable identity here"; "the mode could not be changed"
    /// means the opposite — the credential was read fine. Conflating them costs
    /// the token outright: `shell::naming::persist_pc_name_on_disk` does
    /// `load(path).unwrap_or_else(|| Credentials::fresh(name))` and then saves,
    /// so a `None` here turns renaming the PC into overwriting a good pairing
    /// with a blank one. Logged instead of swallowed (no silent failure): the
    /// mode stays wide, and the forensic line is what says so.
    ///
    /// ⚠️ No test drives the failure arm: chmod on a file you own essentially
    /// cannot fail, and the environments that do make it fail (read-only mount,
    /// foreign owner) are not constructible in a unit test. The guarantee here
    /// is structural — `ensure_user_only` has no `?` on this path.
    pub fn load(path: &Path) -> Option<Self> {
        let protected = std::fs::read(path).ok()?;
        #[cfg(unix)]
        if let Err(e) = ensure_user_only(path) {
            crate::forensic::record(
                "credentials",
                &format!("mode tighten failed (file stays as-is, credential still loaded): {e}"),
            );
        }
        let plain = dpapi_unprotect(&protected).ok()?;
        serde_json::from_slice(&plain).ok()
    }

    /// DPAPI-protect + persist to `path`, creating the parent directory.
    /// Best-effort: an IO/crypto error is returned so callers can log it.
    ///
    /// ⚠️ On unix the file is 0600 — and that is the ONLY at-rest protection
    /// there, because `dpapi_protect` is an identity function off Windows.
    /// See [`write_user_only`].
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        let protected = dpapi_protect(&json).map_err(std::io::Error::other)?;
        write_user_only(path, &protected)
    }
}

// ── Writing a credential file ─────────────────────────────────────────
// One implementation, two callers (this file's `Credentials::save` and the
// cloud config's in socket::channel), for the same reason `dpapi_protect` is
// shared: a second hand-rolled copy is a second thing to audit.

/// Create the parent directory and write `bytes` so that, on unix, only the
/// current user can read the result (file 0600, directory 0700). On Windows the
/// bytes are DPAPI ciphertext and the ACL inherited from %LOCALAPPDATA% already
/// scopes them to this user, so the mode calls do not apply.
///
/// 🔴 MAC-08. This is NOT a substitute for encryption and must never be
/// described as one — see the `cfg(not(windows))` branch of `dpapi_protect`
/// below, which is an identity function. On macOS the bytes on disk are
/// plaintext JSON containing the pairing token; all this does is narrow
/// 「any local process running as any user can read it」 to 「anything running as
/// me can read it」. Measured 2026-08-10 on the Mac mini: the three credential
/// files were 0644. That is what this closes. The plaintext is still open.
///
/// ⚠️ TWO ORDERING DETAILS, both load-bearing:
///  1. The mode is set when the file is CREATED (`OpenOptions::mode`), not
///     chmod'd afterwards. A write-then-chmod leaves a window in which the
///     plaintext exists at 0644, which is the exact thing being fixed.
///  2. An ALREADY EXISTING file is passed through [`ensure_user_only`] BEFORE
///     being rewritten, because `OpenOptions::mode` is ignored when the file
///     is not created. Without this, every install that predates MAC-08 would
///     keep its 0644 file forever — a fix that only protects new users is not
///     a fix for the machine it was written for.
///
/// ⚠️ What it cannot undo: a file that has already been world-readable was
/// readable for as long as it existed. This narrows the future, not the past.
pub(super) fn write_user_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Best-effort: the directory may be shared with other app state and
            // may not be ours to tighten. A failure here must not stop the
            // credential from being written — losing the pairing is worse.
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if path.exists() {
            ensure_user_only(path)?;
        }
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        return f.flush();
    }

    #[cfg(not(unix))]
    std::fs::write(path, bytes)
}

/// On unix, clear every one of the low nine permission bits outside owner-rw,
/// so that part of the mode is a subset of `0o600`. Never adds bits (a `0o400`
/// file stays `0o400`).
///
/// ⚠️ Deliberately scoped to `0o777`: setuid/setgid/sticky are left alone. They
/// are meaningless on a non-executable data file, and the only way one gets set
/// is somebody chmod'ing it by hand — clearing it would be this function
/// guessing at intent it has no basis for. Say `0o777` rather than "every
/// permission bit" so the sentence stays true if anyone reads it as a contract.
///
/// `NotFound` is `Ok(())` — callers that care about absence already branch on
/// read. Other IO errors propagate. [`write_user_only`] returns them to its
/// caller (it is about to write plaintext, so a mode it could not tighten is a
/// reason to abort); [`Credentials::load`] and [`CloudConfig::load`] log and
/// carry on (the credential was read fine — see the note on `load`).
///
/// This function does not exist on Windows (`cfg(unix)` only). The data-dir ACL
/// plus DPAPI are the at-rest controls there; a no-op stub would look like work
/// and perform none.
#[cfg(unix)]
pub(super) fn ensure_user_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let meta = match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
        Ok(m) => m,
    };
    let mode = meta.permissions().mode();
    let tightened = (mode & !0o777) | (mode & 0o600);
    if tightened == mode {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(tightened))
}

// ── DPAPI (user-scoped) — Windows only ────────────────────────────────
// Ported mechanism from the E2EE MasterKey keystore: CryptProtectData /
// CryptUnprotectData with a CRYPT_INTEGER_BLOB in/out, LocalFree on the OS
// allocation.
//
// 🔴 In-place correction (原地更正, MAC-08, 2026-08-10, Mac mini [measured]) —
// the original text
// 「Non-Windows dev builds are identity (**not a security path; the desktop
// ships Windows-only**)」**is kept here for the record, it was true when written**.
// Today both halves are false: ① owner 2026-08-05 ruled that the open-source
// build must ship Windows/macOS/Linux
// three-platform portable versions, `docs/decisions/2026-08-05-owner-build-and-release-additions.md`;
// ② mac now **already has real user data** — measured: `credentials.bin` /
// `credentials-cloud.bin`
// / `cloud.bin`, all three are **plaintext JSON**, containing the pairing token and Cloud Key.
// ⇒ The sentence 「not a security path」 used to defend a **platform that did
// not exist**, and now defends a **platform that does exist**,
// with not a single word of the wording changed. This is exactly anti-façade
// ④: **an assertion flips as elsewhere changes, while it itself does not.**
// ⚠️ **This round only patched the file permissions (`write_user_only`), not
// encryption.** macOS's real solution is
// Keychain (`security` / `SecItem*`), which is the half of MAC-08 that is still open.
//
// `pub(super)`: the R6 T-2 cloud config (socket::channel) wraps the Cloud Key
// with the SAME user-scoped wrapper, so there is exactly ONE at-rest crypto
// implementation in the socket module to audit — never a second hand-rolled one.

#[cfg(windows)]
pub(super) fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&in_blob, PCWSTR::null(), None, None, None, 0, &mut out_blob)
            .map_err(|e| format!("CryptProtectData: {e}"))?;
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(out_blob.pbData as *mut _));
        Ok(out)
    }
}

#[cfg(windows)]
pub(super) fn dpapi_unprotect(protected: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: protected.len() as u32,
            pbData: protected.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&in_blob, Some(&mut PWSTR::null()), None, None, None, 0, &mut out_blob)
            .map_err(|e| format!("CryptUnprotectData: {e}"))?;
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(out_blob.pbData as *mut _));
        Ok(out)
    }
}

#[cfg(not(windows))]
pub(super) fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}
#[cfg(not(windows))]
pub(super) fn dpapi_unprotect(protected: &[u8]) -> Result<Vec<u8>, String> {
    Ok(protected.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_has_identity_but_no_token() {
        let c = Credentials::fresh("My PC");
        assert_eq!(c.device_name, "My PC");
        assert!(c.client_instance_id.starts_with("pc-"));
        assert!(!c.is_registered());
    }

    #[test]
    fn registration_round_trips_through_dpapi_protected_disk() {
        let dir = std::env::temp_dir().join(format!("flowmic-cred-{}", uuid::Uuid::new_v4()));
        let path = dir.join("credentials.bin");

        let mut c = Credentials::fresh("Round Trip PC");
        c.accept_registration("fm_tok_secret", Some("pc-1".into()), Some("room-9".into()));
        c.save(&path).expect("save");

        // On Windows the on-disk bytes are DPAPI ciphertext, never the token
        // plaintext (the whole point of #4).
        #[cfg(windows)]
        {
            let raw = std::fs::read(&path).expect("read raw");
            let hay = String::from_utf8_lossy(&raw);
            assert!(!hay.contains("fm_tok_secret"), "token must not be plaintext at rest");
        }

        let loaded = Credentials::load(&path).expect("load");
        assert_eq!(loaded.token.as_deref(), Some("fm_tok_secret"));
        assert_eq!(loaded.client_instance_id, c.client_instance_id, "identity stable");
        assert!(loaded.is_registered());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_token_forgets_secret_but_keeps_identity() {
        let mut c = Credentials::fresh("PC");
        c.accept_registration("tok", Some("p".into()), Some("r".into()));
        let id = c.client_instance_id.clone();
        c.clear_token();
        assert!(!c.is_registered());
        assert_eq!(c.pc_id, None);
        assert_eq!(c.room_uuid, None);
        assert_eq!(c.client_instance_id, id, "identity survives a token clear");
    }

    #[test]
    fn missing_file_loads_as_none() {
        let missing = std::env::temp_dir().join("flowmic-nope-does-not-exist.bin");
        assert!(Credentials::load(&missing).is_none());
    }

    // ── MAC-08 ────────────────────────────────────────────────────────────
    // 🔴 THESE TWO TESTS CANNOT RUN ON THE MACHINE THEY WERE WRITTEN ON.
    // The dev box is Windows, so `cfg(unix)` compiles them out entirely — they
    // are not skipped, they do not exist. That is the same shape as the MSI /
    // host-Node defect (「这条依赖在本机永远是绿的」, "on this machine this
    // dependency is always green"): a gate that is structurally
    // absent where the author works.
    // ⇒ They were run on the Mac mini over ssh, and the run is what counts as
    // evidence here. If you change `write_user_only`, re-run there. `cargo test`
    // passing on Windows says nothing about this pair.
    #[cfg(unix)]
    #[test]
    fn saved_credential_is_readable_only_by_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("flowmic-mode-{}", uuid::Uuid::new_v4()));
        let path = dir.join("credentials.bin");

        let mut c = Credentials::fresh("Mode PC");
        c.accept_registration("fm_tok_mode", None, None);
        c.save(&path).expect("save");

        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "credential file must not be group/world readable");

        let dir_mode = std::fs::metadata(&dir).expect("stat dir").permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "the directory holding it must not be listable by others");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The case every install that predates MAC-08 is in: the file is already
    /// there at 0644. `OpenOptions::mode` is ignored for an existing file, so
    /// without an explicit chmod this would stay 0644 forever.
    #[cfg(unix)]
    #[test]
    fn rewriting_an_existing_world_readable_file_tightens_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("flowmic-mode-pre-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("credentials.bin");

        // Simulate the pre-fix state, deliberately not via `save()`.
        std::fs::write(&path, b"stale").expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644,
            "the premise of this test is that the file starts world-readable"
        );

        let mut c = Credentials::fresh("Upgrade PC");
        c.accept_registration("fm_tok_upgrade", None, None);
        c.save(&path).expect("save over the old file");

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600,
            "an existing credential file must be tightened, not left as it was"
        );
        assert_eq!(
            Credentials::load(&path).and_then(|c| c.token),
            Some("fm_tok_upgrade".to_string()),
            "and it must still be loadable afterwards"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Startup / read path: an upgraded install loads credentials without
    /// rewriting them. `write_user_only` never runs, so without
    /// [`ensure_user_only`] inside [`Credentials::load`] the file would stay
    /// world-readable for the whole session while the Devices page claims
    /// otherwise.
    #[cfg(unix)]
    #[test]
    fn loading_a_world_readable_credential_tightens_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("flowmic-mode-load-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("credentials.bin");

        // Pre-MAC-08 shape: valid plaintext JSON (dpapi_protect is identity off
        // Windows) at 0644, written without going through `save()`.
        let mut c = Credentials::fresh("Load Upgrade PC");
        c.accept_registration("fm_tok_load_upgrade", None, None);
        let json = serde_json::to_vec(&c).expect("json");
        std::fs::write(&path, &json).expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644,
            "premise: the file starts world-readable"
        );

        let loaded = Credentials::load(&path).expect("load");
        assert_eq!(loaded.token.as_deref(), Some("fm_tok_load_upgrade"));
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600,
            "load must tighten a pre-existing world-readable credential file"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Constraint: only ever remove bits. A file that is already stricter than
    /// 0600 must not be opened up to owner-write.
    #[cfg(unix)]
    #[test]
    fn ensure_user_only_does_not_loosen_stricter_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("flowmic-mode-strict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("credentials.bin");

        std::fs::write(&path, b"secret").expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).expect("chmod");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o400,
            "premise: the file starts owner-read-only"
        );

        ensure_user_only(&path).expect("ensure");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o400,
            "must not add the owner-write bit"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
