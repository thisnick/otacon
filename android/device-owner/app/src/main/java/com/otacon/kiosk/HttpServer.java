package com.otacon.kiosk;

import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/**
 * Lightweight HTTP server running on the phone (port 9090).
 * Exposes device management features: notifications, clipboard,
 * WiFi connect, Bluetooth pairing, SMS, and call control.
 *
 * UI tree snapshots and actions are handled by the separate
 * snapshot-server (app_process on port 9091).
 */
public class HttpServer extends NanoHTTPD {
    private static final String TAG = "OtaconHttp";
    private static final int PORT = 9090;
    private static final String SERVER_EVENT_URL = "http://127.0.0.1:8081/api/internal/event"; // nested under /api in router

    private final android.content.Context context;
    private final long startTime = System.currentTimeMillis();

    // Call state tracking
    private volatile String callState = "idle"; // idle, ringing, active
    private volatile String prevCallState = "idle";
    private volatile String callNumber = null;
    private volatile long callStartTime = 0;

    // SMS tracking
    private long lastSeenSmsId = 0;

    public HttpServer(android.content.Context context) {
        super(PORT);
        this.context = context;
        initLastSeenSmsId();
        registerCallStateListener();
        registerSmsObserver();
    }

    public void startServer() throws IOException {
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        Log.i(TAG, "HTTP server started on port " + PORT);
    }

    private void registerCallStateListener() {
        try {
            android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager)
                context.getSystemService(android.content.Context.TELEPHONY_SERVICE);
            if (tm == null) {
                Log.w(TAG, "TelephonyManager not available");
                return;
            }
            tm.registerTelephonyCallback(context.getMainExecutor(), new CallStateCallback());
            Log.i(TAG, "Call state listener registered (TelephonyCallback)");
        } catch (SecurityException e) {
            Log.w(TAG, "Cannot register call state listener — READ_PHONE_STATE permission not granted. Call status tracking will be unavailable.", e);
        }
    }

    private void initLastSeenSmsId() {
        try {
            android.database.Cursor c = context.getContentResolver().query(
                android.net.Uri.parse("content://sms/inbox"),
                new String[]{"_id"},
                null, null, "_id DESC"
            );
            if (c != null) {
                try {
                    if (c.moveToFirst()) lastSeenSmsId = c.getLong(0);
                } finally { c.close(); }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to init SMS baseline: " + e.getMessage());
        }
    }

    private void registerSmsObserver() {
        try {
            context.getContentResolver().registerContentObserver(
                android.net.Uri.parse("content://sms"),
                true,
                new android.database.ContentObserver(new android.os.Handler(android.os.Looper.getMainLooper())) {
                    @Override
                    public void onChange(boolean selfChange, android.net.Uri uri) {
                        checkNewSms();
                    }
                }
            );
            Log.i(TAG, "SMS observer registered");
        } catch (Exception e) {
            Log.w(TAG, "Cannot register SMS observer: " + e.getMessage());
        }
    }

    private void checkNewSms() {
        try {
            android.database.Cursor c = context.getContentResolver().query(
                android.net.Uri.parse("content://sms/inbox"),
                new String[]{"_id", "address", "body"},
                "_id > ?",
                new String[]{String.valueOf(lastSeenSmsId)},
                "_id ASC"
            );
            if (c != null) {
                try {
                    while (c.moveToNext()) {
                        long id = c.getLong(0);
                        String from = c.getString(1);
                        String body = c.getString(2);
                        lastSeenSmsId = id;
                        Log.i(TAG, "New SMS from " + from + ": " + body.substring(0, Math.min(30, body.length())));
                        try {
                            JSONObject data = new JSONObject();
                            data.put("from", from);
                            data.put("body", body);
                            pushEvent("sms.received", data);
                        } catch (Exception ignored) {}
                    }
                } finally { c.close(); }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to check new SMS: " + e.getMessage());
        }
    }

    private void pushEvent(String eventType, JSONObject data) {
        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject();
                payload.put("event", eventType);
                payload.put("data", data);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
                    new java.net.URL(SERVER_EVENT_URL).openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(2000);
                conn.setReadTimeout(2000);
                conn.getOutputStream().write(payload.toString().getBytes());
                int code = conn.getResponseCode();
                if (code != 200) {
                    Log.w(TAG, "pushEvent " + eventType + " got " + code);
                }
                conn.disconnect();
            } catch (Exception e) {
                Log.d(TAG, "pushEvent " + eventType + " failed: " + e.getMessage());
            }
        }).start();
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Method method = session.getMethod();

        try {
            if ("/health".equals(uri) && method == Method.GET) {
                return handleHealth();
            }

            // Notifications
            if ("/notifications".equals(uri) && method == Method.GET) {
                return handleGetNotifications();
            }
            if (uri.startsWith("/notifications/") && method == Method.DELETE) {
                String key = uri.substring("/notifications/".length());
                return handleDismissNotification(key);
            }
            // POST /notifications/:key/action/:index
            if (uri.matches("/notifications/.+/action/\\d+") && method == Method.POST) {
                String[] parts = uri.split("/");
                // parts: ["", "notifications", key, "action", index]
                String key = java.net.URLDecoder.decode(parts[2], "UTF-8");
                int index = Integer.parseInt(parts[4]);
                return handleNotificationAction(key, index);
            }

            // WiFi
            if ("/wifi/connect".equals(uri) && method == Method.POST) {
                return handleWifiConnect(session);
            }

            // Bluetooth
            if ("/bluetooth/pair".equals(uri) && method == Method.POST) {
                return handleBluetoothPair(session);
            }

            // SMS
            if ("/sms/send".equals(uri) && method == Method.POST) {
                return handleSmsSend(session);
            }

            // Calls
            if ("/call/dial".equals(uri) && method == Method.POST) {
                return handleCallDial(session);
            }
            if ("/call/answer".equals(uri) && method == Method.POST) {
                return handleCallAnswer();
            }
            if ("/call/hangup".equals(uri) && method == Method.POST) {
                return handleCallHangup();
            }
            if ("/call/status".equals(uri) && method == Method.GET) {
                return handleCallStatus();
            }

            // Clipboard
            if ("/clipboard".equals(uri) && method == Method.GET) {
                return handleGetClipboard();
            }
            if ("/clipboard".equals(uri) && (method == Method.PUT || method == Method.POST)) {
                return handleSetClipboard(session);
            }

            return newFixedLengthResponse(Response.Status.NOT_FOUND,
                MIME_JSON, "{\"error\": \"not found\"}");
        } catch (Exception e) {
            Log.e(TAG, "Error handling " + method + " " + uri, e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR,
                MIME_JSON, "{\"error\": \"" + e.getMessage() + "\"}");
        }
    }

    private static final String MIME_JSON = "application/json";

    private Response handleHealth() {
        long uptime = (System.currentTimeMillis() - startTime) / 1000;
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
            "{\"ok\": true, \"uptime\": " + uptime + "}");
    }

    // --- Notifications ---

    private Response handleGetNotifications() {
        OtaconNotificationListener listener = OtaconNotificationListener.getInstance();
        if (listener == null) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "[]");
        }
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
            listener.getNotificationsJson());
    }

    private Response handleDismissNotification(String key) {
        OtaconNotificationListener listener = OtaconNotificationListener.getInstance();
        if (listener == null) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND,
                MIME_JSON, "{\"error\": \"notification listener not active\"}");
        }
        listener.dismissNotification(key);
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "{\"ok\": true}");
    }

    private Response handleNotificationAction(String key, int actionIndex) {
        OtaconNotificationListener listener = OtaconNotificationListener.getInstance();
        if (listener == null) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND,
                MIME_JSON, "{\"error\": \"notification listener not active\"}");
        }
        boolean ok = listener.triggerAction(key, actionIndex);
        if (ok) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "{\"ok\": true}");
        }
        return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_JSON,
            "{\"error\": \"notification or action not found\"}");
    }

    // --- Clipboard ---

    private Response handleGetClipboard() {
        android.content.ClipboardManager cm = (android.content.ClipboardManager)
            context.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "{\"text\": null}");
        }
        android.content.ClipData clip = cm.getPrimaryClip();
        String text = clip != null && clip.getItemCount() > 0
            ? String.valueOf(clip.getItemAt(0).getText()) : null;
        try {
            JSONObject json = new JSONObject();
            json.put("text", text);
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, json.toString());
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR,
                MIME_JSON, "{\"error\": \"" + e.getMessage() + "\"}");
        }
    }

    private Response handleSetClipboard(IHTTPSession session) throws Exception {
        Map<String, String> bodyMap = new java.util.HashMap<>();
        session.parseBody(bodyMap);
        String body = bodyMap.get("postData");
        JSONObject req = new JSONObject(body);
        String text = req.getString("text");

        android.content.ClipboardManager cm = (android.content.ClipboardManager)
            context.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        android.content.ClipData clip = android.content.ClipData.newPlainText("otacon", text);
        cm.setPrimaryClip(clip);

        return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "{\"ok\": true}");
    }

    // --- WiFi ---

    private Response handleWifiConnect(IHTTPSession session) throws Exception {
        Map<String, String> bodyMap = new java.util.HashMap<>();
        session.parseBody(bodyMap);
        String body = bodyMap.get("postData");
        JSONObject req = new JSONObject(body);
        String ssid = req.getString("ssid");
        String password = req.optString("password", "");

        android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager)
            context.getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);

        if (!wm.isWifiEnabled()) {
            wm.setWifiEnabled(true);
            for (int i = 0; i < 10; i++) {
                if (wm.isWifiEnabled()) break;
                Thread.sleep(500);
            }
        }

        // Try legacy WifiConfiguration first (device owner has privileges to force connect)
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
                return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                    "{\"ok\": true, \"method\": \"legacy\"}");
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
                return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                    "{\"ok\": true, \"method\": \"suggestion\"}");
            }
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                "{\"error\": \"suggestion failed, status=" + status + "\"}");
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                "{\"error\": \"" + e.getMessage() + "\"}");
        }
    }

    // --- Bluetooth ---

    private android.content.BroadcastReceiver pairingReceiver;

    private Response handleBluetoothPair(IHTTPSession session) throws Exception {
        Map<String, String> bodyMap = new java.util.HashMap<>();
        session.parseBody(bodyMap);
        String body = bodyMap.get("postData");
        JSONObject req = new JSONObject(body);
        String mac = req.getString("mac").toUpperCase();

        android.bluetooth.BluetoothManager bm = (android.bluetooth.BluetoothManager)
            context.getSystemService(android.content.Context.BLUETOOTH_SERVICE);
        android.bluetooth.BluetoothAdapter adapter = bm.getAdapter();

        if (adapter == null) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                "{\"error\": \"no bluetooth adapter\"}");
        }

        if (!adapter.isEnabled()) {
            adapter.enable();
            for (int i = 0; i < 20; i++) {
                if (adapter.isEnabled()) break;
                Thread.sleep(500);
            }
            if (!adapter.isEnabled()) {
                return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                    "{\"error\": \"could not enable bluetooth\"}");
            }
        }

        android.bluetooth.BluetoothDevice device = adapter.getRemoteDevice(mac);
        if (device == null) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_JSON,
                "{\"error\": \"device not found: " + mac + "\"}");
        }

        if (device.getBondState() == android.bluetooth.BluetoothDevice.BOND_BONDED) {
            Log.i(TAG, "Already paired with " + mac);
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                "{\"ok\": true, \"status\": \"already_paired\"}");
        }

        registerPairingReceiver(mac);

        boolean started = device.createBond();
        if (!started) {
            unregisterPairingReceiver();
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                "{\"error\": \"createBond failed\"}");
        }

        // Wait for bonding (Samsung shows a dialog — auto-tap via snapshot server)
        for (int i = 0; i < 60; i++) {
            int state = device.getBondState();
            if (state == android.bluetooth.BluetoothDevice.BOND_BONDED) {
                Log.i(TAG, "Paired with " + mac);
                unregisterPairingReceiver();
                return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                    "{\"ok\": true, \"status\": \"paired\"}");
            }
            if (state == android.bluetooth.BluetoothDevice.BOND_NONE && i > 4) {
                break;
            }
            Thread.sleep(500);
        }

        unregisterPairingReceiver();
        return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
            "{\"error\": \"pairing timed out or failed\"}");
    }

    private void registerPairingReceiver(String targetMac) {
        unregisterPairingReceiver();
        pairingReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context ctx, android.content.Intent intent) {
                if (android.bluetooth.BluetoothDevice.ACTION_PAIRING_REQUEST.equals(intent.getAction())) {
                    android.bluetooth.BluetoothDevice device =
                        intent.getParcelableExtra(android.bluetooth.BluetoothDevice.EXTRA_DEVICE,
                            android.bluetooth.BluetoothDevice.class);
                    if (device != null && device.getAddress().equalsIgnoreCase(targetMac)) {
                        Log.i(TAG, "Auto-confirming pairing with " + targetMac);
                        device.setPairingConfirmation(true);
                        abortBroadcast();
                    }
                }
            }
        };
        android.content.IntentFilter filter = new android.content.IntentFilter(
            android.bluetooth.BluetoothDevice.ACTION_PAIRING_REQUEST);
        filter.setPriority(android.content.IntentFilter.SYSTEM_HIGH_PRIORITY);
        context.registerReceiver(pairingReceiver, filter);
    }

    private void unregisterPairingReceiver() {
        if (pairingReceiver != null) {
            try { context.unregisterReceiver(pairingReceiver); } catch (Exception ignored) {}
            pairingReceiver = null;
        }
    }

    // --- Calls ---

    private Response handleCallDial(IHTTPSession session) throws Exception {
        Map<String, String> bodyMap = new java.util.HashMap<>();
        session.parseBody(bodyMap);
        String body = bodyMap.get("postData");
        JSONObject req = new JSONObject(body);
        String number = req.getString("number");

        android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_CALL);
        intent.setData(android.net.Uri.parse("tel:" + number));
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);

        // Track the outbound number since TelephonyCallback doesn't provide it for outgoing calls
        callNumber = number;

        Log.i(TAG, "Dialing " + number);
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
            "{\"ok\": true, \"number\": \"" + number + "\"}");
    }

    @SuppressWarnings("deprecation")
    private Response handleCallAnswer() {
        if (!"ringing".equals(callState)) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_JSON,
                "{\"error\": \"no incoming call to answer\"}");
        }
        android.telecom.TelecomManager tm = (android.telecom.TelecomManager)
            context.getSystemService(android.content.Context.TELECOM_SERVICE);
        if (tm != null) {
            tm.acceptRingingCall();
            Log.i(TAG, "Call answered");
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "{\"ok\": true}");
        }
        return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
            "{\"error\": \"TelecomManager not available\"}");
    }

    @SuppressWarnings("deprecation")
    private Response handleCallHangup() {
        if ("idle".equals(callState)) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                "{\"ok\": true, \"status\": \"already_idle\"}");
        }
        android.telecom.TelecomManager tm = (android.telecom.TelecomManager)
            context.getSystemService(android.content.Context.TELECOM_SERVICE);
        if (tm != null) {
            tm.endCall();
            Log.i(TAG, "Call ended");
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "{\"ok\": true}");
        }
        return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
            "{\"error\": \"TelecomManager not available\"}");
    }

    private Response handleCallStatus() {
        try {
            JSONObject json = new JSONObject();
            json.put("state", callState);
            if (callNumber != null) {
                json.put("number", callNumber);
            }
            if (callStartTime > 0) {
                long duration = (System.currentTimeMillis() - callStartTime) / 1000;
                json.put("duration", duration);
            }
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, json.toString());
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                "{\"error\": \"" + e.getMessage() + "\"}");
        }
    }

    // --- SMS ---

    private Response handleSmsSend(IHTTPSession session) throws Exception {
        Map<String, String> bodyMap = new java.util.HashMap<>();
        session.parseBody(bodyMap);
        String body = bodyMap.get("postData");
        JSONObject req = new JSONObject(body);
        String to = req.getString("to");
        String message = req.getString("body");

        android.telephony.SmsManager sms = android.telephony.SmsManager.getDefault();
        java.util.ArrayList<String> parts = sms.divideMessage(message);
        if (parts.size() == 1) {
            sms.sendTextMessage(to, null, message, null, null);
        } else {
            sms.sendMultipartTextMessage(to, null, parts, null, null);
        }
        Log.i(TAG, "SMS sent to " + to + " (" + parts.size() + " part(s))");
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
            "{\"ok\": true, \"parts\": " + parts.size() + "}");
    }

    // --- TelephonyCallback for call state tracking (API 31+) ---

    private class CallStateCallback extends android.telephony.TelephonyCallback
            implements android.telephony.TelephonyCallback.CallStateListener {
        @Override
        public void onCallStateChanged(int state) {
            String prev = prevCallState;
            switch (state) {
                case android.telephony.TelephonyManager.CALL_STATE_IDLE:
                    Log.i(TAG, "Call state: IDLE");
                    callState = "idle";
                    callStartTime = 0;
                    if (!"idle".equals(prev)) {
                        try {
                            JSONObject data = new JSONObject();
                            data.put("reason", "ringing".equals(prev) ? "rejected" : "hangup");
                            pushEvent("call.ended", data);
                        } catch (Exception ignored) {}
                    }
                    callNumber = null;
                    break;
                case android.telephony.TelephonyManager.CALL_STATE_RINGING:
                    Log.i(TAG, "Call state: RINGING");
                    callState = "ringing";
                    String incoming = queryLastIncomingNumber();
                    if (incoming != null) {
                        callNumber = incoming;
                        Log.i(TAG, "Incoming call from " + incoming);
                    }
                    try {
                        JSONObject data = new JSONObject();
                        data.put("number", callNumber);
                        pushEvent("call.incoming", data);
                    } catch (Exception ignored) {}
                    break;
                case android.telephony.TelephonyManager.CALL_STATE_OFFHOOK:
                    Log.i(TAG, "Call state: ACTIVE");
                    callState = "active";
                    if (callStartTime == 0) callStartTime = System.currentTimeMillis();
                    try {
                        JSONObject data = new JSONObject();
                        data.put("number", callNumber);
                        pushEvent("call.connected", data);
                    } catch (Exception ignored) {}
                    break;
            }
            prevCallState = callState;
        }
    }

    /**
     * Query the CallLog for the most recent incoming/missed call to determine the caller number.
     * This compensates for TelephonyCallback not providing the number on RINGING.
     */
    private String queryLastIncomingNumber() {
        try {
            android.database.Cursor cursor = context.getContentResolver().query(
                android.provider.CallLog.Calls.CONTENT_URI,
                new String[]{android.provider.CallLog.Calls.NUMBER, android.provider.CallLog.Calls.TYPE},
                android.provider.CallLog.Calls.TYPE + " IN (?, ?)",
                new String[]{
                    String.valueOf(android.provider.CallLog.Calls.INCOMING_TYPE),
                    String.valueOf(android.provider.CallLog.Calls.MISSED_TYPE)
                },
                android.provider.CallLog.Calls.DATE + " DESC"
            );
            if (cursor != null) {
                try {
                    if (cursor.moveToFirst()) {
                        return cursor.getString(0);
                    }
                } finally {
                    cursor.close();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to query CallLog for incoming number: " + e.getMessage());
        }
        return null;
    }

}
