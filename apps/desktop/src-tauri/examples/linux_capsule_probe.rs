// Real Tauri capsule from the product's WindowConfig and production shell methods.
// This proves the native capsule behavior, not sidecar/pairing/end-to-end delivery.
#[cfg(all(target_os = "linux", feature = "app"))]
fn main() {
    use flowmic_desktop_lib::{focus, shell};
    use gtk::prelude::*;
    use std::time::Duration;
    use tauri::Manager;
    focus::linux_x11::initialize_threads().expect("Xlib threads");
    tauri::Builder::default()
        .setup(|app| {
            flowmic_desktop_lib::forensic::init_default();
            focus::linux_session::capture_gtk_backend();
            if focus::linux_session::current_backend() == focus::linux_session::DisplayBackend::Wayland {
                use flowmic_desktop_lib::{error_codes, inject};
                let outcome = inject::inject_text("must-not-send", Some(1), None, |_| panic!("preflight did not refuse"));
                assert!(!outcome.ok);
                assert_eq!(outcome.mode, inject::InjectMode::Cached);
                assert_eq!(outcome.error_code, Some(error_codes::INJECT_WAYLAND_UNSUPPORTED));
                assert_eq!(outcome.focus_evidence, None);
                println!("{}", serde_json::json!({"wayland_preflight": "refused", "mode": "Cached",
                    "error_code": outcome.error_code, "focus_evidence": null}));
            }
            shell::configure_capsule_window(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for phase in ["before", "first-show", "hide", "second-show", "click-through", "tray-show", "after"] {
                    std::thread::sleep(Duration::from_millis(750));
                    let app = handle.clone();
                    handle.run_on_main_thread(move || {
                        match phase {
                            "first-show" | "second-show" => shell::capsule_surface(app.clone()),
                            "hide" => shell::capsule_hide(app.clone()),
                            "tray-show" => shell::surface_capsule(&app, true),
                            "click-through" => {
                                shell::capsule_click_through(app.clone(), true);
                                shell::capsule_click_through(app.clone(), false);
                            }
                            _ => {}
                        }
                    }).expect("GTK mutation dispatch");
                    std::thread::sleep(Duration::from_millis(200));
                    let app = handle.clone();
                    handle.run_on_main_thread(move || {
                        let capsule = app.get_webview_window("capsule").expect("real capsule");
                        let native = capsule.gtk_window().expect("GTK capsule");
                        if phase == "tray-show" && focus::linux_session::current_backend() == focus::linux_session::DisplayBackend::Wayland {
                            assert!(app.get_webview_window("main").expect("main window").is_visible().unwrap());
                            let explained = gtk::Window::list_toplevels().iter().any(|window|
                                window.is_visible() && window.is::<gtk::MessageDialog>());
                            assert!(explained, "explicit tray summon must show its refusal to the user");
                            println!("WAYLAND_TRAY_FALLBACK: visible main window and native explanation dialog");
                        }
                        println!("{}", serde_json::json!({
                            "phase": phase, "backend": format!("{:?}", focus::linux_session::current_backend()),
                            "accept_focus": native.accepts_focus(), "focus_on_map": native.gets_focus_on_map(),
                            "capsule_active": native.is_active(), "visible": native.is_visible(),
                            "type_hint": format!("{:?}", native.type_hint()),
                            "foreground": focus::current_foreground_target(),
                        }));
                        if phase == "after" {
                            if let Some(path) = std::env::var("FLOWMIC_CAPSULE_SCREENSHOT").ok().filter(|_| native.is_visible()) {
                                let surface = native.window().expect("mapped native capsule");
                                let pixels = surface.pixbuf(0, 0, surface.width(), surface.height()).expect("native capsule pixels");
                                pixels.savev(path, "png", &[]).expect("save native capsule screenshot");
                            }
                            app.exit(0);
                        }
                    }).expect("GTK main dispatch");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri capsule probe");
}

#[cfg(not(all(target_os = "linux", feature = "app")))]
fn main() {
    eprintln!("linux_capsule_probe requires Linux and --features app");
    std::process::exit(2);
}
