package com.otacon.kiosk;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.telephony.euicc.EuiccManager;
import android.util.Log;

/**
 * Transparent Activity that handles eSIM RESOLVABLE_ERROR resolution.
 * When EuiccManager returns resultCode=2, we need an Activity to call
 * startResolutionActivity() which shows Samsung's confirmation dialog.
 * This Activity auto-finishes after the resolution completes.
 */
public class EsimResolutionActivity extends Activity {
    private static final String TAG = "EsimResolution";
    private static final int REQUEST_RESOLVE = 200;

    public static final String EXTRA_RESOLUTION_INTENT = "resolution_intent";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent resolutionIntent = getIntent().getParcelableExtra(
            EXTRA_RESOLUTION_INTENT, Intent.class);
        if (resolutionIntent == null) {
            Log.e(TAG, "No resolution intent provided");
            KioskProvider.onEsimResult(
                EuiccManager.EMBEDDED_SUBSCRIPTION_RESULT_ERROR, -1,
                -1, -1, null, null, null);
            finish();
            return;
        }

        try {
            EuiccManager em = getSystemService(EuiccManager.class);
            em.startResolutionActivity(this, REQUEST_RESOLVE, resolutionIntent,
                KioskProvider.makeEsimPendingIntent(getApplicationContext(), 105));
            Log.i(TAG, "Resolution activity started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start resolution: " + e.getMessage());
            KioskProvider.onEsimResult(
                EuiccManager.EMBEDDED_SUBSCRIPTION_RESULT_ERROR, -1,
                -1, -1, null, null, null);
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_RESOLVE) {
            Log.i(TAG, "Resolution result: " + resultCode);
            // The PendingIntent callback will handle the actual result
            // via EsimResultReceiver -> KioskProvider.onEsimResult
        }
        finish();
    }
}
