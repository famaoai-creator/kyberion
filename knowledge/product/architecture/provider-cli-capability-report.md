# Provider CLI Capability Report

## Summary

- Capabilities registered: 39
- Active capabilities: 28
- Experimental capabilities: 11
- Capabilities with adapters: 31
- Capabilities missing adapters: 8

- Providers available: 7/9
- Available providers: claude-cli, claude-desktop, codex-cli, gemini-app, gemini-cli, gh, grok-cli

## Capability Inventory

| Provider       | Capability                                    | Kind                  | Risk     | Replayability | Status       | Provider Probe | Adapter                          |
| -------------- | --------------------------------------------- | --------------------- | -------- | ------------- | ------------ | -------------- | -------------------------------- |
| claude-cli     | cli.native.claude_agent_loop                  | interactive_tooling   | high     | partial       | active       | available      | missing                          |
| claude-cli     | cli.native.claude_agents_management           | deterministic_utility | low      | deterministic | active       | available      | missing                          |
| claude-cli     | cli.native.claude_headless_prompt             | reasoning             | medium   | partial       | active       | available      | missing                          |
| claude-cli     | cli.native.claude_mcp_management              | delegated_execution   | medium   | partial       | active       | available      | missing                          |
| claude-cli     | cli.native.claude_plugin_management           | deterministic_utility | medium   | deterministic | active       | available      | missing                          |
| claude-desktop | provider.runtime.claude_cowork_desktop        | interactive_tooling   | medium   | partial       | experimental | available      | claude-cowork.desktop            |
| codex-cli      | cli.native.browser_interactive                | interactive_tooling   | high     | partial       | active       | available      | codex-cli.browser-interactive    |
| codex-cli      | cli.native.codex_cloud_tasks                  | delegated_execution   | medium   | partial       | experimental | available      | codex-cli.cloud                  |
| codex-cli      | cli.native.codex_exec                         | reasoning             | medium   | partial       | active       | available      | codex-cli.exec                   |
| codex-cli      | cli.native.codex_feature_flags                | deterministic_utility | low      | deterministic | active       | available      | codex-cli.features               |
| codex-cli      | cli.native.codex_mcp_management               | delegated_execution   | medium   | partial       | active       | available      | codex-cli.mcp                    |
| codex-cli      | cli.native.codex_plugin_management            | deterministic_utility | low      | deterministic | active       | available      | codex-cli.plugin                 |
| codex-cli      | cli.native.codex_review                       | reasoning             | medium   | partial       | active       | available      | codex-cli.review                 |
| codex-cli      | cli.native.computer_use                       | interactive_tooling   | critical | partial       | experimental | available      | codex-cli.computer-use           |
| codex-cli      | cli.native.delegated_agent_worker             | delegated_execution   | medium   | partial       | active       | available      | codex-cli.delegated-agent-worker |
| codex-cli      | cli.plugin.skill_executor                     | deterministic_utility | low      | deterministic | active       | available      | codex-cli.skill-executor         |
| codex-cli      | provider.runtime.codex_app_server             | reasoning             | medium   | partial       | active       | available      | codex-app-server.runtime         |
| gemini-app     | provider.runtime.gemini_spark_desktop         | interactive_tooling   | medium   | partial       | experimental | available      | gemini-spark.desktop             |
| gemini-cli     | cli.native.gemini_extension_management        | deterministic_utility | low      | deterministic | active       | available      | gemini-cli.extensions            |
| gemini-cli     | cli.native.gemini_headless_prompt             | reasoning             | medium   | partial       | active       | available      | gemini-cli.prompt                |
| gemini-cli     | cli.native.gemini_hook_management             | deterministic_utility | medium   | deterministic | active       | available      | gemini-cli.hooks                 |
| gemini-cli     | cli.native.gemini_mcp_management              | delegated_execution   | medium   | partial       | active       | available      | gemini-cli.mcp                   |
| gemini-cli     | cli.native.gemini_skill_management            | deterministic_utility | low      | deterministic | active       | available      | gemini-cli.skills                |
| gh             | cli.native.github_actions_inspection          | deterministic_utility | low      | deterministic | active       | available      | gh-cli.run-workflow              |
| gh             | cli.native.github_agent_task                  | delegated_execution   | medium   | partial       | experimental | available      | gh-cli.agent-task                |
| gh             | cli.native.github_api_access                  | deterministic_utility | medium   | deterministic | active       | available      | gh-cli.api                       |
| gh             | cli.native.github_issue_management            | interactive_tooling   | medium   | partial       | active       | available      | gh-cli.issue                     |
| gh             | cli.native.github_pr_management               | interactive_tooling   | high     | partial       | active       | available      | gh-cli.pr                        |
| gh             | cli.native.github_repo_management             | interactive_tooling   | high     | partial       | active       | available      | gh-cli.repo                      |
| gh             | cli.native.github_skill_management            | deterministic_utility | low      | deterministic | experimental | available      | gh-cli.skill                     |
| grok-cli       | cli.native.grok_headless_prompt               | reasoning             | medium   | partial       | active       | available      | missing                          |
| grok-cli       | cli.native.grok_spawn_subagent                | delegated_execution   | medium   | partial       | active       | available      | missing                          |
| grok-cli       | cli.native.grok_structured_output             | reasoning             | medium   | partial       | active       | available      | missing                          |
| hermes-agent   | provider.runtime.hermes_cron_scheduler        | delegated_execution   | medium   | partial       | experimental | missing        | hermes-cron.scheduler            |
| hermes-agent   | provider.runtime.hermes_hook_pipeline         | deterministic_utility | medium   | partial       | experimental | missing        | hermes-hooks.pipeline            |
| hermes-agent   | provider.runtime.hermes_kanban_board          | delegated_execution   | medium   | partial       | active       | missing        | hermes-kanban.board              |
| hermes-agent   | provider.runtime.hermes_skill_bundle_registry | deterministic_utility | low      | deterministic | experimental | missing        | hermes-skills.bundle-registry    |
| hermes-agent   | provider.runtime.hermes_tool_routing          | reasoning             | medium   | partial       | experimental | missing        | hermes-tool-gateway.routing      |
| openhands      | provider.runtime.openhands_control_plane      | reasoning             | medium   | partial       | experimental | missing        | openhands.control-plane          |

## By Provider

### claude-cli

Provider probe: available

| Capability                          | Source     | Intent Shapes                       | Fallback                         |
| ----------------------------------- | ---------- | ----------------------------------- | -------------------------------- |
| cli.native.claude_agent_loop        | agent-loop | task_session, mission               | agent-actuator                   |
| cli.native.claude_agents_management | agents     | task_session                        | agent-actuator                   |
| cli.native.claude_headless_prompt   | prompt     | direct_reply, task_session, mission | reasoning-backend                |
| cli.native.claude_mcp_management    | mcp        | task_session, mission               | pipelines/a2a-task-contract.json |
| cli.native.claude_plugin_management | plugins    | task_session, mission               | orchestrator-actuator            |

### claude-desktop

Provider probe: available

| Capability                             | Source | Intent Shapes         | Fallback          |
| -------------------------------------- | ------ | --------------------- | ----------------- |
| provider.runtime.claude_cowork_desktop | cowork | task_session, mission | reasoning-backend |

### codex-cli

Provider probe: available

| Capability                         | Source                   | Intent Shapes                            | Fallback                                  |
| ---------------------------------- | ------------------------ | ---------------------------------------- | ----------------------------------------- |
| cli.native.browser_interactive     | browser-interactive-loop | task_session, mission                    | browser-actuator                          |
| cli.native.codex_cloud_tasks       | cloud                    | task_session, mission                    | pipelines/a2a-task-contract.json          |
| cli.native.codex_exec              | exec                     | task_session, mission                    | reasoning-backend                         |
| cli.native.codex_feature_flags     | features                 | direct_reply, task_session               | orchestrator-actuator                     |
| cli.native.codex_mcp_management    | mcp                      | task_session, mission                    | pipelines/a2a-task-contract.json          |
| cli.native.codex_plugin_management | plugin                   | task_session                             | orchestrator-actuator                     |
| cli.native.codex_review            | review                   | task_session, mission                    | reasoning-backend                         |
| cli.native.computer_use            | computer-use-runtime     | task_session, mission                    | pipelines/browser-session-simulation.json |
| cli.native.delegated_agent_worker  | delegated-worker-agent   | task_session, mission, project_bootstrap | pipelines/a2a-task-contract.json          |
| cli.plugin.skill_executor          | plugin-skill-executor    | direct_reply, task_session               | orchestrator-actuator                     |
| provider.runtime.codex_app_server  | app-server               | task_session, mission                    | reasoning-backend                         |

### gemini-app

Provider probe: available

| Capability                            | Source | Intent Shapes         | Fallback          |
| ------------------------------------- | ------ | --------------------- | ----------------- |
| provider.runtime.gemini_spark_desktop | spark  | task_session, mission | reasoning-backend |

### gemini-cli

Provider probe: available

| Capability                             | Source     | Intent Shapes                       | Fallback                         |
| -------------------------------------- | ---------- | ----------------------------------- | -------------------------------- |
| cli.native.gemini_extension_management | extensions | task_session                        | orchestrator-actuator            |
| cli.native.gemini_headless_prompt      | prompt     | direct_reply, task_session, mission | reasoning-backend                |
| cli.native.gemini_hook_management      | hooks      | task_session, mission               | orchestrator-actuator            |
| cli.native.gemini_mcp_management       | mcp        | task_session, mission               | pipelines/a2a-task-contract.json |
| cli.native.gemini_skill_management     | skills     | task_session                        | orchestrator-actuator            |

### gh

Provider probe: available

| Capability                           | Source         | Intent Shapes              | Fallback                         |
| ------------------------------------ | -------------- | -------------------------- | -------------------------------- |
| cli.native.github_actions_inspection | run / workflow | task_session, mission      | service-actuator                 |
| cli.native.github_agent_task         | agent-task     | task_session, mission      | pipelines/a2a-task-contract.json |
| cli.native.github_api_access         | api            | direct_reply, task_session | service-actuator                 |
| cli.native.github_issue_management   | issue          | task_session, mission      | service-actuator                 |
| cli.native.github_pr_management      | pr             | task_session, mission      | service-actuator                 |
| cli.native.github_repo_management    | repo           | task_session, mission      | service-actuator                 |
| cli.native.github_skill_management   | skill          | task_session               | orchestrator-actuator            |

### grok-cli

Provider probe: available

| Capability                        | Source            | Intent Shapes                       | Fallback          |
| --------------------------------- | ----------------- | ----------------------------------- | ----------------- |
| cli.native.grok_headless_prompt   | prompt            | direct_reply, task_session, mission | reasoning-backend |
| cli.native.grok_spawn_subagent    | spawn-subagent    | task_session, mission               | reasoning-backend |
| cli.native.grok_structured_output | structured-output | direct_reply, task_session, mission | reasoning-backend |

### hermes-agent

Provider probe: missing

| Capability                                    | Source       | Intent Shapes         | Fallback                                                      |
| --------------------------------------------- | ------------ | --------------------- | ------------------------------------------------------------- |
| provider.runtime.hermes_cron_scheduler        | cron         | task_session, mission | knowledge/product/orchestration/schedule-delivery-protocol.md |
| provider.runtime.hermes_hook_pipeline         | hooks        | task_session, mission | orchestrator-actuator                                         |
| provider.runtime.hermes_kanban_board          | kanban       | task_session, mission | pipelines/a2a-task-contract.json                              |
| provider.runtime.hermes_skill_bundle_registry | skills       | task_session, mission | orchestrator-actuator                                         |
| provider.runtime.hermes_tool_routing          | tool-gateway | task_session, mission | reasoning-backend                                             |

### openhands

Provider probe: missing

| Capability                               | Source        | Intent Shapes         | Fallback                 |
| ---------------------------------------- | ------------- | --------------------- | ------------------------ |
| provider.runtime.openhands_control_plane | control-plane | task_session, mission | management-control-plane |

## Missing Adapter Coverage

The following capabilities are registered but do not yet have a matching adapter profile:

- cli.native.claude_agent_loop (claude-cli)
- cli.native.claude_agents_management (claude-cli)
- cli.native.claude_headless_prompt (claude-cli)
- cli.native.claude_mcp_management (claude-cli)
- cli.native.claude_plugin_management (claude-cli)
- cli.native.grok_headless_prompt (grok-cli)
- cli.native.grok_spawn_subagent (grok-cli)
- cli.native.grok_structured_output (grok-cli)

## Governance Note

The report is generated from the governed capability and adapter registries. It should be regenerated whenever provider help output or registry entries change.
