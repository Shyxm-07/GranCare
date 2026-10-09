package com.grancare.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * Rings like an alarm clock: alarm-volume sound that grows louder, vibration, a spoken
 * reminder, and the full-screen {@link AlarmActivity} on top of everything (lock screen
 * included). Runs as a foreground service so it keeps ringing with the app closed.
 * Stops when the dose is answered (TAKEN / LATER) or after {@link #RING_MS}; an unanswered
 * alarm then re-rings 10 minutes later via {@link EscalationEngine}.
 */
public class AlarmService extends Service {
    private static final String TAG = "GranCareAlarm";
    static final String ACTION_START = "com.grancare.app.ALARM_START";
    static final String ACTION_STOP = "com.grancare.app.ALARM_STOP";
    static final String ACTION_TEST = "com.grancare.app.ALARM_TEST";
    static final String TEST_KEY = "test";
    static final String CH_RINGING = "gc_ringing_v1";
    static final int NOTIF_ID = 47110;
    static final long RING_MS = 5 * 60_000L;

    private static final LinkedHashSet<String> active = new LinkedHashSet<>();
    static volatile boolean running = false;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private TextToSpeech tts;
    private float volume = 0.3f;
    private int savedAlarmVolume = -1;

    // ------------------------------------------------------------------ API

    public static void ring(Context c, String key) {
        Intent i = new Intent(c, AlarmService.class).setAction(ACTION_START).putExtra(EscalationEngine.EXTRA_KEY, key);
        try { ContextCompat.startForegroundService(c, i); } catch (Exception e) { Log.w(TAG, "cannot start alarm service", e); }
    }

    public static void test(Context c) {
        Intent i = new Intent(c, AlarmService.class).setAction(ACTION_TEST);
        try { ContextCompat.startForegroundService(c, i); } catch (Exception e) { Log.w(TAG, "cannot start test alarm", e); }
    }

    /** Stops ringing for one dose (or all with "*"). */
    public static void stop(Context c, String key) {
        if (!running) return;
        Intent i = new Intent(c, AlarmService.class).setAction(ACTION_STOP).putExtra(EscalationEngine.EXTRA_KEY, key);
        try { c.startService(i); } catch (Exception e) { Log.w(TAG, "cannot stop alarm service", e); }
    }

    public static synchronized List<String> activeKeys() { return new ArrayList<>(active); }

    // ------------------------------------------------------------------ service

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        String key = intent != null ? intent.getStringExtra(EscalationEngine.EXTRA_KEY) : null;
        if (ACTION_STOP.equals(action)) {
            synchronized (AlarmService.class) { if ("*".equals(key)) active.clear(); else active.remove(key); }
            if (activeKeys().isEmpty()) { finishAll(); return START_NOT_STICKY; }
            postForeground();
            AlarmActivity.refreshIfOpen();
            return START_NOT_STICKY;
        }
        synchronized (AlarmService.class) { active.add(ACTION_TEST.equals(action) ? TEST_KEY : key); }
        running = true;
        postForeground();
        startRinging();
        showScreen();
        AlarmActivity.refreshIfOpen();
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, RING_MS);
        return START_NOT_STICKY;
    }

    private final Runnable timeout = () -> {
        // Unanswered: stop ringing; the engine already scheduled the next ring in 10 minutes.
        synchronized (AlarmService.class) { active.clear(); }
        finishAll();
    };

    private void finishAll() {
        stopRinging();
        handler.removeCallbacks(timeout);
        AlarmActivity.closeIfOpen();
        running = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() { stopRinging(); running = false; super.onDestroy(); }

    // ------------------------------------------------------------------ notification + screen

    private void ensureChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH_RINGING) == null) {
            NotificationChannel c = new NotificationChannel(CH_RINGING, "Alarm ringing", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Shown while a medication alarm is ringing");
            c.setSound(null, null);          // the service plays the alarm sound itself
            c.enableVibration(false);
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            c.setBypassDnd(true);
            nm.createNotificationChannel(c);
        }
    }

    private PendingIntent screenIntent() {
        Intent i = new Intent(this, AlarmActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 4711, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent actionIntent(String action) {
        Intent i = new Intent(this, AlarmReceiver.class).setAction(action).putExtra(EscalationEngine.EXTRA_KEY, "*");
        return PendingIntent.getBroadcast(this, action.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void postForeground() {
        ensureChannel();
        AlarmText t = new AlarmText(this);
        List<JSONObject> doses = AlarmActivity.doses(this);
        String title = doses.isEmpty() ? t.get("Time to take your medicine") : t.get("Time to take") + " " + AlarmActivity.label(doses.get(0));
        if (doses.size() > 1) title += " +" + (doses.size() - 1);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_RINGING)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(title)
            .setContentText(t.get("MEDICATION ALARM DUE NOW"))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setFullScreenIntent(screenIntent(), true)
            .setContentIntent(screenIntent())
            .addAction(0, t.get("TAKEN"), actionIntent(EscalationEngine.ACTION_TAKEN));
        if (AlarmActivity.snoozeAllowed(this)) b.addAction(0, t.get("LATER (10 MIN)"), actionIntent(EscalationEngine.ACTION_SNOOZE));
        Notification n = b.build();
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n, type);
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
            getSystemService(NotificationManager.class).notify(NOTIF_ID, n);
        }
    }

    /** Opens the alarm page directly (works over other apps when "Display over other apps" is allowed;
     *  otherwise Android shows it from the full-screen notification, always on the lock screen). */
    private void showScreen() {
        Intent i = new Intent(this, AlarmActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try { startActivity(i); } catch (Exception e) { Log.i(TAG, "alarm page left to the full-screen notification"); }
    }

    // ------------------------------------------------------------------ sound, vibration, voice

    private void startRinging() {
        if (player != null) return;
        PowerManager pm = getSystemService(PowerManager.class);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GranCare:alarm");
        wakeLock.acquire(RING_MS + 10_000L);

        // Make sure the alarm is audible: at least 70% of the alarm volume while ringing.
        AudioManager am = getSystemService(AudioManager.class);
        try {
            int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM), cur = am.getStreamVolume(AudioManager.STREAM_ALARM);
            int want = Math.round(max * 0.7f);
            if (cur < want) { savedAlarmVolume = cur; am.setStreamVolume(AudioManager.STREAM_ALARM, want, 0); }
        } catch (Exception ignored) { }

        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            player.setDataSource(this, uri);
            player.setLooping(true);
            player.setVolume(volume, volume);
            player.prepare();
            player.start();
            handler.post(rampUp);
        } catch (Exception e) {
            Log.w(TAG, "alarm sound failed", e);
            player = null;
        }

        vibrator = Build.VERSION.SDK_INT >= 31
            ? getSystemService(VibratorManager.class).getDefaultVibrator()
            : (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null) {
            VibrationEffect fx = VibrationEffect.createWaveform(new long[]{0, 900, 600}, 0);
            if (Build.VERSION.SDK_INT >= 33) vibrator.vibrate(fx, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM));
            else vibrator.vibrate(fx, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        }
        handler.postDelayed(this::speak, 2500);
    }

    /** Gentle start, then louder every 4 seconds (like an alarm clock). */
    private final Runnable rampUp = new Runnable() {
        @Override public void run() {
            if (player == null) return;
            volume = Math.min(1f, volume + 0.1f);
            try { player.setVolume(volume, volume); } catch (Exception ignored) { }
            if (volume < 1f) handler.postDelayed(this, 4000);
        }
    };

    private void speak() {
        if (player == null) return;
        AlarmText t = new AlarmText(this);
        List<JSONObject> doses = AlarmActivity.doses(this);
        String what = doses.isEmpty() ? t.get("your medicine") : AlarmActivity.label(doses.get(0));
        String line = t.get("It is time to take") + " " + what + ".";
        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS || tts == null) return;
            tts.setLanguage(t.locale());
            tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            try { if (player != null) player.setVolume(0.15f, 0.15f); } catch (Exception ignored) { }
            tts.speak(line, TextToSpeech.QUEUE_FLUSH, null, "gc-alarm");
            handler.postDelayed(() -> { try { if (player != null) player.setVolume(volume, volume); } catch (Exception ignored) { } }, 4500);
        });
    }

    private void stopRinging() {
        handler.removeCallbacks(rampUp);
        if (player != null) { try { player.stop(); } catch (Exception ignored) { } player.release(); player = null; }
        if (vibrator != null) { vibrator.cancel(); vibrator = null; }
        if (tts != null) { try { tts.stop(); tts.shutdown(); } catch (Exception ignored) { } tts = null; }
        if (savedAlarmVolume >= 0) {
            try { getSystemService(AudioManager.class).setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0); } catch (Exception ignored) { }
            savedAlarmVolume = -1;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        volume = 0.3f;
    }
}
