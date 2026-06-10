import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Iconos SVG inline ───────────────────────────────────────────────────────

function IconFolder({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
    </svg>
  );
}

function IconFile({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  );
}

function IconDrive({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function IconArrowUp({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function IconChevron({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp * 1000);
  return d.toLocaleDateString("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// Genera el array de partes del breadcrumb a partir de una ruta Windows
function parseBreadcrumbs(path) {
  if (!path) return [];
  // Normaliza separadores
  const normalized = path.replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  // Reconstruye las rutas acumuladas: C: → C:\ → C:\Users → ...
  return parts.map((part, i) => {
    const accumulated = parts.slice(0, i + 1).join("\\");
    // Para la raíz del disco, aseguramos la barra final
    const fullPath = i === 0 ? accumulated + "\\" : accumulated;
    return { label: part, path: fullPath };
  });
}

// ─── Componente principal ────────────────────────────────────────────────────

export default function FileBrowser({ onSelectSource, onSelectDest, sourcePath, destPath }) {
  const [drives, setDrives] = useState([]);
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [checkedItems, setCheckedItems] = useState(new Set());
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const listRef = useRef(null);
  const pathInputRef = useRef(null);

  useEffect(() => {
    loadDrives();
    const unlistenPromise = listen("drives-changed", (event) => {
      setDrives(event.payload);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  async function loadDrives() {
    try {
      const d = await invoke("list_drives");
      setDrives(d);
    } catch (e) {
      setError("No se pudieron cargar los discos: " + e);
    }
  }

  function toggleCheck(e, entry) {
    e.stopPropagation();
    setCheckedItems(prev => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  async function navigateTo(path) {
    setLoading(true);
    setError("");
    setSelected(null);
    setCheckedItems(new Set());
    try {
      const items = await invoke("list_directory", { path });
      setEntries(items);
      setCurrentPath(path);
      // Scroll al inicio de la lista
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (e) {
      setError(`No se pudo abrir "${path}": ${e}`);
    }
    setLoading(false);
  }

  async function goUp() {
    if (!currentPath) return;
    const parent = await invoke("get_parent_path", { path: currentPath });
    if (parent) {
      navigateTo(parent);
    } else {
      setCurrentPath("");
      setEntries([]);
      setSelected(null);
      setCheckedItems(new Set());
    }
  }

  function handleDoubleClick(entry) {
    if (entry.is_dir) {
      navigateTo(entry.path);
    }
  }

  function handleClick(entry) {
    setSelected(entry.path === selected ? null : entry.path);
  }

  function startEditPath() {
    setPathInput(currentPath);
    setEditingPath(true);
    setTimeout(() => { pathInputRef.current?.select(); }, 0);
  }

  function commitPath() {
    const trimmed = pathInput.trim();
    setEditingPath(false);
    if (trimmed && trimmed !== currentPath) navigateTo(trimmed);
  }

  function handlePathKeyDown(e) {
    if (e.key === "Enter") commitPath();
    if (e.key === "Escape") setEditingPath(false);
  }

  const breadcrumbs = parseBreadcrumbs(currentPath);

  // Carpeta actualmente visible (para los botones de selección)
  const currentFolder = currentPath || null;

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100">

      {/* ── Barra de discos ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-800 flex-wrap">
        <span className="text-xs text-gray-500 uppercase tracking-wider mr-1">Discos</span>
        {drives.map((drive) => (
          <button
            key={drive.letter}
            onClick={() => navigateTo(drive.root)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors
              ${currentPath.startsWith(drive.letter)
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
          >
            <IconDrive className="w-3.5 h-3.5" />
            {drive.letter}
          </button>
        ))}
        <button
          onClick={loadDrives}
          title="Actualizar discos"
          className="ml-auto p-1.5 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* ── Breadcrumb + botón subir ─────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 py-2 bg-gray-900 border-b border-gray-800 min-h-[38px]">
        <button
          onClick={goUp}
          disabled={!currentPath}
          className="p-1 rounded hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors mr-1 shrink-0"
          title="Subir un nivel"
        >
          <IconArrowUp className="w-4 h-4" />
        </button>

        {editingPath ? (
          /* ── Modo edición: input de ruta ── */
          <input
            ref={pathInputRef}
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={handlePathKeyDown}
            onBlur={commitPath}
            className="selectable flex-1 bg-gray-800 border border-blue-500 rounded px-2 py-0.5 text-sm font-mono text-gray-100 focus:outline-none"
            placeholder="C:\ruta\a\carpeta"
            spellCheck={false}
          />
        ) : (
          /* ── Modo normal: breadcrumb clickeable ── */
          <div
            className="flex items-center gap-1 flex-1 min-w-0 cursor-text group"
            onClick={startEditPath}
            title="Clic para escribir una ruta"
          >
            {breadcrumbs.length === 0 ? (
              <span className="text-xs text-gray-600 italic">Selecciona un disco o haz clic aquí para escribir una ruta</span>
            ) : (
              breadcrumbs.map((crumb, i) => (
                <span key={crumb.path} className="flex items-center gap-1 shrink-0">
                  {i > 0 && <IconChevron className="w-3 h-3 text-gray-600" />}
                  <button
                    onClick={e => { e.stopPropagation(); navigateTo(crumb.path); }}
                    className={`text-sm px-1 rounded hover:text-white transition-colors
                      ${i === breadcrumbs.length - 1
                        ? "text-gray-200 font-medium"
                        : "text-gray-500 hover:bg-gray-700"
                      }`}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))
            )}
            {/* Icono lápiz — aparece al hover */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="w-3 h-3 text-gray-700 group-hover:text-gray-500 transition-colors ml-1 shrink-0">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </div>
        )}
      </div>

      {/* ── Lista de archivos ────────────────────────────────────────────── */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {/* Cabecera de columnas */}
        {currentPath && (
          <div className="grid grid-cols-[28px_1fr_100px_100px] gap-2 px-4 py-1.5 text-xs text-gray-600 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-950">
            <span />
            <span>Nombre</span>
            <span className="text-right">Tamaño</span>
            <span className="text-right">Modificado</span>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-32 text-gray-500">
            <svg className="animate-spin w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            Cargando...
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 px-4 py-3 bg-red-950 border border-red-800 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {!loading && !error && !currentPath && (
          <div className="flex flex-col items-center justify-center h-48 text-gray-600">
            <IconDrive className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">Haz clic en un disco para empezar a explorar</p>
          </div>
        )}

        {!loading && entries.map((entry) => (
          <div
            key={entry.path}
            onClick={() => handleClick(entry)}
            onDoubleClick={() => handleDoubleClick(entry)}
            className={`grid grid-cols-[28px_1fr_100px_100px] gap-2 items-center px-4 py-2 cursor-pointer
              border-b border-gray-900 select-none transition-colors
              ${checkedItems.has(entry.path)
                ? "bg-blue-950/50"
                : selected === entry.path
                  ? "bg-blue-900/40 border-l-2 border-l-blue-500"
                  : "hover:bg-gray-900"
              }`}
          >
            <div className="flex items-center justify-center" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={checkedItems.has(entry.path)}
                onChange={e => toggleCheck(e, entry)}
                className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
              />
            </div>
            <div className="flex items-center gap-2.5 min-w-0">
              {entry.is_dir
                ? <IconFolder className="w-4 h-4 text-yellow-400 shrink-0" />
                : <IconFile className="w-4 h-4 text-gray-500 shrink-0" />
              }
              <span className={`text-sm truncate ${entry.is_dir ? "text-gray-100" : "text-gray-300"}`}>
                {entry.name}
              </span>
            </div>
            <span className="text-xs text-gray-500 text-right">
              {formatSize(entry.size)}
            </span>
            <span className="text-xs text-gray-600 text-right">
              {formatDate(entry.modified)}
            </span>
          </div>
        ))}
      </div>

      {/* ── Botones de acción ────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-900 border-t border-gray-800">
        {currentFolder ? (
          <>
            <div className="flex-1 min-w-0">
              {checkedItems.size > 0 ? (
                <p className="text-xs text-blue-400">
                  {checkedItems.size} elemento{checkedItems.size !== 1 ? "s" : ""} seleccionado{checkedItems.size !== 1 ? "s" : ""}
                  <button
                    onClick={() => setCheckedItems(new Set())}
                    className="ml-2 text-gray-600 hover:text-gray-400 transition-colors underline"
                  >
                    limpiar
                  </button>
                </p>
              ) : (
                <p className="text-xs text-gray-500 truncate" title={currentFolder}>
                  Carpeta actual: <span className="text-gray-300">{currentFolder}</span>
                </p>
              )}
            </div>
            <button
              onClick={() => {
                const checked = entries.filter(e => checkedItems.has(e.path));
                const files   = checked.filter(e => !e.is_dir).map(e => e.name);
                const folders = checked.filter(e =>  e.is_dir).map(e => e.name);
                onSelectSource(currentFolder, files, folders);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${sourcePath === currentFolder
                  ? "bg-emerald-600 text-white"
                  : "bg-emerald-900 hover:bg-emerald-700 text-emerald-300"
                }`}
            >
              {sourcePath === currentFolder
                ? "✓ Origen"
                : checkedItems.size > 0
                  ? (() => {
                      const checked  = entries.filter(e => checkedItems.has(e.path));
                      const nFolders = checked.filter(e => e.is_dir).length;
                      const nFiles   = checked.filter(e => !e.is_dir).length;
                      const parts    = [];
                      if (nFolders) parts.push(`${nFolders} carp.`);
                      if (nFiles)   parts.push(`${nFiles} arch.`);
                      return `Origen (${parts.join(", ")})`;
                    })()
                  : "Usar como Origen"}
            </button>
            <button
              onClick={() => onSelectDest(currentFolder)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${destPath === currentFolder
                  ? "bg-purple-600 text-white"
                  : "bg-purple-900 hover:bg-purple-700 text-purple-300"
                }`}
            >
              {destPath === currentFolder ? "✓ Destino" : "Usar como Destino"}
            </button>
          </>
        ) : (
          <p className="text-xs text-gray-600 italic">Navega a una carpeta para seleccionarla como origen o destino</p>
        )}
      </div>
    </div>
  );
}
