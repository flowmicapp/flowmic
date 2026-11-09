// D-MKT-21 — a closed cloud session stops dialing, against the real library.
//
// An INTEGRATION test on purpose, for two reasons. The defect lives in what the real
// `rust_socketio` polling thread does after `disconnect`, so a fake client would
// replace the layer that is wrong (CLAUDE.md D-23). And the session generations, the
// lingering list, the forensic sink and the focus hook are all process-wide, so this
// must own its process (same reason as tests/panic_forensics.rs).
//
// The stub speaks just enough Engine.IO v4 / Socket.IO v5 over a real websocket: the
// open packet, the CONNECT answer, and it closes when the client says it is leaving.
// It records every connection and every CONNECT packet. It does not answer
// `pc:register`, so these sessions stay connected and unregistered, the same state
// the relay holds a closed session in.
//
// Why 3 s of silence is enough: the library's first reconnect rung is
// `reconnect_delay(1_000, …)` with its default ±50 % jitter, so at most 1.5 s.

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flowmic_desktop_lib::socket::session_stop::withdraw_cloud_sessions;
use flowmic_desktop_lib::socket::{self, Channel, DesktopSocket, InjectDeduper, SocketConfig};
use tungstenite::Message;

const KEY: &str = "header.payload-under-test.signature";
const SILENCE: Duration = Duration::from_secs(3);
const DIAL_DEADLINE: Duration = Duration::from_secs(10);

/// The session generations are process-wide, so a test that needs "no successor" must
/// not run beside one that builds a session.
fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn scratch_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("flowmic-session-stop-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        // BEFORE the first connect: it initialises the forensic sink, which would
        // otherwise be this machine's real log.
        std::env::set_var("FLOWMIC_FORENSIC_PATH", dir.join("forensics.log"));
        dir
    })
}

#[derive(Default)]
struct Seen {
    connections: AtomicUsize,
    open_now: AtomicUsize,
    connect_packets: Mutex<Vec<String>>,
    /// Connections that sent `pc:register`: the `open` handler ran, so the session is
    /// fully up. Per connection, because the pump's RV-26 watchdog re-emits the frame.
    registers: AtomicUsize,
    streams: Mutex<Vec<TcpStream>>,
}

struct StubRelay {
    url: String,
    seen: Arc<Seen>,
}

impl StubRelay {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Seen::default());
        let accepting = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let seen = accepting.clone();
                std::thread::spawn(move || serve(stream, seen));
            }
        });
        Self { url, seen }
    }

    fn connections(&self) -> usize {
        self.seen.connections.load(Ordering::SeqCst)
    }

    fn open_now(&self) -> usize {
        self.seen.open_now.load(Ordering::SeqCst)
    }

    fn connect_packets(&self) -> Vec<String> {
        self.seen.connect_packets.lock().unwrap().clone()
    }

    /// The transport breaks under a session, with no goodbye from either side.
    fn break_every_transport(&self) {
        for stream in self.seen.streams.lock().unwrap().drain(..) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    /// A session is closed from this state in the product: `open` has run and the
    /// handshake went out. Closing one earlier tests a race, not the ladder.
    fn wait_until_fully_up(&self, registers: usize) {
        let deadline = Instant::now() + DIAL_DEADLINE;
        while self.seen.registers.load(Ordering::SeqCst) < registers {
            assert!(Instant::now() < deadline, "the session never sent pc:register");
            std::thread::sleep(Duration::from_millis(20));
        }
        settle();
    }

    fn wait_for_open_now(&self, want: usize) {
        let deadline = Instant::now() + DIAL_DEADLINE;
        while self.open_now() != want {
            assert!(
                Instant::now() < deadline,
                "the stub holds {} open connection(s), wanted {want}",
                self.open_now()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for_connect_packets(&self, want: usize) {
        let deadline = Instant::now() + DIAL_DEADLINE;
        while self.connect_packets().len() < want {
            assert!(
                Instant::now() < deadline,
                "the stub saw {} CONNECT packet(s), wanted {want}",
                self.connect_packets().len()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Let the polling thread get back into its blocking read. Without this, 1 of 32 runs
/// under load left the withdrawn session's connection open past the 10 s deadline, with
/// no further dial. The likely reason, from reading `rust_socketio` 0.6 `Iter::next` and
/// not reproduced on purpose: `disconnect` landing between two reads makes the next poll
/// answer `Ok(None)`, which reaches no callback and starts no reconnect.
fn settle() {
    std::thread::sleep(Duration::from_millis(300));
}

fn serve(stream: TcpStream, seen: Arc<Seen>) {
    let mine = stream.try_clone().unwrap();
    seen.streams.lock().unwrap().push(stream.try_clone().unwrap());
    let Ok(mut ws) = tungstenite::accept(stream) else { return };
    seen.connections.fetch_add(1, Ordering::SeqCst);
    seen.open_now.fetch_add(1, Ordering::SeqCst);
    let open = r#"0{"sid":"stub","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#;
    let _ = ws.send(Message::text(open));
    let mut registered = false;
    while let Ok(msg) = ws.read() {
        let Message::Text(text) = msg else { continue };
        if text.starts_with("40") {
            seen.connect_packets.lock().unwrap().push(text.to_string());
            let _ = ws.send(Message::text(r#"40{"sid":"stub-ns"}"#));
        } else if text.contains("pc:register") {
            if !registered {
                registered = true;
                seen.registers.fetch_add(1, Ordering::SeqCst);
            }
        } else if text == "1" {
            // Engine.IO close: the client is leaving. A real relay closes here too.
            let _ = ws.close(None);
        }
    }
    // The clones above keep the socket open past `ws`, and a client read then waits
    // for its ping timeout. A real relay's close is a real FIN.
    let _ = mine.shutdown(std::net::Shutdown::Both);
    seen.open_now.fetch_sub(1, Ordering::SeqCst);
}

fn open_session(relay: &StubRelay, label: &str) -> DesktopSocket {
    let dir = scratch_dir();
    let session = socket::connect(SocketConfig {
        url: relay.url.clone(),
        device_name: "FlowMic session-stop test".to_string(),
        credentials_path: dir.join(format!("creds-{label}.bin")),
        deduper: Some(Arc::new(Mutex::new(InjectDeduper::load_spec_default(
            dir.join(format!("ledger-{label}.bin")),
        )))),
        jwt: Some(KEY.to_string()),
        auth_failure: None,
        inject_foreground_allowlist: Some(Vec::new()),
        bridge: None,
        channel: Channel::Cloud,
        admission: None,
        on_dead_transport: None,
    });
    session.unwrap_or_else(|e| panic!("connect to the stub failed: {e}"))
}

#[test]
fn a_session_closed_for_good_never_presents_the_key_again() {
    let _guard = one_at_a_time();
    let relay = StubRelay::start();
    let session = open_session(&relay, "final");
    relay.wait_until_fully_up(1);
    // The probe is not blind: this is where the key would show up on a later dial.
    assert!(relay.connect_packets()[0].contains(KEY), "{:?}", relay.connect_packets());

    drop(session);
    std::thread::sleep(SILENCE);

    assert_eq!(
        relay.connect_packets().len(),
        1,
        "a closed session dialed again and presented the key: {:?}",
        relay.connect_packets()
    );
    assert_eq!(relay.connections(), 1, "a closed session opened another connection");
}

/// The positive control for the test above: the stop must not reach a session that is
/// still in use. Without this, removing the reconnect ladder would pass.
#[test]
fn a_session_still_in_use_keeps_its_reconnect_ladder() {
    let _guard = one_at_a_time();
    let relay = StubRelay::start();
    let session = open_session(&relay, "live");
    relay.wait_until_fully_up(1);

    relay.break_every_transport();
    relay.wait_until_fully_up(2);
    assert!(relay.connect_packets()[1].contains(KEY));

    // And the ladder ends when this session closes for good.
    drop(session);
    std::thread::sleep(SILENCE);
    assert_eq!(relay.connect_packets().len(), 2);
}

/// The W8-2 path: a heartbeat-death rebuild whose redial failed. This closed session
/// must keep trying (it is what brings the PC back after an outage), and it sits in no
/// slot, so emptying the slot at sign-out does not reach it.
#[test]
fn a_sign_out_reaches_a_session_that_was_left_to_come_back_on_its_own() {
    let _guard = one_at_a_time();
    let relay = StubRelay::start();
    let session = open_session(&relay, "transient");
    relay.wait_until_fully_up(1);

    session.mark_transient_close();
    drop(session);
    relay.wait_for_connect_packets(2); // still coming back: W8-2 is intact
    // The old connection's socket closes around the same moment, so wait for it.
    relay.wait_for_open_now(1);
    settle();

    withdraw_cloud_sessions();
    relay.wait_for_open_now(0);
    std::thread::sleep(SILENCE);
    assert_eq!(
        relay.connect_packets().len(),
        2,
        "the session dialed again after the sign-out: {:?}",
        relay.connect_packets()
    );
}

/// A sign-in after the sign-out is an ordinary new session: the withdrawal does not
/// reach forward.
#[test]
fn a_session_built_after_a_sign_out_is_a_normal_session() {
    let _guard = one_at_a_time();
    let relay = StubRelay::start();
    withdraw_cloud_sessions();

    let session = open_session(&relay, "after");
    relay.wait_until_fully_up(1);
    relay.break_every_transport();
    relay.wait_until_fully_up(2);
    drop(session);
}

/// One closed session must not stay reachable by another one being built: a successor
/// makes the close final at once.
#[test]
fn a_replaced_session_stops_once_its_successor_exists() {
    let _guard = one_at_a_time();
    let relay = StubRelay::start();
    let first = open_session(&relay, "replaced");
    relay.wait_until_fully_up(1);
    let second = open_session(&relay, "successor");
    relay.wait_until_fully_up(2);

    // The rebuild funnel marks the old one transient; the successor wins anyway.
    first.mark_transient_close();
    drop(first);
    std::thread::sleep(SILENCE);
    assert_eq!(relay.connect_packets().len(), 2, "{:?}", relay.connect_packets());
    drop(second);
}
