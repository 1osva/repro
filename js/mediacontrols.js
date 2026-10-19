/**
 * NOCTURNE MEDIA CONTROLS
 * Puente con el plugin nativo "MediaControls": la notificación de música (portada de fondo,
 * barra de progreso, botones) y la reproducción en segundo plano. Solo existe en la app Android.
 *
 * La app avisa con sync() cada vez que cambia algo (canción, play/pausa, posición). Este módulo
 * lee el estado actual mediante el "proveedor" y lo manda al sistema; las órdenes que llegan
 * desde la notificación, la pantalla de bloqueo o los audífonos vuelven por onAction().
 */
const NocturneMediaControls = (() => {
  const PERM_KEY = 'nocturne.notifPermissionAsked';

  let provider = null;       // () => { track, playing, position, duration } | null
  let lastTrackId = null;    // última canción enviada (para mandar la portada solo al cambiar)
  let coverToken = 0;        // invalida portadas que llegan tarde de una canción anterior
  let permissionStep = null; // promesa del pedido de permiso (solo una vez)

  function getPlugin() {
    const cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.MediaControls ? cap.Plugins.MediaControls : null;
  }

  /** 'ready' | 'missing-plugin' (Android sin el módulo) | 'web' */
  function status() {
    const cap = window.Capacitor;
    const native = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    if (!native) return 'web';
    return getPlugin() ? 'ready' : 'missing-plugin';
  }

  function isAvailable() { return status() === 'ready'; }
  function setProvider(fn) { provider = fn; }
  const noop = () => {};

  /** Android 13+: pide permiso para mostrar la notificación (una sola vez, al primer play). */
  function ensurePermission() {
    if (permissionStep) return permissionStep;
    const plugin = getPlugin();
    let asked = false;
    try { asked = localStorage.getItem(PERM_KEY) === '1'; } catch (e) { /* sin almacenamiento */ }
    if (!plugin || asked) {
      permissionStep = Promise.resolve();
      return permissionStep;
    }
    try { localStorage.setItem(PERM_KEY, '1'); } catch (e) { /* sin almacenamiento */ }
    permissionStep = Promise.resolve(plugin.requestNotificationPermission()).catch(noop);
    return permissionStep;
  }

  async function notificationPermission() {
    const plugin = getPlugin();
    if (!plugin) return false;
    try {
      const r = await plugin.hasNotificationPermission();
      return !!(r && r.granted);
    } catch (e) {
      return false;
    }
  }

  /** Portada (URL blob o data) → JPEG cuadrado de 512 px en base64, listo para el sistema. */
  function coverToBase64(url) {
    return new Promise((resolve) => {
      if (!url) { resolve(''); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const size = 512;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const side = Math.min(img.naturalWidth, img.naturalHeight) || size;
          const sx = ((img.naturalWidth || side) - side) / 2;
          const sy = ((img.naturalHeight || side) - side) / 2;
          canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
          resolve((canvas.toDataURL('image/jpeg', 0.85).split(',')[1]) || '');
        } catch (e) {
          resolve('');
        }
      };
      img.onerror = () => resolve('');
      img.src = url;
    });
  }

  async function coverFor(track) {
    if (track._notifCoverSrc === track.cover && track._notifCover !== undefined) return track._notifCover;
    const b64 = await coverToBase64(track.cover);
    track._notifCoverSrc = track.cover;
    track._notifCover = b64;
    return b64;
  }

  function payload(s) {
    return {
      title: s.track.title || '',
      artist: s.track.artist || '',
      album: s.track.album || '',
      duration: s.duration || 0,
      position: s.position || 0,
      playing: !!s.playing
    };
  }

  /** Manda al sistema el estado actual. La portada se envía aparte y solo al cambiar de canción. */
  async function sync() {
    const plugin = getPlugin();
    if (!plugin || !provider) return;
    const s = provider();
    if (!s || !s.track) return;

    await ensurePermission();

    if (s.track.id !== lastTrackId) {
      lastTrackId = s.track.id;
      const token = ++coverToken;
      // El texto aparece ya (portada vacía); la portada llega cuando termina de convertirse
      await Promise.resolve(plugin.update(Object.assign(payload(s), { cover: '' }))).catch(noop);
      const b64 = await coverFor(s.track);
      const now = provider();
      if (token === coverToken && b64 && now && now.track && now.track.id === s.track.id) {
        plugin.update(Object.assign(payload(now), { cover: b64 })).catch(noop);
      }
    } else {
      plugin.update(payload(s)).catch(noop);
    }
  }

  /** La portada de la canción actual llegó después de empezar: volver a enviarla. */
  function refreshCover() {
    lastTrackId = null;
    sync();
  }

  /** Quita la notificación y detiene el servicio. */
  function stop() {
    lastTrackId = null;
    coverToken++;
    const plugin = getPlugin();
    if (plugin) Promise.resolve(plugin.stop()).catch(noop);
  }

  /** Órdenes desde la notificación, la pantalla de bloqueo o audífonos Bluetooth. */
  function onAction(handler) {
    const plugin = getPlugin();
    if (!plugin || typeof plugin.addListener !== 'function') return;
    plugin.addListener('mediaAction', (e) => {
      handler(e.action, typeof e.position === 'number' ? e.position : null);
    });
  }

  return { status, isAvailable, setProvider, sync, refreshCover, stop, onAction, notificationPermission };
})();

window.NocturneMediaControls = NocturneMediaControls;
