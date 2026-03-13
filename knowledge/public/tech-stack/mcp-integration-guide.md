---
title: MCP (Model Context Protocol) Integration Guide
category: Tech-stack
tags: [tech-stack, mcp, integration, guide, protocol]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# MCP (Model Context Protocol) Integration Guide

## 1. Overview

Model Context Protocol (MCP) is an open standard that enables AI models to interact with external tools and data sources seamlessly. In the context of the Kyberion Monorepo, MCP provides a standardized way to export our "Skills" as "MCP Tools," making them usable by any MCP-compliant LLM client (like Claude Desktop or other agents).

## 2. Core Concepts for Skills

To align Kyberion with MCP, we must map our current architecture to MCP primitives:

- **Resources**: Map to our `knowledge/` tier data.
- **Tools**: Map to our `scripts/` and `SKILL.md` definitions.
- **Prompts**: Map to our `templates/` or `intent_mapping.yaml`.

## 3. Implementation Patterns

### Pattern A: Skill-to-Tool Wrapper

Every Kyberion Skill that follows the `runSkill()` pattern can be automatically wrapped as an MCP Tool.

```javascript
// Example: Converting a Kyberion Skill to an MCP Tool definition
{
  "name": "doc-type-classifier",
  "description": "Classifies document types (meeting-notes, spec, etc.)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" }
    },
    "required": ["path"]
  }
}
```

### Pattern B: Sovereign Context Injection

MCP allows for dynamic context injection. Kyberion's **3-Tier Model** should be used to filter what information is sent to the LLM via MCP:

1. **Personal Tier**: Never exported via MCP unless explicitly whitelisted.
2. **Confidential Tier**: Masked or summarized before sending.
3. **Public Tier**: Fully accessible as MCP Resources.

### Pattern C: MCP Connector Wrapper (Approach B)

For high-demand public MCP servers, we create individual "Connector" skills that wrap the MCP server execution. This ensures strict schema validation and better discoverability via `SKILL.md`.

- **Shared Engine**: `skills/Connector/scripts/mcp-client-engine.js` provides the common MCP client logic.
- **Individual Skills**:
    - `mcp-aws-knowledge-connector`: Wraps `@modelcontextprotocol/server-aws-kb-retrieval` (npx).
    - `mcp-terraform-connector`: Wraps `terraform-mcp-server` (npx).

Example execution:
```bash
npm run cli -- run mcp-terraform-connector --action call_tool --name providerDetails --arguments '{"provider": "aws", "namespace": "hashicorp"}'
```

## 4. Strategic Value for Autonomy

By adopting MCP, the Kyberion Ecosystem gains:

- **Interoperability**: Skills can be used by external agents without modification.
- **Discoverability**: LLMs can "browse" available skills via the MCP `list_tools` capability.
- **Scalability**: New skills added to this monorepo are instantly available to any MCP-enabled environment.

## 5. Action Plan for Evolution

1. **MCP Exporter**: Create a new skill `mcp-gateway` that reads `SKILL.md` files and serves them via an MCP server.
2. **Dynamic Tool Loading**: Allow `mission-control` to consume external MCP tools, effectively making our agent capable of using tools it wasn't originally programmed with.

---

_Created by Autonomous Knowledge Refiner_
