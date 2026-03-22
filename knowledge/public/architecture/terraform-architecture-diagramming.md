# Terraform Architecture Diagramming

## Goal
Represent Terraform-based infrastructure as architecture diagrams without leaking renderer-specific implementation details into the public contract.

## Core Concept
Use `architecture-adf` as the stable interface between:

- source analysis
- semantic normalization
- diagram rendering

The renderer may become highly native, but the contract should remain human-readable and backend-independent.

## Recommended Pipeline
1. Analyze Terraform structure.
2. Build `architecture-adf`.
3. Render with `media-actuator`.

The preferred long-term flow is:

`terraform source -> architecture-adf -> drawio | mermaid | d2`

## Why This Matters
Directly drawing from Terraform blocks tends to produce:

- flat resource lists
- module-shaped diagrams instead of runtime-shaped diagrams
- poor AWS boundary visibility
- renderer lock-in

`architecture-adf` lets the system express:

- runtime AWS boundaries
- semantic placement
- module source versus runtime expansion
- synthetic infrastructure hints when the source is incomplete

## Rendering Model
For AWS architecture diagrams, the renderer should support:

- boundary containers:
  - `AWS Account`
  - `Region`
  - `VPC`
  - `AZ`
  - `Subnet`
- semantic lanes:
  - `network`
  - `edge`
  - `security`
  - `web`
  - `application`
  - `data`
  - `control`
  - `state`
- AWS service icons for resources
- AWS group icons for containers

## Terraform Module Handling
Terraform modules are not runtime infrastructure boundaries.

They should be represented as:

- module source references
- caller relationships
- optional expanded runtime views showing what the module instantiates

This avoids the common mistake of drawing each module directory as a separate AWS environment.

## Current Kyberion Direction
The current `media-actuator` draw.io renderer is evolving toward:

- richer AWS-aware boundary rendering
- tier-based layout instead of naive horizontal placement
- better icon fallback behavior
- clearer distinction between source relationships and runtime topology

The Terraform-to-`architecture-adf` step is still a candidate for formal actuatorization. The intended long-term actuator path is:

- `code-actuator` or `modeling-actuator`
  - `terraform_to_architecture_adf`
- `media-actuator`
  - `drawio_from_graph`
  - `drawio_write`
  - `mermaid_render`
  - `d2_render`

## Design Guardrails
- Keep renderer-specific XML out of the public contract.
- Prefer semantic tiers over directory-shaped grouping.
- Prefer runtime AWS topology over Terraform file layout.
- Use synthetic nodes or boundaries only when they clarify the runtime architecture.
- Preserve editability for Draw.io outputs while also allowing simpler static exports.
