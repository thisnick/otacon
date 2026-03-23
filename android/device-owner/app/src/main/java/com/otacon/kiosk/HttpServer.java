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

        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) {
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                "{\"error\": \"no active window\"}");
        }

        TreeSerializer serializer = service.getSerializer();
        if ("json".equals(format)) {
            String json = serializer.toJson(root);
            return newFixedLengthResponse(Response.Status.OK, MIME_JSON, json);
        } else {
            String text = serializer.toText(root);
            return newFixedLengthResponse(Response.Status.OK, MIME_TEXT, text);
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

        // Use WifiNetworkSuggestion for Android 10+
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

        // Fallback: try legacy WifiConfiguration (device owner has privileges)
        try {
            android.net.wifi.WifiConfiguration config = new android.net.wifi.WifiConfiguration();
            config.SSID = "\"" + ssid + "\"";
            config.preSharedKey = "\"" + password + "\"";
            int netId = wm.addNetwork(config);
            if (netId != -1) {
                wm.enableNetwork(netId, true);
                wm.reconnect();
                Log.i(TAG, "WiFi connected to " + ssid + " via legacy API");
                return newFixedLengthResponse(Response.Status.OK, MIME_JSON,
                    "{\"ok\": true, \"method\": \"legacy\"}");
            }
        } catch (Exception e) {
            Log.w(TAG, "Legacy WiFi connect failed: " + e.getMessage());
        }

        return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_JSON,
            "{\"error\": \"failed to add network suggestion, status=" + status + "\"}");
    }
}
