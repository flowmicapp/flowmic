// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (correction: diff_correction → longest
//     common prefix → N × VK_BACK + append text; streaming interim re-type)
//
// Char-level diff between the previously-injected interim text and a new
// interim text. Produces the minimum (backspaces, append) operation pair so
// `SendInputClient::apply_correction` can backspace the differing suffix then
// type the new suffix. Comparison is at Unicode scalar boundaries (`char`),
// never bytes — CJK and emoji collapse to one backspace per visible code
// point, otherwise we eat half a surrogate / half a UTF-8 sequence.

/// Operation pair that turns `previous` into `current`. Apply by sending
/// `backspaces` BACKSPACE keystrokes, then typing `append`. Both zero/empty
/// for the identity case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionOps {
    /// Number of `char`s (Unicode scalars) to delete from the end.
    pub backspaces: usize,
    /// UTF-8 string to append after the backspaces.
    pub append: String,
}

impl CorrectionOps {
    pub fn noop() -> Self {
        Self {
            backspaces: 0,
            append: String::new(),
        }
    }

    pub fn is_noop(&self) -> bool {
        self.backspaces == 0 && self.append.is_empty()
    }
}

/// Compute the operation pair that turns `previous` into `current`.
///
/// 1. Walk both strings as `char` iterators, counting the longest common
///    prefix (in chars, not bytes).
/// 2. The differing suffix of `previous` becomes `backspaces` (its char count).
/// 3. The differing suffix of `current` becomes `append` (bytes after the
///    common-prefix byte boundary).
pub fn diff_correction(previous: &str, current: &str) -> CorrectionOps {
    let mut prev_chars = previous.char_indices();
    let mut curr_chars = current.char_indices();
    let mut common_chars: usize = 0;
    let mut common_bytes_in_current: usize = 0;

    loop {
        match (prev_chars.next(), curr_chars.next()) {
            (Some((_, p)), Some((c_idx, c))) if p == c => {
                common_chars += 1;
                common_bytes_in_current = c_idx + c.len_utf8();
            }
            _ => break,
        }
    }

    let prev_total = previous.chars().count();
    let backspaces = prev_total.saturating_sub(common_chars);

    let append = if common_bytes_in_current >= current.len() {
        String::new()
    } else {
        current[common_bytes_in_current..].to_owned()
    };

    CorrectionOps { backspaces, append }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apply `ops` to `previous` the way the runtime would: drop the last
    /// `ops.backspaces` chars, then concat `ops.append`.
    fn apply(previous: &str, ops: &CorrectionOps) -> String {
        let kept_chars = previous.chars().count().saturating_sub(ops.backspaces);
        let kept: String = previous.chars().take(kept_chars).collect();
        kept + &ops.append
    }

    #[test]
    fn identity_is_noop() {
        let ops = diff_correction("hello", "hello");
        assert_eq!(ops, CorrectionOps::noop());
        assert!(ops.is_noop());
    }

    #[test]
    fn pure_append_ascii() {
        let ops = diff_correction("hello", "hello world");
        assert_eq!(ops.backspaces, 0);
        assert_eq!(ops.append, " world");
    }

    #[test]
    fn total_replace_ascii() {
        let ops = diff_correction("foo", "bar");
        assert_eq!(ops.backspaces, 3);
        assert_eq!(ops.append, "bar");
    }

    #[test]
    fn partial_overlap_ascii() {
        let ops = diff_correction("hello world", "hello there");
        assert_eq!(ops.backspaces, 5);
        assert_eq!(ops.append, "there");
        assert_eq!(apply("hello world", &ops), "hello there");
    }

    #[test]
    fn previous_empty_and_current_empty() {
        let a = diff_correction("", "fresh");
        assert_eq!(a.backspaces, 0);
        assert_eq!(a.append, "fresh");
        let b = diff_correction("clear me", "");
        assert_eq!(b.backspaces, 8);
        assert_eq!(b.append, "");
    }

    #[test]
    fn cjk_counts_chars_not_bytes() {
        // 你好世 -> 你好界 ("hello-good-world" -> "hello-good-realm", swapping the
        // last character, both meaning roughly "world"): must be 1 backspace, not 3 (bytes).
        let ops = diff_correction("你好世", "你好界");
        assert_eq!(ops.backspaces, 1, "must count chars not bytes for CJK");
        assert_eq!(ops.append, "界");
        assert_eq!(apply("你好世", &ops), "你好界");
    }

    #[test]
    fn emoji_replace_is_one_scalar_backspace() {
        // Replace one emoji with another — 1 backspace not 4 (bytes).
        let ops = diff_correction("react 😀", "react 😎");
        assert_eq!(ops.backspaces, 1);
        assert_eq!(ops.append, "😎");
        assert_eq!(apply("react 😀", &ops), "react 😎");
    }

    #[test]
    fn mixed_scripts_roundtrip() {
        let prev = "Hello 你好 😀";
        let curr = "Hello 你好 🎉 world";
        let ops = diff_correction(prev, curr);
        assert_eq!(apply(prev, &ops), curr);
    }
}
