import { useState, useEffect } from "react";
import { version } from "../package.json";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import FileBrowser from "./components/FileBrowser";
import RobocopyPanel from "./components/RobocopyPanel";
import JobHistory from "./components/JobHistory";
import HelpPanel from "./components/HelpPanel";
import CloneDisk from "./components/CloneDisk";

const TABS = [
  {
    id: "explorer",
    label: "Explorador",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    id: "robocopy",
    label: "Robocopy",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <polyline points="16 3 21 3 21 8" />
        <line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" />
        <line x1="15" y1="15" x2="21" y2="21" />
      </svg>
    ),
  },
  {
    id: "history",
    label: "Historial",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <path d="M12 8v4l3 3" />
        <path d="M3.05 11a9 9 0 1 1 .5 4M3 16v-5h5" />
      </svg>
    ),
  },
  {
    id: "clone",
    label: "Clonar Disco",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <ellipse cx="7" cy="7" rx="5" ry="2" />
        <path d="M2 7v6c0 1.1 2.24 2 5 2s5-.9 5-2V7" />
        <path d="M2 10c0 1.1 2.24 2 5 2s5-.9 5-2" />
        <path d="M15 12l3 3 3-3" />
        <path d="M18 7v8" />
      </svg>
    ),
  },
  {
    id: "help",
    label: "Guía y Actualizaciones",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
];

export default function App() {
  const [activeTab, setActiveTab]   = useState("explorer");
  const [sourcePath, setSourcePath] = useState("");
  const [destPath, setDestPath]     = useState("");
  const [sourceFiles, setSourceFiles]     = useState([]);
  const [sourceFolders, setSourceFolders] = useState([]);
  const [loadedJob, setLoadedJob]   = useState(null);
  const [jobsVersion, setJobsVersion] = useState(0);
  const [copyStatus, setCopyStatus] = useState({ running: false, liveFile: null, ft: null, fileCount: 0 });
  const [cloning, setCloning]       = useState(false);
  const [showCloseWarning, setShowCloseWarning] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // El backend Rust emite este evento cuando detecta cierre con proceso activo
  useEffect(() => {
    let unlisten;
    listen("app-close-requested", () => {
      setShowCloseWarning(true);
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Si el proceso terminó solo mientras el aviso estaba visible, cerrar automáticamente
  useEffect(() => {
    if (showCloseWarning && !copyStatus.running && !cloning) {
      setShowCloseWarning(false);
      getCurrentWindow().close();
    }
  }, [showCloseWarning, copyStatus.running, cloning]);

  async function handleCancelAndClose() {
    setCancelling(true);
    try {
      if (copyStatus.running) await invoke("cancel_robocopy");
      if (cloning) await invoke("cancel_clone");
    } catch (_) {}
    getCurrentWindow().close();
  }

  function handleLoadJob(job) {
    setLoadedJob({ ...job, _ts: Date.now() });
    setActiveTab("robocopy");
  }

  // ── Administrador bajo demanda ──
  // La app arranca sin admin; clonar discos y /B la relanzan elevada conservando el estado.
  const [elevated, setElevated] = useState(false);
  useEffect(() => {
    invoke("is_elevated").then(setElevated).catch(() => {});
    invoke("take_relaunch_state").then(raw => {
      if (!raw) return;
      try {
        const st = JSON.parse(raw);
        if (st.job) setLoadedJob({ ...st.job, _ts: Date.now() });
        if (st.tab) setActiveTab(st.tab);
      } catch (_) {}
    }).catch(() => {});
  }, []);

  // Devuelve un mensaje de error si el usuario cancela el UAC (si no, la app se cierra y reabre)
  async function relaunchAsAdmin(state) {
    try {
      await invoke("relaunch_as_admin", { state: JSON.stringify(state ?? {}) });
      return null;
    } catch (e) {
      return String(e);
    }
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">

      {/* ── Modal: operación en curso al cerrar ──────────────────────────────── */}
      {showCloseWarning && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-yellow-500/15 flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-yellow-400">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <p className="text-sm font-semibold text-gray-100">Operación en curso</p>
            </div>

            {cancelling ? (
              <div className="flex items-center gap-3 py-2 text-sm text-gray-400">
                <svg className="w-4 h-4 animate-spin shrink-0 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
                </svg>
                Cancelando proceso, esperando que termine...
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-400 mb-5 leading-relaxed">
                  {copyStatus.running
                    ? "Hay una copia de Robocopy en curso."
                    : "Hay una clonación de disco en curso."}
                  {" "}¿Deseás cancelar el proceso y cerrar la aplicación?
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={handleCancelAndClose}
                    className="flex-1 py-2 bg-red-700 hover:bg-red-600 active:bg-red-800 rounded-lg text-sm font-semibold transition-colors"
                  >
                    Sí, cancelar y cerrar
                  </button>
                  <button
                    onClick={() => setShowCloseWarning(false)}
                    className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 active:bg-gray-800 rounded-lg text-sm font-semibold transition-colors"
                  >
                    No, continuar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Barra de título ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-2.5 bg-gray-900 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" className="w-4 h-4">
              <polyline points="16 3 21 3 21 8" />
              <line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" />
              <line x1="15" y1="15" x2="21" y2="21" />
            </svg>
          </div>
          <h1 className="font-semibold text-sm text-gray-100">RoboCopy GUI</h1>
          {elevated && (
            <span title="La app corre como administrador. Arrastrar desde el Explorador no funciona en este modo (lo bloquea Windows)."
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-900/50 border border-amber-700/60 text-amber-300">
              ADMIN
            </span>
          )}
        </div>

        {/* Indicadores de rutas seleccionadas */}
        <div className="flex items-center gap-5 text-xs">
          {sourcePath && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="text-gray-500">Origen:</span>
              <span className="text-emerald-400 max-w-52 truncate font-mono" title={sourcePath}>{sourcePath}</span>
            </div>
          )}
          {destPath && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
              <span className="text-gray-500">Destino:</span>
              <span className="text-purple-400 max-w-52 truncate font-mono" title={destPath}>{destPath}</span>
            </div>
          )}

          {/* Marca de agua */}
          <div className="flex items-center gap-1.5 pl-4 border-l border-gray-800 ml-2">
            <span className="text-gray-600 font-semibold tracking-wide">TaDevStudio</span>
            <span className="text-gray-700">·</span>
            <span className="text-gray-700">v{version}</span>
          </div>
        </div>
      </header>

      {/* ── Pestañas ─────────────────────────────────────────────────────────── */}
      <nav className="flex gap-1 px-4 pt-2 bg-gray-900 border-b border-gray-800 shrink-0">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
              ${activeTab === tab.id
                ? "border-blue-500 text-blue-400 bg-gray-800"
                : "border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"}`}>
            {tab.icon}
            {tab.label}
            {tab.id === "robocopy" && copyStatus.running ? (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            ) : tab.id === "robocopy" && (sourcePath || destPath) ? (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            ) : null}
          </button>
        ))}
      </nav>

      {/* ── Barra de progreso en segundo plano (visible en otras pestañas) ───── */}
      {copyStatus.running && activeTab !== "robocopy" && (
        <button
          onClick={() => setActiveTab("robocopy")}
          className="flex items-center gap-3 px-4 py-2 bg-blue-950/70 border-b border-blue-900/50 text-xs w-full hover:bg-blue-950/90 transition-colors shrink-0 group"
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>

          <span className="text-blue-400 font-medium shrink-0">Copiando en segundo plano</span>

          {copyStatus.liveFile?.name ? (
            <>
              {copyStatus.ft && (
                <span className={`${copyStatus.ft.bg} ${copyStatus.ft.fg} px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shrink-0`}>
                  {copyStatus.ft.short}
                </span>
              )}
              <span className="text-gray-300 truncate max-w-[220px]">{copyStatus.liveFile.name}</span>
              {copyStatus.liveFile.dir && (
                <span className="text-gray-600 truncate max-w-[180px] font-mono hidden lg:block">
                  {copyStatus.liveFile.dir}
                </span>
              )}
              <div className="flex items-center gap-2 ml-auto shrink-0">
                <div className="relative h-1 w-28 bg-blue-900/60 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${copyStatus.ft?.bar ?? "bg-blue-500"} rounded-full transition-all duration-300`}
                    style={{ width: `${copyStatus.liveFile.percent || 0}%` }}
                  />
                </div>
                <span className="text-blue-300 font-mono w-8 text-right tabular-nums">
                  {copyStatus.liveFile.percent > 0 ? `${copyStatus.liveFile.percent}%` : "—"}
                </span>
              </div>
            </>
          ) : (
            <span className="text-gray-500">
              {copyStatus.fileCount > 0 ? `${copyStatus.fileCount} archivo${copyStatus.fileCount !== 1 ? "s" : ""} procesado${copyStatus.fileCount !== 1 ? "s" : ""}` : "Iniciando..."}
            </span>
          )}

          <span className="text-blue-700 group-hover:text-blue-500 transition-colors shrink-0 ml-1">
            Ver detalles →
          </span>
        </button>
      )}

      {/* ── Contenido ────────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-hidden">
        <div className={activeTab === "explorer" ? "h-full" : "hidden h-full"}>
          <FileBrowser
            onSelectSource={(path, files, folders) => {
              setSourcePath(path);
              setSourceFiles(files || []);
              setSourceFolders(folders || []);
            }}
            onSelectDest={setDestPath}
            sourcePath={sourcePath}
            destPath={destPath}
          />
        </div>
        <div className={activeTab === "robocopy" ? "h-full" : "hidden h-full"}>
          <RobocopyPanel
            source={sourcePath}
            dest={destPath}
            sourceFiles={sourceFiles}
            sourceFolders={sourceFolders}
            onSourceChange={path => { setSourcePath(path); setSourceFolders([]); setSourceFiles([]); }}
            onSourceSelect={(path, files, folders) => {
              setSourcePath(path);
              setSourceFiles(files || []);
              setSourceFolders(folders || []);
            }}
            onDestChange={setDestPath}
            onGoToExplorer={() => setActiveTab("explorer")}
            loadedJob={loadedJob}
            onJobSaved={() => setJobsVersion(v => v + 1)}
            onStatusChange={setCopyStatus}
            elevated={elevated}
            onRelaunchAdmin={job => relaunchAsAdmin({ tab: "robocopy", job })}
          />
        </div>
        <div className={activeTab === "history" ? "h-full" : "hidden h-full"}>
          <JobHistory onLoadJob={handleLoadJob} jobsVersion={jobsVersion} />
        </div>
        <div className={activeTab === "clone" ? "h-full" : "hidden h-full"}>
          <CloneDisk onCloningChange={setCloning} elevated={elevated}
            onRelaunchAdmin={() => relaunchAsAdmin({ tab: "clone" })} />
        </div>
        <div className={activeTab === "help" ? "h-full" : "hidden h-full"}>
          <HelpPanel />
        </div>
      </main>
    </div>
  );
}
