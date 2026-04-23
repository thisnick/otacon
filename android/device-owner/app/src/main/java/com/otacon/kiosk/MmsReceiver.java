package com.otacon.kiosk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Stub receiver for WAP_PUSH_DELIVER — required by Android to qualify
 * as a default SMS app candidate. Does not process MMS content.
 */
public class MmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        // Intentionally empty — MMS not supported in kiosk mode
    }
}
