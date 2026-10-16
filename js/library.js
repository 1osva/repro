/**
 * NOCTURNE LIBRARY
 * Puente con el plugin nativo "MediaLibrary" (solo existe dentro de la app Android).
 *
 *  - scan():     pide el permiso de música si falta y devuelve las canciones del teléfono.
 *  - resolve():  lee UNA canción completa a memoria justo antes de sonar.
 *  - release():  libera esa memoria cuando la canción ya no está cerca de la actual.
 *  - requestThumb(): pide la portada (miniatura) de una canción para mostrarla en las listas,
 *                    sin tener que cargar el archivo de audio completo.
 *
 * Por qué resolve() descarga el archivo entero en lugar de usar la URL directa:
 * el servidor interno de Capacitor responde a las peticiones con "Range" (las que
 * hace el reproductor para buscar dentro de una canción) devolviendo siempre el
 * archivo desde el principio. Una petición normal, sin "Range", sí funciona bien.
 */
const NocturneLibrary = (() => {
  function getPlugin() {
    const cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.MediaLibrary ? cap.Plugins.MediaLibrary : null;
  }

  /** true solo dentro de la app Android con el plugin registrado. */
  function isAvailable() {
    const cap = window.Capacitor;
    return !!(
      cap &&
      typeof cap.isNativePlatform === 'function' &&
      cap.isNativePlatform() &&
      getPlugin()
    );
  }

  /**
   * 'ready'          → app Android con el módulo de música instalado
   * 'missing-plugin' → app Android, pero este APK se compiló SIN el módulo
   * 'web'            → navegador normal
   */
  function status() {
    const cap = window.Capacitor;
    const native = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    if (!native) return 'web';
    return getPlugin() ? 'ready' : 'missing-plugin';
  }

  /** Consulta el permiso sin mostrar ningún aviso. */
  async function hasPermission() {
    const plugin = getPlugin();
    if (!plugin) return false;
    try {
      const result = await plugin.hasPermission();
      return !!(result && result.granted);
    } catch (e) {
      return false;
    }
  }

  function toTrack(item) {
    const fileName = item.name || `${item.title || 'audio'}.mp3`;
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    return {
      id: 'lib_' + item.id,
      contentUri: item.uri,
      fileName: fileName,
      mime: item.mime || '',
      size: item.size || 0,
      file: null,
      url: null, // se completa en resolve()
      title: item.title || baseName || 'Sin título',
      artist: item.artist || '',
      album: item.album || '',
      cover: null,
      duration: item.duration || 0,
      genre: 'Local Audio',
      format: MetadataParser.detectFormatFromName(fileName),
      isSynthetic: false
    };
  }

  /** Lee la música del teléfono (pide el permiso si hace falta). */
  async function scan() {
    const plugin = getPlugin();
    if (!plugin) throw new Error('La biblioteca solo está disponible en la app Android.');
    const result = await plugin.scan();
    const tracks = (result && result.tracks ? result.tracks : []).map(toTrack);
    tracks.sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
    return tracks;
  }

  /** Abre los ajustes de la app (por si el permiso quedó denegado y Android ya no pregunta). */
  async function openSettings() {
    const plugin = getPlugin();
    if (plugin && plugin.openSettings) await plugin.openSettings();
  }

  const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** ¿Esta pista es de la biblioteca y aún no está cargada en memoria? */
  function needsResolve(track) {
    return !!(track && track.contentUri && !track.url);
  }

  /** Carga la canción en memoria y completa portada, artista y álbum desde sus etiquetas. */
  function resolve(track) {
    if (!needsResolve(track)) return Promise.resolve(track);
    if (track._resolving) return track._resolving;

    track._resolving = (async () => {
      // Sin cabecera Range: así Capacitor entrega el archivo completo correctamente
      const response = await fetch(window.Capacitor.convertFileSrc(track.contentUri));
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const blob = await response.blob();
      if (!blob.size) throw new Error('El archivo está vacío');
      await yieldToUI(); // deja respirar al audio y a la interfaz entre un paso pesado y otro

      const file = new File([blob], track.fileName, { type: track.mime || blob.type });
      const parsed = await MetadataParser.parseFile(file);
      await yieldToUI();

      track.file = file;
      track.url = parsed.url;
      if (!track.cover && parsed.cover) track.cover = parsed.cover;
      if (!track.artist && parsed.artist) track.artist = parsed.artist;
      if (!track.album && parsed.album) track.album = parsed.album;
      return track;
    })();

    const clear = () => { track._resolving = null; };
    track._resolving.then(clear, clear);
    return track._resolving;
  }

  /** Libera de memoria el audio de una pista de la biblioteca (se vuelve a cargar al reproducirla). */
  function release(track) {
    if (!track || !track.contentUri || !track.url) return;
    try { URL.revokeObjectURL(track.url); } catch (e) { /* ya liberada */ }
    track.url = null;
    track.file = null;
  }


  // ---------------------------------------------------------------------------
  // Portadas en miniatura (para las listas)
  // Se piden solo cuando una fila aparece en pantalla, de pocas en pocas, y las últimas
  // filas que aparecieron se atienden primero (así, al desplazarse rápido, no se acumulan).
  // ---------------------------------------------------------------------------
  const THUMB_SIZE = 160;
  const THUMB_CONCURRENCY = 3;
  const thumbStack = [];
  const albumThumbs = new Map(); // las canciones de un mismo álbum comparten la misma portada
  let thumbActive = 0;

  function thumbsSupported() {
    const plugin = getPlugin();
    return !!(plugin && typeof plugin.getThumbnail === 'function');
  }

  /** ¿Esta pista de la biblioteca todavía no tiene portada y vale la pena pedirla? */
  function needsThumb(track) {
    return !!(track && track.contentUri && !track.cover && !track.thumb && !track._thumbDone && (track._thumbFails || 0) < 2);
  }

  function thumbKey(track) {
    return track.album && track.artist ? 'a|' + track.album + '|' + track.artist : 'u|' + track.contentUri;
  }

  /** JPEG en base64 → URL corta (blob:). Así las listas largas no cargan megas de texto en el HTML. */
  function base64ToBlobUrl(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  }

  function fetchThumb(track) {
    const key = thumbKey(track);
    let pending = albumThumbs.get(key);
    if (!pending) {
      pending = getPlugin()
        .getThumbnail({ uri: track.contentUri, size: THUMB_SIZE })
        .then((r) => (r && r.cover ? base64ToBlobUrl(r.cover) : ''));
      albumThumbs.set(key, pending);
      pending.catch(() => albumThumbs.delete(key)); // un error no se queda guardado
    }
    return pending;
  }

  function pumpThumbs() {
    while (thumbActive < THUMB_CONCURRENCY && thumbStack.length) {
      const job = thumbStack.pop();
      const track = job.track;
      if (!needsThumb(track)) continue;
      thumbActive++;
      fetchThumb(track)
        .then((url) => {
          if (url) track.thumb = url;
          else track._thumbDone = true; // esta canción no trae portada
          if (url && job.onReady) job.onReady(track);
        })
        .catch(() => { track._thumbFails = (track._thumbFails || 0) + 1; })
        .then(() => { thumbActive--; pumpThumbs(); });
    }
  }

  /** Pide la portada de una pista; cuando llega, avisa con onReady(track). */
  function requestThumb(track, onReady) {
    if (!thumbsSupported() || !needsThumb(track)) return;
    thumbStack.push({ track, onReady });
    pumpThumbs();
  }

  /** Permiso de fotos (Android 13+) para las portadas. Sin él las portadas suelen cargar igual. */
  async function hasImagesPermission() {
    const plugin = getPlugin();
    if (!plugin || typeof plugin.hasImagesPermission !== 'function') return false;
    try {
      const result = await plugin.hasImagesPermission();
      return !!(result && result.granted);
    } catch (e) {
      return false;
    }
  }

  async function ensureImagesPermission() {
    const plugin = getPlugin();
    if (!plugin || typeof plugin.requestImagesPermission !== 'function') return false;
    try {
      const result = await plugin.requestImagesPermission();
      return !!(result && result.granted);
    } catch (e) {
      return false;
    }
  }


  /** ¿Este APK sabe eliminar canciones del teléfono? */
  function canDelete() {
    const plugin = getPlugin();
    return !!(plugin && typeof plugin.deleteTracks === 'function');
  }

  /**
   * Elimina canciones del teléfono. Android muestra su propio aviso de confirmación.
   * Devuelve { deleted: [uri…], cancelled } con lo que realmente se borró.
   */
  async function deleteTracks(tracks) {
    const plugin = getPlugin();
    if (!plugin || typeof plugin.deleteTracks !== 'function') throw new Error('Este APK no incluye la función de eliminar.');
    const uris = tracks.map(t => t.contentUri).filter(Boolean);
    const result = await plugin.deleteTracks({ uris });
    return { deleted: (result && result.deleted) || [], cancelled: !!(result && result.cancelled) };
  }

  return {
    isAvailable, status, hasPermission, scan, openSettings, needsResolve, resolve, release,
    thumbsSupported, needsThumb, requestThumb, hasImagesPermission, ensureImagesPermission,
    canDelete, deleteTracks
  };
})();

window.NocturneLibrary = NocturneLibrary;
