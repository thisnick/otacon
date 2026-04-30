terraform {
  required_version = ">= 1.8"

  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = var.encryption_passphrase
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.5"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

# --- Providers ---

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key      = var.private_key
  private_key_path = var.private_key_path
  region           = var.region
}

# --- Data Sources ---

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# --- SSH Key ---

resource "tls_private_key" "deploy" {
  algorithm = "ED25519"
}

# --- Networking ---

resource "oci_core_vcn" "orchestrator" {
  compartment_id = var.compartment_ocid
  display_name   = "otacon-orchestrator-vcn"
  cidr_blocks    = ["10.1.0.0/16"]
  dns_label      = "orchestr"
}

resource "oci_core_internet_gateway" "orchestrator" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.orchestrator.id
  display_name   = "otacon-orchestrator-igw"
  enabled        = true
}

resource "oci_core_route_table" "orchestrator" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.orchestrator.id
  display_name   = "otacon-orchestrator-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.orchestrator.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_security_list" "orchestrator" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.orchestrator.id
  display_name   = "otacon-orchestrator-sl"

  # Allow all egress (containers pulling from ghcr.io, AI Gateway calls,
  # Tailscale outbound, etc.)
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    stateless   = false
  }

  # Tailscale UDP 41641 is the only public ingress. Everything else
  # (orchestrator HTTP on 9090) reaches the VM over the tailnet.
  ingress_security_rules {
    source    = "0.0.0.0/0"
    protocol  = "17" # UDP
    stateless = false

    udp_options {
      min = 41641
      max = 41641
    }
  }
}

resource "oci_core_subnet" "orchestrator" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.orchestrator.id
  display_name               = "otacon-orchestrator-subnet"
  cidr_block                 = "10.1.1.0/24"
  dns_label                  = "sub1"
  route_table_id             = oci_core_route_table.orchestrator.id
  security_list_ids          = [oci_core_security_list.orchestrator.id]
  prohibit_public_ip_on_vnic = false
}

# --- Compute Instance ---

resource "oci_core_instance" "orchestrator" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "otacon-orchestrator"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gb
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id                 = oci_core_subnet.orchestrator.id
    assign_public_ip          = true
    assign_ipv6ip             = false
    display_name              = "otacon-orchestrator-vnic"
    assign_private_dns_record = true
  }

  metadata = {
    ssh_authorized_keys = join("\n", concat(
      [tls_private_key.deploy.public_key_openssh],
      var.extra_ssh_public_keys,
    ))
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
      tailscale_auth_key = var.tailscale_auth_key
      hostname           = "otacon-orchestrator"
      tailnet_domain     = var.tailnet_domain
      ghcr_pull_token    = var.ghcr_pull_token
      ghcr_pull_user     = var.ghcr_pull_user
      otacon_repo        = var.otacon_repo
      otacon_token       = var.otacon_token
      ai_gateway_api_key = var.ai_gateway_api_key
    }))
  }

  # `metadata` ignored so re-applies don't recycle the VM when secrets
  # rotate (cloud-init only runs on first boot anyway). `source_id`
  # ignored so a newer Ubuntu LTS image hash doesn't force replacement.
  lifecycle {
    ignore_changes = [source_details[0].source_id, metadata]
  }
}
