---
name: html-reporter
description: Report title
status: implemented
arguments: 
- name: title
short: t
type: string
required: false
category: Media
last_updated: '2026-02-28'
tags: gemini-skill
related_skills:
---

# Html Reporter

Generate standalone HTML reports from JSON/Markdown.

## Usage

node dist/index.js [options]

## Knowledge Protocol

- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
