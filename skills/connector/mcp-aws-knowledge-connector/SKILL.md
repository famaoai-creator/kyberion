---
name: mcp-aws-knowledge-connector
description: 
status: implemented
arguments: 
- name: arguments
short: g
type: string
required: false
category: Connector
last_updated: '2026-03-02'
tags: cloud,gemini-skill
---

# AWS Knowledge MCP Connector

This skill provides access to AWS Knowledge Bases (Amazon Bedrock RAG) via the Model Context Protocol.

## Capabilities

- **`retrieve_from_aws_kb`**: Query your own documents indexed in Amazon Bedrock Knowledge Bases.
- **`list_tools`**: Discover available tools on the AWS Knowledge MCP server.

## Usage

- "Retrieve information about our internal security policies from the AWS Knowledge Base."
- "List available tools in the AWS Knowledge MCP server."

## Knowledge Protocol

- Requires `AWS_REGION` and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` to be set in the environment.
- The `knowledgeBaseId` is passed as an argument to `call_tool`.
