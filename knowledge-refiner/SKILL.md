---
name: knowledge-refiner
description: Maintains and consolidates the knowledge base. Cleans up unstructured data and merges it into structured glossaries or patterns.
---

# Knowledge Refiner

This skill keeps the `knowledge/` directory clean and useful.

## Capabilities

### 1. Knowledge Consolidation
- Merges multiple markdown notes into a single structured JSON/YAML glossary.
- Removes duplicate entries and resolves conflicts.

### 2. Pattern Extraction
- Analyzes unstructured text in `work/` or `knowledge/` to extract new reusable patterns for `security-scanner` or `iac-analyzer`.

## Usage
- "Refine the requirements knowledge base by merging all notes into `ipa_best_practices.md`."
- "Extract common error patterns from these logs and save them to `knowledge/security/scan-patterns.yaml`."
