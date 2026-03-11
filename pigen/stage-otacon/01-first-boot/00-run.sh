#!/bin/bash
# Pi-gen stage: set up first-boot service to pull Docker images.
# This can't run in the chroot (Docker needs a running kernel),
# so we create a systemd oneshot that runs on first boot.
set -e

cat > "${ROOTFS_DIR}/etc/systemd/system/otacon-first-boot.service" << 'EOF'
[Unit]
Description=Otacon first boot — pull Docker images
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

REGISTRY="${OTACON_REGISTRY:-ghcr.io/thisnick/otacon}"

echo "Otacon: pulling Docker images..."
docker pull "${REGISTRY}/phone-mirror:latest" || true
docker pull "${REGISTRY}/gnirehtet:latest" || true

# Clone the repo for future updates
if [ ! -d /home/nick/code/otacon ]; then
    sudo -u nick mkdir -p /home/nick/code
    sudo -u nick git clone https://github.com/thisnick/otacon.git /home/nick/code/otacon
fi

mkdir -p /var/lib/otacon
touch /var/lib/otacon/.first-boot-done
echo "Otacon: first boot setup complete"
SCRIPT

chmod +x "${ROOTFS_DIR}/usr/local/bin/otacon-first-boot.sh"

on_chroot << 'CHEOF'
systemctl enable otacon-first-boot.service
CHEOF
