---
name: environment-provisioner
description: Generates Infrastructure as Code (Terraform, Docker, K8s) based on interactive requirements. The creative counterpart to terraform-arch-mapper.
---

# Environment Provisioner

This skill helps you define and generate infrastructure. It translates high-level architectural needs into concrete IaC files.

## Capabilities

### 1. IaC Generation
- **Terraform**: AWS/Azure/GCP resource definitions.
- **Docker**: Optimized multi-stage Dockerfiles.
- **Kubernetes**: Deployment, Service, and Ingress manifests.

### 2. Best Practice Alignment
- Ensures security (non-root users in Docker).
- Resource limits in K8s.
- State management and modularity in Terraform.

## Usage
- "Provision a production-ready AWS VPC and RDS instance using Terraform."
- "Generate a Dockerfile for this Node.js app that follows security best practices."
