# Procedure: Render Terraform Architecture Diagram

## 1. Goal
Turn a Terraform root directory into an editable Draw.io architecture diagram using Kyberion-native contracts.

## 2. Dependencies
- **Actuator**: `Modeling-Actuator`
- **Actuator**: `Media-Actuator`
- **Schema**: `knowledge/public/schemas/architecture-adf.schema.json`

## 3. Principle
Use a two-step contract:

1. `terraform -> architecture-adf`
2. `architecture-adf -> drawio`

Do not render directly from raw Terraform text.

## 4. Step-by-Step Instructions
1. Generate `architecture-adf` from a Terraform directory with `terraform_to_architecture_adf`.
2. Persist the ADF as JSON.
3. Render the ADF with `drawio_from_graph`.
4. Write the resulting Draw.io XML with `drawio_write`.

## 5. Example Flow
First, generate the ADF:

```bash
node dist/libs/actuators/modeling-actuator/src/index.js \
  --input libs/actuators/modeling-actuator/examples/terraform-to-architecture-adf.json
```

Then render it to Draw.io:

```bash
node dist/libs/actuators/media-actuator/src/index.js \
  --input libs/actuators/media-actuator/examples/terraform-architecture-adf-to-drawio.json
```

## 6. Example Artifacts
- [`terraform-to-architecture-adf.json`](../../../../libs/actuators/modeling-actuator/examples/terraform-to-architecture-adf.json)
- [`terraform-architecture-adf-to-drawio.json`](../../../../libs/actuators/media-actuator/examples/terraform-architecture-adf-to-drawio.json)

## 7. Expected Output
- an `architecture-adf` JSON artifact
- an editable `.drawio` architecture diagram

## 8. Notes
- `terraform_to_architecture_adf` is designed to preserve runtime AWS topology rather than Terraform folder layout.
- Terraform module sources are represented separately from the runtime AWS environment.
