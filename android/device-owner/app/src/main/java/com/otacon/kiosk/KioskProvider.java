package com.otacon.kiosk;

import android.app.PendingIntent;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.telephony.SmsManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.euicc.DownloadableSubscription;
import android.telephony.euicc.EuiccManager;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Unified ContentProvider replacing the HTTP server for all device-owner operations.
 * Android wakes the app on-demand for each query — immune to Samsung app freezer.
 *
 * Authority: content://com.otacon.kiosk
 *
 * Endpoints:
 *   /health
 *   /sms/send?to=+1234&body=hello
 *   /clipboard
 *   /clipboard/set?text=hello
 *   /notifications
 *   /notifications/dismiss?key=...
 *   /notifications/action?key=...&index=0
 *   /esim/install?activationCode=LPA:1$server$code
 *   /esim/delete?iccid=...
 */
public class KioskProvider extends ContentProvider {
    private static final String TAG = "KioskProvider";
    private static final String ACTION_ESIM_RESULT = "com.otacon.kiosk.ESIM_RESULT";

    // Shared latch + result for synchronous eSIM operations
    private static volatile CountDownLatch esimLatch;
    private static volatile int esimResultCode = -1;
    private static volatile int esimDetailedCode = -1;
    private static volatile int esimOperationCode = -1;
    private static volatile int esimErrorCode = -1;
    private static volatile String esimSmdxSubject;
    private static volatile String esimSmdxReason;
    private static volatile Intent esimResolutionIntent;

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        String path = uri.getPath();
        if (path == null) path = "";
        if (path.startsWith("/")) path = path.substring(1);

        try {
            // --- Health ---
            if (path.equals("health")) {
                return health();
            }

            // --- WiFi ---
            if (path.equals("wifi/connect")) {
                return wifiConnect(uri);
            }

            // --- Bluetooth ---
            if (path.equals("bluetooth/pair")) {
                return bluetoothPair(uri);
            }

            // --- SMS ---
            if (path.equals("sms/send")) {
                return smsSend(uri);
            }

            // --- Clipboard ---
            if (path.equals("clipboard")) {
                return clipboardGet();
            }
            if (path.equals("clipboard/set")) {
                return clipboardSet(uri);
            }

            // --- Notifications ---
            if (path.equals("notifications")) {
                return notificationsList();
            }
            if (path.equals("notifications/dismiss")) {
                return notificationsDismiss(uri);
            }
            if (path.equals("notifications/action")) {
                return notificationsAction(uri);
            }

            // --- eSIM (install/delete only — enable/disable/profiles/defaults moved to snapshot server) ---
            if (path.equals("esim/install")) {
                return esimInstall(uri);
            }
            if (path.equals("esim/delete")) {
                return esimDelete(uri);
            }

            return errorCursor("unknown endpoint: " + path);
        } catch (Exception e) {
            Log.e(TAG, "Error handling " + path, e);
            return errorCursor(e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    // ==================== Health ====================

    private Cursor health() {
        EuiccManager em = getContext().getSystemService(EuiccManager.class);
        MatrixCursor cursor = new MatrixCursor(new String[]{"ok", "esim_supported"});
        cursor.addRow(new Object[]{true, em != null && em.isEnabled()});
        return cursor;
    }

    // ==================== WiFi ====================

    @SuppressWarnings("deprecation")
    private Cursor wifiConnect(Uri uri) {
        String ssid = uri.getQueryParameter("ssid");
        String password = uri.getQueryParameter("password");
        if (ssid == null) return errorCursor("missing ssid parameter");
        if (password == null) password = "";

        android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager)
            getContext().getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);

        if (!wm.isWifiEnabled()) {
            wm.setWifiEnabled(true);
            for (int i = 0; i < 10; i++) {
                if (wm.isWifiEnabled()) break;
                try { Thread.sleep(500); } catch (InterruptedException ignored) {}
            }
        }

        // Device Owner privileged: addNetwork + enableNetwork
        try {
            android.net.wifi.WifiConfiguration config = new android.net.wifi.WifiConfiguration();
            config.SSID = "\"" + ssid + "\"";
            config.preSharedKey = "\"" + password + "\"";
            config.hiddenSSID = true;
            int netId = wm.addNetwork(config);
            if (netId != -1) {
                wm.enableNetwork(netId, true);
                wm.reconnect();
                Log.i(TAG, "WiFi connected to " + ssid + " via legacy API (netId=" + netId + ")");
                MatrixCursor cursor = new MatrixCursor(new String[]{"ok", "method"});
                cursor.addRow(new Object[]{true, "legacy"});
                return cursor;
            }
            Log.w(TAG, "Legacy addNetwork returned -1 for " + ssid);
        } catch (Exception e) {
            Log.w(TAG, "Legacy WiFi connect failed: " + e.getMessage());
        }

        // Fallback: WifiNetworkSuggestion
        try {
            android.net.wifi.WifiNetworkSuggestion suggestion =
                new android.net.wifi.WifiNetworkSuggestion.Builder()
                    .setSsid(ssid)
                    .setWpa2Passphrase(password)
                    .setIsHiddenSsid(true)
                    .build();
            int status = wm.addNetworkSuggestions(java.util.Collections.singletonList(suggestion));
            if (status == android.net.wifi.WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
                Log.i(TAG, "WiFi suggestion added for " + ssid);
                MatrixCursor cursor = new MatrixCursor(new String[]{"ok", "method"});
                cursor.addRow(new Object[]{true, "suggestion"});
                return cursor;
            }
            return errorCursor("suggestion failed, status=" + status);
        } catch (Exception e) {
            return errorCursor(e.getMessage());
        }
    }

    // ==================== Bluetooth ====================

    private android.content.BroadcastReceiver pairingReceiver;

    private Cursor bluetoothPair(Uri uri) {
        String mac = uri.getQueryParameter("mac");
        if (mac == null) return errorCursor("missing mac parameter");
        mac = mac.toUpperCase();

        android.bluetooth.BluetoothManager bm = (android.bluetooth.BluetoothManager)
            getContext().getSystemService(android.content.Context.BLUETOOTH_SERVICE);
        android.bluetooth.BluetoothAdapter adapter = bm.getAdapter();

        if (adapter == null) return errorCursor("no bluetooth adapter");

        if (!adapter.isEnabled()) {
            adapter.enable();
            for (int i = 0; i < 20; i++) {
                if (adapter.isEnabled()) break;
                try { Thread.sleep(500); } catch (InterruptedException ignored) {}
            }
            if (!adapter.isEnabled()) return errorCursor("could not enable bluetooth");
        }

        android.bluetooth.BluetoothDevice device = adapter.getRemoteDevice(mac);
        if (device == null) return errorCursor("device not found: " + mac);

        if (device.getBondState() == android.bluetooth.BluetoothDevice.BOND_BONDED) {
            MatrixCursor cursor = new MatrixCursor(new String[]{"ok", "status"});
            cursor.addRow(new Object[]{true, "already_paired"});
            return cursor;
        }

        registerPairingReceiver(mac);

        boolean started = device.createBond();
        if (!started) {
            unregisterPairingReceiver();
            return errorCursor("createBond failed");
        }

        // Wait for bonding (Samsung shows a dialog — auto-tap via snapshot server)
        for (int i = 0; i < 60; i++) {
            int state = device.getBondState();
            if (state == android.bluetooth.BluetoothDevice.BOND_BONDED) {
                unregisterPairingReceiver();
                MatrixCursor cursor = new MatrixCursor(new String[]{"ok", "status"});
                cursor.addRow(new Object[]{true, "paired"});
                return cursor;
            }
            if (state == android.bluetooth.BluetoothDevice.BOND_NONE && i > 4) break;
            try { Thread.sleep(500); } catch (InterruptedException ignored) {}
        }

        unregisterPairingReceiver();
        return errorCursor("pairing timed out or failed");
    }

    private void registerPairingReceiver(String targetMac) {
        unregisterPairingReceiver();
        pairingReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context ctx, android.content.Intent intent) {
                if (android.bluetooth.BluetoothDevice.ACTION_PAIRING_REQUEST.equals(intent.getAction())) {
                    android.bluetooth.BluetoothDevice dev =
                        intent.getParcelableExtra(android.bluetooth.BluetoothDevice.EXTRA_DEVICE,
                            android.bluetooth.BluetoothDevice.class);
                    if (dev != null && dev.getAddress().equalsIgnoreCase(targetMac)) {
                        Log.i(TAG, "Auto-confirming pairing with " + targetMac);
                        dev.setPairingConfirmation(true);
                        abortBroadcast();
                    }
                }
            }
        };
        android.content.IntentFilter filter = new android.content.IntentFilter(
            android.bluetooth.BluetoothDevice.ACTION_PAIRING_REQUEST);
        filter.setPriority(android.content.IntentFilter.SYSTEM_HIGH_PRIORITY);
        getContext().registerReceiver(pairingReceiver, filter);
    }

    private void unregisterPairingReceiver() {
        if (pairingReceiver != null) {
            try { getContext().unregisterReceiver(pairingReceiver); } catch (Exception ignored) {}
            pairingReceiver = null;
        }
    }

    // ==================== SMS ====================

    private Cursor smsSend(Uri uri) {
        String to = uri.getQueryParameter("to");
        String body = uri.getQueryParameter("body");
        if (to == null || body == null) {
            return errorCursor("missing to or body parameter");
        }

        SmsManager sms = SmsManager.getDefault();
        ArrayList<String> parts = sms.divideMessage(body);
        if (parts.size() == 1) {
            sms.sendTextMessage(to, null, body, null, null);
        } else {
            sms.sendMultipartTextMessage(to, null, parts, null, null);
        }
        Log.i(TAG, "SMS sent to " + to + " (" + parts.size() + " parts)");

        MatrixCursor cursor = new MatrixCursor(new String[]{"ok", "parts"});
        cursor.addRow(new Object[]{true, parts.size()});
        return cursor;
    }

    // ==================== Clipboard ====================

    private Cursor clipboardGet() {
        android.content.ClipboardManager cm = (android.content.ClipboardManager)
            getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        String text = null;
        if (cm != null && cm.hasPrimaryClip()) {
            android.content.ClipData clip = cm.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence cs = clip.getItemAt(0).getText();
                if (cs != null) text = cs.toString();
            }
        }
        MatrixCursor cursor = new MatrixCursor(new String[]{"text"});
        cursor.addRow(new Object[]{text});
        return cursor;
    }

    private Cursor clipboardSet(Uri uri) {
        String text = uri.getQueryParameter("text");
        if (text == null) return errorCursor("missing text parameter");

        android.content.ClipboardManager cm = (android.content.ClipboardManager)
            getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(android.content.ClipData.newPlainText("otacon", text));

        MatrixCursor cursor = new MatrixCursor(new String[]{"ok"});
        cursor.addRow(new Object[]{true});
        return cursor;
    }

    // ==================== Notifications ====================

    private Cursor notificationsList() {
        OtaconNotificationListener listener = OtaconNotificationListener.getInstance();
        MatrixCursor cursor = new MatrixCursor(new String[]{"json"});
        String json = (listener != null) ? listener.getNotificationsJson() : "[]";
        cursor.addRow(new Object[]{json});
        return cursor;
    }

    private Cursor notificationsDismiss(Uri uri) {
        String key = uri.getQueryParameter("key");
        if (key == null) return errorCursor("missing key parameter");

        OtaconNotificationListener listener = OtaconNotificationListener.getInstance();
        if (listener == null) {
            return errorCursor("notification listener not active");
        }
        listener.dismissNotification(key);

        MatrixCursor cursor = new MatrixCursor(new String[]{"ok"});
        cursor.addRow(new Object[]{true});
        return cursor;
    }

    private Cursor notificationsAction(Uri uri) {
        String key = uri.getQueryParameter("key");
        String indexStr = uri.getQueryParameter("index");
        if (key == null || indexStr == null) {
            return errorCursor("missing key or index parameter");
        }

        OtaconNotificationListener listener = OtaconNotificationListener.getInstance();
        if (listener == null) {
            return errorCursor("notification listener not active");
        }

        boolean ok = listener.triggerAction(key, Integer.parseInt(indexStr));
        MatrixCursor cursor = new MatrixCursor(new String[]{"ok"});
        cursor.addRow(new Object[]{ok});
        return cursor;
    }

    // ==================== eSIM ====================

    private Cursor esimInstall(Uri uri) {
        String activationCode = uri.getQueryParameter("activationCode");
        if (activationCode == null || activationCode.isEmpty()) {
            return errorCursor("missing activationCode parameter");
        }

        EuiccManager em = getContext().getSystemService(EuiccManager.class);
        if (em == null || !em.isEnabled()) {
            return errorCursor("EuiccManager not available or eSIM not supported");
        }

        // Snapshot current ICCIDs to detect the new one after download
        java.util.Set<String> beforeIccids = getInstalledIccids();

        String code = activationCode;
        if (code.startsWith("LPA:")) code = code.substring(4);

        DownloadableSubscription sub = DownloadableSubscription.forActivationCode(code);

        esimLatch = new CountDownLatch(1);
        esimResultCode = -1;
        esimDetailedCode = -1;
        esimOperationCode = -1;
        esimErrorCode = -1;
        esimSmdxSubject = null;
        esimSmdxReason = null;

        PendingIntent pi = makeEsimPendingIntent(100);

        Log.i(TAG, "Downloading eSIM profile...");
        try {
            em.downloadSubscription(sub, true, pi);
        } catch (SecurityException e) {
            return errorCursor("SecurityException: " + e.getMessage());
        }

        Cursor result = waitForEsimResult();

        // If successful, find the new ICCID
        if (esimResultCode == EuiccManager.EMBEDDED_SUBSCRIPTION_RESULT_OK) {
            java.util.Set<String> afterIccids = getInstalledIccids();
            afterIccids.removeAll(beforeIccids);
            String newIccid = afterIccids.isEmpty() ? null : afterIccids.iterator().next();

            // Find subId and carrier for the new profile
            String carrier = null;
            int newSubId = -1;
            if (newIccid != null) {
                SubscriptionManager sm = getContext().getSystemService(SubscriptionManager.class);
                List<SubscriptionInfo> subs = sm.getActiveSubscriptionInfoList();
                if (subs != null) {
                    for (SubscriptionInfo info : subs) {
                        if (newIccid.equals(info.getIccId())) {
                            carrier = String.valueOf(info.getCarrierName());
                            newSubId = info.getSubscriptionId();
                            break;
                        }
                    }
                }
            }

            MatrixCursor cursor = new MatrixCursor(new String[]{
                "success", "iccid", "subId", "carrier", "resultCode"
            });
            cursor.addRow(new Object[]{true, newIccid, newSubId, carrier, 0});
            return cursor;
        }

        return result;
    }

    /** Get all installed eSIM ICCIDs from siminfo table. */
    private java.util.Set<String> getInstalledIccids() {
        java.util.Set<String> iccids = new java.util.HashSet<>();
        try {
            android.database.Cursor c = getContext().getContentResolver().query(
                Uri.parse("content://telephony/siminfo"),
                new String[]{"icc_id"}, "is_embedded=1", null, null);
            if (c != null) {
                while (c.moveToNext()) {
                    String iccid = c.getString(0);
                    if (iccid != null && !iccid.isEmpty()) iccids.add(iccid);
                }
                c.close();
            }
        } catch (Exception e) {
            Log.w(TAG, "getInstalledIccids failed: " + e.getMessage());
        }
        return iccids;
    }

    private Cursor esimDelete(Uri uri) {
        // Accept either subId or iccid
        String subIdParam = uri.getQueryParameter("subId");
        String iccid = uri.getQueryParameter("iccid");

        EuiccManager em = getContext().getSystemService(EuiccManager.class);
        if (em == null || !em.isEnabled()) return errorCursor("EuiccManager not available");

        int subId = -1;
        if (subIdParam != null) {
            subId = Integer.parseInt(subIdParam);
        } else if (iccid != null) {
            SubscriptionManager sm = getContext().getSystemService(SubscriptionManager.class);
            SubscriptionInfo target = findEmbeddedSub(sm, iccid);
            if (target != null) {
                subId = target.getSubscriptionId();
            } else {
                subId = findSubIdByIccid(iccid);
            }
        }
        if (subId == -1) return errorCursor("missing subId or iccid, or profile not found");

        esimLatch = new CountDownLatch(1);
        esimResultCode = -1;
        esimDetailedCode = -1;
        esimOperationCode = -1;
        esimErrorCode = -1;
        esimSmdxSubject = null;
        esimSmdxReason = null;

        try {
            em.deleteSubscription(subId, makeEsimPendingIntent(104));
        } catch (SecurityException e) {
            return errorCursor("SecurityException: " + e.getMessage());
        }

        return waitForEsimResult();
    }

    // ==================== eSIM helpers ====================

    private PendingIntent makeEsimPendingIntent(int requestCode) {
        return makeEsimPendingIntent(getContext(), requestCode);
    }

    /** Create a PendingIntent for eSIM callbacks — accessible from EsimResolutionActivity. */
    static PendingIntent makeEsimPendingIntent(android.content.Context context, int requestCode) {
        Intent intent = new Intent(ACTION_ESIM_RESULT);
        intent.setPackage(context.getPackageName());
        return PendingIntent.getBroadcast(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    private Cursor waitForEsimResult() {
        try {
            boolean completed = esimLatch.await(120, TimeUnit.SECONDS);
            if (!completed) return errorCursor("timeout waiting for eSIM result");
        } catch (InterruptedException e) {
            return errorCursor("interrupted");
        }

        // Handle RESOLVABLE_ERROR by launching resolution Activity
        if (esimResultCode == EuiccManager.EMBEDDED_SUBSCRIPTION_RESULT_RESOLVABLE_ERROR
                && esimResolutionIntent != null) {
            Log.i(TAG, "eSIM needs resolution, launching resolution activity...");

            // Reset latch for the resolution result
            esimLatch = new CountDownLatch(1);
            esimResultCode = -1;
            esimDetailedCode = -1;

            Intent resolveActivity = new Intent(getContext(), EsimResolutionActivity.class);
            resolveActivity.putExtra(EsimResolutionActivity.EXTRA_RESOLUTION_INTENT,
                esimResolutionIntent);
            resolveActivity.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(resolveActivity);

            // Wait for resolution result
            try {
                boolean completed = esimLatch.await(120, TimeUnit.SECONDS);
                if (!completed) return errorCursor("timeout waiting for resolution");
            } catch (InterruptedException e) {
                return errorCursor("interrupted during resolution");
            }
        }

        boolean success = esimResultCode == EuiccManager.EMBEDDED_SUBSCRIPTION_RESULT_OK;
        MatrixCursor cursor = new MatrixCursor(new String[]{
            "success", "resultCode", "detailedCode", "operationCode",
            "errorCode", "smdxSubject", "smdxReason"
        });
        cursor.addRow(new Object[]{
            success, esimResultCode, esimDetailedCode,
            esimOperationCode, esimErrorCode,
            esimSmdxSubject, esimSmdxReason
        });

        if (!success) {
            Log.e(TAG, "eSIM failed: result=" + esimResultCode
                + " smdx=" + esimSmdxSubject + "/" + esimSmdxReason);
        }
        return cursor;
    }

    /** Called by EsimResultReceiver when an eSIM operation completes. */
    static void onEsimResult(int resultCode, int detailedCode,
                             int operationCode, int errorCode,
                             String smdxSubject, String smdxReason, Intent intent) {
        esimResultCode = resultCode;
        esimDetailedCode = detailedCode;
        esimOperationCode = operationCode;
        esimErrorCode = errorCode;
        esimSmdxSubject = smdxSubject;
        esimSmdxReason = smdxReason;
        esimResolutionIntent = (resultCode == EuiccManager.EMBEDDED_SUBSCRIPTION_RESULT_RESOLVABLE_ERROR)
            ? intent : null;
        if (esimLatch != null) {
            esimLatch.countDown();
        }
    }

    private SubscriptionInfo findEmbeddedSub(SubscriptionManager sm, String iccid) {
        // Try active subscriptions first
        List<SubscriptionInfo> active = sm.getActiveSubscriptionInfoList();
        if (active != null) {
            for (SubscriptionInfo info : active) {
                if (info.isEmbedded() && iccid.equals(info.getIccId())) return info;
            }
        }
        // Try accessible (includes disabled embedded)
        try {
            List<SubscriptionInfo> subs = sm.getAccessibleSubscriptionInfoList();
            if (subs != null) {
                for (SubscriptionInfo info : subs) {
                    if (info.isEmbedded() && iccid.equals(info.getIccId())) return info;
                }
            }
        } catch (SecurityException e) {
            Log.w(TAG, "getAccessibleSubscriptionInfoList failed: " + e.getMessage());
        }
        return null;
    }

    /**
     * Find subId for an eSIM by ICCID from the siminfo table.
     * Works for both enabled and disabled profiles.
     */
    private int findSubIdByIccid(String iccid) {
        try {
            android.database.Cursor c = getContext().getContentResolver().query(
                Uri.parse("content://telephony/siminfo"),
                new String[]{"_id"}, "icc_id=? AND is_embedded=1",
                new String[]{iccid}, null);
            if (c != null) {
                if (c.moveToFirst()) {
                    int subId = c.getInt(0);
                    c.close();
                    return subId;
                }
                c.close();
            }
        } catch (Exception e) {
            Log.w(TAG, "findSubIdByIccid failed: " + e.getMessage());
        }
        return -1;
    }

    // ==================== Shared ====================

    private MatrixCursor errorCursor(String message) {
        MatrixCursor cursor = new MatrixCursor(new String[]{"error"});
        cursor.addRow(new Object[]{message});
        return cursor;
    }

    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
