---
title: Service Runtime Abstraction
category: Architecture
tags: [runtime, service, comfyui, provision, install, policy]
importance: 7
last_updated: 2026-07-02
---

# Service Runtime Abstraction

Kyberion treats long-lived services such as ComfyUI as governed runtime entities instead of ad hoc host processes.

Canonical placement rules for managed services live in [`../governance/dependency-placement-policy.md`](../governance/dependency-placement-policy.md).

## Core Idea

The user intent is about the service outcome:

- trial a local service before provisioning it
- provision and approve a service into a governed environment
- reuse an already installed or running service
- pin the service version and managed location

The service runtime layer resolves the concrete probe URL, managed location, and lifecycle state.

## Layers

1. `service-runtime-policy`
   - Governs managed roots, cache roots, and approval requirements.
   - Example: `KYBERION_SERVICE_RUNTIME_POLICY_PATH`.

2. `service-runtime-registry`
   - Declares per-service probe plans, provisioning plans, and managed service roots.
   - First governed entry: `comfyui`.
   - The registry is also queryable as an inventory so operator surfaces can present `trial`, `approved_install`, `installed`, and `pinned` lifecycle states in one place.

3. `service-runtime-state`
   - Records whether a service has been provisioned or pinned, and where it lives.
   - State is stored under `active/shared/runtime/` with per-service state in `service-runtimes/<service>/state.json`.

## Example: `comfyui`

ComfyUI is the canonical image-generation service example.

- trial availability is checked via `GET /system_stats`
- the service preset defines the image-generation operations
- the managed service root keeps lifecycle and provenance separate from the service endpoint catalog

The image generation bridge can use `probeServiceRuntime('comfyui')` to decide whether ComfyUI should be selected before falling back to local FLUX or cloud providers.

## Design Rule

Never bind user intent directly to a host process or startup script.
Bind intent to the service outcome, then let the service runtime layer decide whether the service should be tried, provisioned, reused, or pinned.
