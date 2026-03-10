.PHONY: build up down logs deploy-ssh sync push provision provision-check \
       phone-setup phone-reset health pigen pigen-flash

PI_HOST ?= tiny-pi
PI_USER ?= nick

# Docker
build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

# Deploy (dev — run from Mac)
sync:
	./scripts/deploy.sh $(PI_HOST) ansible

deploy-ssh:
	./scripts/deploy.sh $(PI_HOST) docker

push:
	./scripts/deploy.sh $(PI_HOST) full

# Ansible (run on Pi)
provision:
	cd ansible && ansible-playbook site.yml -c local

provision-check:
	cd ansible && ansible-playbook site.yml -c local --check --diff

# Phone
phone-setup:
	bash scripts/phone-setup.sh

phone-reset:
	bash scripts/phone-reset.sh

# Health
health:
	bash scripts/health-check.sh

# Pi-gen
pigen:
	bash pigen/build.sh

pigen-flash:
	@echo "Usage: make pigen-flash DEVICE=/dev/sdX"
	@test -n "$(DEVICE)" || (echo "ERROR: Set DEVICE="; exit 1)
	bash pigen/build.sh flash $(DEVICE)
