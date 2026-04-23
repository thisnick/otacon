package com.otacon.kiosk;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * Stub service for RESPOND_VIA_MESSAGE — required by Android to qualify
 * as a default SMS app candidate. Returns null from onBind.
 */
public class HeadlessSmsSendService extends Service {
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
