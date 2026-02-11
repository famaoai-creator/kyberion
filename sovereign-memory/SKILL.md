name: sovereign-memory
description: Multi-tier, persistent memory hub. Manages facts across Personal, Confidential, and Public tiers in accordance with the Sovereign Knowledge Protocol.
status: implemented

# Sovereign Memory (Multi-Tier)

This skill provides a structured way to store and recall long-term facts based on the **3-Tier Sovereign Knowledge Protocol**.

## 3-Tier Hierarchy & Storage

1.  **Personal (`personal`)**: Private facts, habits, and user-specific context.
    - Storage: `knowledge/personal/memories/`
2.  **Confidential (`confidential`)**: Corporate/Client secrets (Solution names, internal rules).
    - Storage: `knowledge/confidential/memories/`
3.  **Public (`public`)**: Generic patterns, open standards, and non-sensitive data.
    - Storage: `knowledge/public/memories/`

## Capabilities

### 1. Persistent Storage (Capture)
Store facts into the appropriate tier based on sensitivity.
- **Command**: `node scripts/save.cjs <tier> <category> <fact>`
- **Example**: `node scripts/save.cjs confidential solution_mapping IB is Online Banking.`

### 2. Multi-Tier Retrieval (Recall)
Search for keywords across all memory tiers simultaneously.
- **Command**: `node scripts/search.cjs <query>`

## Knowledge Protocol
- This skill ensures high privacy by keeping `personal` and `confidential` data in restricted local directories.
- The skill implementation itself is generic and safe for public sharing.
