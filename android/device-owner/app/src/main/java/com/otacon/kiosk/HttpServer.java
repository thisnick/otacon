package com.otacon.kiosk;

import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/**
 * Lightweight HTTP server running on the phone (port 9090).
 * Exposes device management features: notifications, clipboard,
 * WiFi connect, Bluetooth pairing.
 *
 * UI tree snapshots and actions are handled by the separate
 * snapshot-server (app_process on port 9091).
 */
public class HttpServer extends NanoHTTPD {
    private static final String TAG = "OtaconHttp";
    private static final int PORT = 9090;

    private final android.content.Context context;
    private final long startTime = System.currentTimeMillis();

    public HttpServer(android.content.Context context) {
        super(PORT);
        this.context = context;
    }

    public void startServer() throws IOException {
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        Log.i(TAG, "HTTP server started on port " + PORT);
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

            // Clipboard
            if ("/clipboard".equals(uri) && method == Method.GET) {
                return handleGetClipboard();
            }
            if ("/clipboard".equals(uri) && method == Method.PUT) {
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

}
