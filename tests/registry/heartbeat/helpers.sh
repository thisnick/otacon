#!/usr/bin/env bash
# Shared helpers for heartbeat test scripts.
# Source this file from each test script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

source "$REPO_ROOT/scripts/lib/tailscale.sh"

# Admin API for querying hosts/phones
ADMIN_TOKEN="${OTACON_ADMIN_TOKEN:-}"

export ADMIN_URL ADMIN_TOKEN

# Pi SSH target for docker commands
PI_SSH="${PI_SSH:-otacon-pi}"

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
    for cmd in curl jq ssh; do
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

# Get the current last_heartbeat timestamp from registry
get_heartbeat_ts() {
    curl -sS "$ADMIN_URL/api/v1/hosts" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
    | jq -r '.[0].last_heartbeat // "null"'
}

# Get all phone statuses as JSON array: [{"id":"phone-1","status":"connected"}, ...]
get_phone_statuses() {
    curl -sS "$ADMIN_URL/api/v1/phones" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
    | jq '[.[] | {id: .id, status: .status}]'
}

# Get count of phones with a given status
count_phones_with_status() {
    local target_status="$1"
    curl -sS "$ADMIN_URL/api/v1/phones" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
    | jq --arg s "$target_status" '[.[] | select(.status == $s)] | length'
}

# Get total phone count
get_phone_count() {
    curl -sS "$ADMIN_URL/api/v1/phones" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
    | jq 'length'
}

# Convert ISO timestamp to epoch seconds (portable)
ts_to_epoch() {
    local ts="$1"
    python3 -c "
from datetime import datetime, timezone
ts = '$ts'.replace('Z', '+00:00')
if '.' in ts:
    # Truncate nanoseconds to microseconds for Python
    parts = ts.split('.')
    frac = parts[1].split('+')[0].split('Z')[0]
    tz = '+' + parts[1].split('+')[1] if '+' in parts[1] else ''
    frac = frac[:6]
    ts = parts[0] + '.' + frac + tz
dt = datetime.fromisoformat(ts)
print(int(dt.timestamp()))
"
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
