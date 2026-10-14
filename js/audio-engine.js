/**
 * NOCTURNE AUDIO ENGINE
 * Motor de audio de alta fidelidad basado en Web Audio API.
 * Soporta reproducción dual con Crossfade real sin bloqueos,
 * Fade In configurable, Ecualizador de 3 bandas, Analizador FFT
 * y Generador Sintético de Demos con gestión segura de eventos.
 */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.masterGain = null;

    // Filtros de ecualización (BiquadFilterNode)
    this.eqBass = null;
    this.eqMid = null;
    this.eqTreble = null;

    // Doble reproductor para Crossfade fluido (A y B)
    this.activePlayerIndex = 0; // 0 o 1
    this.players = [
      { audio: new Audio(), gain: null, source: null, track: null },
      { audio: new Audio(), gain: null, source: null, track: null }
    ];

    // Valores de EQ en dB; se guardan aquí para poder aplicarlos al crear el contexto
    this.eqValues = { bass: 3, mid: 0, treble: 2 };

    this.crossfadeDuration = 3.5; // Segundos
    this.fadeInDuration = 1.8; // Segundos de entrada progresiva
    this.isCrossfading = false;
    this.crossfadeTimeout = null;
    this.pauseTimeout = null;
    this.crossfadeTriggered = false;

    // Generador Sintético
    this.synthInterval = null;
    this.synthActive = false;
    this.synthNodes = [];
    this.currentSyntheticTrack = null;
    this.synthTime = 0;

    // Callbacks
    this.onTimeUpdate = null;
    this.onTrackEnded = null;
    this.onCrossfadeStart = null;
    this.onCrossfadeEnd = null;
    this.onFadeInStart = null;

    this.volume = 0.8;
    this._initialized = false;
  }

  /**
   * Inicializa el contexto de audio en la primera interacción del usuario
   */
  initContext() {
    if (this._initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    // 'playback' usa búferes de audio más grandes: evita cortes en celulares
    // a cambio de unos milisegundos de latencia, irrelevantes en un reproductor.
    try {
      this.ctx = new AudioContextClass({ latencyHint: 'playback' });
    } catch (e) {
      this.ctx = new AudioContextClass();
    }

    // Analizador de frecuencias
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72; // más bajo = las barras reaccionan antes al ritmo

    // Ganancia Master
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);

    // Ecualizador de 3 Bandas
    this.eqBass = this.ctx.createBiquadFilter();
    this.eqBass.type = 'lowshelf';
    this.eqBass.frequency.value = 250;
    this.eqBass.gain.value = this.eqValues.bass;

    this.eqMid = this.ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1500;
    this.eqMid.Q.value = 1.0;
    this.eqMid.gain.value = this.eqValues.mid;

    this.eqTreble = this.ctx.createBiquadFilter();
    this.eqTreble.type = 'highshelf';
    this.eqTreble.frequency.value = 4000;
    this.eqTreble.gain.value = this.eqValues.treble;

    // Configurar canal dual
    this.players.forEach((p, idx) => {
      p.audio.crossOrigin = "anonymous";
      p.gain = this.ctx.createGain();
      p.gain.gain.value = idx === 0 ? 1.0 : 0.0;
      p.source = this.ctx.createMediaElementSource(p.audio);

      p.source.connect(p.gain);
      p.gain.connect(this.eqBass);

      p.audio.addEventListener('timeupdate', () => {
        if (this.activePlayerIndex === idx && this.onTimeUpdate && !this.synthActive) {
          this.onTimeUpdate(p.audio.currentTime, p.audio.duration || 0);
          this.checkCrossfadeTrigger();
        }
      });

      p.audio.addEventListener('ended', () => {
        if (this.activePlayerIndex === idx && !this.isCrossfading && this.onTrackEnded) {
          this.onTrackEnded(false);
        }
      });

      p.audio.addEventListener('error', (e) => {
        console.warn(`Error en elemento de audio ${idx}:`, e);
      });
    });

    // Cadena de efectos
    this.eqBass.connect(this.eqMid);
    this.eqMid.connect(this.eqTreble);
    this.eqTreble.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this._initialized = true;
  }

  /**
   * Cancela inmediatamente transiciones pendientes para evitar condiciones de carrera
   */
  cancelPendingTransitions() {
    if (this.crossfadeTimeout) {
      clearTimeout(this.crossfadeTimeout);
      this.crossfadeTimeout = null;
    }
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
    }
    this.isCrossfading = false;
    if (this.onCrossfadeEnd) this.onCrossfadeEnd();
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setEQ(band, valueDb) {
    this.eqValues[band] = valueDb;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (band === 'bass' && this.eqBass) {
      this.eqBass.gain.setTargetAtTime(valueDb, now, 0.1);
    } else if (band === 'mid' && this.eqMid) {
      this.eqMid.gain.setTargetAtTime(valueDb, now, 0.1);
    } else if (band === 'treble' && this.eqTreble) {
      this.eqTreble.gain.setTargetAtTime(valueDb, now, 0.1);
    }
  }

  setCrossfadeDuration(sec) {
    this.crossfadeDuration = parseFloat(sec);
  }

  setFadeInDuration(sec) {
    this.fadeInDuration = parseFloat(sec);
  }

  getActivePlayer() {
    return this.players[this.activePlayerIndex];
  }

  getInactivePlayer() {
    return this.players[1 - this.activePlayerIndex];
  }

  /**
   * Deja lista la siguiente canción en el reproductor libre ANTES del crossfade.
   * Así, cuando llega el momento, solo hay que darle play: no se carga ni se decodifica
   * justo en medio de la transición (que era cuando se notaban los pequeños cortes).
   */
  preloadTrack(track) {
    if (!track || !track.url || !this.ctx) return;
    if (this.isCrossfading) return;
    const other = this.getInactivePlayer();
    if (!other.audio.paused) return; // está sonando (fundiéndose): no tocarlo
    if (other.preloadedId === track.id && other.audio.src === track.url) return;
    other.audio.preload = 'auto';
    other.audio.src = track.url;
    other.preloadedId = track.id;
    other.audio.load();
  }

  /**
   * Reproduce una pista de inmediato o mediante crossfade controlado
   */
  async playTrack(track, forceImmediate = false) {
    if (!track) return;
    this.initContext();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.crossfadeTriggered = false;
    this.cancelPendingTransitions();

    const currentP = this.getActivePlayer();
    const otherP = this.getInactivePlayer();

    // Si es una pista sintética demo generada
    if (track.isSynthetic) {
      // Detener reproductores de audio reales
      this.players.forEach(p => {
        p.audio.pause();
        p.audio.currentTime = 0;
        if (p.gain && this.ctx) {
          p.gain.gain.cancelScheduledValues(this.ctx.currentTime);
          p.gain.gain.setValueAtTime(0, this.ctx.currentTime);
        }
      });
      this.startSyntheticTrack(track);
      return;
    }

    // Si pasamos a un archivo real, detener cualquier sintetizador
    this.stopSyntheticTrack();

    // Evaluar si corresponde Crossfade automático al terminar
    const canCrossfade = !forceImmediate &&
                         !currentP.audio.paused &&
                         currentP.audio.currentTime > 1 &&
                         this.crossfadeDuration > 0 &&
                         currentP.track &&
                         !currentP.track.isSynthetic &&
                         currentP.track.id !== track.id;

    if (canCrossfade) {
      this.crossfadeToTrack(track);
      return;
    }

    // Reproducción directa e inmediata (Next, Prev o selección manual en cola)
    // Silenciar y detener el otro reproductor
    otherP.audio.pause();
    otherP.audio.currentTime = 0;
    if (otherP.gain && this.ctx) {
      otherP.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      otherP.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    }

    const now = this.ctx.currentTime;
    currentP.track = track;
    currentP.gain.gain.cancelScheduledValues(now);

    if (this.fadeInDuration > 0) {
      currentP.gain.gain.setValueAtTime(0.0001, now);
      currentP.gain.gain.linearRampToValueAtTime(1.0, now + this.fadeInDuration);
      if (this.onFadeInStart) this.onFadeInStart(this.fadeInDuration);
    } else {
      currentP.gain.gain.setValueAtTime(1.0, now);
    }

    currentP.audio.src = track.url;
    try {
      await currentP.audio.play();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn("Reproducción abortada o bloqueada:", e);
      }
    }
  }

  /**
   * Realiza un fundido cruzado seguro entre pistas
   */
  async crossfadeToTrack(nextTrack) {
    if (!nextTrack || nextTrack.isSynthetic) {
      this.playTrack(nextTrack, true);
      return;
    }

    this.cancelPendingTransitions();
    this.isCrossfading = true;
    if (this.onCrossfadeStart) this.onCrossfadeStart();

    const outgoing = this.getActivePlayer();
    const incoming = this.getInactivePlayer();

    incoming.track = nextTrack;
    // Si ya se precargó esta misma canción, no se vuelve a cargar
    if (!(incoming.preloadedId === nextTrack.id && incoming.audio.src === nextTrack.url)) {
      incoming.audio.src = nextTrack.url;
    }
    incoming.preloadedId = null;
    incoming.audio.currentTime = 0;

    const now = this.ctx.currentTime;
    const dur = Math.max(0.5, this.crossfadeDuration);

    outgoing.gain.gain.cancelScheduledValues(now);
    outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value || 1.0, now);
    outgoing.gain.gain.linearRampToValueAtTime(0.0001, now + dur);

    incoming.gain.gain.cancelScheduledValues(now);
    incoming.gain.gain.setValueAtTime(0.0001, now);
    incoming.gain.gain.linearRampToValueAtTime(1.0, now + dur);

    try {
      await incoming.audio.play();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn("Crossfade error al reproducir incoming:", e);
      }
    }

    this.crossfadeTimeout = setTimeout(() => {
      outgoing.audio.pause();
      outgoing.audio.currentTime = 0;
      if (this.ctx) outgoing.gain.gain.setValueAtTime(0.0, this.ctx.currentTime);

      this.activePlayerIndex = 1 - this.activePlayerIndex;
      this.isCrossfading = false;
      this.crossfadeTimeout = null;
      if (this.onCrossfadeEnd) this.onCrossfadeEnd();
    }, dur * 1000);
  }

  /**
   * Detecta cuándo iniciar el Crossfade hacia el final de la pista
   */
  checkCrossfadeTrigger() {
    if (this.isCrossfading || this.crossfadeTriggered || this.crossfadeDuration <= 0) return;
    const p = this.getActivePlayer();
    if (!p.audio || !p.audio.duration || p.audio.paused) return;

    const remaining = p.audio.duration - p.audio.currentTime;
    if (remaining <= this.crossfadeDuration && remaining > 0.5) {
      this.crossfadeTriggered = true;
      if (this.onTrackEnded) {
        this.onTrackEnded(true /* isCrossfadeTrigger */);
      }
    }
  }

  pause() {
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
    }

    if (this.synthActive) {
      this.pauseSyntheticTrack();
      return;
    }

    const p = this.getActivePlayer();
    if (this.ctx && p.audio && !p.audio.paused) {
      const now = this.ctx.currentTime;
      p.gain.gain.cancelScheduledValues(now);
      p.gain.gain.setValueAtTime(p.gain.gain.value || 1.0, now);
      p.gain.gain.linearRampToValueAtTime(0.0001, now + 0.12);
      this.pauseTimeout = setTimeout(() => {
        p.audio.pause();
        this.pauseTimeout = null;
      }, 130);
    } else if (p.audio) {
      p.audio.pause();
    }
  }

  resume() {
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
    }

    this.initContext();
    if (this.currentSyntheticTrack && (this.synthActive || this.getActivePlayer().track?.isSynthetic)) {
      this.resumeSyntheticTrack();
      return;
    }

    const p = this.getActivePlayer();
    if (this.ctx && p.audio) {
      const now = this.ctx.currentTime;
      p.gain.gain.cancelScheduledValues(now);
      p.gain.gain.setValueAtTime(0.0001, now);
      p.audio.play().then(() => {
        const resumeNow = this.ctx.currentTime;
        const rampDuration = Math.min(1.0, Math.max(0.2, this.fadeInDuration * 0.5));
        p.gain.gain.linearRampToValueAtTime(1.0, resumeNow + rampDuration);
      }).catch(e => {
        if (e.name !== 'AbortError') console.warn("Error al reanudar audio:", e);
      });
    } else if (p.audio) {
      p.audio.play().catch(e => {
        if (e.name !== 'AbortError') console.warn(e);
      });
    }
  }

  seek(seconds) {
    if (this.synthActive) return;
    const p = this.getActivePlayer();
    if (p.audio && p.audio.duration) {
      p.audio.currentTime = Math.max(0, Math.min(p.audio.duration, seconds));
    }
  }

  stopAllAudio() {
    this.cancelPendingTransitions();
    this.players.forEach(p => {
      p.audio.pause();
      p.audio.currentTime = 0;
      if (p.gain && this.ctx) {
        p.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        p.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      }
    });
    this.stopSyntheticTrack();
  }

  // =========================================================================
  // GENERADOR SINTÉTICO DE DEMOS AMBIENTALES
  // =========================================================================
  startSyntheticTrack(track) {
    this.initContext();
    this.stopSyntheticTrack();

    this.synthActive = true;
    this.currentSyntheticTrack = track;
    this.synthTime = 0;

    const chords = track.chords || [
      [220, 261.63, 329.63, 392],    // Am7
      [174.61, 220, 261.63, 329.63], // Fmaj7
      [130.81, 164.81, 196, 246.94], // Cmaj7
      [196, 246.94, 293.66, 349.23]  // G7
    ];

    let chordIdx = 0;

    const playChord = () => {
      if (!this.synthActive || !this.ctx) return;
      const now = this.ctx.currentTime;
      const notes = chords[chordIdx % chords.length];
      chordIdx++;

      notes.forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const noteGain = this.ctx.createGain();

        osc.type = i % 2 === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, now);

        noteGain.gain.setValueAtTime(0.0001, now);
        noteGain.gain.linearRampToValueAtTime(0.08 / (i + 1), now + 1.2);
        noteGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.8);

        osc.connect(noteGain);
        noteGain.connect(this.eqBass);

        osc.start(now);
        osc.stop(now + 4.0);

        this.synthNodes.push(osc);
        setTimeout(() => {
          const idx = this.synthNodes.indexOf(osc);
          if (idx !== -1) this.synthNodes.splice(idx, 1);
        }, 4000);
      });

      this.playSynthKick(now);
    };

    playChord();
    this.synthInterval = setInterval(() => {
      this.synthTime += 3.8;
      playChord();
      if (this.onTimeUpdate && this.synthActive) {
        this.onTimeUpdate(this.synthTime % (track.duration || 180), track.duration || 180);
      }
    }, 3800);
  }

  playSynthKick(time) {
    if (!this.ctx || !this.synthActive) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.frequency.setValueAtTime(120, time);
    osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.4);

    gain.gain.setValueAtTime(0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

    osc.connect(gain);
    gain.connect(this.eqBass);

    osc.start(time);
    osc.stop(time + 0.4);

    this.synthNodes.push(osc);
    setTimeout(() => {
      const idx = this.synthNodes.indexOf(osc);
      if (idx !== -1) this.synthNodes.splice(idx, 1);
    }, 450);
  }

  pauseSyntheticTrack() {
    this.synthActive = false;
    if (this.synthInterval) {
      clearInterval(this.synthInterval);
      this.synthInterval = null;
    }
    this.synthNodes.forEach(node => {
      try { node.stop(); node.disconnect(); } catch (e) {}
    });
    this.synthNodes = [];
  }

  resumeSyntheticTrack() {
    if (this.currentSyntheticTrack) {
      this.startSyntheticTrack(this.currentSyntheticTrack);
    }
  }

  stopSyntheticTrack() {
    this.pauseSyntheticTrack();
    this.currentSyntheticTrack = null;
    this.synthTime = 0;
  }
}

window.AudioEngine = AudioEngine;
