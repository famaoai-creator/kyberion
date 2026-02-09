---
name: environment-provisioner
description: Generates Infrastructure as Code (Terraform, Docker, K8s) based on interactive requirements. The creative counterpart to terraform-arch-mapper.
status: implemented
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
- **High Availability**: Generates Multi-AZ and redundant configurations following [Availability Best Practices](../knowledge/operations/availability_best_practices.md).

## Usage
- "Provision a production-ready AWS VPC and RDS instance using Terraform."
- "Generate a Dockerfile for this Node.js app that follows security best practices."

## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
- References [Availability Best Practices](../knowledge/operations/availability_best_practices.md) for architectural redundancy and failover standards.
