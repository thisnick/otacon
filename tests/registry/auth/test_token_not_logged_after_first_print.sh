#!/usr/bin/env bash
# Test 11: Bootstrap admin token not visible in logs after first print
# After initial bootstrap, token should be truncated/hashed in any subsequent log output

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: token not logged after first print ==="

PI_HOST="nick@otacon-pi"
# Find the admin container
CONTAINER=$(ssh "$PI_HOST" "docker ps --format '{{.Names}}' | grep -i admin | head -1" 2>/dev/null || echo "")
if [ -z "$CONTAINER" ]; then
    CONTAINER=$(ssh "$PI_HOST" "docker ps --format '{{.Names}}' | grep 'otacon-admin' | head -1" 2>/dev/null || echo "")
fi
if [ -z "$CONTAINER" ]; then
    fail "find_container" "Cannot find admin container on Pi"
    finish_test "test_token_not_logged_after_first_print"
fi

# The ADMIN_TOKEN we have should NOT appear in plaintext in subsequent logs
# (only the initial bootstrap print is acceptable)

echo ""
echo "--- Checking container logs for plaintext token ---"

# Get recent logs (excluding first 10 lines which might be the bootstrap output)
ALL_LOGS=$(ssh "$PI_HOST" "docker logs $CONTAINER 2>&1" 2>/dev/null || echo "")
LINE_COUNT=$(echo "$ALL_LOGS" | wc -l | tr -d ' ')

if [ "$LINE_COUNT" -le 10 ]; then
    observe "Only $LINE_COUNT lines of logs -- too few to test post-bootstrap behavior"
    finish_test "test_token_not_logged_after_first_print"
fi

# Filter out the bootstrap announcement box (which legitimately contains the token).
# The box uses Unicode box-drawing chars (║, ╔, ╗, ╚, ╝) and keywords like BOOTSTRAP.
NON_BOOTSTRAP=$(echo "$ALL_LOGS" | grep -v "BOOTSTRAP" | grep -v "bootstrap" | grep -v '║' | grep -v '╔' | grep -v '╚')
TOKEN_APPEARANCES=$(echo "$NON_BOOTSTRAP" | grep -c "$ADMIN_TOKEN" 2>/dev/null || true)
TOKEN_APPEARANCES=${TOKEN_APPEARANCES:-0}

if [ "$TOKEN_APPEARANCES" -eq 0 ]; then
    pass "Admin token not found in non-bootstrap log lines"
else
    fail "token_in_logs" "Found $TOKEN_APPEARANCES occurrence(s) of plaintext admin token in non-bootstrap logs"
    echo "  Lines containing token:"
    echo "$NON_BOOTSTRAP" | grep "$ADMIN_TOKEN" | head -5 | sed 's/^/    /'
fi

# Also check: do any logs contain the raw hex portion of token hashes?
# The server should store SHA-256 hashes, not raw tokens
echo ""
echo "--- Checking for token prefix patterns in operational logs ---"
# Extract the hex part after otc_admin_ or otc_node_
TOKEN_HEX="${ADMIN_TOKEN#otc_admin_}"
if [ -n "$TOKEN_HEX" ] && [ ${#TOKEN_HEX} -ge 16 ]; then
    # Search for first 16 chars of hex in logs
    PARTIAL="${TOKEN_HEX:0:16}"
    PARTIAL_HITS=$(echo "$NON_BOOTSTRAP" | grep -c "$PARTIAL" 2>/dev/null || true)
    PARTIAL_HITS=${PARTIAL_HITS:-0}
    if [ "$PARTIAL_HITS" -eq 0 ]; then
        pass "No partial token hex found in operational logs"
    else
        observe "Found $PARTIAL_HITS occurrences of partial token hex in logs (first 16 chars)"
    fi
fi

finish_test "test_token_not_logged_after_first_print"
