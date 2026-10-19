package __APP_PACKAGE__;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Lee la biblioteca de música del teléfono (el índice MediaStore de Android).
 *
 * - Android 13 o superior: permiso READ_MEDIA_AUDIO ("Música y audio").
 * - Android 12 o inferior: permiso READ_EXTERNAL_STORAGE.
 *
 * Desde JavaScript: Capacitor.Plugins.MediaLibrary.hasPermission() y .scan()
 */
@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(strings = { "android.permission.READ_MEDIA_AUDIO" }, alias = "audio"),
        @Permission(strings = { "android.permission.READ_EXTERNAL_STORAGE" }, alias = "audioLegacy")
    }
)
public class MediaLibraryPlugin extends Plugin {

    private static final String MODERN_PERMISSION = "android.permission.READ_MEDIA_AUDIO";
    private static final String LEGACY_PERMISSION = "android.permission.READ_EXTERNAL_STORAGE";

    private boolean usesModernPermission() {
        return Build.VERSION.SDK_INT >= 33;
    }

    private String permissionName() {
        return usesModernPermission() ? MODERN_PERMISSION : LEGACY_PERMISSION;
    }

    private String permissionAlias() {
        return usesModernPermission() ? "audio" : "audioLegacy";
    }

    private boolean hasAccess() {
        return getContext().checkSelfPermission(permissionName()) == PackageManager.PERMISSION_GRANTED;
    }

    /** Devuelve { granted: boolean } sin mostrar ningún aviso. */
    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasAccess());
        call.resolve(result);
    }

    /** Abre la pantalla de ajustes de la app (para activar el permiso a mano). */
    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudieron abrir los ajustes: " + e.getMessage(), e);
        }
    }

    /** Escanea la música. Si falta el permiso, lo pide y continúa al ser concedido. */
    @PluginMethod
    public void scan(PluginCall call) {
        if (hasAccess()) {
            startScan(call);
            return;
        }
        requestPermissionForAlias(permissionAlias(), call, "onPermissionResult");
    }

    @PermissionCallback
    private void onPermissionResult(PluginCall call) {
        if (hasAccess()) {
            startScan(call);
        } else {
            call.reject("Permiso de música denegado", "PERMISSION_DENIED");
        }
    }

    private void startScan(final PluginCall call) {
        final Context context = getContext();
        new Thread(() -> {
            try {
                call.resolve(queryAudio(context.getContentResolver()));
            } catch (Exception e) {
                call.reject("No se pudo leer la biblioteca de música: " + e.getMessage(), e);
            }
        }, "nocturne-scan").start();
    }

    private JSObject queryAudio(ContentResolver resolver) {
        // 1) Lo normal: lo que Android marca como música
        JSArray tracks = readTracks(resolver, MediaStore.Audio.Media.IS_MUSIC + " != 0");

        // 2) Respaldo: algunos archivos (p. ej. descargados) no vienen marcados como
        //    música. Si no hubo nada, se toma todo el audio que no sea tono, alarma,
        //    notificación ni un audio corto (notas de voz, efectos).
        if (tracks.length() == 0) {
            tracks = readTracks(resolver,
                MediaStore.Audio.Media.IS_RINGTONE + " = 0 AND "
                + MediaStore.Audio.Media.IS_ALARM + " = 0 AND "
                + MediaStore.Audio.Media.IS_NOTIFICATION + " = 0 AND "
                + MediaStore.Audio.Media.DURATION + " >= 60000");
        }

        JSObject result = new JSObject();
        result.put("tracks", tracks);
        result.put("count", tracks.length());
        return result;
    }

    private JSArray readTracks(ContentResolver resolver, String selection) {
        Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] projection = {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE
        };

        JSArray tracks = new JSArray();
        try (Cursor c = resolver.query(collection, projection, selection, null, null)) {
            if (c != null) {
                int iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                int iTitle = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                int iArtist = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                int iAlbum = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                int iDuration = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                int iMime = c.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE);
                int iName = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
                int iSize = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);

                while (c.moveToNext()) {
                    long id = c.getLong(iId);
                    JSObject track = new JSObject();
                    track.put("id", id);
                    track.put("uri", ContentUris.withAppendedId(collection, id).toString());
                    track.put("title", clean(c.getString(iTitle)));
                    track.put("artist", clean(c.getString(iArtist)));
                    track.put("album", clean(c.getString(iAlbum)));
                    track.put("duration", c.getLong(iDuration) / 1000.0);
                    track.put("mime", clean(c.getString(iMime)));
                    track.put("name", clean(c.getString(iName)));
                    track.put("size", c.getLong(iSize));
                    tracks.put(track);
                }
            }
        }
        return tracks;
    }

    /** MediaStore usa "<unknown>" cuando falta una etiqueta; lo tratamos como vacío. */
    private static String clean(String value) {
        if (value == null) return "";
        String v = value.trim();
        return "<unknown>".equals(v) ? "" : v;
    }
}
