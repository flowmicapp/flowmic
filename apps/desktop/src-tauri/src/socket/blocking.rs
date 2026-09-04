// P0 2026-09-03 — THE PAIRED-PHONE TABLE WENT BLANK IN 0.3.58, AND THIS IS WHY.
//
// `a938e197` (WP-5) marked twelve Tauri commands `#[tauri::command(async)]` so a
// five-second device-page verb would stop freezing the window. Tauri dispatches
// those through `ipc::respond_async -> async_runtime::spawn`, i.e. onto a tokio
// MULTI-THREAD worker (`tokio-rt-worker`). Their bodies were, and still are,
// synchronous: `list_paired_mobiles` reaches
// `socket::outbound::fetch_paired_mobiles -> Client::emit_with_ack`, and
// `rust_engineio` 0.6.0 drives that frame, in its websocket transport, with its
// own `Runtime::block_on`. `Runtime::block_on` called from a thread that is
// already inside a runtime PANICS — "Cannot start a runtime from within a
// runtime". The spawned task dies, `resolver.respond` never runs, the JS
// `invoke` never settles, and the table renders nothing forever.
//
// MEASURED, not reasoned [window-forensics.log, dev-pc-a]: zero engineio
// panics across 08-27..09-02 (20,000 lines); sixteen of them on 09-02, the first
// 1.1 s after the first 0.3.58 launch, each immediately after a
// `fe.bridge#N CONNECTION <- ui` (the device page's refresh). Under 0.3.55 the
// same verb reached the wire — `pc:list-mobiles refused: AUTH_TOKEN_INVALID`.
// Since 0.3.58 there is no `pc:list-mobiles` line at all.
//
// The fix keeps WP-5's win (the commands stay off the main thread) and tells the
// runtime the truth about what they do: [`run_blocking`] wraps each body in
// `tokio::task::block_in_place`, which hands the task's worker over to blocking
// work and moves the rest of the runtime's queue to a sibling worker. A nested
// `Runtime::block_on` is legal inside that region — probe B in the P0 findings
// measured it, and `nested_block_on_survives_the_helper` below re-measures it on
// every `cargo test`.
//
// 🔴 WHY THE FALLBACK IS A PLAIN CALL, TWICE OVER — this is not a shrug.
//   * NO RUNTIME AT ALL (`try_current()` is `Err`). This is case D of the
//     findings: the socket pump thread, the ack callbacks `rust_socketio` invokes
//     on its own thread, `cargo test`. Blocking a thread nobody is scheduling on
//     is exactly what those threads are for, and it is what the whole crate did
//     before 0.3.58 — measured OK. There is nothing to announce.
//   * A CURRENT-THREAD RUNTIME. `block_in_place` is only implemented for the
//     multi-thread scheduler; calling it under a current-thread runtime panics
//     with "can call blocking only when running on the multi-threaded runtime".
//     Tauri's `async_runtime` is multi-thread today, so this arm should not be
//     reachable from a command — but the helper must not be the thing that turns
//     a runtime-flavour change into a second process-level fault, so it degrades
//     to the pre-0.3.58 behaviour (block the caller) rather than panicking. That
//     is a real degradation, not a fix: on a current-thread runtime this would
//     stall the whole scheduler for the duration.
//
// WHY THE COMMAND BODY AND NOT `emit_with_ack`. Wrapping the six emit sites in
// `outbound.rs` would silence today's panic and nothing more. The blocking window
// is not the emit; it is the emit PLUS `rx.recv_timeout(timeout + 500ms)` — five
// and a half seconds of a worker thread per device-page verb, twice over in
// `list_paired_mobiles` (it asks both channels) — plus the up-to-1.5 s
// `PASTE_HOLD` in `timeline_reinject*` and the multi-minute download in
// `update_download`, none of which pass through any emit. The command body is the
// one place that knows it is running on a runtime thread and knows how long it
// intends to stay there.
//
// THE RULE, so it stays greppable: EVERY `#[tauri::command(async)]` body runs
// inside `run_blocking`. `every_async_command_body_is_wrapped` below reads the
// crate's own sources and fails when a new one arrives without it.

/// Run a synchronous, potentially long blocking body from a context that may be a
/// tokio runtime worker.
///
/// See the module header for the measurement this exists for. Returns whatever
/// `f` returns; adds no timeout, no thread, and no error path of its own.
pub fn run_blocking<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        // The only flavour on which `block_in_place` is implemented.
        Ok(handle)
            if matches!(
                handle.runtime_flavor(),
                tokio::runtime::RuntimeFlavor::MultiThread
            ) =>
        {
            tokio::task::block_in_place(f)
        }
        // No runtime (pump thread, socket.io callback thread, tests) or a
        // current-thread runtime: block the caller, as this crate did until
        // 0.3.58.
        _ => f(),
    }
}

#[cfg(test)]
mod tests {
    use super::run_blocking;

    /// The exact shape that broke the device page: a nested
    /// `Runtime::block_on` (what `rust_engineio`'s websocket transport does on
    /// every `emit_with_ack`) reached from a task spawned on a multi-thread
    /// runtime (what `#[tauri::command(async)]` does to every one of the twelve
    /// verbs WP-5 converted).
    #[test]
    fn nested_block_on_survives_the_helper() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            // Two workers, because `block_in_place` needs somewhere to move the
            // rest of the queue to; one worker still works but tests less.
            .worker_threads(2)
            .build()
            .expect("build multi-thread runtime");
        let out: i32 = rt.block_on(async {
            tokio::spawn(async {
                run_blocking(|| {
                    tokio::runtime::Runtime::new()
                        .expect("inner runtime")
                        .block_on(async { 42 })
                })
            })
            .await
            .expect("the task must not die")
        });
        assert_eq!(out, 42);
    }

    /// 🔴 REVERSE CONTROL — the same closure WITHOUT the helper, which is
    /// 0.3.58 verbatim. It is kept because it is deterministic (the panic is
    /// unconditional inside `Runtime::block_on`'s blocking-region check, not a
    /// race), and because without it the test above passes just as happily on a
    /// `run_blocking` that has been reduced to `f()`.
    ///
    /// SEEN RED once, 2026-09-03, dev-pc-a, before the fix existed —
    /// verbatim from that run, the same sentence as the sixteen lines in
    /// `window-forensics.log`:
    ///
    /// ```text
    /// thread 'tokio-rt-worker' (61536) panicked at
    ///   ...tokio-1.53.1 multi_thread scheduler, mod.rs line 91:
    /// Cannot start a runtime from within a runtime. This happens because a
    /// function (like `block_on`) attempted to block the current thread while
    /// the thread is being used to drive asynchronous tasks.
    /// ```
    ///
    /// Note the thread name: `tokio-rt-worker`, the same one the sixteen
    /// production panics carry. This test reproduces the production thread, not
    /// merely the production sentence.
    ///
    /// The spawned task's panic reaches us as a `JoinError`, so the test asserts
    /// on that rather than using `#[should_panic]` (the panic happens on a
    /// worker thread, not this one — `should_panic` would never see it). The
    /// panic message IS printed to stderr during `cargo test`; that noise is the
    /// control working.
    #[test]
    fn without_the_helper_the_same_task_dies() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .build()
            .expect("build multi-thread runtime");
        let joined = rt.block_on(async {
            tokio::spawn(async {
                // No `run_blocking` — this is the pre-fix call.
                tokio::runtime::Runtime::new()
                    .expect("inner runtime")
                    .block_on(async { 42 })
            })
            .await
        });
        let err = joined.expect_err(
            "a nested block_on on a runtime worker must die — if this ever \
             succeeds, the panic that emptied the paired-phone table is gone for \
             some other reason and the fix above needs re-justifying",
        );
        assert!(err.is_panic(), "expected a panic, got {err:?}");
    }

    /// The rule from the module header, enforced against the crate's own sources
    /// rather than against anyone's memory: a `#[tauri::command(async)]` whose
    /// body never reaches `run_blocking` is 0.3.58's defect arriving again.
    ///
    /// ⚠️ WHAT THIS DOES NOT PROVE. It is a text scan, so it proves the call is
    /// WRITTEN in that span, not that it wraps the blocking part. It reads the
    /// tree at `CARGO_MANIFEST_DIR`, so it sees files added later — the reason it
    /// walks the directory instead of listing the eight files that exist today.
    #[test]
    fn every_async_command_body_is_wrapped() {
        const MARK: &str = "#[tauri::command(async)]";
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut checked = 0usize;
        let mut offenders: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let src = match std::fs::read_to_string(&path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                // Attribute LINES only: `portable/dialog.rs` names the attribute
                // inside a comment, and a scan that counted that would be a
                // measuring instrument answering a different question.
                let mut offset = 0usize;
                for line in src.lines() {
                    let start = offset;
                    offset += line.len() + 1;
                    if line.trim() != MARK {
                        continue;
                    }
                    checked += 1;
                    let rest = &src[start + line.len()..];
                    // The body ends at the next command attribute, whatever its
                    // flavour; that boundary is what keeps one wrapped command
                    // from vouching for its unwrapped neighbour.
                    let span = match rest.find("\n#[tauri::command") {
                        Some(i) => &rest[..i],
                        None => rest,
                    };
                    if !span.contains("run_blocking") {
                        let name = span
                            .lines()
                            .find(|l| l.contains("fn "))
                            .unwrap_or("<unknown fn>")
                            .trim();
                        offenders.push(format!("{}: {name}", path.display()));
                    }
                }
            }
        }
        assert!(
            checked >= 12,
            "expected at least the 12 commands WP-5 converted, found {checked} — \
             the scan is broken, not the tree",
        );
        assert!(
            offenders.is_empty(),
            "these `#[tauri::command(async)]` bodies never reach run_blocking, so a blocking \
             call inside them can panic a tokio worker exactly as 0.3.58 did:\n{}",
            offenders.join("\n"),
        );
    }
}
