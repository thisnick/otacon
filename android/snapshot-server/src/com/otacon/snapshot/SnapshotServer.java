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

            System.out.println("Step 7: starting server on port " + PORT);
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

            if (path.equals("/health")) {
                response = "{\"ok\":true}";
            } else if (path.startsWith("/snapshot")) {
                boolean json = path.contains("format=json");
                contentType = json ? "application/json" : "text/plain; charset=utf-8";
                response = snapshot(json);
            } else if (path.equals("/action") && method.equals("POST") && body != null) {
                response = action(body);
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
            || (node.isFocusable() && className(node).endsWith("EditText"));
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
}
