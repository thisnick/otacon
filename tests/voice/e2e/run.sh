#!/bin/bash
# otacon-voice end-to-end scenarios, run through the test gateway (gateway.sh).
#
#   tests/voice/e2e/run.sh ivr       # agent books a table through the Twilio test menu (hold included)
#   tests/voice/e2e/run.sh handoff   # agent reschedules with a persona "business", brings in persona "Nick"
#   tests/voice/e2e/run.sh inbound   # persona "Nick" calls phone-2; the plugin answers and consults the agent
#   tests/voice/e2e/run.sh call-me   # the agent calls the owner (ownerNumber), a real person, to hear the voice
#
# Each run records phone-2's side (stereo WAV: L = other party, R = the voice
# model) under $OTACON_VOICE_TEST_HOME/runs/.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="${OTACON_VOICE_TEST_HOME:-$HOME/code/otacon-voice-test}"
fleet() { python3 "$HERE/../fleet.py" "$@"; }
HOST="$(fleet get otaconHost)"
P2="$(fleet get phones.phone-2.hostId)"
TOKEN="$(cat "$T/data/gw-token")"
oc() { docker exec -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" ov-gateway node /app/dist/index.js "$@"; }
py() { uv run -q --managed-python --no-project --python 3.12 --with websockets --with numpy python "$@"; }

RUN="$T/runs/$1-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$RUN"
py "$HERE/record.py" "$HOST" "$P2" "$RUN/call" > "$RUN/events.log" 2>&1 &
REC=$!
sleep 2

ask_agent() {
  local session="agent:main:e2e-$(basename "$RUN")"
  echo "$1" > "$RUN/prompt.txt"
  oc agent --session-key "$session" --message "$1" --json --timeout 300 > "$RUN/agent.json" 2>&1
  python3 -c "import json; d=json.load(open('$RUN/agent.json')); print('agent:', d['result']['payloads'][0]['text'][:400])" 2>/dev/null || tail -3 "$RUN/agent.json"
  # Wait for the call to finish, then for the report to wake the agent.
  for i in $(seq 1 144); do
    oc gateway call otaconvoice.status --json 2>/dev/null | tail -1 | grep -qE '"ended": ?true' && break
    sleep 5
  done
  sleep 30
  oc gateway call chat.history --params "{\"sessionKey\":\"$session\",\"limit\":100}" --json > "$RUN/history.json" 2>&1 || true
}

case "$1" in
  ivr)
    ask_agent "Please call Luigi's Trattoria at $(fleet get twilioIvr.number) and book a table for 2 people tonight at 7:30 PM under the name Nick. Their phone menu has a reservations option. Let me know how it goes."
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
    py "$HERE/persona.py" --phone phone-3 --persona nick-calls --voice cedar --dial phone-2 --hangup-on-goodbye \
      --log "$RUN/personas.jsonl" > "$RUN/nick.log" 2>&1
    sleep 30
    ;;
  call-me)
    ask_agent "Please call me at $(fleet get ownerNumber). It's a test call so I can hear how your voice sounds on the phone: say hi, tell me in a few sentences what you can do on calls for me, ask whether I can hear you clearly, and chat until I say goodbye."
    ;;
  *) echo "usage: $0 ivr|handoff|inbound|call-me" >&2; kill $REC; exit 2 ;;
esac
kill $REC 2>/dev/null; wait $REC 2>/dev/null
docker logs --since 20m ov-gateway 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep "otacon-voice" > "$RUN/plugin.log"
echo "run dir: $RUN"
