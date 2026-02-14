---
name: shadow-dispatcher
description: Executes a task in parallel using two different agent personas (Shadow Execution) and synthesizes the results via ACE.
status: implemented
category: QA/Governance
last_updated: '2026-02-14'
---

# shadow-dispatcher

## Overview
Runs "Shadow Execution" pattern. It launches two sub-agents with conflicting philosophies (e.g., Speed vs. Security) to solve the same problem, then uses the ACE Engine to judge or merge the outputs.

## Capabilities
- **Dual-Dispatch**: Launches Persona A and Persona B simultaneously via Gemini Pulse.
- **Conflict Resolution**: Feeds both outputs into ACE for a final decision.
- **Evidence Chaining**: Records the lineage of the decision.

## Arguments
| Name | Type | Description |
| :--- | :--- | :--- |
| --intent | string | (Required) The task description. |
| --personaA | string | (Optional) First persona. Default: "Efficiency Optimizer". |
| --personaB | string | (Optional) Second persona. Default: "Security Reviewer". |

## Usage
```bash
node scripts/cli.cjs run shadow-dispatcher --intent "Refactor the login module"
```
