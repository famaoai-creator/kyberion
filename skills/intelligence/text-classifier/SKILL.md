---
name: text-classifier
description: Universal text classifier supporting multiple rule sets (doc-type, domain, intent).
status: implemented
category: Intelligence
last_updated: '2026-03-03'
tags: documentation,gemini-skill
---

# Text Classifier

## Overview

A unified wrapper for `@agent/core/classifier` that consolidates previously separate skills (doc-type-classifier, domain-classifier).

## Arguments

- `--input <path>`: Path to the text file to classify.
- `--type <type>`: Rule set to use (`doc-type`, `domain`, `intent`). Default is `doc-type`.
