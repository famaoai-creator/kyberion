---
name: tech-stack-librarian
description: >-

status: implemented
arguments:
  - name: dir
    short: d
    type: string
    required: false
    description:
category: Utilities
last_updated: '2026-02-16'
tags:
  - documentation
  - gemini-skill
---

# Tech Stack Librarian

This skill keeps your knowledge base up-to-date with the latest tools and technologies.

## Capabilities

### 1. Documentation Harvesting

- Uses `google_web_search` and `web_fetch` to find official documentation, "Getting Started" guides, and "Best Practices" for a specified tool.
- Summarizes key architectural patterns, configuration recommendations, and known pitfalls.

### 2. Knowledge Structuring

- Creates a structured Markdown file in `knowledge/tech-stack/<tool_name>.md`.
- Sections included: Installation, Configuration, Best Practices, and Troubleshooting.

## Usage

- "Research 'Kubernetes' and add its best practices to our knowledge base."
- "We are adopting 'Supabase'. Create a tech stack guide for it."

## Knowledge Protocol

- Adheres to `knowledge/orchestration/knowledge-protocol.md`.
