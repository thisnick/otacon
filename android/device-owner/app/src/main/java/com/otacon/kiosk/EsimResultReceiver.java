package com.otacon.kiosk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.euicc.EuiccManager;
import android.util.Log;

/**
 * Receives the result of eSIM operations from EuiccManager.
 * Saves the resolution intent for RESOLVABLE_ERROR handling.
 */
public class EsimResultReceiver extends BroadcastReceiver {
    private static final String TAG = "EsimResult";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        int resultCode = getResultCode();
        int detailedCode = intent.getIntExtra(
            EuiccManager.EXTRA_EMBEDDED_SUBSCRIPTION_DETAILED_CODE, -1);
        int operationCode = intent.getIntExtra(
            "android.telephony.euicc.extra.EMBEDDED_SUBSCRIPTION_OPERATION_CODE", -1);
        int errorCode = intent.getIntExtra(
            "android.telephony.euicc.extra.EMBEDDED_SUBSCRIPTION_ERROR_CODE", -1);
        String smdxSubject = intent.getStringExtra(
            "android.telephony.euicc.extra.EMBEDDED_SUBSCRIPTION_SMDX_SUBJECT_CODE");
        String smdxReason = intent.getStringExtra(
            "android.telephony.euicc.extra.EMBEDDED_SUBSCRIPTION_SMDX_REASON_CODE");

        Log.i(TAG, "eSIM result=" + resultCode + " op=" + operationCode
            + " err=" + errorCode + " smdx=" + smdxSubject + "/" + smdxReason);

        KioskProvider.onEsimResult(resultCode, detailedCode,
            operationCode, errorCode, smdxSubject, smdxReason, intent);
    }
}
