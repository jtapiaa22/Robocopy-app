const { execSync } = require("child_process");
const { version }  = require("../package.json");

const tag = `v${version}`;

console.log(`\n🚀 Publicando RoboCopy GUI ${tag}...\n`);

try {
  // Verifica que no haya cambios sin commitear
  const status = execSync("git status --porcelain").toString().trim();
  if (status) {
    console.error("❌ Tenés cambios sin commitear. Hacé commit antes de publicar.");
    process.exit(1);
  }

  // Verifica que el tag no exista ya
  try {
    execSync(`git rev-parse ${tag}`, { stdio: "pipe" });
    console.error(`❌ El tag ${tag} ya existe. Actualizá la versión en package.json.`);
    process.exit(1);
  } catch (_) {}

  // Crea el tag y hace push
  execSync(`git tag ${tag}`);
  execSync("git push origin main");
  execSync(`git push origin ${tag}`);

  console.log(`✅ Tag ${tag} subido a GitHub.`);
  console.log(`\n📦 GitHub Actions está compilando el instalador...`);
  console.log(`   Seguí el progreso en: https://github.com/jtapiaa22/Robocopy-app/actions`);
  console.log(`\n   Cuando termine, el release estará en:`);
  console.log(`   https://github.com/jtapiaa22/Robocopy-app/releases\n`);
} catch (e) {
  console.error("❌ Error:", e.message);
  process.exit(1);
}
