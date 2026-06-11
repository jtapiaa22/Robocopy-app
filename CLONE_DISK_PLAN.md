# Plan: Feature "Clonar Disco"

## Estado actual
- [x] Fase 0: Bloquear cierre de app mientras hay operación en curso (Robocopy + Clone)
- [x] Fase 1: Enumeración de discos (Backend Rust) — comando `list_disks` vía PowerShell Get-Disk
- [x] Fase 2: UI — nueva pestaña "Clonar Disco" (CloneDisk.jsx + tab en App.jsx)
- [x] Fase 3: Motor de clonado (Backend Rust, raw I/O) — `start_clone` / `cancel_clone` con extern "system"
- [x] Fase 4: Progreso, cancelación y manejo de errores — eventos `clone-progress`, listener en frontend

Marcar cada ítem con [x] a medida que se completa.

---

## Contexto del proyecto

- App: Tauri 2 + React + Tailwind CSS
- Rust backend: `src-tauri/src/lib.rs`
- Frontend: `src/` (React/JSX)
- Ya tiene: comandos Tauri, eventos de progreso, `windows-sys` como dependencia
- Admin ya configurado: `build.rs` con `requireAdministrator` en el manifiesto

---

## Qué hace el feature

Clona un disco físico completo (sector a sector, byte a byte) a otro disco usando
raw I/O de Windows (`\\.\PhysicalDriveN`). Copia TODO: MBR/GPT, boot sector,
particiones, archivos del sistema, etc. Resultado: copia idéntica, booteable si
el original lo era.

**Limitación**: el disco del sistema activo (el que corre Windows ahora) NO se puede
clonar en caliente. Se detecta y se bloquea en la UI.

---

## Fase 1 — Enumeración de discos (Rust)

### Objetivo
Nuevo comando Tauri `list_disks()` que retorna JSON con todos los discos físicos.

### Implementación
Usar PowerShell desde Rust (igual que ya se hace para otras cosas):

```powershell
Get-Disk | ForEach-Object {
  $disk = $_
  $parts = Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue |
    ForEach-Object {
      $vol = Get-Volume -Partition $_ -ErrorAction SilentlyContinue
      [PSCustomObject]@{
        letter = $_.DriveLetter
        size   = $_.Size
        label  = if ($vol) { $vol.FileSystemLabel } else { "" }
        fs     = if ($vol) { $vol.FileSystem } else { "" }
      }
    }
  [PSCustomObject]@{
    index     = $disk.Number
    model     = $disk.FriendlyName
    size      = $disk.Size
    isSystem  = $disk.IsSystem
    isBoot    = $disk.IsBoot
    style     = $disk.PartitionStyle   # MBR o GPT
    partitions = @($parts)
  }
} | ConvertTo-Json -Depth 4
```

### Struct Rust a retornar (serde)
```rust
#[derive(serde::Serialize)]
struct PartitionInfo {
    letter: Option<String>,
    size: u64,
    label: String,
    fs: String,
}

#[derive(serde::Serialize)]
struct DiskInfo {
    index: u32,
    model: String,
    size: u64,
    is_system: bool,
    is_boot: bool,
    style: String,
    partitions: Vec<PartitionInfo>,
}
```

### Archivo a modificar
- `src-tauri/src/lib.rs` — agregar comando `list_disks`

---

## Fase 2 — UI nueva pestaña

### Archivos a crear/modificar
- **CREAR**: `src/components/CloneDisk.jsx`
- **MODIFICAR**: `src/App.jsx` — agregar tab "Clonar"

### Layout de CloneDisk.jsx
```
┌─────────────────────────────────────────────────────┐
│  CLONAR DISCO                                       │
├───────────────────────┬─────────────────────────────┤
│  ORIGEN               │  DESTINO                    │
│  [ selector discos ]  │  [ selector discos ]        │
│  info: modelo/tamaño  │  info: modelo/tamaño        │
│  ⚠ si es sistema      │  ⚠ si es más chico          │
├───────────────────────┴─────────────────────────────┤
│  [        Iniciar clonación        ]                │
├─────────────────────────────────────────────────────┤
│  ████████████░░░░  67%  •  245 GB / 365 GB          │
│  Velocidad: 320 MB/s  •  Tiempo restante: 4 min     │
│  [        Cancelar        ]                         │
└─────────────────────────────────────────────────────┘
```

### Estado React
```js
const [disks, setDisks]           = useState([])
const [source, setSource]         = useState(null)   // DiskInfo
const [dest, setDest]             = useState(null)    // DiskInfo
const [cloning, setCloning]       = useState(false)
const [progress, setProgress]     = useState(null)   // { copied, total, speed, eta }
const [error, setError]           = useState(null)
```

### Tab en App.jsx
Agregar al array TABS:
```jsx
{
  id: "clone",
  label: "Clonar Disco",
  icon: <svg>...</svg>   // ícono de dos discos con flecha
}
```

---

## Fase 3 — Motor de clonado (Rust)

### Nuevos features windows-sys necesarios
En `src-tauri/Cargo.toml` agregar a la lista de features:
```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = [
    "Win32_Globalization",
    "Win32_System_Console",
    "Win32_Storage_FileSystem",   # CreateFileW, ReadFile, WriteFile, GENERIC_READ, etc.
    "Win32_System_Ioctl",         # DeviceIoControl, FSCTL_LOCK_VOLUME, IOCTL_DISK_GET_DRIVE_GEOMETRY_EX
    "Win32_Foundation",           # HANDLE, BOOL, INVALID_HANDLE_VALUE, CloseHandle
    "Win32_System_IO",            # OVERLAPPED (si se usa I/O asíncrono)
]}
```

### Comando Tauri `start_clone`
```rust
#[tauri::command]
async fn start_clone(
    source_index: u32,
    dest_index: u32,
    app: tauri::AppHandle,
    state: tauri::State<'_, CloneState>,
) -> Result<(), String>
```

### Estado global de cancelación
```rust
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

struct CloneState {
    cancel: Arc<AtomicBool>,
}
```
Registrar en `tauri::Builder` con `.manage(CloneState { cancel: Arc::new(AtomicBool::new(false)) })`.

### Lógica del clone (pseudocódigo Rust)
```rust
// 1. Abrir discos
let src_path = format!("\\\\.\\PhysicalDrive{}", source_index);
let dst_path = format!("\\\\.\\PhysicalDrive{}", dest_index);

let src = CreateFileW(src_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ...);
let dst = CreateFileW(dst_path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, ...);

// 2. Obtener tamaño total del origen
// DeviceIoControl(src, IOCTL_DISK_GET_DRIVE_GEOMETRY_EX, ...) → disk_size en bytes

// 3. Loop de copia (chunks de 1 MB = 1_048_576 bytes)
const CHUNK: usize = 1_048_576;
let mut buffer = vec![0u8; CHUNK];
let mut copied: u64 = 0;
let start_time = Instant::now();

loop {
    if cancel.load(Ordering::Relaxed) { break; }

    let remaining = disk_size - copied;
    let to_read = CHUNK.min(remaining as usize);
    if to_read == 0 { break; }

    ReadFile(src, &mut buffer[..to_read], ...);
    WriteFile(dst, &buffer[..to_read], ...);
    copied += to_read as u64;

    // Emitir progreso cada X chunks o cada segundo
    let elapsed = start_time.elapsed().as_secs_f64();
    let speed = copied as f64 / elapsed / 1_048_576.0; // MB/s
    let eta = ((disk_size - copied) as f64 / (copied as f64 / elapsed)) as u64;

    app.emit("clone-progress", CloneProgress {
        copied,
        total: disk_size,
        speed_mbps: speed,
        eta_seconds: eta,
    });
}

// 4. Cerrar handles
CloseHandle(src);
CloseHandle(dst);
```

### Evento de progreso
```rust
#[derive(serde::Serialize, Clone)]
struct CloneProgress {
    copied: u64,
    total: u64,
    speed_mbps: f64,
    eta_seconds: u64,
}
```

### Comando `cancel_clone`
```rust
#[tauri::command]
fn cancel_clone(state: tauri::State<'_, CloneState>) {
    state.cancel.store(true, Ordering::Relaxed);
}
```

---

## Fase 4 — Progreso y manejo de errores en el frontend

### Listener de eventos en CloneDisk.jsx
```js
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

// Al montar:
const unlisten = await listen('clone-progress', (event) => {
    setProgress(event.payload)
})
// Al desmontar: unlisten()
```

### Formato del progreso en pantalla
- Barra de progreso: `copied / total * 100`
- Velocidad: `speed_mbps.toFixed(1) MB/s`
- ETA: convertir `eta_seconds` a `Xh Xm Xs`
- GB copiados: `(copied / 1e9).toFixed(1) GB / (total / 1e9).toFixed(1) GB`

---

---

## Fase 0 — Bloquear cierre de app durante operación activa

### Objetivo
Impedir que el usuario cierre la app mientras hay una copia Robocopy o un clonado
de disco en curso, a menos que primero cancele el proceso.

### Alcance
Aplica a DOS operaciones:
1. Copia Robocopy (ya existe `copyStatus.running` en App.jsx)
2. Clonado de disco (se agregará `cloning` en CloneDisk.jsx)

### Cómo funciona en Tauri 2
Tauri 2 expone `onCloseRequested` en el objeto ventana desde el frontend.
Si se llama `event.preventDefault()`, la ventana NO se cierra.

### Implementación — App.jsx

```js
import { getCurrentWindow } from '@tauri-apps/api/window'

// Dentro del componente App, agregar ref para el estado de operación activa:
const operationActiveRef = useRef(false)

// Mantener el ref sincronizado con el estado real:
useEffect(() => {
  operationActiveRef.current = copyStatus.running
}, [copyStatus.running])

// Registrar el handler UNA sola vez al montar:
useEffect(() => {
  const appWindow = getCurrentWindow()
  let unlisten

  appWindow.onCloseRequested((event) => {
    if (operationActiveRef.current) {
      event.preventDefault()           // bloquea el cierre
      setShowCloseWarning(true)         // muestra modal de advertencia
    }
  }).then(fn => { unlisten = fn })

  return () => { if (unlisten) unlisten() }
}, [])
```

### Modal de advertencia (en App.jsx JSX)
```jsx
{showCloseWarning && (
  <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
      <p className="text-sm text-gray-200 mb-5 leading-relaxed">
        Hay una operación en curso. Cancelá el proceso antes de cerrar la aplicación.
      </p>
      <button
        onClick={() => setShowCloseWarning(false)}
        className="w-full py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold transition-colors"
      >
        Entendido
      </button>
    </div>
  </div>
)}
```

### Estado adicional en App.jsx
```js
const [showCloseWarning, setShowCloseWarning] = useState(false)
```

### Cómo CloneDisk notifica a App que está activo
CloneDisk.jsx recibe una prop `onCloningChange(bool)` desde App.jsx.
Cuando empieza el clone: `onCloningChange(true)`.
Cuando termina/cancela: `onCloningChange(false)`.
App.jsx combina: `operationActiveRef.current = copyStatus.running || cloning`.

### Archivos a modificar
- `src/App.jsx` — onCloseRequested, estado showCloseWarning, prop onCloningChange
- `src/components/CloneDisk.jsx` — llamar onCloningChange al iniciar/terminar

---

## Orden de implementación recomendado

1. **Fase 0** — `onCloseRequested` en App.jsx + modal de advertencia + prop `onCloningChange`
2. **Agregar features a Cargo.toml** (windows-sys)
3. **Implementar `list_disks` en lib.rs** + registrar comando
4. **Crear CloneDisk.jsx** con UI estática (sin lógica real aún)
5. **Agregar tab "Clonar Disco" en App.jsx**
6. **Conectar `list_disks` al frontend** — mostrar discos reales
7. **Implementar `CloneState` + `start_clone` en lib.rs**
8. **Implementar `cancel_clone` en lib.rs**
9. **Registrar comandos y estado en tauri::Builder**
10. **Conectar frontend: `startClone`, listener de eventos, `cancelClone`**
11. **Pruebas con disco de datos real**

---

## Notas importantes

- El disco del sistema (`is_system: true` o `is_boot: true`) debe estar BLOQUEADO
  en la UI — mostrar advertencia y deshabilitar el botón.
- Si `dest.size < source.size` → bloquear y avisar.
- Los handles de disco requieren que la app corra como **administrador** (ya configurado).
- Los paths `\\.\PhysicalDriveN` en Rust se escriben como strings wide (UTF-16):
  usar `windows_sys::core::w!()` macro o convertir manualmente con `encode_utf16`.
- Emitir progreso no en cada chunk (demasiado frecuente) sino cada ~200ms o cada 50 chunks.
- Al cancelar, el disco destino queda a medio escribir — avisar al usuario que está incompleto.
