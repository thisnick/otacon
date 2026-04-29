package com.otacon.kiosk;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Defaults and SharedPreferences-backed state for the kiosk watchdog.
 *
 * The watchdog probes the host every {@link #PROBE_INTERVAL_MS} via AlarmManager.
 * After {@link #FAILURE_THRESHOLD} consecutive failures, the kiosk reboots via DPM,
 * subject to {@link #BOOT_GRACE_MS}, {@link #REBOOT_COOLDOWN_MS}, and
 * {@link #MAX_REBOOTS_24H}.
 */
public final class WatchdogConfig {

    public static final String PROBE_URL = "http://127.0.0.1:8081/api/v1/watchdog-probe";

    public static final long PROBE_INTERVAL_MS = 60_000L;
    public static final int  FAILURE_THRESHOLD = 3;
    public static final long BOOT_GRACE_MS = 5L * 60_000L;
    public static final long REBOOT_COOLDOWN_MS = 30L * 60_000L;
    public static final int  MAX_REBOOTS_24H = 4;
    public static final int  PROBE_TIMEOUT_MS = 5_000;

    public static final String PREFS_NAME = "watchdog";
    public static final String KEY_ENABLED = "enabled";
    public static final String KEY_FAILURES = "consecutive_failures";
    public static final String KEY_LAST_REBOOT_TS = "last_reboot_ts";
    public static final String KEY_BOOT_ELAPSED_RT = "boot_elapsed_realtime";
    public static final String KEY_REBOOT_HISTORY = "reboot_history";

    public static final String REBOOT_LOG_FILENAME = "watchdog-reboots.log";

    public static final String NOTIF_CHANNEL_ID = "watchdog";
    public static final String NOTIF_CHANNEL_NAME = "Otacon Watchdog";
    public static final int NOTIF_ID = 0xCAFE;

    private WatchdogConfig() {}

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, true);
    }

    public static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply();
    }
}
