package com.otacon.kiosk;

import android.app.admin.DeviceAdminReceiver;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class DeviceOwnerReceiver extends DeviceAdminReceiver {
    private static final String TAG = "OtaconKiosk";

    @Override
    public void onEnabled(Context context, Intent intent) {
        Log.i(TAG, "Device owner enabled, applying restrictions");
        BootReceiver.applyRestrictions(context);
        setDefaultSmsApp(context);
    }

    static void setDefaultSmsApp(Context context) {
        try {
            DevicePolicyManager dpm = context.getSystemService(DevicePolicyManager.class);
            ComponentName admin = new ComponentName(context, DeviceOwnerReceiver.class);
            dpm.setDefaultSmsApplication(admin, context.getPackageName());
            // Verify it actually took — on some Samsung builds the call
            // silently fails and leaves the device with NO default SMS app,
            // which breaks SmsManager.sendTextMessage for every app.
            String current = android.provider.Telephony.Sms.getDefaultSmsPackage(context);
            if (!context.getPackageName().equals(current)) {
                Log.w(TAG, "setDefaultSmsApplication failed — default is now '"
                    + current + "'. May need to manually restore a working SMS app.");
            } else {
                Log.i(TAG, "Set default SMS app to " + context.getPackageName());
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to set default SMS app: " + e.getMessage());
        }
    }
}
