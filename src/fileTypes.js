// Colores y etiqueta por tipo de archivo (vista de copia en vivo y Explorador)

export function getFileType(ext) {
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
