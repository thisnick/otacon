package com.otacon.kiosk;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

/**
 * Foreground service that keeps the kiosk process out of cached/killed state and
 * schedules the watchdog probe alarm. The actual probe runs in
 * {@link WatchdogReceiver} so it fires reliably during Doze.
 */
public class WatchdogService extends Service {
    private static final String TAG = "Watchdog";

    static final String ACTION_PROBE = "com.otacon.kiosk.WATCHDOG_PROBE";

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
        startForeground(WatchdogConfig.NOTIF_ID, buildNotification());

        // Record fresh boot time for the grace-period check.
        WatchdogConfig.prefs(this).edit()
            .putLong(WatchdogConfig.KEY_BOOT_ELAPSED_RT, SystemClock.elapsedRealtime())
            .putInt(WatchdogConfig.KEY_FAILURES, 0)
            .apply();

        scheduleNextProbe(this, WatchdogConfig.PROBE_INTERVAL_MS);
        Log.i(TAG, "WatchdogService started, first probe in " + WatchdogConfig.PROBE_INTERVAL_MS + "ms");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /** Schedule the next AlarmManager wakeup. Idempotent — replaces any pending alarm. */
    static void scheduleNextProbe(Context context, long delayMs) {
        AlarmManager am = context.getSystemService(AlarmManager.class);
        if (am == null) return;
        Intent intent = new Intent(context, WatchdogReceiver.class).setAction(ACTION_PROBE);
        PendingIntent pi = PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long triggerAt = System.currentTimeMillis() + delayMs;
        try {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
        } catch (SecurityException e) {
            Log.w(TAG, "setExactAndAllowWhileIdle denied, falling back to setAndAllowWhileIdle: " + e);
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
        }
    }

    private void ensureChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
            WatchdogConfig.NOTIF_CHANNEL_ID,
            WatchdogConfig.NOTIF_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        return new Notification.Builder(this, WatchdogConfig.NOTIF_CHANNEL_ID)
            .setContentTitle("Otacon kiosk watchdog")
            .setContentText("Monitoring host connectivity")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build();
    }
}
