---
title: "Procedure: GitHub PR & Issue Management"
tags: [capability, github, procedure, pr-management, code-review]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-14
kind: capability
scope: global
authority: recipe
phase: [execution]
role_affinity: [software_developer, solution_architect, ceo]
applies_to: [system-actuator]
owner: software_developer
status: active
---

# Procedure: GitHub PR & Issue Management

## 1. Goal
Manage GitHub pull requests and issues using the `gh` CLI via system-actuator.

## 2. Dependencies
- **Actuator**: `system-actuator`
- **Tool**: `gh` CLI (GitHub CLI) installed and authenticated

## 3. Operations

### List Open PRs
```json
{ "type": "capture", "op": "shell", "params": { "cmd": "gh pr list --state open --json number,title,author,createdAt,reviewDecision", "export_as": "pr_list" } }
```

### View PR Details
```json
{ "type": "capture", "op": "shell", "params": { "cmd": "gh pr view {{pr_number}} --json title,body,additions,deletions,files,reviews,comments", "export_as": "pr_detail" } }
```

### View PR Diff
```json
{ "type": "capture", "op": "shell", "params": { "cmd": "gh pr diff {{pr_number}}", "export_as": "pr_diff" } }
```

### Review PR (Approve)
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "gh pr review {{pr_number}} --approve --body '{{review_comment}}'" } }
```

### Review PR (Request Changes)
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "gh pr review {{pr_number}} --request-changes --body '{{review_comment}}'" } }
```

### Comment on PR
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "gh pr comment {{pr_number}} --body '{{comment_body}}'" } }
```

### Merge PR
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "gh pr merge {{pr_number}} --merge --delete-branch" } }
```

### List Issues
```json
{ "type": "capture", "op": "shell", "params": { "cmd": "gh issue list --state open --json number,title,labels,assignees,createdAt", "export_as": "issue_list" } }
```

### Close Issue
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "gh issue close {{issue_number}} --comment '{{close_reason}}'" } }
```

## 4. Typical Workflow

1. `gh pr list` → get open PR numbers
2. For each PR: `gh pr view` + `gh pr diff` → understand changes
3. LLM analyzes diff for quality, security, architecture concerns
4. `gh pr review --approve` or `--request-changes` with rationale
5. If approved and ready: `gh pr merge`

## 5. Safety
- Merge operations require approval gate for protected branches
- Review comments are always logged to audit chain
- Destructive operations (force-push, branch delete) require explicit confirmation
