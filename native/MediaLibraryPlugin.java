package __APP_PACKAGE__;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.app.PendingIntent;
import android.app.RecoverableSecurityException;
import android.content.ContentResolver;
import android.content.IntentSender;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;

import com.getcapacitor.JSArray;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lee la biblioteca de música del teléfono (el índice MediaStore de Android).
 *
 * - Android 13 o superior: permiso READ_MEDIA_AUDIO ("Música y audio").
 * - Android 12 o inferior: permiso READ_EXTERNAL_STORAGE.
 *
 * - Portadas: permiso READ_MEDIA_IMAGES ("Fotos y videos") en Android 13 o superior; en versiones
 *   anteriores ya lo cubre READ_EXTERNAL_STORAGE.
 *
 * Desde JavaScript: Capacitor.Plugins.MediaLibrary.hasPermission(), .scan(),
 *   .hasImagesPermission(), .requestImagesPermission(), .getThumbnail({ uri, size })
 *   y .deleteTracks({ uris }) (borra del teléfono, con la confirmación del propio Android)
 */
@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(strings = { "android.permission.READ_MEDIA_AUDIO" }, alias = "audio"),
        @Permission(strings = { "android.permission.READ_EXTERNAL_STORAGE" }, alias = "audioLegacy"),
        @Permission(strings = { "android.permission.READ_MEDIA_IMAGES" }, alias = "images")
    }
)
public class MediaLibraryPlugin extends Plugin {

    private static final String MODERN_PERMISSION = "android.permission.READ_MEDIA_AUDIO";
    private static final String LEGACY_PERMISSION = "android.permission.READ_EXTERNAL_STORAGE";
    private static final String IMAGES_PERMISSION = "android.permission.READ_MEDIA_IMAGES";

    // Las portadas se leen en segundo plano, de dos en dos, para no estorbar al audio ni a la interfaz
    private final ExecutorService thumbPool = Executors.newFixedThreadPool(2);

    // Eliminación de canciones (el sistema muestra su propio aviso de confirmación)
    private ActivityResultLauncher<IntentSenderRequest> deleteLauncher;
    private PluginCall pendingDeleteCall;
    private final List<Uri> pendingUris = new ArrayList<>();
    private final List<String> deletedUris = new ArrayList<>();
    private boolean deleteViaRequest = false; // true en Android 11 o superior (un solo aviso para todas)

    @Override
    public void load() {
        deleteLauncher = getBridge().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> onDeleteResult(result.getResultCode())
        );
    }

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


    // ------------------------------------------------------------------ portadas

    private boolean hasImagesAccess() {
        if (Build.VERSION.SDK_INT < 33) return hasAccess(); // READ_EXTERNAL_STORAGE ya incluye las imágenes
        return getContext().checkSelfPermission(IMAGES_PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Devuelve { granted: boolean } sin mostrar ningún aviso. */
    @PluginMethod
    public void hasImagesPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasImagesAccess());
        call.resolve(result);
    }

    /** Pide el permiso de fotos (Android 13+). En versiones anteriores no hace falta nada más. */
    @PluginMethod
    public void requestImagesPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || hasImagesAccess()) {
            JSObject result = new JSObject();
            result.put("granted", hasImagesAccess());
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("images", call, "onImagesPermissionResult");
    }

    @PermissionCallback
    private void onImagesPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasImagesAccess());
        call.resolve(result);
    }

    /**
     * Devuelve la portada de una canción como miniatura JPEG en base64: { cover: "..." }.
     * Si la canción no tiene portada devuelve cover = "".
     */
    @PluginMethod
    public void getThumbnail(final PluginCall call) {
        final String uriText = call.getString("uri");
        Integer requested = call.getInt("size", 160);
        final int size = Math.max(64, Math.min(512, requested == null ? 160 : requested));
        if (uriText == null || uriText.isEmpty()) {
            call.reject("Falta la uri de la canción");
            return;
        }
        if (!hasAccess()) {
            call.reject("Permiso de música denegado", "PERMISSION_DENIED");
            return;
        }
        thumbPool.execute(new Runnable() {
            @Override
            public void run() {
                String cover = "";
                try {
                    cover = loadCover(Uri.parse(uriText), size);
                } catch (Throwable t) {
                    cover = "";
                }
                JSObject result = new JSObject();
                result.put("cover", cover);
                call.resolve(result);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        thumbPool.shutdownNow();
        super.handleOnDestroy();
    }

    private String loadCover(Uri uri, int size) {
        Context context = getContext();
        Bitmap bitmap = null;

        // 1) La miniatura que genera Android (portada incrustada o la imagen de la carpeta)
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                bitmap = context.getContentResolver().loadThumbnail(uri, new Size(size, size), null);
            } catch (Exception e) {
                bitmap = null; // sin portada para esta canción
            }
        }

        // 2) Respaldo: la imagen incrustada en las etiquetas del archivo
        if (bitmap == null) {
            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            try {
                retriever.setDataSource(context, uri);
                byte[] art = retriever.getEmbeddedPicture();
                if (art != null && art.length > 0) bitmap = decodeScaled(art, size);
            } catch (Exception e) {
                bitmap = null;
            } finally {
                try {
                    retriever.release();
                } catch (Exception e) {
                    // ya liberado
                }
            }
        }

        if (bitmap == null) return "";
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    /** Decodifica una imagen directamente a un tamaño pequeño (sin cargarla completa en memoria). */
    private static Bitmap decodeScaled(byte[] data, int size) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

        int sample = 1;
        while (bounds.outWidth / (sample * 2) >= size && bounds.outHeight / (sample * 2) >= size) sample *= 2;

        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        return BitmapFactory.decodeByteArray(data, 0, data.length, opts);
    }


    // ------------------------------------------------------------------ eliminar canciones

    /**
     * Borra canciones del teléfono. Android pide confirmación a la persona con su propio aviso.
     * Devuelve { deleted: [uri, ...], cancelled: boolean }.
     */
    @PluginMethod
    public void deleteTracks(PluginCall call) {
        if (pendingDeleteCall != null) {
            call.reject("Ya hay una eliminación en curso");
            return;
        }
        if (!hasAccess()) {
            call.reject("Permiso de música denegado", "PERMISSION_DENIED");
            return;
        }
        if (Build.VERSION.SDK_INT < 29) {
            call.reject("Eliminar desde la app requiere Android 10 o superior", "UNSUPPORTED");
            return;
        }
        JSArray array = call.getArray("uris");
        if (array == null || array.length() == 0) {
            call.reject("Faltan las canciones a eliminar");
            return;
        }

        pendingUris.clear();
        deletedUris.clear();
        try {
            for (int i = 0; i < array.length(); i++) {
                String text = array.getString(i);
                // Solo se aceptan canciones del índice de medios de Android
                if (text != null && text.startsWith("content://media/")) pendingUris.add(Uri.parse(text));
            }
        } catch (JSONException e) {
            call.reject("Lista de canciones no válida");
            return;
        }
        if (pendingUris.isEmpty()) {
            call.reject("Ninguna canción válida para eliminar");
            return;
        }

        pendingDeleteCall = call;
        if (Build.VERSION.SDK_INT >= 30) {
            deleteViaRequest = true;
            try {
                PendingIntent request = MediaStore.createDeleteRequest(getContext().getContentResolver(), pendingUris);
                deleteLauncher.launch(new IntentSenderRequest.Builder(request.getIntentSender()).build());
            } catch (Exception e) {
                finishDelete(false, "No se pudo pedir la confirmación: " + e.getMessage());
            }
        } else {
            deleteViaRequest = false;
            deleteOneByOne();
        }
    }

    /** Android 10: se borra de una en una; si el sistema pide permiso para una canción, se muestra su aviso. */
    private void deleteOneByOne() {
        ContentResolver resolver = getContext().getContentResolver();
        while (!pendingUris.isEmpty()) {
            Uri uri = pendingUris.get(0);
            try {
                if (resolver.delete(uri, null, null) > 0) deletedUris.add(uri.toString());
                pendingUris.remove(0);
            } catch (SecurityException e) {
                IntentSender sender = Api29.userActionSender(e);
                if (sender == null) {
                    pendingUris.remove(0); // sin permiso para esta canción: se omite
                    continue;
                }
                try {
                    deleteLauncher.launch(new IntentSenderRequest.Builder(sender).build());
                } catch (Exception launchError) {
                    finishDelete(false, "No se pudo pedir la confirmación: " + launchError.getMessage());
                }
                return; // se continúa en onDeleteResult cuando la persona responde
            }
        }
        finishDelete(false, null);
    }

    private void onDeleteResult(int resultCode) {
        if (pendingDeleteCall == null) return;
        boolean accepted = resultCode == android.app.Activity.RESULT_OK;
        if (deleteViaRequest) {
            if (accepted) {
                for (Uri uri : pendingUris) deletedUris.add(uri.toString());
            }
            pendingUris.clear();
            finishDelete(!accepted, null);
        } else if (accepted) {
            deleteOneByOne(); // ya hay permiso para esa canción: se reintenta
        } else {
            pendingUris.clear();
            finishDelete(true, null);
        }
    }

    private void finishDelete(boolean cancelled, String error) {
        PluginCall call = pendingDeleteCall;
        pendingDeleteCall = null;
        pendingUris.clear();
        if (call == null) return;
        if (error != null) {
            call.reject(error);
            return;
        }
        JSArray deleted = new JSArray();
        for (String uri : deletedUris) deleted.put(uri);
        JSObject result = new JSObject();
        result.put("deleted", deleted);
        result.put("cancelled", cancelled && deletedUris.isEmpty());
        call.resolve(result);
    }

    /** Código exclusivo de Android 10 en una clase aparte para que Android 9 o menor no tenga problemas al cargarlo. */
    private static final class Api29 {
        static IntentSender userActionSender(SecurityException e) {
            if (e instanceof RecoverableSecurityException) {
                return ((RecoverableSecurityException) e).getUserAction().getActionIntent().getIntentSender();
            }
            return null;
        }
    }

    /** MediaStore usa "<unknown>" cuando falta una etiqueta; lo tratamos como vacío. */
    private static String clean(String value) {
        if (value == null) return "";
        String v = value.trim();
        return "<unknown>".equals(v) ? "" : v;
    }
}
