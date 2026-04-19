#!/usr/bin/env bash
# Shared Tailscale FQDN resolver for test scripts and tooling.
# Source this file; it exports ts_fqdn(), PI_FQDN, PI_URL, REGISTRY_URL.
#
# Usage:
#   REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
#   source "$REPO_ROOT/scripts/lib/tailscale.sh"
#   # Now use $PI_URL, $REGISTRY_URL, or call ts_fqdn <hostname>

# Cache: hostname -> FQDN (avoid repeated tailscale calls)
declare -A _TS_FQDN_CACHE 2>/dev/null || true

# Resolve a Tailscale short hostname to its FQDN.
# Falls back to the short hostname if tailscale is unavailable.
ts_fqdn() {
    local hostname="${1:?Usage: ts_fqdn <hostname>}"

    # Return cached value if available
    if [[ -n "${_TS_FQDN_CACHE[$hostname]:-}" ]]; then
        echo "${_TS_FQDN_CACHE[$hostname]}"
        return
    fi

    local fqdn
    fqdn=$(tailscale status --json 2>/dev/null \
        | jq -r --arg name "$hostname" \
            '.Peer[] | select(.HostName == $name) | .DNSName | rtrimstr(".")' \
        2>/dev/null) || true

    if [[ -z "$fqdn" ]]; then
        fqdn="$hostname"
    fi

    _TS_FQDN_CACHE[$hostname]="$fqdn"
    echo "$fqdn"
}

# Pre-resolve common hosts
PI_FQDN=$(ts_fqdn "otacon-pi")
PI_URL="https://${PI_FQDN}:8080"
REGISTRY_URL="http://${PI_FQDN}:9080"

export PI_FQDN PI_URL REGISTRY_URL
