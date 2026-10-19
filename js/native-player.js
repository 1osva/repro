/**
 * NOCTURNE NATIVE PLAYER
 * Puente con el plugin nativo "NativePlayer" (Media3 / ExoPlayer) y motor híbrido:
 *  - Canciones de la biblioteca del teléfono (content://) -> reproducción NATIVA. El audio no
 *    pasa por el WebView ni por Web Audio, así que sale a su frecuencia original y Android
 *    negocia el códec Bluetooth (SBC, AAC, LDAC, LHDC...) con los audífonos.
 *  - Archivos sueltos (blob:) y demos sintéticas -> el motor Web Audio de siempre.
 *
 * Incluye: reproducción, pausa, búsqueda, volumen, entrada suave, paso sin huecos a la siguiente
 * y espectro para las barras del visualizador.
 * Todavía NO hay en modo nativo: crossfade ni ecualizador.
 */
const NocturneNative = (() => {
  const KEY = 'nocturne.nativeEngine';
  const noop = () => {};

  function getPlugin() {
    const cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.NativePlayer ? cap.Plugins.NativePlayer : null;
  }

  /** ¿Es la app Android y trae el módulo nativo? */
  function isAvailable() {
    const cap = window.Capacitor;
    const native = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    return native && !!getPlugin();
  }

  /** Por defecto está activado; se puede apagar en Ajustes (surte efecto al reiniciar la app). */
  function isEnabled() {
    try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; }
  }

  function setEnabled(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* sin almacenamiento */ }
  }

  function createEngine() {
    if (isAvailable() && isEnabled()) return new NativeAudioEngine(getPlugin());
    return new AudioEngine();
  }

  return { isAvailable, isEnabled, setEnabled, createEngine, noop };
})();

/**
 * Hace de AnalyserNode para el visualizador: guarda el último cuadro de espectro que manda el
 * reproductor nativo. El cálculo solo corre en el teléfono mientras alguien lo pide (el
 * visualizador a la vista); si deja de pedirlo, se apaga solo.
 */
class NativeSpectrum {
  constructor(plugin) {
    this.plugin = plugin;
    this.frequencyBinCount = 128;
    this.freq = new Uint8Array(128);
    this.time = new Uint8Array(128).fill(128);
    this.latency = 150; // ms; el reproductor lo mide y lo actualiza
    this.active = false;
    this.lastUse = 0;
    this._watchdog = setInterval(() => {
      if (this.active && performance.now() - this.lastUse > 1500) this._set(false);
    }, 1000);
  }

  _set(on) {
    this.active = on;
    Promise.resolve(this.plugin.setSpectrum({ enabled: on })).catch(NocturneNative.noop);
  }

  _touch() {
    this.lastUse = performance.now();
    if (!this.active) this._set(true);
  }

  push(e) {
    if (!e) return;
    NativeSpectrum._decode(e.freq, this.freq);
    NativeSpectrum._decode(e.time, this.time);
    if (typeof e.latency === 'number') this.latency = e.latency;
  }

  static _decode(b64, target) {
    if (!b64) return;
    try {
      const bin = atob(b64);
      const n = Math.min(bin.length, target.length);
      for (let i = 0; i < n; i++) target[i] = bin.charCodeAt(i);
    } catch (err) { /* cuadro dañado: se ignora */ }
  }

  getByteFrequencyData(arr) {
    this._touch();
    arr.set(this.freq.length > arr.length ? this.freq.subarray(0, arr.length) : this.freq);
  }

  getByteTimeDomainData(arr) {
    this._touch();
    arr.set(this.time.length > arr.length ? this.time.subarray(0, arr.length) : this.time);
  }
}

class NativeAudioEngine extends AudioEngine {
  constructor(plugin) {
    super();
    this.plugin = plugin;

    this.native = false;       // ¿la canción actual suena por el motor nativo?
    this.nativeTrack = null;
    this.nativePos = 0;
    this.nativeDur = 0;
    this.nativePlaying = false;
    this.queuedNext = null;    // siguiente canción ya entregada al reproductor nativo
    this.advancedId = null;    // id al que el reproductor pasó solo (sin huecos)

    // Avisos hacia la app (la app los asigna)
    this.onNativeState = null; // (playing:boolean) => void  (llamadas, foco de audio, audífonos desconectados...)
    this.onNativeError = null; // (message:string) => void

    this.spectrum = new NativeSpectrum(plugin);
    Promise.resolve(plugin.addListener('player', (e) => this._onEvent(e))).catch(NocturneNative.noop);
    Promise.resolve(plugin.addListener('spectrum', (e) => this.spectrum.push(e))).catch(NocturneNative.noop);
    Promise.resolve(plugin.setVolume({ volume: this.volume })).catch(NocturneNative.noop);
  }

  // Con una canción nativa el visualizador lee el espectro del reproductor nativo; con una
  // de Web Audio (archivo suelto, demo) sigue usando el AnalyserNode de siempre.
  get analyser() { return this.native ? this.spectrum : this._webAnalyser; }
  set analyser(v) { this._webAnalyser = v; }

  getOutputLatencyMs() {
    return this.native ? this.spectrum.latency : super.getOutputLatencyMs();
  }

  // ------------------------------------------------------------------ eventos nativos

  _onEvent(e) {
    if (!e || !this.native || !this.nativeTrack) return;

    switch (e.event) {
      case 'time':
        if (e.id !== this.nativeTrack.id) return;
        this.nativePos = e.position || 0;
        if (e.duration > 0) this.nativeDur = e.duration;
        if (this.onTimeUpdate) this.onTimeUpdate(this.nativePos, this.nativeDur || this.nativeTrack.duration || 0);
        break;

      case 'state':
        this.nativePlaying = !!e.playing;
        if (this.onNativeState) this.onNativeState(this.nativePlaying);
        break;

      case 'transition':
        // El reproductor pasó solo a la canción que le dejamos lista: avisar a la app para que
        // actualice la pantalla. playTrack() la reconocerá y no la reiniciará.
        if (this.queuedNext && this.queuedNext.id === e.id) {
          this.nativeTrack = this.queuedNext;
          this.queuedNext = null;
          this.advancedId = e.id;
          this.nativePos = 0;
          this.nativeDur = this.nativeTrack.duration || 0;
          if (this.onTrackEnded) this.onTrackEnded(false);
        }
        break;

      case 'ended':
        // Terminó la última canción de la cola
        if (e.id === this.nativeTrack.id) {
          this.nativePlaying = false;
          if (this.onTrackEnded) this.onTrackEnded(false);
        }
        break;

      case 'error':
        console.warn('Error del reproductor nativo:', e.message);
        this.nativePlaying = false;
        if (this.onNativeError) this.onNativeError(e.message || '');
        break;
    }
  }

  // ------------------------------------------------------------------ utilidades

  usesNative(track) {
    return !!(track && track.contentUri && !track.isSynthetic);
  }

  _silenceWebAudio() {
    this.players.forEach((p) => { if (p.audio && !p.audio.paused) p.audio.pause(); });
    this.stopSyntheticTrack();
  }

  _leaveNative() {
    this.native = false;
    this.nativeTrack = null;
    this.queuedNext = null;
    this.advancedId = null;
    this.nativePlaying = false;
    Promise.resolve(this.plugin.stop()).catch(NocturneNative.noop);
  }

  // ------------------------------------------------------------------ reproducción

  async playTrack(track, forceImmediate = false) {
    if (!track) return;

    if (!this.usesNative(track)) {
      if (this.native) this._leaveNative();
      return super.playTrack(track, forceImmediate);
    }

    this.crossfadeTriggered = false;
    this.cancelPendingTransitions();
    this._silenceWebAudio();

    // El reproductor ya pasó solo a esta canción (sin huecos): no reiniciarla
    if (this.native && this.advancedId === track.id) {
      this.advancedId = null;
      this.nativeTrack = track;
      return;
    }

    this.advancedId = null;
    this.queuedNext = null;
    this.native = true;
    this.nativeTrack = track;
    this.nativePos = 0;
    this.nativeDur = track.duration || 0;
    this.nativePlaying = true;

    if (this.fadeInDuration > 0 && this.onFadeInStart) this.onFadeInStart(this.fadeInDuration);

    try {
      await this.plugin.play({
        uri: track.contentUri,
        id: track.id,
        fade: Math.round(this.fadeInDuration * 1000)
      });
    } catch (e) {
      console.warn('No se pudo iniciar la reproducción nativa:', e);
      this.nativePlaying = false;
      if (this.onNativeError) this.onNativeError(String((e && e.message) || e));
    }
  }

  /** Deja lista la siguiente canción: el reproductor nativo pasa a ella sin huecos. */
  preloadTrack(track) {
    if (this.native) {
      if (this.usesNative(track) && this.nativeTrack && track.id !== this.nativeTrack.id) {
        this.queuedNext = track;
        Promise.resolve(this.plugin.setNext({ uri: track.contentUri, id: track.id })).catch(NocturneNative.noop);
      }
      return;
    }
    super.preloadTrack(track);
  }

  /** Quita la siguiente canción ya entregada (por ejemplo al activar "repetir una"). */
  clearNext() {
    if (!this.native || !this.queuedNext) return;
    this.queuedNext = null;
    Promise.resolve(this.plugin.setNext({ uri: '', id: '' })).catch(NocturneNative.noop);
  }

  pause() {
    if (this.native) {
      this.nativePlaying = false;
      Promise.resolve(this.plugin.pause({ fade: 120 })).catch(NocturneNative.noop);
      return;
    }
    super.pause();
  }

  resume() {
    if (this.native) {
      this.nativePlaying = true;
      const ms = Math.round(Math.min(1.0, Math.max(0.2, this.fadeInDuration * 0.5)) * 1000);
      Promise.resolve(this.plugin.resume({ fade: ms })).catch(NocturneNative.noop);
      return;
    }
    super.resume();
  }

  seek(seconds) {
    if (this.native) {
      const max = this.nativeDur > 0 ? this.nativeDur : Infinity;
      const pos = Math.max(0, Math.min(max, seconds));
      this.nativePos = pos;
      Promise.resolve(this.plugin.seek({ position: pos })).catch(NocturneNative.noop);
      return;
    }
    super.seek(seconds);
  }

  setVolume(val) {
    super.setVolume(val);
    Promise.resolve(this.plugin.setVolume({ volume: this.volume })).catch(NocturneNative.noop);
  }

  // El crossfade nativo llega en la fase 2: por ahora cada canción termina entera
  checkCrossfadeTrigger() {
    if (this.native) return;
    super.checkCrossfadeTrigger();
  }

  stopAllAudio() {
    super.stopAllAudio();
    this._leaveNative();
  }

  // ------------------------------------------------------------------ estado

  getCurrentTime() {
    return this.native ? this.nativePos : super.getCurrentTime();
  }

  getDuration() {
    if (!this.native) return super.getDuration();
    return this.nativeDur || (this.nativeTrack && this.nativeTrack.duration) || 0;
  }

  isAudioPlaying() {
    return this.native ? this.nativePlaying : super.isAudioPlaying();
  }

  getPlaybackInfo(track) {
    if (this.native && this.nativeTrack && track && track.id === this.nativeTrack.id) {
      return { position: this.nativePos, duration: this.getDuration() };
    }
    return super.getPlaybackInfo(track);
  }
}

window.NocturneNative = NocturneNative;
window.NativeAudioEngine = NativeAudioEngine;
