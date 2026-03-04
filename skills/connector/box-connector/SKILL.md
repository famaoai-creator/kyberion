---
name: box-connector
description: 
status: implemented
arguments: 
- name: out
short: o
type: string
required: false
category: Connector
last_updated: '2026-02-28'
tags: gemini-skill
---

# Box Connector

This skill automates file operations on Box, bridging your cloud storage with local workflows.

## Capabilities

### 1. Secure Authentication

- Uses `knowledge/personal/box_config.json` (JWT config) to authenticate without hardcoding credentials.
- Supports "App User" and "Enterprise" contexts.

### 2. File Retrieval

- **Download**: Fetches specific files by ID or name.
- **Search**: Finds files based on queries and downloads the latest version.

## Usage

- "Download the file 'Q3_Financials.xlsx' from Box."
- "Search Box for 'Project_X_Specs' and save it to `work/docs/`."

## Knowledge Protocol

- Adheres to `knowledge/tech-stack/box_api.md`.
