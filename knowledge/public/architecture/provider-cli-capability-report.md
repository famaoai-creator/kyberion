# Provider CLI Capability Report

## Summary

- Capabilities registered: 23
- Active capabilities: 19
- Experimental capabilities: 4
- Capabilities with adapters: 23
- Capabilities missing adapters: 0

- Providers available: 3/3
- Available providers: codex-cli, gemini-cli, gh

## Capability Inventory

| Provider | Capability | Kind | Risk | Replayability | Status | Provider Probe | Adapter |
|---|---|---|---|---|---|---|---|
| codex-cli | cli.native.browser_interactive | interactive_tooling | high | partial | active | available | codex-cli.browser-interactive |
| codex-cli | cli.native.codex_cloud_tasks | delegated_execution | medium | partial | experimental | available | codex-cli.cloud |
| codex-cli | cli.native.codex_exec | reasoning | medium | partial | active | available | codex-cli.exec |
| codex-cli | cli.native.codex_feature_flags | deterministic_utility | low | deterministic | active | available | codex-cli.features |
| codex-cli | cli.native.codex_mcp_management | delegated_execution | medium | partial | active | available | codex-cli.mcp |
| codex-cli | cli.native.codex_plugin_management | deterministic_utility | low | deterministic | active | available | codex-cli.plugin |
| codex-cli | cli.native.codex_review | reasoning | medium | partial | active | available | codex-cli.review |
| codex-cli | cli.native.computer_use | interactive_tooling | critical | partial | experimental | available | codex-cli.computer-use |
| codex-cli | cli.native.delegated_agent_worker | delegated_execution | medium | partial | active | available | codex-cli.delegated-agent-worker |
| codex-cli | cli.plugin.skill_executor | deterministic_utility | low | deterministic | active | available | codex-cli.skill-executor |
| codex-cli | provider.runtime.codex_app_server | reasoning | medium | partial | active | available | codex-app-server.runtime |
| gemini-cli | cli.native.gemini_extension_management | deterministic_utility | low | deterministic | active | available | gemini-cli.extensions |
| gemini-cli | cli.native.gemini_headless_prompt | reasoning | medium | partial | active | available | gemini-cli.prompt |
| gemini-cli | cli.native.gemini_hook_management | deterministic_utility | medium | deterministic | active | available | gemini-cli.hooks |
| gemini-cli | cli.native.gemini_mcp_management | delegated_execution | medium | partial | active | available | gemini-cli.mcp |
| gemini-cli | cli.native.gemini_skill_management | deterministic_utility | low | deterministic | active | available | gemini-cli.skills |
| gh | cli.native.github_actions_inspection | deterministic_utility | low | deterministic | active | available | gh-cli.run-workflow |
| gh | cli.native.github_agent_task | delegated_execution | medium | partial | experimental | available | gh-cli.agent-task |
| gh | cli.native.github_api_access | deterministic_utility | medium | deterministic | active | available | gh-cli.api |
| gh | cli.native.github_issue_management | interactive_tooling | medium | partial | active | available | gh-cli.issue |
| gh | cli.native.github_pr_management | interactive_tooling | high | partial | active | available | gh-cli.pr |
| gh | cli.native.github_repo_management | interactive_tooling | high | partial | active | available | gh-cli.repo |
| gh | cli.native.github_skill_management | deterministic_utility | low | deterministic | experimental | available | gh-cli.skill |

## By Provider

### codex-cli

Provider probe: available

| Capability | Source | Intent Shapes | Fallback |
|---|---|---|---|
| cli.native.browser_interactive | browser-interactive-loop | task_session, mission | browser-actuator |
| cli.native.codex_cloud_tasks | cloud | task_session, mission | pipelines/a2a-task-contract.json |
| cli.native.codex_exec | exec | task_session, mission | reasoning-backend |
| cli.native.codex_feature_flags | features | direct_reply, task_session | orchestrator-actuator |
| cli.native.codex_mcp_management | mcp | task_session, mission | pipelines/a2a-task-contract.json |
| cli.native.codex_plugin_management | plugin | task_session | orchestrator-actuator |
| cli.native.codex_review | review | task_session, mission | reasoning-backend |
| cli.native.computer_use | computer-use-runtime | task_session, mission | pipelines/browser-session-simulation.json |
| cli.native.delegated_agent_worker | delegated-worker-agent | task_session, mission, project_bootstrap | pipelines/a2a-task-contract.json |
| cli.plugin.skill_executor | plugin-skill-executor | direct_reply, task_session | orchestrator-actuator |
| provider.runtime.codex_app_server | app-server | task_session, mission | reasoning-backend |

### gemini-cli

Provider probe: available

| Capability | Source | Intent Shapes | Fallback |
|---|---|---|---|
| cli.native.gemini_extension_management | extensions | task_session | orchestrator-actuator |
| cli.native.gemini_headless_prompt | prompt | direct_reply, task_session, mission | reasoning-backend |
| cli.native.gemini_hook_management | hooks | task_session, mission | orchestrator-actuator |
| cli.native.gemini_mcp_management | mcp | task_session, mission | pipelines/a2a-task-contract.json |
| cli.native.gemini_skill_management | skills | task_session | orchestrator-actuator |

### gh

Provider probe: available

| Capability | Source | Intent Shapes | Fallback |
|---|---|---|---|
| cli.native.github_actions_inspection | run / workflow | task_session, mission | service-actuator |
| cli.native.github_agent_task | agent-task | task_session, mission | pipelines/a2a-task-contract.json |
| cli.native.github_api_access | api | direct_reply, task_session | service-actuator |
| cli.native.github_issue_management | issue | task_session, mission | service-actuator |
| cli.native.github_pr_management | pr | task_session, mission | service-actuator |
| cli.native.github_repo_management | repo | task_session, mission | service-actuator |
| cli.native.github_skill_management | skill | task_session | orchestrator-actuator |

## Governance Note

The report is generated from the governed capability and adapter registries. It should be regenerated whenever provider help output or registry entries change.
