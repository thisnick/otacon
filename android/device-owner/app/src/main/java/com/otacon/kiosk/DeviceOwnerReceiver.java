package com.otacon.kiosk;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class DeviceOwnerReceiver extends DeviceAdminReceiver {
    private static final String TAG = "OtaconKiosk";

    @Override
    public void onEnabled(Context context, Intent intent) {
        Log.i(TAG, "Device owner enabled, applying restrictions");
        BootReceiver.applyRestrictions(context);
    }
}
