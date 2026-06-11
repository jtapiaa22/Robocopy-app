import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

function fmtSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function fmtEta(seconds) {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function DiskCard({ disk, selected, onSelect, disabled, warning }) {
  if (!disk) {
    return (
      <button
        onClick={onSelect}
        disabled={disabled}
        className="flex-1 min-h-[120px] border-2 border-dashed border-gray-700 rounded-xl flex items-center justify-center text-gray-600 text-sm hover:border-gray-600 hover:text-gray-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Seleccionar disco
      </button>
    );
  }

  const isLocked = disk.isSystem || disk.isBoot;

  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`flex-1 min-h-[120px] rounded-xl border-2 p-4 text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed
        ${selected
          ? "border-blue-500 bg-blue-950/30"
          : isLocked
            ? "border-red-900/60 bg-red-950/10 cursor-not-allowed opacity-60"
            : "border-gray-700 bg-gray-800/40 hover:border-gray-600"
        }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 text-gray-400 shrink-0">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
            <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
          </svg>
          <span className="text-sm font-medium text-gray-100 truncate max-w-[180px]">{disk.model || "Disco desconocido"}</span>
        </div>
        {isLocked && (
          <span className="text-[9px] font-bold bg-red-900/60 text-red-400 px-1.5 py-0.5 rounded shrink-0">SISTEMA</span>
        )}
      </div>

      <div className="text-xs text-gray-400 mb-2">{fmtSize(disk.size)} · {disk.style}</div>

      {disk.partitions && disk.partitions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {disk.partitions.map((p, i) => (
            <span key={i} className="text-[10px] bg-gray-700/60 text-gray-400 px-1.5 py-0.5 rounded font-mono">
              {p.letter ? `${p.letter}:` : "—"} {p.fs || "?"} {p.label ? `"${p.label}"` : ""}
            </span>
          ))}
        </div>
      )}

      {warning && (
        <p className="mt-2 text-[10px] text-yellow-400 flex items-center gap-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          {warning}
        </p>
      )}
    </button>
  );
}

function DiskSelector({ disks, selected, onSelect, label, excludeIndex, disabled }) {
  const [open, setOpen] = useState(false);
  const available = disks.filter(d => d.index !== excludeIndex);

  return (
    <div className="flex-1 flex flex-col gap-2">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
      <DiskCard
        disk={selected}
        onSelect={() => !disabled && setOpen(true)}
        disabled={disabled}
        warning={
          selected?.isSystem || selected?.isBoot
            ? "Este es el disco del sistema activo"
            : null
        }
      />

      {open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setOpen(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold text-gray-100">Seleccionar disco — {label}</p>
              <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300 transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
              {available.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-4">No hay otros discos disponibles</p>
              )}
              {available.map(disk => {
                const locked = disk.isSystem || disk.isBoot;
                return (
                  <button
                    key={disk.index}
                    onClick={() => { if (!locked) { onSelect(disk); setOpen(false); } }}
                    disabled={locked}
                    className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors
                      ${locked ? "border-red-900/40 opacity-50 cursor-not-allowed" : "border-gray-700 hover:border-blue-500 hover:bg-blue-950/20"}`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 text-gray-400 shrink-0">
                      <ellipse cx="12" cy="5" rx="9" ry="3" />
                      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-100 truncate">{disk.model || "Disco desconocido"}</p>
                      <p className="text-xs text-gray-500">{fmtSize(disk.size)} · {disk.style}</p>
                    </div>
                    {locked && <span className="text-[9px] font-bold bg-red-900/60 text-red-400 px-1.5 py-0.5 rounded shrink-0">SISTEMA</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CloneDisk({ onCloningChange }) {
  const [disks, setDisks]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [source, setSource]       = useState(null);
  const [dest, setDest]           = useState(null);
  const [cloning, setCloning]       = useState(false);
  const [progress, setProgress]     = useState(null);
  const [cloneError, setCloneError] = useState(null);
  const [done, setDone]             = useState(false);
  const [statusMsg, setStatusMsg]   = useState(null);
  const [expandPartition, setExpandPartition] = useState(true);
  const unlistenRef               = useRef(null);
  const unlistenStatusRef         = useRef(null);

  const loadDisks = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke("list_disks");
      setDisks(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDisks();
    return () => {
      if (unlistenRef.current) unlistenRef.current();
      if (unlistenStatusRef.current) unlistenStatusRef.current();
    };
  }, []);

  useEffect(() => {
    onCloningChange?.(cloning);
  }, [cloning]);

  const canStart = source && dest && !source.isSystem && !source.isBoot
    && !dest.isSystem && !dest.isBoot
    && dest.size >= source.size && !cloning;

  const destWarning = dest && source && dest.size < source.size
    ? `El destino (${fmtSize(dest.size)}) es más chico que el origen (${fmtSize(source.size)})`
    : null;

  const handleStart = async () => {
    if (!canStart) return;
    setCloneError(null);
    setDone(false);
    setProgress(null);
    setStatusMsg(null);
    setCloning(true);

    unlistenRef.current = await listen("clone-progress", (event) => {
      setProgress(event.payload);
    });
    unlistenStatusRef.current = await listen("clone-status", (event) => {
      setStatusMsg(event.payload.message);
    });

    try {
      const destLetters = (dest.partitions || [])
        .map(p => p.letter)
        .filter(l => l && l.length > 0);
      await invoke("start_clone", {
        sourceIndex: source.index,
        destIndex: dest.index,
        destLetters,
        expandPartition,
      });
      setDone(true);
    } catch (e) {
      setCloneError(String(e));
    } finally {
      setCloning(false);
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
      if (unlistenStatusRef.current) { unlistenStatusRef.current(); unlistenStatusRef.current = null; }
    }
  };

  const handleCancel = async () => {
    try { await invoke("cancel_clone"); } catch (_) {}
  };

  const handleClearSelection = () => {
    setSource(null);
    setDest(null);
    setProgress(null);
    setCloneError(null);
    setDone(false);
    setStatusMsg(null);
  };

  const percent = progress ? Math.round((progress.copied / progress.total) * 100) : 0;

  return (
    <div className="h-full flex flex-col p-5 gap-5 overflow-y-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Clonar Disco</h2>
          <p className="text-xs text-gray-500 mt-0.5">Copia sector a sector — boot, particiones y todo el contenido</p>
        </div>
        <div className="flex items-center gap-2">
          {(source || dest) && (
            <button
              onClick={handleClearSelection}
              disabled={cloning}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-400 transition-colors disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Limpiar selección
            </button>
          )}
          <button
            onClick={loadDisks}
            disabled={loading || cloning}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-400 transition-colors disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Actualizar
          </button>
        </div>
      </div>

      {/* ── Error de carga ──────────────────────────────────────────────────── */}
      {error && (
        <div className="shrink-0 flex items-start gap-3 p-3 bg-red-950/30 border border-red-900/40 rounded-xl text-sm text-red-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0 mt-0.5">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      )}

      {/* ── Selectores de disco ─────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 animate-spin mr-2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Leyendo discos...
        </div>
      ) : (
        <>
          <div className="flex gap-4 shrink-0">
            <DiskSelector
              disks={disks}
              selected={source}
              onSelect={setSource}
              label="Origen"
              excludeIndex={dest?.index}
              disabled={cloning}
            />

            {/* Flecha central */}
            <div className="flex items-center justify-center pt-6 shrink-0">
              <div className="flex flex-col items-center gap-1 text-gray-600">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                <span className="text-[9px] font-mono">CLONAR</span>
              </div>
            </div>

            <DiskSelector
              disks={disks}
              selected={dest}
              onSelect={setDest}
              label="Destino"
              excludeIndex={source?.index}
              disabled={cloning}
            />
          </div>

          {/* ── Advertencias ──────────────────────────────────────────────── */}
          {destWarning && !cloning && (
            <div className="shrink-0 flex items-start gap-2 p-3 bg-yellow-950/30 border border-yellow-900/40 rounded-xl text-xs text-yellow-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0 mt-0.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              {destWarning}
            </div>
          )}

          {/* ── Opción: extender partición ────────────────────────────────── */}
          {source && dest && dest.size > source.size && !cloning && !destWarning && (
            <label className="shrink-0 flex items-center gap-2.5 px-3 py-2 bg-gray-800/50 border border-gray-700 rounded-xl cursor-pointer hover:bg-gray-800 transition-colors">
              <input
                type="checkbox"
                checked={expandPartition}
                onChange={e => setExpandPartition(e.target.checked)}
                className="accent-blue-500 w-3.5 h-3.5"
              />
              <div>
                <p className="text-xs font-medium text-gray-200">
                  Extender última partición al espacio disponible
                </p>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  Usa los {fmtSize(dest.size - source.size)} extra del disco destino automáticamente
                </p>
              </div>
            </label>
          )}

          {/* ── Aviso general ─────────────────────────────────────────────── */}
          {source && dest && !destWarning && !cloning && !done && (
            <div className="shrink-0 flex items-start gap-2 p-3 bg-orange-950/20 border border-orange-900/30 rounded-xl text-xs text-orange-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0 mt-0.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>
                <strong>Todo el contenido del disco destino será sobreescrito</strong> sin recuperación posible.
                Asegurate de que no tenga datos importantes antes de continuar.
              </span>
            </div>
          )}

          {/* ── Progreso ──────────────────────────────────────────────────── */}
          {(cloning || (done && progress) || cloneError) && (
            <div className="shrink-0 flex flex-col gap-3 p-4 bg-gray-800/40 border border-gray-700 rounded-xl">

              {/* Mensaje de estado (preparando / copiando / listo) */}
              {statusMsg && !cloneError && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  {cloning && !progress && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 shrink-0 animate-spin text-blue-400">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  )}
                  <span className={done && !cloneError ? "text-emerald-400" : ""}>{statusMsg}</span>
                </div>
              )}

              {cloneError ? (
                <div className="flex items-start gap-2 text-sm text-red-400">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0 mt-0.5">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {cloneError}
                </div>
              ) : done ? (
                <div className="flex items-center gap-2 text-sm text-emerald-400">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  Clonación completada correctamente
                </div>
              ) : null}

              {progress && (
                <>
                  <div className="relative h-2.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${done && !cloneError ? "bg-emerald-500" : "bg-blue-500"}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span className="font-mono tabular-nums">{fmtSize(progress.copied)} / {fmtSize(progress.total)}</span>
                    <span className="font-mono tabular-nums font-semibold text-gray-200">{percent}%</span>
                    <div className="flex items-center gap-3">
                      {cloning && progress.speedMbps > 0 && (
                        <span>{progress.speedMbps.toFixed(0)} MB/s</span>
                      )}
                      {cloning && progress.etaSeconds > 0 && (
                        <span>Restante: {fmtEta(progress.etaSeconds)}</span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Botones ───────────────────────────────────────────────────── */}
          <div className="shrink-0 flex gap-3">
            {cloning ? (
              <button
                onClick={handleCancel}
                className="flex-1 py-2.5 bg-red-700 hover:bg-red-600 rounded-xl text-sm font-semibold transition-colors"
              >
                Cancelar clonación
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={!canStart}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-colors"
              >
                {done ? "Clonar de nuevo" : "Iniciar clonación"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
