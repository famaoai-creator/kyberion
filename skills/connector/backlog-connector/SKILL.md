---
name: backlog-connector
description: Project Key (e.g., NBS_INCIDENT)
status: implemented
arguments: 
- name: out
short: o
type: string
required: true
default: 100
choices: 
category: Connector
last_updated: '2026-02-28'
tags: gemini-skill
---

# Backlog Connector

This skill automates interactions with the Backlog API using credentials stored in the Personal/Confidential tiers.

## Usage

- "Use `backlog-connector` to fetch all issues from NBS_INCIDENT."
- "Get the user list from the project."

## Knowledge Protocol

- Reads `knowledge/personal/connections/backlog.md` for API Key.
- Reads `knowledge/confidential/connections/inventory.json` for Project ID mapping.
