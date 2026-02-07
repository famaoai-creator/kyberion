---
name: deep-archive-librarian
description: Manages the lifecycle of long-term knowledge. Archives stale logs and documents while maintaining a high-speed search index of their existence.
---

# Deep Archive Librarian

This skill fights "Knowledge Decay" and "Cognitive Overload."

## Capabilities

### 1. Auto-Archiving
- Scans `evidence/simulations/` and logs for items older than 6 months.
- Moves them to `archive/` (compressed) to keep the active context clean.

### 2. Metadata Indexing
- Before archiving, extracts key "Lessons Learned" and adds them to `knowledge/memory_index.json`.
- Ensures that even if the file is gone, the *wisdom* remains accessible.

## Usage
- "Clean up the workspace by archiving old simulation logs."
- "Search the deep archive for any past attempts at 'Quantum Encryption'."

## Knowledge Protocol
- Adheres to `knowledge/orchestration/knowledge-protocol.md`.
