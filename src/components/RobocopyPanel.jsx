import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

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
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); add(input); }
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

export default function RobocopyPanel({ source, dest, onSourceChange, onDestChange, onGoToExplorer, loadedJob }) {
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

  const outputRef    = useRef(null);
  const unlistenRef  = useRef([]);

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

  async function startRobocopy() {
    if (!source || !dest) return;
    setRunning(true);
    setExitCode(null);
    setSummary(null);
    setOutputLines([]);

    unlistenRef.current.forEach(fn => fn());
    unlistenRef.current = [];

    const ul1 = await listen("robocopy-output", event => {
      const line = event.payload;
      setOutputLines(prev => [...prev, line]);
      parseSummaryLine(line);
    });

    const ul2 = await listen("robocopy-done", async event => {
      const code = event.payload;
      setExitCode(code);
      setRunning(false);
      unlistenRef.current.forEach(fn => fn());
      unlistenRef.current = [];

      // Notificación nativa de Windows
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const req = await requestPermission();
          granted = req === "granted";
        }
        if (granted) {
          const res = interpretExitCode(code);
          sendNotification({ title: "RoboCopy GUI", body: `${res.label} — ${res.desc}` });
        }
      } catch (_) {}
    });

    unlistenRef.current = [ul1, ul2];

    // Construye el array de flags
    const flags = Object.entries(options)
      .filter(([, on]) => on)
      .map(([flag]) => flag);

    if (mtEnabled) {
      const t = parseInt(mtThreads, 10);
      if (!isNaN(t) && t > 0) flags.push(`/MT:${t}`);
    }
    const r = parseInt(retries, 10);
    const w = parseInt(waitTime, 10);
    if (!isNaN(r) && r >= 0) flags.push(`/R:${r}`);
    if (!isNaN(w) && w >= 0) flags.push(`/W:${w}`);
    const a = parseInt(maxAge, 10);
    if (!isNaN(a) && a >= 0) flags.push(`/MAXAGE:${a}`);
    if (excludeFiles.length > 0) flags.push("/XF", ...excludeFiles);
    if (excludeDirs.length  > 0) flags.push("/XD", ...excludeDirs);
    if (fileFilter.length   > 0) flags.push("/IF", ...fileFilter);
    flags.push("/NP"); // evita miles de líneas de progreso

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
  }

  const canRun  = !!(source && dest && !running);
  const result  = exitCode !== null ? interpretExitCode(exitCode) : null;
  const isDryRun = options["/L"];

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100 overflow-hidden">

      {/* ── Rutas ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 p-4 bg-gray-900 border-b border-gray-800 shrink-0">
        <PathField label="Carpeta Origen"  value={source} onChange={onSourceChange}
          color="emerald" placeholder="C:\ruta\de\origen"  onBrowse={onGoToExplorer} />
        <PathField label="Carpeta Destino" value={dest}   onChange={onDestChange}
          color="purple"  placeholder="D:\ruta\de\destino" onBrowse={onGoToExplorer} />
      </div>

      {/* ── Opciones: checkboxes ────────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-2 bg-gray-900/60 border-b border-gray-800 shrink-0">
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
      </div>

      {/* ── Opciones: campos numéricos y exclusiones ─────────────────────────── */}
      <div className="px-4 py-3 bg-gray-900/40 border-b border-gray-800 shrink-0">
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
      </div>

      {/* ── Botón de inicio + guardar trabajo ───────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-900 border-b border-gray-800 shrink-0">
        {running ? (
          <button onClick={() => {}} className="flex items-center gap-2 px-5 py-2 bg-red-900 rounded-lg text-sm font-semibold text-red-300 cursor-default">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            {isDryRun ? "Simulando..." : "Copiando..."}
          </button>
        ) : (
          <button onClick={startRobocopy} disabled={!canRun}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-colors
              ${isDryRun ? "bg-sky-700 hover:bg-sky-600" : "bg-blue-600 hover:bg-blue-500"}
              disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed`}>
            {isDryRun ? "🔍 Simular (sin copiar)" : "▶ Iniciar copia"}
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

      {/* ── Output ──────────────────────────────────────────────────────────── */}
      <div ref={outputRef} className="flex-1 overflow-y-auto bg-gray-950">

        {/* Tarjeta de resumen (aparece cuando termina) */}
        {summary && exitCode !== null && !running && (
          <SummaryCard summary={summary} exitCode={exitCode} />
        )}

        {/* Texto del output */}
        <div className="p-4 font-mono text-xs leading-5">
          {outputLines.length === 0 && !running && (
            <div className="flex flex-col items-center justify-center h-32 text-gray-700">
              <p className="text-3xl mb-2">⚡</p>
              <p className="text-sm">El output de Robocopy aparecerá aquí en tiempo real</p>
            </div>
          )}

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
      </div>
    </div>
  );
}

// ─── Sub-componentes pequeños ────────────────────────────────────────────────

function PathField({ label, value, onChange, color, placeholder, onBrowse }) {
  const focusColor = color === "emerald" ? "focus:border-emerald-500" : "focus:border-purple-500";
  const textColor  = color === "emerald" ? "text-emerald-500" : "text-purple-500";
  return (
    <div>
      <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">{label}</label>
      <div className="flex gap-2">
        <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          className={`selectable flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
            text-gray-200 placeholder-gray-600 focus:outline-none ${focusColor}`} />
        <button onClick={onBrowse} title="Explorar"
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
