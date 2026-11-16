use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
// AsyncReadExt se importa dentro de stream_output para no contaminar el scope global
use tokio::process::Command;

// ─── Decodificación de salida CMD (OEM code page) ────────────────────────────

// Robocopy emite texto usando el code page OEM del sistema (ej. CP850 en español).
// String::from_utf8_lossy no es suficiente: los acentos aparecen como símbolos raros.
// Usamos MultiByteToWideChar con CP_OEMCP para decodificar correctamente en cualquier locale.
#[cfg(target_os = "windows")]
fn decode_cmd_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
    let len = unsafe {
        MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0)
    };
    if len <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut wide = vec![0u16; len as usize];
    unsafe {
        MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), len);
    }
    String::from_utf16_lossy(&wide)
}

#[cfg(not(target_os = "windows"))]
fn decode_cmd_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

struct ProcessState {
    pid: Mutex<Option<u32>>,
    cancelled: AtomicBool,
}

struct CloneState {
    cancel: Arc<AtomicBool>,
    active: AtomicBool,
}

// ─── Estructuras de datos ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct PartitionInfo {
    letter: Option<String>,
    size: u64,
    label: String,
    fs: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct DiskInfo {
    index: u32,
    model: String,
    size: u64,
    #[serde(rename = "isSystem")]
    is_system: bool,
    #[serde(rename = "isBoot")]
    is_boot: bool,
    style: String,
    partitions: Vec<PartitionInfo>,
}

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
                    let line = decode_cmd_output(&pending);
                    let _ = app.emit("robocopy-output", &line);
                    pending.clear();
                    prev_cr = false;
                    continue;
                } else {
                    // \r solo → porcentaje en curso (reemplaza última línea)
                    if !pending.is_empty() {
                        let line = decode_cmd_output(&pending);
                        let _ = app.emit("robocopy-output-cr", &line);
                        pending.clear();
                    }
                    prev_cr = false;
                }
            }
            match byte {
                b'\r' => { prev_cr = true; }
                b'\n' => {
                    let line = decode_cmd_output(&pending);
                    let _ = app.emit("robocopy-output", &line);
                    pending.clear();
                }
                _ => { pending.push(byte); }
            }
        }
    }
    if !pending.is_empty() {
        let line = decode_cmd_output(&pending);
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
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
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

// Corre robocopy en silencio y devuelve toda su salida (para el pre-escaneo con /L,
// que calcula cuántos archivos y bytes se van a copiar sin tocar nada).
// Registra el PID para que "Cancelar" también lo corte.
#[tauri::command]
async fn scan_robocopy(
    app: tauri::AppHandle,
    source: String,
    destination: String,
    flags: Vec<String>,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;

    let mut cmd = Command::new("robocopy");
    cmd.arg(&source)
        .arg(&destination)
        .args(&flags)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let state = app.state::<ProcessState>();
    *state.pid.lock().unwrap() = child.id();

    let mut out = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_end(&mut out).await;
    }
    let _ = child.wait().await;
    *state.pid.lock().unwrap() = None;

    if state.cancelled.load(Ordering::SeqCst) {
        return Err("cancelado".into());
    }
    Ok(decode_cmd_output(&out))
}

// Para arrastrar y soltar: indica cuáles de las rutas son carpetas
#[tauri::command]
fn paths_are_dirs(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_dir()).collect()
}

// ─── Comandos: elevación (administrador bajo demanda) ────────────────────────
//
// La app arranca sin admin (así funciona arrastrar desde el Explorador, que Windows
// bloquea hacia ventanas elevadas). Clonar discos y el modo /B sí necesitan admin:
// para eso la app se relanza elevada, guardando antes su estado para restaurarlo.

const RELAUNCH_ARG: &str = "--elevated-relaunch";

fn relaunch_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("relaunch_state.json"))
}

#[tauri::command]
fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
    #[cfg(not(target_os = "windows"))]
    false
}

// Abre una nueva instancia elevada (aparece el UAC) y cierra esta.
// `state` es un JSON del frontend (pestaña, rutas, opciones) para continuar donde estaba.
#[tauri::command]
fn relaunch_as_admin(app: tauri::AppHandle, state: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let state_path = relaunch_state_path(&app);
        if let (Some(path), Some(s)) = (&state_path, &state) {
            if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
            std::fs::write(path, s).map_err(|e| e.to_string())?;
        }

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let verb = wide(std::ffi::OsStr::new("runas"));
        let file = wide(exe.as_os_str());
        let params = wide(std::ffi::OsStr::new(RELAUNCH_ARG));

        let result = unsafe {
            ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), params.as_ptr(), std::ptr::null(), SW_SHOWNORMAL)
        };
        // ShellExecuteW devuelve > 32 si lanzó; si no (p. ej. el usuario canceló el UAC) seguimos como estábamos
        if (result as isize) <= 32 {
            if let Some(path) = &state_path { let _ = std::fs::remove_file(path); }
            return Err("No se otorgaron permisos de administrador.".into());
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        Err("Solo disponible en Windows".into())
    }
}

// Si esta instancia viene de un relanzamiento elevado, devuelve (y borra) el estado guardado
#[tauri::command]
fn take_relaunch_state(app: tauri::AppHandle) -> Option<String> {
    if !std::env::args().any(|a| a == RELAUNCH_ARG) {
        return None;
    }
    let path = relaunch_state_path(&app)?;
    let s = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    s
}

// Marca el inicio de una nueva operación (limpia una cancelación anterior)
#[tauri::command]
fn reset_cancel(app: tauri::AppHandle) {
    app.state::<ProcessState>().cancelled.store(false, Ordering::SeqCst);
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

        // Path::join evita dobles barras cuando el padre es raíz de unidad ("D:\")
        let src = Path::new(&parent_source).join(folder);
        let dst = Path::new(&parent_dest).join(folder);

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
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }

        // Si una carpeta falla al iniciar, se registra como error (16) y se sigue con las demás
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("robocopy-output", format!("ERROR: no se pudo iniciar robocopy para \"{}\": {}", folder, e));
                codes.push(16);
                let _ = app.emit("robocopy-folder-done", 16);
                continue;
            }
        };
        *state.pid.lock().unwrap() = child.id();

        if let Some(stdout) = child.stdout.take() {
            stream_output(app.clone(), stdout).await;
        }

        let code = match child.wait().await {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => 16,
        };
        *state.pid.lock().unwrap() = None;
        codes.push(code);
        let _ = app.emit("robocopy-folder-done", code);
    }

    let _ = app.emit("robocopy-all-done", &codes);
    Ok(codes)
}

// Envía CTRL_BREAK_EVENT al proceso de Robocopy para desbloquearlo sin matarlo.
// Equivalente a presionar Ctrl+C una vez en CMD: interrumpe una espera de I/O atascada
// y permite que Robocopy reintente la operación y continúe.
#[tauri::command]
fn nudge_robocopy(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ProcessState>();
    if let Some(pid) = *state.pid.lock().unwrap() {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
            GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid);
        }
    }
    Ok(())
}

#[tauri::command]
async fn cancel_robocopy(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ProcessState>();
    state.cancelled.store(true, Ordering::SeqCst);
    // Extraer pid antes del await para no retener el MutexGuard (no es Send)
    let pid = *state.pid.lock().unwrap();
    if let Some(pid) = pid {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/F", "/T"]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        if let Ok(mut child) = cmd.spawn() {
            let _ = child.wait().await;
        }
    }
    Ok(())
}

// ─── Comandos: enumeración de discos físicos ─────────────────────────────────

#[tauri::command]
async fn list_disks() -> Result<Vec<DiskInfo>, String> {
    let ps_script = r#"
$result = @(Get-Disk | ForEach-Object {
    $disk = $_
    $parts = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue | ForEach-Object {
        $vol = Get-Volume -Partition $_ -ErrorAction SilentlyContinue
        [PSCustomObject]@{
            letter = if ($_.DriveLetter -and $_.DriveLetter -ne [char]0) { [string]$_.DriveLetter } else { $null }
            size   = [long]$_.Size
            label  = if ($vol) { [string]$vol.FileSystemLabel } else { '' }
            fs     = if ($vol) { [string]$vol.FileSystem } else { '' }
        }
    })
    [PSCustomObject]@{
        index      = [int]$disk.Number
        model      = [string]$disk.FriendlyName
        size       = [long]$disk.Size
        isSystem   = [bool]$disk.IsSystem
        isBoot     = [bool]$disk.IsBoot
        style      = [string]$disk.PartitionStyle
        partitions = $parts
    }
})
$result | ConvertTo-Json -Depth 4 -Compress
"#;

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await.map_err(|e| e.to_string())?;
    // PowerShell emite en el code page de consola: decodificar como el resto de salida CMD
    let stdout = decode_cmd_output(&output.stdout);
    let trimmed = stdout.trim();

    if trimmed.is_empty() || trimmed == "null" {
        return Ok(vec![]);
    }

    // PowerShell devuelve objeto (no array) cuando hay un solo disco — normalizar
    let val: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("Parse error: {e}"))?;

    let arr = match val {
        serde_json::Value::Array(a) => a,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => return Ok(vec![]),
    };

    Ok(arr.into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect())
}

// ─── Comandos: clonado de disco ───────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct CloneProgress {
    copied: u64,
    total: u64,
    #[serde(rename = "speedMbps")]
    speed_mbps: f64,
    #[serde(rename = "etaSeconds")]
    eta_seconds: u64,
}

#[derive(Serialize, Clone)]
struct CloneStatus {
    message: String,
}

#[tauri::command]
fn cancel_clone(state: tauri::State<'_, CloneState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn start_clone(
    source_index: u32,
    dest_index: u32,
    dest_letters: Vec<String>,
    expand_partition: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, CloneState>,
) -> Result<(), String> {
    state.cancel.store(false, Ordering::Relaxed);
    state.active.store(true, Ordering::SeqCst);
    let cancel = state.cancel.clone();

    let result = tokio::task::spawn_blocking(move || {
        clone_disk_blocking(source_index, dest_index, dest_letters, expand_partition, app, cancel)
    })
    .await;

    state.active.store(false, Ordering::SeqCst);
    result.map_err(|e| e.to_string())?
}

// Declaraciones explícitas de las API de Windows para I/O de disco
// (evita depender de qué features específicas exporta cada versión de windows-sys)
#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
mod disk_win {
    use std::ffi::c_void;

    pub const GENERIC_READ: u32           = 0x80000000;
    pub const GENERIC_WRITE: u32          = 0x40000000;
    pub const FILE_SHARE_READ: u32        = 0x00000001;
    pub const FILE_SHARE_WRITE: u32       = 0x00000002;
    pub const OPEN_EXISTING: u32          = 3;
    pub const FILE_FLAG_NO_BUFFERING: u32 = 0x20000000;
    pub const FILE_FLAG_WRITE_THROUGH: u32= 0x80000000;
    // DeviceIoControl code para obtener geometría + tamaño del disco
    pub const IOCTL_DISK_GET_DRIVE_GEOMETRY_EX: u32 = 0x000700a0;
    // Para desmontar volúmenes del destino antes de escribir
    pub const FSCTL_LOCK_VOLUME: u32     = 0x00090018;
    pub const FSCTL_DISMOUNT_VOLUME: u32 = 0x00090020;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetLastError() -> u32;

        pub fn CreateFileW(
            lpfilename: *const u16,
            dwdesiredaccess: u32,
            dwsharemode: u32,
            lpsecurityattributes: *const c_void,
            dwcreationdisposition: u32,
            dwflagsandattributes: u32,
            htemplatefile: *mut c_void,
        ) -> *mut c_void;

        pub fn ReadFile(
            hfile: *mut c_void,
            lpbuffer: *mut c_void,
            nnumberofbytestoread: u32,
            lpnumberofbytesread: *mut u32,
            lpoverlapped: *mut c_void,
        ) -> i32;

        pub fn WriteFile(
            hfile: *mut c_void,
            lpbuffer: *const c_void,
            nnumberofbytestowrite: u32,
            lpnumberofbyteswritten: *mut u32,
            lpoverlapped: *mut c_void,
        ) -> i32;

        pub fn CloseHandle(hobject: *mut c_void) -> i32;

        pub fn DeviceIoControl(
            hdevice: *mut c_void,
            dwiocontrolcode: u32,
            lpinbuffer: *const c_void,
            ninbuffersize: u32,
            lpoutbuffer: *mut c_void,
            noutbuffersize: u32,
            lpbytesreturned: *mut u32,
            lpoverlapped: *mut c_void,
        ) -> i32;
    }
}

#[cfg(target_os = "windows")]
fn clone_disk_blocking(
    source_index: u32,
    dest_index: u32,
    dest_letters: Vec<String>,
    expand_partition: bool,
    app: tauri::AppHandle,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    use std::ffi::c_void;
    use std::time::Instant;
    use disk_win::*;

    let invalid: *mut c_void = (-1isize) as *mut c_void;

    let open_disk = |index: u32, write: bool| -> Result<*mut c_void, String> {
        let path: Vec<u16> = format!("\\\\.\\PhysicalDrive{}\0", index)
            .encode_utf16()
            .collect();
        let access = if write { GENERIC_READ | GENERIC_WRITE } else { GENERIC_READ };
        let flags = FILE_FLAG_NO_BUFFERING | if write { FILE_FLAG_WRITE_THROUGH } else { 0 };
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                flags,
                std::ptr::null_mut(),
            )
        };
        if handle == invalid {
            let err = unsafe { GetLastError() };
            Err(format!(
                "No se pudo abrir PhysicalDrive{} (error {}). ¿Está conectado y la app corre como administrador?",
                index, err
            ))
        } else {
            Ok(handle)
        }
    };

    // DISK_GEOMETRY_EX: 24 bytes (DISK_GEOMETRY) + 8 bytes (DiskSize i64) + resto.
    // Buffer raw de 64 bytes, DiskSize en el offset 24.
    let read_disk_size = |handle: *mut c_void| -> Option<u64> {
        let mut buf = [0u8; 64];
        let mut bytes_returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_DISK_GET_DRIVE_GEOMETRY_EX,
                std::ptr::null(),
                0,
                buf.as_mut_ptr() as *mut c_void,
                buf.len() as u32,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return None;
        }
        Some(i64::from_ne_bytes(buf[24..32].try_into().unwrap()) as u64)
    };

    // ── Paso 0: validar TODO antes de tocar el destino ──────────────────────
    // Clear-Disk es destructivo e irreversible: hasta no confirmar que el origen
    // se puede abrir y que el destino es lo bastante grande, no se modifica nada.
    let _ = app.emit("clone-status", CloneStatus {
        message: "Verificando discos...".to_string(),
    });

    let src_handle = open_disk(source_index, false)?;

    let disk_size = match read_disk_size(src_handle) {
        Some(s) => s,
        None => {
            unsafe { CloseHandle(src_handle); }
            return Err("No se pudo obtener el tamaño del disco origen".to_string());
        }
    };

    {
        let probe = match open_disk(dest_index, false) {
            Ok(h) => h,
            Err(e) => {
                unsafe { CloseHandle(src_handle); }
                return Err(e);
            }
        };
        let dest_size = read_disk_size(probe);
        unsafe { CloseHandle(probe); }
        match dest_size {
            None => {
                unsafe { CloseHandle(src_handle); }
                return Err("No se pudo obtener el tamaño del disco destino".to_string());
            }
            Some(d) if d < disk_size => {
                unsafe { CloseHandle(src_handle); }
                return Err(format!(
                    "El disco destino ({:.1} GB) es más chico que el origen ({:.1} GB). \
                     Clonación abortada — el destino no fue modificado.",
                    d as f64 / 1e9,
                    disk_size as f64 / 1e9
                ));
            }
            Some(_) => {}
        }
    }

    // ── Paso 1: limpiar el disco destino ────────────────────────────────────
    // Elimina todas las particiones y el MBR/GPT del destino. Esto garantiza
    // que no haya volúmenes montados que bloqueen las escrituras posteriores.
    let _ = app.emit("clone-status", CloneStatus {
        message: "Preparando disco destino (limpiando particiones)...".to_string(),
    });

    let clean_script = format!(
        "Clear-Disk -Number {} -RemoveData -RemoveOEM -Confirm:$false -ErrorAction SilentlyContinue",
        dest_index
    );
    let clean_out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &clean_script])
        .output();

    if let Err(e) = clean_out {
        unsafe { CloseHandle(src_handle); }
        return Err(format!("No se pudo ejecutar Clear-Disk: {}", e));
    }

    // Pequeña pausa para que Windows actualice la vista del disco
    std::thread::sleep(std::time::Duration::from_millis(800));

    let _ = app.emit("clone-status", CloneStatus {
        message: "Iniciando copia sector a sector...".to_string(),
    });

    // Desmontar todos los volúmenes del disco destino antes de escribir.
    // Windows bloquea escrituras en un disco físico si tiene volúmenes montados.
    // Guardamos los handles abiertos para mantener el lock durante toda la clonación.
    let mut vol_handles: Vec<*mut c_void> = Vec::new();
    for letter in &dest_letters {
        if letter.is_empty() { continue; }
        let vol_path: Vec<u16> = format!("\\\\.\\{}:\0", letter).encode_utf16().collect();
        let vh = unsafe {
            CreateFileW(
                vol_path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if vh != invalid {
            let mut br: u32 = 0;
            unsafe {
                // Bloquear el volumen (falla si hay archivos abiertos → continuamos igual)
                DeviceIoControl(vh, FSCTL_LOCK_VOLUME, std::ptr::null(), 0,
                    std::ptr::null_mut(), 0, &mut br, std::ptr::null_mut());
                // Desmontar del sistema de archivos
                DeviceIoControl(vh, FSCTL_DISMOUNT_VOLUME, std::ptr::null(), 0,
                    std::ptr::null_mut(), 0, &mut br, std::ptr::null_mut());
            }
            vol_handles.push(vh);
        }
    }

    let dst_handle = match open_disk(dest_index, true) {
        Ok(h) => h,
        Err(e) => {
            unsafe { CloseHandle(src_handle); }
            for vh in &vol_handles { unsafe { CloseHandle(*vh); } }
            return Err(e);
        }
    };

    // FILE_FLAG_NO_BUFFERING requiere:
    //   1) tamaño del chunk múltiplo de 512
    //   2) puntero del buffer alineado a 512 bytes
    // Solución: over-alocar 511 bytes extra en el heap y calcular el offset alineado.
    // Box::new(large_array) causa stack overflow porque Rust evalúa el valor en el
    // stack antes de moverlo al heap.
    const CHUNK: usize = 1_048_576; // 1 MB
    let mut raw_buf = vec![0u8; CHUNK + 511];
    let align_offset = raw_buf.as_ptr().align_offset(512);
    // align_offset < 512, por lo que align_offset + CHUNK <= raw_buf.len() siempre
    let mut copied: u64 = 0;
    let start_time = Instant::now();
    let mut last_emit = Instant::now();

    let result = loop {
        if cancel.load(Ordering::Relaxed) {
            break Err("Clonación cancelada por el usuario".to_string());
        }

        let remaining = disk_size.saturating_sub(copied);
        if remaining == 0 { break Ok(()); }

        let to_read = CHUNK.min(remaining as usize);
        let aligned = ((to_read + 511) / 512) * 512;
        let buf_slice = &mut raw_buf[align_offset..align_offset + aligned];

        let mut bytes_read: u32 = 0;
        let ok = unsafe {
            ReadFile(
                src_handle,
                buf_slice.as_mut_ptr() as *mut c_void,
                aligned as u32,
                &mut bytes_read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || bytes_read == 0 {
            let err = unsafe { GetLastError() };
            break Err(format!("Error de lectura del disco origen (código Windows: {})", err));
        }

        let mut bytes_written: u32 = 0;
        let ok = unsafe {
            WriteFile(
                dst_handle,
                buf_slice.as_ptr() as *const c_void,
                bytes_read,
                &mut bytes_written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            break Err(format!("Error de escritura en el disco destino (código Windows: {})", err));
        }
        // Una escritura parcial desalinearía los punteros de origen y destino:
        // todo lo que siga se escribiría corrido → clon corrupto silencioso.
        if bytes_written != bytes_read {
            break Err(format!(
                "Escritura incompleta en el disco destino ({} de {} bytes). Clonación abortada.",
                bytes_written, bytes_read
            ));
        }

        copied += (bytes_read as usize).min(to_read) as u64;

        if last_emit.elapsed().as_millis() >= 200 {
            last_emit = Instant::now();
            let elapsed = start_time.elapsed().as_secs_f64().max(0.001);
            let speed_mbps = (copied as f64 / elapsed) / 1_048_576.0;
            let eta_seconds = if speed_mbps > 0.0 {
                ((disk_size - copied) as f64 / (speed_mbps * 1_048_576.0)) as u64
            } else { 0 };
            let _ = app.emit("clone-progress", CloneProgress {
                copied, total: disk_size, speed_mbps, eta_seconds,
            });
        }
    };

    unsafe { CloseHandle(src_handle); CloseHandle(dst_handle); }
    for vh in &vol_handles { unsafe { CloseHandle(*vh); } }

    if result.is_ok() {
        let _ = app.emit("clone-status", CloneStatus {
            message: "Finalizando: actualizando disco destino...".to_string(),
        });

        // 1. Cambiar la firma del disco destino para que no colisione con el origen.
        //    Windows pone offline los discos con firma duplicada (mismo MBR/GPT signature).
        //    Usamos diskpart para asignar una nueva firma única.
        let diskpart_script = format!(
            "select disk {}\nuniqueid disk\nonline disk\nattributes disk clear readonly\n",
            dest_index
        );
        let _ = std::process::Command::new("diskpart")
            .args(["/s", "nul"])  // fallback: lo pasamos por stdin
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(stdin) = child.stdin.as_mut() {
                    let _ = stdin.write_all(diskpart_script.as_bytes());
                }
                child.wait()
            });

        // 2. Traer el disco online y quitar read-only vía PowerShell (más confiable que diskpart solo)
        let ps_online = format!(
            "$d = Get-Disk -Number {n} -ErrorAction SilentlyContinue; \
             if ($d) {{ \
               if ($d.IsOffline) {{ Set-Disk -Number {n} -IsOffline $false }}; \
               if ($d.IsReadOnly) {{ Set-Disk -Number {n} -IsReadOnly $false }}; \
               Update-Disk -Number {n} -ErrorAction SilentlyContinue \
             }}",
            n = dest_index
        );
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_online])
            .output();

        // 3. Extender la última partición de datos al máximo del disco destino (opcional)
        if expand_partition {
            let _ = app.emit("clone-status", CloneStatus {
                message: "Extendiendo partición al espacio disponible...".to_string(),
            });
            let ps_extend = format!(
                "$parts = Get-Partition -DiskNumber {n} -ErrorAction SilentlyContinue \
                 | Where-Object {{ $_.Type -notin @('Reserved','System','Recovery','Unknown') }} \
                 | Sort-Object Offset; \
                 if ($parts) {{ \
                   $last = $parts | Select-Object -Last 1; \
                   $sz = Get-PartitionSupportedSize -DiskNumber {n} -PartitionNumber $last.PartitionNumber -ErrorAction SilentlyContinue; \
                   if ($sz -and $sz.SizeMax -gt $last.Size) {{ \
                     Resize-Partition -DiskNumber {n} -PartitionNumber $last.PartitionNumber -Size $sz.SizeMax -ErrorAction SilentlyContinue \
                   }} \
                 }}",
                n = dest_index
            );
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_extend])
                .output();
        }

        let _ = app.emit("clone-status", CloneStatus {
            message: "Clonación completada. El disco destino está listo para usar.".to_string(),
        });
    }

    let elapsed = start_time.elapsed().as_secs_f64().max(0.001);
    let _ = app.emit("clone-progress", CloneProgress {
        copied,
        total: disk_size,
        speed_mbps: (copied as f64 / elapsed) / 1_048_576.0,
        eta_seconds: 0,
    });

    result
}

#[cfg(not(target_os = "windows"))]
fn clone_disk_blocking(
    _source_index: u32,
    _dest_index: u32,
    _dest_letters: Vec<String>,
    _expand_partition: bool,
    _app: tauri::AppHandle,
    _cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    Err("Clonado de disco solo disponible en Windows".to_string())
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
        .manage(CloneState { cancel: Arc::new(AtomicBool::new(false)), active: AtomicBool::new(false) })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let ps = window.state::<ProcessState>();
                let cs = window.state::<CloneState>();
                let has_process = ps.pid.lock().map(|g| g.is_some()).unwrap_or(false);
                let process_cancelled = ps.cancelled.load(Ordering::SeqCst);
                let is_cloning = cs.active.load(Ordering::SeqCst);
                let clone_cancelled = cs.cancel.load(Ordering::SeqCst);
                if (has_process && !process_cancelled) || (is_cloning && !clone_cancelled) {
                    api.prevent_close();
                    let _ = window.emit("app-close-requested", ());
                }
            }
        })
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
            scan_robocopy,
            reset_cancel,
            paths_are_dirs,
            is_elevated,
            relaunch_as_admin,
            take_relaunch_state,
            nudge_robocopy,
            cancel_robocopy,
            save_job,
            load_jobs,
            delete_job,
            list_disks,
            start_clone,
            cancel_clone,
        ])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación");
}
