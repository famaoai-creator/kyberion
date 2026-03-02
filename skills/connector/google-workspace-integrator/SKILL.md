---
name: google-workspace-integrator
description: Connects to Google Workspace (Calendar, Gmail) for executive secretary automation.
status: unstable
main: dist/index.js
arguments:
  - name: action
    short: a
    type: string
    required: false
    description: fetch-agenda, list-emails, send-email, auth
category: Connector
last_updated: '2026-03-02'
tags:
  - automation
  - cloud
  - documentation
  - gemini-skill
---

# Google Workspace Integrator

This skill connects the monorepo to your primary productivity tools.

## Actions
- `fetch-agenda`: Lists upcoming calendar events.
- `list-emails`: Lists recent Gmail messages.
- `send-email`: Sends a new email.
- `auth`: Manages OAuth 2.0 authentication.
