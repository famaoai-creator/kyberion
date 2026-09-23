---
title: Remote Compute Actuator and Seam Provider Model
category: Architecture
tags: [architecture, compute, colab, remote-execution, seam-provider, actuators]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-24
---

# Remote Compute Actuator and Seam Provider Model

## 1. Goal

Establish an execution seam and an actuator (`compute-actuator`) in Kyberion to orchestrate heavy, batch-oriented computational workloads (e.g. LLM fine-tuning, batch embeddings, high-resolution media synthesis) across local and remote ephemeral compute substrates, specifically integrating Google Colab (leveraging Google AI Pro / Ultra subscription resources) as a first-class Seam Provider.

## 2. Core Principles & Placement

Kyberion separates **governed intent/contracts** from the **underlying physical execution runtime**.

- **Actuator Layer (`compute-actuator`)**: Declarative contract boundary exposing canonical ops (`submit_job`, `poll_status`, `collect_artifact`, `cancel_job`).
- **Seam Provider Layer (`compute-execution-provider`)**: Governed provider boundary conforming to `libs/core/seam-provider-selection.ts`.
  - `local`: Direct host execution (CPU / local Apple Silicon MPS / CUDA).
  - `colab`: Ephemeral headless or Drive-bridged execution on Google Colab GPU/TPU runtimes.
  - `modal` / `runpod` (future): Serverless container compute providers.
- **Data Bridge (Storage Seam)**:
  - Input payloads and generated weights/artifacts flow through governed storage adapters (local filesystem, Google Drive via `google_drive` sync adapter).

## 3. Actuator Capabilities (`compute-actuator`)

| Op                 | Phase     | Description                                                                                                                                      |
| :----------------- | :-------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit_job`       | `apply`   | Submits a compute job contract (script / notebook template + input parameters) to the resolved compute provider.                                 |
| `poll_status`      | `capture` | Queries execution state (queued, running, completed, failed, timeout) and logs.                                                                  |
| `collect_artifact` | `capture` | Downloads or verifies generated artifacts from provider scratch space into Kyberion `active/` or `knowledge/` roots via `@agent/core/secure-io`. |
| `cancel_job`       | `apply`   | Aborts an in-flight computation to preserve compute units.                                                                                       |

## 4. Google Colab Seam Provider Design

### 4.1 Execution Channels

1. **Google Drive Sync Channel (Recommended for Batch/Train)**:
   - Kyberion deposits `job-contract.json` and input payloads into a designated Google Drive path via the storage seam.
   - Colab notebook executing in background (Google AI Pro 24h background execution) detects the payload, executes GPU processing, and outputs artifacts back to Drive.
   - `compute-actuator` polls completion watermark and retrieves artifacts into Kyberion's asset store.
2. **Headless Browser Bridge Channel**:
   - For interactive or single-cell kickoffs, `browser-actuator` drives Playwright to open the notebook and trigger runtime execution under the authenticated Google session.

### 4.2 Resource & Quota Governance

- Evaluates compute quota and hardware requirements (`gpu_type: 't4' | 'a100' | 'v100' | 'tpu'`).
- Respects tenant isolation: cross-tenant artifacts are rejected at the `collect_artifact` boundary.

## 5. Lockfile Review Evidence

- `pnpm-lock.yaml` sha256: 6ab8b91fc6c11ea162976a26ab68d7723cd5681635c806e2049c17d09e4e931e
- **Rationale**: Added workspace package `libs/actuators/compute-actuator` with internal workspace dependency `@agent/core`. No external third-party dependencies were introduced.
