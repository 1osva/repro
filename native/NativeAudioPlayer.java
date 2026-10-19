package __APP_PACKAGE__;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;

/**
 * Reproductor nativo (Media3 / ExoPlayer). Reproduce directamente los content:// de la
 * biblioteca del teléfono, sin cargar el archivo en el WebView ni pasarlo por Web Audio.
 * El audio sale por AudioTrack a su frecuencia original y Android negocia el códec
 * Bluetooth (SBC, AAC, LDAC, LHDC...) con los audífonos.
 *
 * Todo se ejecuta en el hilo principal (ExoPlayer lo exige). La cola es de a lo más dos
 * elementos: la canción actual y la siguiente (reproducción sin huecos).
 */
@UnstableApi
final class NativeAudioPlayer {

    interface EventSink {
        void onEvent(String name, String id, double position, double duration, boolean playing, String message);
    }

    /** Cuadros del espectro (para las barras del visualizador). */
    interface SpectrumSink {
        void onSpectrum(byte[] freq, byte[] time, int latencyMs);
    }

    private static final long TIME_TICK_MS = 250;
    private static final long SPECTRUM_TICK_MS = 33; // ~30 cuadros por segundo
    private static final long FADE_STEP_MS = 30;

    private static NativeAudioPlayer instance;

    static synchronized NativeAudioPlayer get(Context context) {
        if (instance == null) instance = new NativeAudioPlayer(context.getApplicationContext());
        return instance;
    }

    static synchronized void releaseInstance() {
        if (instance != null) {
            instance.release();
            instance = null;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private volatile EventSink sink;
    private volatile SpectrumSink spectrumSink;

    private final SpectrumProcessor spectrum = new SpectrumProcessor();
    private boolean spectrumOn = false;
    // Cuánto "se adelanta" el audio analizado respecto a lo que se oye (búfer + salida/Bluetooth)
    private volatile int latencyMs = 150;
    private boolean measureLatency = false;

    private float userVolume = 0.8f;
    private float fade = 1f;
    private Runnable fadeRunnable;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) {
                measureLatencyIfNeeded();
                emit("time");
                main.postDelayed(this, TIME_TICK_MS);
            }
        }
    };

    private final Runnable spectrumTicker = new Runnable() {
        @Override
        public void run() {
            if (player == null || !spectrumOn || !player.isPlaying()) return;
            SpectrumSink s = spectrumSink;
            if (s != null) s.onSpectrum(spectrum.frequencyBytes(), spectrum.timeBytes(), latencyMs);
            main.postDelayed(this, SPECTRUM_TICK_MS);
        }
    };

    private NativeAudioPlayer(Context appContext) {
        // El procesador de espectro va dentro de la salida de audio: deja pasar el sonido intacto
        final SpectrumProcessor tap = spectrum;
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(appContext) {
            @Override
            protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput, boolean enableAudioTrackPlaybackParams) {
                return new DefaultAudioSink.Builder(context)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .setAudioProcessors(new AudioProcessor[] { tap })
                    .build();
            }
        };
        player = new ExoPlayer.Builder(appContext, renderers)
            .setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true) // gestiona el foco de audio (llamadas, otras apps)
            .setHandleAudioBecomingNoisy(true) // pausa al desconectar audífonos
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build();
        player.setRepeatMode(Player.REPEAT_MODE_OFF);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                emit("state");
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                main.removeCallbacks(ticker);
                main.removeCallbacks(spectrumTicker);
                if (isPlaying) {
                    main.post(ticker);
                    if (spectrumOn) main.post(spectrumTicker);
                } else {
                    emit("time");
                }
            }

            @Override
            public void onMediaItemTransition(MediaItem item, int reason) {
                if (item != null && reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                    emit("transition");
                }
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) emit("ended");
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                emitMessage("error", String.valueOf(error.getErrorCodeName()));
            }
        });
    }

    void setSink(EventSink s) {
        sink = s;
    }

    void setSpectrumSink(SpectrumSink s) {
        spectrumSink = s;
    }

    /** Activa o apaga el cálculo del espectro (solo mientras el visualizador está a la vista). */
    void setSpectrumEnabled(boolean on) {
        spectrumOn = on;
        spectrum.setEnabled(on);
        main.removeCallbacks(spectrumTicker);
        if (on && player != null && player.isPlaying()) main.post(spectrumTicker);
    }

    /**
     * El procesador va por delante de lo que se escucha. Poco después de empezar una canción
     * (cuando aún no hubo saltos) se compara el audio procesado con la posición audible: la
     * diferencia es el retraso que el visualizador debe compensar.
     */
    private void measureLatencyIfNeeded() {
        if (!measureLatency || player == null) return;
        long pos = player.getCurrentPosition();
        if (pos < 700 || pos > 5000) return;
        long ahead = spectrum.processedMs() - pos;
        if (ahead >= 0 && ahead <= 3000) {
            latencyMs = (int) ahead;
            measureLatency = false;
        }
    }

    void post(Runnable r) {
        main.post(r);
    }

    // ------------------------------------------------------------------ eventos

    private String currentId() {
        MediaItem item = player != null ? player.getCurrentMediaItem() : null;
        return item != null && item.mediaId != null ? item.mediaId : "";
    }

    private void emit(String name) {
        emitMessage(name, null);
    }

    private void emitMessage(String name, String message) {
        EventSink s = sink;
        if (s == null || player == null) return;
        long dur = player.getDuration();
        s.onEvent(
            name,
            currentId(),
            Math.max(0, player.getCurrentPosition()) / 1000.0,
            dur == C.TIME_UNSET ? 0 : dur / 1000.0,
            player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED,
            message);
    }

    // ------------------------------------------------------------------ control (hilo principal)

    private static MediaItem item(String uri, String id) {
        return new MediaItem.Builder().setUri(Uri.parse(uri)).setMediaId(id).build();
    }

    void play(String uri, String id, long fadeInMs) {
        if (player == null) return;
        player.setMediaItem(item(uri, id));
        player.prepare();
        measureLatency = true;
        applyFade(fadeInMs, true);
        player.setPlayWhenReady(true);
    }

    /** Deja lista la siguiente canción para pasar a ella sin huecos. null/"" = quitarla. */
    void setNext(String uri, String id) {
        if (player == null) return;
        int count = player.getMediaItemCount();
        int cur = player.getCurrentMediaItemIndex();
        if (count == 0 || player.getPlaybackState() == Player.STATE_ENDED) return;
        if (count > cur + 1) player.removeMediaItems(cur + 1, count);
        if (uri != null && !uri.isEmpty()) player.addMediaItem(item(uri, id));
    }

    void pause(long fadeOutMs) {
        if (player == null) return;
        if (fadeOutMs <= 0 || !player.getPlayWhenReady()) {
            player.setPlayWhenReady(false);
            return;
        }
        applyFade(fadeOutMs, false);
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (player != null && fade <= 0.001f) player.setPlayWhenReady(false);
            }
        }, fadeOutMs + FADE_STEP_MS);
    }

    void resume(long fadeInMs) {
        if (player == null) return;
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        applyFade(fadeInMs, true);
        player.setPlayWhenReady(true);
    }

    void seek(long ms) {
        measureLatency = false; // tras un salto la cuenta ya no parte de cero
        if (player != null) player.seekTo(Math.max(0, ms));
    }

    void setVolume(float v) {
        userVolume = Math.max(0f, Math.min(1f, v));
        applyVolume();
    }

    void stop() {
        if (player == null) return;
        cancelFade();
        player.stop();
        player.clearMediaItems();
    }

    void release() {
        main.removeCallbacksAndMessages(null);
        sink = null;
        spectrumSink = null;
        if (player != null) {
            player.release();
            player = null;
        }
    }

    // ------------------------------------------------------------------ volumen y fundidos

    private void applyVolume() {
        if (player != null) player.setVolume(userVolume * fade);
    }

    private void cancelFade() {
        if (fadeRunnable != null) main.removeCallbacks(fadeRunnable);
        fadeRunnable = null;
    }

    /** Rampa lineal del factor de fundido hacia 1 (entrar) o 0 (salir) en `ms`. */
    private void applyFade(final long ms, final boolean fadeIn) {
        cancelFade();
        final float target = fadeIn ? 1f : 0f;
        if (ms <= 0) {
            fade = target;
            applyVolume();
            return;
        }
        if (fadeIn && fade >= 1f) fade = 0.0001f; // empezar desde silencio
        final float start = fade;
        final long t0 = android.os.SystemClock.uptimeMillis();
        fadeRunnable = new Runnable() {
            @Override
            public void run() {
                float p = Math.min(1f, (android.os.SystemClock.uptimeMillis() - t0) / (float) ms);
                fade = start + (target - start) * p;
                applyVolume();
                if (p < 1f) main.postDelayed(this, FADE_STEP_MS);
                else fadeRunnable = null;
            }
        };
        main.post(fadeRunnable);
    }
}
