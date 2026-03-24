package com.otacon.kiosk;

import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.UserManager;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "OtaconKiosk";

    private static final String ACTION_CLEAR = "com.otacon.kiosk.CLEAR_RESTRICTIONS";
    private static final String ACTION_REMOVE_OWNER = "com.otacon.kiosk.REMOVE_DEVICE_OWNER";

    private static final String[] USER_RESTRICTIONS = {
        UserManager.DISALLOW_CONFIG_WIFI,
        // DISALLOW_CONFIG_BLUETOOTH removed — may interfere with BlueALSA audio
        UserManager.DISALLOW_CONFIG_LOCATION,
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_USB_FILE_TRANSFER,
        // DISALLOW_ADJUST_VOLUME removed — may interfere with BT audio routing
        UserManager.DISALLOW_AIRPLANE_MODE,
        UserManager.DISALLOW_CONFIG_TETHERING,
        UserManager.DISALLOW_CONFIG_CREDENTIALS,
    };

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        // Ensure HTTP server is running
        ensureHttpServer(context);

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
        } else {
            Log.i(TAG, "Applying restrictions on: " + action);
            applyRestrictions(context);
        }
    }

    private static HttpServer httpServer;

    /** Start the HTTP server if not already running. */
    static void ensureHttpServer(Context context) {
        if (httpServer == null) {
            httpServer = new HttpServer(context.getApplicationContext());
            try {
                httpServer.startServer();
                Log.i(TAG, "HTTP server started");
            } catch (Exception e) {
                Log.e(TAG, "Failed to start HTTP server", e);
            }
        }
    }

    static void applyRestrictions(Context context) {
        DevicePolicyManager dpm = context.getSystemService(DevicePolicyManager.class);
        ComponentName admin = new ComponentName(context, DeviceOwnerReceiver.class);

        if (!dpm.isDeviceOwnerApp(context.getPackageName())) {
            Log.e(TAG, "Not device owner, cannot apply restrictions");
            return;
        }

        // Set media volume to max before locking it
        AudioManager am = context.getSystemService(AudioManager.class);
        int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        am.setStreamVolume(AudioManager.STREAM_MUSIC, maxVol, 0);
        Log.i(TAG, "Media volume set to max: " + maxVol);

        // Apply user restrictions
        for (String restriction : USER_RESTRICTIONS) {
            dpm.addUserRestriction(admin, restriction);
            Log.i(TAG, "Applied: " + restriction);
        }

        // Disable camera
        dpm.setCameraDisabled(admin, true);
        Log.i(TAG, "Camera disabled");

        Log.i(TAG, "All restrictions applied");
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
        dpm.setCameraDisabled(admin, false);

        // Clear any password policy so PIN can be removed
        dpm.setPasswordQuality(admin, DevicePolicyManager.PASSWORD_QUALITY_UNSPECIFIED);
        try {
            dpm.setKeyguardDisabled(admin, false);
        } catch (Exception ignored) {}
        try {
            dpm.clearResetPasswordToken(admin);
        } catch (Exception ignored) {}

        Log.i(TAG, "All restrictions cleared");
    }
}
