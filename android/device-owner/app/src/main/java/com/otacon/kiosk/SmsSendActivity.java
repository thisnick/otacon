package com.otacon.kiosk;

import android.app.Activity;
import android.os.Bundle;

/**
 * Stub activity for ACTION_SENDTO — required by Android to qualify
 * as a default SMS app candidate. Finishes immediately.
 */
public class SmsSendActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        finish();
    }
}
