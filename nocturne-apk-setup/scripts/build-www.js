// Copia solo los archivos de la app web a ./www (la carpeta que empaqueta Capacitor).
// Así no se cuelan .git, node_modules ni archivos de configuración dentro del APK.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const entries = ['index.html', 'manifest.json', 'css', 'js', 'icons'];

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
console.log('www/ listo:', entries.join(', '));
