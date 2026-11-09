---
title: スコープ・ID・権限（Grant）の統合計画
kind: plan
status: partial
last_updated: 2026-11-10
tags: [plan, concepts, tenant, organization, stance, role, persona, grant, authority, scope]
importance: 9
---

# スコープ・ID・権限（Grant）の統合計画

決定記録 [Concept Model v2](../../../knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md) の D3〜D6 を実装する計画です。4 本ある移行計画の 1 本目です。記憶の開示範囲（D8）と意図の振り分けでの権限レベル（D7）はこの計画の結果の上に乗るので、最初に進めます。

権限の判定は新しく作りません。[保存先カタログと許可証による権限判定](./STORE_CATALOG_GRANT_GUARD_DESIGN_2026-11-05.ja.md) と [情報資産のスコープモデル](./INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05.ja.md) を土台にします。この計画が足すのは、「ロール」と「Persona」の側の整理です。

## 結論

| 決定             | 今                                                                                      | 移行後                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D3 Tenant と Org | NHI の ID が `kyberion://agent/<org>/<slug>`、tenant は任意、org がなければ `'default'` | `kyberion://agent/<tenant>/<org\|_>/<slug>`、`tenant_slug` は必須。Organization profile は Org ごと                |
| D4 Stance        | identity / 設定 / customer overlay が混在。`KYBERION_CUSTOMER` を 14 か所が読む         | 「どのテナントの、どの Org と Org Role として動くか」を選んだ状態。口調や窓口は Tenant's Customers と Channel の側 |
| D5 Role          | 6 種類。`assigned_persona` に Org Role が入り、Persona に変換されている                 | NHI / Member、Member Role、Authority Role → Grant、Org Role、Team Role。Execution Persona は廃止                   |
| D6 Grant         | Authority Role が 2 つのレジストリ（55 件と 86 件）。保存先専用ロールが 40 件           | Grant = 誰 × スコープ × 操作。レジストリは 1 つ。保存先専用ロールは許可証に置き換え                                |

## 段階

### S1 — 安全な改名と型の一本化（挙動は変えない）

- tier の型（`'personal'|'confidential'|'public'`、7 か所で宣言）を `libs/core/storage-layout.ts` の 1 つに寄せ、他はそこから import する。
- Member Role（`owner|approver|operator|viewer`、6 か所）を 1 つの型として export し、3 値の部分集合は `Extract<>` で表す。
- `mission-state.assigned_persona` を `org_role` に改名する。読み込みの互換は 1 リリースだけ残す。`authority.ts` で Persona に変換している箇所を外す。
- 完了条件：重複宣言がなくなったことを境界テストで検査する。`assigned_persona` を書いている箇所が 0 件。

### S2 — Stance の再定義

- `stance-resolver.ts` を「許可テナントの一覧と、選んだテナント・Org・Org Role」の形にする。
- 切り替えたときに参照できるデータの範囲が `ViewerContext` / `ResourceAccessScope` に反映されることを、テストで固定する。
- `KYBERION_CUSTOMER` の読み込み（14 か所）を削除する。口調・窓口の設定は Tenant's Customers と Channel に移す。
- `stance-tenant-customer-model.md` を新しい定義に書き換える。

状況（2026-11-10、実装済み）：

- `stance.json` の `acting_for`（`tenant_slug`、任意で `organization_id` と `org_role`）が選択を表す。`resolveStance` は許可テナントの一覧にないテナントを `[STANCE_NOT_PERMITTED]` で拒否する。許可テナントは、CLI ではテナント台帳（`knowledge/personal/tenants/`）の active なプロファイル、HTTP ではビューアー資格情報の `tenant_slugs` です。stance 自身は許可を宣言しない。
- `pnpm stance:switch` は `KYBERION_STANCE` に加えて `KYBERION_TENANT` / `KYBERION_ORGANIZATION_ID` を `stance.env` に書く。`acting_for` のない stance は、従来どおり overlay だけを選ぶ。
- `narrowViewerScopeToStance` が `ViewerContext` を選んだテナントと Org に絞る（広げることはない）。`stanceResourceBinding` が `ResourceAccessScope` をそのテナントに結び付ける。切り替えで範囲が移ることと、許可の外へ広がらないことを `libs/core/authn/stance-scope.test.ts` で固定した。
- `KYBERION_CUSTOMER` の読み込みは、14 か所から既に 2 か所（`stance-resolver.ts` と `tier-guard.ts`）に減っていた。この 2 か所を `libs/core/authn/stance-env.ts` の 1 か所に寄せた。移行のため 1 リリースだけ、`KYBERION_STANCE` が未設定で `knowledge/personal/stances/<slug>/` があるときに限り、その stance として読む。それ以外は無視する。どちらの場合も診断形式の警告を 1 回出す。env-registry では `deprecated: 2026-11` とした。
- 口調・窓口は既にテナント側にあった（`connections/channel-bindings.json` の `language` / `mode` / `counterpart`、`customers/<customer>/` の actor ごとの `channel`）。stance 側の記述（テンプレート、use cases、DEPLOYMENT）から「customer overlay」と顧客とのやり取りの扱いを外した。stance の `voice/` は運用者自身の音声として残した。テナントへ移すかは未決。

### S3 — Tenant 1:N Org と NHI の ID

- NHI の ID に tenant を入れ、`tenant_slug` を必須にする。既存の ID は移行スクリプトで書き換え、旧 ID は別名として 1 リリース解決する。
- `organization-profile.json` を Org ごとの置き場所に移す。Company を tenant の別名として扱う（`company.ts`）。

**状況（2026-11-10、実装済み・統合待ち）**

- ID の文法は `libs/core/contracts/nhi-id.ts` にあります。`buildNhiId(tenant, org, slug)` は tenant がないとき、予約名（`public` / `confidential` / `personal` / `shared`）のときに拒否します。Org がなければ `_` と書き、`'default'` への切り替えはなくしました。tenant に属する Org を tenant なしで指定すると拒否します。
- テナントに属さない NHI（個人用オンボーディングのエージェント、tenant なしで起動した実行体）は、暫定で `kyberion://agent/_/_/<slug>` としました。D3 の「tenant は必須」とどう両立させるかは、オーナーの判断待ちです。
- 移行は `pnpm nhi migrate-ids`（既定は dry run、`--apply` で書き込み）です。ジャーナルは書き換えず、`identity_id_migrated` のイベントを追記します。2 回目以降は何もしません。旧 ID は別名として解決し、ID ごとに 1 回だけ非推奨の警告を出します。移行前の台帳でも、新しい ID で引けば旧レコードが見つかるので、同じ NHI が二重に発行されることはありません。
- Organization profile は `knowledge/confidential/{tenant}/organizations/{org}/organization-profile.json` に置きます。読み込みは新しい置き場所を優先し、旧来の tenant 直下は 1 リリースだけ警告付きで読みます。移動は migration `0004-organization-profile-home` です。`company.ts` は同じ解決関数を使い、Company 専用の置き場所は持ちません。

### S4 — Execution Persona の廃止と Grant への一本化

- `KYBERION_PERSONA` と `Persona` 型の利用箇所を棚卸しし、目的ごとに振り分ける。
  - 権限 → Authority Role / Grant
  - プロンプトの枠付け → Team Role の addendum
  - agent ID として使っている箇所（`network.ts`）→ NHI の ID
- `authority-role-index.json` と `security-policy.json` `authority_role_permissions` を 1 つのレジストリにまとめ、もう一方は生成物にするか削除する。
- 保存先専用ロールを、tier-guard の再設計の許可証に置き換える（同計画の S 段階と並走）。
- 完了条件：Authority Role の数が今の 95 件から大きく減る。レジストリは 1 つ。`Persona` 型の import が 0 件。

#### 棚卸し（2026-11-10）

`KYBERION_PERSONA` は、テストと退役済みのコードを除いて約 190 か所で読み書きされている（テストを含めると約 1,070 か所）。`Persona` 型を import しているのは 3 ファイル（`authority.ts`、`authn/actor-context.ts`、`governance.ts` の再 export）で、`scripts/org.ts` は同じ値の型を自分で宣言している。目的ごとに振り分けると次のとおり。

| 目的                                       | 利用箇所                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 移行先                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 権限（判定の入力）                         | `authority.ts` の `resolveIdentityContext`（persona から固有の権限 `GIT_WRITE` などを出す）、`buildExecutionEnv` / `withExecutionContext*` の env の写し、`foundation/execution-scope.ts` の `resolveExecutionPersona`、`foundation/identity-context.ts`、`secure-io.ts` の子プロセス env、`tier-guard.ts` の `persona_permissions` と `project_permissions.allowed_personas`、`organization-cadence.ts` / `organization-digest.ts` の sovereign の確かめ、`project/project-view-scope.ts` の worker の絞り込み                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Authority Role（`sovereign` / `ecosystem_architect` / `worker` / `analyst` を基本の操作の束としてレジストリに置く）→ Grant |
| 権限（起動時の宣言）                       | `active-surfaces.json` と `surfaces/*.json` の起動 env（`sovereign`）、`package.json` の `config-mission` / `surfaces`、CI の workflow 3 本（`worker` / `ecosystem_architect`）、`pipelines/approval-store-hygiene.json`、pipeline-templates 2 件、`standard-intents.json`、`plugins/*` の MCP 設定（`sovereign_concierge`。Persona の値ではないので実際は `unknown` になる）、`claude-mcp-server-config.ts`、`onboarding_apply.ts`（`.env.local` に保存）、`onboarding_wizard.ts`、`tui.ts`、`company_bootstrap.ts`、`setup_oauth.ts`、`surface_runtime.ts`、`chronos_daemon.ts`、`pipeline-execution-part-results.ts`                                                                                                                                                                                                                                                                                                                                                                                   | 同上。運用者の設定に残っているので、1 リリースは非推奨の別名として読む                                                     |
| 権限（子プロセスへ渡す / 消す env の一覧） | `secure-io.ts`、`authority.ts` の起動 env、concierge の `server-child-env.ts` と `customer-decision-overview-facade.ts`、customer-room の `facade.ts`、`customer-decision/reminder-op.ts`、`pr_preflight.ts`、`install_chronos_launchd.ts`、`check_plugin_views_e2e.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 別名を外すときに一緒に消す                                                                                                 |
| agent ID・記録の主体                       | `network.ts`（egress の監査と governance action の `agentId`）、`mesh/acp-mediator.ts`、`cloudflare-os-*`、`organization-operating-model*.ts`、`organization-operation-run-recording.ts`、`tenant-governance.ts`、`project-management.ts`、`project-track-mutations.ts`、`mission_controller.ts`、`mission-controller-router.ts`、`mission-memory-commands.ts`、`mission-lifecycle-service.ts`、`mission-maintenance.ts`、`mission-scope-approval.ts`、`mission-work-reconciliation.ts`、`delegated-task-observability.ts`、`work-coordination.ts`、`claude-agent-governance.ts`、`provider-pins-store.ts`、`seam-provider-selection.ts`、`seam-selection-rules.ts`、`super-nerve`、`agent_runtime_manager.ts`、`backup.ts`、`config_mission.ts`、`knowledge.ts`、`knowledge_feedback.ts`、`cli-approval-requester.ts`、`ingest.ts` と ingest-actuator の `commit.ts`、`security-ledger.ts`、`promotion-ledger.ts`、`surface_runtime.ts`、`mcp-request-context.ts`、`authn-providers.ts` の agent-context | NHI の ID（`kyberion://agent/<tenant>/<org\|_>/<slug>`、S3）か、実行中の Authority Role 名                                 |
| プロンプトの枠付け                         | `pipeline-execution-part-bootstrap.ts` の reasoning の役割、`onboarding_apply.ts` / `onboarding_wizard.ts` の要約文、mission team の `assignedPersona`（中身は Org Role）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Team Role の addendum                                                                                                      |
| 文言・案内                                 | `error-classifier-rules.json`、`error-classifier.ts`、`tenant-registry.ts`、`company-onboarding.ts`、`project-management.ts`、各スクリプトの使い方のコメント                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 別名を外すときに書き換える                                                                                                 |

Org Role を `KYBERION_PERSONA` に写していた `scripts/compose_mission_team.ts` の経路は外した（S1 の続き）。Org Role の値が `sovereign` などの Persona の値と一致すると、チーム計画を書くプロセスの権限が上がる経路だった。

#### レジストリの一本化（2026-11-10、実装済み）

- Authority Role のレジストリは `knowledge/product/governance/authority-roles/` のカードだけになった（90 件）。カードはプロフィール（`description`、`tier_access` など）と、パスの許可 `permissions` を持つ。`security-policy.json` だけにあった 35 件は `"assignable": false` のプロセスロールのカードにした。プロセスロールはスクリプトやサービスが引き受けるだけで、チーム・組織・dot には割り当てられない（`loadAuthorityRoleIndex` は返さない）。
- `authority-role-index.json`（割り当てできる 55 件）と `security-policy.json` の `authority_role_permissions`（`permissions` を持つ 86 件、そのまま写す）は `pnpm kyberion sync authority-roles` の生成物になった。`--check` と `governance-rules` のゲート（`validateAuthorityRolePermissionProjection`）が、カードに無いロール、欠けたロール、中身の違うロールを止める。実行時の判定（tier-guard）は今までどおり `security-policy.json` を読むので、判定は変わらない。移行の前後で、両方の生成物は既存のファイルとバイト単位で同じだった（`--check` で変更 0 件）。
- `pnpm organization role create` / `promote` は、カードの `permissions` と `security-policy.json` を同じ承認の下で一緒に書く。プロフィールの書き換えでカードの `permissions` は消えない。`publication-role-migration` は、カードの `permissions` と移行元の `security-policy.json` が違えば拒否する。
- `role-authority-map.json`（Org Role → Authority Role と persona）と `role-write-access.json` は、このレジストリにはまだ入っていない。

#### 残り（2026-11-10 時点）

S4 は棚卸しとレジストリの一本化までで止めた。次の 2 つは、まだ済んでいない。

1. **保存先専用ロールを許可証に置き換える。** 残りは 29 件（`STORE_CATALOG_GRANT_GUARD_DESIGN` の G3 の節の一覧）。そのうち少なくとも 8 件は許可証の形にならないと G3 で確かめてあり、オーナーの判断を待っている。横断して読む 3 件（`workspace_graph_reader`、`concierge_management_reader`、`peer_responder_reader`）を開示（スコープモデル P4）の問いとして扱うか。業務の流れで書く 2 件（`concierge_management_writer`、`dot_lifecycle_writer`）を、流れの facade が出す複数の許可証にするか。拒否だけの 3 件（`deliverable_inbox_writer`、`customer_channel_binding_store`、`archived_mission_state_reader`）を security-policy の宣言にするか。残りの 21 件は、呼び出し元ごとに許可証の発行を足し、(主体, パス, 操作) の判定が前後で同じことを比べる表のテストを付けて、1 件ずつ外す。Authority Role の数（90）は、この段階で減る。
2. **Execution Persona をなくす。** `Persona` 型の import（3 ファイル）と、`persona_permissions` の 4 つの束（`sovereign` / `ecosystem_architect` / `worker` / `analyst`）を、レジストリの Authority Role として表し直す。`KYBERION_PERSONA` は運用者の `.env.local`、サーフェスの起動 env、CI が使っているので、1 リリースは非推奨の別名として読み、診断形式の警告を出す。1 の後に行う。

このため、concept-registry の `lifecycle` は外していない。

## 完了の合図

concept-registry から次の項目の `lifecycle` を外します：`tenant`、`organization`、`stance`、`org-role`、`team-role`、`member-role`、`authority-role`、`grant`。`execution-persona` はレジストリと GLOSSARY から削除します。同じ変更で、他の項目の `not_to_confuse_with` にある `execution-persona`（`nhi`、`conversational-persona`）も外します。
