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

    private static final String[] USER_RESTRICTIONS = {
        UserManager.DISALLOW_CONFIG_WIFI,
        UserManager.DISALLOW_CONFIG_BLUETOOTH,
        UserManager.DISALLOW_CONFIG_LOCATION,
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_INSTALL_APPS,
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_USB_FILE_TRANSFER,
        UserManager.DISALLOW_ADJUST_VOLUME,
        UserManager.DISALLOW_AIRPLANE_MODE,
        UserManager.DISALLOW_CONFIG_TETHERING,
    };

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        if (ACTION_CLEAR.equals(action)) {
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

        // Disable WiFi and Bluetooth
        dpm.setWifiEnabled(admin, false);
        Log.i(TAG, "WiFi disabled");

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
        dpm.setCameraDisabled(admin, false);
        dpm.setWifiEnabled(admin, true);

        Log.i(TAG, "All restrictions cleared");
    }
}
