# Procedure: Infrastructure Architecture Mapping

## 1. Goal
Generate a visual architecture diagram from IaC such as Terraform or CloudFormation.

## 2. Dependencies
- **Actuator**: `File-Actuator` or `Code-Actuator` for source discovery and structural extraction
- **Actuator**: `Modeling-Actuator` when semantic normalization is needed
- **Actuator**: `Media-Actuator` for Draw.io, Mermaid, or D2 rendering
- **Schema**: `knowledge/public/schemas/architecture-adf.schema.json`

## 3. Principle
Do not render directly from raw Terraform text.

Use a three-stage pipeline:

1. Source analysis
2. `architecture-adf` normalization
3. renderer-specific output

This keeps the public contract stable while allowing the renderer to become more native and AWS-aware.

## 4. Canonical Contract
The preferred intermediate representation is `architecture-adf`.

For cloud diagrams, the `architecture-adf` should capture:
- resource nodes such as `aws_elb`, `aws_autoscaling_group`, `aws_db_instance`
- infrastructure boundaries such as `AWS Account`, `Region`, `VPC`, `AZ`, `Subnet`
- semantic tiers such as `network`, `edge`, `security`, `web`, `application`, `data`, `control`, `state`
- module/runtime separation
  - Terraform module sources are implementation references
  - runtime AWS environments are the actual architecture

## 5. Step-by-Step Instructions
1. Parse IaC inputs and extract resources, data sources, modules, and references.
2. Normalize the result into `architecture-adf`.
3. Add explicit boundaries when the source implies them:
   - `AWS Account`
   - `Region`
   - `VPC`
   - `AZ`
   - `Public / Private Subnet`
4. Distinguish runtime infrastructure from Terraform module source structure.
5. Render:
   - `drawio_from_graph` for editable architecture diagrams
   - `mermaid_render` or `d2_render` for lightweight distribution artifacts
6. When rendering Draw.io for AWS:
   - prefer AWS service icons for leaf resources
   - prefer AWS group icons for boundaries and containers
   - group nodes by semantic tier instead of flat horizontal placement

## 6. Expected Output
A high-fidelity infrastructure diagram that is readable as both:
- an AWS architecture
- a Terraform implementation map

## 7. Notes
- Terraform modules should not automatically become separate AWS environments.
- When modules are used, show:
  - where they are called
  - what runtime components they expand into
  - what inputs and outputs shape that expansion
