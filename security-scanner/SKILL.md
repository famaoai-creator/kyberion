---
name: security-scanner
description: Scans the codebase for security risks, including hardcoded secrets (API keys, tokens), dangerous code patterns (eval, shell injection), and insecure configurations. Use to audit code before committing or reviewing.
---

# Security Scanner

## Overview
This skill performs a security audit on the current project using **Trivy** (if available) or a lightweight internal scanner. It detects vulnerabilities, secrets, and dangerous patterns.

## Capabilities

### 1. Advanced Scan (via Trivy)
If `trivy` is installed, this skill leverages it for enterprise-grade auditing:
- **Vulnerabilities (SCA)**: Checks `package.json`, `go.mod`, `requirements.txt`, etc., for known CVEs.
- **Misconfigurations (IaC)**: Scans Dockerfiles, Terraform, and Kubernetes manifests for security best practices.
- **Secret Scanning**: Deep inspection for leaked API keys and tokens.
- **License Compliance**: Checks for license risks in dependencies.

### 2. Lightweight Scan (Fallback)
If `trivy` is missing, it falls back to a fast, pattern-based internal scanner:
- **Secret Detection**: AWS keys, GitHub tokens, generic secrets.
- **Dangerous Code**: `eval()`, `dangerouslySetInnerHTML`, command injection risks.

## Usage

Run the scanner from the root of your project.

```bash
node scripts/scan.cjs
```

## Configuration
- **Trivy**: Uses default settings.
- **Internal Scanner**:
    - **Proprietary Patterns**: Automatically checks `knowledge/confidential/skills/security-scanner/` for internal regex rules. These rules are prioritized over general ones to detect company-specific security risks.
    - **General Patterns**: Uses `knowledge/security/scan-patterns.yaml`.
