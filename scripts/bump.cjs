"use strict";

const fs   = require("fs");
const path = require("path");

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error("Uso: npm run bump <version>  →  ejemplo: npm run bump 2.2.0");
  process.exit(1);
}

const pkgPath   = path.resolve(__dirname, "../package.json");
const tauriPath = path.resolve(__dirname, "../src-tauri/tauri.conf.json");

const pkg   = JSON.parse(fs.readFileSync(pkgPath,   "utf-8"));
const tauri = JSON.parse(fs.readFileSync(tauriPath, "utf-8"));

const prev = pkg.version;

pkg.version   = newVersion;
tauri.version = newVersion;

fs.writeFileSync(pkgPath,   JSON.stringify(pkg,   null, 2) + "\n");
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + "\n");

console.log(`\n✓  ${prev}  →  ${newVersion}`);
console.log(`   package.json + tauri.conf.json actualizados`);
console.log(`\n   Siguiente paso:`);
console.log(`   git add package.json src-tauri/tauri.conf.json`);
console.log(`   git commit -m "v${newVersion}"`);
console.log(`   npm run publish\n`);
