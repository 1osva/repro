# 🎵 Nocturne Audio Player

Un reproductor de música moderno con estética oscura profunda (OLED / Glassmorphism), motor de audio de alta fidelidad con **Web Audio API**, **Smart Shuffle (dispersión anti-agrupamiento)** y soporte nativo de **Crossfade continuo sin silencios**.

---

## 🚀 ¿Cómo abrir la Demo?

No requiere instalar ningún programa ni ejecutar comandos en la terminal.

1. Navega a la carpeta del proyecto:
   `C:\Users\S5517\.gemini\antigravity\scratch\nocturne-player\`
2. Haz doble clic en el archivo [`index.html`](file:///C:/Users/S5517/.gemini/antigravity/scratch/nocturne-player/index.html) para abrirlo en tu navegador favorito (Chrome, Edge, Firefox, Brave, etc.).
3. **Para probar de inmediato:** Haz clic en el botón morado **"Cargar Pistas Demo (Sintéticas)"** en el menú lateral. El reproductor sintetizará acordes ambientales, activará el visualizador reactivo y cargará la cola al instante.
4. **Para tu propia música:** Arrastra y suelta tus archivos `.mp3`, `.wav`, `.flac` u `.ogg` directamente dentro del recuadro de la barra lateral.

---

## ⚡ Características Principales

### 1. Algoritmo Smart Shuffle (Anti-Clustering)
* **El problema del azar común:** Las funciones aleatorias uniformes (`Math.random()`) agrupan frecuentemente canciones del mismo artista o álbum, provocando sensación de repetición.
* **Nuestra solución:** 
  1. Aplica permutación base **Fisher-Yates**.
  2. Implementa un pase de **dispersión balanceada**: agrupa las pistas por artista y las distribuye en ranuras equiespaciadas a lo largo de toda la lista.
  3. Suavizado anti-adyacencia: Si dos canciones del mismo artista quedan juntas por el tamaño de la lista, busca un intercambio seguro en el resto de la cola.
  4. Puedes alternar el switch para ver la comparativa estadística entre **Azar Puro** y **Smart Shuffle**.

### 2. Crossfade Fluido (Fundido entre canciones)
* Control de fundido de 0 a 8 segundos.
* El motor dual de Web Audio API atenúa la canción saliente con una rampa exponencial mientras incrementa suavemente el volumen de la nueva, logrando transiciones perfectas como en una estación de radio o sesión de DJ.

### 3. Fade In Suave (Aparición progresiva)
* Regulador de entrada suave de 0 a 5 segundos (por defecto 1.8s).
* Al iniciar una pista o reanudar tras una pausa, el volumen sube progresivamente evitando cualquier chasquido o entrada estridente. Al pausar, aplica un micro fade-out de 0.15s.

### 4. Visualizador de Audio Reactivo (Canvas)
* Conectado directamente al nodo `AnalyserNode` de la Web Audio API.
* 3 modos intercambiables:
  * **Barras de Espectro:** Con picos dinámicos y degradado de color (Violeta a Cian).
  * **Onda:** Osciloscopio de neón en tiempo real.
  * **Pulso Circular:** Espectro radial reactivo.

### 4. Ecualizador de 3 Bandas
* Graves (+/- 10 dB) a 250 Hz.
* Medios (+/- 10 dB) a 1500 Hz.
* Agudos (+/- 10 dB) a 4000 Hz.

---

## ⌨️ Atajos de Teclado

| Tecla | Acción |
| :--- | :--- |
| `Espacio` | Reproducir / Pausar |
| `Flecha Derecha` | Avanzar 5 segundos |
| `Flecha Izquierda` | Retroceder 5 segundos |
| `Shift + Flecha Derecha` | Siguiente canción |
| `Shift + Flecha Izquierda` | Canción anterior |
| `M` | Silenciar / Restaurar volumen |
| `S` | Activar / Desactivar Smart Shuffle |
