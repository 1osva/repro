/**
 * NOCTURNE LISTS
 * Listas de reproducción y Favoritas. Se guardan en el almacenamiento de la app
 * (localStorage) y sobreviven al cerrar y abrir.
 *
 * Solo se pueden guardar canciones de la biblioteca del teléfono (las que tienen
 * `contentUri`): son las únicas que la app puede volver a abrir en otra sesión.
 * Cada canción se guarda con su ruta (uri) y, de respaldo, su nombre y tamaño,
 * por si Android cambia el identificador interno después de reindexar.
 */
const NocturneLists = (() => {
  const KEY = 'nocturne.lists.v1';
  const FAV_ID = 'fav';
  const MAX_NAME = 40;

  let data = load();

  function emptyData() {
    return { lists: [{ id: FAV_ID, name: 'Favoritas', items: [] }] };
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && Array.isArray(raw.lists)) {
        // Garantiza que Favoritas exista y vaya primero
        if (!raw.lists.some(l => l.id === FAV_ID)) {
          raw.lists.unshift({ id: FAV_ID, name: 'Favoritas', items: [] });
        }
        raw.lists.forEach(l => { if (!Array.isArray(l.items)) l.items = []; });
        return raw;
      }
    } catch (e) { /* datos dañados o sin almacenamiento */ }
    return emptyData();
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) { /* sin almacenamiento: los cambios duran solo esta sesión */ }
  }

  function cleanName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  /** ¿Se puede guardar esta canción en una lista? */
  function isSavable(track) {
    return !!(track && track.contentUri);
  }

  function toItem(track) {
    return {
      uri: track.contentUri,
      name: track.fileName || '',
      size: track.size || 0,
      title: track.title || '',
      artist: track.artist || ''
    };
  }

  function sameItem(item, track) {
    if (item.uri === track.contentUri) return true;
    // Respaldo: mismo archivo si coinciden nombre y tamaño
    return !!(item.name && item.size && item.name === track.fileName && item.size === track.size);
  }

  function all() { return data.lists; }
  function get(id) { return data.lists.find(l => l.id === id) || null; }
  function isFavoritesList(id) { return id === FAV_ID; }

  function create(name) {
    const clean = cleanName(name);
    if (!clean) return null;
    const list = { id: 'l_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean, items: [] };
    data.lists.push(list);
    save();
    return list;
  }

  function rename(id, name) {
    const list = get(id);
    const clean = cleanName(name);
    if (!list || id === FAV_ID || !clean) return false;
    list.name = clean;
    save();
    return true;
  }

  function remove(id) {
    if (id === FAV_ID) return false;
    const before = data.lists.length;
    data.lists = data.lists.filter(l => l.id !== id);
    save();
    return data.lists.length < before;
  }

  function has(id, track) {
    const list = get(id);
    return !!(list && isSavable(track) && list.items.some(it => sameItem(it, track)));
  }

  /** Agrega canciones sin duplicar. Devuelve cuántas se agregaron de verdad. */
  function addTracks(id, tracks) {
    const list = get(id);
    if (!list) return 0;
    let added = 0;
    for (const t of tracks) {
      if (!isSavable(t) || list.items.some(it => sameItem(it, t))) continue;
      list.items.push(toItem(t));
      added++;
    }
    if (added) save();
    return added;
  }

  function removeTrack(id, track) {
    const list = get(id);
    if (!list || !track) return false;
    const before = list.items.length;
    list.items = list.items.filter(it => !sameItem(it, track));
    if (list.items.length < before) { save(); return true; }
    return false;
  }

  function isFavorite(track) { return has(FAV_ID, track); }

  /** Marca o desmarca como favorita. Devuelve true si quedó como favorita. */
  function toggleFavorite(track) {
    if (!isSavable(track)) return null;
    if (isFavorite(track)) { removeTrack(FAV_ID, track); return false; }
    addTracks(FAV_ID, [track]);
    return true;
  }

  /**
   * Convierte los elementos guardados de una lista en canciones reales de la
   * biblioteca actual. Los que ya no están en el teléfono se cuentan aparte.
   */
  function resolve(id, libraryTracks) {
    const list = get(id);
    if (!list) return { tracks: [], missing: 0 };
    const byUri = new Map();
    const byFile = new Map();
    for (const t of libraryTracks) {
      if (!t.contentUri) continue;
      byUri.set(t.contentUri, t);
      if (t.fileName && t.size) byFile.set(t.fileName + '|' + t.size, t);
    }
    const tracks = [];
    let missing = 0;
    for (const it of list.items) {
      const t = byUri.get(it.uri) || (it.name && it.size ? byFile.get(it.name + '|' + it.size) : null);
      if (t) tracks.push(t); else missing++;
    }
    return { tracks, missing };
  }

  /** Quita de una lista los elementos que ya no existen en el teléfono. */
  function pruneMissing(id, libraryTracks) {
    const list = get(id);
    if (!list) return 0;
    const { tracks } = resolve(id, libraryTracks);
    const keep = list.items.filter(it => tracks.some(t => sameItem(it, t)));
    const removed = list.items.length - keep.length;
    if (removed) { list.items = keep; save(); }
    return removed;
  }

  return {
    FAV_ID, MAX_NAME,
    all, get, isFavoritesList, isSavable,
    create, rename, remove,
    has, addTracks, removeTrack,
    isFavorite, toggleFavorite,
    resolve, pruneMissing
  };
})();

window.NocturneLists = NocturneLists;
