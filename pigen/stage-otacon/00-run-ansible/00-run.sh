#!/bin/bash
# Pi-gen stage: install Ansible, copy the repo's ansible/ directory, and run site.yml.
# This makes Ansible the single source of truth — pi-gen just invokes it.
set -e

on_chroot << 'CHEOF'
apt-get update
apt-get install -y ansible python3-apt
CHEOF

install -d "${ROOTFS_DIR}/tmp/otacon-ansible"
cp -r "${STAGE_DIR}/ansible/." "${ROOTFS_DIR}/tmp/otacon-ansible/"

on_chroot << 'CHEOF'
cd /tmp/otacon-ansible
ansible-playbook site.yml -c local -i "localhost," -e pigen_chroot=true
CHEOF

on_chroot << 'CHEOF'
apt-get purge -y ansible
apt-get autoremove -y
rm -rf /tmp/otacon-ansible
CHEOF
