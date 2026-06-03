---
title: ADF Pipeline Template
category: Orchestration
tags: [adf, pipeline, template, browser, reasoning, artifact]
importance: 8
author: Kyberion
last_updated: 2026-05-03
---

# ADF Pipeline Template

Use this as the starting point for a new governed pipeline.

The rule is simple:

- keep the contract small
- keep the session stable
- keep the save path explicit
- keep the runtime shape canonical

## 1. Standard Pipeline Shape

```json
{
  "pipeline_id": "your-pipeline-id",
  "version": "1.0.0",
  "description": "Short description of the governed pipeline.",
  "action": "pipeline",
  "steps": [
    {
      "id": "capture-input",
      "type": "control",
      "op": "core:if",
      "params": {
        "condition": { "from": "source_url", "operator": "exists" },
        "then": [],
        "else": []
      }
    },
    {
      "id": "normalize-context",
      "type": "transform",
      "op": "reasoning:analyze",
      "params": {
        "instruction": "Normalize the input context into a structured brief.",
        "context": ["{{input_data}}"],
        "export_as": "normalized_brief"
      }
    },
    {
      "id": "write-artifact",
      "type": "apply",
      "op": "code:write_artifact",
      "params": {
        "path": "active/shared/tmp/output.json",
        "content": "{{normalized_brief}}"
      }
    }
  ]
}
```

## 2. Browser Extraction Shape

Use this for site capture, visual/theme extraction, and browser-based evidence gathering.

```json
{
  "pipeline_id": "browser-extract-template",
  "version": "1.0.0",
  "description": "Template for browser capture and downstream synthesis.",
  "action": "pipeline",
  "steps": [
    {
      "id": "open-site",
      "type": "control",
      "op": "browser:open_tab",
      "params": {
        "url": "{{source_url}}",
        "waitUntil": "domcontentloaded",
        "keep_alive": true,
        "select": true
      }
    },
    {
      "id": "capture-page",
      "type": "capture",
      "op": "browser:snapshot",
      "params": {
        "export_as": "page_snapshot"
      }
    },
    {
      "id": "synthesize-output",
      "type": "transform",
      "op": "reasoning:synthesize",
      "params": {
        "instruction": "Extract the relevant design or behavioral signals from the captured page.",
        "context": ["{{page_snapshot}}"],
        "export_as": "structured_output"
      }
    },
    {
      "id": "save-output",
      "type": "apply",
      "op": "code:write_artifact",
      "params": {
        "path": "active/shared/tmp/output.json",
        "content": "{{structured_output}}"
      }
    }
  ]
}
```

## 3. Concept-to-Prototype Shape

Use this for prompt-driven website generation or other concept-to-artifact flows.

```json
{
  "pipeline_id": "concept-to-prototype-template",
  "version": "1.0.0",
  "description": "Template for generating a prototype from a short concept brief.",
  "action": "pipeline",
  "steps": [
    {
      "id": "synthesize-prototype",
      "type": "transform",
      "op": "reasoning:analyze",
      "params": {
        "instruction": "Write a complete self-contained HTML prototype from the concept brief and optional design theme.",
        "context": [
          "{{concept_brief}}",
          "{{design_theme}}"
        ],
        "export_as": "prototype_html"
      }
    },
    {
      "id": "save-prototype",
      "type": "apply",
      "op": "code:write_artifact",
      "params": {
        "path": "active/shared/tmp/preview/index.html",
        "content": "{{prototype_html}}"
      }
    }
  ]
}
```

## 4. Build Checklist

Before shipping a new pipeline from this template, confirm:

- the output artifact path is explicit
- the save operator is supported by the runtime
- the session id is stable across dependent steps
- the inputs are resolved before reasoning
- the pipeline works on real data
- the output can be compared across runs
- the artifact location respects tier rules
- the runtime contract has a matching schema or known ADF shape

## 5. Template-to-Example Mapping

| Template | Good example | What to copy |
|---|---|---|
| Browser extraction | `extract-brand-theme` | explicit open/capture/reason/write flow |
| Concept to prototype | `build-web-concept` | one reasoning pass + one artifact write |
| Shared coordination | guided coordination flows | separate brief from execution |

---
*Status: Living starter template for governed ADF pipelines*
