#!/bin/bash
set -e
CONF=/boot/firmware/otacon/startup.conf
[ -f "$CONF" ] || exit 0
source "$CONF"

# Join Tailscale
if [ -n "$TS_AUTH_KEY" ]; then
    tailscale up --auth-key="$TS_AUTH_KEY" --ssh \
        --hostname="${TS_HOSTNAME:-$(hostname)}"
fi

# Write Docker .env for first boot (before deploy.sh takes over)
ENV_FILE="/home/nick/otacon/.env"
mkdir -p "$(dirname "$ENV_FILE")"
{
    [ -n "$OTACON_REPO" ] && echo "OTACON_REPO=$OTACON_REPO"
    [ -n "$VNC_PASSWORD" ] && echo "VNC_PASSWORD=$VNC_PASSWORD"
} > "$ENV_FILE"
chown nick:nick "$ENV_FILE"

# Disable traditional SSH if requested
if [ "$TS_DISABLE_SSH" = "true" ]; then
    systemctl disable --now ssh.service
fi

# Securely delete config (contains auth key)
shred -u "$CONF"
