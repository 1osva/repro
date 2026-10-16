/**
 * NOCTURNE AUDIO APP CONTROLLER
 * Vincula la interfaz (4 pantallas), el motor de audio, el visualizador,
 * la biblioteca del teléfono, las listas y el algoritmo de shuffle.
 *
 * Conceptos:
 *  - library:  todas las canciones disponibles (teléfono + archivos manuales + demos).
 *  - playlist: la COLA que suena ahora (puede ser la biblioteca o una lista).
 */

document.addEventListener('DOMContentLoaded', () => {
  const audioEngine = new AudioEngine();
  const visualizer = new Visualizer('visualizerCanvas', audioEngine);

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  let library = [];
  let playlist = [];
  let queueSource = 'library'; // 'library' o el id de una lista
  let currentTrackIndex = -1;
  let isPlaying = false;
  let repeatMode = 'off'; // 'off', 'all', 'one'
  let isMuted = false;
  let previousVolume = 0.8;
  let activeTab = 'library'; // 'library' | 'lists' | 'settings'
  let playerOpen = false;     // reproductor desplegado a pantalla completa
  let settingsOpen = false;
  let tabBeforeSettings = 'library';
  let currentListId = null; // lista abierta en la pestaña Listas
  let libFilter = '';
  let prefetchedFor = null; // canción actual para la que ya se precargó la siguiente
  let mediaDurationFor = null; // canción cuya duración ya se envió a la notificación
  let restorePending = null; // { pos } canción recordada de la última vez, lista para reanudar con Play
  let sessionRestored = false;
  let scrubbing = false; // la persona está deslizando la barra de tiempo
  const SESSION_KEY = 'nocturne.session.v1'; // última canción y segundo en que se quedó
  const QUEUE_KEY = 'nocturne.queue.v1';     // orden de la cola (para conservar el modo aleatorio)

  const $ = (id) => document.getElementById(id);
  const dom = {
    currentTitle: $('currentTitle'), currentArtist: $('currentArtist'), currentAlbum: $('currentAlbum'),
    currentGenre: $('currentGenre'), currentFormat: $('currentFormat'), currentCover: $('currentCover'),
    ambientBg: $('ambientBg'), engineStatusText: $('engineStatusText'),
    barTitle: $('barTitle'), barArtist: $('barArtist'), barCover: $('barCover'),
    miniPlayer: $('miniPlayer'), miniInfo: $('miniInfo'), btnMiniPlay: $('btnMiniPlay'),
    miniPlayIcon: $('miniPlayIcon'), miniPauseIcon: $('miniPauseIcon'),

    btnPlay: $('btnPlay'), playIcon: $('playIcon'), pauseIcon: $('pauseIcon'),
    btnPrev: $('btnPrev'), btnNext: $('btnNext'), btnShuffle: $('btnShuffle'),
    btnRepeat: $('btnRepeat'), repeatIndicator: $('repeatIndicator'),
    btnFavorite: $('btnFavorite'), btnTrackMenu: $('btnTrackMenu'), btnTopMenu: $('btnTopMenu'),

    progressTrack: $('progressTrack'), progressFill: $('progressFill'), progressHandle: $('progressHandle'),
    crossfadeZone: $('crossfadeZone'), currentTime: $('currentTime'), durationTime: $('durationTime'),

    crossfadeSlider: $('crossfadeSlider'), crossfadeVal: $('crossfadeVal'), crossfadeBadge: $('crossfadeBadge'),
    fadeInSlider: $('fadeInSlider'), fadeInVal: $('fadeInVal'),
    vizDelaySlider: $('vizDelaySlider'), vizDelayVal: $('vizDelayVal'),
    smartShuffleToggle: $('smartShuffleToggle'), algoStatus: $('algoStatus'),
    eqBass: $('eqBass'), eqMid: $('eqMid'), eqTreble: $('eqTreble'), bassVal: $('bassVal'),
    volumeSlider: $('volumeSlider'), btnMute: $('btnMute'), volIconHigh: $('volIconHigh'), volIconMuted: $('volIconMuted'),

    dropZone: $('queueList'), fileInput: $('fileInput'),
    queueList: $('queueList'), queueCounter: $('queueCounter'), libSearch: $('libSearch'),
    

    listsOverview: $('listsOverview'), listCards: $('listCards'), btnNewList: $('btnNewList'),
    listDetail: $('listDetail'), listDetailName: $('listDetailName'), listDetailCount: $('listDetailCount'),
    btnListBack: $('btnListBack'), btnListMenu: $('btnListMenu'), btnListPlay: $('btnListPlay'),
    btnListShuffle: $('btnListShuffle'), btnListAdd: $('btnListAdd'), listMissing: $('listMissing'), listTracks: $('listTracks'),

    sheet: $('sheet'), sheetBackdrop: $('sheetBackdrop'), sheetTitle: $('sheetTitle'), sheetBody: $('sheetBody'),
    toast: $('nocturneToast'),
    app: $('app'), player: $('screenHome'), btnPlayerClose: $('btnPlayerClose'), btnMiniNext: $('btnMiniNext'),
    miniProgressFill: $('miniProgressFill'), btnSettingsBack: $('btnSettingsBack'),
    aboutBuild: $('aboutBuild'), aboutMusic: $('aboutMusic'), audioDiagLog: $('audioDiagLog'), btnDiagRefresh: $('btnDiagRefresh'), btnDiagCopy: $('btnDiagCopy'),
    aboutNotif: $('aboutNotif'), aboutCovers: $('aboutCovers'), aboutBackground: $('aboutBackground'),
    vizEnabledToggle: $('vizEnabledToggle'),
    tabs: document.querySelectorAll('.main-tab'),
    screens: document.querySelectorAll('.screen'),
    vModeBtns: document.querySelectorAll('.v-mode-btn')
  };

  const DEFAULT_COVER_HTML = dom.currentCover.innerHTML;
  const DEFAULT_BAR_COVER_HTML = dom.barCover.innerHTML;

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function formatTime(sec) {
    if (isNaN(sec) || sec <= 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  function artistLabel(t) { return t.artist || t.album || 'Artista desconocido'; }

  const ICON = {
    play: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><polygon points="7 3.5 20 12 7 20.5 7 3.5"/></svg>',
    heart: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
    upload: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
    dots: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    note: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  };

  // Aviso flotante
  function showToast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => dom.toast.classList.remove('show'), 2800);
  }

  // ---------------------------------------------------------------------------
  // Capas (hojas y detalle de lista): el botón Atrás de Android las cierra.
  //
  // Se reserva UNA entrada de historial mientras haya alguna capa abierta; así Atrás
  // cierra la capa superior en lugar de salir de la app. Cerrar desde la interfaz
  // es inmediato; solo la limpieza del historial es asíncrona y se serializa con
  // `guardRemoving` para que abrir otra capa justo después no se pise.
  // ---------------------------------------------------------------------------
  const layers = [];        // funciones de cierre; la última es la capa superior
  let guardActive = false;  // ¿existe la entrada de historial reservada?
  let guardRemoving = false; // ¿hay un history.back() de limpieza en curso?

  function pushGuard() {
    try {
      history.pushState({ nocturneGuard: true }, '');
      guardActive = true;
    } catch (e) {
      guardActive = false; // sin historial: Atrás saldrá de la app, pero la interfaz sigue funcionando
    }
  }

  function pushLayer(close) {
    layers.push(close);
    if (!guardActive && !guardRemoving) pushGuard();
  }

  /** Cierra la capa superior desde la interfaz (botón, fondo, acción terminada). */
  function popLayer() {
    const close = layers.pop();
    if (!close) return;
    close();
    if (layers.length === 0 && guardActive && !guardRemoving) {
      guardRemoving = true;
      try { history.back(); } catch (e) { guardRemoving = false; guardActive = false; }
    }
  }

  window.addEventListener('popstate', () => {
    if (guardRemoving) {
      // Era nuestra propia limpieza
      guardRemoving = false;
      guardActive = false;
      if (layers.length) pushGuard(); // se abrió otra capa mientras tanto
      return;
    }
    // El usuario pulsó Atrás: la entrada reservada se consumió
    guardActive = false;
    const close = layers.pop();
    if (close) close();
    if (layers.length) pushGuard();
  });

  // ---------------------------------------------------------------------------
  // Hoja inferior (menús, elegir lista, escribir nombre, confirmar)
  // ---------------------------------------------------------------------------
  let sheetOpen = false;

  function openSheet(title, build) {
    dom.sheetTitle.textContent = title;
    dom.sheetBody.innerHTML = '';
    build(dom.sheetBody);
    dom.sheet.hidden = false;
    dom.sheetBackdrop.hidden = false;
    if (!sheetOpen) {
      sheetOpen = true;
      pushLayer(hideSheet);
    }
  }

  function hideSheet() {
    sheetOpen = false;
    dom.sheet.hidden = true;
    dom.sheetBackdrop.hidden = true;
    dom.sheetBody.innerHTML = '';
  }

  function closeSheet() { if (sheetOpen) popLayer(); }
  dom.sheetBackdrop.addEventListener('click', closeSheet);

  function sheetItem(body, { icon, label, danger = false, onClick }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-item' + (danger ? ' danger' : '');
    b.innerHTML = `${icon || ''}<span>${escapeHtml(label)}</span>`;
    b.addEventListener('click', onClick);
    body.appendChild(b);
    return b;
  }

  function sheetActions(body, buttons) {
    const row = document.createElement('div');
    row.className = 'sheet-actions';
    buttons.forEach(({ label, primary, danger, onClick }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (primary ? ' chip-primary' : '') + (danger ? ' chip-danger' : '');
      b.textContent = label;
      b.addEventListener('click', onClick);
      row.appendChild(b);
    });
    body.appendChild(row);
    return row;
  }

  /** Pide un nombre (crear o renombrar lista). */
  function promptName(title, initial, okLabel, onOk) {
    openSheet(title, (body) => {
      const input = document.createElement('input');
      input.className = 'sheet-input';
      input.type = 'text';
      input.maxLength = NocturneLists.MAX_NAME;
      input.placeholder = 'Nombre de la lista';
      input.value = initial || '';
      input.autocomplete = 'off';
      body.appendChild(input);

      const submit = () => {
        const name = input.value.trim();
        if (!name) { showToast('Escribe un nombre.'); return; }
        onOk(name);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      sheetActions(body, [
        { label: 'Cancelar', onClick: closeSheet },
        { label: okLabel, primary: true, onClick: submit }
      ]);
      setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* sin foco */ } }, 60);
    });
  }

  function confirmSheet(title, text, okLabel, onOk) {
    openSheet(title, (body) => {
      const p = document.createElement('p');
      p.className = 'sheet-text';
      p.textContent = text;
      body.appendChild(p);
      sheetActions(body, [
        { label: 'Cancelar', onClick: closeSheet },
        { label: okLabel, danger: true, onClick: () => { closeSheet(); onOk(); } }
      ]);
    });
  }

  // ---------------------------------------------------------------------------
  // Cola y reproducción
  // ---------------------------------------------------------------------------
  function syncQueueFromLibrary() {
    if (queueSource !== 'library') return;
    const current = currentTrackIndex >= 0 ? playlist[currentTrackIndex] : null;
    playlist = library.slice();
    currentTrackIndex = current ? playlist.indexOf(current) : -1;
  }

  /** Agrega archivos elegidos a mano o demos a la biblioteca de esta sesión. */
  function addTracks(newTracks, autoPlay = true) {
    if (!newTracks || newTracks.length === 0) return;
    const queueWasEmpty = playlist.length === 0;
    library.push(...newTracks);
    syncQueueFromLibrary();
    renderLibrary();
    if (queueWasEmpty && autoPlay && playlist.length > 0) playTrackAtIndex(0);
    showToast(`Se añadieron ${plural(newTracks.length, 'pista', 'pistas')}.`);
  }

  /** Empieza a reproducir `track` usando `tracks` como cola. */
  function playFrom(tracks, track, source) {
    playlist = tracks.slice();
    queueSource = source || 'library';
    const idx = playlist.indexOf(track);
    if (idx < 0) return;
    playTrackAtIndex(idx, true);
  }

  let playRequestId = 0;

  async function playTrackAtIndex(index, forceImmediate = false, startAt = 0) {
    if (index < 0 || index >= playlist.length) return;
    restorePending = null; // ya se eligió qué sonar: la canción recordada deja de estar "pendiente"

    const requestId = ++playRequestId;
    currentTrackIndex = index;
    const track = playlist[index];
    markActiveRows();

    // Las pistas de la biblioteca del teléfono se leen justo antes de sonar
    if (NocturneLibrary.needsResolve(track)) {
      dom.barTitle.textContent = track.title;
      dom.barArtist.textContent = 'Cargando…';
      try {
        await NocturneLibrary.resolve(track);
      } catch (e) {
        console.warn('No se pudo abrir la pista:', e);
        if (requestId === playRequestId) {
          setPlayingState(false);
          showToast(`No se pudo abrir "${track.title}".`);
        }
        return;
      }
      if (requestId !== playRequestId) return; // se eligió otra pista mientras cargaba
    }

    // 1) El audio va primero: arrancar (o fundir) la canción es lo más sensible a cualquier tirón
    audioEngine.playTrack(track, forceImmediate);
    prefetchedFor = null;
    mediaDurationFor = null;

    // Reanudar donde se quedó la última vez: se salta a ese segundo en cuanto el archivo está listo
    if (startAt > 1) {
      const player = audioEngine.getActivePlayer();
      const jump = () => {
        if (player.track !== track) return; // mientras tanto se eligió otra canción
        const a = player.audio;
        if (a && isFinite(a.duration) && startAt < a.duration - 1) {
          try { a.currentTime = startAt; } catch (e) { /* sin salto: empieza desde el principio */ }
        }
      };
      if (player.audio.readyState >= 1 && player.track === track && player.audio.src === track.url) jump();
      else player.audio.addEventListener('loadedmetadata', jump, { once: true });
    }
    saveQueue();
    saveSession(startAt);
    logTrackDiag(track);

    // 2) Texto y estado al instante (es barato)…
    dom.currentTitle.textContent = track.title;
    dom.currentArtist.textContent = artistLabel(track);
    dom.barTitle.textContent = track.title;
    dom.barArtist.textContent = artistLabel(track);
    setPlayingState(true);
    askBatteryExemptionOnce();

    // 3) …y lo pesado (portada, colores, filas, memoria) un instante después, ya con el audio sonando
    setTimeout(() => {
      if (requestId !== playRequestId) return; // se cambió de canción mientras tanto
      updateNowPlayingUI(track);
      refreshTrackRows(track);
      manageLibraryMemory(playlist.indexOf(track));
    }, 350);
  }

  /** Libera la memoria de las canciones del teléfono que ya no están cerca de la actual. */
  function manageLibraryMemory(index) {
    if (index < 0) return;
    const keep = new Set([playlist[index - 1], playlist[index], playlist[index + 1]]);
    if (audioEngine.players) {
      audioEngine.players.forEach(p => { if (p.track) keep.add(p.track); });
    }
    library.forEach(t => {
      if (t.contentUri && t.url && !keep.has(t)) NocturneLibrary.release(t);
    });
  }

  /** La canción que sonará después de la actual (según repetir), o null. */
  function peekNextTrack() {
    if (playlist.length === 0 || currentTrackIndex < 0) return null;
    const next = currentTrackIndex + 1;
    if (next < playlist.length) return playlist[next];
    return repeatMode === 'all' ? playlist[0] : null;
  }

  /**
   * Prepara la siguiente canción poco antes de que termine la actual (no al empezarla):
   * leer el archivo, sus etiquetas y decodificarlo compite con el audio, así que se hace
   * una sola vez y lo más tarde posible, y se deja cargada en el reproductor libre.
   */
  async function prefetchNext() {
    const current = currentTrack();
    const next = peekNextTrack();
    if (!current || !next || prefetchedFor === current) return;
    prefetchedFor = current;
    try {
      await NocturneLibrary.resolve(next);
      if (currentTrack() === current && !audioEngine.isCrossfading) audioEngine.preloadTrack(next);
    } catch (e) {
      console.warn('No se pudo precargar la siguiente pista:', e);
    }
  }

  function nextTrack(isAutoCrossfade = false) {
    if (playlist.length === 0) return;

    if (repeatMode === 'one' && !isAutoCrossfade) {
      playTrackAtIndex(currentTrackIndex, true);
      return;
    }

    let nextIndex = currentTrackIndex + 1;
    if (nextIndex >= playlist.length) {
      if (repeatMode === 'all') {
        nextIndex = 0;
      } else {
        setPlayingState(false);
        return;
      }
    }
    playTrackAtIndex(nextIndex, !isAutoCrossfade);
  }

  function prevTrack() {
    if (playlist.length === 0) return;
    const activePlayer = audioEngine.getActivePlayer();

    // Si pasaron más de 3 segundos, reiniciar la pista actual
    if (activePlayer.audio && activePlayer.audio.currentTime > 3) {
      audioEngine.seek(0);
      syncMedia();
      return;
    }

    let prevIndex = currentTrackIndex - 1;
    if (prevIndex < 0) prevIndex = playlist.length - 1;
    playTrackAtIndex(prevIndex, true);
  }

  function setPlayingState(playing) {
    isPlaying = playing;
    dom.playIcon.style.display = playing ? 'none' : 'block';
    dom.pauseIcon.style.display = playing ? 'block' : 'none';
    dom.miniPlayIcon.style.display = playing ? 'none' : 'block';
    dom.miniPauseIcon.style.display = playing ? 'block' : 'none';
    dom.engineStatusText.textContent = playing ? 'En reproducción' : 'Pausa';
    syncMedia();
    if (!playing) saveSession();
  }

  function togglePlayPause() {
    if (playlist.length === 0) {
      if (library.length > 0) {
        playlist = library.slice();
        queueSource = 'library';
        playTrackAtIndex(0);
      } else {
        showToast('Aún no hay música. Busca en tu teléfono o agrega archivos.');
        closeAllOverlays();
        showTab('library');
      }
      return;
    }

    if (currentTrackIndex === -1) {
      playTrackAtIndex(0);
      return;
    }

    if (restorePending && currentTrack()) {
      playTrackAtIndex(currentTrackIndex, true, restorePending.pos);
      return;
    }

    if (isPlaying) {
      audioEngine.pause();
      setPlayingState(false);
    } else {
      audioEngine.resume();
      setPlayingState(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Pista actual en pantalla
  // ---------------------------------------------------------------------------
  function currentTrack() {
    return currentTrackIndex >= 0 ? playlist[currentTrackIndex] : null;
  }

  // ---------------------------------------------------------------------------
  // Notificación de música y controles del sistema (solo app Android)
  // ---------------------------------------------------------------------------
  NocturneMediaControls.setProvider(() => {
    const t = currentTrack();
    if (!t) return null;
    // Durante un crossfade la canción nueva está en el otro reproductor: buscar el que tiene ESTA canción
    const p = (audioEngine.players || []).find(pl => pl.track && pl.track.id === t.id) || audioEngine.getActivePlayer();
    const a = p && p.audio;
    const dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : (t.duration || 0);
    return { track: t, playing: isPlaying, position: a ? (a.currentTime || 0) : 0, duration: dur };
  });

  function syncMedia() { NocturneMediaControls.sync(); }

  /** Órdenes que llegan desde la notificación, la pantalla de bloqueo o los audífonos. */
  function handleMediaAction(action, position) {
    switch (action) {
      case 'play': if (!isPlaying) togglePlayPause(); break;
      case 'pause':
      case 'stop': if (isPlaying) togglePlayPause(); break;
      case 'next': nextTrack(false); break;
      case 'previous': prevTrack(); break;
      case 'seek':
        if (position !== null) { audioEngine.seek(position); syncMedia(); }
        break;
    }
  }
  NocturneMediaControls.onAction(handleMediaAction);

  function updateNowPlayingUI(track) {
    if (!track) return;

    dom.currentTitle.textContent = track.title;
    dom.currentArtist.textContent = artistLabel(track);
    dom.currentAlbum.textContent = track.album || '';
    dom.currentGenre.textContent = track.genre || '';
    dom.currentFormat.textContent = track.format || '';
    dom.barTitle.textContent = track.title;
    dom.barArtist.textContent = artistLabel(track);

    if (track.cover) {
      visualizer.setCover(track.cover);
      dom.currentCover.style.backgroundImage = `url("${track.cover}")`;
      dom.currentCover.innerHTML = '';
      dom.barCover.style.backgroundImage = `url("${track.cover}")`;
      dom.barCover.innerHTML = '';
    } else {
      visualizer.setCover(null);
      dom.currentCover.style.backgroundImage = 'none';
      dom.currentCover.innerHTML = DEFAULT_COVER_HTML;
      dom.barCover.style.backgroundImage = 'none';
      dom.barCover.innerHTML = DEFAULT_BAR_COVER_HTML;
    }

    updateFavoriteButton(track);
  }

  /** Texto de reposo (sin canción elegida) en el reproductor y la barra inferior. */
  function showIdleInfo() {
    if (currentTrack()) return;
    const n = library.length;
    const info = n ? plural(n, 'canción lista', 'canciones listas') : 'Busca tu música para empezar';
    dom.currentTitle.textContent = 'Elige una canción';
    dom.currentArtist.textContent = n ? info : 'Nocturne Sound Engine';
    dom.barTitle.textContent = 'Elige una canción';
    dom.barArtist.textContent = info;
  }

  function updateFavoriteButton(track) {
    const fav = !!(track && NocturneLists.isFavorite(track));
    dom.btnFavorite.classList.toggle('active', fav);
    dom.btnFavorite.setAttribute('aria-pressed', String(fav));
  }

  // ---------------------------------------------------------------------------
  // Color de la portada → colores de la interfaz
  // - Reproductor, barra de tiempo, botones y mini reproductor: color completo (--accent-*).
  // - Pantallas de listas/biblioteca/ajustes: la misma idea pero más ligera (--soft-*).
  // Los colores se ajustan para que siempre se lean bien sobre el fondo oscuro.
  // ---------------------------------------------------------------------------
  const THEME_VARS = [
    '--accent-purple', '--accent-cyan', '--accent-purple-glow', '--accent-cyan-glow',
    '--soft-purple', '--soft-cyan', '--soft-purple-glow', '--soft-cyan-glow'
  ];
  const DEFAULT_PRIMARY = { r: 139, g: 92, b: 246 };   // paleta de reposo del visualizador
  const DEFAULT_SECONDARY = { r: 6, g: 182, b: 212 };
  const sameRgb = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, sat = 0;
    if (max !== min) {
      const d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s: sat, l };
  }

  function hslToRgb(h, sat, l) {
    const c = (1 - Math.abs(2 * l - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }

  function relLuminance({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  /** Lleva un color de la portada a un tono vivo y legible sobre el fondo oscuro (contraste ≥ 4.5). */
  function readableAccent(rgb, soft) {
    const hsl = rgbToHsl(rgb);
    const sat = soft ? clamp(hsl.s * 0.55, 0.25, 0.60) : clamp(hsl.s, 0.55, 0.95);
    let l = soft ? clamp(hsl.l, 0.70, 0.80) : clamp(hsl.l, 0.60, 0.72);
    let out = hslToRgb(hsl.h, sat, l);
    while (relLuminance(out) < 0.21 && l < 0.92) { l += 0.02; out = hslToRgb(hsl.h, sat, l); }
    return out;
  }

  const rgbCss = (c) => `rgb(${c.r}, ${c.g}, ${c.b})`;
  const rgbaCss = (c, a) => `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;

  /** Aplica los colores de la portada a la interfaz. Devuelve los colores usados, o null si se usa la paleta de reposo. */
  function applyCoverTheme(palette) {
    const root = document.documentElement.style;
    const p = palette.primaryRgb;
    if (sameRgb(p, DEFAULT_PRIMARY)) { // sin portada: colores originales
      THEME_VARS.forEach(v => root.removeProperty(v));
      return null;
    }
    let sec = palette.secondaryRgb;
    if (sameRgb(sec, DEFAULT_SECONDARY)) { // la portada no tiene un segundo color: uno vecino al principal
      const h = rgbToHsl(p);
      sec = hslToRgb((h.h + 35) % 360, h.s, h.l);
    }
    const full = [readableAccent(p, false), readableAccent(sec, false)];
    const soft = [readableAccent(p, true), readableAccent(sec, true)];
    root.setProperty('--accent-purple', rgbCss(full[0]));
    root.setProperty('--accent-cyan', rgbCss(full[1]));
    root.setProperty('--accent-purple-glow', rgbaCss(full[0], 0.45));
    root.setProperty('--accent-cyan-glow', rgbaCss(full[1], 0.45));
    root.setProperty('--soft-purple', rgbCss(soft[0]));
    root.setProperty('--soft-cyan', rgbCss(soft[1]));
    root.setProperty('--soft-purple-glow', rgbaCss(soft[0], 0.22));
    root.setProperty('--soft-cyan-glow', rgbaCss(soft[1], 0.22));
    return { full, soft };
  }

  visualizer.onPaletteExtracted = (palette) => {
    const theme = applyCoverTheme(palette);
    let playerTint;
    let listTint;
    if (theme) {
      const [a, b] = theme.full;
      playerTint = `
        radial-gradient(circle at 18% 16%, ${rgbaCss(a, 0.32)} 0%, transparent 56%),
        radial-gradient(circle at 85% 82%, ${rgbaCss(b, 0.24)} 0%, transparent 58%)`;
      listTint = `
        radial-gradient(circle at 18% 18%, ${rgbaCss(a, 0.14)} 0%, transparent 52%),
        radial-gradient(circle at 85% 80%, ${rgbaCss(b, 0.10)} 0%, transparent 55%)`;
    } else {
      const p = palette.primaryRgb;
      const s = palette.secondaryRgb;
      playerTint = listTint = `
        radial-gradient(circle at 18% 18%, rgba(${p.r}, ${p.g}, ${p.b}, 0.13) 0%, transparent 52%),
        radial-gradient(circle at 85% 80%, rgba(${s.r}, ${s.g}, ${s.b}, 0.10) 0%, transparent 55%),
        radial-gradient(circle at 20% 15%, rgba(124, 92, 255, 0.16) 0%, transparent 50%)`;
    }
    dom.ambientBg.style.background = `${listTint}, radial-gradient(circle at 50% 50%, #0c0a22 0%, #070714 100%)`;
    dom.player.style.background = `${playerTint}, #070714`;
  };

  // ---------------------------------------------------------------------------
  // Listas de canciones (biblioteca y detalle de lista)
  // ---------------------------------------------------------------------------
  function rowHtml(t, idx) {
    const img = t.cover || t.thumb;
    const cover = img ? ` style="background-image:url('${escapeHtml(img)}')"` : '';
    return `
      <div class="track-row" data-index="${idx}" data-id="${escapeHtml(t.id)}">
        <div class="track-row-cover"${cover}>${img ? '' : '♪'}</div>
        <div class="track-row-info">
          <div class="track-row-title">${escapeHtml(t.title)}</div>
          <div class="track-row-artist">${escapeHtml(artistLabel(t))}</div>
        </div>
        <div class="track-row-dur">${t.duration ? formatTime(t.duration) : ''}</div>
        <button class="icon-btn row-menu" type="button" aria-label="Más opciones">${ICON.dots}</button>
      </div>`;
  }

  // Portadas de la biblioteca del teléfono: se piden solo para las filas que aparecen en pantalla
  const coverObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const row = entry.target;
          coverObserver.unobserve(row);
          const tracks = row.parentElement && row.parentElement._tracks;
          const track = tracks && tracks[parseInt(row.dataset.index, 10)];
          if (track) NocturneLibrary.requestThumb(track, refreshTrackRows);
        });
      }, { rootMargin: '240px 0px' })
    : null;

  function observeCovers(container) {
    if (!coverObserver || !NocturneLibrary.thumbsSupported()) return;
    const tracks = container._tracks || [];
    container.querySelectorAll('.track-row').forEach((row) => {
      const track = tracks[parseInt(row.dataset.index, 10)];
      if (NocturneLibrary.needsThumb(track)) coverObserver.observe(row);
    });
  }

  function renderTrackList(container, tracks, emptyHtml) {
    if (coverObserver) container.querySelectorAll('.track-row').forEach(r => coverObserver.unobserve(r));
    container._tracks = tracks;
    container.innerHTML = tracks.length ? tracks.map(rowHtml).join('') : (emptyHtml || '');
    markActiveRows();
    observeCovers(container);
  }

  function bindTrackList(container, getSource) {
    container.addEventListener('click', (e) => {
      const row = e.target.closest('.track-row');
      if (!row || !container.contains(row)) return;
      const tracks = container._tracks || [];
      const t = tracks[parseInt(row.dataset.index, 10)];
      if (!t) return;
      if (e.target.closest('.row-menu')) {
        openTrackMenu(t, { tracks, source: getSource() });
        return;
      }
      playFrom(tracks, t, getSource());
    });
  }

  /** Marca la fila de la canción que suena en todas las listas visibles. */
  function markActiveRows() {
    const cur = currentTrack();
    [dom.queueList, dom.listTracks].forEach((c) => {
      c.querySelectorAll('.track-row.active').forEach(r => r.classList.remove('active'));
      if (cur) {
        const row = c.querySelector(`.track-row[data-id="${String(cur.id).replace(/["\\]/g, '')}"]`);
        if (row) row.classList.add('active');
      }
    });
  }

  /** Actualiza portada y artista de las filas de una canción (se completan al cargarla). */
  function refreshTrackRows(track) {
    if (!track) return;
    const id = String(track.id).replace(/["\\]/g, '');
    [dom.queueList, dom.listTracks].forEach((c) => {
      const row = c.querySelector(`.track-row[data-id="${id}"]`);
      if (!row) return;
      const cover = row.querySelector('.track-row-cover');
      const img = track.cover || track.thumb;
      if (cover && img) {
        cover.style.backgroundImage = `url('${img}')`;
        cover.textContent = '';
      }
      const artist = row.querySelector('.track-row-artist');
      if (artist) artist.textContent = artistLabel(track);
    });
  }

  // ----- Biblioteca -----
  function filteredLibrary() {
    const q = norm(libFilter.trim());
    if (!q) return library;
    return library.filter(t => norm(`${t.title} ${t.artist} ${t.album}`).includes(q));
  }

  function renderLibrary() {
    const shown = filteredLibrary();
    dom.queueCounter.textContent = libFilter.trim()
      ? `${shown.length} de ${plural(library.length, 'canción', 'canciones')}`
      : plural(library.length, 'canción', 'canciones');

    let empty = '';
    if (library.length === 0) {
      const status = NocturneLibrary.status();
      if (status === 'ready') {
        empty = '<div class="empty-state">Aún no hay música.<br>Pulsa <strong>Buscar música</strong> para traer las canciones de tu teléfono.</div>';
      } else if (status === 'missing-plugin') {
        empty = '<div class="empty-state"><strong>Este APK no incluye la búsqueda de música.</strong><br>Vuelve a compilarlo con la última versión. Mientras tanto, usa el menú ⋮ → <strong>Agregar archivos de audio</strong>.</div>';
      } else {
        empty = '<div class="empty-state">Aún no hay música.<br>Usa el menú ⋮ → <strong>Agregar archivos de audio</strong> para empezar.</div>';
      }
    } else if (shown.length === 0) {
      empty = `<div class="empty-state">Sin resultados para <strong>«${escapeHtml(libFilter.trim())}»</strong>.</div>`;
    }
    renderTrackList(dom.queueList, shown, empty);
  }

  let searchTimer = null;
  dom.libSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      libFilter = dom.libSearch.value;
      renderLibrary();
    }, 150);
  });

  bindTrackList(dom.queueList, () => 'library');
  bindTrackList(dom.listTracks, () => currentListId);

  // ----- Listas -----
  function listTracksOf(id) {
    return NocturneLists.resolve(id, library);
  }

  function shuffleTracks(tracks) {
    if (tracks.length <= 1) return tracks.slice();
    return dom.smartShuffleToggle.checked
      ? SmartShuffle.balancedShuffle(tracks)
      : SmartShuffle.pureShuffle(tracks);
  }

  function renderListCards() {
    const lists = NocturneLists.all();
    dom.listCards.innerHTML = lists.map((l) => {
      const fav = NocturneLists.isFavoritesList(l.id);
      const icon = fav ? ICON.heart : ICON.list;
      return `
        <div class="list-card${fav ? ' fav' : ''}" data-list-id="${escapeHtml(l.id)}">
          <div class="list-card-icon">${icon}</div>
          <div class="list-card-info">
            <div class="list-card-name">${escapeHtml(l.name)}</div>
            <div class="list-card-count">${plural(l.items.length, 'canción', 'canciones')}</div>
          </div>
          <button class="play-mini" type="button" data-action="play" aria-label="Reproducir ${escapeHtml(l.name)}">${ICON.play}</button>
        </div>`;
    }).join('') + (lists.length === 1 && lists[0].items.length === 0
      ? '<p class="muted-note">Crea tus propias listas con <strong>Nueva lista</strong>, o agrega canciones desde el menú ⋮ de cualquier canción.</p>'
      : '');
  }

  dom.listCards.addEventListener('click', (e) => {
    const card = e.target.closest('.list-card');
    if (!card) return;
    const id = card.dataset.listId;
    if (e.target.closest('[data-action="play"]')) { playList(id, false); return; }
    openList(id);
  });

  function openList(id) {
    if (!NocturneLists.get(id)) return;
    currentListId = id;
    dom.listsOverview.hidden = true;
    dom.listDetail.hidden = false;
    renderListDetail();
    pushLayer(closeListView);
  }

  function closeListView() {
    currentListId = null;
    dom.listDetail.hidden = true;
    dom.listsOverview.hidden = false;
    renderListCards();
  }

  function renderListDetail() {
    const list = NocturneLists.get(currentListId);
    if (!list) { closeListView(); return; }
    const { tracks, missing } = listTracksOf(list.id);
    dom.listDetailName.textContent = list.name;
    dom.listDetailCount.textContent = plural(tracks.length, 'canción', 'canciones');
    dom.listMissing.hidden = missing === 0;
    dom.listMissing.textContent = missing
      ? `${plural(missing, 'canción no está', 'canciones no están')} en tu teléfono ahora mismo (se conservan por si vuelven).`
      : '';
    renderTrackList(dom.listTracks, tracks,
      `<div class="empty-state">Esta lista está vacía.<br>Toca <strong>+ Agregar canciones</strong> para llenarla.</div>`);
  }

  function playList(id, shuffled) {
    const { tracks } = listTracksOf(id);
    if (tracks.length === 0) {
      showToast(library.length === 0 ? 'Primero carga tu música en Biblioteca.' : 'Esta lista está vacía.');
      return;
    }
    const queue = shuffled ? shuffleTracks(tracks) : tracks;
    playFrom(queue, queue[0], id);
  }

  dom.btnListPlay.addEventListener('click', () => playList(currentListId, false));
  dom.btnListShuffle.addEventListener('click', () => playList(currentListId, true));
  dom.btnListBack.addEventListener('click', () => popLayer());
  dom.btnListAdd.addEventListener('click', () => openTrackPicker(currentListId));

  dom.btnNewList.addEventListener('click', () => {
    promptName('Nueva lista', '', 'Crear', (name) => {
      const list = NocturneLists.create(name);
      if (!list) return;
      closeSheet();
      renderListCards();
      openList(list.id);
    });
  });

  dom.btnListMenu.addEventListener('click', () => {
    const list = NocturneLists.get(currentListId);
    if (!list) return;
    const { missing } = listTracksOf(list.id);
    openSheet(list.name, (body) => {
      if (!NocturneLists.isFavoritesList(list.id)) {
        sheetItem(body, {
          icon: ICON.edit, label: 'Cambiar nombre',
          onClick: () => promptName('Cambiar nombre', list.name, 'Guardar', (name) => {
            NocturneLists.rename(list.id, name);
            closeSheet();
            renderListDetail();
          })
        });
      }
      if (missing > 0) {
        sheetItem(body, {
          icon: ICON.refresh, label: `Quitar ${plural(missing, 'canción faltante', 'canciones faltantes')}`,
          onClick: () => {
            NocturneLists.pruneMissing(list.id, library);
            closeSheet();
            renderListDetail();
          }
        });
      }
      if (!NocturneLists.isFavoritesList(list.id)) {
        sheetItem(body, {
          icon: ICON.trash, label: 'Eliminar lista', danger: true,
          onClick: () => confirmSheet('¿Eliminar esta lista?', 'Las canciones no se borran de tu teléfono.', 'Eliminar', () => {
            NocturneLists.remove(list.id);
            showToast('Lista eliminada.');
            popLayer(); // vuelve al resumen de listas
          })
        });
      }
    });
  });

  // ----- Elegir canciones para una lista -----
  function openTrackPicker(listId) {
    const list = NocturneLists.get(listId);
    if (!list) return;
    const savable = library.filter(NocturneLists.isSavable);
    if (savable.length === 0) {
      showToast('Primero carga tu música del teléfono en Biblioteca.');
      return;
    }

    const selected = new Set();
    openSheet(`Agregar a «${list.name}»`, (body) => {
      const search = document.createElement('input');
      search.className = 'sheet-input';
      search.type = 'search';
      search.placeholder = 'Buscar canción o artista';
      search.autocomplete = 'off';
      body.appendChild(search);

      const listEl = document.createElement('div');
      listEl.className = 'track-list picker-list';
      body.appendChild(listEl);

      const actions = sheetActions(body, [
        { label: 'Cancelar', onClick: closeSheet },
        { label: 'Agregar', primary: true, onClick: confirmAdd }
      ]);
      const addBtn = actions.lastChild;

      function updateButton() {
        addBtn.textContent = selected.size ? `Agregar (${selected.size})` : 'Agregar';
      }

      function renderPicker() {
        const q = norm(search.value.trim());
        const rows = savable.filter(t => !q || norm(`${t.title} ${t.artist} ${t.album}`).includes(q));
        listEl._tracks = rows;
        listEl.innerHTML = rows.length ? rows.map((t, i) => {
          const already = NocturneLists.has(listId, t);
          const on = already || selected.has(t);
          return `
            <div class="track-row${on ? ' selected' : ''}" data-index="${i}" style="${already ? 'opacity:.5' : ''}">
              <div class="check">${ICON.check}</div>
              <div class="track-row-info">
                <div class="track-row-title">${escapeHtml(t.title)}</div>
                <div class="track-row-artist">${escapeHtml(already ? 'Ya está en la lista' : artistLabel(t))}</div>
              </div>
            </div>`;
        }).join('') : '<div class="empty-state">Sin resultados.</div>';
      }

      listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.track-row');
        if (!row) return;
        const t = listEl._tracks[parseInt(row.dataset.index, 10)];
        if (!t || NocturneLists.has(listId, t)) return;
        if (selected.has(t)) selected.delete(t); else selected.add(t);
        row.classList.toggle('selected', selected.has(t));
        updateButton();
      });

      let timer = null;
      search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderPicker, 150); });

      function confirmAdd() {
        if (selected.size === 0) { closeSheet(); return; }
        const added = NocturneLists.addTracks(listId, Array.from(selected));
        closeSheet();
        showToast(`${plural(added, 'canción agregada', 'canciones agregadas')} a «${list.name}».`);
        if (currentListId === listId) renderListDetail();
        renderListCards();
      }

      renderPicker();
    });
  }

  // ----- Menú de una canción -----
  function openTrackMenu(track, ctx = {}) {
    openSheet(track.title, (body) => {
      sheetItem(body, {
        icon: ICON.play, label: 'Reproducir ahora',
        onClick: () => {
          closeSheet();
          const tracks = ctx.tracks && ctx.tracks.includes(track) ? ctx.tracks : [track];
          playFrom(tracks, track, ctx.tracks ? ctx.source : 'library');
        }
      });

      if (NocturneLists.isSavable(track)) {
        const fav = NocturneLists.isFavorite(track);
        sheetItem(body, {
          icon: ICON.heart, label: fav ? 'Quitar de Favoritas' : 'Agregar a Favoritas',
          onClick: () => { closeSheet(); toggleFavorite(track); }
        });
        sheetItem(body, {
          icon: ICON.list, label: 'Agregar a una lista…',
          onClick: () => openListChooser(track)
        });
        if (ctx.source && ctx.source !== 'library' && NocturneLists.get(ctx.source)) {
          sheetItem(body, {
            icon: ICON.trash, label: 'Quitar de esta lista', danger: true,
            onClick: () => {
              NocturneLists.removeTrack(ctx.source, track);
              closeSheet();
              if (currentListId === ctx.source) renderListDetail();
              updateFavoriteButton(currentTrack());
              showToast('Quitada de la lista.');
            }
          });
        }
      } else {
        const p = document.createElement('p');
        p.className = 'muted-note';
        p.style.textAlign = 'center';
        p.textContent = 'Solo las canciones de la biblioteca del teléfono se pueden guardar en listas.';
        body.appendChild(p);
      }

      if (track.contentUri && NocturneLibrary.canDelete()) {
        sheetItem(body, {
          icon: ICON.trash, label: 'Eliminar del teléfono…', danger: true,
          onClick: () => confirmDeleteTrack(track)
        });
      }
    });
  }

  // ----- Eliminar canciones del teléfono -----
  function confirmDeleteTrack(track) {
    confirmSheet(
      `¿Eliminar «${track.title}»?`,
      'Se borrará el archivo de tu teléfono y no se puede deshacer. Android te pedirá confirmar.',
      'Eliminar',
      () => deleteTracksFromPhone([track])
    );
  }

  async function deleteTracksFromPhone(tracks) {
    try {
      const { deleted, cancelled } = await NocturneLibrary.deleteTracks(tracks);
      if (cancelled) { showToast('No se eliminó nada.'); return; }
      const gone = tracks.filter(t => deleted.includes(t.contentUri));
      if (!gone.length) { showToast('No se pudo eliminar la canción.'); return; }
      removeTracksFromApp(gone);
      showToast(gone.length === 1 ? 'Canción eliminada.' : `${gone.length} canciones eliminadas.`);
    } catch (e) {
      console.warn('No se pudo eliminar:', e);
      const msg = (e && e.message) || '';
      if (e && e.code === 'UNSUPPORTED') showToast('Para eliminar desde la app se necesita Android 10 o superior.');
      else if (e && e.code === 'PERMISSION_DENIED') showToast('Falta el permiso de música para eliminar.');
      else showToast(/curso/i.test(msg) ? 'Espera: ya hay una eliminación en curso.' : 'No se pudo eliminar la canción.');
    }
  }

  /** Quita de la app (biblioteca, cola, listas y memoria del reproductor) canciones que ya no existen en el teléfono. */
  function removeTracksFromApp(gone) {
    const goneUris = new Set(gone.map(t => t.contentUri));
    const isGone = (t) => !!(t && t.contentUri && goneUris.has(t.contentUri));
    const cur = currentTrack();
    const removingCurrent = isGone(cur);
    const wasPlaying = isPlaying;

    // Si se borra la que suena, se sigue con la siguiente de la cola que no se haya borrado
    const follow = removingCurrent ? (playlist.slice(currentTrackIndex + 1).find(t => !isGone(t)) || null) : null;

    library = library.filter(t => !isGone(t));
    playlist = playlist.filter(t => !isGone(t));
    currentTrackIndex = removingCurrent ? -1 : (cur ? playlist.indexOf(cur) : -1);

    if (removingCurrent) {
      restorePending = null;
      audioEngine.stopAllAudio();
      NocturneMediaControls.stop();
      setPlayingState(false);
      visualizer.setCover(null);
      dom.currentCover.style.backgroundImage = 'none';
      dom.currentCover.innerHTML = DEFAULT_COVER_HTML;
      dom.barCover.style.backgroundImage = 'none';
      dom.barCover.innerHTML = DEFAULT_BAR_COVER_HTML;
      dom.progressFill.style.width = '0%';
      dom.progressHandle.style.left = '0%';
      dom.miniProgressFill.style.width = '0%';
      dom.currentTime.textContent = formatTime(0);
      dom.durationTime.textContent = formatTime(0);
    }
    gone.forEach(t => NocturneLibrary.release(t));

    // Fuera de Favoritas y de las demás listas
    NocturneLists.all().forEach(l => gone.forEach(t => NocturneLists.removeTrack(l.id, t)));

    // La memoria del reproductor no debe apuntar a una canción borrada
    const saved = readJson(SESSION_KEY);
    if (saved && gone.some(t => String(t.id) === String(saved.id))) {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* sin almacenamiento */ }
    }
    if (playlist.length) saveQueue();

    renderLibrary();
    renderListCards();
    if (currentListId) renderListDetail();
    markActiveRows();
    updateFavoriteButton(currentTrack());
    showIdleInfo();

    if (removingCurrent && wasPlaying && follow) {
      const idx = playlist.indexOf(follow);
      if (idx >= 0) playTrackAtIndex(idx, true);
    }
  }

  function openListChooser(track) {
    openSheet('Agregar a…', (body) => {
      NocturneLists.all().forEach((l) => {
        const fav = NocturneLists.isFavoritesList(l.id);
        sheetItem(body, {
          icon: fav ? ICON.heart : ICON.list,
          label: l.name,
          onClick: () => {
            const added = NocturneLists.addTracks(l.id, [track]);
            closeSheet();
            showToast(added ? `Agregada a «${l.name}».` : `Ya estaba en «${l.name}».`);
            updateFavoriteButton(currentTrack());
            renderListCards();
            if (currentListId === l.id) renderListDetail();
          }
        });
      });
      sheetItem(body, {
        icon: ICON.plus, label: 'Nueva lista…',
        onClick: () => promptName('Nueva lista', '', 'Crear y agregar', (name) => {
          const list = NocturneLists.create(name);
          if (!list) return;
          NocturneLists.addTracks(list.id, [track]);
          closeSheet();
          showToast(`Agregada a «${list.name}».`);
          renderListCards();
        })
      });
    });
  }

  function toggleFavorite(track) {
    const result = NocturneLists.toggleFavorite(track);
    if (result === null) {
      showToast('Solo las canciones de la biblioteca del teléfono se pueden marcar como favoritas.');
      return;
    }
    showToast(result ? 'Agregada a Favoritas.' : 'Quitada de Favoritas.');
    if (currentTrack() === track) updateFavoriteButton(track);
    renderListCards();
    if (currentListId === NocturneLists.FAV_ID) renderListDetail();
  }

  dom.btnFavorite.addEventListener('click', () => {
    const t = currentTrack();
    if (!t) { showToast('Elige una canción primero.'); return; }
    toggleFavorite(t);
  });

  dom.btnTrackMenu.addEventListener('click', () => {
    const t = currentTrack();
    if (!t) { showToast('Elige una canción primero.'); return; }
    openTrackMenu(t, { tracks: playlist, source: queueSource });
  });

  // ---------------------------------------------------------------------------
  // Navegación: lista principal + reproductor desplegable + Ajustes
  // ---------------------------------------------------------------------------
  function showTab(tab) {
    activeTab = tab;
    dom.screens.forEach((sc) => {
      const on = sc.dataset.screen === tab;
      sc.hidden = !on;
      sc.classList.toggle('active', on);
    });
    dom.tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    dom.app.classList.toggle('in-settings', tab === 'settings');
  }

  /** Cambia entre Canciones y Listas. */
  function switchTab(tab) {
    if (currentListId && tab !== 'lists') popLayer(); // cierra el detalle de lista
    showTab(tab);
    if (tab === 'lists' && !currentListId) renderListCards();
  }

  /** Cierra todas las capas abiertas (menús, reproductor, ajustes, detalle). */
  function closeAllOverlays() {
    while (layers.length) popLayer();
  }

  // ----- Reproductor a pantalla completa -----
  function openPlayer() {
    if (playerOpen) return;
    playerOpen = true;
    dom.player.classList.add('open');
    dom.player.setAttribute('aria-hidden', 'false');
    visualizer.paused = false;
    visualizer.resize();
    pushLayer(hidePlayer);
  }

  function hidePlayer() {
    playerOpen = false;
    dom.player.classList.remove('open');
    dom.player.setAttribute('aria-hidden', 'true');
    visualizer.paused = true; // pantalla oculta: no gastar batería dibujando
  }

  dom.miniInfo.addEventListener('click', openPlayer);
  dom.miniInfo.addEventListener('keydown', (e) => { if (e.key === 'Enter') openPlayer(); });
  dom.btnPlayerClose.addEventListener('click', () => popLayer());
  dom.btnMiniPlay.addEventListener('click', togglePlayPause);
  dom.btnMiniNext.addEventListener('click', () => nextTrack(false));

  // Deslizar hacia arriba la barra inferior abre el reproductor
  (function bindSwipeUp() {
    let y0 = null;
    dom.miniPlayer.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    dom.miniPlayer.addEventListener('touchend', (e) => {
      if (y0 === null) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (t && y0 - t.clientY > 40) openPlayer();
      y0 = null;
    }, { passive: true });
  })();

  // Deslizar hacia abajo (barra superior o portada) minimiza el reproductor, siguiendo el dedo
  (function bindSwipeDown() {
    let y0 = null;
    let dy = 0;
    const reset = () => {
      dom.player.style.transition = '';
      dom.player.style.transform = '';
      y0 = null;
      dy = 0;
    };
    [$('playerTop'), dom.player.querySelector('.hero')].forEach((zone) => {
      zone.addEventListener('touchstart', (e) => {
        y0 = e.touches[0].clientY;
        dy = 0;
        dom.player.style.transition = 'none';
      }, { passive: true });
      zone.addEventListener('touchmove', (e) => {
        if (y0 === null) return;
        dy = Math.max(0, e.touches[0].clientY - y0);
        dom.player.style.transform = `translateY(${dy}px)`;
      }, { passive: true });
      const end = () => {
        if (y0 === null) return;
        const close = dy > 110;
        reset();
        if (close && playerOpen) popLayer();
      };
      zone.addEventListener('touchend', end, { passive: true });
      zone.addEventListener('touchcancel', reset, { passive: true });
    });
  })();

  // ----- Ajustes (pantalla secundaria, desde el menú ⋮) -----
  function openSettings() {
    if (settingsOpen) return;
    if (currentListId) popLayer(); // si hay una lista abierta, se cierra primero
    settingsOpen = true;
    tabBeforeSettings = activeTab === 'settings' ? 'library' : activeTab;
    showTab('settings');
    renderAbout();
    pushLayer(closeSettings);
  }

  function closeSettings() {
    settingsOpen = false;
    showTab(tabBeforeSettings || 'library');
  }

  dom.btnSettingsBack.addEventListener('click', () => popLayer());

  dom.tabs.forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // Menú ⋮ de la cabecera
  dom.btnTopMenu.addEventListener('click', () => {
    openSheet('Opciones', (body) => {
      if (NocturneLibrary.isAvailable()) {
        sheetItem(body, { icon: ICON.refresh, label: 'Buscar música en el teléfono', onClick: () => { closeSheet(); scanLibrary(); } });
      }
      sheetItem(body, { icon: ICON.upload, label: 'Agregar archivos de audio', onClick: () => { closeSheet(); dom.fileInput.click(); } });
      sheetItem(body, { icon: ICON.gear, label: 'Ajustes', onClick: () => { closeSheet(); openSettings(); } });
    });
  });

  // ---------------------------------------------------------------------------
  // Audio: progreso, crossfade y eventos del motor
  // ---------------------------------------------------------------------------
  audioEngine.onTimeUpdate = (current, duration) => {
    if (!scrubbing) dom.currentTime.textContent = formatTime(current);
    dom.durationTime.textContent = formatTime(duration);

    if (duration > 0) {
      const pct = (current / duration) * 100;
      if (!scrubbing) {
        dom.progressFill.style.width = `${pct}%`;
        dom.progressHandle.style.left = `${pct}%`;
      }
      dom.miniProgressFill.style.width = `${pct}%`;
      saveSessionSoon();

      // Precargar la siguiente cuando faltan ~35 s (o, en pistas cortas, a mitad)
      const remaining = duration - current;
      const lead = Math.max(35, audioEngine.crossfadeDuration + 25);
      if (remaining <= lead && (current > 8 || duration < lead * 1.5)) prefetchNext();

      // Cuando se conoce la duración real, avisar a la notificación (aparece la barra de progreso)
      const t = currentTrack();
      if (t && mediaDurationFor !== t) {
        mediaDurationFor = t;
        syncMedia();
      }

      const xfadeSec = audioEngine.crossfadeDuration;
      const xfadePct = Math.min(30, (xfadeSec / duration) * 100);
      dom.crossfadeZone.style.width = `${xfadePct}%`;
    }
  };

  audioEngine.onTrackEnded = (isCrossfadeTrigger = false) => { nextTrack(isCrossfadeTrigger); };

  audioEngine.onCrossfadeStart = () => {
    dom.crossfadeBadge.classList.add('active');
    dom.crossfadeBadge.textContent = 'FUNDIENDO...';
  };

  audioEngine.onCrossfadeEnd = () => {
    dom.crossfadeBadge.classList.remove('active');
    dom.crossfadeBadge.textContent = `X-FADE ${audioEngine.crossfadeDuration}s`;
  };

  // ---------------------------------------------------------------------------
  // Shuffle inteligente (reordena la cola actual)
  // ---------------------------------------------------------------------------
  function executeShuffle() {
    if (playlist.length === 0 && library.length > 0) {
      playlist = library.slice();
      queueSource = 'library';
    }
    if (playlist.length <= 1) {
      showToast('Añade más canciones para ejecutar el shuffle.');
      return;
    }

    const useSmart = dom.smartShuffleToggle.checked;
    const current = currentTrack();

    if (useSmart) {
      playlist = SmartShuffle.balancedShuffle(playlist);
      const evalStats = SmartShuffle.evaluateClustering(playlist);
      dom.algoStatus.textContent = `Smart Shuffle activo: 0 choques directos de artista (variedad ${evalStats.qualityScore}%).`;
      showToast(`Cola mezclada con Smart Shuffle (${evalStats.qualityScore}% de variedad).`);
    } else {
      playlist = SmartShuffle.pureShuffle(playlist);
      const evalStats = SmartShuffle.evaluateClustering(playlist);
      dom.algoStatus.textContent = `Azar puro: ${evalStats.clashes} choques de artista consecutivos detectados.`;
      showToast(`Cola mezclada al azar (${evalStats.clashes} repeticiones consecutivas).`);
    }

    if (current) currentTrackIndex = playlist.findIndex(t => t.id === current.id);
    saveQueue();
  }

  dom.btnShuffle.addEventListener('click', () => {
    dom.btnShuffle.classList.toggle('active');
    executeShuffle();
  });

  dom.smartShuffleToggle.addEventListener('change', () => {
    dom.algoStatus.textContent = dom.smartShuffleToggle.checked
      ? 'Dispersión inteligente activa: previene artistas consecutivos y equilibra la variedad.'
      : 'Modo estándar: el azar uniforme puede provocar agrupamientos aleatorios del mismo artista.';
  });

  // ---------------------------------------------------------------------------
  // Controles de reproducción, ecualizador y volumen
  // ---------------------------------------------------------------------------
  dom.btnPlay.addEventListener('click', togglePlayPause);
  dom.btnNext.addEventListener('click', () => nextTrack(false));
  dom.btnPrev.addEventListener('click', prevTrack);

  // Barra de tiempo táctil: se puede tocar o deslizar el dedo hasta el punto que se quiere.
  // Mientras se desliza solo se mueve la barra; la canción salta al soltar (así no se corta el audio).
  (function bindScrub() {
    const bar = dom.progressTrack;
    let activeId = null;
    let lastPct = 0;

    const totalSeconds = () => {
      const t = currentTrack();
      if (restorePending && t) return t.duration || 0; // canción recordada, aún sin cargar
      const a = audioEngine.getActivePlayer().audio;
      return a && isFinite(a.duration) ? a.duration : 0;
    };
    const pctAt = (e) => {
      const r = bar.getBoundingClientRect();
      return r.width ? clamp((e.clientX - r.left) / r.width, 0, 1) : 0;
    };
    const preview = (pct) => {
      lastPct = pct;
      dom.progressFill.style.width = `${pct * 100}%`;
      dom.progressHandle.style.left = `${pct * 100}%`;
      dom.currentTime.textContent = formatTime(pct * totalSeconds());
    };
    const resyncFromPlayer = () => {
      const a = audioEngine.getActivePlayer().audio;
      if (a && isFinite(a.duration) && a.duration > 0) {
        const pct = (a.currentTime / a.duration) * 100;
        dom.progressFill.style.width = `${pct}%`;
        dom.progressHandle.style.left = `${pct}%`;
        dom.currentTime.textContent = formatTime(a.currentTime);
      }
    };

    bar.addEventListener('pointerdown', (e) => {
      if (activeId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (!(totalSeconds() > 0)) return;
      activeId = e.pointerId;
      scrubbing = true;
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* sin captura */ }
      bar.classList.add('scrubbing');
      preview(pctAt(e));
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (e.pointerId === activeId) preview(pctAt(e));
    });

    const finish = (e, commit) => {
      if (e.pointerId !== activeId) return;
      activeId = null;
      scrubbing = false;
      bar.classList.remove('scrubbing');
      try { bar.releasePointerCapture(e.pointerId); } catch (err) { /* ya liberado */ }
      const total = totalSeconds();
      if (!commit || !(total > 0)) { resyncFromPlayer(); return; }
      const target = lastPct * total;
      const t = currentTrack();
      if (restorePending && t) {
        // Canción recordada sin cargar: Play empezará desde el punto elegido
        restorePending.pos = target;
        if (t.contentUri) storageSet(SESSION_KEY, JSON.stringify({ id: t.id, pos: Math.round(target * 10) / 10, src: queueSource }));
      } else {
        audioEngine.seek(target);
        syncMedia();
      }
    };
    bar.addEventListener('pointerup', (e) => finish(e, true));
    bar.addEventListener('pointercancel', (e) => finish(e, false));
  })();

  dom.crossfadeSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    audioEngine.setCrossfadeDuration(val);
    dom.crossfadeVal.textContent = `${val.toFixed(1)}s`;
    dom.crossfadeBadge.textContent = val > 0 ? `X-FADE ${val}s` : 'X-FADE OFF';
  });

  dom.fadeInSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    audioEngine.setFadeInDuration(val);
    dom.fadeInVal.textContent = `${val.toFixed(1)}s`;
  });

  dom.vizDelaySlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    visualizer.syncOffsetMs = val;
    dom.vizDelayVal.textContent = val === 0 ? 'Auto' : `Auto +${val} ms`;
  });

  dom.vizEnabledToggle.addEventListener('change', () => {
    visualizer.enabled = dom.vizEnabledToggle.checked;
  });

  dom.eqBass.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    audioEngine.setEQ('bass', val);
    dom.bassVal.textContent = `Bass: ${val > 0 ? '+' : ''}${val}dB`;
  });
  dom.eqMid.addEventListener('input', (e) => audioEngine.setEQ('mid', parseFloat(e.target.value)));
  dom.eqTreble.addEventListener('input', (e) => audioEngine.setEQ('treble', parseFloat(e.target.value)));

  dom.volumeSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    audioEngine.setVolume(val);
    isMuted = val === 0;
    updateMuteUI();
  });

  dom.btnMute.addEventListener('click', () => {
    if (isMuted) {
      audioEngine.setVolume(previousVolume || 0.8);
      dom.volumeSlider.value = previousVolume || 0.8;
      isMuted = false;
    } else {
      previousVolume = parseFloat(dom.volumeSlider.value);
      audioEngine.setVolume(0);
      dom.volumeSlider.value = 0;
      isMuted = true;
    }
    updateMuteUI();
  });

  function updateMuteUI() {
    dom.volIconHigh.style.display = isMuted ? 'none' : 'block';
    dom.volIconMuted.style.display = isMuted ? 'block' : 'none';
  }

  dom.btnRepeat.addEventListener('click', () => {
    if (repeatMode === 'off') {
      repeatMode = 'all';
      dom.btnRepeat.classList.add('active');
      dom.repeatIndicator.textContent = 'ALL';
    } else if (repeatMode === 'all') {
      repeatMode = 'one';
      dom.btnRepeat.classList.add('active');
      dom.repeatIndicator.textContent = '1';
    } else {
      repeatMode = 'off';
      dom.btnRepeat.classList.remove('active');
      dom.repeatIndicator.textContent = '';
    }
  });

  dom.vModeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      dom.vModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      visualizer.setMode(btn.dataset.mode);
    });
  });

  // ---------------------------------------------------------------------------
  // Vaciar, archivos manuales y demos
  // ---------------------------------------------------------------------------
  function clearEverything() {
    audioEngine.stopAllAudio();
    NocturneMediaControls.stop();
    visualizer.setCover(null);
    library.forEach(t => NocturneLibrary.release(t));
    library = [];
    playlist = [];
    queueSource = 'library';
    currentTrackIndex = -1;
    setPlayingState(false);
    dom.currentCover.style.backgroundImage = 'none';
    dom.currentCover.innerHTML = DEFAULT_COVER_HTML;
    dom.barCover.style.backgroundImage = 'none';
    dom.barCover.innerHTML = DEFAULT_BAR_COVER_HTML;
    dom.miniProgressFill.style.width = '0%';
    updateFavoriteButton(null);
    showIdleInfo();
    renderLibrary();
    renderListCards();
    if (currentListId) renderListDetail();
    showToast('Biblioteca vaciada.');
  }

  async function parseInBatches(files, size) {
    const out = [];
    for (let i = 0; i < files.length; i += size) {
      const chunk = await Promise.all(files.slice(i, i + size).map(f => MetadataParser.parseFile(f)));
      out.push(...chunk);
      await new Promise(resolve => setTimeout(resolve, 0)); // deja respirar a la interfaz
    }
    return out;
  }

  function handleFiles(files) {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);

    const audioFiles = fileList.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name));
    const imageFiles = fileList.filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(f.name));

    // Si se arrastró una imagen sobre la pista actual
    if (audioFiles.length === 0 && imageFiles.length > 0 && currentTrack()) {
      const t = currentTrack();
      t.cover = URL.createObjectURL(imageFiles[0]);
      updateNowPlayingUI(t);
      refreshTrackRows(t);
      showToast('Nueva portada asignada a la pista actual.');
      return;
    }

    if (audioFiles.length === 0) {
      showToast('Por favor selecciona archivos de audio válidos.');
      return;
    }

    parseInBatches(audioFiles, 3).then((parsed) => {
      if (imageFiles.length > 0) {
        const batchCover = URL.createObjectURL(imageFiles[0]);
        parsed.forEach((track) => {
          if (!track.cover || track.cover.startsWith('data:image')) track.cover = batchCover;
        });
      }
      addTracks(parsed, true);
    });
  }

  dom.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = ''; // permite elegir el mismo archivo otra vez
  });

  dom.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
  dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
  dom.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });

  dom.currentCover.addEventListener('dragover', (e) => e.preventDefault());
  dom.currentCover.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/') && currentTrack()) {
      const t = currentTrack();
      t.cover = URL.createObjectURL(file);
      updateNowPlayingUI(t);
      refreshTrackRows(t);
      showToast('Portada asignada a la canción actual.');
    }
  });

  // ---------------------------------------------------------------------------
  // Atajos de teclado (escritorio)
  // ---------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === 'ArrowRight' && e.shiftKey) {
      e.preventDefault(); nextTrack(false);
    } else if (e.code === 'ArrowLeft' && e.shiftKey) {
      e.preventDefault(); prevTrack();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      const p = audioEngine.getActivePlayer();
      if (p.audio) { audioEngine.seek(p.audio.currentTime + 5); syncMedia(); }
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      const p = audioEngine.getActivePlayer();
      if (p.audio) { audioEngine.seek(p.audio.currentTime - 5); syncMedia(); }
    } else if (e.code === 'KeyM') {
      dom.btnMute.click();
    } else if (e.code === 'KeyS') {
      dom.btnShuffle.click();
    }
  });

  // ---------------------------------------------------------------------------
  // Biblioteca del teléfono (solo dentro de la app Android)
  //
  // Primer arranque: explica para qué se pide el permiso, lo solicita y trae la música.
  // Arranques siguientes: escanea en silencio. Al volver a la app, busca canciones nuevas.
  // ---------------------------------------------------------------------------
  const librarySection = $('librarySection');
  const btnScanLibrary = $('btnScanLibrary');
  const ASKED_KEY = 'nocturne.musicPermissionAsked';
  const FIRST_SCAN_KEY = 'nocturne.firstScanDone';
  const COUNT_KEY = 'nocturne.lastSongCount';
  let scanning = false;
  let lastScanAt = 0;

  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* sin almacenamiento */ } }

  // ---------------------------------------------------------------------------
  // Memoria del reproductor: recuerda la canción, el segundo y el orden de la cola.
  // Al abrir la app muestra esa canción en pausa; al pulsar Play sigue desde ese punto.
  // ---------------------------------------------------------------------------
  function readJson(key) { try { return JSON.parse(storageGet(key)); } catch (e) { return null; } }

  function saveQueue() {
    const ids = playlist.filter(t => t.contentUri).map(t => t.id);
    if (ids.length) storageSet(QUEUE_KEY, JSON.stringify({ ids, src: queueSource }));
  }

  /** Guarda la canción actual y su posición. Solo canciones del teléfono (las demás no sobreviven al cerrar la app). */
  function saveSession(posOverride) {
    if (restorePending) return; // aún no se reanuda: se conserva lo recordado
    const t = currentTrack();
    if (!t || !t.contentUri) return;
    let pos = posOverride;
    if (typeof pos !== 'number') {
      const p = (audioEngine.players || []).find(pl => pl.track && pl.track.id === t.id) || audioEngine.getActivePlayer();
      const a = p && p.audio;
      pos = a ? (a.currentTime || 0) : 0;
      const dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : (t.duration || 0);
      if (dur && pos > dur - 2) pos = 0; // la canción terminó: la próxima vez empieza de cero
    }
    storageSet(SESSION_KEY, JSON.stringify({ id: t.id, pos: Math.round(pos * 10) / 10, src: queueSource }));
  }

  let lastSessionSave = 0;
  function saveSessionSoon() {
    const now = Date.now();
    if (now - lastSessionSave < 3000) return;
    lastSessionSave = now;
    saveSession();
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) saveSession(); });
  window.addEventListener('pagehide', () => saveSession());

  /** Pone en pantalla (en pausa) la canción que sonaba la última vez. Se hace una sola vez, al traer la biblioteca. */
  function restoreSession() {
    if (sessionRestored) return;
    sessionRestored = true;
    if (currentTrack() || isPlaying) return;

    const saved = readJson(SESSION_KEY);
    if (!saved || saved.id === undefined) return;
    const byId = new Map(library.map(t => [String(t.id), t]));
    const track = byId.get(String(saved.id));
    if (!track) return; // la canción ya no está en el teléfono

    let queue = null;
    let source = 'library';
    const q = readJson(QUEUE_KEY);
    if (q && Array.isArray(q.ids)) {
      const tracks = q.ids.map(id => byId.get(String(id))).filter(Boolean);
      const sourceOk = q.src === 'library' || !!NocturneLists.get(q.src);
      if (sourceOk && tracks.indexOf(track) >= 0) { queue = tracks; source = q.src; }
    }
    if (!queue) { queue = library.slice(); source = 'library'; }

    playlist = queue;
    queueSource = source;
    currentTrackIndex = playlist.indexOf(track);
    if (currentTrackIndex < 0) { currentTrackIndex = -1; return; }

    const pos = Math.max(0, Number(saved.pos) || 0);
    restorePending = { pos };

    updateNowPlayingUI(track);
    markActiveRows();
    const dur = track.duration || 0;
    dom.currentTime.textContent = formatTime(pos);
    dom.durationTime.textContent = formatTime(dur);
    if (dur > 0) {
      const pct = Math.min(100, (pos / dur) * 100);
      dom.progressFill.style.width = `${pct}%`;
      dom.progressHandle.style.left = `${pct}%`;
      dom.miniProgressFill.style.width = `${pct}%`;
    }

    // Portada en miniatura mientras la canción completa no se ha cargado
    const showThumb = (t) => {
      if (currentTrack() !== t || t.cover || !t.thumb) return;
      [dom.barCover, dom.currentCover].forEach((el) => { el.style.backgroundImage = `url("${t.thumb}")`; el.innerHTML = ''; });
      visualizer.setCover(t.thumb); // y los colores de la interfaz toman el de la portada desde que se abre la app
    };
    showThumb(track);
    NocturneLibrary.requestThumb(track, showThumb);
  }

  // ---------------------------------------------------------------------------
  // Diagnóstico de audio: ayuda a encontrar la causa de los cortes (formato, bitrate, audífonos…)
  // ---------------------------------------------------------------------------
  async function logTrackDiag(track) {
    try {
      const ext = (String(track.fileName || '').split('.').pop() || '?').toUpperCase();
      const mb = track.size ? `${(track.size / 1048576).toFixed(1)} MB` : 'tamaño ?';
      const kbps = track.size && track.duration > 0 ? `~${Math.round((track.size * 8) / track.duration / 1000)} kbps` : 'kbps ?';
      const outs = await NocturneMediaControls.audioOutputs();
      audioEngine.logDiag(`▶ "${track.title}" · ${ext} · ${mb} · ${kbps} · salida: ${outs ? (outs.join(', ') || 'ninguna') : 'desconocida'}`);
    } catch (e) { /* solo diagnóstico */ }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      const outs = await NocturneMediaControls.audioOutputs();
      audioEngine.logDiag(`Cambió la conexión de audio → ${outs ? (outs.join(', ') || 'ninguna') : 'desconocida'}`);
    });
  }

  async function buildAudioDiagText() {
    const ua = navigator.userAgent || '';
    const android = (ua.match(/Android ([\d.]+); ([^)]+)\)/) || []);
    const webview = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
    const outs = await NocturneMediaControls.audioOutputs();
    const t = currentTrack();
    const lines = [
      `Teléfono: Android ${android[1] || '?'} · ${android[2] || '?'}`,
      `WebView: Chrome ${webview}`,
      `Frecuencia del audio: ${audioEngine.ctx ? audioEngine.ctx.sampleRate + ' Hz' : 'sin iniciar'}`,
      `Salida actual: ${outs ? (outs.join(', ') || 'ninguna') : 'desconocida'}`,
      `Crossfade: ${audioEngine.crossfadeDuration}s · Fade-in: ${audioEngine.fadeInDuration}s`,
      t ? `Canción: ${t.title} (${(String(t.fileName || '').split('.').pop() || '?').toUpperCase()})` : 'Canción: ninguna',
      '— Eventos recientes —'
    ];
    return lines.concat(audioEngine.diag.length ? audioEngine.diag : ['(sin eventos todavía)']).join('\n');
  }

  async function renderAudioDiag() {
    dom.audioDiagLog.textContent = await buildAudioDiagText();
  }

  // Captura el contexto justo antes/después de las interacciones que pueden coincidir con un corte.
  let lastInteractionDiag = { key: '', at: 0 };
  document.addEventListener('pointerup', (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest('button, input, select, [role="button"], .queue-item, .mini-player, .progress-track')
      : null;
    if (!target) return;
    const key = target.id || target.getAttribute('aria-label') || target.className?.toString().split(' ')[0] || target.tagName;
    const now = Date.now();
    if (key === lastInteractionDiag.key && now - lastInteractionDiag.at < 700) return;
    lastInteractionDiag = { key, at: now };
    const p = audioEngine.getActivePlayer();
    const audio = p && p.audio;
    audioEngine.logDiag(`Interacción: ${String(key).slice(0, 45)} · hidden=${document.hidden} · AudioContext=${audioEngine.ctx ? audioEngine.ctx.state : 'sin iniciar'} · paused=${audio ? audio.paused : '?'} · readyState=${audio ? audio.readyState : '?'} · t=${audio && Number.isFinite(audio.currentTime) ? audio.currentTime.toFixed(1) : '?'}s`);
  }, true);

  document.addEventListener('visibilitychange', () => {
    const p = audioEngine.getActivePlayer();
    const audio = p && p.audio;
    audioEngine.logDiag(`Visibilidad de la app | documento=${document.hidden ? 'hidden' : 'visible'}, AudioContext=${audioEngine.ctx ? audioEngine.ctx.state : 'sin iniciar'}, ${audio && !audio.paused ? 'reproduciendo' : 'pausado'}, readyState=${audio ? audio.readyState : '?'}, networkState=${audio ? audio.networkState : '?'}, t=${audio && Number.isFinite(audio.currentTime) ? audio.currentTime.toFixed(1) : '?'}s`);
    if (!document.hidden && audio && !audio.paused && audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      audioEngine.ctx.resume().then(() => audioEngine.logDiag('Al volver a la app se reanudó AudioContext')).catch((e) => audioEngine.logDiag(`No se pudo reanudar AudioContext: ${e.name || 'error'}`));
    }
  });

  dom.btnDiagRefresh.addEventListener('click', renderAudioDiag);
  dom.btnDiagCopy.addEventListener('click', async () => {
    const text = await buildAudioDiagText();
    dom.audioDiagLog.textContent = text;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Diagnóstico copiado.');
    } catch (e) {
      showToast('No se pudo copiar: mantén pulsado el texto para copiarlo.');
    }
  });

  // Permiso de fotos (portadas): se pide una sola vez, justo después de traer la música.
  // Las portadas se intentan cargar de todos modos; el permiso solo ayuda en algunos teléfonos.
  const IMAGES_ASKED_KEY = 'nocturne.imagesPermissionAsked';
  async function askImagesPermissionOnce() {
    if (storageGet(IMAGES_ASKED_KEY)) return;
    storageSet(IMAGES_ASKED_KEY, '1');
    try { await NocturneLibrary.ensureImagesPermission(); } catch (e) { /* se puede activar en Ajustes */ }
  }

  // Segundo plano: tras la primera reproducción se explica y se pide quitar la restricción de batería
  // para que Android no corte la música al salir de la app o apagar la pantalla. Se muestra una sola vez.
  const BATTERY_ASKED_KEY = 'nocturne.batteryPromptShown';
  async function askBatteryExemptionOnce() {
    if (!NocturneMediaControls.isAvailable() || storageGet(BATTERY_ASKED_KEY)) return;
    try {
      await NocturneMediaControls.whenPermissionHandled(); // primero el aviso de notificaciones, si lo hay
      const unrestricted = await NocturneMediaControls.batteryUnrestricted();
      if (unrestricted === null) return; // este APK no trae el módulo nuevo: nada que pedir
      if (unrestricted) { storageSet(BATTERY_ASKED_KEY, '1'); return; }
      await new Promise(resolve => setTimeout(resolve, 1200));
      if (document.hidden || sheetOpen) return; // se vuelve a intentar en la próxima reproducción
      storageSet(BATTERY_ASKED_KEY, '1');
      openSheet('Música en segundo plano', (body) => {
        const pText = document.createElement('p');
        pText.className = 'sheet-text';
        pText.textContent = 'Para que la música siga sonando sin interrupciones cuando salgas de la app o apagues la pantalla, permite que Nocturne funcione sin restricciones de batería.';
        body.appendChild(pText);
        sheetActions(body, [
          { label: 'Ahora no', onClick: closeSheet },
          { label: 'Permitir', primary: true, onClick: () => { closeSheet(); NocturneMediaControls.requestBatteryExemption(); } }
        ]);
      });
    } catch (e) { /* no es crítico */ }
  }

  /** Reemplaza las pistas del teléfono conservando las añadidas a mano y la que suena. */
  function setLibraryTracks(scanned) {
    const known = new Map(library.filter(t => t.contentUri).map(t => [t.contentUri, t]));
    const manual = library.filter(t => !t.contentUri);
    // Reutiliza los objetos ya cargados para no perder portada ni audio en memoria
    const merged = scanned.map(t => known.get(t.contentUri) || t);

    library = [...manual, ...merged];
    syncQueueFromLibrary();
    renderLibrary();
    renderListCards();
    if (currentListId) renderListDetail();

    restoreSession();
    showIdleInfo();
  }

  /** Se muestra si el permiso quedó denegado: Android ya no vuelve a preguntar, hay que activarlo a mano. */
  function showPermissionHelp() {
    openSheet('Falta el permiso de música', (body) => {
      const p = document.createElement('p');
      p.className = 'sheet-text';
      p.textContent = 'Sin acceso a tu música no puedo mostrar tus canciones. Puedes activarlo en Ajustes > Permisos > Música y audio.';
      body.appendChild(p);
      sheetActions(body, [
        { label: 'Ahora no', onClick: closeSheet },
        { label: 'Abrir ajustes', primary: true, onClick: () => { closeSheet(); NocturneLibrary.openSettings().catch(() => {}); } }
      ]);
    });
  }

  /**
   * Lee la música del teléfono. `silent` evita avisos cuando no cambia nada
   * (arranque normal y regreso a la app).
   */
  async function scanLibrary({ silent = false } = {}) {
    if (scanning) return;
    scanning = true;
    btnScanLibrary.disabled = true;
    if (!silent) showToast('Buscando música en el teléfono…');
    const before = parseInt(storageGet(COUNT_KEY) || '0', 10);
    try {
      const scanned = await NocturneLibrary.scan();
      if (scanned.length === 0) {
        if (!silent) showToast('No encontré música. Prueba con el menú ⋮ → Agregar archivos de audio.');
      } else {
        setLibraryTracks(scanned);
        storageSet(COUNT_KEY, String(scanned.length));
        if (!silent || scanned.length !== before) {
          showToast(`${plural(scanned.length, 'canción encontrada', 'canciones encontradas')}.`);
        }
        storageSet(FIRST_SCAN_KEY, '1');
        askImagesPermissionOnce();
      }
    } catch (e) {
      console.warn('Escaneo de biblioteca falló:', e);
      const denied = e && (e.code === 'PERMISSION_DENIED' || /denegad|denied/i.test(e.message || ''));
      if (denied) {
        if (!silent) showPermissionHelp();
      } else if (!silent) {
        showToast('No se pudo leer la música del teléfono.');
      }
    } finally {
      scanning = false;
      lastScanAt = Date.now();
      btnScanLibrary.disabled = false;
    }
  }

  const libStatus = NocturneLibrary.status(); // 'ready' | 'missing-plugin' | 'web'

  if (libStatus === 'ready') {
    librarySection.hidden = false;
    btnScanLibrary.addEventListener('click', () => scanLibrary());

    (async () => {
      if (await NocturneLibrary.hasPermission()) {
        scanLibrary({ silent: true });
      } else if (!storageGet(ASKED_KEY)) {
        // Primer arranque: como cualquier app, pide el permiso de inmediato
        storageSet(ASKED_KEY, '1');
        scanLibrary();
      }
    })();

    // Al volver a la app (p. ej. tras activar el permiso en Ajustes o copiar canciones nuevas)
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden || scanning || Date.now() - lastScanAt < 5000) return;
      if (await NocturneLibrary.hasPermission()) scanLibrary({ silent: true });
    });
  } else if (libStatus === 'missing-plugin') {
    // La app corre en Android pero este APK se compiló sin el módulo de música
    console.warn('Falta el plugin MediaLibrary en este APK.');
    setTimeout(() => showToast('Este APK no incluye la búsqueda de música. Vuelve a compilarlo.'), 800);
  }

  /** Tarjeta "Acerca de": permite saber qué APK está instalado y si trae la búsqueda de música. */
  async function renderAbout() {
    const b = window.NOCTURNE_BUILD || {};
    dom.aboutBuild.textContent = b.date
      ? `Compilación: ${b.date}${b.commit ? ' · ' + b.commit : ''}`
      : 'Versión de desarrollo';
    const notif = NocturneMediaControls.status();
    if (notif === 'ready') {
      const ok = await NocturneMediaControls.notificationPermission();
      dom.aboutNotif.textContent = `Notificación de reproducción: ${ok ? 'permiso concedido' : 'sin permiso (actívala en los ajustes del teléfono)'}`;
    } else if (notif === 'missing-plugin') {
      dom.aboutNotif.textContent = 'Notificación de reproducción: NO incluida en este APK (falta recompilar)';
    } else {
      dom.aboutNotif.textContent = 'Notificación de reproducción: solo disponible en la app Android';
    }
    if (libStatus === 'ready') {
      const imgOk = await NocturneLibrary.hasImagesPermission();
      dom.aboutCovers.textContent = `Portadas: ${NocturneLibrary.thumbsSupported() ? (imgOk ? 'permiso de fotos concedido' : 'sin permiso de fotos (se intentan cargar igual)') : 'NO incluidas en este APK (falta recompilar)'}`;
    } else {
      dom.aboutCovers.textContent = 'Portadas: solo disponibles en la app Android';
    }
    if (notif === 'ready') {
      const free = await NocturneMediaControls.batteryUnrestricted();
      dom.aboutBackground.textContent = free === null
        ? 'Segundo plano: NO incluido en este APK (falta recompilar)'
        : `Segundo plano: ${free ? 'sin restricciones de batería' : 'con restricción de batería (puede cortarse la música)'}`;
    } else {
      dom.aboutBackground.textContent = 'Segundo plano: solo disponible en la app Android';
    }
    if (libStatus === 'ready') {
      const granted = await NocturneLibrary.hasPermission();
      dom.aboutMusic.textContent = `Música del teléfono: ${granted ? 'permiso concedido' : 'sin permiso todavía'}`;
    } else if (libStatus === 'missing-plugin') {
      dom.aboutMusic.textContent = 'Música del teléfono: NO incluida en este APK (falta recompilar)';
    } else {
      dom.aboutMusic.textContent = 'Música del teléfono: solo disponible en la app Android';
    }
    renderAudioDiag();
  }

  // ---------------------------------------------------------------------------
  // Persistencia de ajustes (se recuerdan al cerrar y abrir la app)
  // ---------------------------------------------------------------------------
  const SETTINGS_KEY = 'nocturne.settings.v1';
  const rangeSettings = ['volumeSlider', 'crossfadeSlider', 'fadeInSlider', 'vizDelaySlider', 'eqBass', 'eqMid', 'eqTreble'];

  function readSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }

  function writeSettings() {
    try {
      const s = {};
      rangeSettings.forEach(id => { if (dom[id]) s[id] = dom[id].value; });
      s.smartShuffle = dom.smartShuffleToggle.checked;
      s.vizEnabled = dom.vizEnabledToggle.checked;
      const activeMode = document.querySelector('.v-mode-btn.active');
      if (activeMode) s.vMode = activeMode.dataset.mode;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) { /* sin almacenamiento: la app sigue funcionando */ }
  }

  (function restoreSettings() {
    const saved = readSettings();

    // Disparamos los eventos existentes para actualizar etiquetas y motor a la vez
    rangeSettings.forEach((id) => {
      if (dom[id] && saved[id] !== undefined) {
        dom[id].value = saved[id];
        dom[id].dispatchEvent(new Event('input'));
      }
    });

    if (typeof saved.smartShuffle === 'boolean') {
      dom.smartShuffleToggle.checked = saved.smartShuffle;
      dom.smartShuffleToggle.dispatchEvent(new Event('change'));
    }

    if (typeof saved.vizEnabled === 'boolean') {
      dom.vizEnabledToggle.checked = saved.vizEnabled;
      dom.vizEnabledToggle.dispatchEvent(new Event('change'));
    }

    if (saved.vMode) {
      const btn = Array.from(dom.vModeBtns).find(b => b.dataset.mode === saved.vMode);
      if (btn) btn.click();
    }

    // Se registran los guardados después de restaurar, para no pisar lo leído
    rangeSettings.forEach(id => { if (dom[id]) dom[id].addEventListener('input', writeSettings); });
    dom.smartShuffleToggle.addEventListener('change', writeSettings);
    dom.vizEnabledToggle.addEventListener('change', writeSettings);
    dom.vModeBtns.forEach(b => b.addEventListener('click', writeSettings));
  })();

  // ---------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------
  visualizer.paused = true; // el reproductor empieza minimizado
  showIdleInfo();
  renderLibrary();
  renderListCards();
  updateMuteUI();
});
