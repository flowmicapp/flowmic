// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §1.3 (version comparison)
//   docs/decisions/2026-08-02-in-app-update-both-ends.md (「版本号只进不退，
//     出坏版发下一版」— "version numbers only go forward, never back; a bad
//     release gets fixed by shipping the next one")
//
// Three numeric segments, compared segment by segment. The whole file exists so
// that ONE rule is structural rather than conventional:
//
//   🔴 THERE IS NO DOWNGRADE PATH.
//
// A convention ("we just never call it with an older manifest") is a sentence in
// a document. A structure is `UpdateVerdict` having no variant that means「清单
// 比我们旧」("the manifest is older than us") — so the downgrade branch is not
// guarded, it is *unwriteable*. To
// add one, somebody would have to add a variant and every `match` in the crate
// would stop compiling until they had answered for it. That is the difference
// between a rule you can forget and a rule the compiler holds.

use std::fmt;

/// A parsed `x.y.z`.
///
/// The derived `Ord` compares fields in declaration order — major, then minor,
/// then patch — which is precisely the §1.3 rule. It is derived rather than
/// hand-written on purpose: a hand-rolled comparator is one more place for
/// `0.2.9 > 0.2.10` (string compare) to sneak back in, and that specific bug is
/// why the version face is three integers and not a string in the first place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    /// Parse exactly three numeric segments. Anything else is `None`.
    ///
    /// Deliberately strict, and the strictness is load-bearing in one direction:
    /// a value we cannot read must never be *guessed* into a number, because
    /// every guess here is either 「你已经是最新的」("you're already on the latest") for a user who is not, or an
    /// update offer for a version that does not exist. `bump-version.mjs` emits
    /// exactly this shape across every version face, and `verify:lint
    /// version-sync` fails the build if any face drifts — so a value this
    /// function rejects is a build defect, not a user situation.
    ///
    /// ⚠️ NOT accepted, each for a reason rather than by omission:
    ///   • a leading `v` — the manifest carries bare `x.y.z` (server-side
    ///     `VERSION_RE = /^\d+\.\d+\.\d+$/`), and accepting `v0.2.59` here while
    ///     the endpoint refuses it would put the two validators in disagreement
    ///     about what a version IS.
    ///   • four segments / pre-release suffixes (`0.2.59-beta`) — this product
    ///     has never shipped one, and inventing an ordering for a shape we do
    ///     not produce would be a rule with no measurement behind it.
    ///   • leading `+`, whitespace, or `+5` (Rust's `u32::from_str` accepts a
    ///     leading `+`, which would make `0.+2.59` parse) — hence the explicit
    ///     ASCII-digit check below rather than a bare `.parse()`.
    pub fn parse(raw: &str) -> Option<Self> {
        let mut it = raw.split('.');
        let major = parse_segment(it.next()?)?;
        let minor = parse_segment(it.next()?)?;
        let patch = parse_segment(it.next()?)?;
        if it.next().is_some() {
            return None;
        }
        Some(Self { major, minor, patch })
    }

    /// This build's own version, from the crate manifest.
    ///
    /// 🔴 `CARGO_PKG_VERSION` and not a literal: it is one of the faces
    /// `bump-version.mjs` writes and `verify:lint version-sync` guards, so it
    /// cannot drift from the product's version without the gate going red. A
    /// literal here would be a tenth version face that nothing checks — and the
    /// failure mode is silent and permanent ("this build believes it is
    /// 0.2.40 forever", i.e. it offers an update every single day).
    ///
    /// `Option` rather than an unwrap because a panic at check time would take
    /// the whole app down over a cosmetic string; the test below pins that this
    /// build's value really does parse, so `None` here means somebody changed
    /// the versioning scheme and the gate will say so.
    pub fn current() -> Option<Self> {
        Self::parse(env!("CARGO_PKG_VERSION"))
    }
}

/// One segment: ASCII digits only, and it must fit.
fn parse_segment(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// What the comparison concluded. **Two variants, forever.**
///
/// 🔴 Read the module header before adding a third. The absence of a
/// `Downgrade` / `Older` variant is the mechanism, not an oversight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateVerdict {
    /// The manifest offers a STRICTLY greater version.
    UpdateAvailable { current: Version, latest: Version },
    /// The manifest offers the same version or an older one.
    ///
    /// 🔴 This is the ONLY state in the entire update core that may be rendered
    /// as 「已是最新」("already up to date"). Every failure — unreachable, 404,
    /// 503, unparsable — is a
    /// different sentence, because 未知 ≠ 最新 ("unknown ≠ latest") (design §3,
    /// and the endpoint's own
    /// header says the same thing about why it answers 503 instead of an empty
    /// manifest).
    UpToDate { current: Version },
}

/// Compare what the manifest offers against what we are.
///
/// Strictly greater wins; `Equal` and `Less` collapse into the same answer
/// because they demand the same action — none. That collapse is safe in a way
/// the reverse would not be: mistaking a newer build for current costs one
/// missed update notice, while mistaking an older build for newer would walk a
/// user backwards through an installer.
pub fn evaluate(current: Version, latest: Version) -> UpdateVerdict {
    if latest > current {
        UpdateVerdict::UpdateAvailable { current, latest }
    } else {
        UpdateVerdict::UpToDate { current }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("{s} should parse"))
    }

    #[test]
    fn three_numeric_segments_and_nothing_else() {
        assert_eq!(v("0.2.59"), Version { major: 0, minor: 2, patch: 59 });
        assert_eq!(v("10.20.30"), Version { major: 10, minor: 20, patch: 30 });
        for bad in [
            "",
            "0.2",
            "0.2.59.1",
            "v0.2.59",      // the endpoint refuses this shape too
            "0.2.59-beta",  // never shipped; no ordering has been decided for it
            "0.2.x",
            "0..59",
            " 0.2.59",
            "0.+2.59",      // `u32::from_str` would take the `+` without the digit check
            "0.2.59 ",
            "０.２.５９",   // full-width digits are not ASCII digits
        ] {
            assert!(Version::parse(bad).is_none(), "{bad:?} must not parse");
        }
    }

    /// 🔴 The bug this file's integer representation exists to prevent. As strings,
    /// "0.2.9" > "0.2.10" — and that is not hypothetical for this product,
    /// which is at patch 59 and climbing one per delivery round.
    #[test]
    fn double_digit_segments_order_numerically_not_lexically() {
        assert!(v("0.2.10") > v("0.2.9"));
        assert!(v("0.10.0") > v("0.9.99"));
        assert!(v("1.0.0") > v("0.99.99"));
    }

    /// 🔴 THE REVERSE-CONTROL TARGET. Making `evaluate` accept equal-as-newer
    /// (`latest >= current`) must make this test red — it is the assertion that
    /// stands between the user and an update prompt that never goes away,
    /// offering them the version they are already running.
    #[test]
    fn only_a_strictly_greater_version_is_an_update() {
        let mine = v("0.2.59");

        assert_eq!(
            evaluate(mine, v("0.2.60")),
            UpdateVerdict::UpdateAvailable { current: mine, latest: v("0.2.60") },
        );
        assert_eq!(
            evaluate(mine, v("0.3.0")),
            UpdateVerdict::UpdateAvailable { current: mine, latest: v("0.3.0") },
        );

        // EQUAL is not an update.
        assert_eq!(evaluate(mine, mine), UpdateVerdict::UpToDate { current: mine });
        // …and neither is anything below it. There is no downgrade path: the
        // type system has no variant to put one in, so the only way this can be
        // got wrong is by calling an older manifest an update.
        for older in ["0.2.58", "0.1.99", "0.0.1"] {
            assert_eq!(
                evaluate(mine, v(older)),
                UpdateVerdict::UpToDate { current: mine },
                "{older} is older than {mine} — it can never be an update",
            );
        }
    }

    /// The version face this crate reads must be one this code can read.
    ///
    /// 🔴 Not a tautology: if somebody ever sets the crate version to a shape
    /// `parse` refuses (a `-rc1` suffix, a four-segment build number), the
    /// update check would silently stop working ON EVERY MACHINE — `current()`
    /// returns `None`, the check can never conclude anything, and no gate in
    /// the repo would notice, because `version-sync` only asserts the faces
    /// AGREE with each other, never that this code can parse them.
    #[test]
    fn this_builds_own_version_is_a_shape_we_can_compare() {
        let mine = Version::current().unwrap_or_else(|| {
            panic!(
                "CARGO_PKG_VERSION = {:?} does not parse as x.y.z — the update check \
                 would be dead on arrival on every machine",
                env!("CARGO_PKG_VERSION"),
            )
        });
        // Round-trips, so the string we show a user is the number we compared.
        assert_eq!(mine.to_string(), env!("CARGO_PKG_VERSION"));
    }
}
