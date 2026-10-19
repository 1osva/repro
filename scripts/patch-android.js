// Instala los módulos nativos de Nocturne en el proyecto Android que genera
// `npx cap add android`:
//   - MediaLibrary: lee la música del teléfono (permiso de música).
//   - MediaControls + MediaNotificationService: notificación de música y reproducción en
//     segundo plano (servicio en primer plano + MediaSession).
// Se ejecuta solo, mediante el hook "capacitor:update:after" de package.json.
// Es idempotente: se puede ejecutar varias veces sin duplicar nada.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = config.appId;
const androidDir = path.join(root, 'android');
const mainDir = path.join(androidDir, 'app', 'src', 'main');
const javaDir = path.join(mainDir, 'java', ...appId.split('.'));
const resDrawableDir = path.join(mainDir, 'res', 'drawable');
const manifestPath = path.join(mainDir, 'AndroidManifest.xml');

function fail(msg) {
  console.error('patch-android: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(androidDir)) fail('no existe android/. Ejecuta antes: npx cap add android');
if (!fs.existsSync(javaDir)) fail('no existe ' + javaDir + ' (¿cambió el appId?)');

// 1) Código nativo: se sustituye el paquete por el appId
const javaFiles = ['MediaLibraryPlugin.java', 'MediaControlsPlugin.java', 'MediaNotificationService.java', 'NativeAudioPlayer.java', 'SpectrumProcessor.java', 'NativePlayerPlugin.java', 'MainActivity.java'];
for (const file of javaFiles) {
  const src = fs.readFileSync(path.join(root, 'native', file), 'utf8').replace(/__APP_PACKAGE__/g, appId);
  fs.writeFileSync(path.join(javaDir, file), src);
  console.log('  + ' + path.relative(root, path.join(javaDir, file)));
}

// 2) Iconos de la notificación
const iconsSrc = path.join(root, 'native', 'res', 'drawable');
fs.mkdirSync(resDrawableDir, { recursive: true });
for (const file of fs.readdirSync(iconsSrc)) {
  fs.copyFileSync(path.join(iconsSrc, file), path.join(resDrawableDir, file));
  console.log('  + ' + path.relative(root, path.join(resDrawableDir, file)));
}

// 3) Manifest: permisos y servicio
let manifest = fs.readFileSync(manifestPath, 'utf8');
const permissions = [
  '<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />'
];
const anchor = '<uses-permission android:name="android.permission.INTERNET" />';
if (!manifest.includes(anchor)) fail('no encontré el permiso INTERNET en AndroidManifest.xml para anclar los nuevos');

let added = 0;
for (const line of permissions) {
  const name = line.match(/android:name="([^"]+)"/)[1];
  if (!manifest.includes(`android:name="${name}"`)) {
    manifest = manifest.replace(anchor, anchor + '\n    ' + line);
    added++;
  }
}

const serviceName = `${appId}.MediaNotificationService`;
if (!manifest.includes(`android:name="${serviceName}"`)) {
  if (!manifest.includes('</application>')) fail('no encontré </application> en AndroidManifest.xml');
  const service =
    `        <service\n` +
    `            android:name="${serviceName}"\n` +
    `            android:exported="false"\n` +
    `            android:foregroundServiceType="mediaPlayback" />\n    `;
  manifest = manifest.replace('</application>', service + '</application>');
  added++;
}

fs.writeFileSync(manifestPath, manifest);
console.log('  + AndroidManifest.xml: ' + added + ' elemento(s) nuevo(s)');
// 4) Gradle: Media3 (ExoPlayer) para el reproductor nativo
const gradlePath = path.join(androidDir, 'app', 'build.gradle');
if (!fs.existsSync(gradlePath)) fail('no existe ' + gradlePath);
let gradle = fs.readFileSync(gradlePath, 'utf8');
const MEDIA3 = '1.8.0';
if (!gradle.includes('androidx.media3:media3-exoplayer')) {
  const idx = gradle.lastIndexOf('dependencies {');
  if (idx < 0) fail('no encontré el bloque dependencies en app/build.gradle');
  const at = idx + 'dependencies {'.length;
  gradle = gradle.slice(0, at) +
    `\n    implementation "androidx.media3:media3-exoplayer:${MEDIA3}"` +
    `\n    implementation "androidx.media3:media3-common:${MEDIA3}"` +
    gradle.slice(at);
  fs.writeFileSync(gradlePath, gradle);
  console.log('  + app/build.gradle: Media3 ' + MEDIA3);
}

console.log('patch-android: listo');
