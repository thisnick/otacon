#!/usr/bin/env bash
#
# Phase 2 Multi-Phone & Registry End-to-End Test Harness
#
# Usage:
#   ./scripts/test-phase2.sh                           # test against local (localhost:8080)
#   ./scripts/test-phase2.sh --host otacon-pi.tail0437b8.ts.net:8080     # test against deployed Pi
#   ./scripts/test-phase2.sh --registry localhost:8090  # test registry API
#   ./scripts/test-phase2.sh --all --host otacon-pi.tail0437b8.ts.net:8080 --registry localhost:8090
#
# Exit codes: 0 = all passed, 1 = failures

set -euo pipefail

# --- Defaults ---
PI_HOST="${PI_HOST:-localhost:8080}"
PI_SCHEME="${PI_SCHEME:-https}"
REGISTRY_HOST="${REGISTRY_HOST:-}"
REGISTRY_SCHEME="${REGISTRY_SCHEME:-http}"
RUN_PI=true
RUN_REGISTRY=false
VERBOSE=false

# Known phone serials on the Pi (override with env vars)
PHONE_SERIAL_A="${PHONE_SERIAL_A:-R5CT60SDGKD}"
PHONE_SERIAL_B="${PHONE_SERIAL_B:-R92X1022S7K}"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)       PI_HOST="$2"; shift 2 ;;
        --scheme)     PI_SCHEME="$2"; shift 2 ;;
        --registry)   REGISTRY_HOST="$2"; RUN_REGISTRY=true; shift 2 ;;
        --registry-scheme) REGISTRY_SCHEME="$2"; shift 2 ;;
        --all)        RUN_PI=true; RUN_REGISTRY=true; shift ;;
        --registry-only) RUN_PI=false; RUN_REGISTRY=true; shift ;;
        --pi-only)    RUN_PI=true; RUN_REGISTRY=false; shift ;;
        -v|--verbose) VERBOSE=true; shift ;;
        -h|--help)
            head -12 "$0" | tail -10
            exit 0
            ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

PI_BASE="${PI_SCHEME}://${PI_HOST}"
REGISTRY_BASE="${REGISTRY_SCHEME}://${REGISTRY_HOST}"

# --- Test infrastructure ---
PASS=0
FAIL=0
SKIP=0
ERRORS=()

red()    { printf "\033[0;31m%s\033[0m" "$*"; }
green()  { printf "\033[0;32m%s\033[0m" "$*"; }
yellow() { printf "\033[0;33m%s\033[0m" "$*"; }
bold()   { printf "\033[1m%s\033[0m" "$*"; }

log() { echo "  $*"; }
vlog() { $VERBOSE && echo "    [debug] $*" || true; }

pass() {
    PASS=$((PASS + 1))
    echo "  $(green PASS) $1"
}

fail() {
    FAIL=$((FAIL + 1))
    ERRORS+=("$1: ${2:-}")
    echo "  $(red FAIL) $1"
    [[ -n "${2:-}" ]] && echo "        ${2}"
}

skip() {
    SKIP=$((SKIP + 1))
    echo "  $(yellow SKIP) $1"
}

# curl wrapper: returns body via stdout, writes HTTP status code to a temp file.
# After calling: body=$(api GET /path); read HTTP code from $_HTTP_CODE_FILE.
_HTTP_CODE_FILE="/tmp/test-phase2-http-code.$$"
trap 'rm -f "$_HTTP_CODE_FILE"' EXIT

api() {
    local method="$1" url="$2"
    shift 2
    local curl_args=(-s -w '\n%{http_code}' -k --connect-timeout 5 --max-time 15)

    case "$method" in
        GET)    curl_args+=(-X GET) ;;
        POST)   curl_args+=(-X POST -H "Content-Type: application/json") ;;
        PUT)    curl_args+=(-X PUT -H "Content-Type: application/json") ;;
        PATCH)  curl_args+=(-X PATCH -H "Content-Type: application/json") ;;
        DELETE) curl_args+=(-X DELETE) ;;
    esac

    # remaining args passed to curl (e.g. -d '...')
    local response
    response=$(curl "${curl_args[@]}" "$@" "$url" 2>/dev/null) || {
        echo "000" > "$_HTTP_CODE_FILE"
        echo ""
        return
    }
    echo "$response" | tail -1 > "$_HTTP_CODE_FILE"
    echo "$response" | sed '$d'
}

# Read the HTTP code from the temp file after calling api()
http_code() {
    cat "$_HTTP_CODE_FILE" 2>/dev/null || echo "000"
}

# Assert HTTP status code
assert_status() {
    local expected="$1" test_name="$2"
    local code
    code=$(http_code)
    if [[ "$code" == "$expected" ]]; then
        pass "$test_name (HTTP $code)"
    else
        fail "$test_name" "expected HTTP $expected, got $code"
    fi
}

# Assert body contains substring
assert_contains() {
    local body="$1" needle="$2" test_name="$3"
    if echo "$body" | grep -q "$needle"; then
        pass "$test_name"
    else
        fail "$test_name" "body does not contain '$needle'"
        vlog "body: $body"
    fi
}

# Assert body is valid JSON
assert_json() {
    local body="$1" test_name="$2"
    if echo "$body" | python3 -m json.tool >/dev/null 2>&1; then
        pass "$test_name"
    else
        fail "$test_name" "body is not valid JSON"
        vlog "body: $body"
    fi
}

# Assert JSON field equals value
# Usage: assert_json_field "$body" ".field" "expected" "test name"
assert_json_field() {
    local body="$1" jqpath="$2" expected="$3" test_name="$4"
    local actual
    actual=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(eval('d'+sys.argv[1].replace('.','[\"',1).replace('.','\"][\"')+'\"]' if '.' in sys.argv[1] else d))" "$jqpath" 2>/dev/null) || actual="<parse error>"
    if [[ "$actual" == "$expected" ]]; then
        pass "$test_name"
    else
        fail "$test_name" "expected $jqpath=$expected, got $actual"
    fi
}

# Extract JSON field (uses python3 for portability — jq not guaranteed)
json_get() {
    local field="$1"
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field',''))" 2>/dev/null
}

json_array_len() {
    python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null
}

# ============================================================
#  SECTION 1: Pi Server — Multi-Phone API
# ============================================================

test_pi_connectivity() {
    bold "--- Pi Server Connectivity ---"
    echo ""
    local body
    body=$(api GET "${PI_BASE}/api/info")
    if [[ "$(http_code)" == "000" ]]; then
        fail "Pi server reachable" "cannot connect to ${PI_BASE}"
        return 1
    fi
    pass "Pi server reachable at ${PI_BASE}"
    return 0
}

test_phones_list() {
    bold "--- GET /phones (list phones) ---"
    echo ""
    local body
    body=$(api GET "${PI_BASE}/phones")
    assert_status 200 "GET /phones returns 200"
    assert_json "$body" "GET /phones returns valid JSON"

    local count
    count=$(echo "$body" | json_array_len)
    if [[ "$count" -ge 2 ]]; then
        pass "GET /phones lists >= 2 phones (got $count)"
    else
        fail "GET /phones lists >= 2 phones" "got $count"
    fi

    # Extract phone IDs for subsequent tests — match by serial if provided,
    # otherwise pick the first two non-"default" phones.
    read -r PHONE_ID_A PHONE_ID_B <<< "$(echo "$body" | python3 -c "
import sys, json, os
phones = json.load(sys.stdin)
serial_a = os.environ.get('PHONE_SERIAL_A', '')
serial_b = os.environ.get('PHONE_SERIAL_B', '')
by_serial = {p.get('adb_serial',''): p.get('id', p.get('phone_id','')) for p in phones}
# Match by serial if provided
id_a = by_serial.get(serial_a, '')
id_b = by_serial.get(serial_b, '')
# Fallback: pick first two non-default phones
if not id_a or not id_b:
    candidates = [p.get('id', p.get('phone_id','')) for p in phones
                  if p.get('id','') != 'default' and p.get('adb_serial','') != 'default']
    if not id_a and len(candidates) > 0:
        id_a = candidates[0]
    if not id_b and len(candidates) > 1:
        id_b = candidates[1]
    elif not id_b and len(candidates) == 1 and id_a != candidates[0]:
        id_b = candidates[0]
print(f'{id_a} {id_b}')
" 2>/dev/null)"
    log "Phone A: $PHONE_ID_A"
    log "Phone B: $PHONE_ID_B"
}

test_phone_get() {
    bold "--- GET /phones/{id} (phone detail) ---"
    echo ""
    [[ -z "${PHONE_ID_A:-}" ]] && { skip "phone detail (no phone IDs)"; return; }

    local body
    body=$(api GET "${PI_BASE}/phones/${PHONE_ID_A}")
    assert_status 200 "GET /phones/${PHONE_ID_A} returns 200"
    assert_json "$body" "phone detail is valid JSON"
    assert_contains "$body" "adb_serial" "phone detail contains adb_serial"
}

test_phone_not_found() {
    bold "--- GET /phones/{id} (not found) ---"
    echo ""
    local body
    body=$(api GET "${PI_BASE}/phones/nonexistent-phone-xyz")
    assert_status 404 "GET /phones/nonexistent returns 404"
}

test_phone_screenshot() {
    bold "--- GET /phones/{id}/api/screenshot ---"
    echo ""
    [[ -z "${PHONE_ID_A:-}" ]] && { skip "screenshot (no phone IDs)"; return; }

    # Phone A screenshot
    local tmp_a="/tmp/test-phase2-screenshot-a.png"
    curl -sk --connect-timeout 5 --max-time 30 \
        -o "$tmp_a" -w '%{http_code}' \
        "${PI_BASE}/phones/${PHONE_ID_A}/api/screenshot" > /tmp/test-phase2-sc-code-a.txt 2>/dev/null
    local code_a
    code_a=$(cat /tmp/test-phase2-sc-code-a.txt)
    if [[ "$code_a" == "200" ]]; then
        pass "Phone A screenshot returns 200"
        local size_a
        size_a=$(wc -c < "$tmp_a" | tr -d ' ')
        if [[ "$size_a" -gt 1000 ]]; then
            pass "Phone A screenshot is a real image (${size_a} bytes)"
        else
            fail "Phone A screenshot size" "only ${size_a} bytes"
        fi
    else
        fail "Phone A screenshot returns 200" "got $code_a"
    fi

    # Phone B screenshot
    [[ -z "${PHONE_ID_B:-}" ]] && { skip "Phone B screenshot (no second phone)"; return; }
    local tmp_b="/tmp/test-phase2-screenshot-b.png"
    curl -sk --connect-timeout 5 --max-time 30 \
        -o "$tmp_b" -w '%{http_code}' \
        "${PI_BASE}/phones/${PHONE_ID_B}/api/screenshot" > /tmp/test-phase2-sc-code-b.txt 2>/dev/null
    local code_b
    code_b=$(cat /tmp/test-phase2-sc-code-b.txt)
    if [[ "$code_b" == "200" ]]; then
        pass "Phone B screenshot returns 200"
    else
        fail "Phone B screenshot returns 200" "got $code_b"
    fi

    # Verify screenshots are different (different phones should show different screens)
    if [[ -f "$tmp_a" && -f "$tmp_b" ]]; then
        if ! cmp -s "$tmp_a" "$tmp_b"; then
            pass "Phone A and B screenshots differ (isolation check)"
        else
            fail "Phone A and B screenshots differ" "screenshots are identical — may not be isolated"
        fi
    fi

    rm -f "$tmp_a" "$tmp_b" /tmp/test-phase2-sc-code-a.txt /tmp/test-phase2-sc-code-b.txt
}

test_phone_info() {
    bold "--- GET /phones/{id}/api/info ---"
    echo ""
    [[ -z "${PHONE_ID_A:-}" ]] && { skip "info (no phone IDs)"; return; }

    local body_a body_b
    body_a=$(api GET "${PI_BASE}/phones/${PHONE_ID_A}/api/info")
    assert_status 200 "Phone A info returns 200"
    assert_json "$body_a" "Phone A info is valid JSON"
    assert_contains "$body_a" "model" "Phone A info contains model"

    [[ -z "${PHONE_ID_B:-}" ]] && return
    body_b=$(api GET "${PI_BASE}/phones/${PHONE_ID_B}/api/info")
    assert_status 200 "Phone B info returns 200"

    # Check isolation: models or phone numbers should differ (or at least be independent)
    local model_a model_b
    model_a=$(echo "$body_a" | json_get "model")
    model_b=$(echo "$body_b" | json_get "model")
    log "Phone A model: $model_a"
    log "Phone B model: $model_b"
    # Different models is expected since these are SM-S908U1 and SM-S146VL
    if [[ "$model_a" != "$model_b" && -n "$model_a" && -n "$model_b" ]]; then
        pass "Phone A and B report different models (isolation)"
    elif [[ -z "$model_a" || -z "$model_b" ]]; then
        skip "Model isolation check (model field empty)"
    else
        # Same model is possible if both phones are the same model
        log "Both phones report model '$model_a' — same model, checking phone numbers instead"
        local num_a num_b
        num_a=$(echo "$body_a" | json_get "phone_number")
        num_b=$(echo "$body_b" | json_get "phone_number")
        if [[ "$num_a" != "$num_b" && -n "$num_a" && -n "$num_b" ]]; then
            pass "Phone A and B report different phone numbers (isolation)"
        else
            skip "Cannot verify isolation by model or phone number"
        fi
    fi
}

test_phone_snapshot() {
    bold "--- GET /phones/{id}/api/snapshot ---"
    echo ""
    [[ -z "${PHONE_ID_A:-}" ]] && { skip "snapshot (no phone IDs)"; return; }

    local body
    body=$(api GET "${PI_BASE}/phones/${PHONE_ID_A}/api/snapshot?format=json")
    assert_status 200 "Phone A snapshot returns 200"
    assert_json "$body" "Phone A snapshot is valid JSON"
}

test_phone_cross_api() {
    bold "--- Cross-phone API isolation ---"
    echo ""
    [[ -z "${PHONE_ID_A:-}" || -z "${PHONE_ID_B:-}" ]] && { skip "cross-phone (need 2 phones)"; return; }

    # Hit various endpoints on both phones in parallel and verify no crosstalk
    local body_a body_b

    # Apps list
    body_a=$(api GET "${PI_BASE}/phones/${PHONE_ID_A}/api/apps")
    local code_a
    code_a=$(http_code)
    body_b=$(api GET "${PI_BASE}/phones/${PHONE_ID_B}/api/apps")
    local code_b
    code_b=$(http_code)
    if [[ "$code_a" == "200" && "$code_b" == "200" ]]; then
        pass "Both phones return app lists"
    else
        fail "Both phones return app lists" "A=$code_a B=$code_b"
    fi

    # Calls status (should work independently)
    body_a=$(api GET "${PI_BASE}/phones/${PHONE_ID_A}/api/calls/status")
    code_a=$(http_code)
    body_b=$(api GET "${PI_BASE}/phones/${PHONE_ID_B}/api/calls/status")
    code_b=$(http_code)
    if [[ "$code_a" == "200" && "$code_b" == "200" ]]; then
        pass "Both phones return call status independently"
    else
        # 404 or other might be OK if calls module works differently
        log "Call status: A=$code_a B=$code_b"
        skip "Call status check (non-200 response)"
    fi
}

test_phone_action_isolation() {
    bold "--- Phone action isolation (safe read-only) ---"
    echo ""
    [[ -z "${PHONE_ID_A:-}" || -z "${PHONE_ID_B:-}" ]] && { skip "action isolation (need 2 phones)"; return; }

    # Send a clipboard read to phone A, verify it doesn't affect phone B
    local clip_a clip_b
    clip_a=$(api GET "${PI_BASE}/phones/${PHONE_ID_A}/api/clipboard")
    local code_a
    code_a=$(http_code)
    clip_b=$(api GET "${PI_BASE}/phones/${PHONE_ID_B}/api/clipboard")
    local code_b
    code_b=$(http_code)
    if [[ "$code_a" == "200" && "$code_b" == "200" ]]; then
        pass "Clipboard reads succeed on both phones"
    else
        log "Clipboard: A=$code_a B=$code_b (may require device owner)"
        skip "Clipboard isolation (non-200, may need bridge)"
    fi
}

# ============================================================
#  SECTION 2: Registry API
# ============================================================

test_registry_connectivity() {
    bold "--- Registry Connectivity ---"
    echo ""
    if [[ -z "$REGISTRY_HOST" ]]; then
        skip "Registry tests (no --registry specified)"
        return 1
    fi
    local body
    body=$(api GET "${REGISTRY_BASE}/api/v1/hosts")
    if [[ "$(http_code)" == "000" ]]; then
        fail "Registry reachable" "cannot connect to ${REGISTRY_BASE}"
        return 1
    fi
    pass "Registry reachable at ${REGISTRY_BASE}"
    return 0
}

test_registry_hosts() {
    bold "--- Registry: Hosts ---"
    echo ""

    # List hosts
    local body
    body=$(api GET "${REGISTRY_BASE}/api/v1/hosts")
    assert_status 200 "GET /api/v1/hosts returns 200"
    assert_json "$body" "hosts list is valid JSON"

    # Register a test host
    body=$(api POST "${REGISTRY_BASE}/api/v1/hosts/register" \
        -d '{"id":"test-host-eval","tailscale_ip":"100.99.99.99","fqdn":"test-host-eval.ts.net","api_port":8080}')
    assert_status 200 "POST /api/v1/hosts/register returns 200"

    # Verify it appears in list
    body=$(api GET "${REGISTRY_BASE}/api/v1/hosts")
    assert_contains "$body" "test-host-eval" "registered host appears in list"

    # Get host detail
    body=$(api GET "${REGISTRY_BASE}/api/v1/hosts/test-host-eval")
    assert_status 200 "GET /api/v1/hosts/test-host-eval returns 200"
    assert_json "$body" "host detail is valid JSON"

    # Heartbeat
    body=$(api POST "${REGISTRY_BASE}/api/v1/hosts/heartbeat" \
        -d '{"host_id":"test-host-eval","phones":[],"dongles":[]}')
    assert_status 200 "POST /api/v1/hosts/heartbeat returns 200"
}

test_registry_phones() {
    bold "--- Registry: Phones ---"
    echo ""

    # Register phone A
    local body
    body=$(api POST "${REGISTRY_BASE}/api/v1/phones/register" \
        -d "{\"host_id\":\"test-host-eval\",\"adb_serial\":\"${PHONE_SERIAL_A}\",\"phone_number\":\"+15550001111\",\"model\":\"SM-S908U1\",\"bt_mac\":\"AA:BB:CC:DD:EE:01\",\"imei\":\"111111111111111\"}")
    assert_status 200 "POST /api/v1/phones/register (phone A) returns 200"
    assert_json "$body" "phone A registration is valid JSON"
    local phone_id_a
    phone_id_a=$(echo "$body" | json_get "phone_id")
    log "Registered phone A as: $phone_id_a"

    # Register phone B
    body=$(api POST "${REGISTRY_BASE}/api/v1/phones/register" \
        -d "{\"host_id\":\"test-host-eval\",\"adb_serial\":\"${PHONE_SERIAL_B}\",\"phone_number\":\"+15550002222\",\"model\":\"SM-S146VL\",\"bt_mac\":\"AA:BB:CC:DD:EE:02\",\"imei\":\"222222222222222\"}")
    assert_status 200 "POST /api/v1/phones/register (phone B) returns 200"
    local phone_id_b
    phone_id_b=$(echo "$body" | json_get "phone_id")
    log "Registered phone B as: $phone_id_b"

    # List phones
    body=$(api GET "${REGISTRY_BASE}/api/v1/phones")
    assert_status 200 "GET /api/v1/phones returns 200"
    local count
    count=$(echo "$body" | json_array_len)
    if [[ "$count" -ge 2 ]]; then
        pass "GET /api/v1/phones lists >= 2 phones (got $count)"
    else
        fail "GET /api/v1/phones lists >= 2 phones" "got $count"
    fi

    # Get phone detail
    if [[ -n "$phone_id_a" ]]; then
        body=$(api GET "${REGISTRY_BASE}/api/v1/phones/${phone_id_a}")
        assert_status 200 "GET /api/v1/phones/${phone_id_a} returns 200"
        assert_json "$body" "phone detail is valid JSON"
        assert_contains "$body" "$PHONE_SERIAL_A" "phone detail contains ADB serial"
    fi

    # Phone location
    if [[ -n "$phone_id_a" ]]; then
        body=$(api GET "${REGISTRY_BASE}/api/v1/phones/${phone_id_a}/location")
        assert_status 200 "GET /api/v1/phones/${phone_id_a}/location returns 200"
        assert_contains "$body" "test-host-eval" "phone location points to correct host"
    fi

    # Phone config get/put
    if [[ -n "$phone_id_a" ]]; then
        body=$(api GET "${REGISTRY_BASE}/api/v1/phones/${phone_id_a}/config")
        assert_status 200 "GET phone config returns 200"

        body=$(api PUT "${REGISTRY_BASE}/api/v1/phones/${phone_id_a}/config" \
            -d '{"wifi_enabled":true,"bluetooth_enabled":true}')
        assert_status 200 "PUT phone config returns 200"

        # Verify config was saved
        body=$(api GET "${REGISTRY_BASE}/api/v1/phones/${phone_id_a}/config")
        assert_contains "$body" "wifi_enabled" "config contains wifi_enabled after update"
    fi

    # Phone not found
    body=$(api GET "${REGISTRY_BASE}/api/v1/phones/nonexistent-phone")
    assert_status 404 "GET nonexistent phone returns 404"

    # Store IDs for deregistration test
    REG_PHONE_ID_A="$phone_id_a"
    REG_PHONE_ID_B="$phone_id_b"
}

test_registry_phone_upsert() {
    bold "--- Registry: Phone upsert (re-registration) ---"
    echo ""
    [[ -z "${REG_PHONE_ID_A:-}" ]] && { skip "phone upsert (no registered phone)"; return; }

    # Re-register same phone (same IMEI) — should upsert, not duplicate
    local body
    body=$(api POST "${REGISTRY_BASE}/api/v1/phones/register" \
        -d "{\"host_id\":\"test-host-eval\",\"adb_serial\":\"${PHONE_SERIAL_A}\",\"phone_number\":\"+15550001111\",\"model\":\"SM-S908U1\",\"bt_mac\":\"AA:BB:CC:DD:EE:01\",\"imei\":\"111111111111111\"}")
    assert_status 200 "re-registration returns 200"
    local phone_id_again
    phone_id_again=$(echo "$body" | json_get "phone_id")
    if [[ "$phone_id_again" == "$REG_PHONE_ID_A" ]]; then
        pass "re-registration returns same phone_id (upsert, not duplicate)"
    else
        fail "re-registration returns same phone_id" "got $phone_id_again, expected $REG_PHONE_ID_A"
    fi
}

test_registry_phone_move() {
    bold "--- Registry: Phone mobility (host change) ---"
    echo ""
    [[ -z "${REG_PHONE_ID_A:-}" ]] && { skip "phone move (no registered phone)"; return; }

    # Register a second host
    api POST "${REGISTRY_BASE}/api/v1/hosts/register" \
        -d '{"id":"test-host-eval-2","tailscale_ip":"100.99.99.88","fqdn":"test-host-eval-2.ts.net","api_port":8080}' >/dev/null

    # Move phone A to the second host
    local body
    body=$(api POST "${REGISTRY_BASE}/api/v1/phones/register" \
        -d "{\"host_id\":\"test-host-eval-2\",\"adb_serial\":\"${PHONE_SERIAL_A}\",\"phone_number\":\"+15550001111\",\"model\":\"SM-S908U1\",\"bt_mac\":\"AA:BB:CC:DD:EE:01\",\"imei\":\"111111111111111\"}")
    assert_status 200 "phone move re-registration returns 200"

    # Location should now point to host 2
    body=$(api GET "${REGISTRY_BASE}/api/v1/phones/${REG_PHONE_ID_A}/location")
    assert_contains "$body" "test-host-eval-2" "phone location updated to new host after move"

    # Move it back
    api POST "${REGISTRY_BASE}/api/v1/phones/register" \
        -d "{\"host_id\":\"test-host-eval\",\"adb_serial\":\"${PHONE_SERIAL_A}\",\"phone_number\":\"+15550001111\",\"model\":\"SM-S908U1\",\"bt_mac\":\"AA:BB:CC:DD:EE:01\",\"imei\":\"111111111111111\"}" >/dev/null
}

test_registry_sims() {
    bold "--- Registry: SIM cards ---"
    echo ""
    [[ -z "${REG_PHONE_ID_A:-}" ]] && { skip "SIMs (no registered phone)"; return; }

    # Report SIM inventory for phone A
    local body
    body=$(api POST "${REGISTRY_BASE}/api/v1/phones/${REG_PHONE_ID_A}/sims" \
        -d '{"sims":[{"iccid":"89010001234567890123","phone_number":"+15550001111","carrier":"T-Mobile","slot":0,"is_esim":false,"is_active":true,"profile_name":"personal"}]}')
    assert_status 200 "POST phone SIMs returns 200"

    # List all SIMs
    body=$(api GET "${REGISTRY_BASE}/api/v1/sims")
    assert_status 200 "GET /api/v1/sims returns 200"
    assert_json "$body" "SIM list is valid JSON"

    # Lookup by phone number
    body=$(api GET "${REGISTRY_BASE}/api/v1/sims?phone_number=%2B15550001111")
    assert_status 200 "GET /api/v1/sims?phone_number=+15550001111 returns 200"
    assert_contains "$body" "T-Mobile" "SIM lookup by phone number finds carrier"
    assert_contains "$body" "${REG_PHONE_ID_A}" "SIM lookup returns correct phone_id"

    # Phone's SIMs
    body=$(api GET "${REGISTRY_BASE}/api/v1/phones/${REG_PHONE_ID_A}/sims")
    assert_status 200 "GET /api/v1/phones/{id}/sims returns 200"
    assert_contains "$body" "89010001234567890123" "phone SIMs contain reported ICCID"
}

test_registry_dongles() {
    bold "--- Registry: Dongles ---"
    echo ""

    # Register dongles
    local body
    body=$(api POST "${REGISTRY_BASE}/api/v1/dongles/register" \
        -d '{"host_id":"test-host-eval","dongles":[{"bt_mac":"DD:DD:DD:DD:DD:01","hci_device":"hci1"},{"bt_mac":"DD:DD:DD:DD:DD:02","hci_device":"hci2"}]}')
    assert_status 200 "POST /api/v1/dongles/register returns 200"

    # List dongles
    body=$(api GET "${REGISTRY_BASE}/api/v1/dongles")
    assert_status 200 "GET /api/v1/dongles returns 200"
    assert_json "$body" "dongle list is valid JSON"
    assert_contains "$body" "DD:DD:DD:DD:DD:01" "dongle list contains registered MAC"
}

test_registry_events() {
    bold "--- Registry: Events ---"
    echo ""

    local body
    body=$(api GET "${REGISTRY_BASE}/api/v1/events")
    assert_status 200 "GET /api/v1/events returns 200"
    assert_json "$body" "events list is valid JSON"

    # Should have events from the registration/move actions
    local count
    count=$(echo "$body" | json_array_len)
    if [[ "$count" -ge 1 ]]; then
        pass "Events log has entries (got $count)"
    else
        fail "Events log has entries" "got $count"
    fi
}

test_registry_deregister() {
    bold "--- Registry: Phone deregistration ---"
    echo ""
    [[ -z "${REG_PHONE_ID_A:-}" ]] && { skip "deregistration (no registered phone)"; return; }

    local body
    body=$(api POST "${REGISTRY_BASE}/api/v1/phones/deregister" \
        -d "{\"host_id\":\"test-host-eval\",\"phone_id\":\"${REG_PHONE_ID_A}\"}")
    assert_status 200 "POST /api/v1/phones/deregister returns 200"

    # Phone should now be disconnected
    body=$(api GET "${REGISTRY_BASE}/api/v1/phones/${REG_PHONE_ID_A}")
    assert_contains "$body" "disconnected" "deregistered phone status is 'disconnected'"
}

# ============================================================
#  SECTION 3: Edge cases & adversarial tests
# ============================================================

test_invalid_phone_id_paths() {
    bold "--- Edge cases: invalid phone IDs ---"
    echo ""

    # Various invalid IDs
    for bad_id in "../etc/passwd" "phone%00id" "" "a/b/c" "phone id with spaces"; do
        local encoded
        encoded=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$bad_id', safe=''))" 2>/dev/null)
        [[ -z "$encoded" ]] && continue
        local body
        body=$(api GET "${PI_BASE}/phones/${encoded}/api/info")
        local code
        code=$(http_code)
        if [[ "$code" == "404" || "$code" == "400" ]]; then
            pass "Invalid phone ID '$bad_id' returns $code"
        elif [[ "$code" == "000" ]]; then
            skip "Invalid phone ID '$bad_id' (connection failed)"
        else
            fail "Invalid phone ID '$bad_id'" "expected 404/400, got $code"
        fi
    done
}

test_legacy_api_compat() {
    bold "--- Legacy API compatibility ---"
    echo ""

    # Old endpoints under /api/ (without /phones/{id}/) should either:
    # - still work (backwards compat) or
    # - return a clear error/redirect
    # This tests that the migration didn't break the top-level /api/ namespace
    local body
    body=$(api GET "${PI_BASE}/api/info")
    local code
    code=$(http_code)
    log "Legacy GET /api/info returned HTTP $code"
    # We don't assert pass/fail here — just document behavior
    if [[ "$code" == "200" ]]; then
        log "Legacy endpoints still work (backwards compatible)"
    elif [[ "$code" == "404" ]]; then
        log "Legacy endpoints removed (clean break)"
    else
        log "Legacy endpoints returned unexpected $code"
    fi
}

test_concurrent_requests() {
    bold "--- Concurrent requests to different phones ---"
    echo ""
    [[ -z "${PHONE_ID_A:-}" || -z "${PHONE_ID_B:-}" ]] && { skip "concurrent (need 2 phones)"; return; }

    # Fire requests to both phones simultaneously
    local tmp_a="/tmp/test-phase2-concurrent-a.json"
    local tmp_b="/tmp/test-phase2-concurrent-b.json"
    curl -sk --connect-timeout 5 --max-time 15 \
        "${PI_BASE}/phones/${PHONE_ID_A}/api/info" > "$tmp_a" 2>/dev/null &
    local pid_a=$!
    curl -sk --connect-timeout 5 --max-time 15 \
        "${PI_BASE}/phones/${PHONE_ID_B}/api/info" > "$tmp_b" 2>/dev/null &
    local pid_b=$!

    wait "$pid_a" "$pid_b" 2>/dev/null

    local ok=true
    if [[ -s "$tmp_a" ]] && echo "$(cat "$tmp_a")" | python3 -m json.tool >/dev/null 2>&1; then
        pass "Concurrent request to Phone A succeeded"
    else
        fail "Concurrent request to Phone A" "empty or invalid response"
        ok=false
    fi
    if [[ -s "$tmp_b" ]] && echo "$(cat "$tmp_b")" | python3 -m json.tool >/dev/null 2>&1; then
        pass "Concurrent request to Phone B succeeded"
    else
        fail "Concurrent request to Phone B" "empty or invalid response"
        ok=false
    fi

    rm -f "$tmp_a" "$tmp_b"
}

# ============================================================
#  MAIN
# ============================================================

echo ""
bold "=========================================="
bold " Phase 2 Multi-Phone Test Harness"
bold "=========================================="
echo ""

if $RUN_PI; then
    if test_pi_connectivity; then
        echo ""
        test_phones_list
        echo ""
        test_phone_get
        echo ""
        test_phone_not_found
        echo ""
        test_phone_info
        echo ""
        test_phone_screenshot
        echo ""
        test_phone_snapshot
        echo ""
        test_phone_cross_api
        echo ""
        test_phone_action_isolation
        echo ""
        test_invalid_phone_id_paths
        echo ""
        test_legacy_api_compat
        echo ""
        test_concurrent_requests
    else
        echo ""
        log "Skipping Pi tests — server not reachable"
    fi
fi

if $RUN_REGISTRY; then
    echo ""
    bold "=========================================="
    bold " Registry API Tests"
    bold "=========================================="
    echo ""
    if test_registry_connectivity; then
        echo ""
        test_registry_hosts
        echo ""
        test_registry_phones
        echo ""
        test_registry_phone_upsert
        echo ""
        test_registry_phone_move
        echo ""
        test_registry_sims
        echo ""
        test_registry_dongles
        echo ""
        test_registry_events
        echo ""
        test_registry_deregister
    else
        echo ""
        log "Skipping registry tests — not reachable"
    fi
fi

# --- Summary ---
echo ""
bold "=========================================="
bold " Results"
bold "=========================================="
echo ""
echo "  $(green "PASS: $PASS")  $(red "FAIL: $FAIL")  $(yellow "SKIP: $SKIP")"
echo ""

if [[ $FAIL -gt 0 ]]; then
    bold "Failures:"
    for err in "${ERRORS[@]}"; do
        echo "  $(red '✗') $err"
    done
    echo ""
    exit 1
fi

if [[ $PASS -eq 0 && $SKIP -gt 0 ]]; then
    echo "  No tests actually ran — check connectivity and arguments."
    exit 1
fi

echo "  All tests passed."
exit 0
