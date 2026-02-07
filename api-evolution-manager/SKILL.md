---
name: api-evolution-manager
description: Governs the evolution of public APIs. Detects breaking changes, manages deprecation cycles, and generates migration guides for clients.
---

# API Evolution Manager

This skill ensures that your API grows gracefully without breaking downstream consumers.

## Capabilities

### 1. Breaking Change Detection
- Compares current API schemas (OpenAPI, GraphQL) with previous versions.
- Flags any changes that would break backward compatibility.

### 2. Lifecycle Management
- Manages deprecation notices and sunsetting schedules.
- Automatically generates "Migration Guides" for developers using the API.

## Usage
- "Audit the latest API changes for breaking changes and update the versioning plan."
- "Generate a migration guide for clients moving from v1.0 to v2.0."
