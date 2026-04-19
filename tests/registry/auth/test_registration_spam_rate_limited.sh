#!/usr/bin/env bash
# Test 10: Registration spam / rate limiting
# Fire 100 registration requests in 10 seconds, check if rate limiting kicks in

source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"
check_deps

echo "=== Test: registration spam rate limiting ==="

echo ""
echo "--- Firing 100 registration requests in rapid succession ---"

STATUSES_FILE=$(mktemp)
PIDS=()

for i in $(seq 1 100); do
    (
        RESULT=$(http_post "$REGISTRY_URL/api/v1/auth/register" \
            "{\"host_id\": \"spam-test-node-$i\"}")
        STATUS=$(get_status "$RESULT")
        echo "$STATUS" >> "$STATUSES_FILE"
    ) &
    PIDS+=($!)

    # Stagger slightly to avoid shell fork limits
    if [ $((i % 20)) -eq 0 ]; then
        sleep 0.5
    fi
done

# Wait for all requests to complete
for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
done

# Analyze responses
TOTAL=$(wc -l < "$STATUSES_FILE")
OK_COUNT=$(grep -c '^20[01]$' "$STATUSES_FILE" || echo 0)
RATE_LIMITED=$(grep -c '^429$' "$STATUSES_FILE" || echo 0)
OTHER=$(grep -v '^20[01]$' "$STATUSES_FILE" | grep -v '^429$' | sort | uniq -c | sort -rn || echo "none")

echo ""
echo "  Total requests: $TOTAL"
echo "  200/201 (accepted): $OK_COUNT"
echo "  429 (rate limited): $RATE_LIMITED"
echo "  Other: $OTHER"

if [ "$RATE_LIMITED" -gt 0 ]; then
    pass "Rate limiting active: $RATE_LIMITED/100 requests were rate-limited (429)"
else
    observe "No rate limiting observed: all $OK_COUNT requests were accepted. Rate limiting may not be implemented."
fi

rm -f "$STATUSES_FILE"

# Cleanup: reject all pending registrations if possible
if [ -n "$ADMIN_TOKEN" ]; then
    echo ""
    echo "--- Cleanup: rejecting spam registrations ---"
    REGS=$(http_get "$ADMIN_URL/api/v1/auth/registrations/pending" "$ADMIN_TOKEN")
    REG_STATUS=$(get_status "$REGS")
    if [ "$REG_STATUS" = "200" ]; then
        REG_BODY=$(get_body "$REGS")
        PENDING_IDS=$(echo "$REG_BODY" | jq -r '.[] | select(.host_id | startswith("spam-test-node-")) | .id // .pending_id' 2>/dev/null || echo "")
        CLEANED=0
        for pid in $PENDING_IDS; do
            http_post "$ADMIN_URL/api/v1/auth/registrations/$pid/reject" '{}' "$ADMIN_TOKEN" >/dev/null 2>&1 || true
            CLEANED=$((CLEANED + 1))
        done
        echo "  Cleaned up $CLEANED spam registrations"
    fi
fi

finish_test "test_registration_spam_rate_limited"
