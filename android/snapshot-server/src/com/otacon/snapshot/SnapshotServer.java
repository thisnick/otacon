package com.otacon.snapshot;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.lang.reflect.Constructor;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.*;

/**
 * Minimal HTTP server running via app_process with shell permissions.
 * Uses UiAutomation to access the full UI tree (including system dialogs).
 *
 * Launch: adb shell app_process -Djava.class.path=/data/local/tmp/snapshot-server.jar \
 *         / com.otacon.snapshot.SnapshotServer
 *
 * Listens on port 9091.
 */
public class SnapshotServer {
    private static final int PORT = 9091;
    private static UiAutomation uiAutomation;
    private static long nextRef = 0;
    private static final Map<String, String> prevRefs = new HashMap<>();
    private static final Map<String, NodeRef> refMap = new HashMap<>();

    static class NodeRef {
        final AccessibilityNodeInfo node;
        final Rect bounds;
        NodeRef(AccessibilityNodeInfo node, Rect bounds) {
            this.node = node;
            this.bounds = bounds;
        }
    }

    public static void main(String[] args) {
        try {
            System.out.println("Step 1: Looper");
            if (Looper.myLooper() == null) Looper.prepareMainLooper();

            System.out.println("Step 2: HandlerThread");
            HandlerThread handlerThread = new HandlerThread("UiAutomation");
            handlerThread.start();

            System.out.println("Step 3: UiAutomationConnection (reflection)");
            Class<?> connClass = Class.forName("android.app.UiAutomationConnection");
            Object connection = connClass.getDeclaredConstructor().newInstance();

            System.out.println("Step 4: listing UiAutomation constructors");
            for (java.lang.reflect.Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
                System.out.println("  ctor: " + java.util.Arrays.toString(c.getParameterTypes()));
            }

            System.out.println("Step 5: finding matching constructor");
            Constructor<?> ctor = null;
            for (java.lang.reflect.Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
                Class<?>[] params = c.getParameterTypes();
                if (params.length >= 2 && params[0] == Looper.class) {
                    ctor = c;
                    break;
                }
            }
            if (ctor == null) throw new RuntimeException("No suitable UiAutomation constructor found");
            ctor.setAccessible(true);
            uiAutomation = (UiAutomation) ctor.newInstance(handlerThread.getLooper(), connection);

            System.out.println("Step 6: connect()");
            UiAutomation.class.getDeclaredMethod("connect").invoke(uiAutomation);

            System.out.println("Step 7: configuring service info");
            android.accessibilityservice.AccessibilityServiceInfo info = uiAutomation.getServiceInfo();
            if (info != null) {
                info.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                    | android.accessibilityservice.AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
                uiAutomation.setServiceInfo(info);
                System.out.println("  flags set: FLAG_RETRIEVE_INTERACTIVE_WINDOWS | FLAG_INCLUDE_NOT_IMPORTANT_VIEWS");
            } else {
                System.out.println("  WARNING: getServiceInfo() returned null");
            }

            System.out.println("Step 8: waiting for connection");
            Thread.sleep(500);

            // Start telephony monitor (call state push events)
            System.out.println("Step 9: starting telephony monitor");
            TelephonyMonitor telephonyMonitor = new TelephonyMonitor();
            telephonyMonitor.start(handlerThread.getLooper());

            System.out.println("Step 10: starting server on port " + PORT);
            ServerSocket server = new ServerSocket(PORT);
            System.out.println("Snapshot server ready");
            System.out.flush();

            while (true) {
                try {
                    Socket client = server.accept();
                    handleClient(client);
                } catch (Exception e) {
                    System.err.println("Client error: " + e.getMessage());
                }
            }
        } catch (Throwable t) {
            System.err.println("FATAL: " + t.getClass().getName() + ": " + t.getMessage());
            t.printStackTrace(System.err);
            System.err.flush();
            System.exit(1);
        }
    }

    private static void handleClient(Socket client) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
        OutputStream out = client.getOutputStream();

        try {
            String requestLine = reader.readLine();
            if (requestLine == null) { client.close(); return; }

            // Read headers (skip them)
            String line;
            int contentLength = 0;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    contentLength = Integer.parseInt(line.substring(15).trim());
                }
            }

            // Read body if present
            String body = null;
            if (contentLength > 0) {
                char[] buf = new char[contentLength];
                reader.read(buf, 0, contentLength);
                body = new String(buf);
            }

            String[] parts = requestLine.split(" ");
            String method = parts[0];
            String path = parts.length > 1 ? parts[1] : "/";

            String response;
            String contentType = "application/json";

            // Split path and query string
            String rawPath = path;
            String queryString = "";
            if (rawPath.contains("?")) {
                queryString = rawPath.substring(rawPath.indexOf("?") + 1);
                rawPath = rawPath.substring(0, rawPath.indexOf("?"));
            }

            if (rawPath.equals("/health")) {
                response = "{\"ok\":true}";
            } else if (rawPath.startsWith("/snapshot")) {
                boolean json = path.contains("format=json");
                contentType = json ? "application/json" : "text/plain; charset=utf-8";
                response = snapshot(json);
            } else if (rawPath.equals("/action") && method.equals("POST") && body != null) {
                response = action(body);
            } else if (rawPath.equals("/esim/profiles")) {
                response = esimProfiles();
            } else if (rawPath.equals("/esim/enable")) {
                response = esimEnable(queryString);
            } else if (rawPath.equals("/esim/switch")) {
                response = esimSwitch(queryString);
            } else if (rawPath.equals("/esim/defaults")) {
                response = esimDefaults(queryString);
            } else {
                sendResponse(out, 404, "application/json", "{\"error\":\"not found\"}");
                client.close();
                return;
            }

            sendResponse(out, 200, contentType, response);
        } finally {
            client.close();
        }
    }

    private static void sendResponse(OutputStream out, int code, String contentType, String body) throws IOException {
        String status = code == 200 ? "OK" : "Not Found";
        byte[] bodyBytes = body.getBytes("UTF-8");
        String header = "HTTP/1.1 " + code + " " + status + "\r\n"
            + "Content-Type: " + contentType + "\r\n"
            + "Content-Length: " + bodyBytes.length + "\r\n"
            + "Connection: close\r\n"
            + "\r\n";
        out.write(header.getBytes("UTF-8"));
        out.write(bodyBytes);
        out.flush();
    }

    // --- Snapshot ---

    private static String snapshot(boolean json) {
        refMap.clear();
        List<AccessibilityNodeInfo> roots = new ArrayList<>();

        // Wait for UI to settle so WebView bounds are up-to-date
        try { uiAutomation.waitForIdle(500, 2000); } catch (Exception ignored) {}

        // Clear the accessibility node cache via reflection to force fresh data
        try {
            Class<?> client = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
            java.lang.reflect.Method getInstance = client.getMethod("getInstance");
            Object instance = getInstance.invoke(null);
            java.lang.reflect.Method clearCache = client.getMethod("clearCache");
            clearCache.invoke(instance);
        } catch (Exception e) {
            System.err.println("clearCache() failed (non-fatal): " + e.getMessage());
        }

        try {
            List<AccessibilityWindowInfo> windows = uiAutomation.getWindows();
            System.out.println("getWindows() returned " + windows.size() + " windows");
            for (AccessibilityWindowInfo w : windows) {
                AccessibilityNodeInfo root = w.getRoot();
                System.out.println("  window type=" + w.getType() + " layer=" + w.getLayer()
                    + " hasRoot=" + (root != null));
                if (root != null) roots.add(root);
            }
        } catch (Exception e) {
            System.err.println("getWindows() failed: " + e.getMessage());
            // Fallback
            try {
                AccessibilityNodeInfo root = uiAutomation.getRootInActiveWindow();
                System.out.println("getRootInActiveWindow() hasRoot=" + (root != null));
                if (root != null) roots.add(root);
            } catch (Exception e2) {
                System.err.println("getRootInActiveWindow() failed: " + e2.getMessage());
            }
        }
        System.out.println("Total roots: " + roots.size());

        if (roots.isEmpty()) return json ? "[]" : "";

        if (json) {
            try {
                JSONArray arr = new JSONArray();
                for (int i = 0; i < roots.size(); i++) {
                    arr.put(nodeToJson(roots.get(i), "/" + i));
                }
                return arr.toString(2);
            } catch (Exception e) {
                return "{\"error\":\"" + e.getMessage() + "\"}";
            }
        } else {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < roots.size(); i++) {
                nodeToText(roots.get(i), 0, "/" + i, sb);
            }
            return sb.toString();
        }
    }

    // --- Action ---

    private static String action(String body) {
        try {
            JSONObject req = new JSONObject(body);
            String actionType = req.getString("action");
            String refId = req.optString("ref", null);

            if (refId != null) {
                NodeRef ref = refMap.get(refId);
                if (ref == null || ref.node == null) {
                    return "{\"error\":\"ref " + refId + " not found\"}";
                }
                boolean ok;
                switch (actionType) {
                    case "click":
                        ok = ref.node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        break;
                    case "long_click":
                        ok = ref.node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK);
                        break;
                    case "set_text":
                        Bundle args = new Bundle();
                        args.putCharSequence(
                            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                            req.optString("text", ""));
                        ok = ref.node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                        break;
                    case "scroll_forward":
                        ok = ref.node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
                        break;
                    case "scroll_backward":
                        ok = ref.node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
                        break;
                    case "focus":
                        ok = ref.node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                        break;
                    default:
                        return "{\"error\":\"unknown action: " + actionType + "\"}";
                }
                return "{\"ok\":" + ok + "}";
            }
            return "{\"error\":\"ref required\"}";
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    // --- Tree serialization ---

    private static boolean isRefable(AccessibilityNodeInfo node) {
        return node.isClickable()
            || node.isLongClickable()
            || node.isCheckable()
            || node.isScrollable()
            || node.isFocusable();
    }

    private static String fingerprint(AccessibilityNodeInfo node, String path) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        String cls = className(node);
        String rid = node.getViewIdResourceName() != null ? node.getViewIdResourceName() : "";
        String text = node.getText() != null ? node.getText().toString() : "";
        String desc = node.getContentDescription() != null ? node.getContentDescription().toString() : "";
        return path + "|" + cls + "|" + rid + "|" + text + "|" + desc
            + "|" + bounds.left + "," + bounds.top + "," + bounds.right + "," + bounds.bottom;
    }

    private static String assignRef(AccessibilityNodeInfo node, String path) {
        if (!isRefable(node)) return null;
        String fp = fingerprint(node, path);
        String refId = prevRefs.get(fp);
        if (refId == null) {
            refId = "e" + nextRef++;
        }
        prevRefs.put(fp, refId);
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        refMap.put(refId, new NodeRef(node, bounds));
        return refId;
    }

    private static String className(AccessibilityNodeInfo node) {
        CharSequence cls = node.getClassName();
        return cls != null ? cls.toString() : "";
    }

    private static String shortClass(String cls) {
        if (cls.startsWith("android.widget.")) return cls.substring(15);
        if (cls.startsWith("android.view.")) return cls.substring(13);
        return cls;
    }

    // --- Text output ---

    private static void nodeToText(AccessibilityNodeInfo node, int indent, String path, StringBuilder sb) {
        String cls = className(node);
        String name = shortClass(cls);
        for (int i = 0; i < indent; i++) sb.append("  ");
        sb.append(name);

        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        if (text != null && text.length() > 0) {
            sb.append(" \"").append(text.toString().replace("\n", " ")).append("\"");
        } else if (desc != null && desc.length() > 0) {
            sb.append(" \"").append(desc.toString().replace("\n", " ")).append("\"");
        }

        String refId = assignRef(node, path);
        List<String> attrs = new ArrayList<>();
        if (refId != null) attrs.add("ref=" + refId);
        if (node.isLongClickable()) attrs.add("long-clickable");
        if (node.isChecked()) attrs.add("checked");
        if (node.isFocused()) attrs.add("focused");
        if (node.isScrollable()) attrs.add("scrollable");
        if (node.isSelected()) attrs.add("selected");
        if (!node.isEnabled()) attrs.add("disabled");
        if (!node.isVisibleToUser()) attrs.add("offscreen");

        if (!attrs.isEmpty()) {
            sb.append(" [");
            for (int i = 0; i < attrs.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(attrs.get(i));
            }
            sb.append("]");
        }
        sb.append("\n");

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                nodeToText(child, indent + 1, path + "/" + shortClass(cls) + "." + i, sb);
            }
        }
    }

    // --- JSON output ---

    private static JSONObject nodeToJson(AccessibilityNodeInfo node, String path) throws Exception {
        JSONObject obj = new JSONObject();
        String cls = className(node);
        obj.put("class", cls);

        if (node.getText() != null && node.getText().length() > 0)
            obj.put("text", node.getText().toString());
        if (node.getContentDescription() != null && node.getContentDescription().length() > 0)
            obj.put("content_desc", node.getContentDescription().toString());
        if (node.getViewIdResourceName() != null)
            obj.put("resource_id", node.getViewIdResourceName());

        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        JSONObject b = new JSONObject();
        b.put("x1", bounds.left); b.put("y1", bounds.top);
        b.put("x2", bounds.right); b.put("y2", bounds.bottom);
        obj.put("bounds", b);

        String refId = assignRef(node, path);
        if (refId != null) obj.put("ref_id", refId);

        obj.put("clickable", node.isClickable());
        obj.put("long_clickable", node.isLongClickable());
        obj.put("checkable", node.isCheckable());
        obj.put("checked", node.isChecked());
        obj.put("focusable", node.isFocusable());
        obj.put("focused", node.isFocused());
        obj.put("scrollable", node.isScrollable());
        obj.put("enabled", node.isEnabled());
        obj.put("selected", node.isSelected());
        obj.put("visible_to_user", node.isVisibleToUser());

        JSONArray children = new JSONArray();
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                children.put(nodeToJson(child, path + "/" + shortClass(cls) + "." + i));
            }
        }
        if (children.length() > 0) obj.put("children", children);

        return obj;
    }

    // --- Query string parser ---

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> params = new HashMap<>();
        if (query == null || query.isEmpty()) return params;
        for (String param : query.split("&")) {
            String[] kv = param.split("=", 2);
            if (kv.length == 2) {
                try {
                    params.put(kv[0], java.net.URLDecoder.decode(kv[1], "UTF-8"));
                } catch (Exception e) {
                    params.put(kv[0], kv[1]);
                }
            }
        }
        return params;
    }

    // --- Shell command helper ---

    private static String shellExec(String command) throws Exception {
        Process proc = Runtime.getRuntime().exec(new String[]{"sh", "-c", command});
        BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream()));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            if (sb.length() > 0) sb.append("\n");
            sb.append(line);
        }
        proc.waitFor();
        return sb.toString();
    }

    // --- eSIM: list profiles ---

    private static String esimProfiles() {
        try {
            // Get ISub binder for subscription list
            Object binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class)
                .invoke(null, "isub");
            Object isub = Class.forName("com.android.internal.telephony.ISub$Stub")
                .getMethod("asInterface", android.os.IBinder.class)
                .invoke(null, binder);

            // Get default SMS subId
            String defaultSms = shellExec("settings get global multi_sim_sms").trim();
            int defaultSmsSubId = -1;
            try { defaultSmsSubId = Integer.parseInt(defaultSms); } catch (Exception ignored) {}

            JSONArray profiles = new JSONArray();

            // Try getActiveSubscriptionInfoList first
            java.lang.reflect.Method getActive = isub.getClass()
                .getMethod("getActiveSubscriptionInfoList", String.class, String.class, boolean.class);
            Object result = getActive.invoke(isub, "com.android.shell", "com.android.shell", false);

            // Get isSubscriptionEnabled method for accurate enabled status
            java.lang.reflect.Method isEnabled = isub.getClass()
                .getMethod("isSubscriptionEnabled", int.class);

            if (result instanceof java.util.List) {
                for (Object info : (java.util.List<?>) result) {
                    android.telephony.SubscriptionInfo sub = (android.telephony.SubscriptionInfo) info;
                    boolean subEnabled = true;
                    try {
                        subEnabled = (boolean) isEnabled.invoke(isub, sub.getSubscriptionId());
                    } catch (Exception ignored) {}

                    JSONObject profile = new JSONObject();
                    profile.put("subId", sub.getSubscriptionId());
                    profile.put("iccid", sub.getIccId());
                    profile.put("carrier", String.valueOf(sub.getCarrierName()));
                    profile.put("slot", sub.getSimSlotIndex());
                    profile.put("embedded", sub.isEmbedded());
                    profile.put("enabled", subEnabled);
                    profile.put("isDefault", sub.getSubscriptionId() == defaultSmsSubId);
                    profiles.put(profile);
                }
            }

            // NOTE: Disabled embedded profiles are NOT returned by ISub APIs from shell UID.
            // The Rust server should call "adb shell dumpsys isub" and parse
            // SubscriptionInfoInternal entries with isEmbedded=1 for the full list.

            return profiles.toString();
        } catch (Exception e) {
            Throwable cause = e;
            while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
            return "{\"error\":\"" + escapeJson(cause.getMessage()) + "\"}";
        }
    }

    // --- eSIM: enable/disable ---

    private static String esimEnable(String query) {
        try {
            Map<String, String> params = parseQuery(query);
            String subIdStr = params.get("subId");
            String enabledStr = params.get("enabled");
            if (subIdStr == null) return "{\"error\":\"missing subId parameter\"}";

            int subId = Integer.parseInt(subIdStr);
            boolean enabled = enabledStr == null || !"false".equals(enabledStr);

            // Get ISub service via ServiceManager
            Object binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class)
                .invoke(null, "isub");
            Object isub = Class.forName("com.android.internal.telephony.ISub$Stub")
                .getMethod("asInterface", android.os.IBinder.class)
                .invoke(null, binder);

            java.lang.reflect.Method method = isub.getClass()
                .getMethod("setUiccApplicationsEnabled", boolean.class, int.class);
            Object result = method.invoke(isub, enabled, subId);

            System.out.println("[esim] setUiccApplicationsEnabled(" + enabled + ", " + subId + ") = " + result);
            return "{\"ok\":true,\"subId\":" + subId + ",\"enabled\":" + enabled + "}";
        } catch (Exception e) {
            Throwable cause = e;
            while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
            String msg = cause.getClass().getSimpleName() + ": " + cause.getMessage();
            System.err.println("[esim] enable error: " + msg);
            return "{\"error\":\"" + escapeJson(msg) + "\"}";
        }
    }

    // --- eSIM: switch active profile via IEuiccController ---

    private static String esimSwitch(String query) {
        try {
            java.util.Map<String, String> params = parseQuery(query);
            String subIdStr = params.get("subId");
            if (subIdStr == null) return "{\"error\":\"missing subId parameter\"}";
            int subId = Integer.parseInt(subIdStr);

            // Get IEuiccController binder
            Object binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class)
                .invoke(null, "econtroller");
            Object ec = Class.forName("com.android.internal.telephony.euicc.IEuiccController$Stub")
                .getMethod("asInterface", android.os.IBinder.class)
                .invoke(null, binder);

            // switchToSubscription(int cardId, int subId, String callingPackage, PendingIntent callback)
            // Try with null PendingIntent — shell UID might allow it
            java.lang.reflect.Method switchMethod = ec.getClass()
                .getMethod("switchToSubscription", int.class, int.class, String.class,
                    android.app.PendingIntent.class);
            switchMethod.invoke(ec, 0, subId, "com.android.shell", null);

            System.out.println("[esim] switchToSubscription(0, " + subId + ") called");
            // No callback — give it a moment then report
            Thread.sleep(3000);
            return "{\"ok\":true,\"subId\":" + subId + "}";
        } catch (Exception e) {
            Throwable cause = e;
            while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
            String msg = cause.getClass().getSimpleName() + ": " + cause.getMessage();
            System.err.println("[esim] switch error: " + msg);
            return "{\"error\":\"" + escapeJson(msg) + "\"}";
        }
    }

    // --- eSIM: defaults ---

    private static String esimDefaults(String query) {
        try {
            Map<String, String> params = parseQuery(query);

            // Set defaults if parameters provided
            if (params.containsKey("sms")) {
                shellExec("settings put global multi_sim_sms " + Integer.parseInt(params.get("sms")));
            }
            if (params.containsKey("voice")) {
                shellExec("settings put global multi_sim_voice " + Integer.parseInt(params.get("voice")));
            }
            if (params.containsKey("data")) {
                shellExec("settings put global multi_sim_data_call " + Integer.parseInt(params.get("data")));
            }

            // Read current defaults
            String smsSubId = shellExec("settings get global multi_sim_sms").trim();
            String voiceSubId = shellExec("settings get global multi_sim_voice").trim();
            String dataSubId = shellExec("settings get global multi_sim_data_call").trim();

            // Map subIds to ICCIDs via siminfo query
            String smsIccid = findIccidBySubId(smsSubId);
            String voiceIccid = findIccidBySubId(voiceSubId);
            String dataIccid = findIccidBySubId(dataSubId);

            JSONObject result = new JSONObject();
            result.put("smsSubId", parseOrNull(smsSubId));
            result.put("smsIccid", smsIccid);
            result.put("voiceSubId", parseOrNull(voiceSubId));
            result.put("voiceIccid", voiceIccid);
            result.put("dataSubId", parseOrNull(dataSubId));
            result.put("dataIccid", dataIccid);
            return result.toString();
        } catch (Exception e) {
            return "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
        }
    }

    private static Object parseOrNull(String val) {
        if (val == null || val.equals("null") || val.isEmpty()) return JSONObject.NULL;
        try { return Integer.parseInt(val); } catch (Exception e) { return val; }
    }

    private static String findIccidBySubId(String subIdStr) {
        if (subIdStr == null || subIdStr.equals("null") || subIdStr.isEmpty()) return null;
        try {
            int targetSubId = Integer.parseInt(subIdStr);
            Object binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class)
                .invoke(null, "isub");
            Object isub = Class.forName("com.android.internal.telephony.ISub$Stub")
                .getMethod("asInterface", android.os.IBinder.class)
                .invoke(null, binder);
            java.lang.reflect.Method getActive = isub.getClass()
                .getMethod("getActiveSubscriptionInfoList", String.class, String.class, boolean.class);
            Object result = getActive.invoke(isub, "com.android.shell", "com.android.shell", false);
            if (result instanceof java.util.List) {
                for (Object info : (java.util.List<?>) result) {
                    android.telephony.SubscriptionInfo sub = (android.telephony.SubscriptionInfo) info;
                    if (sub.getSubscriptionId() == targetSubId) {
                        return sub.getIccId();
                    }
                }
            }
        } catch (Exception e) {
            System.err.println("[esim] findIccidBySubId failed: " + e.getMessage());
        }
        return null;
    }

    // --- content query output parsers ---

    private static int parseIntField(String row, String field) {
        // Matches: field=123, or field=123\n
        int start = row.indexOf(field + "=");
        if (start < 0) return -1;
        start += field.length() + 1;
        int end = start;
        while (end < row.length() && row.charAt(end) != ',' && row.charAt(end) != '\n') end++;
        try {
            return Integer.parseInt(row.substring(start, end).trim());
        } catch (Exception e) {
            return -1;
        }
    }

    private static String parseStringField(String row, String field) {
        int start = row.indexOf(field + "=");
        if (start < 0) return null;
        start += field.length() + 1;
        int end = start;
        while (end < row.length() && row.charAt(end) != ',' && row.charAt(end) != '\n') end++;
        String val = row.substring(start, end).trim();
        if (val.equals("NULL") || val.isEmpty()) return null;
        return val;
    }

    private static String escapeJson(String s) {
        if (s == null) return "null";
        return s.replace("\\", "\\\\").replace("\"", "'").replace("\n", " ");
    }
}
