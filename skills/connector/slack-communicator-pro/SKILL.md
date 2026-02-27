---
name: slack-communicator-pro
description: >-

status: implemented
arguments:
  - name: action
    short: a
    type: string
    required: false
    description:
  - name: channel
    short: c
    type: string
    required: false
    description:
  - name: input
    short: i
    type: string
    required: false
    description:
  - name: dry-run
    type: boolean
    required: false
    description:
  - name: out
    short: o
    type: string
    required: false
    description:
category: Connector
last_updated: '2026-02-16'
tags:
  - communication
  - gemini-skill
---

# Slack Communicator Pro

This skill gives the agent a professional and empathetic voice in your team's chat.

## Capabilities

### 1. Intelligent Notifications

- Sends "Daily Standup" summaries of AI activities.
- Delivers critical alerts from `crisis-manager` with immediate action items.

### 2. Interactive Polls & Feedback

- Orchestrates human feedback loops by sending "Option A vs B" polls to Slack channels.

## Usage

- "Notify the #engineering channel that the security scan passed with zero vulnerabilities."
- "Send a summary of this week's technical achievements to the #stakeholders channel."

## Knowledge Protocol

- Follows the `empathy-engine` guidelines for tone and timing.
