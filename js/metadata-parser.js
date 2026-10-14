/**
 * NOCTURNE METADATA & DEMO GENERATOR
 * Extractor universal de metadatos y carátulas de alta resolución para:
 *  - ID3v2.2, ID3v2.3 e ID3v2.4 (MP3) con soporte de portadas de hasta 8MB.
 *  - Metadatos MP4/M4A (átomo 'covr' en archivos AAC de Android/iOS).
 *  - Metadatos FLAC (bloque METADATA_BLOCK_PICTURE).
 *  - Generador procedural de respaldo.
 */

class MetadataParser {
  /**
   * Procesa un archivo File local y extrae información legible y carátula incrustada
   */
  /**
   * Cuántos bytes del inicio hay que leer para ver las etiquetas. Un MP3 con etiqueta ID3 dice
   * su propio tamaño en la cabecera; leer 8MB de cada canción (como antes) copiaba memoria de más
   * justo cuando se precargaba la siguiente pista.
   */
  static async tagSliceSize(file) {
    const MAX = 8 * 1024 * 1024;
    try {
      const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { // "ID3"
        const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
        return Math.min(file.size, tagSize + 10 + 1024, MAX);
      }
      if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) { // MP3 sin etiquetas
        return Math.min(file.size, 64 * 1024);
      }
    } catch (e) { /* si falla, se usa el tamaño máximo */ }
    return Math.min(file.size, MAX);
  }

  static async parseFile(file) {
    // Conservar fielmente el nombre exacto del archivo que ya tiene el usuario
    const exactName = file.name.replace(/\.[^/.]+$/, "").trim();

    const track = {
      id: 'track_' + Math.random().toString(36).substr(2, 9),
      file: file,
      url: URL.createObjectURL(file),
      title: exactName, // Mantiene el nombre exacto del archivo sin modificaciones
      artist: '',
      album: '',
      cover: null,
      duration: 0,
      genre: 'Local Audio',
      format: this.detectFormatFromName(file.name),
      isSynthetic: false
    };

    try {
      // Leer solo lo necesario del inicio (hasta 8MB para carátulas de alta resolución)
      const sliceSize = await this.tagSliceSize(file);
      const buffer = await file.slice(0, sliceSize).arrayBuffer();

      // 1. Intentar parser ID3v2 (MP3)
      let tags = this.extractID3(buffer);

      // 2. Si no es ID3, intentar parser MP4/M4A (AAC común en móviles)
      if (!tags && (file.name.endsWith('.m4a') || file.name.endsWith('.mp4') || file.name.endsWith('.aac'))) {
        tags = this.extractMP4Cover(buffer);
      }

      // 3. Si no, intentar parser FLAC
      if (!tags && file.name.endsWith('.flac')) {
        tags = this.extractFLACCover(buffer);
      }

      if (tags) {
        // Solo asignar artista si es un nombre legítimo (sin publicidad web)
        if (tags.artist && tags.artist.trim().length > 1 && !/unknown|desconocido|track|pista|y2mate|snaptube|download|mp3/i.test(tags.artist)) {
          track.artist = tags.artist.trim();
        }
        if (tags.album && tags.album.trim().length > 1 && !/unknown|desconocido|album/i.test(tags.album)) {
          track.album = tags.album.trim();
        }
        if (tags.cover) {
          track.cover = tags.cover;
        }
      }
    } catch (e) {
      console.warn("Aviso en extracción de metadatos binarios:", e);
    }

    // Si el archivo no traía portada incrustada, generamos un arte moderno con sus iniciales
    if (!track.cover) {
      track.cover = this.generateProceduralCover(track.title, track.artist);
    }

    return track;
  }

  static detectFormatFromName(name) {
    const ext = name.split('.').pop().toLowerCase();
    switch (ext) {
      case 'mp3': return 'MPEG Audio Layer III (MP3)';
      case 'flac': return 'Free Lossless Audio (FLAC 24-bit)';
      case 'm4a': return 'MPEG-4 Audio (AAC)';
      case 'wav': return 'Waveform Audio (PCM Lossless)';
      case 'ogg': return 'Ogg Vorbis';
      default: return 'Audio Hi-Fi';
    }
  }

  static parseFromFilename(filename) {
    const clean = filename.replace(/\.[^/.]+$/, "");
    if (clean.includes(" - ")) {
      const parts = clean.split(" - ");
      return {
        artist: parts[0].trim(),
        title: parts.slice(1).join(" - ").trim(),
        album: 'Álbum Local'
      };
    }
    return {
      artist: 'Artista Desconocido',
      title: clean.trim(),
      album: 'Álbum Local'
    };
  }

  /**
   * Parser ID3v2 robusto (Soporta ID3v2.3 y ID3v2.4 con tamaños synchsafe)
   */
  static extractID3(buffer) {
    if (buffer.byteLength < 10) return null;
    const view = new DataView(buffer);

    // Verificar encabezado "ID3"
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
      return null;
    }

    const version = view.getUint8(3); // 3 para ID3v2.3, 4 para ID3v2.4
    // Tamaño total del tag ID3 (synchsafe integer de 28 bits)
    const tagSize = ((view.getUint8(6) & 0x7F) << 21) |
                    ((view.getUint8(7) & 0x7F) << 14) |
                    ((view.getUint8(8) & 0x7F) << 7) |
                    (view.getUint8(9) & 0x7F);

    const tags = {};
    let offset = 10;
    const maxOffset = Math.min(buffer.byteLength, tagSize + 10);

    while (offset + 10 <= maxOffset) {
      let frameId = "";
      for (let i = 0; i < 4; i++) {
        const charCode = view.getUint8(offset + i);
        if (charCode >= 32 && charCode <= 126) {
          frameId += String.fromCharCode(charCode);
        }
      }

      // Si encontramos padding con ceros, terminamos
      if (frameId.length < 4 || view.getUint8(offset) === 0) break;

      let frameSize = 0;
      if (version === 4) {
        // En ID3v2.4 el frameSize es synchsafe
        frameSize = ((view.getUint8(offset + 4) & 0x7F) << 21) |
                    ((view.getUint8(offset + 5) & 0x7F) << 14) |
                    ((view.getUint8(offset + 6) & 0x7F) << 7) |
                    (view.getUint8(offset + 7) & 0x7F);
      } else {
        // En ID3v2.3 es big-endian estándar
        frameSize = view.getUint32(offset + 4);
      }

      offset += 10; // Saltar encabezado del frame

      if (frameSize <= 0 || offset + frameSize > buffer.byteLength) {
        break;
      }

      try {
        if (frameId === "TIT2") {
          tags.title = this.decodeTextFrame(view, offset, frameSize);
        } else if (frameId === "TPE1") {
          tags.artist = this.decodeTextFrame(view, offset, frameSize);
        } else if (frameId === "TALB") {
          tags.album = this.decodeTextFrame(view, offset, frameSize);
        } else if (frameId === "APIC") {
          // Extraer portada de alta resolución
          const coverUrl = this.extractApicImage(view, offset, frameSize);
          if (coverUrl) tags.cover = coverUrl;
        }
      } catch (err) {
        // Ignorar frame defectuoso y continuar
      }

      offset += frameSize;
    }

    return tags;
  }

  static decodeTextFrame(view, offset, size) {
    const encoding = view.getUint8(offset);
    const bytes = new Uint8Array(view.buffer, offset + 1, size - 1);
    const decoder = new TextDecoder(encoding === 1 ? 'utf-16' : 'utf-8');
    return decoder.decode(bytes).replace(/\0/g, '').trim();
  }

  /**
   * Extrae la imagen APIC (JPEG, PNG, WEBP) incrustada en ID3
   */
  static extractApicImage(view, offset, size) {
    const encoding = view.getUint8(offset);
    let cursor = offset + 1;

    // 1. Saltar MIME Type (cadena terminada en null)
    let mime = "";
    while (cursor < offset + size && view.getUint8(cursor) !== 0) {
      mime += String.fromCharCode(view.getUint8(cursor));
      cursor++;
    }
    cursor++; // Saltar el terminador null

    // 2. Saltar Picture Type (1 byte)
    cursor++;

    // 3. Saltar Descripción
    if (encoding === 1 || encoding === 2) {
      // UTF-16: terminado en doble null (0x00 0x00)
      while (cursor < offset + size - 1 && !(view.getUint8(cursor) === 0 && view.getUint8(cursor + 1) === 0)) {
        cursor += 2;
      }
      cursor += 2;
    } else {
      // ISO-8859-1 / UTF-8: terminado en null simple
      while (cursor < offset + size && view.getUint8(cursor) !== 0) {
        cursor++;
      }
      cursor++;
    }

    if (cursor >= offset + size) return null;

    const imgBytes = new Uint8Array(view.buffer, cursor, size - (cursor - offset));
    if (imgBytes.length < 16) return null;

    // Detección rigurosa de formato por Magic Bytes
    let detectedMime = mime || "image/jpeg";
    if (imgBytes[0] === 0xFF && imgBytes[1] === 0xD8) {
      detectedMime = "image/jpeg";
    } else if (imgBytes[0] === 0x89 && imgBytes[1] === 0x50 && imgBytes[2] === 0x4E && imgBytes[3] === 0x47) {
      detectedMime = "image/png";
    } else if (imgBytes[0] === 0x52 && imgBytes[1] === 0x49 && imgBytes[2] === 0x46 && imgBytes[3] === 0x46) {
      detectedMime = "image/webp";
    }

    const blob = new Blob([imgBytes], { type: detectedMime });
    return URL.createObjectURL(blob);
  }

  /**
   * Extrae la carátula en archivos AAC/MP4/M4A (átomo 'covr') comunes de Android
   */
  static extractMP4Cover(buffer) {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;

    // Buscar la secuencia de 4 caracteres 'covr'
    for (let i = 0; i < len - 16; i++) {
      if (
        bytes[i] === 0x63 &&     // 'c'
        bytes[i + 1] === 0x6F && // 'o'
        bytes[i + 2] === 0x76 && // 'v'
        bytes[i + 3] === 0x72    // 'r'
      ) {
        // En MP4, dentro de 'covr' viene un átomo 'data'
        // Buscar cabecera JPEG (FF D8) o PNG (89 50 4E 47) en los siguientes 64 bytes
        for (let j = i + 4; j < Math.min(i + 64, len - 4); j++) {
          if (bytes[j] === 0xFF && bytes[j + 1] === 0xD8) {
            const imgBytes = bytes.slice(j);
            const blob = new Blob([imgBytes], { type: 'image/jpeg' });
            return { cover: URL.createObjectURL(blob) };
          }
          if (bytes[j] === 0x89 && bytes[j + 1] === 0x50 && bytes[j + 2] === 0x4E) {
            const imgBytes = bytes.slice(j);
            const blob = new Blob([imgBytes], { type: 'image/png' });
            return { cover: URL.createObjectURL(blob) };
          }
        }
      }
    }
    return null;
  }

  /**
   * Extrae la carátula en archivos FLAC (bloque METADATA_BLOCK_PICTURE)
   */
  static extractFLACCover(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0x66 || bytes[1] !== 0x4C || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
      return null; // No es 'fLaC'
    }

    let offset = 4;
    while (offset < bytes.length - 8) {
      const isLast = (bytes[offset] & 0x80) !== 0;
      const type = bytes[offset] & 0x7F;
      const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      offset += 4;

      if (type === 6) { // METADATA_BLOCK_PICTURE
        const view = new DataView(buffer, offset, length);
        const mimeLen = view.getUint32(4);
        let mime = "";
        for (let m = 0; m < mimeLen; m++) {
          mime += String.fromCharCode(view.getUint8(8 + m));
        }

        const descLen = view.getUint32(8 + mimeLen);
        const dataOffset = 8 + mimeLen + 4 + descLen + 16;
        const imgLen = view.getUint32(dataOffset - 4);

        const imgBytes = new Uint8Array(buffer, offset + dataOffset, imgLen);
        const blob = new Blob([imgBytes], { type: mime || 'image/jpeg' });
        return { cover: URL.createObjectURL(blob) };
      }

      offset += length;
      if (isLast) break;
    }
    return null;
  }

  /**
   * Genera un arte visual abstracto procedural con Canvas si la canción no tiene portada
   */
  static generateProceduralCover(title, artist) {
    const canvas = document.createElement('canvas');
    canvas.width = 280;
    canvas.height = 280;
    const ctx = canvas.getContext('2d');

    const seed = (title + artist).split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const hue1 = seed % 360;
    const hue2 = (hue1 + 100) % 360;

    const grad = ctx.createLinearGradient(0, 0, 280, 280);
    grad.addColorStop(0, `hsl(${hue1}, 75%, 22%)`);
    grad.addColorStop(1, `hsl(${hue2}, 85%, 12%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 280, 280);

    ctx.fillStyle = `hsla(${hue2}, 95%, 65%, 0.22)`;
    ctx.beginPath();
    ctx.arc(140 + Math.cos(seed) * 35, 140 + Math.sin(seed) * 35, 75, 0, Math.PI * 2);
    ctx.fill();

    const initials = (title.charAt(0) + (artist.charAt(0) || '')).toUpperCase();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 48px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 140, 140);

    return canvas.toDataURL();
  }

  /**
   * Pistas sintéticas demo integradas
   */
  static getDemoTracks() {
    return [
      {
        id: 'demo_1',
        title: 'Neon Odyssey (Lofi Dream)',
        artist: 'Aether Wave',
        album: 'Cybernetic Night',
        genre: 'Synth / Ambient',
        format: 'Web Audio Synth',
        duration: 180,
        isSynthetic: true,
        cover: this.generateProceduralCover('Neon Odyssey', 'Aether Wave'),
        chords: [
          [220, 261.63, 329.63, 392],
          [174.61, 220, 261.63, 329.63],
          [130.81, 164.81, 196, 246.94],
          [196, 246.94, 293.66, 349.23]
        ]
      },
      {
        id: 'demo_2',
        title: 'Obsidian Horizon',
        artist: 'Solaris Dusk',
        album: 'Event Horizon',
        genre: 'Deep Space Chill',
        format: 'Web Audio Synth',
        duration: 210,
        isSynthetic: true,
        cover: this.generateProceduralCover('Obsidian Horizon', 'Solaris Dusk'),
        chords: [
          [146.83, 174.61, 220, 261.63],
          [196, 246.94, 293.66, 349.23],
          [164.81, 196, 246.94, 293.66],
          [220, 261.63, 329.63, 392]
        ]
      },
      {
        id: 'demo_3',
        title: 'Midnight Rain (Cyberpunk)',
        artist: 'Aether Wave',
        album: 'Cybernetic Night',
        genre: 'Lofi Chillhop',
        format: 'Web Audio Synth',
        duration: 195,
        isSynthetic: true,
        cover: this.generateProceduralCover('Midnight Rain', 'Aether Wave'),
        chords: [
          [261.63, 329.63, 392, 493.88],
          [220, 261.63, 329.63, 392],
          [174.61, 220, 261.63, 329.63],
          [196, 246.94, 293.66, 349.23]
        ]
      },
      {
        id: 'demo_4',
        title: 'Quantum Drift',
        artist: 'Kroma Void',
        album: 'Subatomic Pulse',
        genre: 'Darkwave / IDM',
        format: 'Web Audio Synth',
        duration: 240,
        isSynthetic: true,
        cover: this.generateProceduralCover('Quantum Drift', 'Kroma Void'),
        chords: [
          [110, 164.81, 220, 277.18],
          [123.47, 185.00, 246.94, 293.66],
          [146.83, 174.61, 220, 261.63],
          [130.81, 164.81, 196, 246.94]
        ]
      },
      {
        id: 'demo_5',
        title: 'Solar Winds',
        artist: 'Solaris Dusk',
        album: 'Event Horizon',
        genre: 'Ambient Space',
        format: 'Web Audio Synth',
        duration: 175,
        isSynthetic: true,
        cover: this.generateProceduralCover('Solar Winds', 'Solaris Dusk'),
        chords: [
          [174.61, 220, 261.63, 329.63],
          [130.81, 164.81, 196, 246.94],
          [196, 246.94, 293.66, 349.23],
          [220, 261.63, 329.63, 392]
        ]
      }
    ];
  }
}

window.MetadataParser = MetadataParser;
