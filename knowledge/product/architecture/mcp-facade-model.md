---
title: MCP Facade Model (Inbound Tools, Skills, Actuators)
category: Architecture
tags: [architecture, mcp, skills, actuators, governance, cowork]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-13
---

# MCP Facade Model

Kyberion の inbound MCP（`mcp-server-cowork` / `pnpm mcp:server`）は、LLM クライアント向けの **統治された facade** である。Chronos HTTP API や全 actuator op の素通しではない。

## 1. 二つの MCP 方向

| 方向         | 役割                | 実装                                                                                                                   |
| ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Inbound**  | LLM → Kyberion      | `libs/shared-network/src/mcp-server-engine.ts`、catalog [`mcp-tool-catalog.json`](../governance/mcp-tool-catalog.json) |
| **Outbound** | Kyberion → 外部 MCP | service-actuator `mode: mcp`（`executeMcp`）                                                                           |

語彙を混ぜない。inbound の tool 名は常に `kyberion.*`。

## 2. 三帯（bands）

| Band       | 目的                                      | 例                                                             |
| ---------- | ----------------------------------------- | -------------------------------------------------------------- |
| `discover` | 探す・読む・スキル本文を受け取る          | `capability.*`, `skill.*`, `knowledge.search`, `scope.current` |
| `act`      | 狭い実行（allowlist / capture / dry-run） | `pipeline.run`, `service.capture`, `actuator.invoke`           |
| `govern`   | 承認・高リスク書き込み                    | `service.actuate`, `mission.create`, `approval.decide`         |

## 3. Tools ↔ Skills ↔ Actuators

```
Skills (SKILL.md)     — LLM 向けガイド。Resources / skill.get で転送。実行権限ではない。
Tools (kyberion.*)    — MCP で実際に呼べる facade。catalog が正本。
Actuators (manifests) — 能力本体。capability.list/search で発見。
                        実行は service.* / allowlist pipeline / 限定 actuator.invoke。
```

- スキルを全部 Tools に昇格させない（tool 爆発と allowlist 破壊を防ぐ）。
- `related_actuators` は catalog メタデータで Tools → Actuator の関連を示す。

## 4. スキル転送

承認済み／first-party プラグインの `SKILL.md` を:

- MCP Resource: `kyberion://skill/{pluginId}/{skillId}`
- Tools: `kyberion.skill.list` / `kyberion.skill.get`

で渡す。personal/confidential 配下のスキルは出さない。実行は既存 `runSkillAsync` + provenance（[`plugins/README.md`](../../../plugins/README.md)）。

## 5. actuator.invoke（限定）

`kyberion.actuator.invoke` は **catalog の `actuator_invoke_allowlist` に載った (actuator, op) のみ**。

- 既定は `mode=dry_run`（検証・計画のみ）。
- `mode=live` は operator 役割＋allowlist の `requires_approval` / env ゲートに従う。
- 未 allowlist の op は拒否し、`capability.search` へ誘導する。

## 6. 正本と同期

| 正本                    | 追従                                            |
| ----------------------- | ----------------------------------------------- |
| `mcp-tool-catalog.json` | connector `expected_tools`、プラグイン SKILL.md |

ドリフトはテストで検出する。
