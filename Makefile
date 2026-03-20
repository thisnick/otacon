.PHONY: build up down logs push provision deploy-docker setup-pi \
       phone-setup phone-reset health pigen pigen-flash pigen-config \
       bluetooth-pair bluetooth-connect bluetooth-status bluetooth-watch

PI_HOST ?= otacon-pi
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

# One-time Pi setup (ghcr.io login for pulling dev images)
setup-pi:
	ssh -t $(REMOTE) "docker login ghcr.io"

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
		check "otacon" "cd $(REMOTE_DIR) && docker compose ps --status running | grep -q otacon"; \
		check "ADB device" "adb devices | grep -q device\$$"; \
		check "VNC port" "nc -z localhost $${VNC_PORT:-5900}"; \
		check "Audio port" "nc -z localhost $${AUDIO_PORT:-8080}"'

# Pi-gen
pigen:
	bash pigen/build.sh

pigen-flash:
	@echo "Usage: make pigen-flash DEVICE=/dev/sdX"
	@test -n "$(DEVICE)" || (echo "ERROR: Set DEVICE="; exit 1)
	bash pigen/build.sh flash $(DEVICE)

bluetooth-pair:
	$(SSH_CMD) "cd $(REMOTE_DIR) && docker compose exec otacon /opt/bluetooth-pair.sh"

bluetooth-connect:
	$(SSH_CMD) "cd $(REMOTE_DIR) && docker compose exec otacon /opt/bluetooth-connect.sh"

bluetooth-status:
	$(SSH_CMD) "cd $(REMOTE_DIR) && docker compose exec otacon /opt/bluetooth-status.sh"

bluetooth-watch:
	$(SSH_CMD) -t "watch -n 2 'cd $(REMOTE_DIR) && docker compose exec -T otacon /opt/bluetooth-status.sh'"

pigen-config:
	@test -n "$(DEVICE)" || (echo "ERROR: Set DEVICE= to boot partition mount point"; exit 1)
	@mkdir -p "$(DEVICE)/otacon"
	@echo "TS_AUTH_KEY=$${TS_AUTH_KEY:?Set TS_AUTH_KEY}" > "$(DEVICE)/otacon/startup.conf"
	@[ -n "$${TS_HOSTNAME}" ] && echo "TS_HOSTNAME=$${TS_HOSTNAME}" >> "$(DEVICE)/otacon/startup.conf" || true
	@[ -n "$${VNC_PASSWORD}" ] && echo "VNC_PASSWORD=$${VNC_PASSWORD}" >> "$(DEVICE)/otacon/startup.conf" || true
	@[ -n "$${OTACON_REPO}" ] && echo "OTACON_REPO=$${OTACON_REPO}" >> "$(DEVICE)/otacon/startup.conf" || true
	@echo "Wrote $(DEVICE)/otacon/startup.conf"
