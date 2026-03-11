.PHONY: build up down logs push provision deploy-docker \
       phone-setup phone-reset health pigen pigen-flash

PI_HOST ?= tiny-pi
PI_USER ?= nick
REMOTE := $(PI_USER)@$(PI_HOST)
REMOTE_DIR := ~/otacon
SSH_CMD := ssh $(REMOTE)

# Docker (build locally, manage on Pi)
build:
	docker compose build

up:
	$(SSH_CMD) "cd $(REMOTE_DIR) && docker compose up -d"

down:
	$(SSH_CMD) "cd $(REMOTE_DIR) && docker compose down"

logs:
	$(SSH_CMD) "cd $(REMOTE_DIR) && docker compose logs -f"

# Deploy (all from Mac)
push:
	./scripts/deploy.sh $(PI_HOST) full

provision:
	./scripts/deploy.sh $(PI_HOST) ansible

deploy-docker:
	./scripts/deploy.sh $(PI_HOST) docker

# Phone
phone-setup:
	bash scripts/phone-setup.sh

phone-reset:
	bash scripts/phone-reset.sh

# Health (single SSH call to Pi)
health:
	@$(SSH_CMD) '\
		check() { if eval "$$2" >/dev/null 2>&1; then echo "  [OK] $$1"; else echo "  [FAIL] $$1"; fi; }; \
		echo "=== Otacon Health Check ==="; \
		check "Docker" "docker info"; \
		check "phone-mirror" "cd $(REMOTE_DIR) && docker compose ps --status running | grep -q phone-mirror"; \
		check "gnirehtet" "cd $(REMOTE_DIR) && docker compose ps --status running | grep -q gnirehtet"; \
		check "ADB device" "adb devices | grep -q device\$$"; \
		check "VNC port" "nc -z localhost $${VNC_PORT:-5900}"'

# Pi-gen
pigen:
	bash pigen/build.sh

pigen-flash:
	@echo "Usage: make pigen-flash DEVICE=/dev/sdX"
	@test -n "$(DEVICE)" || (echo "ERROR: Set DEVICE="; exit 1)
	bash pigen/build.sh flash $(DEVICE)
