package __APP_PACKAGE__;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Notificación de música y controles del sistema.
 *
 * Desde JavaScript: Capacitor.Plugins.MediaControls
 *   .update({ title, artist, album, duration, position, playing, cover })
 *   .stop()
 *   .hasNotificationPermission() / .requestNotificationPermission()
 *   .isIgnoringBatteryOptimizations() / .requestIgnoreBatteryOptimizations()
 *       (para que Android no corte la música al salir de la app o apagar la pantalla)
 *   .addListener('mediaAction', ({ action, position }) => ...)
 *       action: 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'stop'
 */
@CapacitorPlugin(
    name = "MediaControls",
    permissions = {
        @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = "notifications")
    }
)
public class MediaControlsPlugin extends Plugin {

    private static final String NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";

    @Override
    public void load() {
        MediaNotificationService.listener = new MediaNotificationService.ActionListener() {
            @Override
            public void onAction(String action, long positionMs) {
                JSObject data = new JSObject();
                data.put("action", action);
                if (positionMs >= 0) data.put("position", positionMs / 1000.0);
                notifyListeners("mediaAction", data);
            }
        };
    }

    @Override
    protected void handleOnDestroy() {
        // La app se cierra: ya no hay WebView que reproduzca, así que se quita la notificación
        MediaNotificationService.listener = null;
        MediaNotificationService.stop(getContext());
    }

    private boolean canNotify() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return getContext().checkSelfPermission(NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /** Actualiza la notificación. `cover` (base64 JPEG): ausente = conservar, "" = quitar. */
    @PluginMethod
    public void update(PluginCall call) {
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        Double duration = call.getDouble("duration", 0.0);
        Double position = call.getDouble("position", 0.0);
        Boolean playing = call.getBoolean("playing", false);
        String coverBase64 = call.getString("cover", null);

        // La portada se decodifica aquí (hilo del plugin), no en el hilo principal
        boolean replaceCover = coverBase64 != null;
        Bitmap bitmap = null;
        if (replaceCover && !coverBase64.isEmpty()) {
            try {
                byte[] bytes = Base64.decode(coverBase64, Base64.DEFAULT);
                bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            } catch (Exception e) {
                bitmap = null;
            }
        }

        MediaNotificationService.applyState(
            title, artist, album,
            (long) (duration * 1000.0), (long) (position * 1000.0),
            playing);
        if (replaceCover) MediaNotificationService.cover = bitmap;
        MediaNotificationService.requestRefresh(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        MediaNotificationService.playing = false;
        MediaNotificationService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void hasNotificationPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", canNotify());
        call.resolve(result);
    }

    /** Android 13+: pide el permiso para mostrar la notificación. En versiones anteriores no hace falta. */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (canNotify()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("notifications", call, "onNotificationPermissionResult");
    }

    @PermissionCallback
    private void onNotificationPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", canNotify());
        call.resolve(result);
    }

    // ------------------------------------------------------------------ segundo plano (ahorro de batería)

    private boolean ignoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < 23) return true; // no existe el ahorro agresivo en versiones anteriores
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    /** Devuelve { ignoring: boolean }: true si la app ya está exenta del ahorro de batería. */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ignoring", ignoringBatteryOptimizations());
        call.resolve(result);
    }

    /**
     * Muestra el aviso del sistema "¿Permitir que la app funcione siempre en segundo plano?".
     * Si el teléfono no lo trae, abre la lista de ajustes de optimización de batería.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();
        if (ignoringBatteryOptimizations()) {
            result.put("ignoring", true);
            call.resolve(result);
            return;
        }
        Context context = getContext();
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
            } catch (Exception e2) {
                call.reject("No se pudieron abrir los ajustes de batería: " + e2.getMessage(), e2);
                return;
            }
        }
        result.put("ignoring", false); // la persona decide en el aviso; se vuelve a consultar después
        call.resolve(result);
    }
}
