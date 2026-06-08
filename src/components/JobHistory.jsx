import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

function formatDate(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleString("es-CL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function buildCommand(job) {
  const cfg = job.config || {};
  const flags = [];

  // Opciones checkbox
  const options = cfg.options || {};
  Object.entries(options).forEach(([flag, on]) => { if (on) flags.push(flag); });

  // Numéricos
  const r = parseInt(cfg.retries, 10);
  const w = parseInt(cfg.waitTime, 10);
  if (!isNaN(r) && r >= 0) flags.push(`/R:${r}`);
  if (!isNaN(w) && w >= 0) flags.push(`/W:${w}`);

  // MT
  if (cfg.mtEnabled) flags.push(`/MT:${cfg.mtThreads || 8}`);

  // Exclusiones y filtros
  if (cfg.excludeFiles?.length) flags.push("/XF", ...cfg.excludeFiles);
  if (cfg.excludeDirs?.length)  flags.push("/XD", ...cfg.excludeDirs);
  if (cfg.fileFilter?.length)   flags.push("/IF", ...cfg.fileFilter);

  flags.push("/NP");

  return `robocopy "${job.source}" "${job.destination}" ${flags.join(" ")}`;
}

export default function JobHistory({ onLoadJob }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    loadJobs();
  }, []);

  async function loadJobs() {
    setLoading(true);
    try {
      const list = await invoke("load_jobs");
      setJobs(list);
    } catch (e) {
      console.error("Error cargando historial:", e);
    }
    setLoading(false);
  }

  async function deleteJob(id) {
    await invoke("delete_job", { id });
    setJobs(prev => prev.filter(j => j.id !== id));
  }

  function copyCommand(job) {
    const cmd = buildCommand(job);
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedId(job.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  function handleLoad(job) {
    onLoadJob(job);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600">
        <svg className="animate-spin w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
        </svg>
        Cargando historial...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100">

      {/* ── Cabecera ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Historial de trabajos</h2>
          <p className="text-xs text-gray-600 mt-0.5">
            {jobs.length === 0 ? "Aún no hay trabajos guardados" : `${jobs.length} trabajo${jobs.length !== 1 ? "s" : ""} guardado${jobs.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button onClick={loadJobs}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs text-gray-400 transition-colors">
          ↺ Actualizar
        </button>
      </div>

      {/* ── Lista de trabajos ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-700">
            <p className="text-5xl mb-4">📋</p>
            <p className="text-sm font-medium">Sin trabajos guardados</p>
            <p className="text-xs mt-2 text-center max-w-xs">
              Ve al panel Robocopy, configura una copia y haz clic en "💾 Guardar trabajo" para verlo aquí.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map(job => (
              <div key={job.id}
                className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">

                {/* Nombre y fecha */}
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm text-gray-100 truncate">{job.name}</h3>
                    <p className="text-xs text-gray-600 mt-0.5">{formatDate(job.created_at)}</p>
                  </div>

                  {/* Botones */}
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => handleLoad(job)}
                      className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 rounded-lg text-xs font-medium transition-colors">
                      Cargar
                    </button>
                    <button onClick={() => copyCommand(job)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                        ${copiedId === job.id ? "bg-emerald-800 text-emerald-300" : "bg-gray-800 hover:bg-gray-700 text-gray-400"}`}>
                      {copiedId === job.id ? "✓ Copiado" : "Copiar CMD"}
                    </button>
                    <button onClick={() => deleteJob(job.id)}
                      className="px-3 py-1.5 bg-gray-800 hover:bg-red-900 rounded-lg text-xs text-gray-600 hover:text-red-400 transition-colors">
                      Eliminar
                    </button>
                  </div>
                </div>

                {/* Rutas */}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div className="bg-gray-950 rounded-lg px-3 py-2 min-w-0">
                    <p className="text-xs text-gray-600 mb-0.5">Origen</p>
                    <p className="text-xs text-emerald-400 truncate font-mono" title={job.source}>{job.source}</p>
                  </div>
                  <div className="bg-gray-950 rounded-lg px-3 py-2 min-w-0">
                    <p className="text-xs text-gray-600 mb-0.5">Destino</p>
                    <p className="text-xs text-purple-400 truncate font-mono" title={job.destination}>{job.destination}</p>
                  </div>
                </div>

                {/* Badges de opciones activas */}
                <OptionBadges cfg={job.config} />

                {/* Comando completo (expandible) */}
                <details className="mt-2">
                  <summary className="text-xs text-gray-600 hover:text-gray-400 cursor-pointer select-none">
                    Ver comando completo
                  </summary>
                  <code className="selectable block mt-1.5 text-xs font-mono text-gray-400 bg-gray-950 rounded p-2 break-all">
                    {buildCommand(job)}
                  </code>
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Muestra badges con las opciones activas del trabajo
function OptionBadges({ cfg }) {
  if (!cfg) return null;

  const badges = [];
  const opts = cfg.options || {};

  if (opts["/E"])   badges.push({ label: "Subcarpetas",    color: "bg-blue-900 text-blue-300" });
  if (opts["/MIR"]) badges.push({ label: "Espejo",         color: "bg-yellow-900 text-yellow-300" });
  if (opts["/L"])   badges.push({ label: "Modo prueba",    color: "bg-sky-900 text-sky-300" });
  if (opts["/Z"])   badges.push({ label: "Reiniciable",    color: "bg-gray-800 text-gray-400" });
  if (opts["/B"])   badges.push({ label: "Backup",         color: "bg-gray-800 text-gray-400" });
  if (opts["/XO"])  badges.push({ label: "Excluir antiguos", color: "bg-gray-800 text-gray-400" });
  if (cfg.mtEnabled) badges.push({ label: `MT:${cfg.mtThreads}`, color: "bg-emerald-900 text-emerald-300" });
  if (cfg.excludeFiles?.length) badges.push({ label: `XF: ${cfg.excludeFiles.join(", ")}`, color: "bg-gray-800 text-gray-500" });
  if (cfg.excludeDirs?.length)  badges.push({ label: `XD: ${cfg.excludeDirs.join(", ")}`, color: "bg-gray-800 text-gray-500" });
  if (cfg.fileFilter?.length)   badges.push({ label: `IF: ${cfg.fileFilter.join(", ")}`, color: "bg-gray-800 text-gray-500" });

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.map((b, i) => (
        <span key={i} className={`px-2 py-0.5 rounded text-xs ${b.color}`}>{b.label}</span>
      ))}
    </div>
  );
}
