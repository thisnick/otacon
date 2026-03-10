#!/bin/bash
set -e

on_chroot << 'CHEOF'
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable tailscaled
CHEOF
