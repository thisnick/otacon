output "instance_public_ip" {
  description = "Public IP of the orchestrator VM (for Tailscale UDP ingress only — orchestrator HTTP is reachable via tailnet)"
  value       = oci_core_instance.orchestrator.public_ip
}

output "tailnet_url" {
  description = "Tailscale-magic-DNS URL for the orchestrator HTTP server. The host's `tailscale serve --https=443 http://127.0.0.1:9090` (set up by cloud-init) terminates TLS on 443, so users hit the URL with no port number."
  value       = "https://otacon-orchestrator.${var.tailnet_domain}/"
}

output "ssh_private_key" {
  description = "SSH private key for direct (non-Tailscale) deploy/debug access to the VM"
  value       = tls_private_key.deploy.private_key_openssh
  sensitive   = true
}

output "ssh_command" {
  description = "Convenience SSH-via-Tailscale command (cloud-init enables Tailscale SSH)"
  value       = "ssh ubuntu@otacon-orchestrator.${var.tailnet_domain}"
}

output "instance_id" {
  description = "OCID of the compute instance"
  value       = oci_core_instance.orchestrator.id
}

output "image_id" {
  description = "Image OCID used for the instance"
  value       = data.oci_core_images.ubuntu.images[0].id
}
