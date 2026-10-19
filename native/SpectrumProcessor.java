package __APP_PACKAGE__;

import androidx.media3.common.C;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

/**
 * Procesador de audio "transparente" para ExoPlayer: deja pasar el sonido tal cual y, mientras
 * alguien lo pide (visualizador a la vista), calcula el espectro de frecuencias con una FFT.
 *
 * Reproduce lo que hace el AnalyserNode de Web Audio con la configuración de la app
 * (fftSize 256 -> 128 barras, suavizado 0.72, -100..-30 dB, ventana de Blackman), así los tres
 * modos del visualizador se ven igual que con el motor anterior.
 *
 * Corre en el hilo de reproducción: es barato y no reserva memoria salvo 2 arreglos pequeños
 * por cada cuadro (~30 por segundo).
 */
@UnstableApi
final class SpectrumProcessor extends BaseAudioProcessor {

    static final int FFT_SIZE = 256;
    static final int BINS = FFT_SIZE / 2;

    private static final float SMOOTHING = 0.72f;
    private static final float MIN_DB = -100f;
    private static final float MAX_DB = -30f;
    private static final int FPS = 30;

    private final float[] window = new float[FFT_SIZE];
    private final float[] cosT = new float[FFT_SIZE / 2];
    private final float[] sinT = new float[FFT_SIZE / 2];
    private final float[] ring = new float[FFT_SIZE];
    private final float[] re = new float[FFT_SIZE];
    private final float[] im = new float[FFT_SIZE];
    private final float[] smoothed = new float[BINS];

    private int ringPos = 0;
    private int sinceFft = 0;
    private int channels = 2;
    private int encoding = C.ENCODING_PCM_16BIT;

    private volatile boolean enabled = false;
    private volatile int sampleRate = 44100;
    private volatile long processedFrames = 0;
    private volatile byte[] freqOut = new byte[BINS];
    private volatile byte[] timeOut = filled(BINS, (byte) 128);

    SpectrumProcessor() {
        for (int n = 0; n < FFT_SIZE; n++) {
            // Ventana de Blackman (alpha 0.16), igual que el AnalyserNode
            window[n] = (float) (0.42 - 0.5 * Math.cos(2 * Math.PI * n / FFT_SIZE)
                + 0.08 * Math.cos(4 * Math.PI * n / FFT_SIZE));
        }
        for (int n = 0; n < FFT_SIZE / 2; n++) {
            cosT[n] = (float) Math.cos(2 * Math.PI * n / FFT_SIZE);
            sinT[n] = (float) Math.sin(2 * Math.PI * n / FFT_SIZE);
        }
    }

    private static byte[] filled(int n, byte v) {
        byte[] a = new byte[n];
        Arrays.fill(a, v);
        return a;
    }

    // ------------------------------------------------------------------ API para el reproductor

    void setEnabled(boolean on) {
        enabled = on;
    }

    byte[] frequencyBytes() {
        return freqOut;
    }

    byte[] timeBytes() {
        return timeOut;
    }

    /** Milisegundos de audio que ya pasaron por aquí desde el último flush. */
    long processedMs() {
        int rate = sampleRate;
        return rate > 0 ? processedFrames * 1000L / rate : 0;
    }

    // ------------------------------------------------------------------ BaseAudioProcessor

    @Override
    protected AudioFormat onConfigure(AudioFormat input) throws UnhandledAudioFormatException {
        // Solo PCM de 16 bits o float; con cualquier otro formato se desactiva (el audio no se toca)
        if (input.encoding != C.ENCODING_PCM_16BIT && input.encoding != C.ENCODING_PCM_FLOAT) {
            return AudioFormat.NOT_SET;
        }
        encoding = input.encoding;
        channels = Math.max(1, input.channelCount);
        sampleRate = input.sampleRate;
        return input;
    }

    @Override
    protected void onFlush() {
        processedFrames = 0;
        sinceFft = 0;
        ringPos = 0;
        Arrays.fill(ring, 0f);
    }

    @Override
    public void queueInput(ByteBuffer inputBuffer) {
        int size = inputBuffer.remaining();
        if (size == 0) return;

        int bytesPerSample = encoding == C.ENCODING_PCM_FLOAT ? 4 : 2;
        int frameBytes = bytesPerSample * channels;
        processedFrames += size / frameBytes;

        if (enabled) analyze(inputBuffer.duplicate().order(ByteOrder.LITTLE_ENDIAN), bytesPerSample, frameBytes);

        // Pasa el audio sin modificarlo
        ByteBuffer out = replaceOutputBuffer(size);
        out.put(inputBuffer);
        out.flip();
    }

    // ------------------------------------------------------------------ análisis

    private void analyze(ByteBuffer b, int bytesPerSample, int frameBytes) {
        int frames = b.remaining() / frameBytes;
        int pos = b.position();
        int interval = Math.max(FFT_SIZE, sampleRate / FPS);
        boolean isFloat = encoding == C.ENCODING_PCM_FLOAT;

        for (int f = 0; f < frames; f++) {
            float sum = 0f;
            for (int c = 0; c < channels; c++) {
                sum += isFloat ? b.getFloat(pos) : b.getShort(pos) / 32768f;
                pos += bytesPerSample;
            }
            ring[ringPos] = sum / channels;
            ringPos = (ringPos + 1) & (FFT_SIZE - 1);
            if (++sinceFft >= interval) {
                sinceFft = 0;
                computeFrame();
            }
        }
    }

    private void computeFrame() {
        byte[] time = new byte[BINS];
        for (int i = 0; i < FFT_SIZE; i++) {
            float x = ring[(ringPos + i) & (FFT_SIZE - 1)]; // del más viejo al más nuevo
            re[i] = x * window[i];
            im[i] = 0f;
            if (i < BINS) time[i] = (byte) clamp255(Math.round(128f * (1f + x)));
        }
        fft();

        byte[] freq = new byte[BINS];
        for (int k = 0; k < BINS; k++) {
            float mag = (float) Math.sqrt(re[k] * re[k] + im[k] * im[k]) / FFT_SIZE;
            smoothed[k] = SMOOTHING * smoothed[k] + (1f - SMOOTHING) * mag;
            float db = 20f * (float) Math.log10(Math.max(smoothed[k], 1e-9f));
            freq[k] = (byte) clamp255(Math.round(255f * (db - MIN_DB) / (MAX_DB - MIN_DB)));
        }
        timeOut = time;
        freqOut = freq;
    }

    private static int clamp255(int v) {
        return v < 0 ? 0 : (v > 255 ? 255 : v);
    }

    /** FFT radix-2 iterativa, en el sitio, sobre re/im. */
    private void fft() {
        for (int i = 1, j = 0; i < FFT_SIZE; i++) {
            int bit = FFT_SIZE >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                float tr = re[i]; re[i] = re[j]; re[j] = tr;
                float ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
        }
        for (int len = 2; len <= FFT_SIZE; len <<= 1) {
            int half = len >> 1;
            int step = FFT_SIZE / len;
            for (int i = 0; i < FFT_SIZE; i += len) {
                for (int k = 0; k < half; k++) {
                    float wr = cosT[k * step];
                    float wi = -sinT[k * step];
                    int a = i + k;
                    int bIdx = a + half;
                    float xr = re[bIdx] * wr - im[bIdx] * wi;
                    float xi = re[bIdx] * wi + im[bIdx] * wr;
                    re[bIdx] = re[a] - xr;
                    im[bIdx] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
        }
    }
}
