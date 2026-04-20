#!/usr/bin/env bash
# Shared helpers for Phase 1 registry API restructure tests.
# Source this file from each test script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$REPO_ROOT/scripts/lib/tailscale.sh"

# After admin merger, everything runs on a single port.
REGISTRY_FQDN=$(ts_fqdn "otacon-registry")
REGISTRY_URL="${OTACON_REGISTRY_URL:-http://${REGISTRY_FQDN}:9080}"
ADMIN_TOKEN="${OTACON_ADMIN_TOKEN:-}"

export REGISTRY_URL ADMIN_TOKEN

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}  [PASS]${NC} $1"
}

fail() {
    echo -e "${RED}  [FAIL]${NC} $1 -- $2"
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

# HTTP helpers that return status code + body
# Usage: result=$(http_post URL BODY [TOKEN])
#   echo "$result" | head -1  # status code
#   echo "$result" | tail -n +2  # body
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

http_put() {
    local url="$1" body="$2" token="${3:-}"
    local tmpfile
    tmpfile=$(mktemp)
    local status
    if [ -n "$token" ]; then
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X PUT -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $token" \
            -d "$body" "$url" 2>/dev/null) || status="000"
    else
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X PUT -H 'Content-Type: application/json' \
            -d "$body" "$url" 2>/dev/null) || status="000"
    fi
    echo "$status"
    cat "$tmpfile"
    rm -f "$tmpfile"
}

http_delete() {
    local url="$1" token="${2:-}"
    local tmpfile
    tmpfile=$(mktemp)
    local status
    if [ -n "$token" ]; then
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X DELETE -H "Authorization: Bearer $token" \
            "$url" 2>/dev/null) || status="000"
    else
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X DELETE "$url" 2>/dev/null) || status="000"
    fi
    echo "$status"
    cat "$tmpfile"
    rm -f "$tmpfile"
}

http_patch() {
    local url="$1" body="$2" token="${3:-}"
    local tmpfile
    tmpfile=$(mktemp)
    local status
    if [ -n "$token" ]; then
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X PATCH -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $token" \
            -d "$body" "$url" 2>/dev/null) || status="000"
    else
        status=$(curl -s -o "$tmpfile" -w '%{http_code}' \
            -X PATCH -H 'Content-Type: application/json' \
            -d "$body" "$url" 2>/dev/null) || status="000"
    fi
    echo "$status"
    cat "$tmpfile"
    rm -f "$tmpfile"
}

# Extract first line (status code) from http_* output
get_status() {
    printf '%s\n' "$1" | head -1 || true
}

# Extract body (everything after first line) from http_* output
get_body() {
    printf '%s\n' "$1" | tail -n +2 || true
}

# Generate a unique test host_id
test_host_id() {
    echo "test-host-$(date +%s)-$$"
}

# ---- New-path registration helpers ----

# Register a test host via new path, sets PENDING_ID
register_test_host() {
    local host_id="$1"
    local result
    result=$(http_post "$REGISTRY_URL/api/v1/hosts/register" \
        "{\"host_id\": \"$host_id\"}")
    local status
    status=$(get_status "$result")
    local body
    body=$(get_body "$result")

    if [ "$status" != "200" ] && [ "$status" != "201" ]; then
        echo "Host registration failed: status=$status body=$body" >&2
        return 1
    fi
    PENDING_ID=$(echo "$body" | jq -r '.pending_id // .id')
    if [ -z "$PENDING_ID" ] || [ "$PENDING_ID" = "null" ]; then
        echo "No pending_id in response: $body" >&2
        return 1
    fi
    echo "$PENDING_ID"
}

# Register a test client via new path, sets PENDING_ID
register_test_client() {
    local client_id="${1:-test-client-$(date +%s)-$$}"
    local result
    result=$(http_post "$REGISTRY_URL/api/v1/clients/register" \
        "{\"client_id\": \"$client_id\"}")
    local status
    status=$(get_status "$result")
    local body
    body=$(get_body "$result")

    if [ "$status" != "200" ] && [ "$status" != "201" ]; then
        echo "Client registration failed: status=$status body=$body" >&2
        return 1
    fi
    PENDING_ID=$(echo "$body" | jq -r '.pending_id // .id')
    if [ -z "$PENDING_ID" ] || [ "$PENDING_ID" = "null" ]; then
        echo "No pending_id in response: $body" >&2
        return 1
    fi
    echo "$PENDING_ID"
}

# Approve a host registration via new admin path
approve_host() {
    local pending_id="$1"
    local result
    result=$(http_post "$REGISTRY_URL/api/v1/admin/hosts/$pending_id/approve" \
        '{}' "$ADMIN_TOKEN")
    local status
    status=$(get_status "$result")
    local body
    body=$(get_body "$result")

    if [ "$status" != "200" ] && [ "$status" != "201" ]; then
        echo "Host approval failed: status=$status body=$body" >&2
        return 1
    fi
    echo "$body" | jq -r '.token // empty'
}

# Approve a client registration via new admin path
approve_client() {
    local pending_id="$1"
    local result
    result=$(http_post "$REGISTRY_URL/api/v1/admin/clients/$pending_id/approve" \
        '{}' "$ADMIN_TOKEN")
    local status
    status=$(get_status "$result")
    local body
    body=$(get_body "$result")

    if [ "$status" != "200" ] && [ "$status" != "201" ]; then
        echo "Client approval failed: status=$status body=$body" >&2
        return 1
    fi
    echo "$body" | jq -r '.token // empty'
}

# Full host registration flow: register -> poll (bg) -> approve -> get token
# Sets: NODE_TOKEN
get_node_token() {
    local host_id="$1"
    PENDING_ID=$(register_test_host "$host_id")
    if [ $? -ne 0 ]; then
        return 1
    fi

    local poll_tmpfile poll_status_file
    poll_tmpfile=$(mktemp)
    poll_status_file=$(mktemp)
    (
        local st
        st=$(curl -s -o "$poll_tmpfile" -w '%{http_code}' \
            -X POST --max-time 30 \
            "$REGISTRY_URL/api/v1/hosts/poll/$PENDING_ID" 2>/dev/null) || st="000"
        echo "$st" > "$poll_status_file"
    ) &
    local poll_pid=$!
    sleep 2

    approve_host "$PENDING_ID" >/dev/null
    wait $poll_pid 2>/dev/null || true

    local poll_body
    poll_body=$(cat "$poll_tmpfile" 2>/dev/null)
    rm -f "$poll_tmpfile" "$poll_status_file"

    NODE_TOKEN=$(echo "$poll_body" | jq -r '.token // empty')
    if [ -z "$NODE_TOKEN" ]; then
        return 1
    fi
    return 0
}

# Full client registration flow: register -> poll (bg) -> approve -> get token
# Sets: ADMIN_CLIENT_TOKEN
get_client_token() {
    local client_id="${1:-test-client-$(date +%s)-$$}"
    PENDING_ID=$(register_test_client "$client_id")
    if [ $? -ne 0 ]; then
        return 1
    fi

    local poll_tmpfile poll_status_file
    poll_tmpfile=$(mktemp)
    poll_status_file=$(mktemp)
    (
        local st
        st=$(curl -s -o "$poll_tmpfile" -w '%{http_code}' \
            -X POST --max-time 30 \
            "$REGISTRY_URL/api/v1/clients/poll/$PENDING_ID" 2>/dev/null) || st="000"
        echo "$st" > "$poll_status_file"
    ) &
    local poll_pid=$!
    sleep 2

    approve_client "$PENDING_ID" >/dev/null
    wait $poll_pid 2>/dev/null || true

    local poll_body
    poll_body=$(cat "$poll_tmpfile" 2>/dev/null)
    rm -f "$poll_tmpfile" "$poll_status_file"

    ADMIN_CLIENT_TOKEN=$(echo "$poll_body" | jq -r '.token // empty')
    if [ -z "$ADMIN_CLIENT_TOKEN" ]; then
        return 1
    fi
    return 0
}

# Find the token_id for a raw token by querying admin list tokens
find_token_id() {
    local raw_token="$1"
    local prefix="${raw_token:0:12}"
    local result
    result=$(http_get "$REGISTRY_URL/api/v1/admin/tokens" "$ADMIN_TOKEN")
    local status
    status=$(get_status "$result")
    if [ "$status" != "200" ]; then
        echo "" >&2
        return 1
    fi
    local body
    body=$(get_body "$result")
    echo "$body" | jq -r --arg pfx "$prefix" \
        '.[] | select(.token_prefix == $pfx) | .id' | head -1
}

# Revoke a token by its token_id
revoke_token() {
    local tid="$1"
    http_post "$REGISTRY_URL/api/v1/admin/tokens/$tid/revoke" '{}' "$ADMIN_TOKEN" >/dev/null 2>&1
}

# Set up test result tracking
TEST_FAILED=false

finish_test() {
    local test_name="$1"
    echo ""
    if [ "$TEST_FAILED" = "true" ]; then
        echo -e "${RED}=== $test_name: FAILED ===${NC}"
        exit 1
    else
        echo -e "${GREEN}=== $test_name: PASSED ===${NC}"
        exit 0
    fi
}
