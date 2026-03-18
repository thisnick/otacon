#!/bin/bash
# Renew Tailscale TLS certs
set -e
CERT_DIR=/etc/tailscale/certs

# Get FQDN from tailscale (e.g. otacon-pi.tail0437b8.ts.net)
FQDN=$(tailscale status --self --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[ -z "$FQDN" ] && { echo "Cannot determine Tailscale FQDN"; exit 1; }

# Short name for cert filenames (e.g. otacon-pi)
SHORT=${FQDN%%.*}

mkdir -p "$CERT_DIR"
tailscale cert --cert-file "$CERT_DIR/$SHORT.crt" --key-file "$CERT_DIR/$SHORT.key" "$FQDN"
chmod 644 "$CERT_DIR/$SHORT.crt"
chmod 600 "$CERT_DIR/$SHORT.key"
echo "Certs written to $CERT_DIR/$SHORT.{crt,key} for $FQDN"
