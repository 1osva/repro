/**
 * NOCTURNE LIBRARY
 * Puente con el plugin nativo "MediaLibrary" (solo existe dentro de la app Android).
 *
 *  - scan():     pide el permiso de música si falta y devuelve las canciones del teléfono.
 *  - resolve():  lee UNA canción completa a memoria justo antes de sonar.
 *  - release():  libera esa memoria cuando la canción ya no está cerca de la actual.
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

  return { isAvailable, status, hasPermission, scan, openSettings, needsResolve, resolve, release };
})();

window.NocturneLibrary = NocturneLibrary;
