#!/bin/bash
# Throwaway OpenClaw gateway for otacon-voice end-to-end tests.
#
#   tests/voice/e2e/gateway.sh init     # write its config from fleet.local.json
#   tests/voice/e2e/gateway.sh install  # build the plugin, install it, (re)start
#   tests/voice/e2e/gateway.sh start|stop
#
# State lives in $OTACON_VOICE_TEST_HOME (default ~/code/otacon-voice-test),
# outside the repo. Host networking (it reaches the otacon Pi over the tailnet)
# on port 28789, pinned in its config so its CLI never talks to a live gateway
# on the default 18789. The OpenAI key comes from fleet.py at start.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
T="${OTACON_VOICE_TEST_HOME:-$HOME/code/otacon-voice-test}"
IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:2026.10.3}"
fleet() { python3 "$HERE/../fleet.py" "$@"; }
mkdir -p "$T/home/.openclaw" "$T/data" "$T/runs"

run_cli() {
  docker run --rm --network host -u "$(id -u):$(id -g)" -v "$T/home:/home/node" -e HOME=/home/node \
    --entrypoint node "$IMAGE" /app/dist/index.js "$@"
}

init() {
  [ -f "$T/data/gw-token" ] || (python3 -c "import secrets; print(secrets.token_hex(24))" > "$T/data/gw-token" && chmod 600 "$T/data/gw-token")
  HERE_DIR="$HERE" python3 - "$T/home/.openclaw/openclaw.json" <<'PY'
import json, os, sys
sys.path.insert(0, os.path.join(os.environ["HERE_DIR"], ".."))
import fleet
cfg = {
  "gateway": {"mode": "local", "bind": "loopback", "port": 28789, "auth": {"mode": "token"}},
  "agents": {"defaults": {"model": {"primary": "openai/gpt-6-luna"}}},
  "plugins": {"allow": ["otacon-voice"], "entries": {"otacon-voice": {"enabled": True, "config": {
    "otacon": {"url": f"https://{fleet.HOST}", "phoneId": fleet.host_id("phone-2")},
    "ownerName": "Nick", "assistantName": "Nick's assistant",
    "inboundPolicy": "allowlist", "allowFrom": [fleet.number("phone-3")],
    "toolPolicy": "safe-read-only",
    "realtime": {"provider": "openai", "providers": {"openai": {"model": "gpt-realtime-2.1", "voice": "marin"}}},
    "holdCapSeconds": 300}}}},
}
path = sys.argv[1]
if os.path.exists(path):
    old = json.load(open(path))
    old.setdefault("plugins", {}).update(cfg["plugins"])
    old["gateway"] = cfg["gateway"]
    cfg = {**old, "agents": old.get("agents", cfg["agents"])}
json.dump(cfg, open(path, "w"), indent=2)
print("wrote", path)
PY
}

stop() { docker rm -f ov-gateway >/dev/null 2>&1 || true; }

start() {
  stop
  OPENAI_API_KEY="$(fleet secret OPENAI_API_KEY)"
  export OPENAI_API_KEY
  # A just-stopped gateway's state lease can still be held for a few seconds.
  for attempt in 1 2 3 4 5; do
    stop
    docker run -d --name ov-gateway --network host -u "$(id -u):$(id -g)" -v "$T/home:/home/node" -e HOME=/home/node \
      -e OPENAI_API_KEY --entrypoint node "$IMAGE" \
      /app/dist/index.js gateway --port 28789 --bind loopback --auth token --token "$(cat "$T/data/gw-token")" >/dev/null
    sleep 8
    [ "$(docker inspect -f '{{.State.Running}}' ov-gateway)" = true ] && break
    echo "gateway exited during startup (attempt $attempt); retrying" >&2
    sleep 10
  done
  for i in $(seq 1 60); do docker logs ov-gateway 2>&1 | grep -q "otacon-voice\] connected\|otacon-voice\] disabled" && break; sleep 2; done
  docker logs ov-gateway 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E "otacon-voice\]" | cut -c1-200 | tail -3
}

install() {
  (cd "$REPO/src/openclaw-voice" && rm -f ./*.tgz && npm install --no-audit --no-fund >/dev/null && npx tsc -p tsconfig.json && npm pack >/dev/null 2>&1)
  cp "$REPO"/src/openclaw-voice/otacon-fleet-openclaw-voice-*.tgz "$T/home/otacon-voice.tgz"
  stop
  # install needs the gateway's state lease, which lapses a few seconds after a stop.
  for attempt in $(seq 1 12); do
    out=$(run_cli plugins install /home/node/otacon-voice.tgz --force --accept-capabilities 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')
    if echo "$out" | grep -q "Installed plugin"; then echo "installed (attempt $attempt)"; break; fi
    [ "$attempt" = 12 ] && { echo "$out" | tail -5; echo "install failed" >&2; exit 1; }
    sleep 5
  done
  cmp -s <(tar -xzOf "$T/home/otacon-voice.tgz" package/dist/call.js) "$T/home/.openclaw/extensions/otacon-voice/dist/call.js" \
    || { echo "installed files don't match the package" >&2; exit 1; }
  start
}

case "${1:-}" in
  init) init ;;
  install) install ;;
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 init|install|start|stop" >&2; exit 2 ;;
esac
