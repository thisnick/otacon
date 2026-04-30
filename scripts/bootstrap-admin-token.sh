#!/bin/bash
# Generate a valid otc_admin_* bootstrap token and seed both:
#   - .env at the repo root (REGISTRY_BOOTSTRAP_ADMIN_TOKEN=...)
#   - ~/.otacon/config.toml (token = "...")
#
# Idempotent: refuses to overwrite an existing token unless --force is passed.
#
# Usage:
#   scripts/bootstrap-admin-token.sh           # safe, errors if already seeded
#   scripts/bootstrap-admin-token.sh --force   # overwrites both files
set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ]; then
    FORCE=1
fi

# Anchor to repo root
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
    echo "ERROR: not inside a git repo" >&2
    exit 1
fi

ENV_FILE="${REPO_ROOT}/.env"
CONFIG_FILE="${HOME}/.otacon/config.toml"

# Generate token
TOKEN="otc_admin_$(openssl rand -hex 32)"

# Track whether this is a fresh bootstrap (env var did not previously exist)
WAS_NEW_BOOTSTRAP=0

# --- .env handling ---
if [ ! -f "${ENV_FILE}" ]; then
    printf 'REGISTRY_BOOTSTRAP_ADMIN_TOKEN=%s\n' "${TOKEN}" > "${ENV_FILE}"
    WAS_NEW_BOOTSTRAP=1
elif ! grep -qE '^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=' "${ENV_FILE}"; then
    # Append, preserving trailing newline if present
    printf 'REGISTRY_BOOTSTRAP_ADMIN_TOKEN=%s\n' "${TOKEN}" >> "${ENV_FILE}"
    WAS_NEW_BOOTSTRAP=1
else
    EXISTING="$(grep -E '^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=' "${ENV_FILE}" | head -n1 | cut -d'=' -f2-)"
    if [ -z "${EXISTING}" ]; then
        # Empty value — replace
        sed -i.bak "s|^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=.*|REGISTRY_BOOTSTRAP_ADMIN_TOKEN=${TOKEN}|" "${ENV_FILE}"
        rm -f "${ENV_FILE}.bak"
        WAS_NEW_BOOTSTRAP=1
    else
        if [ "${FORCE}" -ne 1 ]; then
            echo "ERROR: ${ENV_FILE} already has REGISTRY_BOOTSTRAP_ADMIN_TOKEN set." >&2
            echo "       Re-run with --force to overwrite." >&2
            exit 2
        fi
        sed -i.bak "s|^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=.*|REGISTRY_BOOTSTRAP_ADMIN_TOKEN=${TOKEN}|" "${ENV_FILE}"
        rm -f "${ENV_FILE}.bak"
    fi
fi

# --- ~/.otacon/config.toml handling ---
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "ERROR: ${CONFIG_FILE} does not exist." >&2
    echo "       Run 'otacon' (or 'pnpm cli ...') once to create it, then re-run this script." >&2
    exit 3
fi

if ! grep -qE '^token = "' "${CONFIG_FILE}"; then
    echo "ERROR: ${CONFIG_FILE} has no 'token = \"...\"' line." >&2
    echo "       Run 'otacon login ...' (or edit the file) to seed an initial token line, then re-run." >&2
    exit 4
fi

EXISTING_CFG_TOKEN="$(grep -E '^token = "' "${CONFIG_FILE}" | head -n1 | sed -E 's/^token = "(.*)"$/\1/')"
if [ -n "${EXISTING_CFG_TOKEN}" ] && [ "${EXISTING_CFG_TOKEN}" != "${TOKEN}" ] && [ "${FORCE}" -ne 1 ]; then
    echo "ERROR: ${CONFIG_FILE} already has a non-empty token." >&2
    echo "       Re-run with --force to overwrite." >&2
    exit 5
fi

sed -i.bak "s|^token = \".*\"|token = \"${TOKEN}\"|" "${CONFIG_FILE}"
rm -f "${CONFIG_FILE}.bak"

echo "Generated: ${TOKEN}"
echo "Wrote .env REGISTRY_BOOTSTRAP_ADMIN_TOKEN"
echo "Wrote ~/.otacon/config.toml token"
echo "Next: ./scripts/deploy-registry.sh <pi-host>"

if [ "${WAS_NEW_BOOTSTRAP}" -eq 1 ]; then
    cat <<'NOTE'

NOTE: For a fresh registry to pick up this token, tokens.json must be empty
or absent on the Pi:

  ssh otacon-pi 'docker exec otacon-registry rm -f /data/tokens.json && \
                 docker compose -f ~/otacon-registry/docker-compose.yml restart otacon-registry'

Then re-run: ./scripts/deploy-registry.sh otacon-pi
NOTE
fi
