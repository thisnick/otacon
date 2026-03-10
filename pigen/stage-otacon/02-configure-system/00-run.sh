#!/bin/bash
set -e

# Install ADB and system packages
on_chroot << 'CHEOF'
apt-get update
apt-get install -y android-sdk-platform-tools git curl jq
CHEOF

# udev rules for Android USB devices
cat > "${ROOTFS_DIR}/etc/udev/rules.d/51-android.rules" << 'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="04e8", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666", GROUP="plugdev"
EOF

on_chroot << 'CHEOF'
usermod -aG plugdev "${FIRST_USER_NAME}"
CHEOF
