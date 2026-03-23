package com.otacon.kiosk;

import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/**
 * Lightweight HTTP server running on the phone (port 9090).
 * Exposes accessibility tree, actions, notifications, and clipboard
 * to the Rust server on the Pi via ADB port forwarding.
 */
public class HttpServer extends NanoHTTPD {
    private static final String TAG = "OtaconHttp";
    private static final int PORT = 9090;

    private final OtaconAccessibilityService service;
    private final long startTime = System.currentTimeMillis();

    public HttpServer(OtaconAccessibilityService service) {
        super(PORT);
        this.service = service;
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
            // Health check
            if ("/health".equals(uri) && method == Method.GET) {
                return handleHealth();
            }

            // Snapshot
            if ("/snapshot".equals(uri) && method == Method.GET) {
                return handleSnapshot(session);
            }

            // Action
            if ("/action".equals(uri) && method == Method.POST) {
                return handleAction(session);
            }

            // Notifications
            if ("/notifications".equals(uri) && method == Method.GET) {
                return handleGetNotifications();
            }
            if (uri.startsWith("/notifications/") && method == Method.DELETE) {
                String key = uri.substring("/notifications/".length());
                return handleDismissNotification(key);
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
    private static final String MIME_TEXT = "text/plain; charset=utf-8";

    // --- Health ---

    private Response handleHealth() {
        long uptime = (System.currentTimeMillis() - startTime) / 1000;
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
            "{\"ok\": true, \"uptime\": " + uptime + "}");
    }

    // --- Snapshot ---

    private Response handleSnapshot(IHTTPSession session) {
        Map<String, String> params = session.getParms();
        String format = params.getOrDefault("format", "text");

        TreeSerializer serializer = service.getSerializer();

        // Collect roots from all available sources
        java.util.List<android.view.accessibility.AccessibilityNodeInfo> roots = new java.util.ArrayList<>();
        java.util.Set<Integer> seenWindowIds = new java.util.HashSet<>();

        // Source 1: getWindows() — system UI, nav bar, etc.
        java.util.List<android.view.accessibility.AccessibilityWindowInfo> windows = service.getWindows();
        if (windows != null) {
            for (android.view.accessibility.AccessibilityWindowInfo w : windows) {
                android.view.accessibility.AccessibilityNodeInfo root = w.getRoot();
                if (root != null) {
                    roots.add(root);
                    seenWindowIds.add(w.getId());
                }
            }
        }

        // Source 2: getRootInActiveWindow() — may capture windows that getWindows() misses
        android.view.accessibility.AccessibilityNodeInfo activeRoot = service.getRootInActiveWindow();
        if (activeRoot != null) {
            // Avoid duplicates: check if this window was already included
            android.view.accessibility.AccessibilityWindowInfo activeWindow = activeRoot.getWindow();
            int activeWindowId = activeWindow != null ? activeWindow.getId() : -1;
            if (!seenWindowIds.contains(activeWindowId)) {
                roots.add(activeRoot);
            }
        }

        if (roots.isEmpty()) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                "{\"error\": \"no windows available\"}");
        }

        if ("json".equals(format)) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                serializer.toJsonMultiRoot(roots));
        } else {
            return newFixedLengthResponse(Response.Status.OK, MIME_TEXT,
                serializer.toTextMultiRoot(roots));
        }
    }

    // --- Action ---

    private Response handleAction(IHTTPSession session) throws Exception {
        // Read POST body
        Map<String, String> bodyMap = new java.util.HashMap<>();
        session.parseBody(bodyMap);
        String body = bodyMap.get("postData");
        if (body == null) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST,
                MIME_JSON, "{\"error\": \"missing body\"}");
        }

        JSONObject req = new JSONObject(body);
        String action = req.getString("action");
        String refId = req.optString("ref", null);

        if (refId == null || refId.isEmpty()) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST,
                MIME_JSON, "{\"error\": \"ref required\"}");
        }

        TreeSerializer.RefInfo refInfo = service.getSerializer().getRefMap().get(refId);
        if (refInfo == null || refInfo.node == null) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND,
                MIME_JSON, "{\"error\": \"ref " + refId + " not found\"}");
        }

        AccessibilityNodeInfo node = refInfo.node;
        boolean success;

        switch (action) {
            case "click":
                success = node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                break;
            case "long_click":
                success = node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK);
                break;
            case "set_text":
                String text = req.optString("text", "");
                android.os.Bundle args = new android.os.Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                success = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                break;
            case "scroll_forward":
                success = node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
                break;
            case "scroll_backward":
                success = node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
                break;
            case "focus":
                success = node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                break;
            case "clear_focus":
                success = node.performAction(AccessibilityNodeInfo.ACTION_CLEAR_FOCUS);
                break;
            default:
                return newFixedLengthResponse(Response.Status.BAD_REQUEST,
                    MIME_JSON, "{\"error\": \"unknown action: " + action + "\"}");
        }

        return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
            "{\"ok\": " + success + "}");
    }

    // --- Notifications (Phase 2 — delegate to NotificationListener) ---

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

    // --- Clipboard (Phase 2) ---

    private Response handleGetClipboard() {
        android.content.ClipboardManager cm = (android.content.ClipboardManager)
            service.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                "{\"text\": null}");
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
            service.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
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
            service.getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);

        if (!wm.isWifiEnabled()) {
            wm.setWifiEnabled(true);
            // Wait for WiFi to enable
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

        // Fallback: WifiNetworkSuggestion (passive — Android decides when to connect)
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
            service.getSystemService(android.content.Context.BLUETOOTH_SERVICE);
        android.bluetooth.BluetoothAdapter adapter = bm.getAdapter();

        if (adapter == null) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                "{\"error\": \"no bluetooth adapter\"}");
        }

        // Enable Bluetooth if off
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

        // Check if already bonded
        if (device.getBondState() == android.bluetooth.BluetoothDevice.BOND_BONDED) {
            Log.i(TAG, "Already paired with " + mac);
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                "{\"ok\": true, \"status\": \"already_paired\"}");
        }

        // Register auto-confirm receiver for pairing requests
        registerPairingReceiver(mac);

        // Initiate pairing
        boolean started = device.createBond();
        if (!started) {
            unregisterPairingReceiver();
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
                "{\"error\": \"createBond failed\"}");
        }

        // Wait for bonding to complete (up to 30s)
        // Samsung shows a pairing dialog that needs to be confirmed via a11y
        for (int i = 0; i < 60; i++) {
            int state = device.getBondState();
            if (state == android.bluetooth.BluetoothDevice.BOND_BONDED) {
                Log.i(TAG, "Paired with " + mac);
                unregisterPairingReceiver();
                return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                    "{\"ok\": true, \"status\": \"paired\"}");
            }
            if (state == android.bluetooth.BluetoothDevice.BOND_NONE && i > 4) {
                // Bonding failed (wait a few seconds before checking —
                // state can briefly be NONE during Samsung dialog transition)
                break;
            }
            // Try to auto-tap Samsung's pairing confirmation dialog
            if (state == android.bluetooth.BluetoothDevice.BOND_BONDING) {
                autoDismissPairingDialog();
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
            public void onReceive(android.content.Context context, android.content.Intent intent) {
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
        service.registerReceiver(pairingReceiver, filter);
    }

    private void unregisterPairingReceiver() {
        if (pairingReceiver != null) {
            try { service.unregisterReceiver(pairingReceiver); } catch (Exception ignored) {}
            pairingReceiver = null;
        }
    }

    /**
     * Samsung shows a BluetoothPairingDialog that requires user confirmation.
     * Use the accessibility service to find and tap the "Pair" button.
     */
    private void autoDismissPairingDialog() {
        try {
            java.util.List<android.view.accessibility.AccessibilityWindowInfo> windows = service.getWindows();
            if (windows == null) return;
            for (android.view.accessibility.AccessibilityWindowInfo window : windows) {
                AccessibilityNodeInfo root = window.getRoot();
                if (root == null) continue;
                AccessibilityNodeInfo pairBtn = findNodeByText(root, "Pair");
                if (pairBtn != null) {
                    Log.i(TAG, "Auto-tapping 'Pair' button in pairing dialog");
                    pairBtn.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    return;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "autoDismissPairingDialog error: " + e.getMessage());
        }
    }

    private AccessibilityNodeInfo findNodeByText(AccessibilityNodeInfo node, String text) {
        if (node == null) return null;
        CharSequence nodeText = node.getText();
        if (nodeText != null && text.equals(nodeText.toString()) && node.isClickable()) {
            return node;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findNodeByText(child, text);
            if (found != null) return found;
        }
        return null;
    }
}
