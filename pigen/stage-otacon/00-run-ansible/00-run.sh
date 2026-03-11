#!/bin/bash
# Pi-gen stage: install Ansible, copy the repo's ansible/ directory, and run site.yml.
# This makes Ansible the single source of truth — pi-gen just invokes it.
set -e

# Copy the ansible directory into the chroot
# build.sh copies ansible/ into the pi-gen root, so it's at ../../ansible relative to this stage
ANSIBLE_SRC="$(cd "$(dirname "$0")/../.." && pwd)/ansible"
install -d "${ROOTFS_DIR}/tmp/otacon-ansible"
cp -r "${ANSIBLE_SRC}/." "${ROOTFS_DIR}/tmp/otacon-ansible/"

on_chroot << 'CHEOF'
# Install Ansible
apt-get update
apt-get install -y ansible git

# Run the same playbook used on a live Pi
cd /tmp/otacon-ansible
ansible-playbook site.yml -c local

# Clean up
rm -rf /tmp/otacon-ansible
apt-get purge -y ansible
apt-get autoremove -y
apt-get clean
CHEOF
