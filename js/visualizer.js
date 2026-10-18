/**
 * Modo ligero: en celulares se reduce el costo de dibujo (menos fotogramas,
 * sin sombras difusas, menor resolución) para que no compita con el audio.
 */
const NOCTURNE_LITE = (() => {
  try {
    const native = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    const android = /Android/i.test(navigator.userAgent);
    const narrow = !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
    return native || android || narrow;
  } catch (e) {
    return false;
  }
})();
if (NOCTURNE_LITE) document.documentElement.classList.add('lite');

/**
 * NOCTURNE AUDIO VISUALIZER
 * Visualizador Canvas reactivo con extracción dinámica de paleta de colores.
 * Modos:
 *  - Barras: Portada nítida y visible de fondo, con espectro coloreado según la portada.
 *  - Onda: Osciloscopio con resplandor neón adaptado a la tonalidad del álbum.
 *  - Pulso: Disco de vinilo giratorio central con recorte 1:1 estricto (sin deformaciones),
 *           púas reactivas a juego con la paleta y fondo ambiental difuminado elegante.
 */

class Visualizer {
  constructor(canvasId, audioEngine) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.audioEngine = audioEngine;
    this.mode = 'bars'; // 'bars', 'wave', 'circle'

    this.peaks = [];
    this.animationId = null;
    this.idlePhase = 0;

    // Gestión de Carátula y Dinámica
    this.coverImg = null;
    this.coverLoaded = false;
    this.rotationAngle = 0;
    this.bassEnergy = 0; // 0.0 a 1.0

    // Paleta de colores dinámica adaptativa
    this.palette = {
      primary: '#8b5cf6',
      secondary: '#06b6d4',
      primaryRgb: { r: 139, g: 92, b: 246 },
      secondaryRgb: { r: 6, g: 182, b: 212 }
    };
    this.onPaletteExtracted = null;

    // Sincronía con lo que se escucha: el analizador lee el audio ANTES de que salga
    // por el altavoz, así que se retrasa lo dibujado por la latencia de salida.
    this.enabled = true;     // false = solo se dibuja la portada (ahorra batería y CPU)
    this.syncOffsetMs = 0;   // ajuste manual extra (Ajustes > Sincronía de las barras)
    this._ring = [];
    this._ringHead = 0;
    this._ringCount = 0;
    this._interval = 0;      // 0 = a la velocidad de la pantalla; si dibujar cuesta mucho, 30 fps

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.start();
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, NOCTURNE_LITE ? 1.5 : 2);
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    if (this.ctx) {
      this.ctx.scale(dpr, dpr);
    }
    this.width = rect.width;
    this.height = rect.height;
  }

  setMode(newMode) {
    this.mode = newMode;
  }

  /**
   * Extrae los colores dominantes y vibrantes de la carátula
   */
  static extractPalette(img) {
    try {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;

      const candidates = [];
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 128) continue;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lum = (max + min) / 510;
        const sat = max === 0 ? 0 : (max - min) / max;

        // Filtrar oscuros profundos y blancos para capturar tonos cromáticos
        if (lum > 0.18 && lum < 0.85 && sat > 0.20) {
          const score = sat * 1.5 + (1 - Math.abs(lum - 0.5));
          candidates.push({ r, g, b, score });
        }
      }

      let primary = { r: 139, g: 92, b: 246 };
      let secondary = { r: 6, g: 182, b: 212 };

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        primary = candidates[0];

        for (let j = 1; j < candidates.length; j++) {
          const c = candidates[j];
          const dist = Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b);
          if (dist > 80) {
            secondary = c;
            break;
          }
        }
      }

      return {
        primary: `rgb(${primary.r}, ${primary.g}, ${primary.b})`,
        secondary: `rgb(${secondary.r}, ${secondary.g}, ${secondary.b})`,
        primaryRgb: primary,
        secondaryRgb: secondary
      };
    } catch (e) {
      return {
        primary: '#8b5cf6',
        secondary: '#06b6d4',
        primaryRgb: { r: 139, g: 92, b: 246 },
        secondaryRgb: { r: 6, g: 182, b: 212 }
      };
    }
  }

  /**
   * Carga la imagen de portada y sincroniza la paleta cromática
   */
  setCover(coverUrl) {
    if (!coverUrl) {
      this.coverImg = null;
      this.coverLoaded = false;
      this.palette = {
        primary: '#8b5cf6',
        secondary: '#06b6d4',
        primaryRgb: { r: 139, g: 92, b: 246 },
        secondaryRgb: { r: 6, g: 182, b: 212 }
      };
      if (this.onPaletteExtracted) {
        this.onPaletteExtracted(this.palette);
      }
      return;
    }

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.coverImg = img;
      this.coverLoaded = true;
      this.palette = Visualizer.extractPalette(img);
      if (this.onPaletteExtracted) {
        this.onPaletteExtracted(this.palette);
      }
    };
    img.onerror = () => {
      this.coverImg = null;
      this.coverLoaded = false;
    };
    img.src = coverUrl;
  }

  start() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    let last = 0;
    let costAvg = 0;
    const render = (now) => {
      this.animationId = requestAnimationFrame(render);
      if (document.hidden || this.paused) return; // app en segundo plano o pantalla oculta: no dibujar

      const elapsed = now - last;
      if (this.enabled === false && elapsed < 250) return; // sin animación: basta con refrescar poco
      if (this._interval && elapsed < this._interval - 1) return; // 1 ms de tolerancia al jitter
      // Se conserva el resto para no acumular deriva (antes se caía a ~20 fps irregulares)
      last = this._interval ? now - (elapsed % this._interval) : now;

      const t0 = performance.now();
      this.draw();
      const cost = performance.now() - t0;
      costAvg = costAvg ? costAvg * 0.9 + cost * 0.1 : cost;

      // Solo se baja a 30 fps si dibujar de verdad es caro; si vuelve a ser barato, se sube
      if (!this._interval && costAvg > 12) this._interval = 1000 / 30;
      else if (this._interval && costAvg < 5) this._interval = 0;
    };
    this.animationId = requestAnimationFrame(render);
  }

  /** Latencia total entre analizar el audio y oírlo (ms), más el ajuste manual. */
  _latencyMs() {
    const ctx = this.audioEngine && this.audioEngine.ctx;
    let ms = 0;
    if (ctx) ms = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
    return Math.max(0, Math.min(600, ms + (this.syncOffsetMs || 0)));
  }

  /** Guarda lo que "suena" en este instante para mostrarlo cuando de verdad se oiga. */
  _record(analyser, now) {
    const n = analyser.frequencyBinCount;
    if (this._ring.length === 0 || this._ring[0].freq.length !== n) {
      this._ring = Array.from({ length: 40 }, () => ({ t: 0, freq: new Uint8Array(n), time: new Uint8Array(n) }));
      this._ringHead = 0;
      this._ringCount = 0;
    }
    const e = this._ring[this._ringHead];
    e.t = now;
    analyser.getByteFrequencyData(e.freq);
    analyser.getByteTimeDomainData(e.time);
    this._ringHead = (this._ringHead + 1) % this._ring.length;
    this._ringCount = Math.min(this._ringCount + 1, this._ring.length);
  }

  /** Devuelve la muestra de hace `latencia` ms (o la más antigua si aún no hay tanto historial). */
  _delayed(now) {
    const target = now - this._latencyMs();
    const len = this._ring.length;
    let pick = null;
    for (let i = 0; i < this._ringCount; i++) {
      const e = this._ring[(this._ringHead - 1 - i + len * 2) % len];
      pick = e;
      if (e.t <= target) break;
    }
    return pick;
  }

  draw() {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    const analyser = this.audioEngine.analyser;
    const isPlaying = this.audioEngine._initialized && (
      (this.audioEngine.getActivePlayer().audio && !this.audioEngine.getActivePlayer().audio.paused) ||
      this.audioEngine.synthActive
    );

    const now = performance.now();
    let snap = null;
    if (this.enabled && analyser && isPlaying) {
      this._record(analyser, now);
      snap = this._delayed(now);
    } else {
      this._ringCount = 0; // al pausar, no reutilizar muestras viejas al reanudar
    }

    if (snap) {
      const freqData = snap.freq;
      const bufferLength = freqData.length;

      let bassSum = 0;
      const sr = (this.audioEngine.ctx && this.audioEngine.ctx.sampleRate) || 48000;
      const bassBins = Math.max(2, Math.min(bufferLength, Math.round(160 / ((sr / 2) / bufferLength)))); // graves: hasta ~160 Hz
      for (let i = 0; i < bassBins; i++) {
        bassSum += freqData[i];
      }
      this.bassEnergy = (bassSum / bassBins) / 255.0;
      this.rotationAngle += 0.007 + (this.bassEnergy * 0.014);
    } else {
      this.bassEnergy = Math.max(0, this.bassEnergy - 0.05);
      this.rotationAngle += 0.002;
    }

    // Fondo visible y adaptativo
    this.drawBackground(w, h);

    if (!snap) {
      if (!this.enabled && isPlaying) return; // animación apagada: queda solo la portada
      this.drawIdleState(w, h);
      return;
    }

    const bufferLength = snap.freq.length;

    if (this.mode === 'wave') {
      this.drawWaveform(snap.time, bufferLength, w, h);
    } else if (this.mode === 'circle') {
      this.drawCircularPulse(snap.freq, bufferLength, w, h);
    } else {
      this.drawSpectrumBars(snap.freq, bufferLength, w, h);
    }
  }

  drawBackground(w, h) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    if (this.coverLoaded && this.coverImg && this.coverImg.complete && this.coverImg.naturalWidth > 0) {
      ctx.save();

      const imgW = this.coverImg.naturalWidth || this.coverImg.width;
      const imgH = this.coverImg.naturalHeight || this.coverImg.height;
      const imgAspect = imgW / imgH;
      const canvasAspect = w / h;

      let renderW, renderH;

      if (canvasAspect > imgAspect) {
        renderW = w;
        renderH = w / imgAspect;
      } else {
        renderH = h;
        renderW = h * imgAspect;
      }

      const offsetX = (w - renderW) / 2;
      const offsetY = (h - renderH) / 2;

      // Opacidad clara y agradable para que se vea la portada nítidamente
      ctx.globalAlpha = this.mode === 'circle' ? 0.55 : 0.65;
      ctx.drawImage(this.coverImg, offsetX, offsetY, renderW, renderH);

      // Máscara sutil para contraste elegante
      if (this.mode === 'circle') {
        const radGrad = ctx.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, Math.max(w, h) * 0.65);
        radGrad.addColorStop(0, 'rgba(12, 14, 22, 0.40)');
        radGrad.addColorStop(0.5, 'rgba(9, 11, 17, 0.60)');
        radGrad.addColorStop(1, 'rgba(7, 8, 12, 0.85)');
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = radGrad;
        ctx.fillRect(0, 0, w, h);
      } else {
        const overlayGrad = ctx.createLinearGradient(0, 0, 0, h);
        overlayGrad.addColorStop(0, 'rgba(7, 8, 12, 0.35)');
        overlayGrad.addColorStop(0.5, 'rgba(7, 8, 12, 0.45)');
        overlayGrad.addColorStop(1, 'rgba(7, 8, 12, 0.70)');
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = overlayGrad;
        ctx.fillRect(0, 0, w, h);
      }

      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(7, 8, 12, 0.95)';
      ctx.fillRect(0, 0, w, h);
    }
  }

  drawIdleState(w, h) {
    const ctx = this.ctx;
    this.idlePhase += 0.02;

    const p = this.palette ? this.palette.primary : '#8b5cf6';
    ctx.save();
    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p;

    for (let x = 0; x < w; x += 4) {
      const y = h / 2 + Math.sin(x * 0.01 + this.idlePhase) * 12 + Math.cos(x * 0.02 - this.idlePhase) * 6;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Reparto de las barras por frecuencia: escala logarítmica de 45 Hz a 14 kHz (como oye el oído).
   * Así todo el ancho se mueve con la música; antes las barras repartían las frecuencias en línea recta
   * y casi toda la música caía en las primeras, dejando el otro lado plano.
   */
  _bandPlan(barCount, binCount, sampleRate) {
    const key = `${barCount}|${binCount}|${sampleRate}`;
    if (this._plan && this._plan.key === key) return this._plan;
    const FMIN = 45;
    const FMAX = Math.min(14000, (sampleRate / 2) * 0.95);
    const binHz = (sampleRate / 2) / binCount;
    const lo = new Float32Array(barCount);
    const hi = new Float32Array(barCount);
    const tilt = new Float32Array(barCount);
    for (let i = 0; i < barCount; i++) {
      const f0 = FMIN * Math.pow(FMAX / FMIN, i / barCount);
      const f1 = FMIN * Math.pow(FMAX / FMIN, (i + 1) / barCount);
      lo[i] = f0 / binHz;
      hi[i] = f1 / binHz;
      // La música pierde ~3 dB por octava hacia los agudos: se compensa para que se vean igual de vivos
      tilt[i] = Math.max(-3, Math.min(16, 3.2 * Math.log2(Math.sqrt(f0 * f1) / 250)));
    }
    this._plan = { key, lo, hi, tilt };
    return this._plan;
  }

  /** Valor de una banda: si es más angosta que un punto del analizador se interpola; si no, mezcla de pico y promedio. */
  _bandValue(data, lo, hi) {
    const n = data.length;
    if (hi - lo < 1) {
      const c = Math.min(n - 1, (lo + hi) / 2);
      const k = Math.floor(c);
      const a = data[k] || 0;
      const b = data[Math.min(n - 1, k + 1)] || 0;
      return a + (b - a) * (c - k);
    }
    const k0 = Math.max(0, Math.floor(lo));
    const k1 = Math.min(n - 1, Math.ceil(hi));
    let max = 0;
    let sum = 0;
    for (let k = k0; k <= k1; k++) {
      const v = data[k];
      if (v > max) max = v;
      sum += v;
    }
    return 0.6 * max + 0.4 * (sum / (k1 - k0 + 1));
  }

  drawSpectrumBars(dataArray, bufferLength, w, h) {
    const ctx = this.ctx;
    const barCount = Math.max(28, Math.min(56, Math.floor(w / 8.5)));
    const barSpacing = 4;
    const barWidth = (w - barSpacing * (barCount + 1)) / barCount;
    const sampleRate = (this.audioEngine.ctx && this.audioEngine.ctx.sampleRate) || 48000;
    const analyser = this.audioEngine.analyser;
    const dbRange = (analyser && (analyser.maxDecibels - analyser.minDecibels)) || 70;
    const plan = this._bandPlan(barCount, bufferLength, sampleRate);

    // Tiempo entre fotogramas: las barras reaccionan igual a 30 que a 60 fps
    const now = performance.now();
    const dt = Math.max(8, Math.min(50, now - (this._barsT || now - 16)));
    this._barsT = now;

    if (!this._bars || this._bars.length !== barCount) {
      this._bars = new Float32Array(barCount);
      this._levels = new Float32Array(barCount);
      this._bandRef = new Float32Array(barCount).fill(0.4);
      this.peaks = new Array(barCount).fill(0); // 0..1
    }

    // 1) Nivel de cada banda (0..1), con compensación de agudos y una compuerta contra el ruido de fondo
    const FLOOR = 40;
    const toBytes = 255 / dbRange;
    let frameMax = 0;
    for (let i = 0; i < barCount; i++) {
      const raw = this._bandValue(dataArray, plan.lo[i], plan.hi[i]) + plan.tilt[i] * toBytes;
      const level = Math.max(0, (raw - FLOOR) / (255 - FLOOR)); // sin tope: así un golpe fuerte no aplana las barras vecinas
      this._levels[i] = level;
      if (level > frameMax) frameMax = level;
    }

    // 2) Ganancia automática: las barras se ajustan al volumen de la canción (suave o fuerte, siempre se ven completas)
    this._agc = Math.max(frameMax, (this._agc || 0.5) * Math.pow(0.994, dt / 16.7));
    const gain = Math.min(2.2, 0.9 / Math.max(0.3, this._agc));

    // Cada banda también se ajusta a su propio rango reciente: los agudos suaves se ven tan vivos como los graves
    const bandDecay = Math.pow(0.997, dt / 16.7);
    for (let i = 0; i < barCount; i++) {
      this._bandRef[i] = Math.max(this._levels[i], this._bandRef[i] * bandDecay);
    }

    // 3) Ataque rápido (golpea con el ritmo) y caída más lenta (se ve fluido)
    const attack = 1 - Math.pow(1 - 0.75, dt / 16.7);
    const release = 1 - Math.pow(1 - 0.16, dt / 16.7);

    const p = this.palette ? this.palette.primary : '#8b5cf6';
    const s = this.palette ? this.palette.secondary : '#06b6d4';
    const pr = this.palette ? this.palette.primaryRgb : { r: 139, g: 92, b: 246 };
    const maxH = h * 0.76;

    for (let i = 0; i < barCount; i++) {
      const shared = this._levels[i] * gain;                                   // según el volumen de toda la canción
      const own = Math.pow(Math.min(1.2, this._levels[i] / Math.max(this._bandRef[i], 0.25)), 1.5) * 0.92; // según el rango de esta frecuencia (más contraste)
      const target = Math.pow(Math.min(1, shared * 0.45 + own * 0.55), 1.3);   // algo de contraste: lo suave queda bajo, lo fuerte sube
      const cur = this._bars[i];
      const next = cur + (target - cur) * (target > cur ? attack : release);
      this._bars[i] = next;

      this.peaks[i] = Math.max(next, this.peaks[i] - dt * 0.0009);

      const barHeight = Math.max(4, next * maxH);
      const x = barSpacing + i * (barWidth + barSpacing);
      const y = h - barHeight;

      // Gradiente que armoniza con los colores de la portada
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, s);
      grad.addColorStop(0.4, p);
      grad.addColorStop(1, `rgba(${pr.r}, ${pr.g}, ${pr.b}, 0.20)`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [4, 4, 0, 0]);
      ctx.fill();

      // Puntas brillantes a juego con el acento secundario
      const peakY = h - this.peaks[i] * maxH - 6;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = s;
      ctx.shadowBlur = NOCTURNE_LITE ? 0 : 10;
      ctx.fillRect(x, Math.max(0, peakY), barWidth, 2.5);
      ctx.shadowBlur = 0;
    }
  }

  drawWaveform(dataArray, bufferLength, w, h) {
    const ctx = this.ctx;
    const s = this.palette ? this.palette.secondary : '#06b6d4';

    ctx.lineWidth = 2.8;
    ctx.strokeStyle = s;
    ctx.shadowColor = s;
    ctx.shadowBlur = NOCTURNE_LITE ? 0 : 14;

    ctx.beginPath();
    const sliceWidth = w / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * h) / 2;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);

      x += sliceWidth;
    }

    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /**
   * Modo Pulso: Vinilo giratorio dinámico con colores de la portada
   */
  drawCircularPulse(dataArray, bufferLength, w, h) {
    const ctx = this.ctx;
    const centerX = w / 2;
    const centerY = h / 2;

    const baseRadius = Math.min(w, h) * 0.22;
    const dynamicRadius = baseRadius + (this.bassEnergy * 8);
    const points = 60;
    const step = Math.floor(bufferLength / points);

    const p = this.palette ? this.palette.primary : '#8b5cf6';
    const s = this.palette ? this.palette.secondary : '#06b6d4';

    // 1. PÚAS RADIALES DE FRECUENCIA A JUEGO CON LA PORTADA
    for (let i = 0; i < points; i++) {
      const val = dataArray[i * step] || 0;
      const spikeLen = (val / 255) * (baseRadius * 0.8);
      const angle = (i / points) * Math.PI * 2;

      const innerX = centerX + Math.cos(angle) * (dynamicRadius + 6);
      const innerY = centerY + Math.sin(angle) * (dynamicRadius + 6);
      const outerX = centerX + Math.cos(angle) * (dynamicRadius + 6 + spikeLen);
      const outerY = centerY + Math.sin(angle) * (dynamicRadius + 6 + spikeLen);

      ctx.beginPath();
      ctx.moveTo(innerX, innerY);
      ctx.lineTo(outerX, outerY);
      ctx.strokeStyle = i % 2 === 0 ? p : s;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = NOCTURNE_LITE ? 0 : 8;
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // 2. DISCO CENTRAL CON RESPLANDOR
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, dynamicRadius + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0d14';
    ctx.shadowColor = p;
    ctx.shadowBlur = NOCTURNE_LITE ? 0 : 20;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Ranuras concéntricas de acetato
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let r = dynamicRadius - 8; r > dynamicRadius * 0.78; r -= 6) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 3. CARÁTULA EN ROTACIÓN CONTINUA (CON RECORTE 1:1 PERFECTO SIN DEFORMARSE)
    const artRadius = dynamicRadius * 0.72;
    ctx.save();
    ctx.translate(centerX, centerY);
    // Gira suavemente con el ritmo de la música
    ctx.rotate(this.rotationAngle);

    ctx.beginPath();
    ctx.arc(0, 0, artRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    if (this.coverLoaded && this.coverImg && this.coverImg.complete && this.coverImg.naturalWidth > 0) {
      const iw = this.coverImg.naturalWidth;
      const ih = this.coverImg.naturalHeight;
      const minDim = Math.min(iw, ih);
      const sx = (iw - minDim) / 2;
      const sy = (ih - minDim) / 2;

      ctx.drawImage(this.coverImg, sx, sy, minDim, minDim, -artRadius, -artRadius, artRadius * 2, artRadius * 2);
    } else {
      const grad = ctx.createLinearGradient(-artRadius, -artRadius, artRadius, artRadius);
      grad.addColorStop(0, p);
      grad.addColorStop(1, s);
      ctx.fillStyle = grad;
      ctx.fillRect(-artRadius, -artRadius, artRadius * 2, artRadius * 2);

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 24px "Plus Jakarta Sans"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♪', 0, 0);
    }
    ctx.restore();

    // 4. ANILLO Y EJE METÁLICO
    ctx.beginPath();
    ctx.arc(centerX, centerY, artRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY, artRadius * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = '#07080c';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.restore();
  }
}

window.Visualizer = Visualizer;
