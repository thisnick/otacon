# --- OCI Authentication ---

variable "encryption_passphrase" {
  description = "Passphrase for encrypting state/plan files"
  sensitive   = true
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
}

variable "user_ocid" {
  description = "OCI user OCID"
}

variable "fingerprint" {
  description = "OCI API key fingerprint"
}

variable "private_key" {
  description = "OCI API signing key (PEM content, used in CI)"
  sensitive   = true
  default     = null
}

variable "private_key_path" {
  description = "Path to OCI API signing key PEM file (used locally)"
  default     = null
}

variable "region" {
  description = "OCI region identifier"
  default     = "us-sanjose-1"
}

variable "compartment_ocid" {
  description = "OCI compartment OCID (defaults to tenancy root)"
}

# --- Instance ---

variable "instance_ocpus" {
  description = "Number of OCPUs for the ARM instance"
  default     = 2
}

variable "instance_memory_gb" {
  description = "Memory in GB for the ARM instance"
  default     = 12
}

variable "boot_volume_size_gb" {
  description = "Boot volume size in GB"
  default     = 50
}

variable "extra_ssh_public_keys" {
  description = "Additional SSH public keys for instance access"
  type        = list(string)
  default     = []
}

# --- Tailscale ---

variable "tailscale_auth_key" {
  description = "Tailscale pre-auth key for automatic enrollment. The plan reuses TS_AUTH_KEY_REGISTRY from the local .env via direnv."
  sensitive   = true
}

variable "tailnet_domain" {
  description = "Tailscale tailnet domain (e.g. tail0437b8.ts.net)"
  default     = "tail0437b8.ts.net"
}

# --- Container image registry (ghcr.io) ---

variable "ghcr_pull_token" {
  description = "GitHub Container Registry pull token (read:packages scope) for `docker login ghcr.io` on the VM. Used by Watchtower to pull updated orchestrator images."
  sensitive   = true
  default     = null
}

variable "ghcr_pull_user" {
  description = "GitHub username paired with ghcr_pull_token"
  default     = null
}

variable "otacon_repo" {
  description = "Image repo slug under ghcr.io/thisnick/<repo>/orchestrator. Defaults to 'otacon-dev'; production deploys override to 'otacon'."
  default     = "otacon-dev"
}

# --- Orchestrator runtime secrets ---
#
# Cloud-init writes these into /opt/orchestrator/.env so docker compose
# picks them up. They never appear in plan/state output thanks to the
# `sensitive = true` flag above (and OpenTofu's encrypted state +
# plan files configured in main.tf).

variable "otacon_token" {
  description = "Bearer token the orchestrator presents when calling the otacon registry (OTACON_TOKEN). Phase 5 deploy uses the same token the local CLI does."
  sensitive   = true
  default     = ""
}

variable "ai_gateway_api_key" {
  description = "Vercel AI Gateway API key (AI_GATEWAY_API_KEY) for model calls."
  sensitive   = true
  default     = ""
}
