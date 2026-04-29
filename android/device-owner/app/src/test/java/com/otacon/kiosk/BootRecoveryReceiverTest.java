package com.otacon.kiosk;

import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.shadows.ShadowLog;

import java.io.File;
import java.io.FileWriter;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the BOOT_COMPLETED recovery-marker logging path.
 *
 * Contract: on BOOT_COMPLETED, BootReceiver inspects watchdog-reboots.log
 * and if the most recent entry is younger than 10 minutes, emits a logcat
 * line:
 *     Log.i("Watchdog", "WATCHDOG_RECOVERY_BOOT ts=<ts> reason=<reason>")
 *
 * Older entries (or empty log) produce no recovery marker — avoids spam on
 * routine reboots.
 */
@RunWith(RobolectricTestRunner.class)
public class BootRecoveryReceiverTest {

    private static final String WATCHDOG_TAG = "Watchdog";
    private static final String RECOVERY_PREFIX = "WATCHDOG_RECOVERY_BOOT";

    private Context context;
    private File logFile;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        logFile = new File(context.getFilesDir(), WatchdogConfig.REBOOT_LOG_FILENAME);
        if (logFile.exists()) logFile.delete();
        ShadowLog.clear();
    }

    @After
    public void tearDown() {
        if (logFile.exists()) logFile.delete();
        ShadowLog.clear();
    }

    // ---------------------------------------------------------------
    // Case 1: empty log — no recovery marker
    // ---------------------------------------------------------------
    @Test
    public void fresh_boot_no_log() {
        // No log file at all.
        BootReceiver receiver = new BootReceiver();
        receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));

        assertFalse("no recovery marker on fresh boot",
            findLog(WATCHDOG_TAG, RECOVERY_PREFIX));
    }

    // ---------------------------------------------------------------
    // Case 2: recent reboot (2 min ago) — emits recovery marker
    // ---------------------------------------------------------------
    @Test
    public void recent_reboot_logs_recovery() throws Exception {
        long twoMinAgo = System.currentTimeMillis() - (2L * 60 * 1000);
        writeLogEntry(twoMinAgo, "consecutive_failures=3", 3);

        BootReceiver receiver = new BootReceiver();
        receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));

        assertTrue("recent reboot must produce recovery marker",
            findLog(WATCHDOG_TAG, RECOVERY_PREFIX));
    }

    // ---------------------------------------------------------------
    // Case 3: stale reboot (1 hour ago) — no recovery marker
    // ---------------------------------------------------------------
    @Test
    public void stale_reboot_no_log() throws Exception {
        long oneHourAgo = System.currentTimeMillis() - (60L * 60 * 1000);
        writeLogEntry(oneHourAgo, "consecutive_failures=3", 3);

        BootReceiver receiver = new BootReceiver();
        receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));

        assertFalse("stale reboot must NOT produce recovery marker",
            findLog(WATCHDOG_TAG, RECOVERY_PREFIX));
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------
    private void writeLogEntry(long tsMs, String reason, int failures) throws Exception {
        try (FileWriter w = new FileWriter(logFile, true)) {
            w.write("{\"ts\":" + tsMs + ",\"reason\":\"" + reason
                + "\",\"consecutive_failures\":" + failures + "}\n");
        }
    }

    private static boolean findLog(String tag, String prefix) {
        List<ShadowLog.LogItem> items = ShadowLog.getLogsForTag(tag);
        if (items == null) return false;
        for (ShadowLog.LogItem item : items) {
            if (item.msg != null && item.msg.contains(prefix)) {
                return true;
            }
        }
        return false;
    }
}
