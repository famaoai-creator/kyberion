---
title: MCP Facade Model (Inbound Tools, Skills, Actuators)
category: Architecture
tags: [architecture, mcp, skills, actuators, governance, cowork]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-12
concepts: [mcp-facade, mcp-caller-identity, mcp-client]
---

# MCP Facade Model

Kyberion の inbound MCP（`mcp-server-cowork` / `pnpm mcp:server`）は、LLM クライアント向けの **統治された facade** である。Chronos HTTP API や全 actuator op の素通しではない。

## 1. 二つの MCP 方向

| 方向         | 役割                | 実装                                                                                                                                                                                                                                                                   |
| ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inbound**  | LLM → Kyberion      | `libs/shared-network/src/mcp-server-engine.ts`、catalog [`mcp-tool-catalog.json`](../governance/mcp-tool-catalog.json)                                                                                                                                                 |
| **Outbound** | Kyberion → 外部 MCP | service-actuator `mode: mcp`。クライアントは `libs/core/service/service-engine-execution.ts` の `executeMcp`（stdio）/ `executeRemoteMcp`（HTTP）だけ。stdio サーバーの起動は承認が必要で、tool 呼び出しは発見した interface と照合した外部 operation として実行される |

語彙を混ぜない。inbound の tool 名は常に `kyberion.*`。outbound クライアントは上の一つだけで、shared-network に別のクライアントは置かない。

## 2. 三帯（bands）と tool の一覧

tool の一覧・band・呼び出せる caller role・tier・承認要否の正本は [`mcp-tool-catalog.json`](../governance/mcp-tool-catalog.json)。catalog に無い tool は呼び出し時に `[MCP_TOOL_UNREGISTERED]` で拒否される。下の表はグループの説明であり、一覧ではない。

| Band       | 目的                                      | グループ                                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover` | 探す・読む・スキル本文を受け取る          | `scope.current`、`workspace.*`、`needs-you.*`、`setup.checklist`、`capability.*`、`skill.*`、`knowledge.search`、`pipeline.list` / `pipeline.job_status`、`mission.status` / `mission.journal`、`approval.list_pending`、`audit.export` / `audit.verify`、`surface.cowork.list` |
| `act`      | 狭い実行（allowlist / capture / dry-run） | `pipeline.run`、`service.capture`、`actuator.invoke`、`knowledge.feedback`、`surface.cowork.deliver`、`knowledge.cowork_sync`                                                                                                                                                   |
| `govern`   | 承認・高リスク書き込み                    | `mission.create`、mission lifecycle（`mission.record_evidence` / `review_task` / `verify` / `distill` / `finish`）、`service.actuate`、`approval.decide`                                                                                                                        |

補足:

- **workspace 帯**（`workspace.*`、`needs-you.*`、`setup.checklist`）は surface operation registry（`libs/core/surface/surface-operation-registry.ts`）の全 operation を `kyberion.<operation id>` として登録したもの。Concierge の HTTP `/api/v1/<domain>/<verb>` と同じ handler・同じ viewer 認可で動く。MCP にはブラウザセッションが無いので、viewer はサーバーの束縛テナント（§6）で、束縛が無ければ public のみ。
- **人の承認が必要な tool**（catalog `requires_approval: true`）は `mission.create`、mission lifecycle の 5 つ、`service.actuate`。承認が無いと `approval_required` と `request_id` を返し、承認済みの `approval_ref` を付けた再呼び出しで実行する。承認は payload hash と scope に束縛される。
- **`approval.decide` は承認ゲート付きではない**（catalog `requires_approval: false`）。govern 帯で caller role `operator` のみが呼べ、`approval.list_pending` で得た `request_id` に対する決定を記録する。人の決定が必須の request は `[APPROVAL_HUMAN_PROOF_REQUIRED]` で拒否され、それ以外は agent の決定として記録される。
- caller role の絞り込み: `service.actuate` と `approval.decide` は `operator` のみ。mission lifecycle は `operator` / `agent`（`cowork` 不可）。`knowledge.feedback`、`mission.create`、`approval.list_pending`、`audit.*`、`knowledge.cowork_sync` は `operator` / `cowork`（`agent` 不可）。その他は `operator` / `agent` / `cowork`。

### HTTP の `kyberion.request.*` は別サーバー

`kyberion.request.receive` / `status` / `result` は stdio の facade には無く、catalog にも載らない。既定で無効の HTTP resource server（`mcp-http-resource-server.ts`、起動は `scripts/mcp_http_server.ts`）だけが公開し、identity は環境変数ではなく外部 OAuth トークンと member registry から決まる。→ [mcp-http-human-requests](./mcp-http-human-requests.md)

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

- 既定は `mode=dry_run`（検証・計画のみ）。allowlist の `execution` が `dry_run` の op は `mode=live` を指定しても dry-run で返る。
- `mode=live` の条件は三つ: caller role が `operator`、サーバーにテナント束縛がある、allowlist の `requires_approval` が `true` なら人の承認がある。**env ゲートは無い。**
- 未 allowlist の op は拒否し、`capability.search` へ誘導する。

## 6. Caller identity（誰として動いているか）

MCP サーバーの identity は **サーバー自身の環境変数だけ** で決まる。tool の引数で名乗ることはできず、クライアントが渡す `tenant` は束縛済みテナントと一致する場合にだけ通る（絞り込みのみ）。

解決するのは `libs/shared-network/src/mcp-request-context.ts` の `resolveMcpServerIdentity` 一つで、リクエストごとの context（`resolveMcpRequestContext`）も、起動・停止の lifecycle receipt も同じ結果を使う。先に値がある変数が勝つ。

| 項目                            | 優先順                                                                                                    | 既定                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------- |
| テナント束縛（リクエスト認可）  | `KYBERION_MCP_TENANT` > `KYBERION_TENANT`                                                                 | なし（public のみ） |
| lifecycle receipt のテナント    | `KYBERION_MCP_TENANT` > `KYBERION_TENANT` > `KYBERION_TENANT_ID`（legacy）                                | なし（system）      |
| principal（リクエストの行為者） | `KYBERION_MCP_PRINCIPAL` > `KYBERION_BASE_ROLE`                                                           | `mcp-client`        |
| caller role                     | `KYBERION_MCP_CALLER_ROLE` > `MISSION_ROLE`。`operator` / `agent` / `cowork` / `service` 以外は `unknown` | `unknown`           |
| NHI                             | `KYBERION_MCP_NHI` > 申告 NHI（`KYBERION_NHI_ID`）                                                        | なし                |
| lifecycle receipt の principal  | `KYBERION_MCP_NHI` > `KYBERION_MCP_PRINCIPAL`                                                             | `mcp-server-cowork` |

- `KYBERION_TENANT_ID` は receipt の表示にだけ使う。これだけを設定したサーバーはテナント束縛を持たず、public のみを扱う。
- caller role が `unknown` のサーバーは全 tool を `[MCP_CALLER_ROLE_REQUIRED]` で拒否する。`service` は認識されるが、現在 catalog のどの tool も許可していない。
- caller role は MCP の tool 可否だけを決める。ファイルや knowledge への権限は別軸で、プロセスの Authority Role（`SYSTEM_ROLE` / `MISSION_ROLE`）と base role（`KYBERION_BASE_ROLE`）が決める。

## 7. 正本と同期

| 正本                    | 追従                                            |
| ----------------------- | ----------------------------------------------- |
| `mcp-tool-catalog.json` | connector `expected_tools`、プラグイン SKILL.md |

ドリフトはテストで検出する。

### 7.1 呼び出し主体はサーバーが決める

tool の実行主体（principal）・caller role・tenant は、MCP サーバーのプロセスに束縛した値
（`KYBERION_MCP_PRINCIPAL` / `KYBERION_MCP_CALLER_ROLE` / `KYBERION_MCP_TENANT`）から
`resolveMcpRequestContext` が解決する。tool の引数は主体を名乗れない。

- `kyberion.approval.decide` の決定者は、サーバー束縛の principal として記録する。引数 `decided_by` は
  wire 互換のために残すが、監査記録の `caller_label` にしか残らない。プロセス単位の束縛であり要求ごとの
  認証ではないため、決定は引き続き `deciderIdentitySource: 'caller_supplied'` として記録され、
  separation of duties が ON のときは承認できない（[`approval-gate-design.md`](../governance/approval-gate-design.md)）。
- `kyberion.audit.export` / `kyberion.audit.verify` の `requested_by` も同じ扱いで、監査の依頼者は
  サーバー束縛の principal、引数は `caller_label` になる。

## 8. 既知の乖離（2026-11-12 時点の事実）

コードと意図したモデルが食い違っている箇所。ここは現状の記録であり、どちらに揃えるかは未決定。

### 8.1 service preset を実行する二つの経路でゲートが違う

どちらも最後は `executeServicePreset` を呼ぶ。

| 経路                                                                 | caller role | テナント束縛 | 人の承認 | env ゲート                                    |
| -------------------------------------------------------------------- | ----------- | ------------ | -------- | --------------------------------------------- |
| `kyberion.service.actuate`                                           | `operator`  | 必須         | 必須     | `KYBERION_ENABLE_SERVICE_ACTUATE_TOOL=1` 必須 |
| `kyberion.actuator.invoke`（`service-actuator:preset`、`mode=live`） | `operator`  | 必須         | 必須     | なし                                          |

つまり `KYBERION_ENABLE_SERVICE_ACTUATE_TOOL` を設定していないサーバーでも、`actuator.invoke` 経由なら同じ preset を実行できる。

### 8.2 起動設定ごとに caller identity が違う

同じサーバー（`dist/scripts/mcp_server.js`）を起動する設定が三種類あり、解決結果が異なる。

| 起動設定                                                                                         | 設定する env                                                                                                   | プロセスの role                                                  | base role                         | MCP caller role | principal             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- | --------------- | --------------------- |
| surface manifest（`surfaces/mcp-server-cowork.json`、`active-surfaces.json`）                    | `KYBERION_BASE_ROLE=sovereign`、`MISSION_ROLE=mcp_server`、`KYBERION_MCP_CALLER_ROLE=cowork`                   | `mcp_server_cowork`（surface_runtime が `SYSTEM_ROLE` を付ける） | `sovereign`（`base_sovereign`）   | `cowork`        | `sovereign`           |
| プラグイン（`plugins/kyberion-claude-code/.mcp.json`、`plugins/kyberion-agent-plugin/mcp.json`） | `KYBERION_BASE_ROLE=sovereign_concierge`、`SYSTEM_ROLE=mcp_server_cowork`、`KYBERION_MCP_CALLER_ROLE=operator` | `mcp_server_cowork`                                              | `unknown`（base role 名ではない） | `operator`      | `sovereign_concierge` |
| connector（`plugins/kyberion/connector.json`、`plugin-manifest.json`、`pnpm mcp:server`）        | `KYBERION_BASE_ROLE=sovereign_concierge` のみ                                                                  | 設定なし（起動元の env か、スクリプト名から決まる）              | `unknown`                         | `unknown`       | `sovereign_concierge` |

結果:

- `operator` のみの tool（`service.actuate`、`approval.decide`）と mission lifecycle は、プラグイン起動では使えるが surface manifest 起動では使えない。
- connector 起動は caller role を設定しないので、起動元の環境が `KYBERION_MCP_CALLER_ROLE` か `MISSION_ROLE` を与えない限り全 tool が拒否される。
- MCP 上で最も強い `operator` を持つプラグイン起動は base role が `unknown`、`cowork` の surface manifest 起動は base role が `sovereign` で、二つの軸の強弱が逆になっている。
- `KYBERION_BASE_ROLE` の値として有効なのは `sovereign` / `ecosystem_architect` / `worker` / `analyst`。`sovereign_concierge` は Authority Role のカード名（`authority-roles/sovereign_concierge.json`）で、base role としては `unknown` になる。
- surface manifest の `MISSION_ROLE=mcp_server` という名前は、Authority Role カードにも `role-assumption-policy.json` の `system_roles` にも無い（あるのは `mcp_server_cowork`）。surface_runtime 経由なら `SYSTEM_ROLE=mcp_server_cowork` が優先されるので使われないが、manifest の env だけで直接起動するとプロセスの role は `mcp_server` になる。

どの起動設定がどの caller role を持つべきかは権限の決定であり、人の判断を待つ。

### 8.3 HTTP MCP サーバーは surface 一覧と protocol service registry に載っていない

`scripts/mcp_http_server.ts`（CLI は `mcp http`）は `cli-commands.json` にはあるが、[`docs/SURFACES.md`](../../../docs/SURFACES.md) にも `protocol-service-registry.json` にも行が無い。registry にあるのは stdio の `mcp-server-cowork` だけ。既定で無効のサービスを registry に載せるかどうかは未決定。

### 8.4 MCP が作る承認の surface ラベルは `api`

`ensureMcpApproval` が作る承認 request は `requestedByContext.surface: 'api'` で記録される。承認 store の surface 値に MCP 専用の値は無い。保存先（`mcp-approval` channel）と correlation id（`mcp:` で始まる）で MCP 由来と判別できる。
