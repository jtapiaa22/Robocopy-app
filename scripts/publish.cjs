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

function capture(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function findIn(dir, pred) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(pred).map(f => path.join(dir, f));
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n🚀  RoboCopy GUI ${tag} — build local + publish\n`);

// 1. Sin cambios sin commitear
const dirty = capture("git status --porcelain");
if (dirty) {
  console.error("❌  Tenés cambios sin commitear. Hacé commit primero.");
  process.exit(1);
}

// 2. Tag no debe existir todavía
try {
  capture(`git rev-parse ${tag}`);
  console.error(`❌  El tag ${tag} ya existe. Actualizá la versión en package.json.`);
  process.exit(1);
} catch (_) {}

// 3. Clave de firma: env → archivo .tauri-signing-key
let signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!signingKey) {
  const keyFile = path.join(__dirname, "../.tauri-signing-key");
  if (fs.existsSync(keyFile)) {
    signingKey = fs.readFileSync(keyFile, "utf-8").trim();
    console.log("🔑  Clave cargada desde .tauri-signing-key");
  } else {
    console.error("❌  No se encontró la clave de firma.");
    console.error("    Opción A: exportá TAURI_SIGNING_PRIVATE_KEY como variable de entorno.");
    console.error("    Opción B: guardá la clave en .tauri-signing-key (está en .gitignore).");
    process.exit(1);
  }
} else {
  console.log("🔑  Clave cargada desde variable de entorno.");
}

// 4. Compilar
console.log("\n🔨  Compilando (puede tardar varios minutos)...\n");
run("npm run tauri build", {
  TAURI_SIGNING_PRIVATE_KEY: signingKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
});

// 5. Localizar artefactos
const bundleDir = path.join(__dirname, "../src-tauri/target/release/bundle");
const nsisDir   = path.join(bundleDir, "nsis");
const msiDir    = path.join(bundleDir, "msi");

const nsisExe  = findIn(nsisDir, f => f.endsWith("-setup.exe"));
const nsisZip  = findIn(nsisDir, f => f.endsWith(".nsis.zip") && !f.endsWith(".sig"));
const nsisSig  = findIn(nsisDir, f => f.endsWith(".nsis.zip.sig"));
const msiFile  = findIn(msiDir,  f => f.endsWith(".msi") && !f.endsWith(".zip"));
const msiZip   = findIn(msiDir,  f => f.endsWith(".msi.zip") && !f.endsWith(".sig"));
const msiSig   = findIn(msiDir,  f => f.endsWith(".msi.zip.sig"));

if (!nsisZip[0] || !nsisSig[0]) {
  console.error("❌  No se encontraron los archivos NSIS en target/release/bundle/nsis/");
  console.error("    Verificá que el build terminó sin errores.");
  process.exit(1);
}

// 6. Tag + push
console.log(`\n📌  Creando tag ${tag}...`);
run(`git tag ${tag}`);
run("git push origin main");
run(`git push origin ${tag}`);

// 7. Release en GitHub
console.log("\n📦  Creando release en GitHub...");
run(`gh release create ${tag} --title "RoboCopy GUI ${tag}" --notes "Nueva versión ${tag}" --repo ${REPO}`);

// 8. Subir todos los instaladores
const toUpload = [...nsisExe, ...nsisZip, ...nsisSig, ...msiFile, ...msiZip, ...msiSig].filter(Boolean);

for (const file of toUpload) {
  console.log(`📤  Subiendo ${path.basename(file)}...`);
  run(`gh release upload ${tag} "${file}" --repo ${REPO}`);
}

// 9. Generar latest.json para el auto-updater de Tauri
const sig     = fs.readFileSync(nsisSig[0], "utf-8").trim();
const zipName = path.basename(nsisZip[0]);
const url     = `https://github.com/${REPO}/releases/download/${tag}/${zipName.replace(/ /g, "%20")}`;

const latestJson = {
  version,
  notes:    `Nueva versión de RoboCopy GUI ${tag}.`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature: sig, url },
  },
};

const latestPath = path.join(__dirname, "../latest.json");
fs.writeFileSync(latestPath, JSON.stringify(latestJson, null, 2));

console.log("📤  Subiendo latest.json...");
run(`gh release upload ${tag} "${latestPath}" --repo ${REPO}`);

console.log(`\n✅  Release ${tag} publicado!`);
console.log(`   https://github.com/${REPO}/releases/tag/${tag}\n`);
