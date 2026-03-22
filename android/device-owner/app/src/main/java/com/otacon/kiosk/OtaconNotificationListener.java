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
}
