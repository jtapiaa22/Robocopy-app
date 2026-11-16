import Actualizador from './Actualizador'

const SECTIONS = [
  {
    title: "Modo de copia",
    items: [
      {
        flag: "/E",
        label: "Incluir subcarpetas",
        color: "blue",
        desc: "Copia toda la estructura de carpetas del origen, incluyendo las subcarpetas vacías. Sin esta opción, Robocopy solo copia los archivos que están en el nivel raíz de la carpeta origen.",
        example: 'robocopy "C:\\Docs" "D:\\Backup" /E',
        tip: "Casi siempre querrás activar esta opción.",
      },
      {
        flag: "/MIR",
        label: "Modo espejo",
        color: "yellow",
        desc: "Hace que el destino quede IDÉNTICO al origen. Si borraste un archivo en origen, también lo borrará del destino. Activa /E automáticamente.",
        example: 'robocopy "C:\\Fotos" "D:\\Backup\\Fotos" /MIR',
        tip: "Ideal para backups donde quieres sincronización total. ¡Cuidado: borra archivos en destino!",
        warn: true,
      },
      {
        flag: "/L",
        label: "Modo prueba (simulación)",
        color: "sky",
        desc: "Simula la copia completa SIN mover ni modificar ningún archivo. El output muestra exactamente qué se copiaría, cuántos archivos y cuántos bytes.",
        example: 'robocopy "C:\\Docs" "D:\\Backup" /E /L',
        tip: "Úsalo siempre antes de una copia importante para revisar qué va a pasar.",
      },
      {
        flag: "/Z",
        label: "Modo reiniciable",
        color: "gray",
        desc: "Guarda el progreso de cada archivo mientras copia. Si se corta la luz o la red, puede continuar desde donde quedó en lugar de empezar de cero.",
        example: 'robocopy "C:\\Docs" "\\\\servidor\\backup" /E /Z',
        tip: "Más lento que la copia normal. Recomendado para transferencias largas por red o WiFi.",
      },
      {
        flag: "/B",
        label: "Modo backup",
        color: "gray",
        desc: "Usa privilegios especiales de Windows para copiar archivos que normalmente estarían bloqueados por permisos de seguridad, como archivos del sistema o de otras cuentas de usuario.",
        example: 'robocopy "C:\\Windows\\System32" "D:\\Copia" /B',
        tip: "Requiere administrador: al activarlo, la app te ofrece reiniciarse elevada con la misma configuración.",
      },
      {
        flag: "/XO",
        label: "Excluir archivos más antiguos",
        color: "gray",
        desc: "Si un archivo ya existe en el destino y su fecha es más reciente que la del origen, NO lo sobreescribe. Protege versiones más nuevas que ya tengas en el destino.",
        example: 'robocopy "C:\\Docs" "D:\\Backup" /E /XO',
        tip: "Útil cuando trabajas en ambos lados y no quieres perder cambios recientes del destino.",
      },
    ],
  },
  {
    title: "Control de rendimiento y errores",
    items: [
      {
        flag: "/MT:n",
        label: "Multi-hilo",
        color: "emerald",
        desc: "Copia varios archivos en paralelo al mismo tiempo. El número indica cuántos hilos usar (máx. 128). Por defecto Robocopy copia de a uno.",
        example: 'robocopy "C:\\Fotos" "D:\\Backup" /E /MT:16',
        tip: "Nota: /MT es incompatible con /IPG e /EFSRAW. Si usas /LOG, el orden de líneas puede mezclarse.",
      },
      {
        flag: "/R:n",
        label: "Reintentos",
        color: "gray",
        desc: "Número de veces que Robocopy reintenta copiar un archivo si falla (por ejemplo, si está siendo usado por otro programa). Por defecto son 1.000.000 reintentos, lo que puede dejar la copia colgada horas.",
        example: 'robocopy "C:\\Docs" "D:\\Backup" /E /R:3 /W:5',
        tip: "Recomendamos /R:3 para que salte archivos problemáticos rápido y siga con el resto.",
      },
      {
        flag: "/W:n",
        label: "Espera entre reintentos",
        color: "gray",
        desc: "Segundos que espera entre cada reintento. Combinado con /R define el tiempo máximo que pasa intentando copiar un archivo fallido antes de seguir.",
        example: 'robocopy "C:\\Docs" "D:\\Backup" /E /R:3 /W:5',
        tip: "/R:3 /W:5 = máximo 15 segundos por archivo fallido, luego continúa.",
      },
    ],
  },
  {
    title: "Filtros y exclusiones",
    items: [
      {
        flag: "/XF",
        label: "Excluir archivos",
        color: "red",
        desc: "Excluye archivos que coincidan con los patrones indicados. Puedes usar comodines: * para cualquier texto, ? para un carácter. Puedes agregar múltiples patrones.",
        example: 'robocopy "C:\\Proyecto" "D:\\Backup" /E /XF *.tmp *.log thumbs.db',
        tip: "Muy útil para no copiar archivos temporales, caches, logs o archivos de sistema.",
      },
      {
        flag: "/XD",
        label: "Excluir carpetas",
        color: "red",
        desc: "Excluye carpetas completas que coincidan con los nombres indicados. Toda la carpeta y su contenido serán ignorados.",
        example: 'robocopy "C:\\Proyecto" "D:\\Backup" /E /XD node_modules .git dist __pycache__',
        tip: "Esencial al copiar proyectos de programación — evita copiar cientos de MB de dependencias.",
      },
      {
        flag: "/IF",
        label: "Solo copiar (filtro)",
        color: "cyan",
        desc: "Solo copia los archivos que coincidan con los patrones indicados. Es el opuesto de /XF: en vez de excluir, incluye solo lo que especifiques.",
        example: 'robocopy "C:\\Descargas" "D:\\Fotos" /E /IF *.jpg *.jpeg *.png *.heic',
        tip: "Ideal para extraer solo un tipo de archivo de una carpeta grande. Por ejemplo, solo las fotos.",
      },
      {
        flag: "/MAXAGE:n",
        label: "Edad máxima de archivos",
        color: "cyan",
        desc: "Solo copia archivos que hayan sido modificados en los últimos n días. Excluye archivos más antiguos que ese límite. modo de uso: en fomato de número de días (n) desde la última modificación. Por ejemplo, /MAXAGE:30 copiará solo archivos modificados en los últimos 30 días o tambien en formato de fecha YYYYMMDD, por ejemplo /MAXAGE:20240101 copiará solo archivos modificados después del 1 de enero de 2024.",
        example: 'robocopy "C:\\Docs" "D:\\Backup" /E /MAXAGE:30',
        tip: "Perfecto para hacer copias rápidas de solo los archivos recientes, por ejemplo, tus documentos modificados en el último mes.",
      },
    ],
  },
  {
    title: "Códigos de salida",
    isExitCodes: true,
    items: [
      { code: "0", label: "Sin cambios",        color: "gray",    desc: "No había nada que copiar. El destino ya era idéntico al origen." },
      { code: "1", label: "Copiado OK",          color: "emerald", desc: "Todos los archivos se copiaron correctamente. Todo bien." },
      { code: "2", label: "Extras detectados",   color: "blue",    desc: "Hay archivos en el destino que no existen en el origen. No se copiaron archivos nuevos." },
      { code: "3", label: "Copiado + Extras",    color: "emerald", desc: "Archivos copiados correctamente y además hay archivos extra en destino." },
      { code: "4", label: "Diferencias",         color: "yellow",  desc: "Hay archivos que difieren entre origen y destino (mismatch). Ninguno se copió." },
      { code: "5-7", label: "Parcial/Advertencia", color: "yellow", desc: "Combinaciones de los anteriores. La copia se completó pero con advertencias. Revisa el output." },
      { code: "8+", label: "Con errores",        color: "red",     desc: "Algunos archivos no se pudieron copiar. Busca líneas FAILED en el output para ver cuáles." },
      { code: "16", label: "Error grave",        color: "red",     desc: "Error crítico. Robocopy no pudo copiar nada. Verificar rutas, permisos y que las carpetas existan." },
    ],
  },
];

const COLORS = {
  blue:    { badge: "bg-blue-900 text-blue-300 border-blue-800",    dot: "bg-blue-400"    },
  yellow:  { badge: "bg-yellow-900 text-yellow-300 border-yellow-800", dot: "bg-yellow-400" },
  sky:     { badge: "bg-sky-900 text-sky-300 border-sky-800",       dot: "bg-sky-400"     },
  emerald: { badge: "bg-emerald-900 text-emerald-300 border-emerald-800", dot: "bg-emerald-400" },
  red:     { badge: "bg-red-900 text-red-300 border-red-800",       dot: "bg-red-400"     },
  cyan:    { badge: "bg-cyan-900 text-cyan-300 border-cyan-800",    dot: "bg-cyan-400"    },
  gray:    { badge: "bg-gray-800 text-gray-300 border-gray-700",    dot: "bg-gray-500"    },
};

export default function HelpPanel() {
  return (
    <div className="h-full overflow-y-auto bg-gray-950 text-gray-100">
      <div className="max-w-4xl mx-auto px-6 py-6">

        {/* Cabecera */}
        <div className="mb-8">
          <h1 className="text-xl font-bold text-gray-100 mb-2">Guía de opciones de Robocopy</h1>
          <p className="text-sm text-gray-500">
            Robocopy (Robust File Copy) es una herramienta de Windows para copiar archivos de forma confiable.
            Aquí encontrarás la explicación de cada opción disponible en la app.
          </p>
        </div>

        {SECTIONS.map(section => (
          <div key={section.title} className="mb-10">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4 pb-2 border-b border-gray-800">
              {section.title}
            </h2>

            {section.isExitCodes ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {section.items.map(item => {
                  const c = COLORS[item.color];
                  return (
                    <div key={item.code} className="flex gap-3 p-3 bg-gray-900 rounded-lg border border-gray-800">
                      <span className={`text-lg font-mono font-bold w-10 shrink-0 ${
                        item.color === "emerald" ? "text-emerald-400"
                        : item.color === "yellow" ? "text-yellow-400"
                        : item.color === "red"    ? "text-red-400"
                        : "text-gray-500"}`}>
                        {item.code}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-gray-200">{item.label}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-4">
                {section.items.map(item => {
                  const c = COLORS[item.color] || COLORS.gray;
                  return (
                    <div key={item.flag} className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                      {/* Encabezado de la opción */}
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
                        <span className={`px-2.5 py-1 rounded-md text-sm font-mono font-bold border ${c.badge}`}>
                          {item.flag}
                        </span>
                        <span className="font-semibold text-sm text-gray-100">{item.label}</span>
                        {item.warn && (
                          <span className="ml-auto text-xs text-yellow-500 flex items-center gap-1">
                            ⚠ Puede borrar archivos
                          </span>
                        )}
                      </div>

                      {/* Descripción */}
                      <div className="px-4 py-3">
                        <p className="text-sm text-gray-300 leading-relaxed">{item.desc}</p>

                        {/* Ejemplo */}
                        <div className="mt-3">
                          <p className="text-xs text-gray-600 uppercase tracking-wider mb-1.5">Ejemplo</p>
                          <code className="selectable block text-xs font-mono text-cyan-400 bg-gray-950 rounded-lg px-3 py-2 break-all">
                            {item.example}
                          </code>
                        </div>

                        {/* Tip */}
                        {item.tip && (
                          <div className="flex gap-2 mt-3 p-2.5 bg-gray-800/60 rounded-lg">
                            <span className="text-blue-400 shrink-0 text-sm">💡</span>
                            <p className="text-xs text-gray-400">{item.tip}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {/* Nota al pie */}
        <div className="mt-4 p-4 bg-gray-900 rounded-xl border border-gray-800 text-xs text-gray-500">
          <p className="font-semibold text-gray-400 mb-1">¿Quieres ver todas las opciones de Robocopy?</p>
          <p>Abre el CMD de Windows y escribe <code className="text-cyan-400 font-mono">robocopy /?</code> para ver la documentación completa oficial.</p>
        </div>

        {/* Actualizaciones */}
        <div className="mt-4 mb-8 p-4 bg-gray-900 rounded-xl border border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Actualizaciones</p>
          <Actualizador />
        </div>

      </div>
    </div>
  );
}
