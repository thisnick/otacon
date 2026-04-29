package com.otacon.kiosk;

import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.SystemClock;

import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowSystemClock;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Unit tests for the watchdog probe → counter → reboot logic.
 *
 * Contract assumed (negotiated with implementer in spawn message):
 *   - WatchdogReceiver extends BroadcastReceiver, onReceive(Context, Intent) drives all logic.
 *   - HealthProbe is an interface with boolean probe(); injectable via static
 *     test-seam WatchdogReceiver.sProbeOverride.
 *   - DPM is fetched via context.getSystemService(DevicePolicyManager.class).
 *   - Receiver mocks DPM via WatchdogReceiver.sDpmOverride for tests.
 *   - SharedPreferences name "watchdog" with keys:
 *       enabled (bool), consecutive_failures (int), last_reboot_ts (long),
 *       boot_elapsed_realtime (long), reboot_history (string, JSON array).
 *   - WatchdogConfig constants (FAILURE_THRESHOLD=3, BOOT_GRACE_MS=300_000,
 *     REBOOT_COOLDOWN_MS=1_800_000, MAX_REBOOTS_24H=4).
 *   - Reboot log: ${filesDir}/watchdog-reboots.log, JSONL.
 */
@RunWith(RobolectricTestRunner.class)
public class WatchdogReceiverTest {

    private Context context;
    private SharedPreferences prefs;
    private DevicePolicyManager mockDpm;
    private FakeProbe fakeProbe;
    private WatchdogReceiver receiver;

    /** Test double for HealthProbe — controllable success/failure. */
    static class FakeProbe implements HealthProbe {
        boolean nextResult = true;
        int callCount = 0;
        @Override public boolean probe() {
            callCount += 1;
            return nextResult;
        }
    }

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        prefs = context.getSharedPreferences(WatchdogConfig.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().clear().commit();

        mockDpm = mock(DevicePolicyManager.class);
        fakeProbe = new FakeProbe();

        WatchdogReceiver.sProbeOverride = fakeProbe;
        WatchdogReceiver.sDpmOverride = mockDpm;

        // Default: phone has been up long enough that boot grace is over.
        // Boot grace is 5 min; pretend we booted 10 min ago.
        prefs.edit()
            .putLong(WatchdogConfig.KEY_BOOT_ELAPSED_RT, 0L)
            .commit();
        ShadowSystemClock.advanceBy(java.time.Duration.ofMinutes(10));

        // Wipe reboot log if present.
        File logFile = new File(context.getFilesDir(), WatchdogConfig.REBOOT_LOG_FILENAME);
        if (logFile.exists()) logFile.delete();

        receiver = new WatchdogReceiver();
    }

    @After
    public void tearDown() {
        WatchdogReceiver.sProbeOverride = null;
        WatchdogReceiver.sDpmOverride = null;
    }

    // ---------------------------------------------------------------
    // Case 1: probe success resets counter
    // ---------------------------------------------------------------
    @Test
    public void probe_success_resets_counter() {
        prefs.edit().putInt(WatchdogConfig.KEY_FAILURES, 2).commit();
        fakeProbe.nextResult = true;

        receiver.onReceive(context, new Intent());

        assertEquals("counter must reset to 0 on success",
            0, prefs.getInt(WatchdogConfig.KEY_FAILURES, -1));
        verify(mockDpm, never()).reboot(org.mockito.ArgumentMatchers.any());
    }

    // ---------------------------------------------------------------
    // Case 2: probe failure increments counter (no reboot below threshold)
    // ---------------------------------------------------------------
    @Test
    public void probe_fail_increments_counter() {
        prefs.edit().putInt(WatchdogConfig.KEY_FAILURES, 1).commit();
        fakeProbe.nextResult = false;

        receiver.onReceive(context, new Intent());

        assertEquals("counter increments on failure",
            2, prefs.getInt(WatchdogConfig.KEY_FAILURES, -1));
        verify(mockDpm, never()).reboot(org.mockito.ArgumentMatchers.any());
    }

    // ---------------------------------------------------------------
    // Case 3: threshold (3 consecutive fails) triggers reboot
    // ---------------------------------------------------------------
    @Test
    public void threshold_triggers_reboot() throws Exception {
        prefs.edit().putInt(WatchdogConfig.KEY_FAILURES, 2).commit();
        fakeProbe.nextResult = false;

        receiver.onReceive(context, new Intent());

        verify(mockDpm, times(1)).reboot(org.mockito.ArgumentMatchers.any());

        File logFile = new File(context.getFilesDir(), WatchdogConfig.REBOOT_LOG_FILENAME);
        assertTrue("reboot log file must be created", logFile.exists());

        String last = readLastLine(logFile);
        assertTrue("log entry must mention consecutive_failures",
            last != null && last.contains("consecutive_failures"));
    }

    // ---------------------------------------------------------------
    // Case 4: kill switch — disabled → no probe, no counter change
    // ---------------------------------------------------------------
    @Test
    public void kill_switch_skips_probe() {
        prefs.edit()
            .putBoolean(WatchdogConfig.KEY_ENABLED, false)
            .putInt(WatchdogConfig.KEY_FAILURES, 1)
            .commit();
        fakeProbe.nextResult = false;

        receiver.onReceive(context, new Intent());

        assertEquals("probe must not be called when disabled",
            0, fakeProbe.callCount);
        assertEquals("counter must not change when disabled",
            1, prefs.getInt(WatchdogConfig.KEY_FAILURES, -1));
        verify(mockDpm, never()).reboot(org.mockito.ArgumentMatchers.any());
    }

    // ---------------------------------------------------------------
    // Case 5: boot grace skips reboot (even with high failure count)
    // ---------------------------------------------------------------
    @Test
    public void boot_grace_skips_reboot() {
        // Pretend we booted "now" (elapsed_realtime captured 0ms ago).
        long currentElapsed = SystemClock.elapsedRealtime();
        prefs.edit()
            .putLong(WatchdogConfig.KEY_BOOT_ELAPSED_RT, currentElapsed)
            .putInt(WatchdogConfig.KEY_FAILURES, 10)
            .commit();
        fakeProbe.nextResult = false;

        receiver.onReceive(context, new Intent());

        verify(mockDpm, never()).reboot(org.mockito.ArgumentMatchers.any());
    }

    // ---------------------------------------------------------------
    // Case 6: reboot cooldown skips reboot (last_reboot_ts < 30min ago)
    // ---------------------------------------------------------------
    @Test
    public void reboot_cooldown_skips() {
        long tenMinAgoMs = System.currentTimeMillis() - (10L * 60 * 1000);
        prefs.edit()
            .putLong(WatchdogConfig.KEY_LAST_REBOOT_TS, tenMinAgoMs)
            .putInt(WatchdogConfig.KEY_FAILURES, 10)
            .commit();
        fakeProbe.nextResult = false;

        receiver.onReceive(context, new Intent());

        verify(mockDpm, never()).reboot(org.mockito.ArgumentMatchers.any());
    }

    // ---------------------------------------------------------------
    // Case 7: 24h cap — 4 reboots in last 24h → no further reboot
    // ---------------------------------------------------------------
    @Test
    public void cap_24h_skips() {
        long now = System.currentTimeMillis();
        // Build a JSON array with 4 entries, all in the last 24h but >30min ago
        // (so cooldown alone wouldn't block).
        long h2  = now - (2L  * 60 * 60 * 1000);
        long h6  = now - (6L  * 60 * 60 * 1000);
        long h12 = now - (12L * 60 * 60 * 1000);
        long h22 = now - (22L * 60 * 60 * 1000);
        String history = "[" + h22 + "," + h12 + "," + h6 + "," + h2 + "]";

        prefs.edit()
            .putString(WatchdogConfig.KEY_REBOOT_HISTORY, history)
            // last_reboot_ts is 2h ago — past the 30 min cooldown.
            .putLong(WatchdogConfig.KEY_LAST_REBOOT_TS, h2)
            .putInt(WatchdogConfig.KEY_FAILURES, 10)
            .commit();
        fakeProbe.nextResult = false;

        receiver.onReceive(context, new Intent());

        verify(mockDpm, never()).reboot(org.mockito.ArgumentMatchers.any());
    }

    // ---------------------------------------------------------------
    // Helper: read last line of a file
    // ---------------------------------------------------------------
    private static String readLastLine(File f) throws Exception {
        String last = null;
        try (BufferedReader br = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = br.readLine()) != null) {
                if (!line.isEmpty()) last = line;
            }
        }
        return last;
    }
}
