package com.otacon.snapshot;

import android.os.Looper;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executor;

/**
 * Monitors call state via TelephonyCallback and pushes events to the
 * otacon server. Runs inside app_process (shell user), which is immune
 * to Samsung's app freezer.
 */
public class TelephonyMonitor {
    private static final String TAG = "TelephonyMonitor";
    private static final String EVENT_URL = "http://127.0.0.1:8081/api/internal/event";
    private static final String SMS_ID_FILE = "/data/local/tmp/otacon-last-sms-id";

    private String prevState = "idle";
    private String callNumber = null;
    private long lastSeenSmsId = 0;

    public void start(Looper looper) {
        try {
            // In app_process, get TelephonyManager via ServiceManager (no Context)
            Object binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class)
                .invoke(null, "phone");

            Object stub = Class.forName("com.android.internal.telephony.ITelephony$Stub")
                .getMethod("asInterface", android.os.IBinder.class)
                .invoke(null, binder);

            // Get TelephonyManager via reflection with default constructor
            TelephonyManager tm = TelephonyManager.class.getDeclaredConstructor().newInstance();

            Executor executor = command -> {
                android.os.Handler handler = new android.os.Handler(looper);
                handler.post(command);
            };

            tm.registerTelephonyCallback(executor, new CallStateCallback());

            System.out.println("[telephony] Call state monitor registered (callback)");
        } catch (Exception e) {
            System.err.println("[telephony] Callback failed: " + e.getMessage());
            try {
                startFallbackMonitor(looper);
            } catch (Exception e2) {
                System.err.println("[telephony] Fallback also failed: " + e2.getMessage());
                e2.printStackTrace(System.err);
            }
        }

        // SMS monitor (polls inbox for new received messages)
        initSmsBaseline();
        startSmsMonitor(looper);
    }

    private void initSmsBaseline() {
        // Try to restore from persisted file first (survives restarts)
        try {
            java.io.BufferedReader fr = new java.io.BufferedReader(
                new java.io.FileReader(SMS_ID_FILE));
            String saved = fr.readLine();
            fr.close();
            if (saved != null && !saved.isEmpty()) {
                lastSeenSmsId = Long.parseLong(saved.trim());
                System.out.println("[telephony] SMS baseline restored from file: " + lastSeenSmsId);
            }
        } catch (Exception e) {
            // file doesn't exist yet, fall through to content query
        }

        // Query current latest SMS ID — use the higher of persisted vs current
        // Note: --limit is not supported on all Android versions, so we sort DESC and take first line
        try {
            Process p = Runtime.getRuntime().exec(new String[]{
                "sh", "-c",
                "content query --uri content://sms/inbox --projection _id --sort \"_id DESC\""
            });
            java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(p.getInputStream()));
            String line = reader.readLine();
            p.destroy(); // only need first line, kill the rest
            if (line != null && line.contains("_id=")) {
                long currentMax = Long.parseLong(
                    line.replaceAll(".*_id=", "").replaceAll(",.*", "").trim());
                if (currentMax > lastSeenSmsId) {
                    lastSeenSmsId = currentMax;
                }
            }
        } catch (Exception e) {
            System.out.println("[telephony] WARNING: SMS content query failed, using persisted baseline");
        }

        persistSmsId();
        System.out.println("[telephony] SMS baseline: " + lastSeenSmsId);
    }

    private void persistSmsId() {
        try {
            java.io.FileWriter fw = new java.io.FileWriter(SMS_ID_FILE);
            fw.write(String.valueOf(lastSeenSmsId));
            fw.close();
        } catch (Exception e) {
            // best effort
        }
    }

    private void startSmsMonitor(Looper looper) {
        System.out.println("[telephony] SMS monitor started (3s poll)");
        android.os.Handler handler = new android.os.Handler(looper);
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                pollSms();
                handler.postDelayed(this, 3000);
            }
        }, 3000);
    }

    private void pollSms() {
        try {
            Process p = Runtime.getRuntime().exec(new String[]{
                "sh", "-c",
                "content query --uri content://sms/inbox " +
                "--projection _id:address:body " +
                "--where \"_id>" + lastSeenSmsId + "\" " +
                "--sort \"_id ASC\""
            });
            java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(p.getInputStream()));
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.contains("_id=")) continue;
                try {
                    long id = Long.parseLong(
                        line.replaceAll(".*_id=", "").replaceAll(",.*", "").trim());
                    String address = line.replaceAll(".*address=", "").replaceAll(",.*", "").trim();
                    String body = line.replaceAll(".*body=", "").replaceAll(",\\s*$", "").trim();
                    if (id > lastSeenSmsId) {
                        lastSeenSmsId = id;
                        persistSmsId();
                        System.out.println("[telephony] New SMS from " + address);
                        JSONObject data = new JSONObject();
                        data.put("from", address);
                        data.put("body", body);
                        pushEvent("sms.received", data);
                    }
                } catch (Exception e) {
                    // skip malformed line
                }
            }
            p.waitFor();
        } catch (Exception e) {
            // ignore polling errors
        }
    }

    /**
     * Fallback: poll dumpsys telephony.registry every 500ms.
     * Used when TelephonyCallback registration fails (common in app_process).
     */
    private void startFallbackMonitor(Looper looper) {
        System.out.println("[telephony] Using polling fallback (500ms)");
        android.os.Handler handler = new android.os.Handler(looper);
        handler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Process p = Runtime.getRuntime().exec(new String[]{
                        "sh", "-c",
                        "dumpsys telephony.registry | grep -E 'mCallState=|mCallIncomingNumber='"
                    });
                    java.io.BufferedReader reader = new java.io.BufferedReader(
                        new java.io.InputStreamReader(p.getInputStream()));
                    String newState = "idle";
                    String number = null;
                    String line;
                    while ((line = reader.readLine()) != null) {
                        line = line.trim();
                        if (line.startsWith("mCallState=")) {
                            int val = Integer.parseInt(line.substring("mCallState=".length()).trim());
                            if (val == 1) newState = "ringing";
                            else if (val == 2) newState = "active";
                        } else if (line.startsWith("mCallIncomingNumber=")) {
                            String n = line.substring("mCallIncomingNumber=".length()).trim();
                            if (!n.isEmpty()) number = n;
                        }
                    }
                    p.waitFor();

                    if (!newState.equals(prevState)) {
                        handleStateChange(newState, number);
                    }
                } catch (Exception e) {
                    // ignore polling errors
                }
                handler.postDelayed(this, 500);
            }
        });
    }

    private void handleStateChange(String newState, String number) {
        System.out.println("[telephony] " + prevState + " -> " + newState);
        try {
            switch (newState) {
                case "ringing": {
                    callNumber = number != null ? number : queryIncomingNumber();
                    JSONObject data = new JSONObject();
                    data.put("number", callNumber);
                    pushEvent("call.incoming", data);
                    break;
                }
                case "active": {
                    JSONObject data = new JSONObject();
                    data.put("number", callNumber);
                    pushEvent("call.connected", data);
                    break;
                }
                case "idle": {
                    if (!"idle".equals(prevState)) {
                        JSONObject data = new JSONObject();
                        data.put("reason", "ringing".equals(prevState) ? "rejected" : "hangup");
                        pushEvent("call.ended", data);
                    }
                    callNumber = null;
                    break;
                }
            }
        } catch (Exception e) {
            System.err.println("[telephony] Error: " + e.getMessage());
        }
        prevState = newState;
    }

    private class CallStateCallback extends TelephonyCallback
            implements TelephonyCallback.CallStateListener {
        @Override
        public void onCallStateChanged(int state) {
            String newState;
            String number = null;
            switch (state) {
                case TelephonyManager.CALL_STATE_RINGING:
                    newState = "ringing";
                    number = queryIncomingNumber();
                    break;
                case TelephonyManager.CALL_STATE_OFFHOOK:
                    newState = "active";
                    break;
                default:
                    newState = "idle";
                    break;
            }
            if (!newState.equals(prevState)) {
                handleStateChange(newState, number);
            }
        }
    }

    private String queryIncomingNumber() {
        // In app_process we don't have a ContentResolver, so we use
        // adb shell to query the call log
        try {
            Process p = Runtime.getRuntime().exec(new String[]{
                "sh", "-c",
                "content query --uri content://call_log/calls " +
                "--projection number --where \"type=1 OR type=3\" " +
                "--sort \"date DESC\" --limit 1"
            });
            java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(p.getInputStream()));
            String line = reader.readLine();
            p.waitFor();
            if (line != null && line.contains("number=")) {
                String num = line.replaceAll(".*number=", "").replaceAll(",.*", "").trim();
                if (!num.isEmpty() && !num.equals("NULL")) {
                    System.out.println("[telephony] Incoming number: " + num);
                    return num;
                }
            }
        } catch (Exception e) {
            System.err.println("[telephony] Failed to query call log: " + e.getMessage());
        }
        return null;
    }

    private void pushEvent(String eventType, JSONObject data) {
        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject();
                payload.put("event", eventType);
                payload.put("data", data);

                HttpURLConnection conn = (HttpURLConnection)
                    new URL(EVENT_URL).openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(2000);
                conn.setReadTimeout(2000);
                OutputStream os = conn.getOutputStream();
                os.write(payload.toString().getBytes());
                os.flush();
                int code = conn.getResponseCode();
                conn.disconnect();

                if (code == 200) {
                    System.out.println("[telephony] Pushed " + eventType);
                } else {
                    System.err.println("[telephony] Push " + eventType + " got " + code);
                }
            } catch (Exception e) {
                System.err.println("[telephony] Push " + eventType + " failed: " + e.getMessage());
            }
        }).start();
    }
}
