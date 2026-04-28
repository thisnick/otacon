#!/usr/bin/env bash
# Auto-approve all orchestrator approval requests by watching the approvals directory.
# Logs each approval to stdout for capture.
set -euo pipefail

APPROVALS_DIR="${1:-.orchestrator/approvals}"
mkdir -p "$APPROVALS_DIR"

echo "[auto-approve] Watching $APPROVALS_DIR for approval requests..."

# Poll the orchestrator log for signal IDs and auto-approve them
while true; do
  # Check if any pending signal files need creating by scanning the log
  # Instead, just watch the approvals directory and approve anything that appears as a request
  # We rely on the log to tell us signal IDs

  # Find any signal IDs mentioned in any orchestrator log that don't have approval files yet
  for logfile in /tmp/orchestrator-r*.log /tmp/e2e-test*.log; do
    [ -f "$logfile" ] || continue
    for signal_id in $(grep -o 'Signal ID: [A-Z0-9]*' "$logfile" 2>/dev/null | sed 's/Signal ID: //' || true); do
      approval_file="$APPROVALS_DIR/${signal_id}.json"
      if [ ! -f "$approval_file" ]; then
        echo "[auto-approve] $(date +%H:%M:%S) Approving signal: $signal_id"
        echo '{"decision":"approve"}' > "$approval_file"
      fi
    done
  done

  sleep 0.5
done
