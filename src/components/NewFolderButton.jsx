import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

function IconFolderPlus({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}

// Botón "Nueva carpeta": se convierte en un campo para escribir el nombre.
// Crea la carpeta dentro de `parent` y llama a onCreated(rutaCompleta).
// variant: "toolbar" (barra del Explorador) | "field" (al lado del campo de destino)
export default function NewFolderButton({ parent, onCreated, variant = "toolbar", disabledTitle }) {
  const [editing, setEditing] = useState(false);
  const [name, setName]       = useState("");
  const [error, setError]     = useState("");
  const [busy, setBusy]       = useState(false);
  const inputRef = useRef(null);
  const disabled = !parent;

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  // Si cambia la carpeta padre mientras se escribe, se cancela
  useEffect(() => { cancel(); }, [parent]);

  function start() {
    if (disabled) return;
    setName("Nueva carpeta");
    setError("");
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function cancel() {
    setEditing(false);
    setName("");
    setError("");
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      const path = await invoke("create_folder", { parent, name });
      cancel();
      onCreated?.(path);
    } catch (e) {
      setError(String(e));
      inputRef.current?.focus();
    }
    setBusy(false);
  }

  function handleKeyDown(e) {
    e.stopPropagation(); // que Ctrl+A / Esc no lleguen a la lista del Explorador
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  }

  const isField = variant === "field";

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        title={disabled ? (disabledTitle || "Elegí primero una carpeta") : `Crear una carpeta nueva dentro de ${parent}`}
        className={isField
          ? "px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-400 hover:text-purple-300 transition-colors disabled:opacity-40 disabled:hover:bg-gray-800 disabled:hover:text-gray-400 disabled:cursor-not-allowed"
          : "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"}
      >
        <IconFolderPlus className={isField ? "w-4 h-4" : "w-3.5 h-3.5"} />
        {!isField && "Nueva carpeta"}
      </button>
    );
  }

  return (
    <div className={`relative flex items-center gap-1 ${isField ? "" : "shrink-0"}`}>
      <IconFolderPlus className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
      <input
        ref={inputRef}
        value={name}
        onChange={e => { setName(e.target.value); setError(""); }}
        onKeyDown={handleKeyDown}
        disabled={busy}
        placeholder="Nombre de la carpeta"
        className={`selectable bg-gray-800 border rounded-md px-2 py-1 text-xs text-gray-200 focus:outline-none w-40
          ${error ? "border-red-500" : "border-gray-600 focus:border-blue-500"}`}
      />
      <button type="button" onClick={confirm} disabled={busy} title="Crear (Enter)"
        className="px-2 py-1 rounded-md text-xs bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
        Crear
      </button>
      <button type="button" onClick={cancel} title="Cancelar (Esc)"
        className="px-1.5 py-1 rounded-md text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-300">
        ✕
      </button>
      {error && (
        <div className="absolute top-full left-0 mt-1 z-20 px-2 py-1 rounded-md bg-red-950 border border-red-800 text-xs text-red-300 whitespace-nowrap">
          {error}
        </div>
      )}
    </div>
  );
}
