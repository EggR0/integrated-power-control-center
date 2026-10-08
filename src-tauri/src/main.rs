#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct BrokerProcess(Mutex<Option<Child>>);
struct PositionFile(PathBuf);

fn main() {
    tauri::Builder::default()
        .manage(BrokerProcess(Mutex::new(None)))
        .setup(|app| {
            let launcher = broker_launcher(&app.handle());
            if let Some(launcher) = launcher {
                let node = std::env::var("INTEGRATED_POWER_NODE")
                    .ok()
                    .or_else(|| bundled_node(app))
                    .unwrap_or_else(|| "node".to_string());
                let mut command = Command::new(node);
                command.arg(&launcher);
                if let Some(module) = launcher
                    .parent()
                    .map(|parent| parent.join("broker-out").join("broker"))
                {
                    if module.exists() {
                        command.env("INTEGRATED_POWER_BROKER_MODULE", module);
                    }
                }

                let log_dir = state_root(&app.handle());
                let _ = fs::create_dir_all(&log_dir);
                command.env("INTEGRATED_POWER_STATE_ROOT", &log_dir);
                let log_path = log_dir.join("broker.log");
                if let Ok(out_file) = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                {
                    if let Ok(err_file) = out_file.try_clone() {
                        command.stdout(std::process::Stdio::from(out_file));
                        command.stderr(std::process::Stdio::from(err_file));
                    } else {
                        command.stdout(std::process::Stdio::from(out_file));
                    }
                }

                #[cfg(windows)]
                command.creation_flags(CREATE_NO_WINDOW);

                if let Ok(child) = command.spawn() {
                    if let Ok(mut process) = app.state::<BrokerProcess>().0.lock() {
                        *process = Some(child);
                    }
                }
            }

            let position_file = position_file(&app.handle());
            let _ = fs::create_dir_all(position_file.parent().unwrap_or_else(|| Path::new(".")));
            app.manage(PositionFile(position_file.clone()));
            if let Some(window) = app.get_webview_window("main") {
                show_and_restore_window(app.handle(), &window);
            }

            let show = MenuItem::with_id(app, "show", "Show Integrated Power", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &exit])?;
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Integrated Power")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("window icon is required"),
                )
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_and_restore_window(app, &window);
                        }
                    }
                    "exit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(&tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(position) => {
                if let Some(file) = window.app_handle().try_state::<PositionFile>() {
                    let _ = fs::write(
                        &file.0,
                        format!("{{\"x\":{},\"y\":{}}}", position.x, position.y),
                    );
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Integrated Power control center");
}

fn show_and_restore_window<R: tauri::Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let _ = window.center();
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn toggle_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_and_restore_window(app, &window);
        }
    }
}

fn restore_or_place<R: tauri::Runtime>(window: &WebviewWindow<R>, file: &Path) {
    if let Ok(text) = fs::read_to_string(file) {
        if let (Some(x), Some(y)) = (json_number(&text, "x"), json_number(&text, "y")) {
            if window
                .available_monitors()
                .map(|monitors| {
                    monitors.iter().any(|monitor| {
                        point_inside_monitor(x, y, *monitor.position(), *monitor.size())
                    })
                })
                .unwrap_or(false)
            {
                let _ = window.set_position(PhysicalPosition::new(x, y));
                return;
            }
        }
    }
    if let (Ok(Some(monitor)), Ok(size)) = (window.current_monitor(), window.outer_size()) {
        let work = monitor.position();
        let area = monitor.size();
        let x = work.x + area.width as i32 - size.width as i32 - 16;
        let y = work.y + area.height as i32 - size.height as i32 - 16;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

fn point_inside_monitor(
    x: i32,
    y: i32,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> bool {
    x >= position.x
        && y >= position.y
        && x < position.x + size.width as i32
        && y < position.y + size.height as i32
}

fn json_number(text: &str, key: &str) -> Option<i32> {
    let marker = format!("\"{}\":", key);
    let value = text.split(&marker).nth(1)?.split([',', '}']).next()?.trim();
    value.parse().ok()
}

fn state_root<R: tauri::Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Ok(root) = std::env::var("INTEGRATED_POWER_STATE_ROOT") {
        return PathBuf::from(root);
    }
    #[cfg(windows)]
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("IntegratedPower").join("state");
    }
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("IntegratedPower")
        .join("state")
}

fn position_file<R: tauri::Runtime>(app: &AppHandle<R>) -> PathBuf {
    state_root(app).join("control-center-window.json")
}

fn broker_launcher<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Ok(value) = std::env::var("INTEGRATED_POWER_BROKER_LAUNCHER") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("resources").join("broker-server.js"));
        candidates.push(resource.join("broker-server.js"));
    }
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("broker-server.js"));
        candidates.push(current.join("..\\broker-server.js"));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn bundled_node<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<String> {
    app.path()
        .resource_dir()
        .ok()
        .map(|resource| resource.join("resources").join("node-runtime.exe"))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
}
