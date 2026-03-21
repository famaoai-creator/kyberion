# Procedure: Infrastructure Architecture Mapping

## 1. Goal
Generate a visual architecture diagram from IaC (Terraform, CloudFormation) files.

## 2. Dependencies
- **Actuator**: `File-Actuator` (Parsing)
- **Actuator**: `Media-Actuator` (Rendering)

## 3. Step-by-Step Instructions
1.  **Parsing**: Use `File-Actuator` to read `.tf` or `.yaml` files.
2.  **Relationship Extraction**: Identify connections (e.g., `security_group_id`, `vpc_id`) between resources.
3.  **Mermaid Generation**: Draft a Mermaid `graph TD` representing the infrastructure topology.
4.  **Rendering**: Use `Media-Actuator` with `mermaid_render` to produce an SVG/PNG.

## 4. Expected Output
A high-fidelity infrastructure diagram.
