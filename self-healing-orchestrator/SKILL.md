---
name: self-healing-orchestrator
description: Automatically repairs known production issues by applying patches, rollbacks, or config changes. The autonomous counterpart to crisis-manager.
---

# Self-Healing Orchestrator

This skill acts as an autonomous first-responder to production alerts.

## Capabilities

### 1. Pattern-Based Repair
- Matches incoming error patterns with established "Healing Runbooks."
- Can automatically restart services, scale resources, or rollback a specific deployment.

### 2. Autonomous Patching
- For known minor bugs (e.g., edge-case NULL pointers), it can generate, test, and deploy a temporary hotfix.

## Usage
- "Automate the response to 'Database Connection Timeout' alerts using `self-healing-orchestrator`."
- "A minor bug was detected in production; can the orchestrator apply a safe hotfix?"
