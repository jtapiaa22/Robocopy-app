use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
// AsyncReadExt se importa dentro de stream_output para no contaminar el scope global
use tokio::process::Command;

struct ProcessState {
    pid: Mutex<Option<u32>>,
    cancelled: AtomicBool,
}

// ─── Estructuras de datos ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
    extension: String,
}

#[derive(Serialize, Clone, PartialEq)]
struct DriveInfo {
    letter: String,
    root: String,
}

// Un trabajo guardado en el historial
#[derive(Serialize, Deserialize, Clone)]
struct CopyJob {
    id: String,
    name: String,
    source: String,
    destination: String,
    config: serde_json::Value, // guarda todo el estado del panel como JSON
    created_at: u64,
}

// ─── Helpers para historial ──────────────────────────────────────────────────

fn get_jobs_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("jobs.json"))
}

fn read_jobs(app: &tauri::AppHandle) -> Result<Vec<CopyJob>, String> {
    let path = get_jobs_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_jobs(app: &tauri::AppHandle, jobs: &[CopyJob]) -> Result<(), String> {
    let path = get_jobs_path(app)?;
    let json = serde_json::to_string_pretty(jobs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// ─── Comandos: explorador ────────────────────────────────────────────────────

fn get_drives() -> Vec<DriveInfo> {
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                Some(DriveInfo {
                    letter: format!("{}:", letter as char),
                    root,
                })
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    get_drives()
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    let mut result: Vec<FileEntry> = entries
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let entry_path = entry.path().to_string_lossy().into_owned();
            let is_dir = metadata.is_dir();
            let size = if is_dir { 0 } else { metadata.len() };
            let extension = if is_dir {
                String::new()
            } else {
                entry
                    .path()
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            Some(FileEntry { name, path: entry_path, is_dir, size, modified, extension })
        })
        .collect();

    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
fn get_parent_path(path: String) -> Option<String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

// ─── Helper: stream stdout de robocopy, diferenciando \r (progreso) y \r\n ───

async fn stream_output(app: tauri::AppHandle, mut stdout: tokio::process::ChildStdout) {
    use tokio::io::AsyncReadExt;

    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    let mut prev_cr = false;

    loop {
        let n = match stdout.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &buf[..n] {
            if prev_cr {
                if byte == b'\n' {
                    // \r\n → línea completa (append)
                    let line = String::from_utf8_lossy(&pending).into_owned();
                    let _ = app.emit("robocopy-output", &line);
                    pending.clear();
                    prev_cr = false;
                    continue;
                } else {
                    // \r solo → porcentaje en curso (reemplaza última línea)
                    if !pending.is_empty() {
                        let line = String::from_utf8_lossy(&pending).into_owned();
                        let _ = app.emit("robocopy-output-cr", &line);
                        pending.clear();
                    }
                    prev_cr = false;
                }
            }
            match byte {
                b'\r' => { prev_cr = true; }
                b'\n' => {
                    let line = String::from_utf8_lossy(&pending).into_owned();
                    let _ = app.emit("robocopy-output", &line);
                    pending.clear();
                }
                _ => { pending.push(byte); }
            }
        }
    }
    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending).into_owned();
        let _ = app.emit("robocopy-output", &line);
    }
}

// ─── Comandos: robocopy ──────────────────────────────────────────────────────

#[tauri::command]
async fn run_robocopy(
    app: tauri::AppHandle,
    source: String,
    destination: String,
    flags: Vec<String>,
) -> Result<i32, String> {
    let mut cmd = Command::new("robocopy");
    cmd.arg(&source)
        .arg(&destination)
        .args(&flags)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // Guarda el PID para poder cancelar
    let state = app.state::<ProcessState>();
    state.cancelled.store(false, Ordering::SeqCst);
    *state.pid.lock().unwrap() = child.id();

    let stdout = child.stdout.take().ok_or("No se pudo capturar stdout")?;
    stream_output(app.clone(), stdout).await;

    let status = child.wait().await.map_err(|e| e.to_string())?;
    *state.pid.lock().unwrap() = None;
    let code = status.code().unwrap_or(-1);
    let _ = app.emit("robocopy-done", code);
    Ok(code)
}

// ─── Comandos: historial de trabajos ────────────────────────────────────────

#[tauri::command]
fn save_job(app: tauri::AppHandle, job: CopyJob) -> Result<(), String> {
    let mut jobs = read_jobs(&app)?;
    // Si ya existe un trabajo con el mismo id, lo reemplaza
    if let Some(pos) = jobs.iter().position(|j| j.id == job.id) {
        jobs[pos] = job;
    } else {
        jobs.insert(0, job); // más reciente al inicio
    }
    write_jobs(&app, &jobs)
}

#[tauri::command]
fn load_jobs(app: tauri::AppHandle) -> Result<Vec<CopyJob>, String> {
    read_jobs(&app)
}

#[tauri::command]
fn delete_job(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut jobs = read_jobs(&app)?;
    jobs.retain(|j| j.id != id);
    write_jobs(&app, &jobs)
}

// Corre Robocopy una vez por cada subcarpeta seleccionada
#[tauri::command]
async fn run_robocopy_multi(
    app: tauri::AppHandle,
    parent_source: String,
    parent_dest: String,
    folders: Vec<String>,
    flags: Vec<String>,
) -> Result<Vec<i32>, String> {
    let mut codes: Vec<i32> = vec![];
    let state = app.state::<ProcessState>();
    state.cancelled.store(false, Ordering::SeqCst);

    for folder in &folders {
        if state.cancelled.load(Ordering::SeqCst) { break; }

        let src = format!("{}\\{}", parent_source, folder);
        let dst = format!("{}\\{}", parent_dest, folder);

        let _ = app.emit("robocopy-folder-start", folder.clone());

        let mut cmd = Command::new("robocopy");
        cmd.arg(&src)
            .arg(&dst)
            .args(&flags)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        *state.pid.lock().unwrap() = child.id();

        let stdout = child.stdout.take().ok_or("No stdout")?;
        stream_output(app.clone(), stdout).await;

        let code = child.wait().await.map_err(|e| e.to_string())?.code().unwrap_or(-1);
        *state.pid.lock().unwrap() = None;
        codes.push(code);
        let _ = app.emit("robocopy-folder-done", code);
    }

    let _ = app.emit("robocopy-all-done", &codes);
    Ok(codes)
}

#[tauri::command]
fn cancel_robocopy(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ProcessState>();
    state.cancelled.store(true, Ordering::SeqCst);
    if let Some(pid) = *state.pid.lock().unwrap() {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/F", "/T"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Entry point ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessState { pid: Mutex::new(None), cancelled: AtomicBool::new(false) })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last = get_drives();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let current = get_drives();
                    if current != last {
                        last = current.clone();
                        let _ = handle.emit("drives-changed", &last);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_drives,
            list_directory,
            get_parent_path,
            run_robocopy,
            run_robocopy_multi,
            cancel_robocopy,
            save_job,
            load_jobs,
            delete_job,
        ])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación");
}
