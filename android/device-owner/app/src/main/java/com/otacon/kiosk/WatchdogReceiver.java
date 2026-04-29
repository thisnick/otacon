package com.otacon.kiosk;

import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * AlarmManager broadcast handler that runs one watchdog probe and decides whether
 * to reboot. Re-arms the next alarm at the end of every invocation so the loop
 * survives all branches (success, failure, kill-switch, grace, cooldown).
 *
 * Test seams (package-private static fields, set in @Before, cleared in @After):
 *   {@link #sProbeOverride} — swap in a fake HealthProbe
 *   {@link #sDpmOverride}   — swap in a mocked DevicePolicyManager
 */
public class WatchdogReceiver extends BroadcastReceiver {
    private static final String TAG = "Watchdog";

    /** Test seam: when non-null, used instead of {@link HealthProbe.Http}. */
    static HealthProbe sProbeOverride;
    /** Test seam: when non-null, used instead of {@code context.getSystemService(DPM.class)}. */
    static DevicePolicyManager sDpmOverride;
    /**
     * Single shared worker thread. The handler does network I/O (HttpURLConnection),
     * SharedPreferences writes, and DPM calls — none of which are safe on the main
     * BroadcastReceiver thread (NetworkOnMainThreadException + StrictMode warnings).
     */
    private static final Executor EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "watchdog-probe");
        t.setDaemon(true);
        return t;
    });

    /**
     * Test seam: when true, force the async / executor path even with
     * {@link #sProbeOverride} set. The thread-safety regression test uses this
     * to verify we don't drift back to running network I/O on the main thread.
     */
    static boolean sForceAsync = false;

    @Override
    public void onReceive(Context context, Intent intent) {
        // Tests inject a fake probe (and optional fake DPM) — those don't touch
        // the network and tests assert observable side effects immediately after
        // onReceive returns. Run synchronously in that path so we don't race the
        // worker thread; production always takes the goAsync + executor path.
        if (sProbeOverride != null && !sForceAsync) {
            runHandler(context);
            return;
        }
        final PendingResult pending = goAsync();
        EXECUTOR.execute(() -> {
            try {
                runHandler(context);
            } finally {
                pending.finish();
            }
        });
    }

    /** Wraps {@link #handle(Context)} with an unconditional alarm re-arm. */
    private void runHandler(Context context) {
        try {
            handle(context);
        } finally {
            try {
                WatchdogService.scheduleNextProbe(context, WatchdogConfig.PROBE_INTERVAL_MS);
            } catch (Throwable t) {
                Log.w(TAG, "scheduleNextProbe failed: " + t.getMessage());
            }
        }
    }

    private void handle(Context context) {
        SharedPreferences prefs = WatchdogConfig.prefs(context);

        if (!prefs.getBoolean(WatchdogConfig.KEY_ENABLED, true)) {
            Log.i(TAG, "kill switch active — skipping probe");
            return;
        }

        // Boot grace: if we haven't been up long enough, never reboot. Still probe
        // so the counter resets cleanly when the host comes back during grace.
        long bootElapsedRt = prefs.getLong(WatchdogConfig.KEY_BOOT_ELAPSED_RT, 0L);
        long elapsedNow = SystemClock.elapsedRealtime();
        boolean inGrace = elapsedNow - bootElapsedRt < WatchdogConfig.BOOT_GRACE_MS;

        boolean ok = probe();
        if (ok) {
            prefs.edit().putInt(WatchdogConfig.KEY_FAILURES, 0).apply();
            Log.i(TAG, "probe ok — counter reset");
            return;
        }

        int counter = prefs.getInt(WatchdogConfig.KEY_FAILURES, 0) + 1;
        prefs.edit().putInt(WatchdogConfig.KEY_FAILURES, counter).apply();
        Log.w(TAG, "probe failed — counter=" + counter);

        if (counter < WatchdogConfig.FAILURE_THRESHOLD) return;

        if (inGrace) {
            Log.w(TAG, "boot grace active — skipping reboot path despite threshold");
            return;
        }

        long nowMs = System.currentTimeMillis();

        long lastReboot = prefs.getLong(WatchdogConfig.KEY_LAST_REBOOT_TS, 0L);
        if (lastReboot != 0L && nowMs - lastReboot < WatchdogConfig.REBOOT_COOLDOWN_MS) {
            Log.w(TAG, "reboot cooldown active (last=" + lastReboot + ") — skipping");
            return;
        }

        int rebootsLast24h = countRecentRebootsFromHistory(prefs, nowMs - 24L * 60L * 60L * 1000L);
        if (rebootsLast24h >= WatchdogConfig.MAX_REBOOTS_24H) {
            Log.w(TAG, "24h reboot cap reached (" + rebootsLast24h + ") — skipping");
            return;
        }

        String reason = "consecutive_failures=" + counter;
        appendRebootLog(context, nowMs, reason, counter);
        appendRebootHistory(prefs, nowMs);
        prefs.edit().putLong(WatchdogConfig.KEY_LAST_REBOOT_TS, nowMs).apply();

        ComponentName admin = new ComponentName(context, DeviceOwnerReceiver.class);
        Log.w(TAG, "TRIGGERING REBOOT: " + reason);
        DevicePolicyManager dpm = sDpmOverride != null
            ? sDpmOverride
            : context.getSystemService(DevicePolicyManager.class);
        if (dpm == null) {
            Log.e(TAG, "DPM unavailable — cannot reboot");
            return;
        }
        try {
            dpm.reboot(admin);
        } catch (SecurityException e) {
            Log.e(TAG, "dpm.reboot denied: " + e.getMessage());
        } catch (IllegalStateException e) {
            Log.e(TAG, "dpm.reboot illegal state (call/ringing?): " + e.getMessage());
        }
    }

    private boolean probe() {
        HealthProbe p = sProbeOverride != null ? sProbeOverride : new HealthProbe.Http();
        return p.probe();
    }

    /**
     * Reads {@link WatchdogConfig#KEY_REBOOT_HISTORY} (JSON array of long
     * timestamps) and returns the count newer than {@code sinceMs}.
     */
    private static int countRecentRebootsFromHistory(SharedPreferences prefs, long sinceMs) {
        String json = prefs.getString(WatchdogConfig.KEY_REBOOT_HISTORY, null);
        if (json == null || json.isEmpty()) return 0;
        List<Long> ts = parseLongArray(json);
        int count = 0;
        for (long t : ts) if (t >= sinceMs) count++;
        return count;
    }

    /** Append {@code ts} to the reboot history JSON array, dropping entries older than 24h. */
    private static void appendRebootHistory(SharedPreferences prefs, long ts) {
        String existing = prefs.getString(WatchdogConfig.KEY_REBOOT_HISTORY, "[]");
        List<Long> values = parseLongArray(existing);
        long cutoff = ts - 24L * 60L * 60L * 1000L;
        List<Long> kept = new ArrayList<>();
        for (long v : values) if (v >= cutoff) kept.add(v);
        kept.add(ts);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < kept.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(kept.get(i));
        }
        sb.append(']');
        prefs.edit().putString(WatchdogConfig.KEY_REBOOT_HISTORY, sb.toString()).apply();
    }

    /** Parse a flat JSON array of longs like "[123,456]". Tolerant of whitespace. */
    private static List<Long> parseLongArray(String json) {
        List<Long> out = new ArrayList<>();
        if (json == null) return out;
        String s = json.trim();
        if (s.startsWith("[")) s = s.substring(1);
        if (s.endsWith("]")) s = s.substring(0, s.length() - 1);
        if (s.isEmpty()) return out;
        for (String tok : s.split(",")) {
            try { out.add(Long.parseLong(tok.trim())); } catch (NumberFormatException ignored) {}
        }
        return out;
    }

    private static void appendRebootLog(Context context, long ts, String reason, int counter) {
        File f = new File(context.getFilesDir(), WatchdogConfig.REBOOT_LOG_FILENAME);
        String line = "{\"ts\":" + ts + ",\"reason\":\"" + reason
            + "\",\"consecutive_failures\":" + counter + "}\n";
        try (FileWriter w = new FileWriter(f, true)) {
            w.write(line);
        } catch (IOException e) {
            Log.e(TAG, "reboot log write failed: " + e.getMessage());
        }
    }
}
