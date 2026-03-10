---
title: Incident Report: quality-scorer
category: Incidents
tags: [incidents, incident, unknown, quality, scorer, 1771099808128]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Incident Report: quality-scorer

## Metadata

- **Mission ID**: UNKNOWN
- **Timestamp**: 2026-02-14T20:10:08.123Z
- **Status**: error

## Analysis

- **Error**: Output contains forbidden tokens.
- **Cause**: Output contains sensitive data (Personal/Confidential) that is blocked by Tier Guard.
- **Impact**: Security leak prevented, but execution results are hidden.

## Action Taken

- **Recommendation**: Review the output for secrets (API keys, PII) and mask them before returning.
