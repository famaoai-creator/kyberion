---
name: mobile-test-generator
description: >-
  Automatically generates Maestro YAML test flows based on provided scenarios and mobile automation best practices.
status: implemented
category: Engineering
last_updated: '2026-02-16'
arguments:
  - name: app-id
    short: a
    type: string
    required: true
  - name: scenario
    short: s
    type: string
    required: true
  - name: out
    short: o
    type: string
---

# mobile-test-generator

## Capabilities

- **YAML Generation**: Creates valid Maestro `.yaml` files from simple text descriptions.
- **Protocol Compliance**: Applies Accessibility ID prioritization and Wait-assert patterns automatically.
- **Scenario Templating**: Supports common flows like Login, Signup, and Search.

## Arguments

| Name       | Type   | Description                                               |
| :--------- | :----- | :-------------------------------------------------------- |
| --scenario | string | (Required) Brief description of the test flow.            |
| --app-id   | string | (Required) Target application ID (e.g., com.example.app). |
| --out      | string | (Optional) Output file path.                              |

## Usage

```bash
node scripts/cli.cjs run mobile-test-generator --app-id com.myapp --scenario "Login with user1 and check dashboard"
```
