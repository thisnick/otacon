package com.otacon.kiosk;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Serializes an AccessibilityNodeInfo tree to text or JSON format.
 * Assigns stable ref IDs using monotonic counter + path-based fingerprinting.
 */
public class TreeSerializer {
    private long nextRef = 0;
    private final Map<String, String> prevRefs = new HashMap<>();
    private final Map<String, RefInfo> refMap = new HashMap<>();

    public static class RefInfo {
        public final AccessibilityNodeInfo node;
        public final Rect bounds;

        RefInfo(AccessibilityNodeInfo node, Rect bounds) {
            this.node = node;
            this.bounds = bounds;
        }
    }

    /** Get the ref→node map from the last serialization. */
    public Map<String, RefInfo> getRefMap() {
        return refMap;
    }

    /** Serialize the tree from all windows to indented text. */
    public String toText(List<AccessibilityWindowInfo> windows) {
        refMap.clear();
        StringBuilder sb = new StringBuilder();
        int idx = 0;
        for (AccessibilityWindowInfo window : windows) {
            AccessibilityNodeInfo root = window.getRoot();
            if (root != null) {
                walkText(root, 0, "/" + idx, sb);
                idx++;
            }
        }
        return sb.toString();
    }

    /** Serialize the tree from all windows to JSON. */
    public String toJson(List<AccessibilityWindowInfo> windows) {
        refMap.clear();
        try {
            JSONArray arr = new JSONArray();
            int idx = 0;
            for (AccessibilityWindowInfo window : windows) {
                AccessibilityNodeInfo root = window.getRoot();
                if (root != null) {
                    arr.put(walkJson(root, "/" + idx));
                    idx++;
                }
            }
            return arr.toString(2);
        } catch (JSONException e) {
            return "{\"error\": \"" + e.getMessage() + "\"}";
        }
    }

    /** Serialize multiple roots (combined from getWindows + getRootInActiveWindow). */
    public String toTextMultiRoot(List<AccessibilityNodeInfo> roots) {
        refMap.clear();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < roots.size(); i++) {
            walkText(roots.get(i), 0, "/" + i, sb);
        }
        return sb.toString();
    }

    /** Serialize multiple roots to JSON. */
    public String toJsonMultiRoot(List<AccessibilityNodeInfo> roots) {
        refMap.clear();
        try {
            JSONArray arr = new JSONArray();
            for (int i = 0; i < roots.size(); i++) {
                arr.put(walkJson(roots.get(i), "/" + i));
            }
            return arr.toString(2);
        } catch (JSONException e) {
            return "{\"error\": \"" + e.getMessage() + "\"}";
        }
    }

    /** Serialize a single root (fallback). */
    public String toText(AccessibilityNodeInfo root) {
        if (root == null) return "";
        refMap.clear();
        StringBuilder sb = new StringBuilder();
        walkText(root, 0, "/0", sb);
        return sb.toString();
    }

    /** Serialize a single root to JSON (fallback). */
    public String toJson(AccessibilityNodeInfo root) {
        if (root == null) return "[]";
        refMap.clear();
        try {
            JSONArray arr = new JSONArray();
            arr.put(walkJson(root, "/0"));
            return arr.toString(2);
        } catch (JSONException e) {
            return "{\"error\": \"" + e.getMessage() + "\"}";
        }
    }

    private boolean isRefable(AccessibilityNodeInfo node) {
        return node.isClickable()
            || node.isLongClickable()
            || node.isCheckable()
            || node.isScrollable()
            || (node.isFocusable() && className(node).endsWith("EditText"));
    }

    private String fingerprint(AccessibilityNodeInfo node, String path) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        String cls = className(node);
        String rid = node.getViewIdResourceName() != null ? node.getViewIdResourceName() : "";
        String text = node.getText() != null ? node.getText().toString() : "";
        String desc = node.getContentDescription() != null ? node.getContentDescription().toString() : "";
        return path + "|" + cls + "|" + rid + "|" + text + "|" + desc
            + "|" + bounds.left + "," + bounds.top + "," + bounds.right + "," + bounds.bottom;
    }

    private String assignRef(AccessibilityNodeInfo node, String path) {
        if (!isRefable(node)) return null;

        String fp = fingerprint(node, path);
        String refId = prevRefs.get(fp);
        if (refId == null) {
            refId = "e" + nextRef++;
        }
        prevRefs.put(fp, refId);

        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        refMap.put(refId, new RefInfo(node, bounds));
        return refId;
    }

    private String className(AccessibilityNodeInfo node) {
        CharSequence cls = node.getClassName();
        return cls != null ? cls.toString() : "";
    }

    private String shortClass(String cls) {
        if (cls.startsWith("android.widget.")) return cls.substring("android.widget.".length());
        if (cls.startsWith("android.view.")) return cls.substring("android.view.".length());
        return cls;
    }

    // --- Text output ---

    private void walkText(AccessibilityNodeInfo node, int indent, String path, StringBuilder sb) {
        String cls = className(node);
        String name = shortClass(cls);
        String prefix = "  ".repeat(indent);

        sb.append(prefix).append(name);

        // Text or content description
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        if (text != null && text.length() > 0) {
            sb.append(" \"").append(text.toString().replace("\n", " ")).append("\"");
        } else if (desc != null && desc.length() > 0) {
            sb.append(" \"").append(desc.toString().replace("\n", " ")).append("\"");
        }

        // Attributes
        String refId = assignRef(node, path);
        StringBuilder attrs = new StringBuilder();
        if (refId != null) append(attrs, "ref=" + refId);
        if (node.isLongClickable()) append(attrs, "long-clickable");
        if (node.isChecked()) append(attrs, "checked");
        if (node.isFocused()) append(attrs, "focused");
        if (node.isScrollable()) append(attrs, "scrollable");
        if (node.isSelected()) append(attrs, "selected");
        if (!node.isEnabled()) append(attrs, "disabled");

        if (attrs.length() > 0) {
            sb.append(" [").append(attrs).append("]");
        }

        sb.append("\n");

        // Children
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                String childPath = path + "/" + shortClass(cls) + "." + i;
                walkText(child, indent + 1, childPath, sb);
            }
        }
    }

    private void append(StringBuilder sb, String attr) {
        if (sb.length() > 0) sb.append(", ");
        sb.append(attr);
    }

    // --- JSON output ---

    private JSONObject walkJson(AccessibilityNodeInfo node, String path) throws JSONException {
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
        b.put("x1", bounds.left);
        b.put("y1", bounds.top);
        b.put("x2", bounds.right);
        b.put("y2", bounds.bottom);
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
                String childPath = path + "/" + shortClass(cls) + "." + i;
                children.put(walkJson(child, childPath));
            }
        }
        if (children.length() > 0) obj.put("children", children);

        return obj;
    }
}
