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
        } else {
            Log.i(TAG, "Applying restrictions on: " + action);
            applyRestrictions(context);
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

        // Allow lock screen — don't disable keyguard
        // (User can set their own PIN/pattern via device settings)

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

        Log.i(TAG, "All restrictions cleared");
    }
}
