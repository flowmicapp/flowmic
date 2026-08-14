// WP-R2-4 sidecar io tests — split from io.rs (file-size cap, client_tests.rs precedent).
// Included via `#[cfg(test)] #[path = "io_tests.rs"] mod io_tests;` inside io.rs,
// so `super::*` here IS the io module (private items reachable).

    use super::*;

    #[test]
    fn parse_listening_extracts_the_port() {
        assert_eq!(
            parse_listening("FLOWMIC_LISTENING port=41879 mode=standalone version=0.1.0"),
            Some(41879)
        );
        assert_eq!(parse_listening("41879"), None);
        assert_eq!(parse_listening("random log line"), None);
        assert_eq!(parse_listening("  FLOWMIC_LISTENING port=41879 "), Some(41879));
    }

    #[test]
    fn normalize_path_strips_verbatim_prefix() {
        let p = PathBuf::from(r"\\?\C:\Program Files\FlowMic\resources\server.js");
        assert_eq!(normalize_path(&p), PathBuf::from(r"C:\Program Files\FlowMic\resources\server.js"));
        // A plain path is unchanged.
        let q = PathBuf::from(r"C:\dev\server.js");
        assert_eq!(normalize_path(&q), q);
    }

    #[test]
    fn resolve_prefers_the_first_existing_candidate() {
        let tmp = std::env::temp_dir().join(format!("flowmic-sidecar-resolve-{}", std::process::id()));
        let a = tmp.join("a");
        let b = tmp.join("b");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("server.js"), "// stub").unwrap();
        // a has no server.js, b does → resolves to b.
        let got = resolve_server_js(&[a.clone(), b.clone()]);
        assert_eq!(got, Some(normalize_path(&b.join("server.js"))));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_returns_none_when_no_candidate_has_server_js() {
        let tmp = std::env::temp_dir().join(format!("flowmic-sidecar-noresolve-{}", std::process::id()));
        assert_eq!(resolve_server_js(&[tmp]), None);
    }

    #[test]
    fn http_get_against_a_dead_port_errors_not_panics() {
        // Nothing listens on this high port → connect error, no panic.
        let r = http_get("127.0.0.1", 1, "/api/health", Duration::from_millis(200));
        assert!(r.is_err());
    }

    #[test]
    fn db_and_secret_home_share_one_dir_and_lifecycle() {
        // The escape-defect fix: the DB nests INSIDE the FLOWMIC_HOME so it pairs
        // with `<home>/standalone.secret` — mismatched secret ⇒ enc:v1: decrypt
        // fail-loud. Default db_path.parent() MUST equal home, and home ends FlowMic.
        let opts = BringUpOptions::default();
        assert_eq!(opts.db_path.parent(), Some(opts.home.as_path()));
        assert!(opts.home.ends_with("FlowMic"), "home must be the FlowMic subdir, got {}", opts.home.display());
        assert_eq!(opts.db_path.file_name().and_then(|s| s.to_str()), Some("flowmic.sqlite"));
    }

    #[test]
    fn stderr_tail_keeps_only_the_last_lines() {
        let buf = Arc::new(Mutex::new((0..30).map(|i| format!("line{i}")).collect::<Vec<_>>()));
        let tail = stderr_tail(&buf, 5);
        assert!(tail.contains("line29"), "keeps the newest");
        assert!(tail.contains("line25"), "keeps the 5th-from-last");
        assert!(!tail.contains("line24"), "drops older than the last 5");
    }

    #[test]
    fn stderr_tail_is_none_when_empty_and_truncates_long_lines() {
        let empty: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        assert_eq!(stderr_tail(&empty, 5), "<none>");
        // A 500-char line is truncated to 200 chars + ellipsis (overflow guard).
        let long = Arc::new(Mutex::new(vec!["x".repeat(500)]));
        let tail = stderr_tail(&long, 5);
        assert!(tail.chars().count() <= 201, "truncated to ≤200 chars + ellipsis, got {}", tail.chars().count());
        assert!(tail.ends_with('…'));
    }

// ── owner 2026-07-27: adopt only OUR server.js ───────────────────────────────
//
// A stale orphan sidecar from another build answers `/api/health` with ok:true
// just as convincingly as ours does, so the old probe adopted it and the app
// silently ran against a server it did not ship. `script` is the discriminator.
mod adopt_identity {
    use crate::sidecar::adopt::{is_same_script, parse_health_script};
    use std::path::PathBuf;

    #[test]
    fn parses_a_windows_path_out_of_the_health_body() {
        // A real health body: JSON doubles every backslash in a Windows path.
        let body = r#"{"ok":true,"mode":"standalone","port":41879,"version":"0.1.0","script":"C:\\Program Files\\FlowMic\\resources\\server.js"}"#;
        assert_eq!(
            parse_health_script(body).as_deref(),
            Some(r"C:\Program Files\FlowMic\resources\server.js")
        );
    }

    #[test]
    fn a_body_without_the_field_yields_none() {
        // A pre-2026-07-27 server — i.e. exactly the legacy build we must not adopt.
        let body = r#"{"ok":true,"mode":"standalone","port":41879,"version":"0.1.0"}"#;
        assert_eq!(parse_health_script(body), None);
    }

    #[test]
    fn same_file_matches_across_case_and_separator_differences() {
        // Tauri's resolver and Node's process.argv[1] disagree on both for one file.
        let expected = PathBuf::from(r"F:\app\publish\FlowMic-portable\resources\server.js");
        assert!(is_same_script(r"f:/app/publish/flowmic-portable/resources/server.js", &expected));
        assert!(is_same_script(r"F:\app\publish\FlowMic-portable\resources\server.js", &expected));
    }

    #[test]
    fn a_different_install_does_not_match() {
        // The exact real-device case: the portable bundle meets the MSI's orphan.
        let expected = PathBuf::from(r"F:\app\publish\FlowMic-portable\resources\server.js");
        assert!(!is_same_script(r"C:\Program Files\FlowMic\resources\server.js", &expected));
    }

    #[test]
    fn an_empty_or_absent_script_never_matches() {
        let expected = PathBuf::from(r"C:\FlowMic\resources\server.js");
        assert!(!is_same_script("", &expected));
    }

    #[test]
    fn a_verbatim_prefixed_expected_path_still_matches() {
        // resolve_server_js already strips the verbatim prefix, but the comparison
        // guards it too — a path that reaches here unnormalized must still match.
        let expected = PathBuf::from(r"\\?\C:\FlowMic\resources\server.js");
        assert!(is_same_script(r"C:\FlowMic\resources\server.js", &expected));
    }
}

// ── D2LAN-B2b: the LAN TLS fingerprint's first hop into this process ─────────
//
// 🔴 WHAT THESE DEFEND. The fingerprint is minted in server-core and pinned by a
// phone; this process only CARRIES it. So the failure this file has to catch is
// not「算错了」("computed wrong") but「原样送到没有」("whether it arrived unchanged
// or not") — and the nastier direction, a value that arrives
// mangled and gets printed into a QR anyway, where it becomes a pin nothing can
// ever match and a phone that correctly refuses a server that is in fact correct.
//
// The bodies below are the literal shape `apps/server-core/src/http/router.ts`
// (symbol `publishableLanTlsFingerprint`) serializes. That server-side shape is
// pinned as TEXT by `apps/server-core/test/lan-tls-network-route.test.ts`
// (「serializes in the LITERAL shape the Rust reader looks for」), so these
// fixtures cannot quietly drift away from the producer.
mod lan_tls_fingerprint {
    use crate::sidecar::io::{is_carryable_fingerprint, parse_lan_tls_fingerprint};

    /// A real 24-char base64url fingerprint (18 bytes of digest, §3-3).
    const FP: &str = "oTA0pWG9421vmsxFi1ZoR4gs";

    fn body_with(fp_json: &str) -> String {
        format!(
            "{{\"lan_ipv4\":[\"10.0.0.78\"],\"primary\":\"10.0.0.78\",\
             \"candidates\":[{{\"address\":\"10.0.0.78\",\"kind\":\"rfc1918\",\
             \"nonStandardPrivate\":false}}],\"port\":41879,\"lan_tls_fp\":{fp_json}}}"
        )
    }

    #[test]
    fn reads_the_fingerprint_out_of_a_real_network_body() {
        assert_eq!(parse_lan_tls_fingerprint(&body_with(&format!("\"{FP}\""))), Some(FP.to_string()));
    }

    #[test]
    fn reads_a_body_captured_verbatim_from_a_real_running_sidecar() {
        // 🔴 NOT a hand-written fixture. This is the literal response body of a real
        // `node dist/index.js --mode standalone` on dev-pc-a (2026-08-08),
        // fetched over plain loopback exactly as `fetch_lan_tls_fingerprint` does.
        // The fingerprint in it was independently confirmed against the certificate
        // that server actually presented, using openssl rather than any of our own
        // code:
        //   openssl s_client -connect 127.0.0.1:PORT | openssl x509 -pubkey -noout
        //     | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary
        //     | head -c 18 | base64 | tr '+/' '-_' | tr -d '='
        //   => 5A7MixUQT7GpuQSblhHLag7u
        // A synthetic fixture can only prove this parser agrees with whoever wrote
        // the fixture; this one proves it agrees with the server.
        let body = "{\"lan_ipv4\":[\"10.0.0.78\",\"10.8.66.78\",\"192.168.80.1\",\"198.18.0.1\",\"100.64.7.78\"],\
            \"primary\":\"10.0.0.78\",\"candidates\":[{\"address\":\"10.0.0.78\",\"kind\":\"rfc1918\",\
            \"nonStandardPrivate\":false},{\"address\":\"10.8.66.78\",\"kind\":\"rfc1918\",\"nonStandardPrivate\":false},\
            {\"address\":\"192.168.80.1\",\"kind\":\"rfc1918\",\"nonStandardPrivate\":false},{\"address\":\"198.18.0.1\",\
            \"kind\":\"non-standard-private\",\"nonStandardPrivate\":true},{\"address\":\"100.64.7.78\",\
            \"kind\":\"non-standard-private\",\"nonStandardPrivate\":true}],\"port\":41999,\
            \"lan_tls_fp\":\"5A7MixUQT7GpuQSblhHLag7u\"}";
        let fp = parse_lan_tls_fingerprint(body).expect("the real body carries a fingerprint");
        assert_eq!(fp, "5A7MixUQT7GpuQSblhHLag7u");
        assert!(is_carryable_fingerprint(&fp));
        // The key sits LAST in the real body, after five addresses and a nested
        // array — the arrangement a naive reader is most likely to trip over.
        assert!(!fp.contains('.'), "an address must never come back as a fingerprint");
    }

    #[test]
    fn a_null_is_no_fingerprint_and_never_the_string_null() {
        // The no-TLS path, which is every saas deployment and any standalone run
        // with no durable home. `Some("null")` here would put the four letters
        // `null` on the pairing QR as a pin.
        assert_eq!(parse_lan_tls_fingerprint(&body_with("null")), None);
    }

    #[test]
    fn an_older_sidecar_that_never_heard_of_the_key_yields_none() {
        let body = "{\"lan_ipv4\":[\"10.0.0.78\"],\"primary\":\"10.0.0.78\",\"port\":41879}";
        assert_eq!(parse_lan_tls_fingerprint(body), None);
    }

    #[test]
    fn an_empty_string_is_no_fingerprint() {
        assert_eq!(parse_lan_tls_fingerprint(&body_with("\"\"")), None);
    }

    #[test]
    fn a_truncated_body_does_not_invent_a_value() {
        // The read is over a hand-rolled HTTP client with a byte cap, so a cut-off
        // body is a real input, not a hypothetical one.
        assert_eq!(parse_lan_tls_fingerprint("{\"port\":41879,\"lan_tls_fp\":\"oTA0pWG"), None);
        assert_eq!(parse_lan_tls_fingerprint("{\"port\":41879,\"lan_tls_fp\":"), None);
    }

    #[test]
    fn the_key_is_not_confused_with_a_neighbour() {
        // Reading `"primary"` when asked for the fingerprint would be the worst
        // outcome of all: a plausible-looking value that is not a fingerprint.
        let body = body_with(&format!("\"{FP}\""));
        let got = parse_lan_tls_fingerprint(&body).expect("a fingerprint");
        assert_eq!(got, FP);
        assert!(!got.contains('.'), "an IP address must never come back as a fingerprint");
    }

    #[test]
    fn carryable_accepts_the_real_shape() {
        assert!(is_carryable_fingerprint(FP));
    }

    #[test]
    fn carryable_refuses_anything_that_would_split_or_extend_the_qr() {
        // ',' splits an `alt=` list and '&' starts a new key — either one silently
        // turns ONE value into TWO. Whitespace cannot survive the round trip, and a
        // fingerprint that compares unequal only because of a trailing space is the
        // worst kind of pinning failure: the phone is right and nobody can see why.
        assert!(!is_carryable_fingerprint("oTA0pWG9421vmsx,i1ZoR4gs"));
        assert!(!is_carryable_fingerprint("oTA0pWG9421vmsx&i1ZoR4gs"));
        assert!(!is_carryable_fingerprint("oTA0pWG9421vmsx i1ZoR4gs"));
        assert!(!is_carryable_fingerprint("oTA0pWG9421vmsx\ni1ZoR4gs"));
        assert!(!is_carryable_fingerprint("oTA0pWG9421vmsxFi1ZoR4g="));
        assert!(!is_carryable_fingerprint(""));
        assert!(!is_carryable_fingerprint(&"x".repeat(129)));
    }

    #[test]
    fn carryable_does_not_second_guess_the_producers_length() {
        // ⚠️ Deliberate: a 24-char constant here would be a SECOND copy of
        // `FP_CHARS` (server-core lan-tls/fingerprint.ts), and the day FP_BYTES
        // moves the two would disagree with no way to tell which is right. The
        // exact length is judged once, at the producer. This layer only asks
        // 「能不能原样穿过二维码」("can it pass through the QR code unchanged").
        assert!(is_carryable_fingerprint("shorter"));
        assert!(is_carryable_fingerprint(&"a".repeat(43)));
    }
}
