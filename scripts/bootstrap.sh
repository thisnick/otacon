#!/bin/bash
# First-run bootstrap: installs Ansible, then runs the playbook.
# Usage: curl -sL <raw-url>/scripts/bootstrap.sh | bash
set -euo pipefail

echo "=== Otacon Bootstrap ==="

# Install Ansible if not present
if ! command -v ansible-playbook &>/dev/null; then
    echo "Installing Ansible..."
    sudo apt-get update
    sudo apt-get install -y ansible
fi

# Clone repo if not present
REPO_DIR="${HOME}/code/otacon"
if [ ! -d "${REPO_DIR}" ]; then
    echo "Cloning otacon repo..."
    mkdir -p "${HOME}/code"
    git clone https://github.com/YOUR_USER/otacon.git "${REPO_DIR}"
fi

# Run Ansible
echo "Running Ansible bootstrap..."
cd "${REPO_DIR}/ansible"
ansible-playbook site.yml -c local

echo "=== Bootstrap complete ==="
echo "Next steps:"
echo "  cd ${REPO_DIR}"
echo "  docker compose up -d"
