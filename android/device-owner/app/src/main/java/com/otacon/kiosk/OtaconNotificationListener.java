package com.otacon.kiosk;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Listens for notifications and exposes them via the HTTP server.
 * Enabled via ADB during device provisioning:
 *   adb shell cmd notification allow_listener \
 *       com.otacon.kiosk/.OtaconNotificationListener
 */
public class OtaconNotificationListener extends NotificationListenerService {
    private static final String TAG = "OtaconNotif";
    private static OtaconNotificationListener instance;

    public static OtaconNotificationListener getInstance() {
        return instance;
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        instance = this;
        Log.i(TAG, "Notification listener connected");
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        instance = null;
        Log.i(TAG, "Notification listener disconnected");
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        // Future: push event via WebSocket
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // Future: push event via WebSocket
    }

    /** Get all active notifications as JSON. */
    public String getNotificationsJson() {
        try {
            StatusBarNotification[] notifications = getActiveNotifications();
            JSONArray arr = new JSONArray();
            if (notifications != null) {
                for (StatusBarNotification sbn : notifications) {
                    JSONObject obj = new JSONObject();
                    obj.put("key", sbn.getKey());
                    obj.put("package", sbn.getPackageName());
                    obj.put("time", sbn.getPostTime());

                    android.os.Bundle extras = sbn.getNotification().extras;
                    if (extras != null) {
                        CharSequence title = extras.getCharSequence("android.title");
                        CharSequence text = extras.getCharSequence("android.text");
                        if (title != null) obj.put("title", title.toString());
                        if (text != null) obj.put("text", text.toString());
                    }

                    // Include actions
                    android.app.Notification.Action[] actions = sbn.getNotification().actions;
                    if (actions != null && actions.length > 0) {
                        JSONArray actionsArr = new JSONArray();
                        for (int i = 0; i < actions.length; i++) {
                            JSONObject actionObj = new JSONObject();
                            actionObj.put("index", i);
                            actionObj.put("title", actions[i].title.toString());
                            actionsArr.put(actionObj);
                        }
                        obj.put("actions", actionsArr);
                    }

                    arr.put(obj);
                }
            }
            return arr.toString();
        } catch (Exception e) {
            Log.e(TAG, "Error getting notifications", e);
            return "[]";
        }
    }

    /** Dismiss a notification by key. */
    public void dismissNotification(String key) {
        cancelNotification(key);
        Log.i(TAG, "Dismissed notification: " + key);
    }

    /** Trigger a notification action by key and action index. */
    public boolean triggerAction(String key, int actionIndex) {
        try {
            StatusBarNotification[] notifications = getActiveNotifications();
            if (notifications == null) return false;
            for (StatusBarNotification sbn : notifications) {
                if (sbn.getKey().equals(key)) {
                    android.app.Notification.Action[] actions = sbn.getNotification().actions;
                    if (actions != null && actionIndex >= 0 && actionIndex < actions.length) {
                        actions[actionIndex].actionIntent.send();
                        Log.i(TAG, "Triggered action " + actionIndex + " on " + key);
                        return true;
                    }
                }
            }
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error triggering action", e);
            return false;
        }
    }
}
