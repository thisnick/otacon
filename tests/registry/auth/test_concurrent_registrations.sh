#!/usr/bin/env bash
# Test 14: Concurrent registrations
# Fire 5 register calls in parallel, approve all, verify each gets unique token

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps
require_admin_token

echo "=== Test: concurrent registrations ==="

NUM_NODES=5
TMPDIR=$(mktemp -d)

# Step 1: Register all nodes in parallel
echo ""
echo "--- Registering $NUM_NODES nodes in parallel ---"
PIDS=()
for i in $(seq 1 $NUM_NODES); do
    (
        HOST_ID="concurrent-test-node-$i-$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
        RESULT=$(http_post "$REGISTRY_URL/api/v1/auth/register" \
            "{\"host_id\": \"$HOST_ID\"}")
        STATUS=$(get_status "$RESULT")
        BODY=$(get_body "$RESULT")
        PENDING_ID=$(echo "$BODY" | jq -r '.pending_id // .id // empty')
        echo "$HOST_ID|$PENDING_ID|$STATUS" > "$TMPDIR/reg_$i.txt"
    ) &
    PIDS+=($!)
done

for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
done

# Check all registered successfully
ALL_REGISTERED=true
for i in $(seq 1 $NUM_NODES); do
    LINE=$(cat "$TMPDIR/reg_$i.txt" 2>/dev/null || echo "||000")
    STATUS=$(echo "$LINE" | cut -d'|' -f3)
    PENDING_ID=$(echo "$LINE" | cut -d'|' -f2)
    if [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then
        fail "register_$i" "status=$STATUS"
        ALL_REGISTERED=false
    fi
    if [ -z "$PENDING_ID" ] || [ "$PENDING_ID" = "null" ]; then
        fail "register_$i" "no pending_id"
        ALL_REGISTERED=false
    fi
done

if [ "$ALL_REGISTERED" = "true" ]; then
    pass "All $NUM_NODES nodes registered"
else
    fail "registration" "Not all nodes registered"
    rm -rf "$TMPDIR"
    finish_test "test_concurrent_registrations"
fi

# Step 2: Start polls for all in parallel
echo ""
echo "--- Starting polls for all $NUM_NODES nodes ---"
PIDS=()
for i in $(seq 1 $NUM_NODES); do
    (
        LINE=$(cat "$TMPDIR/reg_$i.txt")
        PENDING_ID=$(echo "$LINE" | cut -d'|' -f2)
        TMPFILE="$TMPDIR/poll_$i.json"
        status=$(curl -s -o "$TMPFILE" -w '%{http_code}' \
            -X POST --max-time 30 \
            "$REGISTRY_URL/api/v1/auth/poll/$PENDING_ID" 2>/dev/null) || status="000"
        echo "$status" > "$TMPDIR/poll_status_$i.txt"
    ) &
    PIDS+=($!)
done

sleep 2

# Step 3: Approve all
echo ""
echo "--- Approving all $NUM_NODES registrations ---"
for i in $(seq 1 $NUM_NODES); do
    LINE=$(cat "$TMPDIR/reg_$i.txt")
    PENDING_ID=$(echo "$LINE" | cut -d'|' -f2)
    http_post "$ADMIN_URL/api/v1/auth/registrations/$PENDING_ID/approve" \
        '{}' "$ADMIN_TOKEN" >/dev/null 2>&1
done

# Wait for all polls to complete
for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
done

# Step 4: Collect and verify tokens
echo ""
echo "--- Verifying tokens ---"
TOKENS=()
ALL_TOKENS_OK=true
for i in $(seq 1 $NUM_NODES); do
    POLL_STATUS=$(cat "$TMPDIR/poll_status_$i.txt" 2>/dev/null || echo "000")
    POLL_BODY=$(cat "$TMPDIR/poll_$i.json" 2>/dev/null || echo "{}")
    TOKEN=$(echo "$POLL_BODY" | jq -r '.token // empty')

    if [ "$POLL_STATUS" = "200" ] && [ -n "$TOKEN" ]; then
        TOKENS+=("$TOKEN")
    else
        fail "poll_$i" "status=$POLL_STATUS token=$TOKEN"
        ALL_TOKENS_OK=false
    fi
done

if [ "$ALL_TOKENS_OK" = "true" ]; then
    pass "All $NUM_NODES nodes received tokens"
else
    fail "tokens" "Not all nodes received tokens"
fi

# Check uniqueness
echo ""
echo "--- Checking token uniqueness ---"
UNIQUE_COUNT=$(printf '%s\n' "${TOKENS[@]}" | sort -u | wc -l | tr -d ' ')
if [ "$UNIQUE_COUNT" -eq "$NUM_NODES" ]; then
    pass "All $NUM_NODES tokens are unique"
else
    fail "uniqueness" "Only $UNIQUE_COUNT unique tokens out of $NUM_NODES"
fi

# Cleanup
echo ""
echo "--- Cleanup ---"
for i in $(seq 1 $NUM_NODES); do
    POLL_BODY=$(cat "$TMPDIR/poll_$i.json" 2>/dev/null || echo "{}")
    TOKEN_ID=$(echo "$POLL_BODY" | jq -r '.token_id // .id // empty')
    TOKEN=$(echo "$POLL_BODY" | jq -r '.token // empty')
    if [ -n "$TOKEN" ]; then
        TID=$(find_token_id "$TOKEN" 2>/dev/null || echo "")
        if [ -n "$TID" ] && [ "$TID" != "null" ]; then
            http_post "$ADMIN_URL/api/v1/auth/tokens/$TID/revoke" '{}' "$ADMIN_TOKEN" >/dev/null 2>&1 || true
        fi
    fi
done
rm -rf "$TMPDIR"

finish_test "test_concurrent_registrations"
