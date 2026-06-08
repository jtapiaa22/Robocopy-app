use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

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

#[derive(Serialize, Clone)]
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

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
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
    let stdout = child.stdout.take().ok_or("No se pudo capturar stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let _ = app.emit("robocopy-output", &line);
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
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

// ─── Entry point ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            list_drives,
            list_directory,
            get_parent_path,
            run_robocopy,
            save_job,
            load_jobs,
            delete_job,
        ])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación");
}
