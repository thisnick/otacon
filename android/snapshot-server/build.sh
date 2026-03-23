#!/bin/bash
# Build snapshot-server.jar for use with app_process on Android.
# Requires ANDROID_HOME to be set with platform SDK available.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
ANDROID_JAR="${ANDROID_HOME}/platforms/android-34/android.jar"

if [ ! -f "$ANDROID_JAR" ]; then
    echo "ERROR: android.jar not found at $ANDROID_JAR"
    echo "Set ANDROID_HOME and ensure android-34 platform is installed"
    exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/classes"

echo "Compiling..."
javac -source 17 -target 17 \
    -cp "$ANDROID_JAR" \
    -d "$BUILD_DIR/classes" \
    "$SCRIPT_DIR/src/com/otacon/snapshot/SnapshotServer.java"

echo "Creating DEX jar..."
# Use d8 to convert to DEX format (required for app_process)
"${ANDROID_HOME}/build-tools/34.0.0/d8" \
    --output "$BUILD_DIR" \
    "$BUILD_DIR/classes/com/otacon/snapshot/SnapshotServer.class"

# d8 produces classes.dex, package it into a jar
cd "$BUILD_DIR"
jar cf snapshot-server.jar classes.dex

echo "Built: $BUILD_DIR/snapshot-server.jar"
