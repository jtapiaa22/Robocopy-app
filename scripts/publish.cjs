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

// Crea un ZIP con método STORED (método 0) en puro Node.js.
// El crate zip de Rust soporta STORED incondicionalmente, sin importar qué features tenga compiladas.
function createStoredZip(zipPath, filePath) {
  const name = path.basename(filePath);
  const data = fs.readFileSync(filePath);
  const size = data.length;
  const nameLen = Buffer.byteLength(name, "utf8");

  // CRC-32
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < size; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  // Local file header
  const lh = Buffer.alloc(30 + nameLen);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0,  6);
  lh.writeUInt16LE(0,  8);   // compression: STORED
  lh.writeUInt16LE(0, 10);
  lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc,  14);
  lh.writeUInt32LE(size, 18);
  lh.writeUInt32LE(size, 22);
  lh.writeUInt16LE(nameLen, 26);
  lh.writeUInt16LE(0, 28);
  lh.write(name, 30, "utf8");

  // Central directory record
  const cd = Buffer.alloc(46 + nameLen);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0,  8);
  cd.writeUInt16LE(0, 10);   // compression: STORED
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc,  16);
  cd.writeUInt32LE(size, 20);
  cd.writeUInt32LE(size, 24);
  cd.writeUInt16LE(nameLen, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42);   // local header offset = 0
  cd.write(name, 46, "utf8");

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameLen,        12);  // cd size
  eocd.writeUInt32LE(30 + nameLen + size, 16);  // cd offset
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([lh, data, cd, eocd]));
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

// Tauri 2 acepta la ruta del archivo directamente → evita problemas de encoding en Windows
const signingKey = fs.existsSync(keyFile)
  ? keyFile
  : process.env.TAURI_SIGNING_PRIVATE_KEY;
console.log("🔑  Clave de firma cargada.");

// ── Build ─────────────────────────────────────────────────────────────────────

console.log("\n🔨  Compilando (puede tardar varios minutos)...\n");
run("npm run tauri build", {
  TAURI_SIGNING_PRIVATE_KEY: signingKey,
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

  const zipName = path.basename(nsisExe).replace("-setup.exe", "-setup.nsis.zip");
  nsisZip = path.join(nsisDir, zipName);
  console.log(`   Comprimiendo ${path.basename(nsisExe)}...`);
  createStoredZip(nsisZip, nsisExe);
  console.log(`   ✓ ZIP creado (STORED).`);

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
