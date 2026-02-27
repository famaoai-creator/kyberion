---
name: source-importer
description: >-

status: implemented
category: Intelligence
last_updated: '2026-02-16'
tags:
  - gemini-skill
  - security
arguments:
  - name: repo
    short: r
    type: string
    required: true
    description: Repository URL
  - name: name
    short: 'n'
    type: string
    description: Local name
---

# source-importer

## Overview

This skill implements the **Quarantine Protocol** for external data sources. It ensures that no external code is analyzed or used until it has passed initial security and sensitivity checks.

## Capabilities

- **Secure Cloning**: Clones repositories directly into `active/quarantine/`.
- **Mandatory Gating**: Automatically triggers `security-scanner` and `sensitivity-detector` upon import.
- **Provenance Registry**: Records source metadata (URL, timestamp, scan results) in `source_registry.json`.

## Arguments

| Name   | Type   | Description                                             |
| :----- | :----- | :------------------------------------------------------ |
| --repo | string | (Required) The GitHub repository URL to clone.          |
| --name | string | (Optional) Local directory name. Defaults to repo name. |

## Usage

```bash
node scripts/cli.cjs run source-importer --repo https://github.com/example/project
```
