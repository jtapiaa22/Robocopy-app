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

// ─── Clasifica líneas del output para colorearlas ───────────────────────────

function classifyLine(line) {
  const t = line.trim();
  if (!t) return "empty";
  if (t.startsWith("---")) return "separator";
  if (/^\s*\d+%/.test(line)) return "progress";
  if (/New File/i.test(line)) return "new";
  if (/\bNewer\b/i.test(line)) return "newer";
  if (/\bOlder\b/i.test(line)) return "older";
  if (/FAILED|ERROR/i.test(line)) return "error";
  if (/EXTRA File|EXTRA Dir/i.test(line)) return "extra";
  if (/^\s*(Dirs|Files|Bytes|Times|Speed)\s*:/i.test(line)) return "summary";
  if (/^\s*(Started|Source|Dest|Options|Ended)\s*:/i.test(line)) return "header";
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
  const name = segs[segs.length - 1];
  if (!name || !name.includes(".")) return null;
  if (/^(New File|Newer|Older|EXTRA|ERROR|FAILED)$/i.test(name)) return null;
  const ext = name.split(".").pop().toLowerCase();
  const sizeMatch = line.match(/\b(\d[\d,.]*\s*[kKmMgG]?)\s+\S+\s*$/);
  return { name, ext, size: sizeMatch?.[1]?.trim() || "" };
}

function parseDirLine(line) {
  // Detecta líneas de directorio: "\t   3\tE:\source\subfolder\"
  const segs = line.split("\t").map(s => s.trim()).filter(Boolean);
  const last = segs[segs.length - 1];
  return (last && /^[A-Za-z]:[/\\]/.test(last) && last.endsWith("\\")) ? last : null;
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
            <Stat label="Fallidos"          value={summary.files.failed}  color={summary.files.failed !== "0" ? "text-red-400" : "text-gray-500"} />
          </>
        )}
        {summary.dirs && (
          <>
            <Stat label="Carpetas copiadas" value={summary.dirs.copied}  color="text-blue-400" />
            <Stat label="Carpetas totales"  value={summary.dirs.total}   color="text-gray-300" />
          </>
        )}
        {summary.bytes && (
          <Stat label="Datos copiados" value={summary.bytes.copied} color="text-cyan-400" />
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

// ─── Componente principal ────────────────────────────────────────────────────

export default function RobocopyPanel({ source, dest, sourceFiles = [], sourceFolders = [], onSourceChange, onDestChange, onGoToExplorer, loadedJob, onJobSaved }) {
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
  const [liveFile, setLiveFile]       = useState(null);  // { name, ext, size, percent }
  const [recentFiles, setRecentFiles] = useState([]);    // archivos recién copiados
  const [showRawLog, setShowRawLog]   = useState(false);

  const outputRef    = useRef(null);
  const unlistenRef  = useRef([]);
  const lastWasCrRef = useRef(false);
  const currentDirRef = useRef(""); // directorio actual que está procesando robocopy

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
    setOutputLines([]);
    setExitCode(null);
    setSummary(null);
  }, [loadedJob]);

  // Auto-scroll al final del output
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [outputLines]);

  // Limpia listeners al desmontar
  useEffect(() => () => unlistenRef.current.forEach(fn => fn()), []);

  function toggleOption(flag) {
    setOptions(prev => ({ ...prev, [flag]: !prev[flag] }));
  }

  // Parsea líneas de resumen estadístico del output de robocopy
  function parseSummaryLine(line) {
    const dirsMatch  = line.match(/^\s*Dirs\s*:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i);
    const filesMatch = line.match(/^\s*Files\s*:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i);
    const bytesMatch = line.match(/^\s*Bytes\s*:\s+(\S+(?:\s+\S+)?)\s+(\S+(?:\s+\S+)?)/i);
    const speedMatch = line.match(/Speed\s*:\s+([\d,.\s]+Bytes\/Sec)/i);

    if (dirsMatch)  setSummary(p => ({ ...p, dirs:  { total: dirsMatch[1],  copied: dirsMatch[2],  skipped: dirsMatch[3], failed: dirsMatch[5] } }));
    if (filesMatch) setSummary(p => ({ ...p, files: { total: filesMatch[1], copied: filesMatch[2], skipped: filesMatch[3], failed: filesMatch[5] } }));
    if (bytesMatch) setSummary(p => ({ ...p, bytes: { total: bytesMatch[1], copied: bytesMatch[2] } }));
    if (speedMatch) {
      const bps = parseFloat(speedMatch[1].replace(/[,\s]/g, "").replace("Bytes/Sec", ""));
      if (!isNaN(bps)) {
        const speed = bps > 1e9 ? `${(bps/1e9).toFixed(2)} GB/s`
                    : bps > 1e6 ? `${(bps/1e6).toFixed(1)} MB/s`
                    : bps > 1e3 ? `${(bps/1e3).toFixed(0)} KB/s`
                    : `${bps} B/s`;
        setSummary(p => ({ ...p, speed }));
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
    if (!source || !dest) return;
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
    setLiveFile(null);
    setRecentFiles([]);
    setShowRawLog(false);
    currentDirRef.current = "";

    const flags = buildFlags();

    // ── Modo multi-carpeta ──────────────────────────────────────────────────
    if (sourceFolders.length > 0) {
      const ul1 = await listen("robocopy-output", event => {
        const line = event.payload;
        const wasCr = lastWasCrRef.current;
        lastWasCrRef.current = false;
        setOutputLines(prev => {
          if (wasCr && prev.length > 0) return [...prev.slice(0, -1), line];
          return [...prev, line];
        });
        parseSummaryLine(line);
        // Detectar directorio actual
        const dir = parseDirLine(line);
        if (dir) { currentDirRef.current = dir; }
        if (/New File|\bNewer\b|\bOlder\b|EXTRA File/i.test(line)) {
          setFileCount(p => p + 1);
          const parsed = parseFileLine(line);
          if (parsed?.name) {
            setLiveFile(null);
            setRecentFiles(prev => [{ ...parsed, dir: currentDirRef.current }, ...prev].slice(0, 10));
          }
        }
      });

      const ulCr = await listen("robocopy-output-cr", event => {
        const line = event.payload;
        const wasCr = lastWasCrRef.current;
        lastWasCrRef.current = true;
        setOutputLines(prev => {
          if (wasCr && prev.length > 0) return [...prev.slice(0, -1), line];
          return [...prev, line];
        });
        const pctMatch = line.trim().match(/^(\d+)%/);
        if (pctMatch) {
          const pct = parseInt(pctMatch[1], 10);
          setLiveFile(prev => ({ name: prev?.name || "", ext: prev?.ext || "", size: prev?.size || "", dir: prev?.dir || currentDirRef.current, percent: pct }));
        } else {
          const parsed = parseFileLine(line);
          if (parsed?.name) setLiveFile({ ...parsed, dir: currentDirRef.current, percent: 0 });
        }
      });

      const ul2 = await listen("robocopy-folder-start", event => {
        const name = event.payload;
        lastWasCrRef.current = false;
        currentDirRef.current = "";
        setOutputLines(prev => [...prev, "", `${"═".repeat(20)} ${name} ${"═".repeat(20)}`]);
        setMultiFolderIdx(prev => prev + 1);
        setFileCount(0);
        setLiveFile(null);
        setRecentFiles([]);
      });

      const ul3 = await listen("robocopy-folder-done", event => {
        setMultiFolderCodes(prev => [...prev, event.payload]);
      });

      const ul4 = await listen("robocopy-all-done", async event => {
        const codes = event.payload;
        const worst = Math.max(...codes);
        setExitCode(worst);
        setRunning(false);
        setLiveFile(null);
        unlistenRef.current.forEach(fn => fn());
        unlistenRef.current = [];
        await sendDoneNotification(worst);
      });

      unlistenRef.current = [ul1, ulCr, ul2, ul3, ul4];

      try {
        await invoke("run_robocopy_multi", {
          parentSource: source,
          parentDest: dest,
          folders: sourceFolders,
          flags,
        });
      } catch (e) {
        setOutputLines(prev => [...prev, `ERROR: ${e}`]);
        setRunning(false);
      }
      return;
    }

    // ── Modo carpeta única (comportamiento original) ─────────────────────────
    const ul1 = await listen("robocopy-output", event => {
      const line = event.payload;
      const wasCr = lastWasCrRef.current;
      lastWasCrRef.current = false;
      setOutputLines(prev => {
        if (wasCr && prev.length > 0) return [...prev.slice(0, -1), line];
        return [...prev, line];
      });
      parseSummaryLine(line);
      const dir = parseDirLine(line);
      if (dir) { currentDirRef.current = dir; }
      if (/New File|\bNewer\b|\bOlder\b|EXTRA File/i.test(line)) {
        setFileCount(p => p + 1);
        const parsed = parseFileLine(line);
        if (parsed?.name) {
          setLiveFile(null);
          setRecentFiles(prev => [{ ...parsed, dir: currentDirRef.current }, ...prev].slice(0, 10));
        }
      }
    });

    const ulCr = await listen("robocopy-output-cr", event => {
      const line = event.payload;
      const wasCr = lastWasCrRef.current;
      lastWasCrRef.current = true;
      setOutputLines(prev => {
        if (wasCr && prev.length > 0) return [...prev.slice(0, -1), line];
        return [...prev, line];
      });
      const pctMatch = line.trim().match(/^(\d+)%/);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1], 10);
        setLiveFile(prev => ({ name: prev?.name || "", ext: prev?.ext || "", size: prev?.size || "", dir: prev?.dir || currentDirRef.current, percent: pct }));
      } else {
        const parsed = parseFileLine(line);
        if (parsed?.name) setLiveFile({ ...parsed, dir: currentDirRef.current, percent: 0 });
      }
    });

    const ul2 = await listen("robocopy-done", async event => {
      const code = event.payload;
      setExitCode(code);
      setRunning(false);
      setLiveFile(null);
      unlistenRef.current.forEach(fn => fn());
      unlistenRef.current = [];
      await sendDoneNotification(code);
    });

    unlistenRef.current = [ul1, ulCr, ul2];

    try {
      await invoke("run_robocopy", { source, destination: dest, flags });
    } catch (e) {
      setOutputLines(prev => [...prev, `ERROR: ${e}`]);
      setRunning(false);
    }
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
        config: { options, retries, waitTime, mtEnabled, mtThreads, excludeFiles, excludeDirs, fileFilter },
        created_at: Math.floor(Date.now() / 1000),
      },
    });
    setSaveMode(false);
    setSaveName("");
    onJobSaved?.();
  }

  const canRun  = !!(source && dest && !running);
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
          <button
            onClick={() => invoke("cancel_robocopy").catch(() => {})}
            className="flex items-center gap-2 px-5 py-2 bg-red-800 hover:bg-red-700 rounded-lg text-sm font-semibold text-red-200 transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            {isDryRun ? "Simulando..." : "Copiando..."}
            <span className="ml-1 text-red-400 text-xs border border-red-700 rounded px-1.5 py-0.5">✕ Cancelar</span>
          </button>
        ) : (
          <button onClick={startRobocopy} disabled={!canRun}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-colors
              ${isDryRun ? "bg-sky-700 hover:bg-sky-600" : "bg-blue-600 hover:bg-blue-500"}
              disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed`}>
            {isDryRun
            ? "🔍 Simular (sin copiar)"
            : sourceFolders.length > 0
              ? `▶ Copiar ${sourceFolders.length} carpetas`
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
          <button onClick={() => { setOutputLines([]); setExitCode(null); setSummary(null); }}
            disabled={running || outputLines.length === 0}
            className="text-xs text-gray-600 hover:text-gray-400 disabled:opacity-30 transition-colors px-2">
            Limpiar
          </button>
        </div>
      </div>

      {/* ── Barra de progreso ────────────────────────────────────────────────── */}
      {(running || exitCode !== null) && (
        <div className="px-4 py-2.5 bg-gray-900/80 border-b border-gray-800 shrink-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-gray-400">
              {running
                ? sourceFolders.length > 0
                  ? `Carpeta ${multiFolderIdx} de ${sourceFolders.length}: "${sourceFolders[multiFolderIdx - 1] ?? ""}" — ${fileCount} archivos`
                  : `${isDryRun ? "Simulando" : "Copiando"}... ${fileCount > 0 ? `${fileCount} archivo${fileCount !== 1 ? "s" : ""} procesado${fileCount !== 1 ? "s" : ""}` : "iniciando"}`
                : sourceFolders.length > 0
                  ? `${sourceFolders.length} carpetas — ${multiFolderCodes.filter(c => c >= 8).length === 0 ? "completado" : "con errores"}`
                  : result?.desc}
            </span>
            {!running && exitCode !== null && (
              <span className={`text-xs font-medium ${result?.color}`}>
                {exitCode >= 8 ? "✗" : "✓"} código {exitCode}
              </span>
            )}
          </div>
          <div className="relative h-1.5 bg-gray-800 rounded-full overflow-hidden">
            {running ? (
              sourceFolders.length > 0 ? (
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
          dest={dest}
          isDryRun={isDryRun}
        />
      )}

      {/* ── Tarjeta de resumen (al terminar) ───────────────────────────────── */}
      {summary && exitCode !== null && !running && (
        <SummaryCard summary={summary} exitCode={exitCode} />
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
              <div className="flex items-center gap-2 mt-1 text-blue-400 animate-pulse">
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
                </svg>
                {isDryRun ? "Simulando (no se están copiando archivos)..." : "Robocopy en ejecución..."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Vista de copia en vivo ──────────────────────────────────────────────────

function LiveCopyView({ liveFile, recentFiles, source, dest, isDryRun }) {
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
