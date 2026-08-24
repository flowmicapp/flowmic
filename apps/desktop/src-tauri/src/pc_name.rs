// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7 (reserved key device.pc_name, F-3101)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-10 / F-ruling-6
//
// THIS PC'S NAME — and why the default had to change.
//
// The default was the literal `"FlowMic PC"` (lib.rs). One machine, fine. Two
// machines on one account and the phone's pairing list shows two rows with the
// same label and no way to tell them apart — the exact problem 「device
// distinguishability」 was
// supposed to solve. owner's 2026-07-26 iron rule ④: the default name must be unique.
//
// The shape is `FlowMic-<hostname>-<XXXX>`:
//
//   · `hostname` alone is usually unique on a LAN but NOT guaranteed — a cloned
//     or reimaged machine keeps its name, and this account spans networks;
//   · a machine-GUID digest alone is unique but unreadable, and a user picking
//     between 「FlowMic-3f7a」 and 「FlowMic-91c2」 is picking at random;
//   · together they are both readable and unique.
//
// The raw machine id NEVER leaves the machine: only the first two bytes of its
// SHA-256 are used, and only as a disambiguator. Four hex characters is a
// deliberate choice — enough to separate the handful of PCs one person owns,
// too little to be an identifier worth correlating.
//
// The user can rename it at any time (04 §3.7); this is only what a fresh
// install proposes.

/// 04 §3.7: trim non-empty, ≤80 chars. Mirrored from the server so the desktop
/// refuses a name locally instead of learning about it from an ack.
pub const PC_NAME_MAX_CHARS: usize = 80;

/// Validate a user-typed name. `None` = refuse (empty after trim, or too long).
/// Deliberately does NOT truncate: silently storing something other than what
/// the user typed is the quiet kind of lie.
pub fn sanitize_pc_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > PC_NAME_MAX_CHARS {
        return None;
    }
    Some(name.to_string())
}

/// Build the default name from the two parts. Pure, so the composition rule is
/// testable without a registry or a hostname.
pub fn compose_default_name(hostname: &str, machine_id: &str) -> String {
    let host = hostname.trim();
    let suffix = short_digest(machine_id);
    if host.is_empty() {
        return format!("FlowMic-{suffix}");
    }
    // A hostname can be long; the whole thing still has to fit the 80-char cap
    // with room for the prefix and suffix.
    let host: String = host.chars().take(60).collect();
    format!("FlowMic-{host}-{suffix}")
}

/// First 2 bytes of SHA-256(machine_id) as lowercase hex. An empty/unknown id
/// yields a stable placeholder rather than a random one — a name that changed on
/// every launch would be worse than a duplicate.
pub fn short_digest(machine_id: &str) -> String {
    let id = machine_id.trim();
    if id.is_empty() {
        return "0000".to_string();
    }
    let digest = sha256(id.as_bytes());
    format!("{:02x}{:02x}", digest[0], digest[1])
}

/// This machine's stable id. On Windows that is the Cryptography MachineGuid,
/// which survives renames and reboots; anywhere else (and on a locked-down box
/// where the read fails) the hostname stands in, which still beats a constant.
///
/// 🔴 In-place correction (MAC-02, 2026-08-07) —「anywhere else … the hostname stands in,
/// which still beats a constant」**the original text is kept**: it is true against
/// the "a constant" comparison it was written for, **but on macOS "better than a
/// constant" is nowhere near enough**. This value is the anchor for the "the
/// destination is a machine, not a connection" iron rule
/// (`2026-07-31-queue-destination-is-a-machine-not-a-connection.md`),
/// and macOS's hostname **changes on its own**: joining a different network, DHCP
/// assignment, or changing the sharing name in System Settings all change it ⇒ the
/// SAME Mac becomes "a different machine" the moment it switches networks,
/// addressing and per-machine dedup drift on the spot, and **no layer will ever
/// report an error** (every layer is correctly serving a wrong identity).
/// ⇒ macOS switches to **IOPlatformUUID** (board-level, tied to the machine not the
/// name). hostname is still the
/// last-resort fallback, it is just no longer macOS's first answer.
/// ⚠️ This card has to land **before the first real pairing**: once a phone has
/// paired against the old identity, changing the identity is equivalent to
/// swapping out the machine it paired with. As of this window there is no real
/// pairing on macOS yet (the `.app`
/// has never been launched, see `2026-08-06-macmini-onboarding-findings.md` §5) ⇒ no migration debt.
///
/// Resolved ONCE per process, and the cache is on THIS function rather than only
/// on its callers because the cost is here: on Windows this shells out to
/// `reg.exe`. Every caller is a repeat offender —
/// `socket_config_from_env()` (→ `default_pc_name`) runs on each
/// `connect_socket` AND inside `reconcile_stored_pc_name`, i.e. ~4× per launch,
/// and v0.2.4 added `machine_uid()` on register / reconnect / `pairing_code`.
/// owner 2026-07-29 saw the sum as 「N black-screen flashes at startup」.
///
/// Caching is safe because the value is a property of the machine, not of the
/// session: a MachineGuid does not change while a process is running, and the
/// hostname fallback is re-read only if the whole process restarts.
pub fn machine_id() -> String {
    static CACHED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHED.get_or_init(read_machine_id_uncached).clone()
}

fn read_machine_id_uncached() -> String {
    #[cfg(windows)]
    {
        if let Some(guid) = read_machine_guid() {
            return guid;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(uuid) = read_io_platform_uuid() {
            return uuid;
        }
    }
    hostname()
}

/// macOS's board-level machine id (MAC-02). Read via `ioreg` for the same reason
/// Windows shells out to `reg.exe`: one string is not worth a new dependency, and
/// a failure here is not an error — `machine_id` falls back to the hostname.
///
/// No `CREATE_NO_WINDOW` equivalent is needed or exists: the black-flash problem
/// that flag solves is a Win32 console behaviour, and a spawned process on macOS
/// has no console of its own to show. (Said explicitly because the Windows branch
/// right above carries a loud warning about it, and the natural next question is
/// "why isn't that here too".)
#[cfg(target_os = "macos")]
fn read_io_platform_uuid() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // The line looks like:  "IOPlatformUUID" = "0A1B2C3D-...-..."
    let value = text
        .lines()
        .find(|l| l.contains("IOPlatformUUID"))
        .and_then(|l| l.split('=').nth(1))
        .map(|v| v.trim().trim_matches('"').trim().to_string())?;
    if value.is_empty() {
        return None;
    }
    Some(value)
}

#[cfg(windows)]
fn read_machine_guid() -> Option<String> {
    use std::os::windows::process::CommandExt;
    // Read via `reg query` rather than pulling a registry crate in for one
    // string. A failure here is not an error — `machine_id` falls back.
    //
    // CREATE_NO_WINDOW is NOT optional (owner 2026-07-29:「N black-screen flashes at startup」).
    // A bare `Command::new` on Windows gives the child its own console, which
    // flashes a black window on screen for as long as `reg.exe` lives. It was
    // invisible while this ran ONCE per process for the default machine name;
    // v0.2.4 put `machine_uid()` on pc:register, pc:reconnect AND the
    // `pairing_code` command — which the device page invokes on mount and on
    // every connection-state change — so the same call site became N flashes.
    // The cache in `machine_uid()` fixes the count; this fixes the flash, and
    // both are needed: one spawn that flashes is still one flash.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let value = text
        .lines()
        .find(|l| l.contains("MachineGuid"))
        .and_then(|l| l.split_whitespace().last())?;
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

// ── v0.2.4: 「is this the same PC」 ────────────────────────────────────────────
//
// owner 2026-07-29:「PC 端要有一个唯一的实例名或 ID 来区分是否同一 PC……手机在外
// 部网络是通过云端中继来访问，如外出办公，在内网环境使用本地局域网环境，但应能明
// 确知道是否都是同一台手机和同一台 PC」 ("the PC side needs a unique instance name
// or ID to distinguish whether it's the same PC ... when the phone is on an
// external network it connects via the cloud relay, e.g. working away from the
// office, and on an internal network it uses the local LAN environment, but it
// should be able to clearly know whether it's the same phone and the same PC
// every time").
//
// `client_instance_id` cannot answer that and must not be made to: it lives in
// the per-channel credentials file, so LAN and cloud each mint their own — and
// the phone keys its stored pairings on it (auth/token_storage.dart
// `connectionIdentity`), so making the two channels share one would make the
// phone's own store dedupe a PC's two pairings into one and throw a token away.
//
// The machine uid is DERIVED instead of stored. That is the whole design: two
// channels computing the same pure function of the same machine can never
// disagree, so there is no second file and nothing to reconcile. This is the
// lesson of the 0.2.1 `device_name` split — two credential files, two answers,
// and a reconciliation pass that had to be written to heal it afterwards.
//
// SEED = MachineGuid + the WINDOWS USER, and the second half is load-bearing.
// The server resolves a returning machine by this uid when the instance id
// misses (registry.registerPc ②). Without the user in the seed, two Windows
// accounts on one PC under one FlowMic account would resolve onto each other's
// row and rotate each other's token forever. The credential store is already
// user-scoped (DPAPI), so 「this Windows account on this machine」 is the honest
// unit regardless.
//
// The raw MachineGuid NEVER travels — only 8 bytes of its SHA-256, the same
// rule device_label.dart applies to ANDROID_ID on the phone.

/// The Windows account this process runs as, or empty when unreadable.
pub fn os_user() -> String {
    for key in ["USERNAME", "USER"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    String::new()
}

/// Build the uid from its two parts. Pure, so the derivation is provable
/// without a registry — and so the 「two Windows users must not collide」
/// property is a unit test rather than a hope.
///
/// `None` when there is no machine id at all. Deliberate: a uid derived from
/// nothing would be IDENTICAL on every machine that also has nothing, and this
/// value decides whether the server treats two registrations as one PC. Having
/// no answer is safe (the server falls back to the instance id, i.e. exactly
/// the pre-0.2.4 behaviour); having a shared wrong answer merges strangers.
pub fn compose_machine_uid(machine_id: &str, os_user: &str) -> Option<String> {
    let id = machine_id.trim();
    if id.is_empty() {
        return None;
    }
    // Domain-separated so this digest can never coincide with some other
    // SHA-256 of the same machine id computed elsewhere for another purpose.
    let digest = sha256(format!("flowmic-machine-v1|{id}|{}", os_user.trim()).as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    // `pc-` prefix: matches protocol DeviceUid's `^[a-z]{2}-[0-9a-f]{16,48}$`
    // and makes a PC uid impossible to confuse with a phone's `mb-` in a log.
    Some(format!("pc-{hex}"))
}

/// This machine's cross-channel identity, or `None` when it cannot be derived.
///
/// Resolved ONCE per process. The MachineGuid and the Windows user cannot change
/// while this process runs, so re-deriving is pure cost — and on Windows it is
/// not even cheap cost: `machine_id()` shells out to `reg.exe`. v0.2.4 called
/// this on every register, every reconnect and every `pairing_code` invoke, and
/// the device page invokes that on mount and on every connection-state change.
/// owner saw the result as 「N black-screen flashes at startup」.
///
/// `OnceLock` rather than a mutex: the value is immutable and the first caller
/// racing a second one simply computes it twice and one result is dropped —
/// which is correct, because the function is pure.
pub fn machine_uid() -> Option<String> {
    static CACHED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| compose_machine_uid(&machine_id(), &os_user()))
        .clone()
}

/// The OS host name, or an empty string when it cannot be read.
pub fn hostname() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    String::new()
}

// ── 0.3.28: the NAME half had to stop being the hostname on macOS ───────────
//
// owner 2026-08-23: 「iOS/Mac 上要能检测到当前操作系统的类型，在命名时如果获取不到
// 机器标识或 ID 以机器系统类型来命名」 ("on iOS/Mac we must detect the current OS
// type, and when no machine identifier or ID can be obtained, name it by the
// machine's system type").
//
// 🔴 MAC-02 (above, in `machine_id`) already moved the IDENTITY off the
// hostname, and wrote down exactly why: **macOS's hostname changes on its
// own** — a different network, a DHCP assignment, or renaming the sharing name
// all change it. That correction stopped at the identity and left the NAME
// half untouched, which is this line's whole reason to exist: the same Mac
// still renames itself in the phone's pairing list when it moves network.
//
// 🔴 MEASURED ON THE ONE MAC WE HAVE, and it is worse than the sentence above
// predicted [flowmic-mac, macOS 26.5.1, 2026-08-24]:
//
//     hostname                  = 172-77-77-142.adr01.atmr.al.ip.frontiernet.net
//     scutil --get ComputerName = Bitbalabala的Mac mini
//     sysctl -n hw.model        = Mac16,10
//
// The first line is not a drifting machine name, it is **the ISP's reverse-DNS
// record for the current IP address**. Today that Mac's default name would be
// `FlowMic-172-77-77-142.adr01.atmr.al.ip.frontier-<4>` (the composer's 60-char
// clip lands mid-domain), and it would change with the address.
//
// ⇒ Two things follow, and only the second one was in the original plan:
//   ① macOS has a value that IS the counterpart of Windows' `COMPUTERNAME`,
//      and it is not `hostname()` — it is `scutil --get ComputerName`. Windows
//      was never reading a network-derived string; macOS was, by accident.
//      So the first rung is the user's own name for the machine.
//   ② `hw.model` = `Mac16,10` is the CLASS fallback owner asked for — and note
//      which arm of the table catches it: the generic Apple-Silicon one. A
//      prefix table of `Macmini` / `MacBookPro` / `iMac` would have returned
//      None **on the only Mac in this project**.
//
// ⚠️ **Windows is untouched, deliberately.** Nobody has reported a bad name
// there, `COMPUTERNAME` does not drift, and changing what a fresh Windows
// install proposes would split "what is this machine called" across versions
// for no gain.
//
// ⚠️ Only fresh installs see any of this. A machine that has stored a name
// keeps it (`reconcile_stored_pc_name` falls back to the default only when
// NEITHER channel has credentials), which is pinned by a test below rather
// than only asserted here.

/// The readable half of the default name for THIS platform.
///
/// Split out from [default_pc_name] so the platform choice has one home, and
/// so the pure mapping it leans on ([mac_hardware_class]) is testable on a box
/// that will never run the `sysctl` beside it.
fn default_name_half() -> String {
    // Cached for the same reason `machine_id` is: `default_pc_name` runs ~4×
    // per launch and each miss here would spawn a process.
    static CACHED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHED.get_or_init(read_name_half_uncached).clone()
}

fn read_name_half_uncached() -> String {
    #[cfg(target_os = "macos")]
    {
        // ① The user's OWN name for this machine — the true counterpart of the
        //    Windows branch below. Windows reads `COMPUTERNAME`, which IS the
        //    name the user set; the bug was that `hostname()`'s macOS answer is
        //    a completely different value that merely looks like one.
        if let Some(name) = read_scutil("ComputerName") {
            return name;
        }
        // ② owner's ask, literally: no machine name to be had ⇒ name it by what
        //    kind of machine it is.
        if let Some(class) = read_hw_model().as_deref().and_then(mac_hardware_class) {
            return class.to_string();
        }
        // ③ The old behaviour, demoted to third. See the measurement above for
        //    why it is no longer allowed anywhere near the top.
        let host = hostname();
        if !host.trim().is_empty() {
            return host;
        }
        // Never empty on a Mac: `compose_default_name` would then produce
        // `FlowMic-3f2a`, which answers "which machine is this" with four hex
        // digits and nothing else.
        //
        // ⚠️ No `return` — this block IS the whole function body once cfg has
        // removed the other one, so the tail expression is the return value and
        // `return` here is `clippy::needless_return`. Windows clippy cannot see
        // that (it compiles the other block), and it did not: caught by
        // `cargo clippy -D warnings` on the Mac mini, which is the only judge
        // this branch has.
        "Mac".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        hostname()
    }
}

/// One `scutil --get <key>`, trimmed, or `None`.
///
/// `ComputerName` is the name in System Settings → General → About, the one
/// Finder and AirDrop show. It is NOT the same value as `hostname()`, and that
/// distinction is the whole content of this change.
#[cfg(target_os = "macos")]
fn read_scutil(key: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", key])
        .output()
        .ok()?;
    // scutil writes "<key>: not set" to stderr and exits non-zero when unset;
    // an unset key must read as None, never as that sentence.
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

/// Apple's `hw.model` → the human name of the machine class.
///
/// Pure, and matched by PREFIX against an ORDERED table. Both properties are
/// load-bearing:
///
/// 🔴 **The order is the correctness.** `MacBookPro18,3` starts with `MacBook`,
/// so a table that tests `MacBook` first calls every MacBook Pro a "MacBook".
/// Longest-first is not tidiness here, it is the difference between a true and
/// a false name, and the test below walks the table in the order a wrong sort
/// would break.
///
/// 🔴 **The `Mac` arm at the bottom is not a catch-all afterthought — it is the
/// arm that serves most machines sold today.** Apple Silicon reports a GENERIC
/// identifier with no class word in it: Mac Studio is `Mac13,1`, the M2 Mac
/// mini is `Mac14,3`, and later models continue `Mac15,x` / `Mac16,x`. A table
/// of only the classic `Macmini` / `MacBookPro` / `iMac` prefixes returns
/// `None` for every one of them — silently, with the caller falling through to
/// the drifting hostname this whole change exists to stop using. The office Mac
/// mini is very likely in exactly that bucket.
///
/// `None` means "this string names no Mac at all" (empty, or something that is
/// not an Apple hardware identifier), and the caller then falls back rather
/// than inventing a class.
pub fn mac_hardware_class(hw_model: &str) -> Option<&'static str> {
    // Longest prefix first. `iMacPro` before `iMac`, the two MacBook variants
    // before `MacBook`, and the bare `Mac` last of all.
    const TABLE: &[(&str, &str)] = &[
        ("MacBookPro", "MacBook Pro"),
        ("MacBookAir", "MacBook Air"),
        ("MacBook", "MacBook"),
        ("Macmini", "Mac mini"),
        ("MacPro", "Mac Pro"),
        ("iMacPro", "iMac Pro"),
        ("iMac", "iMac"),
        // A VM under Virtualization.framework reports `VirtualMac2,1`. It is a
        // Mac to every layer that matters here, and calling it one beats
        // falling through to a hostname.
        ("VirtualMac", "Mac"),
        ("Mac", "Mac"),
    ];
    let model = hw_model.trim();
    if model.is_empty() {
        return None;
    }
    TABLE
        .iter()
        .find(|(prefix, _)| model.starts_with(prefix))
        .map(|(_, name)| *name)
}

/// This Mac's hardware model string (`Macmini9,1`, `Mac14,3`, …).
///
/// Shelled out for the same reason `ioreg` and `reg.exe` are: one string is not
/// worth a dependency, and a failure is not an error — the caller falls back.
#[cfg(target_os = "macos")]
fn read_hw_model() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.model"])
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

/// The name a fresh install proposes.
pub fn default_pc_name() -> String {
    compose_default_name(&default_name_half(), &machine_id())
}

// ── v0.2.1: ONE name per machine, not one per channel ───────────────────────
//
// owner's 2026-07-28 ruling:「PC 这端的名称应该是唯一的。不管通过本地局域网还是云端
// 中继建立链接，都能获取同一个名称」 ("the name on the PC side should be unique;
// regardless of whether the connection is established via the local LAN or the
// cloud relay, it should get the same name").
//
// The name was being stored PER CHANNEL, because each channel has its own
// credentials file and `device_name` is a field in it. A real smoke run of the
// 0.2.1 build proved the consequence in two adjacent log lines:
//
//   [rename] re-asserted pc name on connect: "FlowMic PC"        (cloud)
//   [rename] re-asserted pc name on connect: "office-pc-windows" (lan)
//
// Two channels, two files, two different names — one of them the pre-GA-10
// literal default. Making the rename write both channels (as this release does)
// stops NEW divergence, but it cannot heal what is already on disk, and the
// re-assert loop would have faithfully pinned each channel to its own wrong
// answer forever. The name has to be resolved to a single value BEFORE either
// channel registers.
//
// (This is why the smoke run matters: every unit test agreed with itself, and
// the split only existed in a file on one machine — doc 13 §7 F1 ③, 「all-green
// unit tests have zero proof value for wiring」.)

/// The pre-GA-10 literal default. Any credential still carrying it was never
/// renamed by the user — it is a leftover, not a choice, so it must never win a
/// reconciliation against a name someone actually set.
pub const LEGACY_DEFAULT_PC_NAME: &str = "FlowMic PC";

/// Whether `name` is something the USER chose, as opposed to a leftover default
/// or an empty slot.
fn is_user_chosen(name: Option<&str>) -> bool {
    match name.map(str::trim) {
        None | Some("") => false,
        Some(n) => n != LEGACY_DEFAULT_PC_NAME,
    }
}

/// The single name for this machine, given what each channel's credential holds.
///
/// Pure, so the precedence is provable without touching LOCALAPPDATA:
///   1. a user-chosen LAN name — that slot is the historical one the rename UI
///      has always targeted, so when both are real it is the more likely to be
///      the deliberate one;
///   2. otherwise a user-chosen CLOUD name;
///   3. otherwise `fallback` (the per-machine default).
///
/// Returns the name AND whether the two credentials disagreed, so the caller can
/// record it. A silent pick would leave 「when did my computer's name change」 unanswerable.
pub fn reconcile_machine_name(
    lan: Option<&str>,
    cloud: Option<&str>,
    fallback: &str,
) -> (String, bool) {
    let lan_ok = is_user_chosen(lan);
    let cloud_ok = is_user_chosen(cloud);
    let conflicted = lan_ok
        && cloud_ok
        && lan.map(str::trim) != cloud.map(str::trim);
    let chosen = if lan_ok {
        lan.unwrap_or("").trim().to_string()
    } else if cloud_ok {
        cloud.unwrap_or("").trim().to_string()
    } else {
        fallback.to_string()
    };
    (chosen, conflicted)
}

// ── SHA-256 (hand-rolled: this crate has no hash dependency and pulling one in
//    for four hex characters is the wrong trade) ─────────────────────────────
//
// 2026-08-01 — a SECOND consumer, hence `pub(crate)`: FPR v1 names an export's
// attachments by the content hash of their bytes (doc 16 §3), and BOTH ENDS have
// to compute the same name. A second implementation here would be a second
// answer to 「are these two sets of bytes the same」, which is this repo's #1 bug shape. It stays in
// this module rather than moving to one of its own so nothing has to be
// re-verified: the known-vector assertion below is what makes it trustworthy,
// and it is already here. Callers: `default_pc_name` / `machine_uid` (below),
// `portable::archive::digest_of`.
pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for (i, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].into_iter().enumerate() {
            h[i] = h[i].wrapping_add(v);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}
#[cfg(test)]
#[path = "pc_name_tests.rs"]
mod tests;
