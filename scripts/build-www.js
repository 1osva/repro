// Copia solo los archivos de la app web a ./www (la carpeta que empaqueta Capacitor).
// Así no se cuelan .git, node_modules ni archivos de configuración dentro del APK.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const entries = ['index.html', 'manifest.json', 'css', 'js', 'icons', 'fonts'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const name of entries) {
  const src = path.join(root, name);
  if (!fs.existsSync(src)) {
    console.error(`Falta ${name} en la raíz del proyecto`);
    process.exit(1);
  }
  fs.cpSync(src, path.join(out, name), { recursive: true });
}
// Marca de compilación: se ve en Ajustes > Acerca de, para saber qué APK está instalado
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
const commit = (process.env.GITHUB_SHA || '').slice(0, 7);
fs.writeFileSync(path.join(out, 'build-info.js'), `window.NOCTURNE_BUILD = ${JSON.stringify({ date, commit })};\n`);

console.log('www/ listo:', entries.join(', '), '(+ build-info.js)');
