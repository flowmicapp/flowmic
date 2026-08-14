// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (port pinned at 41879 — 「adopt-first on :41879」)
//   CLAUDE.md red line: no silent failure
//
// Which TCP port the local server is on. Split out of `sidecar/io.rs` for the
// 800-line cap (`portclear.rs` / `node_runtime.rs` precedent) and re-exported
// from there, so no existing caller has to learn a new path.
//
// The whole module exists to make ONE thing impossible: quietly ending up on
// :41879 when somebody asked for a different port. That is not tidiness. The
// chain it prevents is measured and it ends in a kill:
//   two copies on one port
//     → the loser probes the winner (`crate::sidecar::adopt::probe_existing`)
//     → the probe rules it FOREIGN whenever the two run different `server.js`
//       files, which is the normal state of a dev tree beside an install
//     → `crate::sidecar::portclear::clear_port` reclaims the port with
//       `netstat -ano` + `taskkill /F /PID`.
// A silent fallback anywhere in here is therefore a fallback INTO that chain.

use crate::forensic;

/// The DEFAULT standalone port (F-2232 — below the Windows ephemeral 49152+
/// range). Shipping builds use exactly this number; `sidecar_port()` is the one
/// function allowed to answer「which port are we actually on」.
///
/// 🔴 RENAMED from `SIDECAR_PORT` when the override below was added, and the
/// rename is the point rather than tidiness: with an override in play, a bare
/// `SIDECAR_PORT` would be a SECOND answer to a question that must have one —
/// the repo's #1 (头号) bug shape. The old name no longer exists, so a call site that
/// meant「the constant」cannot silently keep meaning it after someone sets the
/// environment variable.
pub const SIDECAR_PORT_DEFAULT: u16 = 41879;

/// Explicit, named opt-out from the fixed port.
///
/// WHY IT EXISTS: the single-instance identity is a named kernel object now
/// (see `crate::single_instance`), so a second copy of this app cannot become a
/// second「first instance」by accident. But a developer legitimately wants two
/// isolated instances sometimes, and the ONLY reason that used to half-work was
/// that nothing stopped it — both copies then contended for this hard-coded
/// port, and the loser's adopt probe (`crate::sidecar::adopt::probe_existing`)
/// can rule the other copy foreign and reclaim the port through
/// `crate::sidecar::portclear::clear_port`, which is `netstat -ano` +
/// `taskkill /F /PID`. That chain ends with one developer killing another
/// process's live sidecar.
///
/// ⇒ Two isolated instances are supported, but only when they are ASKED for:
/// `FLOWMIC_INSTANCE_TAG` (a distinct instance identity) plus THIS variable (a
/// distinct port). `crate::single_instance::resolve_scope` refuses the tag
/// unless this variable moved the port off the default, because a second
/// identity on the same port is precisely the kill chain above with the safety
/// net removed.
pub const SIDECAR_PORT_ENV: &str = "FLOWMIC_SIDECAR_PORT";

/// Why an override was refused. Carried as a value (not a pre-baked sentence)
/// so the caller decides whether it is a startup refusal or a panic, and so the
/// unit tests can assert the CLASSIFICATION rather than a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarPortError {
    /// Set, but to nothing. Deliberately NOT treated as「unset」: falling back
    /// to the default here is the silent fallback the red line (红线) forbids, and it is
    /// the exact shape that would hand a tagged second instance the first
    /// instance's port.
    Empty,
    /// Not a number, or outside `u16`.
    NotAPort(String),
    /// Parsed, but zero — `0` means「let the OS choose」in the sockets API, and
    /// this port has to be knowable in advance (the phone dials it, and the
    /// adopt probe looks for a listener on it).
    Zero,
}

impl std::fmt::Display for SidecarPortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarPortError::Empty => write!(
                f,
                "{SIDECAR_PORT_ENV} is set but empty — refusing to start rather than silently using :{SIDECAR_PORT_DEFAULT}"
            ),
            SidecarPortError::NotAPort(raw) => write!(
                f,
                "{SIDECAR_PORT_ENV}={raw:?} is not a TCP port (1-65535) — refusing to start rather than silently using :{SIDECAR_PORT_DEFAULT}"
            ),
            SidecarPortError::Zero => write!(
                f,
                "{SIDECAR_PORT_ENV}=0 asks the OS to pick a port, which nothing downstream could then dial — refusing to start rather than silently using :{SIDECAR_PORT_DEFAULT}"
            ),
        }
    }
}

/// The pure half: raw environment value → port. `None` (absent) is the ONLY
/// input that yields the default; every present-but-bad value is an error.
///
/// Trimmed before parsing because a `set VAR=41880 ` typed with a trailing space
/// is a value somebody meant, not a value somebody fat-fingered — but a value
/// that is ONLY whitespace is `Empty`, which is refused.
pub fn parse_sidecar_port(raw: Option<&str>) -> Result<u16, SidecarPortError> {
    let Some(raw) = raw else { return Ok(SIDECAR_PORT_DEFAULT) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(SidecarPortError::Empty);
    }
    match trimmed.parse::<u16>() {
        Ok(0) => Err(SidecarPortError::Zero),
        Ok(p) => Ok(p),
        Err(_) => Err(SidecarPortError::NotAPort(trimmed.to_string())),
    }
}

/// Read + validate the override, without deciding what to do about a bad one.
/// `lib.rs`'s `run()` calls this during startup preflight so an invalid value
/// refuses the LAUNCH — explained on the record, before a window or a lock
/// exists — instead of exploding somewhere deeper.
pub fn sidecar_port_checked() -> Result<u16, SidecarPortError> {
    parse_sidecar_port(std::env::var(SIDECAR_PORT_ENV).ok().as_deref())
}

/// The single answer to「which port is the local server on」.
///
/// 🔴 It PANICS on an invalid override, and that is the fail-loud requirement,
/// not an oversight. The shipping path never reaches the panic: `run()`'s
/// preflight (`sidecar_port_checked`) refuses the launch with a forensic line
/// first. The panic is the backstop for callers that have no preflight — the
/// headless examples and any future embedder — because the alternative for them
/// is silently getting `:41879`, i.e. contending for the port the real instance
/// is on, which is how the reclaim chain gets to `taskkill`.
pub fn sidecar_port() -> u16 {
    match sidecar_port_checked() {
        Ok(p) => p,
        Err(e) => {
            forensic::record("sidecar", &format!("REFUSED to resolve the sidecar port: {e}"));
            eprintln!("[flowmic] {e}");
            panic!("{e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 🔴 These drive `parse_sidecar_port` (the pure half) and NEVER
    // `std::env::set_var`. Two reasons, and the second one is the real one:
    //   1. `cargo test` runs test fns concurrently in ONE process, so a test
    //      that mutates the process environment can change what an unrelated
    //      test on another thread reads.
    //   2. A test that sets the variable would be measuring the environment,
    //      not the decision. The decision is「absent → default, present-and-bad
    //      → refuse」, and that is a total function of one `Option<&str>`.

    #[test]
    fn an_absent_override_is_the_shipped_default_port() {
        assert_eq!(parse_sidecar_port(None), Ok(SIDECAR_PORT_DEFAULT));
        assert_eq!(SIDECAR_PORT_DEFAULT, 41879, "the shipped port is part of the pairing contract");
    }

    #[test]
    fn a_valid_override_is_taken_verbatim() {
        assert_eq!(parse_sidecar_port(Some("41880")), Ok(41880));
        assert_eq!(parse_sidecar_port(Some("1")), Ok(1));
        assert_eq!(parse_sidecar_port(Some("65535")), Ok(65535));
        // Surrounding whitespace is a shell artefact, not a different intent.
        assert_eq!(parse_sidecar_port(Some("  41880  ")), Ok(41880));
    }

    /// 🔴 The whole point of the card: an invalid value must REFUSE, never fall
    /// back. A silent fallback here would put a developer's second instance on
    /// the port the real instance is serving — and the adopt probe can then
    /// rule that real instance foreign and `taskkill` its sidecar.
    ///
    /// The assertions are on the ERROR CLASSIFICATION rather than on the
    /// sentence, so rewording a message cannot go red and a behaviour change
    /// cannot go green.
    #[test]
    fn an_invalid_override_refuses_loudly_instead_of_falling_back() {
        for bad in ["", "   "] {
            assert_eq!(parse_sidecar_port(Some(bad)), Err(SidecarPortError::Empty), "input {bad:?}");
        }
        assert_eq!(parse_sidecar_port(Some("0")), Err(SidecarPortError::Zero));
        for bad in ["forty-two", "41880x", "-1", "65536", "418.79", "0x1234", ""] {
            let got = parse_sidecar_port(Some(bad));
            assert!(got.is_err(), "{bad:?} must be refused, got {got:?}");
            assert_ne!(
                got,
                Ok(SIDECAR_PORT_DEFAULT),
                "{bad:?} fell back to the default — that is the silent fallback this card removes"
            );
        }
        // And the refusal must be sayable: an error nobody can print is an
        // error nobody can act on.
        for e in [
            SidecarPortError::Empty,
            SidecarPortError::Zero,
            SidecarPortError::NotAPort("forty-two".to_string()),
        ] {
            let msg = e.to_string();
            assert!(msg.contains(SIDECAR_PORT_ENV), "the message must name the variable: {msg}");
            assert!(msg.contains("refusing to start"), "the message must state the consequence: {msg}");
        }
    }
}
