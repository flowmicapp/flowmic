// Test-only OS boundary for full wire-handler -> pipeline composition tests.
// All policy gates run; only foreground/probe facts and physical output are fake.
use std::cell::RefCell;

thread_local! {
    static PAYLOADS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
    static PREFLIGHT_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(crate) fn record_preflight() {
    PREFLIGHT_CALLS.with(|calls| calls.set(calls.get() + 1));
}

pub(crate) fn preflight_calls() -> usize {
    PREFLIGHT_CALLS.with(|calls| calls.get())
}

pub(crate) fn active() -> bool {
    PAYLOADS.with(|slot| slot.borrow().is_some())
}

pub(crate) fn capture(text: &str) -> Option<super::InjectOutcome> {
    PAYLOADS.with(|slot| {
        slot.borrow_mut().as_mut().map(|payloads| {
            payloads.push(text.to_owned());
            super::InjectOutcome {
                ok: true,
                mode: super::InjectMode::Clipboard,
                error_code: None,
                error_message: None,
                focus_evidence: None,
            }
        })
    })
}

pub(crate) fn recording(run: impl FnOnce()) -> Vec<String> {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            PAYLOADS.with(|slot| *slot.borrow_mut() = None);
        }
    }
    assert!(!active(), "nested delivery recording");
    PREFLIGHT_CALLS.with(|calls| calls.set(0));
    PAYLOADS.with(|slot| *slot.borrow_mut() = Some(Vec::new()));
    let _reset = Reset;
    run();
    PAYLOADS.with(|slot| slot.borrow_mut().take().unwrap())
}
