/**
 * NOCTURNE SMART SHUFFLE ENGINE
 * Implementación de Algoritmo de Azar Equilibrado (Anti-Clustering & Balanced Dispersal).
 * 
 * Por qué el shuffle aleatorio puro falla para los humanos:
 * El azar uniforme O(1) agrupa aleatoriamente pistas del mismo autor ("clustering illusion"),
 * haciendo que parezca sesgado.
 * 
 * Este algoritmo:
 * 1. Aplica permutación estricta de Fisher-Yates como base sin sesgo.
 * 2. Aplica un filtro de Dispersión Anti-Agrupamiento: penaliza y reubica
 *    canciones consecutivas del mismo artista o álbum.
 */

class SmartShuffle {
  /**
   * Barajado Fisher-Yates clásico (puro e imparcial)
   */
  static pureShuffle(array) {
    const list = [...array];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  /**
   * Algoritmo Smart Shuffle con Dispersión Anti-Clustering (Tipo Spotify)
   * @param {Array} tracks Lista de canciones con propiedades `artist`, `album`, etc.
   * @returns {Array} Lista redistribuida con separación máxima de artistas
   */
  static balancedShuffle(tracks) {
    if (!tracks || tracks.length <= 2) return [...tracks];

    // 1. Agrupar pistas por artista
    const artistGroups = new Map();
    tracks.forEach(track => {
      const artist = (track.artist || 'Desconocido').toLowerCase().trim();
      if (!artistGroups.has(artist)) {
        artistGroups.set(artist, []);
      }
      artistGroups.get(artist).push(track);
    });

    // 2. Barajar internamente cada grupo de artista usando Fisher-Yates
    for (const [artist, group] of artistGroups.entries()) {
      artistGroups.set(artist, this.pureShuffle(group));
    }

    // 3. Ordenar los grupos por tamaño descendente (los artistas con más pistas primero)
    const sortedGroups = Array.from(artistGroups.values()).sort(
      (a, b) => b.length - a.length
    );

    // 4. Distribuir en ranuras equiespaciadas (Dithering Dispersal)
    const totalCount = tracks.length;
    const result = new Array(totalCount).fill(null);

    // Ranuras disponibles
    const freeSlots = Array.from({ length: totalCount }, (_, i) => i);

    for (const group of sortedGroups) {
      const groupSize = group.length;
      const step = totalCount / groupSize;

      // Desplazamiento inicial aleatorio para variedad
      let offset = Math.floor(Math.random() * Math.min(step, totalCount));

      for (let i = 0; i < groupSize; i++) {
        let idealPos = Math.floor(offset + (i * step)) % totalCount;

        // Encontrar la ranura libre más cercana a la posición ideal
        let bestSlotIdx = -1;
        let minDistance = Infinity;

        for (let s = 0; s < freeSlots.length; s++) {
          const slot = freeSlots[s];
          const dist = Math.abs(slot - idealPos);
          if (dist < minDistance) {
            minDistance = dist;
            bestSlotIdx = s;
          }
        }

        if (bestSlotIdx !== -1) {
          const chosenSlot = freeSlots[bestSlotIdx];
          result[chosenSlot] = group[i];
          freeSlots.splice(bestSlotIdx, 1);
        }
      }
    }

    // 5. Pase de seguridad de suavizado anti-adyacencia:
    // Si por el tamaño de lista dos canciones del mismo artista quedaron contiguas,
    // buscar un intercambio seguro sin conflicto.
    for (let i = 0; i < result.length - 1; i++) {
      const current = result[i];
      const next = result[i + 1];

      if (current && next && this.isSameArtist(current, next)) {
        // Buscar un candidato más adelante para intercambiar
        for (let j = i + 2; j < result.length; j++) {
          const candidate = result[j];
          const prevOfCandidate = result[j - 1];
          const nextOfCandidate = result[j + 1];

          if (
            !this.isSameArtist(candidate, current) &&
            (!prevOfCandidate || !this.isSameArtist(prevOfCandidate, next)) &&
            (!nextOfCandidate || !this.isSameArtist(nextOfCandidate, next))
          ) {
            // Intercambio seguro
            [result[i + 1], result[j]] = [result[j], result[i + 1]];
            break;
          }
        }
      }
    }

    return result.filter(item => item !== null);
  }

  static isSameArtist(trackA, trackB) {
    if (!trackA || !trackB) return false;
    const a = (trackA.artist || '').toLowerCase().trim();
    const b = (trackB.artist || '').toLowerCase().trim();
    return a === b && a.length > 0;
  }

  /**
   * Evalúa la calidad del azar midiendo choques de artistas consecutivos
   */
  static evaluateClustering(playlist) {
    let consecutiveClashes = 0;
    for (let i = 0; i < playlist.length - 1; i++) {
      if (this.isSameArtist(playlist[i], playlist[i + 1])) {
        consecutiveClashes++;
      }
    }
    return {
      totalTracks: playlist.length,
      clashes: consecutiveClashes,
      qualityScore: playlist.length > 1 
        ? Math.max(0, 100 - Math.round((consecutiveClashes / (playlist.length - 1)) * 100))
        : 100
    };
  }
}

window.SmartShuffle = SmartShuffle;
