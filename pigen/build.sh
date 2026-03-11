#!/bin/bash
# Build a custom Raspberry Pi image using pi-gen.
# Usage:
#   ./pigen/build.sh          # Local build
#   ./pigen/build.sh ci       # CI build (no interactive)
#   ./pigen/build.sh flash /dev/sdX  # Build + flash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIGEN_DIR="${SCRIPT_DIR}/pi-gen"
DEPLOY_DIR="${SCRIPT_DIR}/deploy"

MODE="${1:-local}"

# Clone pi-gen if not present
if [ ! -d "${PIGEN_DIR}" ]; then
    echo "Cloning pi-gen..."
    git clone --depth 1 https://github.com/RPi-Distro/pi-gen.git "${PIGEN_DIR}"
fi

# Copy our custom stage (includes reference to ../ansible via 00-run.sh)
rm -rf "${PIGEN_DIR}/stage-otacon"
cp -r "${SCRIPT_DIR}/stage-otacon" "${PIGEN_DIR}/stage-otacon"

# Copy ansible directory so the pi-gen stage can access it
rm -rf "${PIGEN_DIR}/ansible"
cp -r "${SCRIPT_DIR}/../ansible" "${PIGEN_DIR}/ansible"

# Write pi-gen config
cp "${SCRIPT_DIR}/config" "${PIGEN_DIR}/config"

# Skip stages 3-5 (desktop, etc), add our custom stage
touch "${PIGEN_DIR}/stage3/SKIP" "${PIGEN_DIR}/stage4/SKIP" "${PIGEN_DIR}/stage5/SKIP"
touch "${PIGEN_DIR}/stage3/SKIP_IMAGES" "${PIGEN_DIR}/stage4/SKIP_IMAGES" "${PIGEN_DIR}/stage5/SKIP_IMAGES"
touch "${PIGEN_DIR}/stage-otacon/EXPORT_IMAGE"

echo "Building pi-gen image..."
cd "${PIGEN_DIR}"

if [ "${MODE}" = "ci" ]; then
    sudo ./build-docker.sh
else
    sudo ./build.sh
fi

# Copy output
mkdir -p "${DEPLOY_DIR}"
cp "${PIGEN_DIR}/deploy/"*.img* "${DEPLOY_DIR}/" 2>/dev/null || true
echo "Image built: ${DEPLOY_DIR}/"
ls -lh "${DEPLOY_DIR}/"

# Flash if requested
if [ "${MODE}" = "flash" ] && [ -n "${2:-}" ]; then
    DEVICE="$2"
    IMAGE=$(ls -1 "${DEPLOY_DIR}/"*.img 2>/dev/null | head -1)
    if [ -z "${IMAGE}" ]; then
        IMAGE=$(ls -1 "${DEPLOY_DIR}/"*.img.xz | head -1)
        echo "Flashing ${IMAGE} to ${DEVICE}..."
        xzcat "${IMAGE}" | sudo dd of="${DEVICE}" bs=4M status=progress
    else
        echo "Flashing ${IMAGE} to ${DEVICE}..."
        sudo dd if="${IMAGE}" of="${DEVICE}" bs=4M status=progress
    fi
    sync
    echo "Flash complete."
fi
