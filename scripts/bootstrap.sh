#!/bin/bash
# First-run bootstrap: installs Ansible, then runs the playbook.
# Usage: curl -sL <raw-url>/scripts/bootstrap.sh | bash
set -euo pipefail

echo "=== Otacon Bootstrap ==="

# Install git and Ansible if not present
sudo apt-get update
for pkg in git ansible; do
    if ! command -v "${pkg}" &>/dev/null; then
        echo "Installing ${pkg}..."
        sudo apt-get install -y "${pkg}"
    fi
done

# Clone repo if not present
REPO_DIR="${HOME}/code/otacon"
if [ ! -d "${REPO_DIR}" ]; then
    echo "Cloning otacon repo..."
    mkdir -p "${HOME}/code"
    git clone https://github.com/thisnick/otacon.git "${REPO_DIR}"
fi

# Run Ansible
echo "Running Ansible bootstrap..."
cd "${REPO_DIR}/ansible"
ansible-playbook site.yml -c local

echo "=== Bootstrap complete ==="
echo "Next steps:"
echo "  cd ${REPO_DIR}"
echo "  docker compose up -d"
