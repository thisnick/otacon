#!/bin/bash
# Pre-pull Docker images so first boot is fast.
# This runs inside the pi-gen build, so we need to start dockerd in the chroot.
set -e

# Note: pre-pulling inside pi-gen chroot is tricky because dockerd needs
# kernel features. For now, we set up a systemd service that pulls on first boot.

cat > "${ROOTFS_DIR}/etc/systemd/system/otacon-first-boot.service" << 'EOF'
[Unit]
Description=Otacon first boot setup
After=docker.service network-online.target
Wants=network-online.target
ConditionPathExists=!/var/lib/otacon/.first-boot-done

[Service]
Type=oneshot
ExecStart=/usr/local/bin/otacon-first-boot.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat > "${ROOTFS_DIR}/usr/local/bin/otacon-first-boot.sh" << 'SCRIPT'
#!/bin/bash
set -e

REGISTRY="${OTACON_REGISTRY:-ghcr.io/YOUR_USER/otacon}"

echo "Otacon: pulling Docker images..."
docker pull "${REGISTRY}/phone-mirror:latest" || true
docker pull "${REGISTRY}/gnirehtet:latest" || true

mkdir -p /var/lib/otacon
touch /var/lib/otacon/.first-boot-done
echo "Otacon: first boot setup complete"
SCRIPT

chmod +x "${ROOTFS_DIR}/usr/local/bin/otacon-first-boot.sh"

on_chroot << 'CHEOF'
systemctl enable otacon-first-boot.service
CHEOF
