package com.otacon.kiosk;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.UserManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "OtaconKiosk";

    private static final String ACTION_CLEAR = "com.otacon.kiosk.CLEAR_RESTRICTIONS";
    private static final String ACTION_REMOVE_OWNER = "com.otacon.kiosk.REMOVE_DEVICE_OWNER";

    private static final String[] USER_RESTRICTIONS = {
        UserManager.DISALLOW_CONFIG_WIFI,
        UserManager.DISALLOW_CONFIG_BLUETOOTH,
        UserManager.DISALLOW_CONFIG_LOCATION,
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_USB_FILE_TRANSFER,
        // DISALLOW_ADJUST_VOLUME — confirmed breaks BlueALSA BT audio on Samsung
        UserManager.DISALLOW_AIRPLANE_MODE,
        UserManager.DISALLOW_CONFIG_TETHERING,
        // DISALLOW_CONFIG_CREDENTIALS — removed so accounts can be managed
    };

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        if (ACTION_REMOVE_OWNER.equals(action)) {
            Log.i(TAG, "Removing device owner");
            clearRestrictions(context);
            DevicePolicyManager dpm = context.getSystemService(DevicePolicyManager.class);
            if (dpm.isDeviceOwnerApp(context.getPackageName())) {
                dpm.clearDeviceOwnerApp(context.getPackageName());
                Log.i(TAG, "Device owner removed");
            }
            return;
        } else if (ACTION_CLEAR.equals(action)) {
            Log.i(TAG, "Clearing all restrictions");
            clearRestrictions(context);
        } else if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            // Fired after `adb install -r` reinstalls the kiosk APK. Boot didn't
            // happen, so the OS won't redeliver BOOT_COMPLETED — we have to
            // restart the watchdog ourselves.
            Log.i(TAG, "MY_PACKAGE_REPLACED — starting watchdog");
            startWatchdog(context);
        } else {
            Log.i(TAG, "Applying restrictions on: " + action);
            applyRestrictions(context);

            // Watchdog wiring runs on boot/apply paths only — not when the user
            // is intentionally clearing or removing device ownership.
            logRecoveryIfRecent(context);
            startWatchdog(context);
        }
    }

    /**
     * If the watchdog rebooted us within the last 10 minutes, emit a tagged
     * logcat line so integration tests can grep for it.
     */
    private static void logRecoveryIfRecent(Context context) {
        File f = new File(context.getFilesDir(), WatchdogConfig.REBOOT_LOG_FILENAME);
        if (!f.exists()) return;
        String last = null;
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (!line.isEmpty()) last = line;
            }
        } catch (IOException e) {
            Log.w(TAG, "watchdog log read failed: " + e.getMessage());
            return;
        }
        if (last == null) return;
        long ts = parseTs(last);
        if (ts <= 0) return;
        long ageMs = System.currentTimeMillis() - ts;
        if (ageMs < 0 || ageMs > 10L * 60_000L) return;
        String reason = parseReason(last);
        Log.i("Watchdog", "WATCHDOG_RECOVERY_BOOT ts=" + ts + " reason=" + reason);
    }

    private static long parseTs(String jsonLine) {
        int i = jsonLine.indexOf("\"ts\":");
        if (i < 0) return 0L;
        int s = i + 5;
        int e = s;
        while (e < jsonLine.length() && (Character.isDigit(jsonLine.charAt(e)) || jsonLine.charAt(e) == '-')) e++;
        try { return Long.parseLong(jsonLine.substring(s, e)); } catch (NumberFormatException ex) { return 0L; }
    }

    private static String parseReason(String jsonLine) {
        int i = jsonLine.indexOf("\"reason\":\"");
        if (i < 0) return "unknown";
        int s = i + 10;
        int e = jsonLine.indexOf('"', s);
        return e > s ? jsonLine.substring(s, e) : "unknown";
    }

    private static void startWatchdog(Context context) {
        try {
            Intent svc = new Intent(context, WatchdogService.class);
            context.startForegroundService(svc);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start WatchdogService: " + e.getMessage());
        }
    }

    static void applyRestrictions(Context context) {
        DevicePolicyManager dpm = context.getSystemService(DevicePolicyManager.class);
        ComponentName admin = new ComponentName(context, DeviceOwnerReceiver.class);

        if (!dpm.isDeviceOwnerApp(context.getPackageName())) {
            Log.e(TAG, "Not device owner, cannot apply restrictions");
            return;
        }

        // Set all audio volumes to max
        AudioManager am = context.getSystemService(AudioManager.class);
        for (int stream : new int[]{AudioManager.STREAM_MUSIC, AudioManager.STREAM_VOICE_CALL}) {
            int maxVol = am.getStreamMaxVolume(stream);
            am.setStreamVolume(stream, maxVol, 0);
        }
        Log.i(TAG, "Media volume set to max: " + am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));

        // Apply user restrictions
        for (String restriction : USER_RESTRICTIONS) {
            dpm.addUserRestriction(admin, restriction);
            Log.i(TAG, "Applied: " + restriction);
        }

        // Disable camera
        dpm.setCameraDisabled(admin, true);
        Log.i(TAG, "Camera disabled");

        // Hide app stores so they can't auto-update apps in the background.
        // setApplicationHidden returns true if the change was applied. We don't
        // disable Play Services itself — too many things depend on it.
        for (String pkg : new String[]{
                "com.android.vending",                     // Google Play Store
                "com.sec.android.app.samsungapps",         // Galaxy Store (Samsung)
                "com.samsung.android.app.omcagent",        // Samsung OMC config update agent
        }) {
            try {
                if (dpm.setApplicationHidden(admin, pkg, true)) {
                    Log.i(TAG, "Hidden: " + pkg);
                }
            } catch (Exception e) {
                Log.w(TAG, "setApplicationHidden(" + pkg + ") failed: " + e.getMessage());
            }
        }

        // Disable keyguard so PIN lock screen doesn't show
        try {
            dpm.setKeyguardDisabled(admin, true);
            Log.i(TAG, "Keyguard disabled");
        } catch (Exception e) {
            Log.w(TAG, "setKeyguardDisabled failed: " + e.getMessage());
        }

        // Set up reset password token for unattended password clearing.
        // The token is persisted in app private storage and activated once
        // the user confirms their PIN via /lock/activate.
        setupResetPasswordToken(context, dpm, admin);

        // Grant the watchdog the right to keep alarms firing in Doze.
        // Complemented at provisioning time by `dumpsys deviceidle whitelist
        // +com.otacon.kiosk` from fleet-agent for belt-and-suspenders.
        try {
            dpm.setPermissionGrantState(admin, context.getPackageName(),
                Manifest.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
            Log.i(TAG, "Granted REQUEST_IGNORE_BATTERY_OPTIMIZATIONS");
        } catch (Exception e) {
            Log.w(TAG, "setPermissionGrantState(IGNORE_BATTERY_OPTIMIZATIONS) failed: " + e.getMessage());
        }

        Log.i(TAG, "All restrictions applied");
    }

    /** Generate and set a reset-password token if one isn't already stored. */
    private static void setupResetPasswordToken(Context context, DevicePolicyManager dpm,
                                                 ComponentName admin) {
        java.io.File tokenFile = new java.io.File(context.getFilesDir(), "reset_token");
        byte[] token;

        if (tokenFile.exists()) {
            // Reuse existing token
            try {
                token = java.nio.file.Files.readAllBytes(tokenFile.toPath());
                if (token.length >= 32) {
                    // Re-set the token with DPM (survives app updates)
                    dpm.setResetPasswordToken(admin, token);
                    Log.i(TAG, "Re-set existing reset password token");
                    return;
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to read token file: " + e.getMessage());
            }
        }

        // Generate new token
        token = new byte[32];
        new java.security.SecureRandom().nextBytes(token);
        try {
            dpm.setResetPasswordToken(admin, token);
            // Persist token
            java.io.FileOutputStream fos = new java.io.FileOutputStream(tokenFile);
            fos.write(token);
            fos.close();
            Log.i(TAG, "Generated and set new reset password token");
        } catch (Exception e) {
            Log.e(TAG, "Failed to set reset password token: " + e.getMessage());
        }
    }

    private static void clearRestrictions(Context context) {
        DevicePolicyManager dpm = context.getSystemService(DevicePolicyManager.class);
        ComponentName admin = new ComponentName(context, DeviceOwnerReceiver.class);

        if (!dpm.isDeviceOwnerApp(context.getPackageName())) {
            Log.e(TAG, "Not device owner, cannot clear restrictions");
            return;
        }

        for (String restriction : USER_RESTRICTIONS) {
            dpm.clearUserRestriction(admin, restriction);
        }
        // Also clear restrictions that were previously applied but removed from the list
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_BLUETOOTH);
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_ADJUST_VOLUME);
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_CREDENTIALS);
        dpm.setCameraDisabled(admin, false);

        // Clear any password policy so PIN can be removed
        dpm.setPasswordQuality(admin, DevicePolicyManager.PASSWORD_QUALITY_UNSPECIFIED);
        try {
            dpm.setKeyguardDisabled(admin, false);
        } catch (Exception ignored) {}
        try {
            dpm.clearResetPasswordToken(admin);
        } catch (Exception ignored) {}

        // Un-hide app stores in case CLEAR is being used to recover usability
        for (String pkg : new String[]{
                "com.android.vending",
                "com.sec.android.app.samsungapps",
                "com.samsung.android.app.omcagent",
        }) {
            try { dpm.setApplicationHidden(admin, pkg, false); } catch (Exception ignored) {}
        }

        Log.i(TAG, "All restrictions cleared");
    }
}
