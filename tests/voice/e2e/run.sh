#!/bin/bash
# otacon-voice end-to-end scenarios, run through the test gateway (gateway.sh).
#
#   tests/voice/e2e/run.sh ivr       # agent books a table through the Twilio test menu (hold included)
#   tests/voice/e2e/run.sh ivr-hold-limit  # same, but the agent gives up after 1 min on hold (outcome hold_cap)
#   tests/voice/e2e/run.sh handoff   # agent reschedules with a persona "business", brings in persona "Nick"
#   tests/voice/e2e/run.sh inbound   # persona "Nick" calls the plugin's phone (from phone-3, or pixel4 when that's phone-3); the plugin answers and consults the agent
#   tests/voice/e2e/run.sh call-me   # the agent calls the owner (ownerNumber), a real person, to hear the voice
#   tests/voice/e2e/run.sh consult   # the agent calls a persona pharmacy that asks for something only the agent knows
#
# Each run records phone-2's side (stereo WAV: L = other party, R = the voice
# model) under $OTACON_VOICE_TEST_HOME/runs/.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="${OTACON_VOICE_TEST_HOME:-$HOME/code/otacon-voice-test}"
fleet() { python3 "$HERE/../fleet.py" "$@"; }
HOST="$(fleet get otaconHost)"
# The plugin's phone (OTACON_VOICE_PHONE, as for gateway.sh; default phone-2).
P2="$(fleet get "phones.${OTACON_VOICE_PHONE:-phone-2}.hostId")"
TOKEN="$(cat "$T/data/gw-token")"
oc() { docker exec -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" ov-gateway node /app/dist/index.js "$@"; }
py() { uv run -q --managed-python --no-project --python 3.12 --with websockets --with numpy python "$@"; }

RUN="$T/runs/$1-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$RUN"
py "$HERE/record.py" "$HOST" "$P2" "$RUN/call" > "$RUN/events.log" 2>&1 &
REC=$!
sleep 2

# The id of the plugin's latest call ("" before any).
last_call() {
  oc gateway call otaconvoice.status --json 2>/dev/null |
    python3 -c 'import json,sys; d=json.load(sys.stdin) or {}; print(d.get("missionId", ""), d.get("ended", False))' 2>/dev/null
}

# Ask the agent; returns 1 at once if it didn't place a call.
ask_agent() {
  local session="agent:main:e2e-$(basename "$RUN")"
  local before
  before="$(last_call | cut -d' ' -f1)"
  echo "$1" > "$RUN/prompt.txt"
  oc agent --session-key "$session" --message "$1" --json --timeout 300 > "$RUN/agent.json" 2>&1
  python3 -c "import json; d=json.load(open('$RUN/agent.json')); print('agent:', d['result']['payloads'][0]['text'][:400])" 2>/dev/null || tail -3 "$RUN/agent.json"
  # Wait for the call it placed to finish, then for the report to wake the agent.
  local id ended
  for i in $(seq 1 144); do
    read -r id ended <<< "$(last_call)"
    if [ "$id" = "$before" ]; then echo "the agent placed no call" >&2; return 1; fi
    [ "$ended" = True ] && break
    sleep 5
  done
  sleep 30
  oc gateway call chat.history --params "{\"sessionKey\":\"$session\",\"limit\":100}" --json > "$RUN/history.json" 2>&1 || true
}

case "$1" in
  ivr)
    ask_agent "Please call Luigi's Trattoria at $(fleet get twilioIvr.number) and book a table for 2 people tonight at 7:30 PM under the name Nick. Their phone menu has a reservations option. Let me know how it goes."
    ;;
  ivr-hold-limit)
    ask_agent "Please call Luigi's Trattoria at $(fleet get twilioIvr.number) and book a table for 2 people tonight at 7:30 PM under the name Nick. Their phone menu has a reservations option. Don't wait on hold for more than 1 minute. Let me know how it goes."
    ;;
  handoff)
    py "$HERE/persona.py" --phone phone-pixel4 --persona dental --voice marin --hangup-on-goodbye \
      --arm-goodbye-on "this is nick|nick here|it's nick" --log "$RUN/personas.jsonl" > "$RUN/dental.log" 2>&1 &
    D=$!
    py "$HERE/persona.py" --phone phone-3 --persona nick --voice cedar --log "$RUN/personas.jsonl" > "$RUN/nick.log" 2>&1 &
    N=$!
    sleep 6
    ask_agent "Please call my dentist, Bright Smile Dental, at $(fleet get phones.phone-pixel4.number) and move my teeth cleaning from Monday at 10 AM to Thursday at 2 PM. If they need to talk to me directly, bring me into the call: I'm Nick, at $(fleet get phones.phone-3.number)."
    wait $D $N 2>/dev/null
    ;;
  inbound)
    # The plugin's first line: its fleet phone, or the Twilio number.
    PLUGIN_PHONE="${OTACON_VOICE_PHONE:-phone-2}"; DIAL="$PLUGIN_PHONE"
    case "${OTACON_VOICE_LINES:-phone}" in twilio*) DIAL="$(fleet get twilioLine.number)"; PLUGIN_PHONE=none ;; esac
    CALLER=phone-3; [ "$PLUGIN_PHONE" = phone-3 ] && CALLER=phone-pixel4
    py "$HERE/persona.py" --phone "$CALLER" --persona nick-calls --voice cedar --dial "$DIAL" --hangup-on-goodbye \
      --log "$RUN/personas.jsonl" > "$RUN/nick.log" 2>&1
    sleep 30
    ;;
  consult)
    py "$HERE/persona.py" --phone phone-pixel4 --persona pharmacy --voice marin --hangup-on-goodbye \
      --log "$RUN/personas.jsonl" > "$RUN/pharmacy.log" 2>&1 &
    P=$!
    sleep 6
    ask_agent "Use otacon_call to call Corner Pharmacy at $(fleet get phones.phone-pixel4.number) and ask whether my prescription is ready for pickup. They'll ask for my date of birth: tell the assistant to check with me for it during the call." || kill $P 2>/dev/null
    wait $P 2>/dev/null
    ;;
  call-me)
    ask_agent "Please call me at $(fleet get ownerNumber). It's a test call so I can hear how your voice sounds on the phone: say hi, tell me in a few sentences what you can do on calls for me, ask whether I can hear you clearly, and chat until I say goodbye."
    ;;
  *) echo "usage: $0 ivr|ivr-hold-limit|handoff|inbound|call-me|consult" >&2; kill $REC; exit 2 ;;
esac
kill $REC 2>/dev/null; wait $REC 2>/dev/null
docker logs --since 20m ov-gateway 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep "otacon-voice" > "$RUN/plugin.log"
echo "run dir: $RUN"
