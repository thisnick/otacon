package com.otacon.kiosk;

import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * Regression test for the NetworkOnMainThreadException seen in production.
 *
 * The receiver does HttpURLConnection I/O. BroadcastReceiver.onReceive runs on
 * the main thread, where Android forbids network I/O. This test mocks the
 * probe to record which thread it runs on and asserts it isn't the main thread.
 */
@RunWith(RobolectricTestRunner.class)
public class WatchdogReceiverThreadingTest {

    @Before
    public void setUp() {
        WatchdogReceiver.sForceAsync = true;
    }

    @After
    public void tearDown() {
        WatchdogReceiver.sForceAsync = false;
        WatchdogReceiver.sProbeOverride = null;
        WatchdogReceiver.sDpmOverride = null;
    }

    @Test
    public void probe_runs_off_main_thread() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        Thread mainThread = Thread.currentThread();

        AtomicReference<Thread> probeThread = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);

        WatchdogReceiver.sProbeOverride = () -> {
            probeThread.set(Thread.currentThread());
            done.countDown();
            return true;
        };
        WatchdogReceiver.sDpmOverride = mock(DevicePolicyManager.class);

        new WatchdogReceiver().onReceive(context, new Intent());

        assertTrue("probe must run within 5s", done.await(5, TimeUnit.SECONDS));
        Thread probedOn = probeThread.get();
        assertNotEquals("probe must NOT run on the main thread", mainThread, probedOn);
    }
}
