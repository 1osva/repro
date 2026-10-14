package __APP_PACKAGE__;

import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
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
}
