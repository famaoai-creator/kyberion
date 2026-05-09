# Scenario: Messaging Bridge Activation & Orchestration

This playbook describes how to request and manage declared messaging bridge implementations. Today, the shipped activation path covers Slack and iMessage; Telegram remains scaffold-required until a satellite and manifest entry exist.

## 1. Requesting New Channels

You can request the activation of new messaging platforms using natural language. Kyberion will guide you through credential setup and service activation.

### Example Intents

| Goal | Ask Kyberion |
|---|---|
| **Setup Slack** | `Slackブリッジを起動して` |
| **Enable iMessage** | `iMessageの連携を設定して` |
| **Status Check** | `メッセージングブリッジの状態を教えて` |

## 2. Activation Workflow

When you request a bridge activation, Kyberion executes the `setup-messaging-bridge` pipeline:

1.  **Platform Identification**: Kyberion requires an explicit `platform_id` in pipeline context.
2.  **Declared Bridge Check**: Kyberion verifies that the requested bridge implementation exists in `satellites/<platform>-bridge`.
3.  **Host Constraint Check**: iMessage activations require macOS before any startup is attempted.
4.  **Reconciliation**: Kyberion reconciles `knowledge/public/governance/surfaces/*.json` through `scripts/surface_runtime.ts` / `service-actuator`, with `active-surfaces.json` as a compatibility snapshot.
5.  **Service Startup**: The declared bridge is started as part of the managed reconcile flow.

## 3. Managing Services

For daily operations, you can control the communication services directly:

- **Start All**: `通信サービス群をすべて起動して`
- **Restart Specific**: `Slackブリッジを再起動して`
- **Stop for Privacy**: `すべての外部連携を止めて`

## 4. Technical Architecture

- **Slack**: The currently shipped declared bridge implementation.
- **iMessage**: A shipped macOS-only declared bridge implementation backed by the local Messages app.
- **Telegram**: Planned target. It still requires a scaffolded satellite and a matching manifest entry before this playbook can activate it.
- **Governance**: All bridges are monitored by the `runtimeSupervisor` and logged for auditability.

---
*Created by Kyberion Ecosystem Architect | 2026-05-03*
