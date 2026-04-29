package com.otacon.kiosk;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Minimal HTTP probe abstraction. The default implementation hits
 * {@link WatchdogConfig#PROBE_URL} with {@link WatchdogConfig#PROBE_TIMEOUT_MS}
 * connect+read timeout. Tests may substitute a fake to exercise success/failure
 * paths without sockets.
 */
public interface HealthProbe {
    /** @return true if the host responded 2xx within the timeout, false otherwise. */
    boolean probe();

    /** Default HttpURLConnection-backed implementation. */
    final class Http implements HealthProbe {
        @Override
        public boolean probe() {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(WatchdogConfig.PROBE_URL).openConnection();
                conn.setConnectTimeout(WatchdogConfig.PROBE_TIMEOUT_MS);
                conn.setReadTimeout(WatchdogConfig.PROBE_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                int code = conn.getResponseCode();
                return code >= 200 && code < 300;
            } catch (IOException e) {
                return false;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }
}
