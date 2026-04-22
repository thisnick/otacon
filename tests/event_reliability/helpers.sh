#!/usr/bin/env bash
# Shared helpers for Phase 5 event reliability tests.
# Source this file from each test script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$REPO_ROOT/scripts/lib/tailscale.sh"

REGISTRY_FQDN=$(ts_fqdn "otacon-registry")
REGISTRY_URL="${OTACON_REGISTRY_URL:-http://${REGISTRY_FQDN}:9080}"
ADMIN_TOKEN="${OTACON_ADMIN_TOKEN:-}"
PI_FQDN=$(ts_fqdn "otacon-pi")
PI_HOST="${OTACON_PI_HOST:-${PI_FQDN}}"

export REGISTRY_URL ADMIN_TOKEN PI_HOST

# Known phone local IDs (fleet-agent names on the Pi)
KNOWN_LOCAL_IDS=(phone-r5ct60sd phone-14151jec phone-99241ffa phone-r92x1022 phone-11031jec)

# Expected host_id on the Pi
EXPECTED_HOST_ID="otacon-pi"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}  [PASS]${NC} $1"
    PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
    echo -e "${RED}  [FAIL]${NC} $1 -- $2"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    TEST_FAILED=true
}

observe() {
    echo -e "${YELLOW}  [OBSERVE]${NC} $1"
}

check_deps() {
    for cmd in curl jq; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "ERROR: $cmd not found"
            exit 2
        fi
    done
}

require_admin_token() {
    if [ -z "$ADMIN_TOKEN" ]; then
        echo "ERROR: OTACON_ADMIN_TOKEN not set"
        echo "Set it via: export OTACON_ADMIN_TOKEN=otc_admin_..."
        exit 2
    fi
}

# HTTP helpers (reuse pattern from registry_api tests)
http_get() {
    local url="$1" token="${2:-}"
    local tmpfile
    tmpfile=$(mktemp)
    local status
    if [ -n "$token" ]; then
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -H "Authorization: Bearer $token" \
            "$url" 2>/dev/null) || status="000"
    else
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            "$url" 2>/dev/null) || status="000"
    fi
    echo "$status"
    cat "$tmpfile"
    rm -f "$tmpfile"
}

http_post() {
    local url="$1" body="$2" token="${3:-}"
    local tmpfile
    tmpfile=$(mktemp)
    local status
    if [ -n "$token" ]; then
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X POST -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $token" \
            -d "$body" "$url" 2>/dev/null) || status="000"
    else
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X POST -H 'Content-Type: application/json' \
            -d "$body" "$url" 2>/dev/null) || status="000"
    fi
    echo "$status"
    cat "$tmpfile"
    rm -f "$tmpfile"
}

get_status() {
    printf '%s\n' "$1" | head -1 || true
}

get_body() {
    printf '%s\n' "$1" | tail -n +2 || true
}

# ---- Registry query helpers ----

# Get all phones from registry as JSON array
registry_phones() {
    local result
    result=$(http_get "$REGISTRY_URL/api/v1/admin/phones" "$ADMIN_TOKEN")
    local status
    status=$(get_status "$result")
    if [ "$status" != "200" ]; then
        echo "[]"
        return 1
    fi
    get_body "$result"
}

# Get a single phone's status from registry by registry phone_id
registry_phone_status() {
    local phone_id="$1"
    registry_phones | jq -r --arg id "$phone_id" '.[] | select(.id == $id) | .status'
}

# Get host info
registry_host() {
    local host_id="$1"
    local result
    result=$(http_get "$REGISTRY_URL/api/v1/admin/hosts/$host_id" "$ADMIN_TOKEN")
    local status
    status=$(get_status "$result")
    if [ "$status" != "200" ]; then
        echo "{}"
        return 1
    fi
    get_body "$result"
}

# Count phones with a given status
count_phones_with_status() {
    local target_status="$1"
    registry_phones | jq --arg s "$target_status" '[.[] | select(.status == $s)] | length'
}

# Wait for a condition with timeout
# Usage: wait_for TIMEOUT_SECS DESCRIPTION COMMAND
# COMMAND should return 0 on success
wait_for() {
    local timeout="$1" desc="$2"
    shift 2
    local elapsed=0
    while [ $elapsed -lt "$timeout" ]; do
        if "$@" 2>/dev/null; then
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    return 1
}

# SSH to Pi (non-interactive)
pi_ssh() {
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "root@${PI_HOST}" "$@"
}

# Run docker command on Pi
pi_docker() {
    pi_ssh docker "$@"
}

# Docker volume path for /data/otacon on the host filesystem
OTACON_DATA_VOL="/var/lib/docker/volumes/otacon_otacon-data/_data"
OUTBOX_DB="${OTACON_DATA_VOL}/outbox/events.db"
STATE_DIR="${OTACON_DATA_VOL}/state"

# Host container name
HOST_CONTAINER="otacon-otacon-1"
REGISTRY_CONTAINER="otacon-registry-otacon-registry-1"

# Query outbox DB via host sqlite3 (not inside container)
# Note: uses double quotes for outer SSH command so single quotes in SQL work
pi_outbox_sql() {
    pi_ssh "sqlite3 '${OUTBOX_DB}' \"$1\""
}

# Check if outbox DB exists on Pi (via volume path)
pi_outbox_exists() {
    pi_ssh "test -f '${OUTBOX_DB}' && echo yes || echo no"
}

# Set up test result tracking
PASS_COUNT=0
FAIL_COUNT=0
TEST_FAILED=false

finish_test() {
    local test_name="$1"
    echo ""
    echo "---"
    echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
    if [ "$TEST_FAILED" = "true" ]; then
        echo -e "${RED}=== $test_name: FAILED ===${NC}"
        exit 1
    else
        echo -e "${GREEN}=== $test_name: PASSED ===${NC}"
        exit 0
    fi
}
