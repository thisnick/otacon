#!/bin/bash
# Bootstrap a fresh otc_admin_* token in two stages:
#
#   1. Default mode (no flags or --generate)
#        Generates a fresh token and writes it to .env only
#        (REGISTRY_BOOTSTRAP_ADMIN_TOKEN=...). Does NOT touch
#        ~/.otacon/config.toml — the existing CLI token still works
#        until the registry is redeployed.
#
#   2. --activate
#        Reads REGISTRY_BOOTSTRAP_ADMIN_TOKEN from .env and copies it
#        into ~/.otacon/config.toml's `token = "..."` line. Run only
#        AFTER the registry has been redeployed with the new token.
#
# Idempotent: refuses to overwrite existing values without --force.
#
# See --help for full usage.
set -euo pipefail

usage() {
    cat <<'USAGE'
Usage:
  scripts/bootstrap-admin-token.sh             Generate token, write to .env
  scripts/bootstrap-admin-token.sh --force     Regenerate (overwrite existing .env value)
  scripts/bootstrap-admin-token.sh --activate  Copy .env token to ~/.otacon/config.toml
  scripts/bootstrap-admin-token.sh --activate --force
                                                Activate even if config.toml differs
  scripts/bootstrap-admin-token.sh --help      Show this message
USAGE
}

MODE="generate"
FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --generate)
            MODE="generate"
            ;;
        --activate)
            MODE="activate"
            ;;
        --force)
            FORCE=1
            ;;
        *)
            echo "ERROR: unknown argument: $1" >&2
            usage >&2
            exit 64
            ;;
    esac
    shift
done

# Anchor to repo root
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_ROOT}" ]; then
    echo "ERROR: not inside a git repo" >&2
    exit 1
fi

ENV_FILE="${REPO_ROOT}/.env"
CONFIG_FILE="${HOME}/.otacon/config.toml"

read_env_token() {
    if [ ! -f "${ENV_FILE}" ]; then
        echo ""
        return 0
    fi
    grep -E '^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=' "${ENV_FILE}" \
        | head -n1 \
        | cut -d'=' -f2- \
        || true
}

read_config_token() {
    if [ ! -f "${CONFIG_FILE}" ]; then
        echo ""
        return 0
    fi
    grep -E '^token = "' "${CONFIG_FILE}" \
        | head -n1 \
        | sed -E 's/^token = "(.*)"$/\1/' \
        || true
}

if [ "${MODE}" = "generate" ]; then
    # --- generate mode: write .env only ---
    EXISTING_ENV="$(read_env_token)"
    if [ -n "${EXISTING_ENV}" ] && [ "${FORCE}" -ne 1 ]; then
        cat >&2 <<EOF
ERROR: REGISTRY_BOOTSTRAP_ADMIN_TOKEN already set in .env. Use --force to regenerate.
       Or skip generation and run: ./scripts/bootstrap-admin-token.sh --activate
EOF
        exit 2
    fi

    TOKEN="otc_admin_$(openssl rand -hex 32)"

    if [ ! -f "${ENV_FILE}" ]; then
        printf 'REGISTRY_BOOTSTRAP_ADMIN_TOKEN=%s\n' "${TOKEN}" > "${ENV_FILE}"
    elif ! grep -qE '^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=' "${ENV_FILE}"; then
        printf 'REGISTRY_BOOTSTRAP_ADMIN_TOKEN=%s\n' "${TOKEN}" >> "${ENV_FILE}"
    else
        sed -i.bak "s|^REGISTRY_BOOTSTRAP_ADMIN_TOKEN=.*|REGISTRY_BOOTSTRAP_ADMIN_TOKEN=${TOKEN}|" "${ENV_FILE}"
        rm -f "${ENV_FILE}.bak"
    fi

    cat <<EOF
Generated: ${TOKEN}

Wrote: .env  (REGISTRY_BOOTSTRAP_ADMIN_TOKEN)

Next steps:
  1. Wipe registry's tokens.json so bootstrap fires:
       ssh otacon-pi 'docker exec otacon-registry rm -f /data/tokens.json'

  2. Deploy the registry — it will read the new token from .env:
       make registry-deploy

  3. Once registry is live with the new token, point your CLI at it:
       ./scripts/bootstrap-admin-token.sh --activate

Your existing ~/.otacon/config.toml is unchanged — old CLI token still works
until step 2 completes.
EOF
    exit 0
fi

if [ "${MODE}" = "activate" ]; then
    # --- activate mode: copy .env token into config.toml ---
    ENV_TOKEN="$(read_env_token)"
    if [ -z "${ENV_TOKEN}" ]; then
        echo "ERROR: REGISTRY_BOOTSTRAP_ADMIN_TOKEN is unset in ${ENV_FILE}." >&2
        echo "       Run: ./scripts/bootstrap-admin-token.sh   to generate one." >&2
        exit 6
    fi

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

    EXISTING_CFG_TOKEN="$(read_config_token)"
    if [ -n "${EXISTING_CFG_TOKEN}" ] \
        && [ "${EXISTING_CFG_TOKEN}" != "${ENV_TOKEN}" ] \
        && [ "${FORCE}" -ne 1 ]; then
        echo "ERROR: ${CONFIG_FILE} already has a token that differs from .env." >&2
        echo "       Re-run with --force to overwrite." >&2
        exit 5
    fi

    sed -i.bak "s|^token = \".*\"|token = \"${ENV_TOKEN}\"|" "${CONFIG_FILE}"
    rm -f "${CONFIG_FILE}.bak"

    cat <<EOF
Updated: ${CONFIG_FILE} (token = "${ENV_TOKEN}")

CLI now points at the seeded admin token.
Test: pnpm cli phones list
EOF
    exit 0
fi

echo "ERROR: unreachable mode: ${MODE}" >&2
exit 70
