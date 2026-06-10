import { useState, useEffect } from "react";
import { version } from "../package.json";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./index.css";
import FileBrowser from "./components/FileBrowser";
import RobocopyPanel from "./components/RobocopyPanel";
import JobHistory from "./components/JobHistory";
import HelpPanel from "./components/HelpPanel";

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
    id: "help",
    label: "Guía",
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

  const [updateInfo, setUpdateInfo]   = useState(null);
  const [updatePhase, setUpdatePhase] = useState(null); // null | 'downloading' | 'installing'
  const [updatePct, setUpdatePct]     = useState(0);
  const [updateError, setUpdateError] = useState(null);

  useEffect(() => {
    check().then(update => {
      if (update?.available) setUpdateInfo(update);
    }).catch(() => {});
  }, []);

  async function installUpdate() {
    if (!updateInfo) return;
    setUpdatePhase("downloading");
    setUpdatePct(0);
    setUpdateError(null);

    try {
      let totalBytes = 0;
      let downloadedBytes = 0;

      await updateInfo.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          setUpdatePhase("downloading");
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength ?? 0;
          if (totalBytes > 0) {
            setUpdatePct(Math.round((downloadedBytes / totalBytes) * 100));
          }
        } else if (event.event === "Finished") {
          setUpdatePhase("installing");
          setUpdatePct(100);
        }
      });

      await relaunch();
    } catch (e) {
      setUpdatePhase(null);
      setUpdatePct(0);
      setUpdateError(String(e));
    }
  }

  function handleLoadJob(job) {
    setLoadedJob({ ...job, _ts: Date.now() }); // _ts fuerza el useEffect aunque sea el mismo trabajo
    setActiveTab("robocopy");
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">

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

      {/* ── Banner de actualización ──────────────────────────────────────────── */}
      {updateInfo && (
        <div className="flex items-center gap-3 px-5 py-2.5 bg-blue-950 border-b border-blue-900 shrink-0 text-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className="w-4 h-4 text-blue-400 shrink-0">
            <polyline points="16 3 21 3 21 8" />
            <line x1="4" y1="20" x2="21" y2="3" />
            <polyline points="21 16 21 21 16 21" />
            <line x1="15" y1="15" x2="21" y2="21" />
          </svg>

          {!updatePhase ? (
            /* Estado inicial: disponible */
            <>
              <span className="text-blue-200 text-xs">
                Nueva versión <strong className="text-white">v{updateInfo.version}</strong> disponible
              </span>
              <button
                onClick={installUpdate}
                className="ml-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded text-white text-xs font-semibold transition-colors"
              >
                Actualizar ahora
              </button>
              <button
                onClick={() => setUpdateInfo(null)}
                className="ml-auto text-blue-700 hover:text-blue-400 text-xs transition-colors"
              >
                Más tarde
              </button>
            </>
          ) : updatePhase === "downloading" ? (
            /* Descargando */
            <>
              <span className="text-blue-300 text-xs font-medium shrink-0">Descargando...</span>
              <div className="flex items-center gap-2 flex-1">
                <div className="relative flex-1 max-w-[200px] h-1.5 bg-blue-900 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-400 rounded-full transition-all duration-300"
                    style={{ width: `${updatePct}%` }}
                  />
                  {updatePct === 0 && (
                    <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-blue-400/50 to-transparent motion-safe:animate-shimmer" />
                  )}
                </div>
                <span className="text-blue-400 font-mono text-xs tabular-nums w-8">
                  {updatePct > 0 ? `${updatePct}%` : "…"}
                </span>
              </div>
            </>
          ) : (
            /* Instalando */
            <>
              <span className="text-emerald-300 text-xs font-medium shrink-0 animate-pulse">
                Instalando v{updateInfo.version}... La app se reiniciará automáticamente.
              </span>
              <svg className="w-3.5 h-3.5 animate-spin text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
              </svg>
            </>
          )}

          {/* Error */}
          {updateError && (
            <span className="text-red-400 text-xs truncate ml-2" title={updateError}>
              Error: {updateError.slice(0, 80)}
            </span>
          )}
        </div>
      )}

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
            {/* Badge pulsante cuando hay copia corriendo */}
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
          {/* Indicador pulsante */}
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>

          <span className="text-blue-400 font-medium shrink-0">Copiando en segundo plano</span>

          {copyStatus.liveFile?.name ? (
            <>
              {/* Badge del tipo de archivo */}
              {copyStatus.ft && (
                <span className={`${copyStatus.ft.bg} ${copyStatus.ft.fg} px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shrink-0`}>
                  {copyStatus.ft.short}
                </span>
              )}
              {/* Nombre */}
              <span className="text-gray-300 truncate max-w-[220px]">{copyStatus.liveFile.name}</span>
              {/* Directorio */}
              {copyStatus.liveFile.dir && (
                <span className="text-gray-600 truncate max-w-[180px] font-mono hidden lg:block">
                  {copyStatus.liveFile.dir}
                </span>
              )}
              {/* Barra + porcentaje */}
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

          {/* Hint "ir a ver" */}
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
            onDestChange={setDestPath}
            onGoToExplorer={() => setActiveTab("explorer")}
            loadedJob={loadedJob}
            onJobSaved={() => setJobsVersion(v => v + 1)}
            onStatusChange={setCopyStatus}
          />
        </div>
        <div className={activeTab === "history" ? "h-full" : "hidden h-full"}>
          <JobHistory onLoadJob={handleLoadJob} jobsVersion={jobsVersion} />
        </div>
        <div className={activeTab === "help" ? "h-full" : "hidden h-full"}>
          <HelpPanel />
        </div>
      </main>
    </div>
  );
}
