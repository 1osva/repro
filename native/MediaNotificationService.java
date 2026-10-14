package __APP_PACKAGE__;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

/**
 * Servicio en primer plano que mantiene viva la reproducción con la app en segundo plano
 * y muestra la notificación de música (portada, título, botones y barra de progreso).
 *
 * La notificación se apoya en una MediaSession: gracias a ella Android dibuja los controles
 * multimedia del sistema (pantalla de bloqueo y panel), toma los colores de la portada
 * y atiende los botones de audífonos Bluetooth.
 *
 * El audio en sí lo reproduce el WebView; este servicio solo refleja su estado y devuelve las
 * órdenes (play, pausa, siguiente, anterior, buscar) a la app mediante {@link ActionListener}.
 */
public class MediaNotificationService extends Service {

    public interface ActionListener {
        void onAction(String action, long positionMs);
    }

    public static final String ACTION_UPDATE = "nocturne.action.UPDATE";
    public static final String ACTION_PLAY = "nocturne.action.PLAY";
    public static final String ACTION_PAUSE = "nocturne.action.PAUSE";
    public static final String ACTION_NEXT = "nocturne.action.NEXT";
    public static final String ACTION_PREVIOUS = "nocturne.action.PREVIOUS";
    public static final String ACTION_STOP = "nocturne.action.STOP";

    private static final String CHANNEL_ID = "nocturne_playback";
    private static final int NOTIFICATION_ID = 4242;
    private static final long WAKE_LOCK_MAX_MS = 6L * 60L * 60L * 1000L;

    // Estado compartido: lo escribe el plugin, lo lee el servicio
    static volatile ActionListener listener;
    static volatile MediaNotificationService instance;
    static volatile String title = "";
    static volatile String artist = "";
    static volatile String album = "";
    static volatile long durationMs = 0;
    static volatile long positionMs = 0;
    static volatile boolean playing = false;
    static volatile Bitmap cover = null;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private boolean inForeground = false;
    private Bitmap accentSource = null;
    private int accentColor = 0xFF4B3BD6;

    // ------------------------------------------------------------------ API para el plugin

    static void applyState(String t, String a, String al, long dur, long pos, boolean play) {
        title = t == null ? "" : t;
        artist = a == null ? "" : a;
        album = al == null ? "" : al;
        durationMs = Math.max(0, dur);
        positionMs = Math.max(0, pos);
        playing = play;
    }

    /** Pide que se redibuje la notificación; si el servicio no existe y se está reproduciendo, lo inicia. */
    static void requestRefresh(Context context) {
        final MediaNotificationService inst = instance;
        if (inst != null) {
            inst.main.post(new Runnable() {
                @Override
                public void run() {
                    inst.refresh();
                }
            });
            return;
        }
        if (!playing) return;
        Intent intent = new Intent(context, MediaNotificationService.class).setAction(ACTION_UPDATE);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException e) {
            // Android no permite iniciarlo ahora (app en segundo plano): se reintentará con la siguiente acción
        }
    }

    static void stop(Context context) {
        final MediaNotificationService inst = instance;
        if (inst != null) {
            inst.main.post(new Runnable() {
                @Override
                public void run() {
                    inst.shutdown();
                }
            });
        } else {
            try {
                context.stopService(new Intent(context, MediaNotificationService.class));
            } catch (RuntimeException e) {
                // nada que detener
            }
        }
    }

    // ------------------------------------------------------------------ ciclo de vida

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();

        session = new MediaSession(this, "NocturneSession");
        applySessionFlags();
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                dispatch("play", -1);
            }

            @Override
            public void onPause() {
                dispatch("pause", -1);
            }

            @Override
            public void onSkipToNext() {
                dispatch("next", -1);
            }

            @Override
            public void onSkipToPrevious() {
                dispatch("previous", -1);
            }

            @Override
            public void onSeekTo(long pos) {
                dispatch("seek", pos);
            }

            @Override
            public void onStop() {
                dispatch("stop", -1);
                shutdown();
            }
        });
        session.setSessionActivity(openAppIntent());
        session.setActive(true);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Nocturne:playback");
            wakeLock.setReferenceCounted(false);
        }
    }

    @SuppressWarnings("deprecation")
    private void applySessionFlags() {
        // En Android 8 y anteriores hay que pedir explícitamente los botones multimedia
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            // Estando iniciado con startForegroundService hay que llamar a startForeground antes de salir
            ensureForeground();
            dispatch("stop", -1);
            shutdown();
            return START_NOT_STICKY;
        }

        ensureForeground();
        refresh();

        if (ACTION_PLAY.equals(action)) {
            dispatch("play", -1);
        } else if (ACTION_PAUSE.equals(action)) {
            dispatch("pause", -1);
        } else if (ACTION_NEXT.equals(action)) {
            dispatch("next", -1);
        } else if (ACTION_PREVIOUS.equals(action)) {
            dispatch("previous", -1);
        }

        // Si la app no responde (por ejemplo el WebView ya no existe), no quedarse "reproduciendo"
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!playing && inForeground) {
                    stopForeground(Service.STOP_FOREGROUND_DETACH);
                    inForeground = false;
                    releaseWakeLock();
                }
            }
        }, 4000);

        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // El usuario cerró la app desde recientes: el WebView desaparece, así que no hay nada que controlar
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        main.removeCallbacksAndMessages(null);
        releaseWakeLock();
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ notificación

    /** Redibuja metadatos, estado de reproducción y notificación con el estado compartido actual. */
    void refresh() {
        if (session == null) return;

        Bitmap art = cover;
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (art != null) {
            meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
            meta.putBitmap(MediaMetadata.METADATA_KEY_ART, art);
        }
        session.setMetadata(meta.build());

        long actions = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_STOP;
        // Con posición + velocidad + hora, el sistema avanza solo la barra de progreso
        PlaybackState state = new PlaybackState.Builder()
            .setActions(actions)
            .setState(
                playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                positionMs,
                playing ? 1.0f : 0.0f,
                SystemClock.elapsedRealtime())
            .build();
        session.setPlaybackState(state);

        Notification notification = buildNotification(art);
        if (playing) {
            acquireWakeLock();
            promoteToForeground(notification);
        } else {
            releaseWakeLock();
            if (inForeground) {
                // Pausado: la notificación se queda, pero ya se puede deslizar para quitarla
                stopForeground(Service.STOP_FOREGROUND_DETACH);
                inForeground = false;
            }
            notifyOnly(notification);
        }
    }

    private void ensureForeground() {
        if (inForeground) return;
        promoteToForeground(buildNotification(cover));
    }

    private void promoteToForeground(Notification notification) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            inForeground = true;
        } catch (RuntimeException e) {
            // Android no deja pasar a primer plano desde aquí: se muestra solo la notificación
            notifyOnly(notification);
        }
    }

    private void notifyOnly(Notification notification) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, notification);
    }

    @SuppressWarnings("deprecation") // Builder(Context) solo se usa en Android 7 (sin canales de notificación)
    private Notification buildNotification(Bitmap art) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        b.setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(title.isEmpty() ? "Nocturne" : title)
            .setContentText(artist)
            .setSubText(album.isEmpty() ? null : album)
            .setContentIntent(openAppIntent())
            .setDeleteIntent(servicePendingIntent(ACTION_STOP, 5))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing);

        if (art != null) b.setLargeIcon(art);

        b.addAction(action(R.drawable.ic_notif_prev, "Anterior", ACTION_PREVIOUS, 1));
        if (playing) {
            b.addAction(action(R.drawable.ic_notif_pause, "Pausa", ACTION_PAUSE, 2));
        } else {
            b.addAction(action(R.drawable.ic_notif_play, "Reproducir", ACTION_PLAY, 3));
        }
        b.addAction(action(R.drawable.ic_notif_next, "Siguiente", ACTION_NEXT, 4));

        b.setStyle(new Notification.MediaStyle()
            .setMediaSession(session.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2));

        // El color de la barra y del fondo sale de la portada
        if (Build.VERSION.SDK_INT >= 26) b.setColorized(true);
        b.setColor(accentFor(art));

        return b.build();
    }

    private Notification.Action action(int iconRes, String label, String act, int requestCode) {
        return new Notification.Action.Builder(
            Icon.createWithResource(this, iconRes), label, servicePendingIntent(act, requestCode)).build();
    }

    private PendingIntent servicePendingIntent(String act, int requestCode) {
        Intent intent = new Intent(this, MediaNotificationService.class).setAction(act);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 26) {
            return PendingIntent.getForegroundService(this, requestCode, intent, flags);
        }
        return PendingIntent.getService(this, requestCode, intent, flags);
    }

    private PendingIntent openAppIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent();
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Reproducción de música", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Controles de la canción que está sonando");
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(channel);
    }

    // ------------------------------------------------------------------ color de acento de la portada

    private int accentFor(Bitmap art) {
        if (art == null) return 0xFF4B3BD6;
        if (art != accentSource) {
            accentSource = art;
            accentColor = pickAccent(art);
        }
        return accentColor;
    }

    /** Color dominante y vistoso de la portada, ajustado para que el texto blanco se lea bien. */
    static int pickAccent(Bitmap bmp) {
        Bitmap small = Bitmap.createScaledBitmap(bmp, 24, 24, true);
        float[] hsv = new float[3];
        double[] sumR = new double[12];
        double[] sumG = new double[12];
        double[] sumB = new double[12];
        double[] weight = new double[12];
        double allR = 0, allG = 0, allB = 0;
        int n = 0;

        for (int y = 0; y < small.getHeight(); y++) {
            for (int x = 0; x < small.getWidth(); x++) {
                int px = small.getPixel(x, y);
                allR += Color.red(px);
                allG += Color.green(px);
                allB += Color.blue(px);
                n++;
                Color.colorToHSV(px, hsv);
                if (hsv[2] < 0.15f) continue; // casi negro
                double w = hsv[1] * hsv[2];
                int bucket = ((int) (hsv[0] / 30f)) % 12;
                sumR[bucket] += Color.red(px) * w;
                sumG[bucket] += Color.green(px) * w;
                sumB[bucket] += Color.blue(px) * w;
                weight[bucket] += w;
            }
        }
        if (small != bmp) small.recycle();

        int best = 0;
        for (int i = 1; i < 12; i++) {
            if (weight[i] > weight[best]) best = i;
        }

        int r;
        int g;
        int b;
        if (weight[best] < 0.5) {
            // Portada casi gris: se usa el promedio general
            r = (int) (allR / Math.max(1, n));
            g = (int) (allG / Math.max(1, n));
            b = (int) (allB / Math.max(1, n));
        } else {
            r = (int) (sumR[best] / weight[best]);
            g = (int) (sumG[best] / weight[best]);
            b = (int) (sumB[best] / weight[best]);
        }

        Color.colorToHSV(Color.rgb(r, g, b), hsv);
        hsv[1] = Math.max(hsv[1], 0.35f);
        hsv[2] = Math.min(Math.max(hsv[2], 0.30f), 0.72f);
        return Color.HSVToColor(hsv);
    }

    // ------------------------------------------------------------------ utilidades

    private void dispatch(String action, long positionMs) {
        ActionListener l = listener;
        if (l != null) l.onAction(action, positionMs);
    }

    private void acquireWakeLock() {
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(WAKE_LOCK_MAX_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    void shutdown() {
        releaseWakeLock();
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        inForeground = false;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
        stopSelf();
    }
}
