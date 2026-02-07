---
name: knowledge-fetcher
description: Fetch knowledge from both public and confidential directories. Bridges general best practices with proprietary internal standards.
---

# Knowledge Fetcher (Hybrid Bridge)

This skill acts as the gateway to the monorepo's collective intelligence, supporting a tiered access model between public and confidential data.

## Capabilities

### 1. Hybrid Search
Automatically searches for relevant documentation in two locations:
- **Public Tier**: `knowledge/` (Synced with Git, general standards like IPA/FISC).
- **Confidential Tier**: `knowledge/confidential/` (Local only, ignored by Git, contains proprietary info).

### 2. Multi-Source Consolidation
- Merges findings from both tiers to provide a complete context.
- Prioritizes confidential standards if a conflict exists with public ones (e.g., specific company policies overriding generic ones).

## Usage
- "Fetch all knowledge regarding [Topic], including any internal confidential standards."
- "What is our company's specific policy on [Security Method]? Check the confidential tier."

## Safety
- This skill NEVER outputs the full content of confidential files if it detects a public-facing task (like drafting an issue on GitHub). It provides summarized, safe insights instead.