use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, Child};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

struct AppState {
    sessions: Mutex<HashMap<u32, Arc<Mutex<PtySession>>>>,
    next_id: Mutex<u32>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

#[tauri::command]
async fn spawn_pty(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let cmd_name = command.unwrap_or_else(|| {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    });

    let mut cmd = CommandBuilder::new(&cmd_name);
    if let Some(ref args_vec) = args {
        for arg in args_vec {
            cmd.arg(arg);
        }
    }
    cmd.cwd(&cwd);

    // Inherit environment
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("LC_CTYPE", "en_US.UTF-8");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    // Get reader before moving master
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Get writer before moving master
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = {
        let mut next_id = state.next_id.lock();
        let id = *next_id;
        *next_id += 1;
        id
    };

    let session = Arc::new(Mutex::new(PtySession {
        master: pair.master,
        writer,
        child,
    }));

    {
        let mut sessions = state.sessions.lock();
        sessions.insert(id, Arc::clone(&session));
    }

    // Spawn reader thread
    let app_clone = app.clone();
    let session_clone = Arc::clone(&session);
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit("pty-output", PtyOutput { id, data });
                }
                Err(_) => break,
            }
        }

        // Process exited, get exit code
        let exit_code = {
            let mut session = session_clone.lock();
            session.child.wait().ok().map(|s| s.exit_code())
        };

        let _ = app_clone.emit("pty-exit", PtyExit { id, code: exit_code });
    });

    Ok(id)
}

#[tauri::command]
async fn write_pty(
    state: State<'_, AppState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock();
        sessions.get(&id).cloned()
    };

    match session {
        Some(session) => {
            let mut session = session.lock();
            session.writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            session.writer.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err(format!("PTY session {} not found", id)),
    }
}

#[tauri::command]
async fn resize_pty(
    state: State<'_, AppState>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock();
        sessions.get(&id).cloned()
    };

    match session {
        Some(session) => {
            let session = session.lock();
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err(format!("PTY session {} not found", id)),
    }
}

#[tauri::command]
async fn kill_pty(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    let session = {
        let mut sessions = state.sessions.lock();
        sessions.remove(&id)
    };

    match session {
        Some(session) => {
            let mut session = session.lock();
            session.child.kill().map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err(format!("PTY session {} not found", id)),
    }
}

#[derive(Serialize)]
struct PrerequisiteCheck {
    name: String,
    available: bool,
    path: Option<String>,
}

#[tauri::command]
async fn check_prerequisites() -> Vec<PrerequisiteCheck> {
    let commands = vec!["node", "npm", "git", "claude"];
    let mut results = Vec::new();

    for cmd in commands {
        let (available, path) = match which::which(cmd) {
            Ok(p) => (true, Some(p.to_string_lossy().to_string())),
            Err(_) => (false, None),
        };
        results.push(PrerequisiteCheck {
            name: cmd.to_string(),
            available,
            path,
        });
    }

    results
}

#[tauri::command]
async fn get_maros_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let maros_dir = home.join("MarOS");
    Ok(maros_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn ensure_maros_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let maros_dir = home.join("MarOS");

    if !maros_dir.exists() {
        std::fs::create_dir_all(&maros_dir).map_err(|e| e.to_string())?;
    }

    Ok(maros_dir.to_string_lossy().to_string())
}

#[derive(Serialize)]
struct ProjectInfo {
    name: String,
    path: String,
}

#[tauri::command]
async fn delete_project(path: String) -> Result<(), String> {
    let project_path = std::path::Path::new(&path);

    // Safety check: only allow deleting from MarOS directory
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let maros_dir = home.join("MarOS");

    if !project_path.starts_with(&maros_dir) {
        return Err("Can only delete projects from MarOS directory".to_string());
    }

    if !project_path.exists() {
        return Err("Project not found".to_string());
    }

    std::fs::remove_dir_all(project_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let maros_dir = home.join("MarOS");

    if !maros_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&maros_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            // Check if it's a valid project (has package.json)
            if path.join("package.json").exists() {
                projects.push(ProjectInfo {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(projects)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            check_prerequisites,
            get_maros_dir,
            ensure_maros_dir,
            list_projects,
            delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
