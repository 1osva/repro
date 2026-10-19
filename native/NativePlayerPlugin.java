package __APP_PACKAGE__;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Puente JavaScript <-> reproductor nativo (Media3 / ExoPlayer).
 *
 * Desde JavaScript: Capacitor.Plugins.NativePlayer
 *   .play({ uri, id, fade })      // fade = ms de entrada progresiva
 *   .setNext({ uri, id })         // siguiente canción (sin huecos); uri vacío = quitarla
 *   .pause({ fade }) / .resume({ fade })
 *   .seek({ position })           // segundos
 *   .setVolume({ volume })        // 0..1
 *   .stop()
 *   .setSpectrum({ enabled })     // activa/apaga el espectro para las barras
 *   .addListener('spectrum', ({ freq, time, latency }) => ...)   // base64, 128 bytes cada uno
 *   .addListener('player', ({ event, id, position, duration, playing, message }) => ...)
 *       event: 'time' | 'state' | 'transition' | 'ended' | 'error'
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {

    private NativeAudioPlayer player() {
        return NativeAudioPlayer.get(getContext());
    }

    @Override
    public void load() {
        player().setSink(new NativeAudioPlayer.EventSink() {
            @Override
            public void onEvent(String name, String id, double position, double duration, boolean playing, String message) {
                JSObject data = new JSObject();
                data.put("event", name);
                data.put("id", id);
                data.put("position", position);
                data.put("duration", duration);
                data.put("playing", playing);
                if (message != null) data.put("message", message);
                notifyListeners("player", data);
            }
        });
        player().setSpectrumSink(new NativeAudioPlayer.SpectrumSink() {
            @Override
            public void onSpectrum(byte[] freq, byte[] time, int latencyMs) {
                JSObject data = new JSObject();
                data.put("freq", Base64.encodeToString(freq, Base64.NO_WRAP));
                data.put("time", Base64.encodeToString(time, Base64.NO_WRAP));
                data.put("latency", latencyMs);
                notifyListeners("spectrum", data);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        NativeAudioPlayer.releaseInstance();
    }

    @PluginMethod
    public void play(final PluginCall call) {
        final String uri = call.getString("uri", "");
        final String id = call.getString("id", "");
        final long fade = (long) (double) call.getDouble("fade", 0.0);
        if (uri == null || uri.isEmpty()) {
            call.reject("Falta uri");
            return;
        }
        player().post(new Runnable() {
            @Override
            public void run() {
                player().play(uri, id, fade);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void setNext(final PluginCall call) {
        final String uri = call.getString("uri", "");
        final String id = call.getString("id", "");
        player().post(new Runnable() {
            @Override
            public void run() {
                player().setNext(uri, id);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void pause(final PluginCall call) {
        final long fade = (long) (double) call.getDouble("fade", 0.0);
        player().post(new Runnable() {
            @Override
            public void run() {
                player().pause(fade);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void resume(final PluginCall call) {
        final long fade = (long) (double) call.getDouble("fade", 0.0);
        player().post(new Runnable() {
            @Override
            public void run() {
                player().resume(fade);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void seek(final PluginCall call) {
        final long ms = (long) (call.getDouble("position", 0.0) * 1000.0);
        player().post(new Runnable() {
            @Override
            public void run() {
                player().seek(ms);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void setVolume(final PluginCall call) {
        final float v = (float) (double) call.getDouble("volume", 1.0);
        player().post(new Runnable() {
            @Override
            public void run() {
                player().setVolume(v);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void setSpectrum(final PluginCall call) {
        final boolean on = call.getBoolean("enabled", false);
        player().post(new Runnable() {
            @Override
            public void run() {
                player().setSpectrumEnabled(on);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void stop(final PluginCall call) {
        player().post(new Runnable() {
            @Override
            public void run() {
                player().stop();
                call.resolve();
            }
        });
    }
}
