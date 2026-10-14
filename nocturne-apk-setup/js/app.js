/**
 * NOCTURNE AUDIO APP CONTROLLER
 * Controlador central que vincula UI, Motor de Audio, Visualizador y Algoritmo de Shuffle.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Inicialización de subsistemas
  const audioEngine = new AudioEngine();
  const visualizer = new Visualizer('visualizerCanvas', audioEngine);

  // Estado de la aplicación
  let playlist = [];
  let currentTrackIndex = -1;
  let isPlaying = false;
  let repeatMode = 'off'; // 'off', 'all', 'one'
  let isMuted = false;
  let previousVolume = 0.8;

  // Referencias a elementos del DOM
  const dom = {
    // Stage & Info
    currentTitle: document.getElementById('currentTitle'),
    currentArtist: document.getElementById('currentArtist'),
    currentAlbum: document.getElementById('currentAlbum'),
    currentGenre: document.getElementById('currentGenre'),
    currentFormat: document.getElementById('currentFormat'),
    currentCover: document.getElementById('currentCover'),
    ambientBg: document.getElementById('ambientBg'),
    statsPill: document.getElementById('statsPill'),
    engineStatusText: document.getElementById('engineStatusText'),

    // Mini bar
    barTitle: document.getElementById('barTitle'),
    barArtist: document.getElementById('barArtist'),
    barCover: document.getElementById('barCover'),

    // Controles de Reproducción
    btnPlay: document.getElementById('btnPlay'),
    playIcon: document.getElementById('playIcon'),
    pauseIcon: document.getElementById('pauseIcon'),
    btnPrev: document.getElementById('btnPrev'),
    btnNext: document.getElementById('btnNext'),
    btnShuffle: document.getElementById('btnShuffle'),
    btnRepeat: document.getElementById('btnRepeat'),
    repeatIndicator: document.getElementById('repeatIndicator'),

    // Barra de Progreso
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
    progressHandle: document.getElementById('progressHandle'),
    crossfadeZone: document.getElementById('crossfadeZone'),
    currentTime: document.getElementById('currentTime'),
    durationTime: document.getElementById('durationTime'),

    // Crossfade y Configuración
    crossfadeSlider: document.getElementById('crossfadeSlider'),
    crossfadeVal: document.getElementById('crossfadeVal'),
    crossfadeBadge: document.getElementById('crossfadeBadge'),
    fadeInSlider: document.getElementById('fadeInSlider'),
    fadeInVal: document.getElementById('fadeInVal'),
    smartShuffleToggle: document.getElementById('smartShuffleToggle'),
    algoStatus: document.getElementById('algoStatus'),

    // Ecualizador
    eqBass: document.getElementById('eqBass'),
    eqMid: document.getElementById('eqMid'),
    eqTreble: document.getElementById('eqTreble'),
    bassVal: document.getElementById('bassVal'),

    // Volumen
    volumeSlider: document.getElementById('volumeSlider'),
    btnMute: document.getElementById('btnMute'),
    volIconHigh: document.getElementById('volIconHigh'),
    volIconMuted: document.getElementById('volIconMuted'),

    // Cola y Carga
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    queueList: document.getElementById('queueList'),
    queueCounter: document.getElementById('queueCounter'),
    btnShuffleNow: document.getElementById('btnShuffleNow'),
    btnClearQueue: document.getElementById('btnClearQueue'),
    btnLoadDemos: document.getElementById('btnLoadDemos'),

    // Modos visualizador
    vModeBtns: document.querySelectorAll('.v-mode-btn')
  };

  // =========================================================================
  // GESTIÓN DE PISTAS Y LISTA DE REPRODUCCIÓN
  // =========================================================================

  function addTracks(newTracks, autoPlay = true) {
    if (!newTracks || newTracks.length === 0) return;

    const wasEmpty = playlist.length === 0;
    playlist.push(...newTracks);
    updateQueueUI();

    if (wasEmpty && autoPlay) {
      playTrackAtIndex(0);
    }
    showToast(`Se añadieron ${newTracks.length} pista(s) a la cola.`);
  }

  function playTrackAtIndex(index, forceImmediate = false) {
    if (index < 0 || index >= playlist.length) return;

    currentTrackIndex = index;
    const track = playlist[index];

    // Actualizar UI
    updateNowPlayingUI(track);
    updateQueueUI();

    // Reproducir en el motor
    audioEngine.playTrack(track, forceImmediate);
    setPlayingState(true);
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
      return;
    }

    let prevIndex = currentTrackIndex - 1;
    if (prevIndex < 0) {
      prevIndex = playlist.length - 1;
    }
    playTrackAtIndex(prevIndex, true);
  }

  function setPlayingState(playing) {
    isPlaying = playing;
    if (isPlaying) {
      dom.playIcon.style.display = 'none';
      dom.pauseIcon.style.display = 'block';
      dom.currentCover.classList.add('spinning');
      dom.engineStatusText.textContent = 'En reproducción (Web Audio API Hi-Fi)';
    } else {
      dom.playIcon.style.display = 'block';
      dom.pauseIcon.style.display = 'none';
      dom.currentCover.classList.remove('spinning');
      dom.engineStatusText.textContent = 'Pausa (Espera interactiva)';
    }
  }

  function togglePlayPause() {
    if (playlist.length === 0) {
      // Cargar demos si no hay nada
      loadDemoTracks();
      return;
    }

    if (currentTrackIndex === -1) {
      playTrackAtIndex(0);
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

  // =========================================================================
  // ACTUALIZACIÓN DE INTERFAZ (UI)
  // =========================================================================

  function updateNowPlayingUI(track) {
    if (!track) return;

    dom.currentTitle.textContent = track.title;
    dom.currentArtist.textContent = track.artist || track.format || 'Audio Local';
    dom.currentAlbum.textContent = track.album || '';
    dom.currentGenre.textContent = track.genre || 'Audio Hi-Fi';
    dom.currentFormat.textContent = track.format || '48kHz Stereo';

    dom.barTitle.textContent = track.title;
    dom.barArtist.textContent = track.artist || track.format || 'Audio Local';

    if (track.cover) {
      visualizer.setCover(track.cover);
      dom.currentCover.style.backgroundImage = `url("${track.cover}")`;
      dom.currentCover.innerHTML = '';
      dom.barCover.style.backgroundImage = `url("${track.cover}")`;
      dom.barCover.innerHTML = '';
    } else {
      visualizer.setCover(null);
    }
  }

  // Sincronización cromática de toda la app según los colores de la carátula
  visualizer.onPaletteExtracted = (palette) => {
    const p = palette.primaryRgb;
    const s = palette.secondaryRgb;

    // Tono ambiental elegante de fondo que se transforma con cada canción
    dom.ambientBg.style.background = `
      radial-gradient(circle at 18% 22%, rgba(${p.r}, ${p.g}, ${p.b}, 0.22) 0%, transparent 55%),
      radial-gradient(circle at 82% 78%, rgba(${s.r}, ${s.g}, ${s.b}, 0.18) 0%, transparent 55%),
      radial-gradient(circle at 50% 50%, rgba(12, 14, 22, 0.94) 0%, var(--bg-deep) 100%)
    `;

    // Actualizar colores de acento en botones, sliders, bordes y barras de progreso
    document.documentElement.style.setProperty('--accent-purple', palette.primary);
    document.documentElement.style.setProperty('--accent-cyan', palette.secondary);
    document.documentElement.style.setProperty('--accent-purple-glow', `rgba(${p.r}, ${p.g}, ${p.b}, 0.45)`);
    document.documentElement.style.setProperty('--accent-cyan-glow', `rgba(${s.r}, ${s.g}, ${s.b}, 0.45)`);
    document.documentElement.style.setProperty('--border-glow', `rgba(${p.r}, ${p.g}, ${p.b}, 0.35)`);
  };

  function updateQueueUI() {
    dom.queueCounter.textContent = `${playlist.length} pista${playlist.length === 1 ? '' : 's'}`;
    dom.statsPill.textContent = `${playlist.length} pistas en memoria`;

    if (playlist.length === 0) {
      dom.queueList.innerHTML = `
        <div class="empty-state">
          <p>Arrastra archivos de música o usa las <strong>pistas de demostración</strong> para comenzar.</p>
        </div>
      `;
      return;
    }

    dom.queueList.innerHTML = playlist.map((t, idx) => `
      <div class="queue-item ${idx === currentTrackIndex ? 'active' : ''}" data-index="${idx}">
        <div class="queue-item-index">${idx + 1}</div>
        <div class="queue-item-cover" style="background-image: url('${t.cover || ''}')">
          ${!t.cover ? '♪' : ''}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(t.title)}</div>
          <div class="queue-item-artist">${escapeHtml(t.artist || t.format || 'Audio Local')}</div>
        </div>
        <div class="queue-item-duration">${formatTime(t.duration || 180)}</div>
      </div>
    `).join('');

    // Listener para cada item de la lista
    dom.queueList.querySelectorAll('.queue-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index, 10);
        playTrackAtIndex(idx, true);
      });
    });
  }

  function formatTime(sec) {
    if (isNaN(sec) || sec <= 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // =========================================================================
  // CALLBACKS DEL MOTOR DE AUDIO (TIME, CROSSFADE, ENDED)
  // =========================================================================

  audioEngine.onTimeUpdate = (current, duration) => {
    dom.currentTime.textContent = formatTime(current);
    dom.durationTime.textContent = formatTime(duration);

    if (duration > 0) {
      const pct = (current / duration) * 100;
      dom.progressFill.style.width = `${pct}%`;
      dom.progressHandle.style.left = `${pct}%`;

      // Visualizar ancho de la zona de crossfade
      const xfadeSec = audioEngine.crossfadeDuration;
      const xfadePct = Math.min(30, (xfadeSec / duration) * 100);
      dom.crossfadeZone.style.width = `${xfadePct}%`;
    }
  };

  audioEngine.onTrackEnded = (isCrossfadeTrigger = false) => {
    nextTrack(isCrossfadeTrigger);
  };

  audioEngine.onCrossfadeStart = () => {
    dom.crossfadeBadge.classList.add('active');
    dom.crossfadeBadge.textContent = 'FUNDIENDO...';
  };

  audioEngine.onCrossfadeEnd = () => {
    dom.crossfadeBadge.classList.remove('active');
    dom.crossfadeBadge.textContent = `X-FADE ${audioEngine.crossfadeDuration}s`;
  };

  // =========================================================================
  // CONTROL DEL ALGORITMO SMART SHUFFLE
  // =========================================================================

  function executeShuffle() {
    if (playlist.length <= 1) {
      showToast('Añade más canciones para ejecutar el shuffle.');
      return;
    }

    const useSmart = dom.smartShuffleToggle.checked;
    const currentTrack = currentTrackIndex >= 0 ? playlist[currentTrackIndex] : null;

    if (useSmart) {
      // Aplicar algoritmo balanceado anti-clustering
      playlist = SmartShuffle.balancedShuffle(playlist);
      const evalStats = SmartShuffle.evaluateClustering(playlist);

      dom.algoStatus.innerHTML = `
        <strong>Smart Shuffle Activo:</strong> 0 choques directos de artista. Dispersión equiespaciada aplicada (Índice de variedad: ${evalStats.qualityScore}%).
      `;
      showToast(`Smart Shuffle aplicado: ${evalStats.qualityScore}% de dispersión perfecta.`);
    } else {
      // Shuffle puro uniforme
      playlist = SmartShuffle.pureShuffle(playlist);
      const evalStats = SmartShuffle.evaluateClustering(playlist);

      dom.algoStatus.innerHTML = `
        <strong>Azar Puro (Uniforme):</strong> ${evalStats.clashes} choques de artistas consecutivos detectados.
      `;
      showToast(`Azar Puro aplicado (${evalStats.clashes} repeticiones consecutivas).`);
    }

    // Reubicar índice de la pista activa
    if (currentTrack) {
      currentTrackIndex = playlist.findIndex(t => t.id === currentTrack.id);
    }

    updateQueueUI();
  }

  dom.btnShuffleNow.addEventListener('click', executeShuffle);
  dom.btnShuffle.addEventListener('click', () => {
    dom.btnShuffle.classList.toggle('active');
    executeShuffle();
  });

  dom.smartShuffleToggle.addEventListener('change', () => {
    if (dom.smartShuffleToggle.checked) {
      dom.algoStatus.textContent = 'Dispersión inteligente activa: previene artistas consecutivos y equilibra la variedad.';
    } else {
      dom.algoStatus.textContent = 'Modo estándar: el azar uniforme puede provocar agrupamientos aleatorios del mismo artista.';
    }
  });

  // =========================================================================
  // EVENTOS DE CONTROL (PLAYBACK, PROGRESS, EQ, VOLUME)
  // =========================================================================

  dom.btnPlay.addEventListener('click', togglePlayPause);
  dom.btnNext.addEventListener('click', () => nextTrack(false));
  dom.btnPrev.addEventListener('click', prevTrack);

  // Barra de progreso interactiva (Seek)
  dom.progressTrack.addEventListener('click', (e) => {
    const rect = dom.progressTrack.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));

    const activePlayer = audioEngine.getActivePlayer();
    if (activePlayer.audio && activePlayer.audio.duration) {
      const targetSec = pct * activePlayer.audio.duration;
      audioEngine.seek(targetSec);
    }
  });

  // Crossfade Slider
  dom.crossfadeSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    audioEngine.setCrossfadeDuration(val);
    dom.crossfadeVal.textContent = `${val.toFixed(1)}s`;
    dom.crossfadeBadge.textContent = val > 0 ? `X-FADE ${val}s` : 'X-FADE OFF';
  });

  // Fade In Slider
  if (dom.fadeInSlider) {
    dom.fadeInSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      audioEngine.setFadeInDuration(val);
      dom.fadeInVal.textContent = `${val.toFixed(1)}s`;
    });
  }

  // Ecualizador
  dom.eqBass.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    audioEngine.setEQ('bass', val);
    dom.bassVal.textContent = `Bass: ${val > 0 ? '+' : ''}${val}dB`;
  });

  dom.eqMid.addEventListener('input', (e) => {
    audioEngine.setEQ('mid', parseFloat(e.target.value));
  });

  dom.eqTreble.addEventListener('input', (e) => {
    audioEngine.setEQ('treble', parseFloat(e.target.value));
  });

  // Control de Volumen
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
    if (isMuted) {
      dom.volIconHigh.style.display = 'none';
      dom.volIconMuted.style.display = 'block';
    } else {
      dom.volIconHigh.style.display = 'block';
      dom.volIconMuted.style.display = 'none';
    }
  }

  // Modos de Repetición
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

  // Modos del Visualizador
  dom.vModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      dom.vModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      visualizer.setMode(btn.dataset.mode);
    });
  });

  // Limpiar cola
  dom.btnClearQueue.addEventListener('click', () => {
    audioEngine.stopAllAudio();
    visualizer.setCover(null);
    playlist = [];
    currentTrackIndex = -1;
    setPlayingState(false);
    updateQueueUI();
    dom.currentTitle.textContent = 'Selecciona una pista o pulsa "Cargar Demos"';
    dom.currentArtist.textContent = 'Nocturne Sound Engine';
    dom.currentAlbum.textContent = '';
    dom.currentCover.style.backgroundImage = 'none';
    dom.barCover.style.backgroundImage = 'none';
    dom.barTitle.textContent = 'Listo para reproducir';
    dom.barArtist.textContent = 'Nocturne Audio';
    showToast('Cola de reproducción vaciada.');
  });

  // =========================================================================
  // CARGA DE ARCHIVOS LOCALES (DRAG & DROP + INPUT)
  // =========================================================================

  function handleFiles(files) {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);

    const audioFiles = fileList.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name));
    const imageFiles = fileList.filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(f.name));

    // Si se arrastró una imagen sobre una pista existente
    if (audioFiles.length === 0 && imageFiles.length > 0 && currentTrackIndex >= 0) {
      const imgUrl = URL.createObjectURL(imageFiles[0]);
      playlist[currentTrackIndex].cover = imgUrl;
      updateNowPlayingUI(playlist[currentTrackIndex]);
      updateQueueUI();
      showToast('Nueva portada asignada a la pista actual.');
      return;
    }

    if (audioFiles.length === 0) {
      showToast('Por favor selecciona archivos de audio válidos.');
      return;
    }

    Promise.all(audioFiles.map(f => MetadataParser.parseFile(f))).then(parsed => {
      // Si se arrastró la música junto a una imagen (ej. cover.jpg o folder.jpg del móvil)
      if (imageFiles.length > 0) {
        const batchCover = URL.createObjectURL(imageFiles[0]);
        parsed.forEach(track => {
          if (!track.cover || track.cover.startsWith('data:image')) {
            track.cover = batchCover;
          }
        });
      }
      addTracks(parsed, true);
    });
  }

  // Permitir arrastrar una imagen directamente sobre la carátula para asignarla
  dom.currentCover.addEventListener('dragover', (e) => e.preventDefault());
  dom.currentCover.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/')) {
        const imgUrl = URL.createObjectURL(file);
        if (currentTrackIndex >= 0 && playlist[currentTrackIndex]) {
          playlist[currentTrackIndex].cover = imgUrl;
          updateNowPlayingUI(playlist[currentTrackIndex]);
          updateQueueUI();
          showToast('Portada asignada a la canción actual.');
        }
      }
    }
  });

  dom.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });

  dom.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropZone.classList.add('drag-over');
  });

  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('drag-over');
  });

  dom.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Cargar Demos Sintéticas
  function loadDemoTracks() {
    const demos = MetadataParser.getDemoTracks();
    addTracks(demos, true);
  }

  dom.btnLoadDemos.addEventListener('click', loadDemoTracks);

  // =========================================================================
  // ATAJOS DE TECLADO GLOBALES
  // =========================================================================

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return; // Evitar interferir en sliders

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === 'ArrowRight' && e.shiftKey) {
      e.preventDefault();
      nextTrack(false);
    } else if (e.code === 'ArrowLeft' && e.shiftKey) {
      e.preventDefault();
      prevTrack();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      const p = audioEngine.getActivePlayer();
      if (p.audio) audioEngine.seek(p.audio.currentTime + 5);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      const p = audioEngine.getActivePlayer();
      if (p.audio) audioEngine.seek(p.audio.currentTime - 5);
    } else if (e.code === 'KeyM') {
      dom.btnMute.click();
    } else if (e.code === 'KeyS') {
      dom.btnShuffle.click();
    }
  });

  // Notificación flotante (Toast)
  function showToast(msg) {
    let toast = document.getElementById('nocturneToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'nocturneToast';
      toast.style.cssText = `
        position: fixed;
        bottom: 104px;
        right: 32px;
        background: rgba(18, 20, 30, 0.95);
        color: #fff;
        padding: 10px 18px;
        border-radius: 8px;
        border: 1px solid rgba(139, 92, 246, 0.4);
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        font-size: 0.8rem;
        z-index: 999;
        backdrop-filter: blur(12px);
        transition: opacity 0.3s ease, transform 0.3s ease;
        transform: translateY(10px);
        opacity: 0;
        pointer-events: none;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';

    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.style.transform = 'translateY(10px)';
      toast.style.opacity = '0';
    }, 2800);
  }

  // =========================================================================
  // PERSISTENCIA DE AJUSTES (se recuerdan al cerrar y abrir la app)
  // =========================================================================

  const SETTINGS_KEY = 'nocturne.settings.v1';
  const rangeSettings = ['volumeSlider', 'crossfadeSlider', 'fadeInSlider', 'eqBass', 'eqMid', 'eqTreble'];

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function writeSettings() {
    try {
      const s = {};
      rangeSettings.forEach(id => { if (dom[id]) s[id] = dom[id].value; });
      s.smartShuffle = dom.smartShuffleToggle.checked;
      const activeMode = document.querySelector('.v-mode-btn.active');
      if (activeMode) s.vMode = activeMode.dataset.mode;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {
      // Almacenamiento no disponible: la app sigue funcionando sin recordar ajustes
    }
  }

  (function restoreSettings() {
    const saved = readSettings();

    // Reutilizamos los handlers existentes disparando sus eventos, así se
    // actualizan a la vez las etiquetas de la interfaz y el motor de audio.
    rangeSettings.forEach(id => {
      if (dom[id] && saved[id] !== undefined) {
        dom[id].value = saved[id];
        dom[id].dispatchEvent(new Event('input'));
      }
    });

    if (typeof saved.smartShuffle === 'boolean') {
      dom.smartShuffleToggle.checked = saved.smartShuffle;
      dom.smartShuffleToggle.dispatchEvent(new Event('change'));
    }

    if (saved.vMode) {
      const btn = Array.from(dom.vModeBtns).find(b => b.dataset.mode === saved.vMode);
      if (btn) btn.click();
    }

    // Se registran los guardados después de restaurar, para no pisar lo leído
    rangeSettings.forEach(id => {
      if (dom[id]) dom[id].addEventListener('input', writeSettings);
    });
    dom.smartShuffleToggle.addEventListener('change', writeSettings);
    dom.vModeBtns.forEach(b => b.addEventListener('click', writeSettings));
  })();
});

// --- Menú móvil (sidebar deslizable) ---
const btnMobileMenu = document.getElementById('btnMobileMenu');
const sidebarEl = document.querySelector('.sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const menuIconOpen = document.getElementById('menuIconOpen');
const menuIconClose = document.getElementById('menuIconClose');

function openMobileSidebar() {
  sidebarEl.classList.add('sidebar-open');
  sidebarBackdrop.classList.add('active');
  menuIconOpen.style.display = 'none';
  menuIconClose.style.display = 'block';
}
function closeMobileSidebar() {
  sidebarEl.classList.remove('sidebar-open');
  sidebarBackdrop.classList.remove('active');
  menuIconOpen.style.display = 'block';
  menuIconClose.style.display = 'none';
}
if (btnMobileMenu && sidebarEl && sidebarBackdrop) {
  btnMobileMenu.addEventListener('click', () => {
    sidebarEl.classList.contains('sidebar-open') ? closeMobileSidebar() : openMobileSidebar();
  });
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);
}
