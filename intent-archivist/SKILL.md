---
name: intent-archivist
description: Captures and indexes the "Rationale" behind technical decisions. Analyzes discussions, PR comments, and meeting notes to preserve the "Why" for future teams.
---

# Intent Archivist

This skill prevents the loss of institutional knowledge by capturing the context and reasoning behind major technical choices.

## Capabilities

### 1. Rationale Extraction
- Analyzes PR threads, Slack exports, and design documents to identify why a specific path was chosen.
- Distinguishes between "temporary workarounds" and "strategic architectural decisions."

### 2. Decision Indexing
- Creates a searchable "Decision Log" that links code modules to the original discussions and rejected alternatives.

## Usage
- "Analyze the PR history of the `auth` module and summarize why we chose OAuth2 over SAML."
- "Preserve the rationale for this new microservices migration in our Decision Log."
