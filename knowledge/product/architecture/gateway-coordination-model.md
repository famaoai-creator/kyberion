---
title: Gateway Coordination Model
category: Architecture
tags: [gateway, saas, api, assimilation, governance, oauth]
importance: 9
author: Ecosystem Architect
last_updated: 2026-05-04
---

# Gateway Coordination Model

## Executive Verdict

Kyberion must interact with external SaaS platforms and Web APIs (Gateways) dynamically and securely.

The strategic position is:
- **Do not hardcode API clients:** Rely on dynamic discovery and assimilation of OpenAPI/Swagger specs or documentation.
- **Maintain Strict Governance:** All external communications must pass through governed adapters (Gateway Adapters) defining explicit auth, scopes, and permitted endpoints.
- **Unified Capability Lifecycle:** SaaS integrations must follow the same PIVER (Provision, Inspect, Validate, Expose, Register) lifecycle as local CLI tools.

## Core Thesis

External APIs are **Gateway Capabilities**. They are not inherent to Kyberion but are assimilated into its ecosystem.

Every SaaS integration should be represented by a **Gateway Adapter Profile** that defines:
- The identity of the provider.
- The authentication mechanism (e.g., OAuth2, API Key).
- The list of permitted operations (endpoints).
- The risk classification and approval hooks required before making network calls.

## Lifecycle (Assimilation)

When a new SaaS is needed:
1. **Provision & Inspect:** Kyberion fetches the API documentation or OpenAPI specification.
2. **Validate & Synthesize:** A reasoning pipeline (`reasoning:synthesize`) parses the spec and generates a `Gateway Adapter Profile`. It also generates scaffolding for the user to input credentials (Client IDs/Secrets).
3. **Register:** The capability is registered in the `gateway-capability-registry.json`.
4. **Authenticate:** The user runs the scaffolded auth pipeline, triggering the OAuth Broker (`oauth-broker.ts`) to acquire tokens.
5. **Operate:** Kyberion uses the `service-actuator` to make requests using the securely stored tokens.

## Artifacts

- **`gateway-capability-registry.json`**: Central ledger of all assimilated external APIs.
- **`gateway-adapter-profile.schema.json`**: Schema defining the strict structure of an API adapter, including auth profiles and endpoint whitelists.
