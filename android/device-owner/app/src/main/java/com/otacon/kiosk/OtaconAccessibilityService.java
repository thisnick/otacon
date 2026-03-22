package com.otacon.kiosk;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;

/**
 * AccessibilityService that provides UI tree access and an embedded HTTP server.
 * Enabled via ADB during device provisioning:
 *   adb shell settings put secure enabled_accessibility_services \
 *       com.otacon.kiosk/.OtaconAccessibilityService
 */
public class OtaconAccessibilityService extends AccessibilityService {
    private static final String TAG = "OtaconA11y";

    private HttpServer httpServer;
    private final TreeSerializer serializer = new TreeSerializer();

    public TreeSerializer getSerializer() {
        return serializer;
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();

        // Configure to see all windows
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            setServiceInfo(info);
        }

        // Start HTTP server
        httpServer = new HttpServer(this);
        try {
            httpServer.startServer();
            Log.i(TAG, "Accessibility service connected, HTTP server started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start HTTP server", e);
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Events are received but we don't need to act on them yet.
        // Phase 5 will implement smart cache invalidation here.
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "Accessibility service interrupted");
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (httpServer != null) {
            httpServer.stop();
            Log.i(TAG, "HTTP server stopped");
        }
    }
}
