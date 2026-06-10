import { useState } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export default function Actualizador() {
  const [verificando, setVerificando] = useState(false)
  const [descargando, setDescargando] = useState(false)
  const [progreso, setProgreso] = useState(0)
  const [alerta, setAlerta] = useState(null)
  const [confirmar, setConfirmar] = useState(null)

  const verificar = async () => {
    try {
      setVerificando(true)
      const update = await check()

      if (update?.available) {
        setConfirmar({
          mensaje: `Hay una nueva versión disponible (v${update.version}). ¿Querés descargar e instalar ahora?`,
          onConfirmar: async () => {
            setConfirmar(null)
            setDescargando(true)
            setProgreso(0)

            let downloaded = 0
            let total = 0

            await update.downloadAndInstall((event) => {
              if (event.event === 'Started') {
                total = event.data.contentLength ?? 0
              } else if (event.event === 'Progress') {
                downloaded += event.data.chunkLength ?? 0
                if (total > 0) setProgreso(Math.floor((downloaded / total) * 100))
              } else if (event.event === 'Finished') {
                setProgreso(100)
              }
            })

            setDescargando(false)
            setAlerta({ tipo: 'success', mensaje: 'La app se reiniciará automáticamente para instalar la actualización.' })
            await relaunch()
          },
        })
      } else {
        setAlerta({ tipo: 'info', mensaje: 'Ya tenés la última versión instalada.' })
      }
    } catch {
      setAlerta({ tipo: 'error', mensaje: 'No se pudo verificar actualizaciones. Revisá tu conexión.' })
    } finally {
      setVerificando(false)
    }
  }

  const ocupado = verificando || descargando

  return (
    <>
      {alerta && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <p className="text-sm text-gray-200 mb-5 leading-relaxed">{alerta.mensaje}</p>
            <button
              onClick={() => setAlerta(null)}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold transition-colors"
            >
              Entendido
            </button>
          </div>
        </div>
      )}

      {confirmar && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <p className="text-sm text-gray-200 mb-5 leading-relaxed">{confirmar.mensaje}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmar(null)}
                className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-semibold transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={confirmar.onConfirmar}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold transition-colors"
              >
                Descargar
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="w-full">
        {descargando && (
          <div className="mb-3">
            <div className="flex justify-between text-xs text-gray-500 mb-1.5">
              <span>Descargando actualización...</span>
              <span>{progreso}%</span>
            </div>
            <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${progreso}%` }}
              />
            </div>
          </div>
        )}

        <button
          onClick={verificar}
          disabled={ocupado}
          className="w-full py-2 px-4 rounded-full border border-gray-700 bg-gray-800/60 text-purple-300 text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-800 transition-all"
        >
          {ocupado && (
            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
            </svg>
          )}
          {descargando
            ? `Descargando... ${progreso}%`
            : verificando
              ? 'Verificando actualizaciones...'
              : 'Buscar actualizaciones'}
        </button>
      </div>
    </>
  )
}
