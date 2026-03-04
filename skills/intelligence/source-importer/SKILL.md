---
name: source-importer
description: Local name
status: implemented
category: Intelligence
last_updated: '2026-02-28'
tags: gemini-skill
arguments: 
- name: name
short: 'n'
type: string
required: true
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
npm run cli -- run source-importer --repo https://github.com/example/project
```
