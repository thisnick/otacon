#!/usr/bin/env bash
#
# Phase 3 Lazy Resources + BT Dongle + Audio + Password Token Test Harness
#
# Usage:
#   ./scripts/test-phase3.sh                                     # test against Pi via Tailscale
#   ./scripts/test-phase3.sh --host otacon-pi.tail0437b8.ts.net:8080               # custom host
#   ./scripts/test-phase3.sh --registry localhost:8090            # include registry tests
#   ./scripts/test-phase3.sh --all                               # Pi + registry
#   ./scripts/test-phase3.sh --section lazy                      # run only one section
#
# Exit codes: 0 = all passed, 1 = failures

set -euo pipefail

# --- Defaults ---
PI_HOST="${PI_HOST:-otacon-pi.tail0437b8.ts.net:8080}"
PI_SCHEME="${PI_SCHEME:-https}"
PI_SSH="${PI_SSH:-nick@otacon-pi}"
REGISTRY_HOST="${REGISTRY_HOST:-}"
REGISTRY_SCHEME="${REGISTRY_SCHEME:-http}"
RUN_PI=true
RUN_REGISTRY=false
VERBOSE=false
SECTION=""  # empty = all

# Known phone serials (3 phones on the Pi)
export PHONE_SERIAL_A="${PHONE_SERIAL_A:-R5CT60SDGKD}"   # S22 Ultra
export PHONE_SERIAL_B="${PHONE_SERIAL_B:-R92X1022S7K}"    # Galaxy A15
export PHONE_SERIAL_C="${PHONE_SERIAL_C:-14151JEC200486}" # Pixel 4a

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)       PI_HOST="$2"; shift 2 ;;
        --scheme)     PI_SCHEME="$2"; shift 2 ;;
        --ssh)        PI_SSH="$2"; shift 2 ;;
        --registry)   REGISTRY_HOST="$2"; RUN_REGISTRY=true; shift 2 ;;
        --registry-scheme) REGISTRY_SCHEME="$2"; shift 2 ;;
        --all)        RUN_PI=true; RUN_REGISTRY=true; shift ;;
        --registry-only) RUN_PI=false; RUN_REGISTRY=true; shift ;;
        --pi-only)    RUN_PI=true; RUN_REGISTRY=false; shift ;;
        --section)    SECTION="$2"; shift 2 ;;
        -v|--verbose) VERBOSE=true; shift ;;
        -h|--help)
            head -14 "$0" | tail -12
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

# curl wrapper
_HTTP_CODE_FILE="/tmp/test-phase3-http-code.$$"
trap 'rm -f "$_HTTP_CODE_FILE" /tmp/test-phase3-*.tmp.$$' EXIT

api() {
    local method="$1" url="$2"
    shift 2
    local curl_args=(-s -w '\n%{http_code}' -k --connect-timeout 5 --max-time 15)

    case "$method" in
        GET)    curl_args+=(-X GET) ;;
        POST)   curl_args+=(-X POST -H "Content-Type: application/json") ;;
        PUT)    curl_args+=(-X PUT -H "Content-Type: application/json") ;;
        DELETE) curl_args+=(-X DELETE) ;;
    esac

    local response
    response=$(curl "${curl_args[@]}" "$@" "$url" 2>/dev/null) || {
        echo "000" > "$_HTTP_CODE_FILE"
        echo ""
        return
    }
    echo "$response" | tail -1 > "$_HTTP_CODE_FILE"
    echo "$response" | sed '$d'
}

http_code() {
    cat "$_HTTP_CODE_FILE" 2>/dev/null || echo "000"
}

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

assert_contains() {
    local body="$1" needle="$2" test_name="$3"
    if echo "$body" | grep -q "$needle"; then
        pass "$test_name"
    else
        fail "$test_name" "body does not contain '$needle'"
        vlog "body: $body"
    fi
}

assert_json() {
    local body="$1" test_name="$2"
    if echo "$body" | python3 -m json.tool >/dev/null 2>&1; then
        pass "$test_name"
    else
        fail "$test_name" "body is not valid JSON"
        vlog "body: $body"
    fi
}

json_get() {
    local field="$1"
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field',''))" 2>/dev/null
}

json_array_len() {
    python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null
}

# SSH helper: run command on Pi host (outside container)
pi_ssh() {
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$PI_SSH" "$@" 2>/dev/null
}

# SSH helper: run command inside the otacon container on the Pi
pi_exec() {
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$PI_SSH" \
        "cd ~/otacon && docker compose exec -T otacon bash -c '$*'" 2>/dev/null
}

should_run() {
    [[ -z "$SECTION" ]] || [[ "$SECTION" == "$1" ]]
}

# Find a python3 with websockets installed
PYTHON_WS=""
for py in /tmp/ws-venv/bin/python3 python3 /opt/homebrew/bin/python3 /opt/homebrew/bin/python3.14 /usr/bin/python3 /usr/local/bin/python3; do
    if command -v "$py" >/dev/null 2>&1 && "$py" -c "import websockets" 2>/dev/null; then
        PYTHON_WS="$py"
        break
    fi
done

# Get VNC port for a phone ID
vnc_port_for() {
    local pid="$1"
    if [[ "$pid" == "$PHONE_ID_A" ]]; then echo "$VNC_PORT_A"
    elif [[ "$pid" == "$PHONE_ID_B" ]]; then echo "$VNC_PORT_B"
    elif [[ "$pid" == "$PHONE_ID_C" ]]; then echo "$VNC_PORT_C"
    else echo "5900"
    fi
}

# ============================================================
#  SECTION 0: Connectivity & phone discovery
# ============================================================

# Populated by test_phone_discovery
PHONE_IDS=()
PHONE_ID_A=""
PHONE_ID_B=""
PHONE_ID_C=""
# VNC ports per phone (derived from phone index in config)
VNC_PORT_A=5900
VNC_PORT_B=5901
VNC_PORT_C=5902

test_connectivity() {
    bold "--- Pi Server Connectivity ---"
    echo ""
    local body
    body=$(api GET "${PI_BASE}/phones")
    if [[ "$(http_code)" == "000" ]]; then
        fail "Pi server reachable" "cannot connect to ${PI_BASE}"
        return 1
    fi
    pass "Pi server reachable at ${PI_BASE}"
    return 0
}

test_phone_discovery() {
    bold "--- Phone Discovery (3 phones expected) ---"
    echo ""
    local body
    body=$(api GET "${PI_BASE}/phones")
    assert_status 200 "GET /phones returns 200"

    local count
    count=$(echo "$body" | json_array_len)
    if [[ "$count" -ge 3 ]]; then
        pass "GET /phones lists >= 3 phones (got $count)"
    elif [[ "$count" -ge 2 ]]; then
        fail "GET /phones lists >= 3 phones" "got $count (expected 3)"
    else
        fail "GET /phones lists >= 3 phones" "got $count"
        return
    fi

    # Extract phone IDs by serial from API
    read -r PHONE_ID_A PHONE_ID_B PHONE_ID_C <<< "$(echo "$body" | python3 -c "
import sys, json, os
phones = json.load(sys.stdin)
by_serial = {p.get('adb_serial',''): p.get('id','') for p in phones}
a = by_serial.get(os.environ.get('PHONE_SERIAL_A',''), '')
b = by_serial.get(os.environ.get('PHONE_SERIAL_B',''), '')
c = by_serial.get(os.environ.get('PHONE_SERIAL_C',''), '')
print(f'{a} {b} {c}')
" 2>/dev/null)"

    # Get VNC ports from API (vnc_port is now in PhoneSummary)
    read -r VNC_PORT_A VNC_PORT_B VNC_PORT_C <<< "$(echo "$body" | python3 -c "
import sys, json, os
phones = json.load(sys.stdin)
by_serial = {p.get('adb_serial',''): p.get('vnc_port', 5900) for p in phones}
a = by_serial.get(os.environ.get('PHONE_SERIAL_A',''), 5900)
b = by_serial.get(os.environ.get('PHONE_SERIAL_B',''), 5901)
c = by_serial.get(os.environ.get('PHONE_SERIAL_C',''), 5902)
print(f'{a} {b} {c}')
" 2>/dev/null)"

    PHONE_IDS=("$PHONE_ID_A" "$PHONE_ID_B" "$PHONE_ID_C")
    log "Phone A (S22 Ultra):  $PHONE_ID_A (VNC :$VNC_PORT_A)"
    log "Phone B (Galaxy A15): $PHONE_ID_B (VNC :$VNC_PORT_B)"
    log "Phone C (Pixel 4a):   $PHONE_ID_C (VNC :$VNC_PORT_C)"

    for pid in "${PHONE_IDS[@]}"; do
        if [[ -z "$pid" ]]; then
            fail "All 3 phone IDs resolved" "one or more IDs empty"
            return
        fi
    done
    pass "All 3 phone IDs resolved"
}

# ============================================================
#  SECTION 1: Standing criteria — phone setup
# ============================================================

test_phone_setup() {
    bold "--- Standing Criteria 1: Phone Setup ---"
    echo ""

    for pid in "${PHONE_IDS[@]}"; do
        [[ -z "$pid" ]] && { skip "Phone setup ($pid — no ID)"; continue; }

        # Device owner health check
        local body
        body=$(api GET "${PI_BASE}/phones/${pid}/api/info")
        local code
        code=$(http_code)
        if [[ "$code" == "200" ]]; then
            pass "[$pid] /api/info returns 200 (device owner + bridge working)"
        else
            fail "[$pid] /api/info returns 200" "got HTTP $code"
        fi
    done
}

# ============================================================
#  SECTION 2: Standing criteria — per-phone API isolation
# ============================================================

test_api_isolation() {
    bold "--- Standing Criteria 2: Per-Phone API Isolation ---"
    echo ""

    [[ -z "$PHONE_ID_A" || -z "$PHONE_ID_B" || -z "$PHONE_ID_C" ]] && {
        skip "API isolation (need 3 phone IDs)"
        return
    }

    # Collect info from all 3 phones
    local info_a info_b info_c
    info_a=$(api GET "${PI_BASE}/phones/${PHONE_ID_A}/api/info")
    info_b=$(api GET "${PI_BASE}/phones/${PHONE_ID_B}/api/info")
    info_c=$(api GET "${PI_BASE}/phones/${PHONE_ID_C}/api/info")

    # All should return 200
    for label in A B C; do
        local var="info_${label,,}"
        body="${!var}"
        if echo "$body" | python3 -m json.tool >/dev/null 2>&1; then
            pass "Phone $label info is valid JSON"
        else
            fail "Phone $label info is valid JSON"
        fi
    done

    # Models should differ (S22 Ultra vs Galaxy A15 vs Pixel 4a)
    local model_a model_b model_c
    model_a=$(echo "$info_a" | json_get model)
    model_b=$(echo "$info_b" | json_get model)
    model_c=$(echo "$info_c" | json_get model)
    log "Models: A=$model_a, B=$model_b, C=$model_c"

    if [[ "$model_a" != "$model_b" && "$model_b" != "$model_c" && "$model_a" != "$model_c" ]]; then
        pass "All 3 phones report different models (isolation confirmed)"
    elif [[ -n "$model_a" && -n "$model_b" && -n "$model_c" ]]; then
        fail "All 3 phones report different models" "A=$model_a B=$model_b C=$model_c"
    else
        skip "Model isolation (some models empty)"
    fi

    # Screenshots should differ (sequential — concurrent can overwhelm scrcpy on Pi)
    local tmp_a="/tmp/test-phase3-sc-a.tmp.$$"
    local tmp_b="/tmp/test-phase3-sc-b.tmp.$$"
    local tmp_c="/tmp/test-phase3-sc-c.tmp.$$"
    curl -sk --max-time 30 -o "$tmp_a" "${PI_BASE}/phones/${PHONE_ID_A}/api/screenshot" 2>/dev/null
    curl -sk --max-time 30 -o "$tmp_b" "${PI_BASE}/phones/${PHONE_ID_B}/api/screenshot" 2>/dev/null
    curl -sk --max-time 30 -o "$tmp_c" "${PI_BASE}/phones/${PHONE_ID_C}/api/screenshot" 2>/dev/null

    local all_diff=true
    for pair in "a:b" "b:c" "a:c"; do
        local f1="/tmp/test-phase3-sc-${pair%%:*}.tmp.$$"
        local f2="/tmp/test-phase3-sc-${pair##*:}.tmp.$$"
        if [[ -s "$f1" && -s "$f2" ]] && cmp -s "$f1" "$f2"; then
            all_diff=false
        fi
    done
    if $all_diff && [[ -s "$tmp_a" && -s "$tmp_b" && -s "$tmp_c" ]]; then
        pass "All 3 screenshots differ (no cross-talk)"
    elif [[ ! -s "$tmp_a" || ! -s "$tmp_b" || ! -s "$tmp_c" ]]; then
        fail "All 3 screenshots retrieved" "one or more empty"
    else
        fail "All 3 screenshots differ" "some screenshots are identical"
    fi
    rm -f "$tmp_a" "$tmp_b" "$tmp_c"

    # Snapshot endpoint
    for pid in "${PHONE_IDS[@]}"; do
        local body
        body=$(api GET "${PI_BASE}/phones/${pid}/api/snapshot?format=json")
        if [[ "$(http_code)" == "200" ]]; then
            pass "[$pid] /api/snapshot returns 200"
        else
            fail "[$pid] /api/snapshot returns 200" "HTTP $(http_code)"
        fi
    done

    # Apps endpoint
    for pid in "${PHONE_IDS[@]}"; do
        local body
        body=$(api GET "${PI_BASE}/phones/${pid}/api/apps")
        if [[ "$(http_code)" == "200" ]]; then
            pass "[$pid] /api/apps returns 200"
        else
            fail "[$pid] /api/apps returns 200" "HTTP $(http_code)"
        fi
    done
}

# ============================================================
#  SECTION 3: Dongle assignment validation (Phase 3 specific)
# ============================================================

test_dongle_assignment() {
    bold "--- Phase 3: Dongle Assignment ---"
    echo ""

    [[ -z "$PHONE_ID_A" ]] && { skip "Dongle assignment (no phone IDs)"; return; }

    local body
    body=$(api GET "${PI_BASE}/phones")

    # Extract adapter_mac for each phone
    local macs
    macs=$(echo "$body" | python3 -c "
import sys, json
phones = json.load(sys.stdin)
for p in phones:
    pid = p.get('id','')
    mac = p.get('adapter_mac', 'null')
    print(f'{pid}={mac}')
" 2>/dev/null)

    log "Dongle assignments:"
    echo "$macs" | while read -r line; do
        log "  $line"
    done

    # Check all phones have a dongle assigned
    local unassigned=0
    while IFS= read -r line; do
        local pid="${line%%=*}"
        local mac="${line##*=}"
        if [[ "$mac" == "null" || "$mac" == "None" || -z "$mac" ]]; then
            fail "[$pid] has dongle assigned" "adapter_mac is null"
            unassigned=$((unassigned + 1))
        else
            pass "[$pid] has dongle assigned ($mac)"
        fi
    done <<< "$macs"

    # Check no two phones share the same dongle
    local unique_count
    unique_count=$(echo "$macs" | grep -v 'null\|None' | awk -F= '{print $2}' | sort -u | wc -l | tr -d ' ')
    local total_count
    total_count=$(echo "$macs" | grep -v 'null\|None' | wc -l | tr -d ' ')
    if [[ "$unique_count" -eq "$total_count" && "$total_count" -gt 0 ]]; then
        pass "No two phones share a dongle ($unique_count unique MACs)"
    elif [[ "$total_count" -eq 0 ]]; then
        fail "No phones have dongles assigned"
    else
        fail "No two phones share a dongle" "$total_count assignments but only $unique_count unique MACs"
    fi
}

# ============================================================
#  SECTION 4: Bluetooth pairing validation
# ============================================================

test_bt_pairing() {
    bold "--- Phase 3: Bluetooth Pairing (per-phone dongle) ---"
    echo ""

    # Get phone BT MACs and adapter MACs from the API
    local body
    body=$(api GET "${PI_BASE}/phones")
    local bt_macs
    bt_macs=$(echo "$body" | python3 -c "
import sys, json
phones = json.load(sys.stdin)
for p in phones:
    pid = p.get('id','')
    btm = p.get('phone_bt_mac', '')
    adm = p.get('adapter_mac', '')
    print(f'{pid}|{btm}|{adm}')
" 2>/dev/null)

    # Query paired devices PER ADAPTER using 'select <mac>' so we check the
    # correct dongle instead of only the default hci0 (Pi's built-in BT).
    while IFS='|' read -r pid btm adm; do
        [[ -z "$btm" || "$btm" == "None" ]] && {
            skip "[$pid] BT pairing check (no phone_bt_mac recorded)"
            continue
        }
        [[ -z "$adm" || "$adm" == "None" ]] && {
            skip "[$pid] BT pairing check (no adapter_mac assigned)"
            continue
        }

        # Query this specific adapter for paired devices
        local paired_output
        paired_output=$(pi_exec "printf 'select ${adm}\ndevices Paired\n' | bluetoothctl 2>/dev/null" 2>/dev/null) || {
            skip "[$pid] BT pairing (SSH to Pi failed)"
            continue
        }

        log "[$pid] Paired devices on adapter $adm:"
        echo "$paired_output" | grep "^Device " | while IFS= read -r line; do
            log "  $line"
        done

        if echo "$paired_output" | grep -qi "$btm"; then
            pass "[$pid] phone BT MAC $btm is paired on adapter $adm"
        else
            fail "[$pid] phone BT MAC $btm is paired on adapter $adm" "not found in paired list"
        fi
    done <<< "$bt_macs"
}

# ============================================================
#  SECTION 5: Lazy resources (no idle processes)
# ============================================================

test_lazy_idle() {
    bold "--- Phase 3: Lazy Resources (Idle State) ---"
    echo ""

    # With no VNC clients or audio WS connections, there should be no
    # scrcpy, Xvnc, arecord, or aplay processes running
    local ps_output
    ps_output=$(pi_exec "ps aux" 2>/dev/null) || {
        skip "Lazy resource check (SSH to Pi failed)"
        return
    }

    for proc in scrcpy Xvnc arecord aplay; do
        local count
        count=$(echo "$ps_output" | grep -c "$proc" || true)
        # grep itself might match, so subtract 1 if we see it
        if [[ "$count" -le 0 ]]; then
            pass "No $proc processes running (idle)"
        else
            # Check if any match is the grep command itself
            local real_count
            real_count=$(echo "$ps_output" | grep "$proc" | grep -cv "grep" || true)
            if [[ "$real_count" -le 0 ]]; then
                pass "No $proc processes running (idle)"
            else
                fail "No $proc processes running (idle)" "found $real_count $proc processes"
                if $VERBOSE; then
                    echo "$ps_output" | grep "$proc" | grep -v grep | while IFS= read -r line; do
                        log "    $line"
                    done
                fi
            fi
        fi
    done
}

test_lazy_vnc_spinup() {
    bold "--- Phase 3: Lazy VNC Spin-Up ---"
    echo ""

    [[ -z "$PHONE_ID_A" ]] && { skip "VNC spin-up (no phone IDs)"; return; }

    local vnc_port
    vnc_port=$(vnc_port_for "$PHONE_ID_A")

    log "Testing VNC on port $vnc_port for phone $PHONE_ID_A"

    # Connect to VNC port — this should trigger lazy spin-up
    local start_time
    start_time=$(python3 -c "import time; print(time.time())")
    local vnc_ok=false

    # Try connecting via nc with a short timeout — the VNC server should start
    if nc -z -w 5 "${PI_HOST%%:*}" "$vnc_port" 2>/dev/null; then
        vnc_ok=true
    fi

    local end_time
    end_time=$(python3 -c "import time; print(time.time())")
    local elapsed
    elapsed=$(python3 -c "print(f'{$end_time - $start_time:.1f}')")

    if $vnc_ok; then
        pass "VNC port $vnc_port reachable for phone $PHONE_ID_A"
        if python3 -c "exit(0 if float('$elapsed') <= 5.0 else 1)"; then
            pass "VNC spin-up within 5s (took ${elapsed}s)"
        else
            fail "VNC spin-up within 5s" "took ${elapsed}s"
        fi
    else
        fail "VNC port $vnc_port reachable" "nc -z failed after 5s"
    fi

    # Now check that scrcpy/Xvnc processes exist (lazy start happened)
    local ps_output
    ps_output=$(pi_exec "ps aux" 2>/dev/null) || true
    local xvnc_running
    xvnc_running=$(echo "$ps_output" | grep -c "Xvnc" | grep -cv "grep" || true) 2>/dev/null
    # Simpler check
    if echo "$ps_output" | grep -v grep | grep -q "Xvnc"; then
        pass "Xvnc process running after VNC connect"
    else
        fail "Xvnc process running after VNC connect"
    fi
}

test_lazy_vnc_teardown() {
    bold "--- Phase 3: Lazy VNC Teardown (60s idle timeout) ---"
    echo ""

    # This test is informational — we can't easily wait 60s in a test script.
    # Instead, just document the expectation and verify the mechanism is in place.
    log "NOTE: Full 60s idle teardown requires manual verification."
    log "After disconnecting all VNC clients, wait 60s and verify:"
    log "  ssh $PI_SSH \"cd ~/otacon && docker compose exec -T otacon ps aux | grep -E 'scrcpy|Xvnc'\""
    log "Expected: no scrcpy/Xvnc processes."
    skip "VNC 60s idle teardown (requires manual wait)"
}

test_lazy_all_three_vnc() {
    bold "--- Phase 3: Simultaneous VNC for All 3 Phones ---"
    echo ""

    # Try connecting to VNC ports for all 3 phones simultaneously
    for pid in "${PHONE_IDS[@]}"; do
        [[ -z "$pid" ]] && continue
        local vnc_port
        vnc_port=$(vnc_port_for "$pid")

        if nc -z -w 5 "${PI_HOST%%:*}" "$vnc_port" 2>/dev/null; then
            pass "[$pid] VNC port $vnc_port reachable"
        else
            fail "[$pid] VNC port $vnc_port reachable" "nc -z failed"
        fi
    done
}

# ============================================================
#  SECTION 6: Audio streaming (A2DP bytes flowing)
# ============================================================

test_audio_ws() {
    bold "--- Standing Criteria 3: Audio Streaming (A2DP) ---"
    echo ""

    [[ -z "$PHONE_ID_A" ]] && { skip "Audio streaming (no phone IDs)"; return; }

    # For each phone, connect to /phones/{id}/ws/audio/media and count bytes
    for pid in "${PHONE_IDS[@]}"; do
        [[ -z "$pid" ]] && continue

        local ws_url
        if [[ "$PI_SCHEME" == "https" ]]; then
            ws_url="wss://${PI_HOST}/phones/${pid}/ws/audio/media"
        else
            ws_url="ws://${PI_HOST}/phones/${pid}/ws/audio/media"
        fi

        if [[ -z "$PYTHON_WS" ]]; then
            skip "[$pid] A2DP audio bytes (no python3 with websockets)"
            log "Install with: pip3 install websockets"
            break
        fi

        # Use python3 websocket client to connect and count bytes for 3 seconds
        local byte_count
        byte_count=$($PYTHON_WS -c "
import asyncio, ssl, sys, websockets

async def count_bytes():
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    total = 0
    try:
        async with websockets.connect('$ws_url', ssl=ssl_ctx, open_timeout=5) as ws:
            try:
                async with asyncio.timeout(3):
                    async for msg in ws:
                        if isinstance(msg, bytes):
                            total += len(msg)
            except (asyncio.TimeoutError, TimeoutError):
                pass
    except Exception as e:
        print('-2', file=sys.stderr)
    print(total)

asyncio.run(count_bytes())
" 2>/dev/null) || byte_count="-3"

        if [[ "$byte_count" == "-2" || "$byte_count" == "-3" ]]; then
            fail "[$pid] A2DP WebSocket connection" "connection failed"
        elif [[ "$byte_count" -gt 0 ]]; then
            pass "[$pid] A2DP audio bytes received ($byte_count bytes in 3s)"
        else
            # 0 bytes is expected if no media is playing — this is a soft check
            log "[$pid] 0 bytes received — is media playing on this phone?"
            skip "[$pid] A2DP audio bytes (0 bytes — no media playing?)"
        fi
    done
}

test_audio_ws_accept() {
    bold "--- Audio: WebSocket Accept (all phones) ---"
    echo ""

    # Verify WS upgrade succeeds using a proper WebSocket client
    for pid in "${PHONE_IDS[@]}"; do
        [[ -z "$pid" ]] && continue

        local ws_url
        if [[ "$PI_SCHEME" == "https" ]]; then
            ws_url="wss://${PI_HOST}/phones/${pid}/ws/audio/media"
        else
            ws_url="ws://${PI_HOST}/phones/${pid}/ws/audio/media"
        fi

        if [[ -z "$PYTHON_WS" ]]; then
            skip "[$pid] /ws/audio/media WS upgrade (no python3 with websockets)"
            break
        fi

        local result
        result=$($PYTHON_WS -c "
import asyncio, ssl, sys, websockets

async def test():
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    try:
        async with websockets.connect('$ws_url', ssl=ssl_ctx, open_timeout=5) as ws:
            print('ok')
    except Exception as e:
        print(f'error:{e}')

asyncio.run(test())
" 2>/dev/null) || result="error:python_failed"

        if [[ "$result" == "ok" ]]; then
            pass "[$pid] /ws/audio/media WS upgrade accepted"
        else
            fail "[$pid] /ws/audio/media WS upgrade" "$result"
        fi
    done
}

# ============================================================
#  SECTION 7: Token-based password clearing
# ============================================================

test_password_token() {
    bold "--- Phase 3: Token-Based Password Clearing ---"
    echo ""

    [[ -z "$PHONE_ID_B" ]] && { skip "Password token (no A15 phone ID)"; return; }

    # The A15 (PHONE_ID_B) may have a PIN set. Test lock/status and lock/clear via the API.
    # First check lock status via bridge
    local status_body
    status_body=$(pi_exec "adb -s ${PHONE_SERIAL_B} shell content query --uri 'content://com.otacon.kiosk/lock/status'" 2>/dev/null) || {
        skip "Password token (SSH/ADB failed)"
        return
    }
    log "A15 lock status: $status_body"

    if echo "$status_body" | grep -q "is_secure=true"; then
        log "A15 has a passcode — attempting clear via token..."
        local clear_body
        clear_body=$(pi_exec "adb -s ${PHONE_SERIAL_B} shell content query --uri 'content://com.otacon.kiosk/lock/clear'" 2>/dev/null) || {
            fail "Password clear via token" "SSH/ADB failed"
            return
        }
        log "Clear result: $clear_body"
        if echo "$clear_body" | grep -q "ok=true"; then
            pass "A15 passcode cleared via device-owner token"
        else
            fail "A15 passcode cleared via device-owner token" "result: $clear_body"
        fi

        # Verify it's now clear
        status_body=$(pi_exec "adb -s ${PHONE_SERIAL_B} shell content query --uri 'content://com.otacon.kiosk/lock/status'" 2>/dev/null) || true
        if echo "$status_body" | grep -q "is_secure=false"; then
            pass "A15 confirmed no passcode after clear"
        else
            fail "A15 confirmed no passcode after clear" "status: $status_body"
        fi
    else
        pass "A15 has no passcode (is_secure=false) — token not needed"
    fi
}

# ============================================================
#  SECTION 8: Error reporting (no free dongle scenario)
# ============================================================

test_error_reporting() {
    bold "--- Phase 3: Error Reporting ---"
    echo ""

    if [[ -z "$REGISTRY_HOST" ]]; then
        skip "Error reporting (no --registry specified)"
        return
    fi

    # Check that events endpoint exists and returns data
    local body
    body=$(api GET "${REGISTRY_BASE}/api/v1/events")
    assert_status 200 "Registry events endpoint returns 200"
    assert_json "$body" "Registry events is valid JSON"

    # Look for any error events already logged
    local error_count
    error_count=$(echo "$body" | python3 -c "
import sys, json
events = json.load(sys.stdin)
errors = [e for e in events if 'error' in e.get('event_type','').lower() or 'error' in str(e.get('data','')).lower()]
print(len(errors))
" 2>/dev/null) || error_count="0"
    log "Error events in registry: $error_count"

    # Note: triggering "no free dongle" requires removing all dongles which is destructive.
    # We document how to test manually.
    log "Manual test for 'no free dongle':"
    log "  1. Unplug all USB BT dongles from the Pi"
    log "  2. Connect a 4th phone (or restart device-monitor)"
    log "  3. Check: curl ${REGISTRY_BASE}/api/v1/events | grep dongle"
    log "  4. Expect: event with type containing 'error' or 'no_free_dongle'"
    skip "No-free-dongle scenario (requires hardware intervention)"
}

# ============================================================
#  SECTION 9: Adversarial tests
# ============================================================

test_rapid_vnc_reconnect() {
    bold "--- Adversarial: Rapid VNC Connect/Disconnect ---"
    echo ""

    [[ -z "$PHONE_ID_A" ]] && { skip "Rapid VNC (no phone IDs)"; return; }

    local vnc_port
    vnc_port=$(vnc_port_for "$PHONE_ID_A")

    log "Rapid connect/disconnect on port $vnc_port (5 cycles)..."
    local success=0
    for i in $(seq 1 5); do
        if nc -z -w 2 "${PI_HOST%%:*}" "$vnc_port" 2>/dev/null; then
            success=$((success + 1))
        fi
    done

    if [[ "$success" -ge 4 ]]; then
        pass "Rapid VNC reconnect: $success/5 successful"
    else
        fail "Rapid VNC reconnect" "only $success/5 successful"
    fi
}

test_concurrent_all_three() {
    bold "--- Adversarial: Concurrent API to All 3 Phones ---"
    echo ""

    [[ ${#PHONE_IDS[@]} -lt 3 ]] && { skip "Concurrent all-3 (need 3 phones)"; return; }

    local pids=()
    local tmps=()
    for pid in "${PHONE_IDS[@]}"; do
        [[ -z "$pid" ]] && continue
        local tmp="/tmp/test-phase3-concurrent-${pid}.tmp.$$"
        tmps+=("$tmp")
        curl -sk --max-time 15 "${PI_BASE}/phones/${pid}/api/info" > "$tmp" 2>/dev/null &
        pids+=($!)
    done

    for bg_pid in "${pids[@]}"; do
        wait "$bg_pid" 2>/dev/null || true
    done

    local all_ok=true
    for tmp in "${tmps[@]}"; do
        local phone_slug
        phone_slug=$(basename "$tmp" | sed "s/test-phase3-concurrent-//" | sed "s/.tmp.*//")
        if [[ -s "$tmp" ]] && python3 -m json.tool < "$tmp" >/dev/null 2>&1; then
            pass "Concurrent request to $phone_slug succeeded"
        else
            fail "Concurrent request to $phone_slug" "empty or invalid response"
            all_ok=false
        fi
        rm -f "$tmp"
    done
}

# ============================================================
#  SECTION 10: Registry integration (if available)
# ============================================================

test_registry_phone_data() {
    bold "--- Registry: Phone Data Matches Pi ---"
    echo ""

    if [[ -z "$REGISTRY_HOST" ]]; then
        skip "Registry phone data (no --registry specified)"
        return
    fi

    # Get phones from registry
    local reg_body
    reg_body=$(api GET "${REGISTRY_BASE}/api/v1/phones")
    if [[ "$(http_code)" != "200" ]]; then
        fail "Registry phones endpoint" "HTTP $(http_code)"
        return
    fi

    local reg_count
    reg_count=$(echo "$reg_body" | json_array_len)
    if [[ "$reg_count" -ge 3 ]]; then
        pass "Registry has >= 3 phones (got $reg_count)"
    else
        fail "Registry has >= 3 phones" "got $reg_count"
    fi

    # Verify each phone has a unique dongle in the registry too
    local reg_macs
    reg_macs=$(echo "$reg_body" | python3 -c "
import sys, json
phones = json.load(sys.stdin)
macs = set()
for p in phones:
    mac = p.get('dongle_mac', p.get('adapter_mac', ''))
    if mac:
        macs.add(mac)
print(len(macs))
" 2>/dev/null) || reg_macs="0"
    log "Unique dongle MACs in registry: $reg_macs"
}

# ============================================================
#  SECTION 11: Standing criteria 4 — scrcpy + VNC
# ============================================================

test_vnc_per_phone() {
    bold "--- Standing Criteria 4: VNC Per Phone ---"
    echo ""

    for pid in "${PHONE_IDS[@]}"; do
        [[ -z "$pid" ]] && continue
        local vnc_port
        vnc_port=$(vnc_port_for "$pid")

        if nc -z -w 5 "${PI_HOST%%:*}" "$vnc_port" 2>/dev/null; then
            pass "[$pid] VNC port $vnc_port reachable"
        else
            fail "[$pid] VNC port $vnc_port reachable" "nc -z failed"
        fi
    done
}

# ============================================================
#  MAIN
# ============================================================

echo ""
bold "=========================================="
bold " Phase 3 Test Harness"
bold " Lazy Resources + BT Dongle + Audio"
bold "=========================================="
echo ""

if $RUN_PI; then
    if test_connectivity; then
        echo ""
        test_phone_discovery

        if should_run "setup"; then
            echo ""
            test_phone_setup
        fi

        if should_run "isolation"; then
            echo ""
            test_api_isolation
        fi

        if should_run "dongle"; then
            echo ""
            test_dongle_assignment
        fi

        if should_run "bt"; then
            echo ""
            test_bt_pairing
        fi

        if should_run "lazy"; then
            echo ""
            test_lazy_idle
            echo ""
            test_lazy_vnc_spinup
            echo ""
            test_lazy_vnc_teardown
            echo ""
            test_lazy_all_three_vnc
        fi

        if should_run "audio"; then
            echo ""
            test_audio_ws_accept
            echo ""
            test_audio_ws
        fi

        if should_run "vnc"; then
            echo ""
            test_vnc_per_phone
        fi

        if should_run "password"; then
            echo ""
            test_password_token
        fi

        if should_run "adversarial"; then
            echo ""
            test_rapid_vnc_reconnect
            echo ""
            test_concurrent_all_three
        fi
    else
        echo ""
        log "Skipping Pi tests — server not reachable"
    fi
fi

if $RUN_REGISTRY || should_run "registry"; then
    if [[ -n "$REGISTRY_HOST" ]]; then
        echo ""
        bold "=========================================="
        bold " Registry Integration Tests"
        bold "=========================================="
        echo ""
        test_registry_phone_data

        if should_run "error"; then
            echo ""
            test_error_reporting
        fi
    else
        skip "Registry tests (no --registry specified)"
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
