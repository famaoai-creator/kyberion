---
title: スコープ・ID・権限（Grant）の統合計画
kind: plan
status: partial
last_updated: 2026-11-11
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
- テナントに属さない NHI（個人用オンボーディングのエージェント、tenant なしで起動した実行体）は `kyberion://agent/_/_/<slug>` です。オーナーの判断（2026-11-10）で、tenant の位置の `_` は正式に「tenant なし」を表すことになりました（GLOSSARY、NHI_IDENTITY_MAPPING に記載。コードの変更はなし）。`_` は tenant の slug にはなりません。
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
- `role-authority-map.json`（Org Role → Authority Role と persona）は、2026-11-11 に Org Role のカードからの生成物になった（下の「残り」の 3）。`role-write-access.json` は、このレジストリにはまだ入っていない。

#### 保存先専用ロールの許可証化（2026-11-10、S4 の 3 つ目）

オーナーの判断（2026-11-10）：

- 横断して読む 3 件（`workspace_graph_reader`、`concierge_management_reader`、`peer_responder_reader`）は常設のロールにせず、読むたびに確かめて監査に残す開示（スコープモデル P4）にする。
- 業務の流れで書く 2 件（`concierge_management_writer`、`dot_lifecycle_writer`）は、流れの窓口が書き込みごとに狭い許可証を出す。常設のロールにしない。
- 拒否だけの 3 件（`deliverable_inbox_writer`、`customer_channel_binding_store`、`archived_mission_state_reader`）は、ロールではなく `security-policy.json` の明示した拒否の宣言にする。
- tenant を持たない NHI の ID は `kyberion://agent/_/_/<slug>` のまま。tenant の位置の `_` は正式に「tenant なし」を表す（GLOSSARY、NHI_IDENTITY_MAPPING に記載。コードの変更なし）。

実装（`libs/core/foundation/declared-store-grant.ts`、`authority.ts` の `withStoreGrant` / `withStoreGrantAsync`）：

- 保存先専用ロールは **宣言された許可証（declared store grant）** になった。許可証の操作は `security-policy.json` の `store_grants.<name>` に、旧ロールの `allow_read` / `allow_write` / `deny_read` / `deny_read_descendants` / `narrow` をそのまま移した。カード、`authority-role-index.json`、`authority_role_permissions`、`role-write-access.json` からは消え、保存先カタログでは `legacy_roles` から `grants` に移した。
- 許可証を開けるのは保存先の窓口だけ（`withStoreGrant`）。発行の条件は旧ロールの引き受けと同じ RA-02 の規則（名前は `role-assumption-policy.json` に発行の権利として残る）と、tenant の束縛の規則。`withExecutionContext(name)` は拒否する。窓口が開いたモジュール内の token がある間だけ宣言が判定に使われ、偽造・複製・期限切れの token は何も解決しない。RN-02 の到達性解析は `withStoreGrant*` の呼び出しも数える。
- 横断して読む許可証（`disclosure`）は、開くたびに監査チェーンへ `store_grant.disclosure` を記録し、記録できなければ開かない。Concierge の管理の窓口は、正確な上限に入る前に記録して 1 回だけ使える受領を渡す（`recordStoreGrantDisclosure`）。呼び出し元がすでに別の上限の中にいるとき（情報資産のカタログなど）も記録する。記録（許可証の名前、主体、束縛した範囲、操作。tenant の中身は含まない）はシステムの範囲の記録で、tenant の印を付けず（束縛した tenant はメタデータ）、台帳本体だけに入る。監査チェーン自身の書き手（`audit_mirror_writer`。呼び出し元ではない）が、呼び出し元の上限の外で追記する（`auditChain.recordDurable`。台帳本体への書き込みが失敗すれば例外）。呼び出し元の I/O は上限の中のまま。上限から出る関数（`runDisclosureAuditOutsideResourceCeilings`）を使えるのは `authority.ts` の開示の記録だけ（`tests/resource-ceiling-audit-exit-boundary.test.ts`）。記録できなければ読まない（2026-11-10、隙間を閉じた）。
- 許可証の名前は新しいロールに使えない（`collectExistingRoleIds` が予約する）。同じ名前の `authority_role_permissions` の項目があっても、許可証の宣言は変わらない（`rolePermissionRecord`）。
- 流れで書く 2 件：Concierge の管理の書き込みは、窓口が書き込みのたびに正確な上限の中で許可証を出す。`dot_lifecycle_writer` は以前に `dot_charter_store` と `dot_lifecycle_runtime_store` に分けてあり、その 2 つを dot の窓口が書き込みのたびに出す許可証にした。
- 拒否だけの 3 件：`narrow` の宣言（`only` / `deny` / `content_check` / `require_scope`）を `store_grants.<name>.narrow` に移した。これが security-policy の明示した拒否の宣言で、許可証が開いている間だけ効く（許可証が開いていない名前の I/O は、そもそもすべて拒否する）。
- 意図した違い（狭くなる側だけ）：`SYSTEM_ROLE` / `MISSION_ROLE` / 委譲された環境変数でその名前として動くプロセスや、許可証の中から起動した子プロセスは I/O が一切できない（`[STORE_GRANT_REQUIRED]`）。旧ロールではそのロールの権限を持てた。
- 比較：`tests/fixtures/store-grant-equivalence.json` に、基準 `19b0a6a01` で 30 件のロールそれぞれの (呼び出し元 6 種, パス, 操作 5 種) の判定を記録した。`libs/core/testing/store-grant-equivalence.test.ts` が、許可証にしたものは許可証で、まだロールのものはロールで同じ表を作り直して突き合わせる。違いは上の env の行だけ。

数（カードの数。`authority-roles/*.json`）：

| 時点                      | Authority Role    | うち保存先専用                                   | 宣言された許可証 |
| ------------------------- | ----------------- | ------------------------------------------------ | ---------------- |
| 3 つ目の前（`19b0a6a01`） | 90                | 30（`dot_lifecycle_writer` を分けた 2 件を含む） | 0                |
| 3 つ目の後                | 62                | 2                                                | 28               |
| 残り 2 件の後             | 60                | 0                                                | 30               |
| base role を足した後      | 64（うち base 4） | 0                                                | 30               |

#### 残り（2026-11-10 時点）

1. **保存先専用ロールの残り 2 件（2026-11-10、済み）。** `notification_preferences_reader`（`surface/operator-notifications.ts`）と `tool_runtime_policy_reader`（`tool/tool-runtime-policy.ts`）も宣言された許可証にした。インストール先の公開ロールの移行（`organization/publication-role-migration.ts`、`pnpm organization role migrate-publication-store`）は、ロールのカード・権限・索引ではなく、`store_grants` の宣言と発行の権利（shared core roles）を写す。実行するコードが宣言していない名前、移行元にまだロールとして残っている名前、移行元に宣言か発行の権利が無い名前は写さない。比較の表は 3 つ目と同じ基準で、違いは env の行だけ。
2. **Execution Persona をなくす（S4 の 4 つ目）。** 一部済み（2026-11-10）。
   - 済み：`persona_permissions` の 4 つの束を、レジストリの base Authority Role `base_sovereign` / `base_ecosystem_architect` / `base_worker` / `base_analyst`（`"assignable": false` のカード、`authority_role_permissions` は生成物）として表し直し、`security-policy.json` から `persona_permissions` を外した（スキーマでは 1 リリースだけ任意の非推奨の項目として残し、base role の無い古い catalog はそこから読む）。tier-guard（`tier-guard.ts`、`tier-guard-tenant-store-partitions.ts`）は persona が指す base role の権限を足す（`foundation/base-authority-role.ts`）。base role は自分のロールにならない（引き受けは `[ROLE_ASSUMPTION_DENIED]`、env でその名前として動いても記録を解決しない）。宣言された許可証の `persona: 'worker'` は `baseRole: 'base_worker'` にした。比較：`tests/fixtures/base-authority-role-equivalence.json` に、変更前の (プリンシパル 54 種 = ロール 5 種 × persona 6 種 × env／プロセス内, パス 215, 操作 3 種) の判定と、解決した persona・authority を記録し、`libs/core/testing/base-authority-role-equivalence.test.ts` が作り直して突き合わせる。違いは無い。
   - 済み（agent ID）：policy-engine の `agentId`（レート制限の枠の鍵）、kill switch の記録、監査の `agentId` は、persona の文字列ではなく実行中の NHI の ID になった（`governance/execution-agent-id.ts` の `executionAgentId`）。`KYBERION_NHI_ID` があればそれ、なければ `kyberion://agent/<tenant>/<org|_>/<slug>`（tenant と Org はプロセスの env、slug は base role の名前の `_` を `-` にしたもの、なければ呼び出し元の部品名、なければ `unknown`）。対象は `secure-io.ts`、`network.ts`、`operation-policy-gate.ts` と、監査の記録の主体を persona から取っていた箇所（`organization-operating-model*.ts`、`organization-operation-run-recording.ts`、`tenant-governance.ts`、`project-management.ts`、`project-track-mutations.ts`、`acp-mediator.ts`、`work-coordination.ts`、`claude-agent-governance.ts`、`cloudflare-os-journal-store.ts`、`mission_controller.ts`、`mission-controller-router.ts`、`mission-memory-commands.ts`、`config_mission.ts`、`agent_runtime_manager.ts`、`organization_member.ts`、`surface_runtime.ts`）。比較：`tests/fixtures/agent-nhi-id-equivalence.json` に、変更前の判定の列（プロセス 5 種 × プリンシパル最大 12 種、`api_call` を 65 周、ほかの規則 8 種）を記録し、`libs/core/testing/agent-nhi-id-equivalence.test.ts` が新しい ID で作り直す。NHI の ID を名乗らないプロセスでは同じ。`KYBERION_NHI_ID` を名乗るプロセスと、slug にならない persona の文字列では、別々だった枠が 1 つになることがあるので、狭くなる側だけ（前に拒否したものを許可しない）を確かめる。kill switch の停止は `agentRegistry` のキー（manifest の slug）で引くので、URI の ID と一致することはなく、前と同じく停止まで進まない。
   - 済み（env の名前）：`KYBERION_PERSONA` は `KYBERION_BASE_ROLE` になった。値は base Authority Role の短い名前（`worker` はカード `base_worker`。カード名そのものも受け付ける）。読むのは `foundation/base-role-env.ts` の `baseRoleEnvText` の 1 か所だけで、旧名は 1 リリースだけ、`KYBERION_BASE_ROLE` が env に無いときに限り、診断形式の警告（`what — why | next | evidence`）を 1 回出して読む。空の `KYBERION_BASE_ROLE` は「base role なし」で、旧名に戻らない（消す側が旧名の値を通すことはない）。書く側は新しい名前だけを書き、子プロセスの env を作るときは旧名を落とす（`writeBaseRoleEnv`）。同じ変更で、子プロセスへ渡す／消す env の一覧（`foundation/env.ts`、`secure-io.ts`、`authority.ts` の `AUTHORITY_ENV_KEYS` と `buildSystemRoleLaunchEnv`、concierge と customer-room の facade、`reminder-op.ts`、`install_chronos_launchd.ts`、`pr_preflight.ts`、`check_plugin_views_e2e.ts`、`chronos_daemon.ts`、`setup_oauth.ts`）には両方の名前を書き、起動の宣言（`active-surfaces.json`、`surfaces/*.json`、`package.json`、CI の workflow 3 本、`pipelines/approval-store-hygiene.json`、pipeline-templates 2 件、`standard-intents.json`、`plugins/*`）と、運用の文書・エラーの案内は新しい名前にした。`.env.local` の保存（`reasoning_backend_selection.ts`）は新しい名前で書き、旧名も読む。`tests/base-role-env-key-list-boundary.test.ts` が、一覧が片方の名前しか書いていないこと、env の値を作る箇所が旧名だけを書くこと、`base-role-env` の外で旧名を読み書きすること、起動の設定が旧名を書くことを止める。テストは `tests/vitest-legacy-base-role-env-guard.ts` で旧名を env から外す（運用者のシェルや古い CI の値が混ざらない）。比較：`base-authority-role-equivalence` の表（54 プリンシパル × 215 パス × 3 操作）は、新しい名前で作り直しても同じ。
   - 済み（型と契約）：`Persona` 型は `BaseRole`（`libs/core/types.ts`、値は同じ 6 つ）になり、`Persona` を import するファイルは 0 件になった（`Persona` は外部の利用者のために 1 リリースだけ `@deprecated` の別名として残す。`governance.ts` は `BaseRole` を再 export する）。`IdentityContext.persona` は `IdentityContext.baseRole`、`ActorContext.authority.persona` は `authority.baseRole`、`readConfiguredActorIdentity()` の `persona` は `baseRole` になった。読む側（tier-guard、tenant store partition、dot、tenant-governance、tenant-rate-limiter、tenant-rename、mission-task-supersede、cli-usage-metering、seam-selection-defaults、reasoning-selection-settings、pipeline-run-journal、chronos_daemon、dot_charters、promotion-ledger、pipeline-execution-part-results）も同じ変更で切り替えた。判定の入力は名前が変わっただけで、`base-authority-role-equivalence` と `agent-nhi-id-equivalence` の表は変わらない。保存されている記録の項目名は変えていない：pipeline の実行記録（`execution_authority.persona`、`identity.persona`。再開のときに元の権限と突き合わせる）と、authn の `executionContext.persona`（入力の契約）。これらは保存済みの値を 1 リリース読むために残し、書き手と読み手を同時に移す別の変更にする。関数名の `inferPersonaFromRole`、`resolveExecutionPersona`、`executionPersonaText` も同じく別の変更にする。
   - 済み（`allowed_personas`）：`security-policy.json` の `project_permissions.<project>.allowed_personas` は `allowed_base_roles` になった（値は同じ base role の短い名前）。tier-guard は `allowed_base_roles` を読み、それが無いインストール先の古い catalog に限り 1 リリースだけ `allowed_personas` を読む。両方あれば新しい方だけを使う。配列でない値は何も許さない（以前は文字列の部分一致になりえた。狭くなる側だけ）。拒否の文言は `Base role '<x>' is not authorized for project '<p>'`。比較：`libs/core/tier-guard-project-base-roles.test.ts` が、古い名前の catalog と新しい名前の catalog で (base role 6 種 × SUDO の有無 × パス 2 × 読み書き) の判定が同じであること、両方あるときに新しい方だけを読むことを確かめる（読み替えを外すと失敗する）。出荷する policy での判定は `base-authority-role-equivalence`（`canton-node` のパスを含む）で変わらない。
   - 残り：保存されている記録と入力の項目名（pipeline の実行記録の `execution_authority.persona` / `identity.persona`、authn の `executionContext.persona`）と、関数名（`inferPersonaFromRole`、`resolveExecutionPersona`、`executionPersonaText`、execution scope の `assumedPersona`）。前者は書き手と読み手を同時に移し、保存済みの値を 1 リリース読む別の変更にする。1 リリース後に `KYBERION_PERSONA` と `allowed_personas` の読み替え、`Persona` 型の別名を外す。
3. **`role-authority-map.json` と `role-write-access.json`。** `role-authority-map.json` は 2026-11-11 に済んだ。`role-write-access.json` は見送り（理由は下）。
   - オーナーの判断（2026-11-11）：Org Role の既定の Grant は、Org Role の側（`knowledge/product/roles/<role>/`）に宣言する。
   - 済み：27 の Org Role のディレクトリそれぞれにカード `role.json`（スキーマ `org-role-card.schema.json`）を置いた。カードは `role_class`（`system` / `mission` / `context`。表の 3 つの群）と `default_grant`（`authority_role`：Authority Role のカードか `null`、`base_role`：base role の短い名前、`execution_mode`：`system` / `mission` / `sovereign`）を持つ。カードはレジストリの項目を指すだけで、それ自体は何も許可しない。表にあった system / mission のロール（`mission_controller` など）にも Org Role のディレクトリが既にあったので、置き場所に迷うロールは無かった。
   - 済み：`role-authority-map.json` は `pnpm kyberion sync org-role-grants`（`scripts/sync_org_role_grants.ts`）の生成物になった。`--check` は pr のゲート `org-role-grants`（`ci-gates.json`）で、`pnpm kyberion resolve generated` の手順にも入れた。`authority_role` がレジストリのカードに無いとき、base role の名前（`base_worker` など）を指すとき、`base_role` が知られていない base role のとき（`BASE_AUTHORITY_ROLES` の 4 つと、カードを持たない `mission_owner` 以外）、生成は `[ORG_ROLE_GRANT_INVALID]` で失敗する。カードの読み込み・検証・射影は `organization/authority-role-registry.ts`（`loadOrgRoleCards`、`validateOrgRoleCards`、`projectRoleAuthorityMap`）。作り直した表は、説明文を除いて前のファイルと同じ（`jq -S 'del(.description)'` の差分なし、並びも同じ）。読む側（`authority.ts` の `inferPersonaFromRole`、`scripts/org.ts`）は生成物をそのまま読む。
   - 済み：`pnpm organization role create` / `promote` は、同じ承認の下でカードの `default_grant` と表の射影を一緒に書く。`promote` は、既にあるロールの群（`role_class`）を保つ。以前は昇格したロールを必ず `context_roles` に移していた（群を読む判定は無い）。カードの無いインストール先の表の項目は、そのまま残す。
   - 比較：`tests/fixtures/org-role-default-grant-equivalence.json` に、変更前（`91f99beef`）の表の 27 ロールと、知らないロール・空のロールについて、表を読むすべての箇所が返す値（表の項目、`inferPersonaFromRole`、`MISSION_ROLE=<role>` での `resolveIdentityContext` の base role と authority、`withExecutionContext(role)` が結ぶ persona、`collectExistingRoleIds`）を記録し、`scripts/org-role-default-grant-equivalence.test.ts` が作り直して突き合わせる。違いは無い。
   - 見送り：`role-write-access.json`。Org Role のカードに入れる（同じカードの `write_access` にする）ことはできない。理由：(1) 鍵は Org Role ではなく Authority Role の名前（`upsertRoleWriteAccess(rootDir, authorityRoleId, …)`）。20 件のうち 10 件（`slack_bridge`、`chronos_gateway`、`chronos_operator`、`chronos_mirror_v2`、`chronos_localadmin`、`surface_runtime`、`decision_ledger`、`daemon_watchdog`、`organization_operator`、`dot_lifecycle_worker`）には Org Role が無く、`ceo` には Authority Role のカードが無い。(2) Org Role のカードに書き込みの範囲を持たせると、「Org Role は自分の権限を持たない」（D6）に反する。(3) 中身は Authority Role のカードの `write_scopes` と 7 件、`authority_role_permissions` の `allow_write` と 11 件しか一致しないので、どちらからの生成にしても内容が変わる。実行時の判定には使われていない（読むのは `scripts/org.ts` の `collectExistingRoleIds`（名前の予約）と、`scripts/org.test.ts`、`tests/slack-chronos-governance-contract.test.ts`）ので、行き先は Authority Role のカードに入れるか、ファイルごと消すかのどちらかになる。どちらも `role create` / `promote` の流れと名前の予約を変えるので、オーナーが決めてから別の変更にする。

concept-registry の `lifecycle` は、この変更でも外していない。D6 の「レジストリは 1 つ」は、`role-write-access.json` が Authority Role ごとの書き込みの範囲を手で持つ 2 つ目の一覧として残っている間は満たしていない（上の見送り）。各項目の状況（2026-11-11）：

- `authority-role`、`grant`（D6）：Authority Role の数（95 → 64）、`Persona` 型の import 0 件、Org Role → 既定の Grant の置き場所は済んだ。`role-write-access.json` の扱いが残る。
- `org-role`（D5）：既定の Grant はカードに移り、Org Role は権限を持たなくなった。ただし team plan はまだ `assigned_persona` を書き（`mission-team-plan-composer.ts`）、`assignedPersona`（中身は Org Role）と `--persona` のフラグも残る。
- `team-role`（D5）：プロンプトの枠付けを Team Role の addendum へ移す作業（棚卸しの表の「プロンプトの枠付け」）が残る。
- `member-role`（D5）：S1 の完了条件（型の一本化と境界テスト `tests/tier-member-role-type-boundary.test.ts`）は満たしている。この項目だけを外すかは、オーナーが決める（この計画の完了の合図はすべての項目をまとめて外す）。
- `tenant`、`organization`（D3、S3）と `stance`（D4、S2）：この変更の範囲外。旧 ID の別名、旧来の Organization profile の読み込み、`KYBERION_CUSTOMER` の読み替え（どれも 1 リリース）が残る。
- `execution-persona`：`Persona` 型の別名と `KYBERION_PERSONA`、`allowed_personas` の読み替え（どれも 1 リリース）が残っている間は、レジストリと GLOSSARY に残す。保存されている記録の項目名（`execution_authority.persona`、`identity.persona`、`executionContext.persona`）と関数名（`inferPersonaFromRole` など）も残る。

## 完了の合図

concept-registry から次の項目の `lifecycle` を外します：`tenant`、`organization`、`stance`、`org-role`、`team-role`、`member-role`、`authority-role`、`grant`。`execution-persona` はレジストリと GLOSSARY から削除します。同じ変更で、他の項目の `not_to_confuse_with` にある `execution-persona`（`nhi`、`conversational-persona`）も外します。
