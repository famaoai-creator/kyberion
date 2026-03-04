---
name: business-growth-planner
description: Output file path
status: implemented
arguments: 
- name: out
short: o
type: string
required: false
category: Business
last_updated: '2026-02-28'
tags: gemini-skill
---

# Business Growth Planner

This skill helps the CEO plan "Where to Play" and "How to Win."

## Capabilities

### 1. OKR Cascading

- Breaks down company-wide "Objectives" into team-level "Key Results."
- Ensures all engineering tasks in the monorepo align with a top-level growth goal.

### 2. Market Sizing & Strategy

- Performs competitive positioning audits (using `competitive-intel-strategist`).
- Proposes expansion strategies (e.g., "Enter the US market via white-label partners").

## Usage

- "Translate my 2030 Vision into an OKR structure for the current fiscal year."
- "Design a growth strategy for our new AI-native analytics product."

## Knowledge Protocol

- Adheres to `knowledge/orchestration/knowledge-protocol.md`.
