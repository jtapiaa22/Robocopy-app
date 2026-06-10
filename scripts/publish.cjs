"use strict";

const { execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const { version } = require("../package.json");
const tag  = `v${version}`;
const REPO = "jtapiaa22/Robocopy-app";

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, extraEnv = {}) {
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

// Captura solo stdout (npm escribe sus propias líneas en stderr)
function capture(cmd, extraEnv = {}) {
  return execSync(cmd, { stdio: "pipe", env: { ...process.env, ...extraEnv } }).toString().trim();
}

// Archivo más reciente que cumpla el predicado
function findNewest(dir, pred) {
  if (!fs.existsSync(dir)) return null;
  const matches = fs.readdirSync(dir)
    .filter(pred)
    .map(name => ({ name, mt: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt);
  return matches.length ? path.join(dir, matches[0].name) : null;
}

function ghUpload(file) {
  console.log(`📤  Subiendo ${path.basename(file)}...`);
  run(`gh release upload "${tag}" "${file}" --repo ${REPO}`);
}

// ── Validaciones ──────────────────────────────────────────────────────────────

console.log(`\n🚀  RoboCopy GUI ${tag} — build local + publish\n`);

const dirty = capture("git status --porcelain");
if (dirty) {
  console.error("❌  Tenés cambios sin commitear. Hacé commit primero.");
  process.exit(1);
}

try {
  capture(`git rev-parse ${tag}`);
  console.error(`❌  El tag ${tag} ya existe. Actualizá la versión en package.json.`);
  process.exit(1);
} catch (_) {}

// ── Clave de firma ────────────────────────────────────────────────────────────

const keyFile = path.resolve(__dirname, "../.tauri-signing-key");
if (!fs.existsSync(keyFile) && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error("❌  No se encontró la clave de firma (.tauri-signing-key)");
  process.exit(1);
}

// En Windows, los saltos de línea en env vars se cortan → base64 evita el problema
const keyRaw    = process.env.TAURI_SIGNING_PRIVATE_KEY || fs.readFileSync(keyFile, "utf-8");
const keyBase64 = Buffer.from(keyRaw).toString("base64");
console.log("🔑  Clave de firma cargada.");

// ── Build ─────────────────────────────────────────────────────────────────────

console.log("\n🔨  Compilando (puede tardar varios minutos)...\n");
run("npm run tauri build", {
  TAURI_SIGNING_PRIVATE_KEY: keyBase64,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
});

// ── Localizar instaladores ────────────────────────────────────────────────────

const bundleDir = path.resolve(__dirname, "../src-tauri/target/release/bundle");
const nsisDir   = path.join(bundleDir, "nsis");
const msiDir    = path.join(bundleDir, "msi");

const isVer = f => f.includes(`_${version}_`);

const nsisExe = findNewest(nsisDir, f => isVer(f) && f.endsWith("-setup.exe"));
const msiFile = findNewest(msiDir,  f => isVer(f) && f.endsWith(".msi") && !f.endsWith(".zip"));

if (!nsisExe) {
  console.error(`❌  No se encontró el instalador NSIS para v${version}.`);
  process.exit(1);
}
console.log(`\n✓  NSIS: ${path.basename(nsisExe)}`);
if (msiFile) console.log(`✓  MSI:  ${path.basename(msiFile)}`);

// ── Zip + firma (auto o manual) ───────────────────────────────────────────────

let nsisZip = findNewest(nsisDir, f => isVer(f) && f.endsWith(".nsis.zip") && !f.endsWith(".sig"));
let nsisSig = findNewest(nsisDir, f => isVer(f) && f.endsWith(".nsis.zip.sig"));

if (!nsisZip || !nsisSig) {
  console.log("\n🔐  El build no firmó automáticamente. Firmando manualmente...");

  // Crear el zip con .NET ZipFile (Deflate estándar, compatible con el crate zip de Tauri)
  const zipName = path.basename(nsisExe).replace("-setup.exe", "-setup.nsis.zip");
  nsisZip = path.join(nsisDir, zipName);
  console.log(`   Comprimiendo ${path.basename(nsisExe)}...`);
  const exeName = path.basename(nsisExe);
  const psContent = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$z = [System.IO.Compression.ZipFile]::Open("${nsisZip}", [System.IO.Compression.ZipArchiveMode]::Create)`,
    `[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, "${nsisExe}", "${exeName}", [System.IO.Compression.CompressionLevel]::Optimal)`,
    "$z.Dispose()",
  ].join("\n");
  const tmpPs1 = path.join(nsisDir, "_zip.ps1");
  fs.writeFileSync(tmpPs1, psContent, "utf-8");
  try {
    run(`powershell -ExecutionPolicy Bypass -NoProfile -File "${tmpPs1}"`);
  } finally {
    try { fs.unlinkSync(tmpPs1); } catch (_) {}
  }

  // Firmar el zip con la CLI de Tauri (crea el .sig automáticamente al lado del zip)
  console.log(`   Firmando ${zipName}...`);
  execSync(`npx tauri signer sign -f "${keyFile}" -p "" "${nsisZip}"`, { stdio: ["inherit", "ignore", "inherit"] });
  nsisSig = `${nsisZip}.sig`;
  if (!fs.existsSync(nsisSig)) {
    console.error("❌  No se encontró el archivo .sig después de firmar.");
    process.exit(1);
  }
  console.log("   ✓ Firma generada.");
}

// ── Tag + push ────────────────────────────────────────────────────────────────

console.log(`\n📌  Creando tag ${tag}...`);
run(`git tag ${tag}`);
run("git push origin main");
run(`git push origin ${tag}`);

// ── Release ───────────────────────────────────────────────────────────────────

console.log("\n📦  Creando release en GitHub...");
run(`gh release create "${tag}" --title "RoboCopy GUI ${tag}" --notes "Nueva versión ${tag}" --repo ${REPO}`);

// ── Subir archivos ────────────────────────────────────────────────────────────

const toUpload = [nsisExe, nsisZip, nsisSig, msiFile].filter(Boolean);
for (const file of toUpload) ghUpload(file);

// ── latest.json ───────────────────────────────────────────────────────────────

const sig     = fs.readFileSync(nsisSig, "utf-8").trim();
const zipBase = path.basename(nsisZip);
const url     = `https://github.com/${REPO}/releases/download/${tag}/${zipBase.replace(/ /g, ".")}`;

const latestJson = {
  version,
  notes:    `Nueva versión de RoboCopy GUI ${tag}.`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature: sig, url },
  },
};

const latestPath = path.resolve(__dirname, "../latest.json");
fs.writeFileSync(latestPath, JSON.stringify(latestJson, null, 2));
ghUpload(latestPath);

console.log(`\n✅  Release ${tag} publicado!`);
console.log(`   https://github.com/${REPO}/releases/tag/${tag}\n`);
