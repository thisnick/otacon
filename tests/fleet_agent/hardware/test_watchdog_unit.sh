#!/usr/bin/env bash
# Hardware test: kiosk watchdog unit tests (Robolectric / JUnit, JVM-only).
#
# Wraps `./gradlew :app:testDebugUnitTest` against the device-owner Android
# project. The variant-specific task accepts --tests filters; the aggregate
# `:app:test` task does not.
# Source files:
#   android/device-owner/app/src/test/java/com/otacon/kiosk/WatchdogReceiverTest.java
#   android/device-owner/app/src/test/java/com/otacon/kiosk/BootRecoveryReceiverTest.java
#
# This is JVM-only — no phone, no Pi required. Runs in CI / local dev.
#
# Usage: ./test_watchdog_unit.sh
# Exit codes:
#   0   tests pass
#   1   tests fail (see Gradle output)
#   2   gradle / build env not available (skipped)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
PROJ="$REPO/android/device-owner"

echo "=== Test: kiosk watchdog unit tests ==="
echo "project: $PROJ"

if [ ! -x "$PROJ/gradlew" ]; then
    echo "SKIP: $PROJ/gradlew not found or not executable"
    exit 2
fi

# JAVA_HOME must be set for gradle. AGP 8.7 supports JDK 17 and 21 but not 24+.
# Try in order: caller's JAVA_HOME, JDK 21 (homebrew typical), JDK 17,
# system default, common homebrew paths.
if [ -z "${JAVA_HOME:-}" ]; then
    for candidate in \
        "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
        "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
        "$(/usr/libexec/java_home -v 21 2>/dev/null || true)" \
        "$(/usr/libexec/java_home -v 17 2>/dev/null || true)"; do
        if [ -n "$candidate" ] && [ -x "$candidate/bin/java" ]; then
            JAVA_HOME="$candidate"
            export JAVA_HOME
            break
        fi
    done
fi

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
    echo "SKIP: no JDK 17 or 21 found; AGP 8.7 does not support JDK 24+"
    exit 2
fi

# ANDROID_HOME / sdk.dir must point at a real SDK install.
if [ -z "${ANDROID_HOME:-}" ]; then
    for candidate in \
        "/opt/homebrew/share/android-commandlinetools" \
        "$HOME/Library/Android/sdk" \
        "/opt/android-sdk"; do
        if [ -d "$candidate/platforms" ] || [ -d "$candidate/cmdline-tools" ]; then
            ANDROID_HOME="$candidate"
            export ANDROID_HOME
            break
        fi
    done
fi

if [ -z "${ANDROID_HOME:-}" ]; then
    echo "SKIP: ANDROID_HOME not set and no SDK auto-detected"
    exit 2
fi
echo "ANDROID_HOME=$ANDROID_HOME"

echo "JAVA_HOME=$JAVA_HOME"

cd "$PROJ"

# Run only the watchdog-related tests for speed. The variant-specific task
# `testDebugUnitTest` accepts --tests; the aggregate `:app:test` does not.
echo ""
echo "--- Running ./gradlew :app:testDebugUnitTest ---"
TEST_FILTERS=(
    "--tests=com.otacon.kiosk.WatchdogReceiverTest"
    "--tests=com.otacon.kiosk.BootRecoveryReceiverTest"
)

# Use --no-daemon to avoid leaving stale gradle daemons lying around in CI.
if ./gradlew :app:testDebugUnitTest "${TEST_FILTERS[@]}" --no-daemon --console=plain; then
    echo ""
    echo "PASS: watchdog unit tests passed"

    # Surface the test report path for the showboat artifact.
    REPORT="$PROJ/app/build/reports/tests/testDebugUnitTest/index.html"
    if [ -f "$REPORT" ]; then
        echo "Report: $REPORT"
    fi

    echo ""
    echo "=== Test: kiosk watchdog unit tests PASSED ==="
    exit 0
else
    rc=$?
    echo ""
    echo "FAIL: gradle test exited with $rc"
    REPORT="$PROJ/app/build/reports/tests/testDebugUnitTest/index.html"
    if [ -f "$REPORT" ]; then
        echo "See report: $REPORT"
    fi
    exit 1
fi
