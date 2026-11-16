import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ─── Interpreta el exit code de robocopy ────────────────────────────────────

function interpretExitCode(code) {
  if (code < 0)  return { label: "Error al iniciar", color: "text-red-400",     desc: "Robocopy no pudo iniciarse." };
  if (code === 0) return { label: "Sin cambios",      color: "text-gray-400",    desc: "No había nada que copiar." };
  if (code === 1) return { label: "Completado",        color: "text-emerald-400", desc: "Todos los archivos copiados correctamente." };
  if (code === 2) return { label: "Extras",            color: "text-blue-400",    desc: "Archivos extra detectados en destino." };
  if (code === 3) return { label: "Completado",        color: "text-emerald-400", desc: "Archivos copiados. Hay extras en destino." };
  if (code <= 7)  return { label: "Advertencia",       color: "text-yellow-400",  desc: `Código ${code}: copia con advertencias.` };
  return            { label: "Con errores",             color: "text-red-400",     desc: `Código ${code}: algunos archivos no se copiaron.` };
}

// ─── Etiquetas del resumen de robocopy (Windows en inglés y en español) ─────
// EN: "Dirs :", "Files :", "Bytes :", "Times :", "Speed :"
// ES: "Director.:", "Archivos:", "Bytes:", "Tiempo:", "Velocidad:"
const DIRS_LABEL  = String.raw`(?:Dirs|Director(?:\.|ios)?)`;
const FILES_LABEL = String.raw`(?:Files|Archivos)`;
const SUMMARY_LINE_RE = /^\s*(?:Dirs|Director(?:\.|ios)?|Files|Archivos|Bytes|Times|Tiempos?|Speed|Velocidad)\s*:\s*\d/i;
const HEADER_LINE_RE  = /^\s*(?:Started|Source|Dest|Files|Options|Ended|Iniciado|Origen|Destino|Archivos|Opciones|Finalizado)\s*:/i;

// Convierte "0.401" / "0,401" / "1,234.5" / "1.234,5" a número
function parseLocaleNumber(str) {
  const s = str.trim();
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    return lastComma > lastDot
      ? parseFloat(s.replace(/\./g, "").replace(",", "."))
      : parseFloat(s.replace(/,/g, ""));
  }
  return parseFloat(s.replace(",", "."));
}

const toInt = s => parseInt(String(s).replace(/[.,]/g, ""), 10) || 0;

// "1.479 g" / "350.2 m" / "7" → bytes (robocopy usa unidades de 1024)
function parseByteSize(str) {
  const m = String(str).trim().match(/^([\d.,]+)\s*([kmgt])?$/i);
  if (!m) return 0;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[(m[2] || "").toLowerCase()] ?? 1;
  return (m[2] ? parseLocaleNumber(m[1]) : toInt(m[1])) * mult;
}

function formatBytes(b) {
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024)      return `${(b / 1024).toFixed(0)} KB`;
  return `${Math.round(b)} B`;
}

function formatSpeed(bps) {
  return bps > 1e9 ? `${(bps / 1e9).toFixed(2)} GB/s`
       : bps > 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s`
       : bps > 1e3 ? `${(bps / 1e3).toFixed(0)} KB/s`
       : `${bps.toFixed(0)} B/s`;
}

// Línea de error real de robocopy, no la cabecera de columnas ("... ERROR Extras")
// ni rutas que contengan "error". Formatos:
//   "2026/11/16 11:14:06 ERROR 5 (0x00000005) Copiando archivo C:\..."
//   "ERROR : Invalid Parameter #3"  /  "ERROR: RETRY LIMIT EXCEEDED."
function isErrorLine(line) {
  return /\bERROR\s+\d+\s+\(0x[0-9a-f]+\)/i.test(line) || /^\s*(?:[\d/]+\s+[\d:]+\s+)?ERROR\s*:/i.test(line);
}

// ─── Pre-escaneo (progreso total) ────────────────────────────────────────────

// Mismas opciones que la copia real, pero como simulación silenciosa:
// /L no copia nada, /NFL /NDL /NJH dejan solo el resumen, /BYTES da tamaños exactos.
function buildScanFlags(flags) {
  const base = flags.filter(f => !/^\/(L|R:\d+|W:\d+)$/i.test(f));
  return [...base, "/L", "/NFL", "/NDL", "/NJH", "/BYTES", "/R:0", "/W:0"];
}

// Del resumen de la simulación saca la columna "Copiado" de archivos y bytes
function parseScanTotals(text) {
  const fiveCols = String.raw`\s*:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`;
  let files = null, bytes = null;
  for (const line of text.split(/\r?\n/)) {
    const f = line.match(new RegExp(String.raw`^\s*${FILES_LABEL}${fiveCols}`, "i"));
    const b = line.match(/^\s*Bytes\s*:\s+(\S+(?:\s+[kmgt]\b)?)\s+(\S+(?:\s+[kmgt]\b)?)/i);
    if (f) files = toInt(f[2]);
    if (b) bytes = parseByteSize(b[2]);
  }
  return files === null || bytes === null ? null : { files, bytes };
}

// Líneas de archivo que implican una copia real (las EXTRA solo se listan)
const COPY_LINE_RE = /New File|Nuevo arch|\bNewer\b|Más rec|\bOlder\b|Más ant|\bChanged\b|Modificado|Cambiado/i;

function formatDuration(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 60)   return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

// ─── Rutas de Windows ────────────────────────────────────────────────────────

function normWinPath(p) {
  return (p || "").trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function joinWinPath(parent, child) {
  return `${(parent || "").replace(/[\\/]+$/, "")}\\${child}`;
}

// ─── Clasifica líneas del output para colorearlas ───────────────────────────

function classifyLine(line) {
  const t = line.trim();
  if (!t) return "empty";
  if (t.startsWith("---")) return "separator";
  if (/^\s*\d+(?:\.\d+)?%/.test(line)) return "progress";
  if (/New File|Nuevo arch/i.test(line)) return "new";
  if (/\bNewer\b|Más rec/i.test(line)) return "newer";
  if (/\bOlder\b|Más ant/i.test(line)) return "older";
  if (isErrorLine(line)) return "error";
  if (/EXTRA (File|Dir)|(Archivo|Directorio) EXTRA/i.test(line)) return "extra";
  if (SUMMARY_LINE_RE.test(line)) return "summary";
  if (HEADER_LINE_RE.test(line)) return "header";
  if (/ROBOCOPY/i.test(line)) return "title";
  return "normal";
}

const LINE_COLORS = {
  empty:     "",
  separator: "text-gray-700",
  progress:  "text-cyan-400",
  new:       "text-emerald-400",
  newer:     "text-blue-400",
  older:     "text-gray-500",
  error:     "text-red-400 font-semibold",
  extra:     "text-yellow-500",
  summary:   "text-yellow-300 font-mono font-semibold",
  header:    "text-gray-500",
  title:     "text-blue-300 font-bold",
  normal:    "text-gray-300",
};

// ─── Helpers para vista de copia en vivo ────────────────────────────────────

function getFileType(ext) {
  const e = (ext || "").toLowerCase();
  if (e === "pdf")
    return { label: "PDF",   short: "PDF", bg: "bg-red-900/80",    fg: "text-red-300",    bar: "bg-red-500"    };
  if (["mp4","avi","mov","mkv","wmv","flv","webm"].includes(e))
    return { label: "VIDEO", short: "VID", bg: "bg-purple-900/80", fg: "text-purple-300", bar: "bg-purple-500" };
  if (["mp3","wav","flac","aac","ogg","m4a"].includes(e))
    return { label: "AUDIO", short: "AUD", bg: "bg-pink-900/80",   fg: "text-pink-300",   bar: "bg-pink-500"   };
  if (["doc","docx"].includes(e))
    return { label: "WORD",  short: "DOC", bg: "bg-blue-900/80",   fg: "text-blue-300",   bar: "bg-blue-500"   };
  if (["xls","xlsx","csv"].includes(e))
    return { label: "EXCEL", short: "XLS", bg: "bg-green-900/80",  fg: "text-green-300",  bar: "bg-green-500"  };
  if (["ppt","pptx"].includes(e))
    return { label: "PPT",   short: "PPT", bg: "bg-orange-900/80", fg: "text-orange-300", bar: "bg-orange-500" };
  if (["jpg","jpeg","png","gif","bmp","svg","webp","tiff","heic"].includes(e))
    return { label: "IMG",   short: "IMG", bg: "bg-yellow-900/80", fg: "text-yellow-300", bar: "bg-yellow-500" };
  if (["zip","rar","7z","tar","gz","bz2"].includes(e))
    return { label: "ZIP",   short: "ZIP", bg: "bg-gray-700/80",   fg: "text-gray-300",   bar: "bg-gray-500"   };
  if (["exe","msi","bat","cmd"].includes(e))
    return { label: "APP",   short: "APP", bg: "bg-cyan-900/80",   fg: "text-cyan-300",   bar: "bg-cyan-500"   };
  const s = e.slice(0, 3).toUpperCase() || "???";
  return { label: s, short: s, bg: "bg-gray-800/80", fg: "text-gray-400", bar: "bg-gray-500" };
}

function parseFileLine(line) {
  // Formato: "\tNew File \t\t  1.23 m\tfilename.pdf" — el nombre es el último segmento por tab
  const segs = line.split("\t").map(s => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;
  // Con /MT robocopy pone la ruta completa: nos quedamos con el nombre
  const name = segs[segs.length - 1].split(/[\\/]/).pop();
  if (!name || !name.includes(".")) return null;
  if (/^(New File|Newer|Older|EXTRA|ERROR|FAILED|Nuevo archivo|Más reciente|Más antiguo|\*?Archivo EXTRA)$/i.test(name)) return null;
  const ext = name.split(".").pop().toLowerCase();
  // El tamaño es el segmento anterior al nombre ("1.7 m", "2997"). Funciona aunque el nombre tenga espacios.
  const sizeSeg = segs.length >= 3 ? segs[segs.length - 2] : "";
  const size = /^[\d.,]+(?:\s*[kmgt])?$/i.test(sizeSeg) ? sizeSeg : "";
  // label = la etiqueta de robocopy ("Nuevo archivo", "*Archivo EXTRA"…), sin el nombre ni la ruta
  return { name, ext, size, sizeBytes: size ? parseByteSize(size) : 0, label: segs.length >= 3 ? segs[0] : "" };
}

function parseDirLine(line) {
  // Robocopy muestra: "[espacios]Nuevo dir[espacios]N[espacios]LETRA:\ruta\"
  // Los separadores pueden ser espacios o tabs, así que usamos regex en lugar de split.
  const pathMatch = line.match(/([A-Za-z]:[/\\].+[/\\])\s*$/);
  if (!pathMatch) return null;
  const path = pathMatch[1];
  // Descarta líneas de cabecera como "Source : C:\..." o "Dest : D:\..."
  const before = line.slice(0, pathMatch.index);
  if (before.includes(":")) return null;
  // Extrae el número entero justo antes de la ruta (cantidad de elementos en el directorio)
  const numMatch = before.match(/(\d+)\s*$/);
  return { path, count: numMatch ? parseInt(numMatch[1], 10) : null };
}

function getFileDescription(ext) {
  const e = (ext || "").toLowerCase();
  if (e === "pdf")                                                    return "Documento PDF";
  if (["mp4","avi","mov","mkv","wmv","flv","webm"].includes(e))       return `Vídeo ${e.toUpperCase()}`;
  if (["mp3","wav","flac","aac","ogg","m4a"].includes(e))             return `Audio ${e.toUpperCase()}`;
  if (["doc","docx"].includes(e))                                     return "Documento Word";
  if (["xls","xlsx"].includes(e))                                     return "Hoja de cálculo";
  if (["csv"].includes(e))                                            return "Datos CSV";
  if (["ppt","pptx"].includes(e))                                     return "Presentación";
  if (["jpg","jpeg","png","gif","bmp","svg","webp","tiff","heic"].includes(e)) return `Imagen ${e.toUpperCase()}`;
  if (["zip","rar","7z","tar","gz","bz2"].includes(e))                return "Archivo comprimido";
  if (["exe","msi","bat","cmd"].includes(e))                          return "Aplicación / Ejecutable";
  if (["txt","md","log"].includes(e))                                 return "Archivo de texto";
  return ext ? `Archivo ${ext.toUpperCase()}` : "Archivo";
}

// Detecta líneas de robocopy que representan un archivo procesado (EN y ES)
const FILE_LINE_RE = /New File|Nuevo arch|\bNewer\b|Más rec|\bOlder\b|Más ant|EXTRA File|Archivo EXTRA/i;

// ─── Spinner y barra de progreso estilo terminal (para la vista CMD) ────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Octavos de bloque para resolución sub-carácter: ▏▎▍▌▋▊▉
const FRACTION_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function asciiBar(percent, width = 24) {
  const cells = (Math.max(0, Math.min(100, percent || 0)) / 100) * width;
  let full = Math.floor(cells);
  let frac = Math.round((cells - full) * 8);
  if (frac === 8) { full += 1; frac = 0; }
  let bar = "█".repeat(Math.min(full, width));
  if (frac > 0 && full < width) bar += FRACTION_BLOCKS[frac];
  return bar.padEnd(width, "░");
}

function TextSpinner({ className = "" }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <span className={`font-mono ${className}`}>{SPINNER_FRAMES[frame]}</span>;
}

// Tope de líneas retenidas del log para no agotar memoria en copias enormes
const MAX_LOG_LINES = 2000;

// ─── Opciones de robocopy (checkboxes) ───────────────────────────────────────

const ROBOCOPY_OPTIONS = [
  { flag: "/E",   label: "Incluir subcarpetas",    desc: "Copia todos los subdirectorios, incluyendo los vacíos", default: true },
  { flag: "/MIR", label: "Modo espejo",             desc: "Sincroniza destino con origen (borra archivos extra)", default: false, warn: "¡Borra archivos en destino que no existen en origen!" },
  { flag: "/L",   label: "Modo prueba",             desc: "Simula la copia sin mover nada — ideal para revisar antes de ejecutar", default: false, info: true },
  { flag: "/Z",   label: "Modo reiniciable",        desc: "Puede reanudar si se interrumpe (más lento)", default: false },
  { flag: "/B",   label: "Modo backup",             desc: "Copia con privilegios especiales, omite restricciones de permisos", default: false },
  { flag: "/XO",  label: "Excluir más antiguos",    desc: "No sobreescribe archivos más nuevos en destino", default: false },
  { flag: "/MOV", label: "Mover archivos", desc: "Mueve los archivos al destino y los borra del origen después de copiarlos", default: false, warn: "¡Borra los archivos originales después de copiarlos!" },
];

const DEFAULT_OPTIONS = Object.fromEntries(ROBOCOPY_OPTIONS.map(o => [o.flag, o.default]));

// ─── TagInput: escribe un valor y Enter para agregar, × para eliminar ────────

function TagInput({ tags, onChange, placeholder }) {
  const [input, setInput] = useState("");

  function add(val) {
    const v = val.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setInput("");
  }

  function handleKey(e) {
    if (e.key === "Enter") { e.preventDefault(); add(input); }
    if (e.key === "Backspace" && !input && tags.length > 0) onChange(tags.slice(0, -1));
  }

  return (
    <div className="flex flex-wrap gap-1 p-2 bg-gray-800 border border-gray-700 rounded-lg min-h-[36px] focus-within:border-blue-500 transition-colors">
      {tags.map(tag => (
        <span key={tag} className="flex items-center gap-1 px-2 py-0.5 bg-gray-700 rounded text-xs text-gray-200">
          {tag}
          <button onClick={() => onChange(tags.filter(t => t !== tag))} className="text-gray-500 hover:text-red-400 leading-none">×</button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => input && add(input)}
        placeholder={tags.length === 0 ? placeholder : ""}
        className="selectable flex-1 min-w-[80px] bg-transparent text-xs text-gray-200 placeholder-gray-600 focus:outline-none"
      />
    </div>
  );
}

// ─── Tarjeta de resumen post-copia ───────────────────────────────────────────

function SummaryCard({ summary, exitCode }) {
  const result = interpretExitCode(exitCode);

  return (
    <div className={`mx-4 mt-4 p-4 rounded-xl border ${exitCode >= 8 ? "border-red-800 bg-red-950/30" : "border-emerald-800 bg-emerald-950/20"}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className={`font-semibold text-sm ${result.color}`}>{result.label}</h3>
        <span className="text-xs text-gray-600">Código de salida: {exitCode}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs sm:grid-cols-4">
        {summary.files && (
          <>
            <Stat label="Archivos copiados" value={summary.files.copied} color="text-emerald-400" />
            <Stat label="Archivos totales"  value={summary.files.total}  color="text-gray-300" />
            <Stat label="Omitidos"          value={summary.files.skipped} color="text-gray-500" />
            <Stat label="Fallidos"          value={summary.files.failed}  color={summary.files.failed > 0 ? "text-red-400" : "text-gray-500"} />
          </>
        )}
        {summary.dirs && (
          <>
            <Stat label="Carpetas copiadas" value={summary.dirs.copied}  color="text-blue-400" />
            <Stat label="Carpetas totales"  value={summary.dirs.total}   color="text-gray-300" />
          </>
        )}
        {summary.bytes && (
          <Stat label="Datos copiados" value={formatBytes(summary.bytes.copied)} color="text-cyan-400" />
        )}
        {summary.speed && (
          <Stat label="Velocidad" value={summary.speed} color="text-yellow-400" />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <p className="text-gray-600">{label}</p>
      <p className={`font-mono font-semibold ${color}`}>{value}</p>
    </div>
  );
}

// ─── Captura de líneas de error ─────────────────────────────────────────────
// Robocopy puede emitir el path en la misma línea ERROR o en la línea siguiente.
// Esta función acumula el contexto necesario en pendingErrRef y agrega entradas
// a errorFiles solo cuando tiene el mensaje completo.
function trackErrorLine(line, pendingErrRef, setErrorFiles) {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (isErrorLine(trimmed)) {
    // Si el path ya está en esta línea (p.ej. "ERROR 5 ... Copying File C:\ruta\archivo")
    if (/[A-Za-z]:[\\\/]|^\\\\\S/.test(trimmed)) {
      setErrorFiles(prev => [...prev, trimmed]);
      pendingErrRef.current = null;
    } else {
      // El path puede estar en la línea siguiente
      pendingErrRef.current = trimmed;
    }
  } else if (pendingErrRef.current) {
    // Esta es la línea con el path (o el mensaje de error del SO)
    const combined = `${pendingErrRef.current}  —  ${trimmed}`;
    setErrorFiles(prev => [...prev, combined]);
    pendingErrRef.current = null;
  }
}

// ─── Componente principal ────────────────────────────────────────────────────

export default function RobocopyPanel({ source, dest, sourceFiles = [], sourceFolders = [], onSourceChange, onDestChange, onGoToExplorer, loadedJob, onJobSaved, onStatusChange }) {
  const [options, setOptions]           = useState({ ...DEFAULT_OPTIONS });
  const [retries, setRetries]           = useState("3");
  const [waitTime, setWaitTime]         = useState("5");
  const [mtEnabled, setMtEnabled]       = useState(false);
  const [mtThreads, setMtThreads]       = useState("8");
  const [excludeFiles, setExcludeFiles] = useState([]);
  const [excludeDirs, setExcludeDirs]   = useState([]);
  const [fileFilter, setFileFilter]     = useState([]);
  const [maxAge, setMaxAge]           = useState("");
  const [outputLines, setOutputLines]   = useState([]);
  const [running, setRunning]           = useState(false);
  const [exitCode, setExitCode]         = useState(null);
  const [summary, setSummary]           = useState(null);
  const [saveMode, setSaveMode]         = useState(false);
  const [saveName, setSaveName]         = useState("");
  const [fileCount, setFileCount]       = useState(0);
  const [multiFolderIdx, setMultiFolderIdx]     = useState(0);
  const [multiFolderCodes, setMultiFolderCodes] = useState([]);
  const [showOptions, setShowOptions]           = useState(true);
  const [liveFile, setLiveFile]           = useState(null);  // { name, ext, size, percent }
  const [recentFiles, setRecentFiles]     = useState([]);    // archivos recién copiados
  const [showRawLog, setShowRawLog]       = useState(false);
  const [currentDirInfo, setCurrentDirInfo] = useState(null); // { path, count, processed }
  const [cancelling, setCancelling]       = useState(false);
  const [nudgeFeedback, setNudgeFeedback] = useState(false); // feedback visual tras "desbloquear"
  const [errorFiles, setErrorFiles]       = useState([]);
  const [showErrors, setShowErrors]       = useState(false);
  const [includeParent, setIncludeParent] = useState(true); // crea la carpeta origen dentro del destino
  // Progreso total: totals = lo que se va a copiar (pre-escaneo), overall = lo copiado hasta ahora
  const [scanning, setScanning] = useState(false);
  const [totals, setTotals]     = useState(null); // { files, bytes }
  const [overall, setOverall]   = useState(null); // { files, bytes }
  const [, setTick]             = useState(0);    // refresca el tiempo restante cada segundo
  const progRef      = useRef({ doneBytes: 0, doneFiles: 0, curSize: 0, curPct: 0, active: false, start: 0 });
  const cancelReqRef = useRef(false);

  // Nombre de la carpeta origen (null si es raíz de unidad, p. ej. "E:\")
  const sourceFolderName = (() => {
    const clean = (source || "").trim().replace(/[\\/]+$/, "");
    if (!clean || /^[a-zA-Z]:$/.test(clean)) return null;
    const name = clean.split(/[\\/]/).pop();
    return name || null;
  })();
  // Solo aplica en modo carpeta única (desde el Explorador ya se copia la carpeta en sí)
  const canIncludeParent = !!sourceFolderName && sourceFolders.length === 0 && sourceFiles.length === 0;
  const applyParent      = canIncludeParent && includeParent;
  const effectiveDest    = applyParent && dest
    ? `${dest.replace(/[\\/]+$/, "")}\\${sourceFolderName}`
    : dest;

  // Evita copiar una carpeta sobre sí misma o dentro de sí misma (con subcarpetas
  // robocopy vuelve a copiar lo que acaba de copiar y entra en bucle).
  const pathError = (() => {
    if (!source || !dest) return null;
    const recursive = options["/E"] || options["/S"] || options["/MIR"];
    const pairs = sourceFolders.length > 0
      ? sourceFolders.map(f => [joinWinPath(source, f), joinWinPath(dest, f)])
      : [[source, effectiveDest]];
    for (const [src, dst] of pairs) {
      const s = normWinPath(src), d = normWinPath(dst);
      if (s === d) return "El origen y el destino son la misma carpeta.";
      if (recursive && d.startsWith(s + "\\"))
        return `El destino está dentro del origen (${dst}). Con subcarpetas activadas robocopy entraría en bucle.`;
    }
    return null;
  })();

  const outputRef      = useRef(null);
  const unlistenRef    = useRef([]);
  const lastWasCrRef   = useRef(false);
  const currentDirRef  = useRef(""); // directorio actual que está procesando robocopy
  const pendingErrRef  = useRef(null); // acumula línea ERROR si el path viene en la línea siguiente

  // Cuando el explorador manda archivos seleccionados, pre-rellena el filtro /IF
  useEffect(() => {
    if (sourceFiles.length > 0) setFileFilter(sourceFiles);
  }, [sourceFiles]);

  // Carga un trabajo guardado desde el historial
  useEffect(() => {
    if (!loadedJob) return;
    const cfg = loadedJob.config || {};
    onSourceChange(loadedJob.source);
    onDestChange(loadedJob.destination);
    setOptions(cfg.options ?? { ...DEFAULT_OPTIONS });
    setRetries(cfg.retries ?? "3");
    setWaitTime(cfg.waitTime ?? "5");
    setMtEnabled(cfg.mtEnabled ?? false);
    setMtThreads(cfg.mtThreads ?? "8");
    setExcludeFiles(cfg.excludeFiles ?? []);
    setExcludeDirs(cfg.excludeDirs ?? []);
    setFileFilter(cfg.fileFilter ?? []);
    setMaxAge(cfg.maxAge ?? "");
    setIncludeParent(cfg.includeParent ?? false); // trabajos viejos: copiaban solo el contenido
    setOutputLines([]);
    setExitCode(null);
    setSummary(null);
  }, [loadedJob]);

  // Auto-scroll al final del output
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [outputLines]);

  // Reporta estado de copia al componente padre (para la barra en segundo plano)
  useEffect(() => {
    const ft = liveFile ? getFileType(liveFile.ext) : null;
    onStatusChange?.({ running, liveFile, ft, fileCount });
  }, [running, liveFile, fileCount]);

  // Mientras copia, re-renderiza cada segundo para que velocidad/tiempo restante no se congelen
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // ── Contabilidad del progreso total ──
  function pushOverall() {
    const p = progRef.current;
    setOverall({
      bytes: p.doneBytes + (p.active ? p.curSize * p.curPct / 100 : 0),
      files: p.doneFiles + (p.active ? 1 : 0),
    });
  }
  // Empieza un archivo nuevo: el anterior se da por terminado
  function progFileStart(line, parsed) {
    // Se mira solo la etiqueta: un archivo llamado "extras.zip" sí se copia
    const label = parsed?.label || "";
    if (!COPY_LINE_RE.test(label) || /EXTRA/i.test(label)) return;
    const p = progRef.current;
    if (p.active) { p.doneBytes += p.curSize; p.doneFiles += 1; }
    p.active = true; p.curSize = parsed?.sizeBytes || 0; p.curPct = 0;
    pushOverall();
  }
  function progPercent(pct) {
    const p = progRef.current;
    if (!p.active) return;
    p.curPct = pct;
    pushOverall();
  }
  function progFlush() {
    const p = progRef.current;
    if (p.active) { p.doneBytes += p.curSize; p.doneFiles += 1; p.active = false; }
    pushOverall();
  }

  // Limpia listeners al desmontar
  useEffect(() => () => unlistenRef.current.forEach(fn => fn()), []);

  function toggleOption(flag) {
    setOptions(prev => ({ ...prev, [flag]: !prev[flag] }));
  }

  // Parsea líneas de resumen estadístico del output de robocopy
  function parseSummaryLine(line) {
    const fiveCols   = String.raw`\s*:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)`;
    const dirsMatch  = line.match(new RegExp(String.raw`^\s*${DIRS_LABEL}${fiveCols}`, "i"));
    const filesMatch = line.match(new RegExp(String.raw`^\s*${FILES_LABEL}${fiveCols}`, "i"));
    const bytesMatch = line.match(/^\s*Bytes\s*:\s+(\S+(?:\s+[kmgt]\b)?)\s+(\S+(?:\s+[kmgt]\b)?)/i);
    // Se usa la línea en MB/min: el valor en Bytes/s cambia de separadores según el idioma
    // ("7,000 Bytes/s" en español son 7000). MB de robocopy = 1 048 576 bytes.
    const mbMinMatch = line.match(/(?:Speed|Velocidad)\s*:\s*([\d.,]+)\s*MegaBytes\/min/i);

    // Los valores se SUMAN: en modo multi-carpeta robocopy imprime un resumen por carpeta.
    // (summary arranca en null en cada corrida, así que en modo simple la suma es el valor tal cual)
    const counts = m => ({ total: toInt(m[1]), copied: toInt(m[2]), skipped: toInt(m[3]), failed: toInt(m[5]) });
    const addCounts = (a, b) => a
      ? { total: a.total + b.total, copied: a.copied + b.copied, skipped: a.skipped + b.skipped, failed: a.failed + b.failed }
      : b;

    if (dirsMatch)  setSummary(p => ({ ...p, dirs:  addCounts(p?.dirs,  counts(dirsMatch)) }));
    if (filesMatch) setSummary(p => ({ ...p, files: addCounts(p?.files, counts(filesMatch)) }));
    if (bytesMatch) {
      const total = parseByteSize(bytesMatch[1]), copied = parseByteSize(bytesMatch[2]);
      setSummary(p => ({
        ...p,
        bytes: { total: (p?.bytes?.total ?? 0) + total, copied: (p?.bytes?.copied ?? 0) + copied },
        lastCopied: copied, // para ponderar la velocidad de esta carpeta
      }));
    }
    if (mbMinMatch) {
      const bps = parseLocaleNumber(mbMinMatch[1]) * 1048576 / 60;
      if (!isNaN(bps) && bps > 0) {
        setSummary(p => {
          // Velocidad global = bytes copiados totales / tiempo de copia total
          const secs     = (p?.copySecs ?? 0) + (p?.lastCopied ?? 0) / bps;
          const copied   = p?.bytes?.copied ?? 0;
          const overall  = secs > 0 && copied > 0 ? copied / secs : bps;
          return { ...p, copySecs: secs, speed: formatSpeed(overall) };
        });
      }
    }
  }

  function buildFlags() {
    const flags = Object.entries(options)
      .filter(([, on]) => on)
      .map(([flag]) => flag);
    if (mtEnabled) { const t = parseInt(mtThreads, 10); if (!isNaN(t) && t > 0) flags.push(`/MT:${t}`); }
    const r = parseInt(retries, 10);
    const w = parseInt(waitTime, 10);
    if (!isNaN(r) && r >= 0) flags.push(`/R:${r}`);
    if (!isNaN(w) && w >= 0) flags.push(`/W:${w}`);
    const a = parseInt(maxAge, 10);
    if (!isNaN(a) && a >= 0) flags.push(`/MAXAGE:${a}`);
    if (excludeFiles.length > 0) flags.push("/XF", ...excludeFiles);
    if (excludeDirs.length  > 0) flags.push("/XD", ...excludeDirs);
    if (fileFilter.length   > 0 && sourceFolders.length === 0) flags.push("/IF", ...fileFilter);
    return flags;
  }

  async function sendDoneNotification(code) {
    try {
      let granted = await isPermissionGranted();
      if (!granted) { const req = await requestPermission(); granted = req === "granted"; }
      if (granted) {
        const res = interpretExitCode(code);
        sendNotification({ title: "RoboCopy GUI", body: `${res.label} — ${res.desc}` });
      }
    } catch (_) {}
  }

  async function startRobocopy() {
    if (!source || !dest || pathError) return;
    setRunning(true);
    setExitCode(null);
    setSummary(null);
    setOutputLines([]);
    setFileCount(0);
    setMultiFolderIdx(0);
    setMultiFolderCodes([]);
    setShowOptions(false);

    unlistenRef.current.forEach(fn => fn());
    unlistenRef.current = [];
    lastWasCrRef.current = false;
    pendingErrRef.current = null;
    setLiveFile(null);
    setRecentFiles([]);
    setShowRawLog(false);
    setCurrentDirInfo(null);
    setCancelling(false);
    setErrorFiles([]);
    setShowErrors(false);
    currentDirRef.current = "";

    const flags = buildFlags();
    const multi = sourceFolders.length > 0;

    // ── Pre-escaneo: cuánto hay que copiar (para progreso total y tiempo restante) ──
    cancelReqRef.current = false;
    progRef.current = { doneBytes: 0, doneFiles: 0, curSize: 0, curPct: 0, active: false, start: 0 };
    setTotals(null);
    setOverall(null);
    await invoke("reset_cancel").catch(() => {});

    if (!isDryRun) {
      setScanning(true);
      const pairs = multi
        ? sourceFolders.map(f => [joinWinPath(source, f), joinWinPath(dest, f)])
        : [[source, effectiveDest]];
      let sum = { files: 0, bytes: 0 };
      let scanErr = null;
      try {
        for (const [s, d] of pairs) {
          if (cancelReqRef.current) break;
          const out = await invoke("scan_robocopy", { source: s, destination: d, flags: buildScanFlags(flags) });
          const t = parseScanTotals(out);
          if (!t) { sum = null; scanErr = "no se encontró el resumen en la salida"; break; }
          sum.files += t.files;
          sum.bytes += t.bytes;
        }
      } catch (e) {
        sum = null;
        scanErr = String(e);
      }
      // Si falla, la copia sigue igual, solo que sin progreso total
      if (scanErr && !cancelReqRef.current) {
        setOutputLines([`(No se pudo calcular el total, se copia sin barra de progreso total: ${scanErr})`]);
      }
      setScanning(false);
      if (cancelReqRef.current) {
        setRunning(false);
        setCancelling(false);
        setOutputLines(["Cancelado mientras se calculaba el tamaño total. No se copió nada."]);
        return;
      }
      if (sum) setTotals(sum);
    }
    progRef.current.start = Date.now();

    // Agrega una línea al log (reemplazando la anterior si venía de un \r)
    // y descarta las más viejas al superar el tope.
    const appendOutput = (line, wasCr) => {
      setOutputLines(prev => {
        const next = wasCr && prev.length > 0 ? [...prev.slice(0, -1), line] : [...prev, line];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    };

    const handleOutput = (line) => {
      const wasCr = lastWasCrRef.current;
      lastWasCrRef.current = false;
      appendOutput(line, wasCr);
      parseSummaryLine(line);
      // Capturar líneas de error (con soporte para path en línea siguiente)
      trackErrorLine(line, pendingErrRef, setErrorFiles);
      // Detectar directorio actual
      const dirInfo = parseDirLine(line);
      if (dirInfo) { currentDirRef.current = dirInfo.path; setCurrentDirInfo({ ...dirInfo, processed: 0 }); }
      if (FILE_LINE_RE.test(line)) {
        setFileCount(p => p + 1);
        setCurrentDirInfo(prev => prev ? { ...prev, processed: prev.processed + 1 } : prev);
        const parsed = parseFileLine(line);
        if (parsed?.name) {
          const pctOnLine = line.trim().match(/^(\d+(?:\.\d+)?)%/);
          const pct = pctOnLine ? parseFloat(pctOnLine[1]) : 0;
          progFileStart(line, parsed);
          if (pct) progPercent(pct);
          setLiveFile({ ...parsed, dir: currentDirRef.current, percent: pct });
          setRecentFiles(prev => [{ ...parsed, dir: currentDirRef.current }, ...prev].slice(0, 10));
        }
      }
    };

    const handleCrOutput = (line) => {
      const wasCr = lastWasCrRef.current;
      lastWasCrRef.current = true;
      appendOutput(line, wasCr);
      const pctMatch = line.trim().match(/^(\d+(?:\.\d+)?)%/);
      if (pctMatch) {
        const pct = parseFloat(pctMatch[1]);
        progPercent(pct);
        setLiveFile(prev => prev ? { ...prev, percent: pct } : { name: "", ext: "", size: "", dir: currentDirRef.current, percent: pct });
      } else {
        const parsed = parseFileLine(line);
        if (parsed?.name) {
          if (FILE_LINE_RE.test(line)) {
            setFileCount(p => p + 1);
            setCurrentDirInfo(prev => prev ? { ...prev, processed: prev.processed + 1 } : prev);
            setRecentFiles(prev => [{ ...parsed, dir: currentDirRef.current }, ...prev].slice(0, 10));
            progFileStart(line, parsed);
          }
          setLiveFile({ ...parsed, dir: currentDirRef.current, percent: 0 });
        }
      }
    };

    const finishRun = async (code) => {
      progFlush();
      setExitCode(code);
      setRunning(false);
      setLiveFile(null);
      setCurrentDirInfo(null);
      setCancelling(false);
      if (code >= 8) setShowErrors(true);
      unlistenRef.current.forEach(fn => fn());
      unlistenRef.current = [];
      await sendDoneNotification(code);
    };

    const handleInvokeError = (e) => {
      setOutputLines(prev => [...prev, `ERROR: ${e}`]);
      setRunning(false);
      unlistenRef.current.forEach(fn => fn());
      unlistenRef.current = [];
    };

    const ul1  = await listen("robocopy-output", event => handleOutput(event.payload));
    const ulCr = await listen("robocopy-output-cr", event => handleCrOutput(event.payload));
    unlistenRef.current = [ul1, ulCr];

    // ── Modo multi-carpeta ──────────────────────────────────────────────────
    if (sourceFolders.length > 0) {
      const ul2 = await listen("robocopy-folder-start", event => {
        const name = event.payload;
        lastWasCrRef.current = false;
        currentDirRef.current = "";
        setCurrentDirInfo(null);
        setOutputLines(prev => [...prev, "", `${"═".repeat(20)} ${name} ${"═".repeat(20)}`]);
        setMultiFolderIdx(prev => prev + 1);
        setFileCount(0);
        setLiveFile(null);
        setRecentFiles([]);
      });

      const ul3 = await listen("robocopy-folder-done", event => {
        progFlush();
        setMultiFolderCodes(prev => [...prev, event.payload]);
      });

      const ul4 = await listen("robocopy-all-done", async event => {
        const codes = event.payload;
        await finishRun(codes.length > 0 ? Math.max(...codes) : -1);
      });

      unlistenRef.current.push(ul2, ul3, ul4);

      try {
        await invoke("run_robocopy_multi", {
          parentSource: source,
          parentDest: dest,
          folders: sourceFolders,
          flags,
        });
      } catch (e) {
        handleInvokeError(e);
      }
      return;
    }

    // ── Modo carpeta única ───────────────────────────────────────────────────
    const ul2 = await listen("robocopy-done", event => finishRun(event.payload));
    unlistenRef.current.push(ul2);

    try {
      await invoke("run_robocopy", { source, destination: effectiveDest, flags });
    } catch (e) {
      handleInvokeError(e);
    }
  }

  // Limpia todo lo que quedó en pantalla de la corrida anterior
  function clearResults() {
    setOutputLines([]);
    setExitCode(null);
    setSummary(null);
    setTotals(null);
    setOverall(null);
    setRecentFiles([]);
    setLiveFile(null);
    setErrorFiles([]);
    setShowErrors(false);
    setFileCount(0);
    setMultiFolderIdx(0);
    setMultiFolderCodes([]);
    setCurrentDirInfo(null);
    setShowRawLog(false);
  }

  async function handleSaveJob() {
    if (!saveName.trim()) return;
    const id = `job_${Date.now()}`;
    await invoke("save_job", {
      job: {
        id,
        name: saveName.trim(),
        source,
        destination: dest,
        config: { options, retries, waitTime, mtEnabled, mtThreads, excludeFiles, excludeDirs, fileFilter, maxAge, includeParent },
        created_at: Math.floor(Date.now() / 1000),
      },
    });
    setSaveMode(false);
    setSaveName("");
    onJobSaved?.();
  }

  const canRun  = !!(source && dest && !running && !pathError);

  // Progreso total (solo si el pre-escaneo dio resultado)
  const progress = (() => {
    if (!running || scanning || !totals || (totals.bytes <= 0 && totals.files <= 0)) return null;
    const done = overall ?? { bytes: 0, files: 0 };
    const frac = totals.bytes > 0 ? done.bytes / totals.bytes : done.files / totals.files;
    const pct  = Math.max(0, Math.min(100, frac * 100));
    const elapsed = progRef.current.start ? (Date.now() - progRef.current.start) / 1000 : 0;
    const speed   = elapsed >= 2 && done.bytes > 0 ? done.bytes / elapsed : null;
    // Tiempo restante: se muestra recién a los 3 s para que la estimación no salte
    const eta = speed && elapsed >= 3 && totals.bytes > 0 ? Math.max(0, totals.bytes - done.bytes) / speed : null;
    return { pct, speed, eta };
  })();
  const result  = exitCode !== null ? interpretExitCode(exitCode) : null;
  const isDryRun = options["/L"];

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100 overflow-y-auto">

      {/* ── Rutas ──────────────────────────────────────────────────────────── */}
      <div className="p-4 bg-gray-900 border-b border-gray-800 shrink-0 space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <PathField label="Carpeta Origen"  value={source} onChange={onSourceChange}
            color="emerald" placeholder="C:\ruta\de\origen"  onBrowse={onGoToExplorer} />
          <PathField label="Carpeta Destino" value={dest}   onChange={onDestChange}
            color="purple"  placeholder="D:\ruta\de\destino" onBrowse={onGoToExplorer} />
        </div>

        {/* Copiar la carpeta en sí o solo su contenido */}
        {canIncludeParent && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-gray-800/50 border border-gray-700/60 rounded-lg">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={includeParent} onChange={e => setIncludeParent(e.target.checked)}
                className="accent-emerald-500" />
              Crear carpeta <span className="font-mono text-emerald-400">"{sourceFolderName}"</span> en destino
            </label>
            <span className="text-xs text-gray-500 truncate min-w-0 flex-1" title={effectiveDest || ""}>
              {dest
                ? <>Se copiará en: <span className="font-mono text-purple-400">{effectiveDest}</span></>
                : includeParent ? "Se copia la carpeta completa" : "Se copia solo su contenido"}
            </span>
          </div>
        )}

        {pathError && (
          <div className="px-3 py-2 bg-red-950/40 border border-red-800/60 rounded-lg text-xs text-red-300">
            ⚠ {pathError}
          </div>
        )}

        {/* Badge de carpetas seleccionadas para copia múltiple */}
        {sourceFolders.length > 0 && (
          <div className="flex items-start gap-2 px-3 py-2 bg-emerald-950/40 border border-emerald-800/50 rounded-lg">
            <span className="text-xs text-emerald-400 font-medium shrink-0 mt-0.5">
              {sourceFolders.length} carpeta{sourceFolders.length !== 1 ? "s" : ""} a copiar:
            </span>
            <div className="flex flex-wrap gap-1 flex-1">
              {sourceFolders.map(f => (
                <span key={f} className="px-2 py-0.5 bg-emerald-900/60 border border-emerald-700/50 rounded text-xs text-emerald-300 font-mono">
                  {f}
                </span>
              ))}
            </div>
            <button
              onClick={() => onSourceChange(source)}
              className="text-xs text-emerald-700 hover:text-emerald-500 transition-colors shrink-0"
              title="Limpiar selección de carpetas"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* ── Cabecera colapsable de opciones ─────────────────────────────────── */}
      <div
        onClick={() => setShowOptions(p => !p)}
        className="flex items-center gap-3 px-4 py-2 bg-gray-900/80 border-b border-gray-800 shrink-0 cursor-pointer hover:bg-gray-900 transition-colors select-none"
      >
        <span className="text-xs text-gray-500 uppercase tracking-wider">Opciones</span>

        {/* Resumen compacto cuando está cerrado */}
        {!showOptions && (
          <div className="flex items-center gap-1.5 flex-1 flex-wrap">
            {Object.entries(options).filter(([, v]) => v).map(([flag]) => (
              <span key={flag} className="px-1.5 py-0.5 bg-blue-950/60 border border-blue-800/50 rounded text-xs text-blue-400 font-mono">{flag}</span>
            ))}
            {mtEnabled && <span className="px-1.5 py-0.5 bg-gray-800 rounded text-xs text-gray-400 font-mono">/MT:{mtThreads}</span>}
            <span className="px-1.5 py-0.5 bg-gray-800 rounded text-xs text-gray-400 font-mono">/R:{retries} /W:{waitTime}</span>
            {maxAge && <span className="px-1.5 py-0.5 bg-gray-800 rounded text-xs text-gray-400 font-mono">/MAXAGE:{maxAge}</span>}
            {excludeFiles.length > 0 && <span className="text-xs text-gray-600">/XF ({excludeFiles.length})</span>}
            {excludeDirs.length  > 0 && <span className="text-xs text-gray-600">/XD ({excludeDirs.length})</span>}
            {fileFilter.length   > 0 && <span className="text-xs text-gray-600">/IF ({fileFilter.length})</span>}
          </div>
        )}

        <svg
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`w-4 h-4 text-gray-600 ml-auto shrink-0 transition-transform duration-200 ${showOptions ? "" : "-rotate-90"}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* ── Opciones: checkboxes ────────────────────────────────────────────── */}
      {showOptions && <div className="px-4 pt-3 pb-2 bg-gray-900/60 border-b border-gray-800 shrink-0">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Modo de copia</p>
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
          {ROBOCOPY_OPTIONS.map(opt => (
            <label key={opt.flag}
              className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer border transition-colors
                ${options[opt.flag]
                  ? opt.warn  ? "bg-yellow-950/50 border-yellow-700"
                  : opt.info  ? "bg-sky-950/50 border-sky-700"
                  :             "bg-blue-950/50 border-blue-700"
                  : "bg-gray-900 border-gray-800 hover:border-gray-700"}`}
            >
              <input type="checkbox" checked={!!options[opt.flag]}
                onChange={() => toggleOption(opt.flag)} className="mt-0.5 accent-blue-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-200 leading-tight">{opt.label}</p>
                <p className="text-xs text-gray-600">{opt.flag}</p>
                {opt.warn && options[opt.flag] && <p className="text-xs text-yellow-500 mt-0.5">⚠ {opt.warn}</p>}
              </div>
            </label>
          ))}
        </div>
      </div>}

      {/* ── Opciones: campos numéricos y exclusiones ─────────────────────────── */}
      {showOptions && <div className="px-4 py-3 bg-gray-900/40 border-b border-gray-800 shrink-0">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">

          {/* Reintentos */}
          <NumericField label="Reintentos" flag="/R:n"
            value={retries} onChange={setRetries}
            desc="veces antes de saltar" />

          {/* Espera */}
          <NumericField label="Espera entre reintentos" flag="/W:n"
            value={waitTime} onChange={setWaitTime}
            desc="segundos entre intentos" />

          <NumericField label="Edad máxima de archivos" flag="/MAXAGE:n"
            value={maxAge} onChange={setMaxAge}
            desc="días desde la última modificación" />

          {/* Multi-hilo */}
          <div>
            <label className="flex items-center gap-2 mb-1.5 cursor-pointer">
              <input type="checkbox" checked={mtEnabled} onChange={e => setMtEnabled(e.target.checked)} className="accent-blue-500" />
              <span className="text-xs text-gray-400 uppercase tracking-wider">Multi-hilo</span>
              <span className="text-xs text-gray-600">/MT:n</span>
            </label>
            <input type="number" min="1" max="128" value={mtThreads}
              onChange={e => setMtThreads(e.target.value)} disabled={!mtEnabled}
              className="selectable w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm
                text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-40" />
            <p className="text-xs text-gray-600 mt-1">hilos en paralelo</p>
          </div>

          {/* Filtro de archivos */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1.5">
              Solo copiar <span className="text-gray-600 normal-case">/IF</span>
            </p>
            <TagInput tags={fileFilter} onChange={setFileFilter} placeholder="*.jpg *.png ..." />
            <p className="text-xs text-gray-600 mt-1">Enter para agregar, × para quitar</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-3">
          {/* Excluir archivos */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1.5">
              Excluir archivos <span className="text-gray-600 normal-case">/XF</span>
            </p>
            <TagInput tags={excludeFiles} onChange={setExcludeFiles} placeholder="*.tmp *.log ..." />
          </div>

          {/* Excluir carpetas */}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1.5">
              Excluir carpetas <span className="text-gray-600 normal-case">/XD</span>
            </p>
            <TagInput tags={excludeDirs} onChange={setExcludeDirs} placeholder="node_modules .git ..." />
          </div>
        </div>
      </div>}

      {/* ── Botón de inicio + guardar trabajo ───────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-900 border-b border-gray-800 shrink-0">
        {running ? (
          <div className="flex items-center gap-2">
            {/* Botón cancelar */}
            {cancelling ? (
              <div className="flex items-center gap-2 px-5 py-2 bg-red-900/60 rounded-lg text-sm font-semibold text-red-300 cursor-default select-none">
                <svg className="w-3.5 h-3.5 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
                </svg>
                estoy deteniendo, bancame...
              </div>
            ) : (
              <button
                onClick={() => { cancelReqRef.current = true; setCancelling(true); invoke("cancel_robocopy").catch(() => setCancelling(false)); }}
                className="flex items-center gap-2 px-5 py-2 bg-red-800 hover:bg-red-700 active:bg-red-900 rounded-lg text-sm font-semibold text-red-200 transition-colors"
              >
                <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                {isDryRun ? "Simulando..." : "Copiando..."}
                <span className="ml-1 text-red-400 text-xs border border-red-700 rounded px-1.5 py-0.5">✕ Cancelar</span>
              </button>
            )}

            {/* Botón desbloquear — solo cuando no está cancelando */}
            {!cancelling && !isDryRun && (
              <button
                onClick={() => {
                  invoke("nudge_robocopy").catch(() => {});
                  setNudgeFeedback(true);
                  setTimeout(() => setNudgeFeedback(false), 2000);
                }}
                title="Envía una señal al proceso para desbloquearlo si se quedó atascado (equivalente a Ctrl+C en CMD)"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all duration-200
                  ${nudgeFeedback
                    ? "bg-amber-900/50 border-amber-700 text-amber-300"
                    : "bg-gray-800 hover:bg-amber-900/40 border-gray-700 hover:border-amber-700 text-gray-400 hover:text-amber-300"}`}
              >
                {nudgeFeedback ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5 shrink-0">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Listo, ya envie el coso
                  </>
                ) : (
                  <>
                    {/* Icono "onda/señal" */}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 shrink-0">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                    Desbloquear
                  </>
                )}
              </button>
            )}
          </div>
        ) : (
          <button onClick={startRobocopy} disabled={!canRun}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-colors
              ${isDryRun ? "bg-sky-700 hover:bg-sky-600" : "bg-blue-600 hover:bg-blue-500"}
              disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed`}>
            {isDryRun
            ? "🔍 Simular (sin copiar)"
            : sourceFolders.length > 0
              ? `Copiar ${sourceFolders.length} carpeta(s)`
              : "Iniciar"}
          </button>
        )}

        {result && !running && (
          <span className={`text-sm font-medium ${result.color}`}>{result.label} — {result.desc}</span>
        )}

        {/* Guardar trabajo */}
        <div className="ml-auto flex items-center gap-2">
          {saveMode ? (
            <>
              <input value={saveName} onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSaveJob()}
                placeholder="Nombre del trabajo..." autoFocus
                className="selectable bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm
                  text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 w-48" />
              <button onClick={handleSaveJob} disabled={!saveName.trim()}
                className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-sm disabled:opacity-40">
                Guardar
              </button>
              <button onClick={() => { setSaveMode(false); setSaveName(""); }}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-400">
                Cancelar
              </button>
            </>
          ) : (
            <button onClick={() => setSaveMode(true)} disabled={!source || !dest}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-400 disabled:opacity-30 transition-colors">
              💾 Guardar trabajo
            </button>
          )}
          <button onClick={clearResults}
            disabled={running || (outputLines.length === 0 && recentFiles.length === 0 && errorFiles.length === 0 && exitCode === null)}
            className="text-xs text-gray-600 hover:text-gray-400 disabled:opacity-30 transition-colors px-2">
            Limpiar
          </button>
        </div>
      </div>

      {/* ── Barra de progreso ────────────────────────────────────────────────── */}
      {(running || exitCode !== null) && (
        <div className="px-4 py-2.5 bg-gray-900/80 border-b border-gray-800 shrink-0">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="text-xs text-gray-400 truncate">
              {scanning
                ? "Calculando cuánto hay que copiar…"
                : running
                ? sourceFolders.length > 0
                  ? `Carpeta ${multiFolderIdx} de ${sourceFolders.length}: "${sourceFolders[multiFolderIdx - 1] ?? ""}" — ${fileCount} archivos`
                  : `${isDryRun ? "Simulando" : "Copiando"}... ${fileCount > 0 ? `${fileCount} archivo${fileCount !== 1 ? "s" : ""} procesado${fileCount !== 1 ? "s" : ""}` : "iniciando"}`
                : sourceFolders.length > 0
                  ? `${sourceFolders.length} carpetas — ${multiFolderCodes.filter(c => c >= 8).length === 0 ? "completado" : "con errores"}`
                  : result?.desc}
            </span>
            {progress && (
              <span className="text-xs text-gray-400 font-mono tabular-nums shrink-0">
                <span className="text-blue-300 font-semibold">{progress.pct.toFixed(0)}%</span>
                {totals.bytes > 0 && <> · {formatBytes(Math.min(overall?.bytes ?? 0, totals.bytes))} de {formatBytes(totals.bytes)}</>}
                {" "}· {Math.min(overall?.files ?? 0, totals.files)}/{totals.files} arch.
                {progress.speed && <> · {formatSpeed(progress.speed)}</>}
                {progress.eta != null && <> · <span className="text-gray-200">faltan {formatDuration(progress.eta)}</span></>}
              </span>
            )}
            {!running && exitCode !== null && (
              <span className={`text-xs font-medium ${result?.color}`}>
                {exitCode >= 8 ? "✗" : "✓"} código {exitCode}
              </span>
            )}
          </div>
          <div className="relative h-1.5 bg-gray-800 rounded-full overflow-hidden">
            {running ? (
              progress ? (
                // Progreso total real (bytes copiados / bytes a copiar)
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${progress.pct}%` }}
                />
              ) : scanning ? (
                <div className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-gray-400 to-transparent motion-safe:animate-shimmer" />
              ) : sourceFolders.length > 0 ? (
                // Progreso escalonado por carpeta
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${(multiFolderIdx / sourceFolders.length) * 100}%` }}
                />
              ) : (
                // Shimmer para copia única
                <div className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-blue-400 to-transparent motion-safe:animate-shimmer" />
              )
            ) : (
              <div className={`h-full w-full rounded-full transition-all duration-300 ${
                exitCode >= 8 ? "bg-red-500" : exitCode === 0 ? "bg-gray-500" : "bg-emerald-500"
              }`} />
            )}
          </div>

          {/* Resumen por carpeta al terminar */}
          {!running && sourceFolders.length > 0 && multiFolderCodes.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {sourceFolders.map((name, i) => {
                const code = multiFolderCodes[i];
                const ok   = code !== undefined && code < 8;
                return (
                  <span key={name} className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono border
                    ${ok ? "bg-emerald-950/50 border-emerald-800 text-emerald-400"
                         : "bg-red-950/50 border-red-800 text-red-400"}`}>
                    {ok ? "✓" : "✗"} {name}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Vista de copia en vivo ─────────────────────────────────────────── */}
      {(running || recentFiles.length > 0) && (
        <LiveCopyView
          liveFile={liveFile}
          recentFiles={recentFiles}
          source={source}
          dest={effectiveDest}
          isDryRun={isDryRun}
          currentDirInfo={running ? currentDirInfo : null}
        />
      )}

      {/* ── Tarjeta de resumen (al terminar) ───────────────────────────────── */}
      {summary && exitCode !== null && !running && (
        <SummaryCard summary={summary} exitCode={exitCode} />
      )}

      {/* ── Panel de errores (al terminar con código >= 8) ──────────────────── */}
      {!running && errorFiles.length > 0 && (
        <div className="mx-4 mb-2">
          <button
            onClick={() => setShowErrors(p => !p)}
            className="flex items-center justify-between w-full px-3 py-2 bg-red-950/30 border border-red-900/50 rounded-lg text-xs text-red-400 hover:bg-red-950/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 shrink-0">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>{errorFiles.length} entrada{errorFiles.length !== 1 ? "s" : ""} con error — click para ver</span>
            </div>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`w-3 h-3 transition-transform duration-200 ${showErrors ? "rotate-180" : ""}`}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {showErrors && (
            <div className="mt-1 bg-gray-950 border border-red-900/30 rounded-lg overflow-hidden">
              <div className="max-h-56 overflow-y-auto p-3 space-y-1.5">
                {errorFiles.map((entry, i) => (
                  <div key={i} className="font-mono text-xs text-red-400 selectable leading-relaxed break-all border-l-2 border-red-900/50 pl-2">
                    {entry}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Toggle + Log raw ───────────────────────────────────────────────── */}
      <div ref={outputRef} className="flex-1 bg-gray-950">

        {/* Estado vacío — antes de correr */}
        {outputLines.length === 0 && !running && recentFiles.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-gray-700">
            <p className="text-4xl mb-3">⚡</p>
            <p className="text-sm">El output de Robocopy aparecerá aquí en tiempo real</p>
          </div>
        )}

        {outputLines.length > 0 && (
          <div className="px-4 pt-3 pb-1">
            <button
              onClick={() => setShowRawLog(p => !p)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border transition-all duration-150 ${
                showRawLog
                  ? "bg-gray-800 border-gray-700 text-gray-300"
                  : "bg-gray-900/60 border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"
              }`}
            >
              {/* Terminal icon */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className="w-3.5 h-3.5 shrink-0">
                <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              {showRawLog
                ? "Ocultar salida CMD"
                : `Ver salida CMD · ${outputLines.filter(l => l.trim()).length} líneas`}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                className={`w-3 h-3 ml-1 transition-transform duration-200 ${showRawLog ? "rotate-180" : ""}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        )}

        {showRawLog && (
          <div className="p-4 font-mono text-xs leading-5">
            {outputLines.map((line, i) => {
              const type = classifyLine(line);
              if (type === "empty") return null;
              return (
                <div key={i} className={`${LINE_COLORS[type]} whitespace-pre selectable`}>{line}</div>
              );
            })}
            {running && (
              <div className="flex items-center gap-2 mt-1 text-blue-400 whitespace-pre">
                <TextSpinner className="text-cyan-400" />
                <span>{isDryRun ? "Simulando (no se están copiando archivos)..." : "Robocopy en ejecución..."}</span>
                {liveFile?.percent > 0 && (
                  <span className="text-cyan-400">
                    [{asciiBar(liveFile.percent)}] {Math.round(liveFile.percent)}%
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Vista de copia en vivo ──────────────────────────────────────────────────

function LiveCopyView({ liveFile, recentFiles, source, dest, isDryRun, currentDirInfo }) {
  if (!liveFile && recentFiles.length === 0) return null;

  const ft  = liveFile ? getFileType(liveFile.ext) : null;
  const pct = liveFile?.percent ?? 0;
  const desc = liveFile ? getFileDescription(liveFile.ext) : "";

  return (
    <div className="p-4 space-y-3">

      {/* ── Cabecera origen → destino ── */}
      <div className="flex items-center gap-2 bg-gray-900/60 border border-gray-800 rounded-lg px-3 py-2 text-xs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="w-3.5 h-3.5 text-emerald-600 shrink-0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="font-mono text-emerald-400 truncate flex-1" title={source}>
          {source?.split(/[/\\]/).slice(-2).join("\\") || source}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className="w-3.5 h-3.5 text-gray-600 shrink-0">
          <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
        </svg>
        <span className="font-mono text-purple-400 truncate flex-1" title={dest}>
          {dest?.split(/[/\\]/).slice(-2).join("\\") || dest}
        </span>
      </div>

      {/* ── Carpeta activa ── */}
      {currentDirInfo && (
        <div className="px-3 py-2.5 bg-blue-950/30 border border-blue-900/40 rounded-lg text-xs space-y-2">
          {/* Fila: icono + ruta + contador */}
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="w-3.5 h-3.5 text-blue-500 shrink-0">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span className="font-mono text-blue-300 truncate flex-1 min-w-0" title={currentDirInfo.path}>
              {currentDirInfo.path}
            </span>
            {currentDirInfo.count > 0 ? (
              <span className="shrink-0 font-mono tabular-nums text-blue-400">
                <span className="text-blue-300 font-semibold">{currentDirInfo.processed}</span>
                <span className="text-blue-700"> / </span>
                <span>{currentDirInfo.count}</span>
                <span className="text-blue-700 ml-1">arch.</span>
              </span>
            ) : currentDirInfo.processed > 0 ? (
              <span className="shrink-0 font-mono tabular-nums text-blue-500">
                {currentDirInfo.processed} arch.
              </span>
            ) : null}
          </div>
          {/* Mini barra de progreso por directorio */}
          {currentDirInfo.count > 0 ? (
            <div className="h-0.5 bg-blue-900/60 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${Math.min((currentDirInfo.processed / currentDirInfo.count) * 100, 100)}%` }}
              />
            </div>
          ) : currentDirInfo.processed > 0 ? (
            <div className="h-0.5 bg-blue-900/60 rounded-full overflow-hidden">
              <div className="h-full w-1/3 bg-blue-600/60 rounded-full motion-safe:animate-shimmer" />
            </div>
          ) : null}
        </div>
      )}

      {/* ── Card de archivo activo ── */}
      {liveFile && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden motion-safe:animate-fade-in">

          {/* Acento de color según tipo — se llena con el progreso */}
          <div className={`h-0.5 ${ft.bar} transition-all duration-300`} style={{ width: `${pct}%` }} />

          <div className="p-5">
            <div className="flex items-start gap-4">

              {/* Ícono grande de tipo */}
              <FileTypeIcon ext={liveFile.ext} />

              {/* Info principal */}
              <div className="flex-1 min-w-0 space-y-1.5">
                {/* Nombre del archivo */}
                <p className="text-sm font-semibold text-gray-100 truncate leading-snug" title={liveFile.name}>
                  {liveFile.name || (isDryRun ? "Analizando archivo..." : "Preparando copia...")}
                </p>

                {/* Ubicación (directorio) */}
                {liveFile.dir && (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      className="w-3 h-3 text-gray-700 shrink-0">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span className="text-xs text-gray-600 font-mono truncate" title={liveFile.dir}>
                      {liveFile.dir}
                    </span>
                  </div>
                )}

                {/* Tamaño + tipo */}
                <div className="flex items-center gap-3 flex-wrap">
                  {liveFile.size && (
                    <span className="flex items-center gap-1 text-xs text-gray-400">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        className="w-3 h-3 text-gray-600">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      <span className="font-mono font-medium">{liveFile.size}</span>
                    </span>
                  )}
                  <span className={`text-xs font-medium ${ft.fg}`}>{desc}</span>
                </div>
              </div>

              {/* Porcentaje grande */}
              <div className="text-right shrink-0">
                <p className={`text-3xl font-mono font-black tabular-nums leading-none ${pct > 0 ? ft.fg : "text-gray-700"}`}>
                  {pct > 0 ? `${pct}%` : "—"}
                </p>
                <p className="text-xs text-gray-600 mt-1.5">
                  {isDryRun       ? "simulando"
                    : pct >= 100  ? "finalizando"
                    : pct > 0     ? "copiando"
                    :               "iniciando"}
                </p>
              </div>
            </div>

            {/* Barra de progreso del archivo */}
            <div className="mt-5 relative h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-200 ${ft.bar}`}
                style={{ width: `${pct}%` }}
              />
              {pct > 0 && pct < 100 && (
                <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent motion-safe:animate-shimmer" />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Lista de archivos recientes ── */}
      {recentFiles.length > 0 && (
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-wider mb-2">
            Recién {isDryRun ? "analizados" : "copiados"} · {recentFiles.length}
          </p>
          <div className="space-y-1">
            {recentFiles.slice(0, 7).map((f, i) => {
              const rft = getFileType(f.ext);
              return (
                <div key={i}
                  className={`flex items-center gap-2.5 px-3 py-2 bg-gray-900/50 hover:bg-gray-900 rounded-lg transition-colors ${i === 0 ? "motion-safe:animate-fade-in" : ""}`}>
                  {/* Badge pequeño */}
                  <span className={`${rft.bg} ${rft.fg} px-1 py-0.5 rounded text-[9px] font-mono font-bold w-[30px] text-center shrink-0`}>
                    {rft.short}
                  </span>
                  {/* Nombre + ruta */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-300 truncate leading-snug" title={f.name}>{f.name}</p>
                    {f.dir && (
                      <p className="text-[10px] text-gray-700 truncate font-mono" title={f.dir}>{f.dir}</p>
                    )}
                  </div>
                  {/* Tamaño */}
                  {f.size && (
                    <span className="text-[11px] text-gray-600 font-mono shrink-0">{f.size}</span>
                  )}
                  {/* Check */}
                  <span className="text-emerald-500 text-sm shrink-0">✓</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function FileTypeIcon({ ext }) {
  const t = getFileType(ext);
  return (
    <div className={`${t.bg} rounded-xl shrink-0 w-16 h-16 flex flex-col items-center justify-center gap-1.5`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        className={`w-6 h-6 ${t.fg} opacity-75`}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span className={`text-[10px] font-black font-mono tracking-wide ${t.fg}`}>{t.label}</span>
    </div>
  );
}

function FileTypeBadge({ ext }) {
  const t = getFileType(ext);
  return (
    <span className={`${t.bg} ${t.fg} px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-center shrink-0 inline-block`}>
      {t.short}
    </span>
  );
}

// ─── Sub-componentes pequeños ────────────────────────────────────────────────

function PathField({ label, value, onChange, color, placeholder, onBrowse }) {
  const focusColor = color === "emerald" ? "focus:border-emerald-500" : "focus:border-purple-500";
  const textColor  = color === "emerald" ? "text-emerald-500" : "text-purple-500";

  async function handleNativeDialog() {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: label });
      if (selected) onChange(selected);
    } catch (_) {}
  }

  return (
    <div>
      <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">{label}</label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
            className={`selectable w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 pr-8 text-sm
              text-gray-200 placeholder-gray-600 focus:outline-none ${focusColor}`} />
          {value && (
            <button
              onClick={() => onChange("")}
              title="Limpiar"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300 transition-colors"
            >
              ✕
            </button>
          )}
        </div>
        <button onClick={handleNativeDialog} title="Seleccionar con explorador de Windows"
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-400 transition-colors text-base">
          🗂
        </button>
        <button onClick={onBrowse} title="Explorar en la app (con selección de archivos)"
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-400 transition-colors">
          📂
        </button>
      </div>
      {value && <p className={`mt-1 text-xs ${textColor} truncate`} title={value}>{value}</p>}
    </div>
  );
}

function NumericField({ label, flag, value, onChange, desc }) {
  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1.5">
        {label} <span className="text-gray-600 normal-case">{flag}</span>
      </p>
      <input type="number" min="0" max="999" value={value} onChange={e => onChange(e.target.value)}
        className="selectable w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm
          text-gray-200 focus:outline-none focus:border-blue-500" />
      <p className="text-xs text-gray-600 mt-1">{desc}</p>
    </div>
  );
}
