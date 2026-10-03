---
title: Scope Governance 統合計画 (SC-01〜08)
tags: [improvement-plan, 2026-10, entity-scope, workspace, cloudflare-os, governance]
last_updated: 2026-10-03
status: draft
---

# Scope Governance 統合計画 (SC-01〜08)

> **作成日**: 2026-10-03
> **対象**: entity-scope 階層（tenant→org→project→mission→task）・workspace 隔離（WS-01〜07）・cloudflare-os 制御プレーン（OS-01〜15）の3系統の整合
> **位置づけ**: [ENTITY_GOVERNANCE_UNIFICATION_PLAN](../improvement-plans-2026-08/ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)・[CLOUDFLARE_OS_ADOPTION_PLAN](../improvement-plans-archive/2026-08/CLOUDFLARE_OS_ADOPTION_PLAN_2026-08-09.ja.md)・workspace-isolation の後続。3系統が「たまたま同じ mission_id を持つ並立機構」から「1つのスコープ平面に投影される1つの統治モデル」へ進めるための収束計画。

## 1. 統合コンセプト（何に収束するか）

**「スコープ封筒（scope envelope）一元化」**: 作業アイテムの正準コンテキスト連鎖 `tenant_slug → organization_id → project_id → mission_id → task_id`（`libs/core/entity-scope.ts` が宣言）を、runtime がディスパッチ時に**一度だけ** `security_scope` 封筒としてスタンプする。以後のすべての統治機構はこの封筒を消費し、tenant/tier を**記録に持たず owner-scope resolver（`libs/core/owner-scope.ts`）経由で導出**する。

```
work item 作成時:  context chain 宣言（entity-scope, typed context）
        ↓ dispatch 時
runtime:           security_scope 封筒をスタンプ（一度だけ・改竄不可の信頼境界）
        ↓
┌─ workspace ledger   owner={mission_id,task_id,session_id} → owner-scope で tenant/tier 導出
├─ held actions       context={missionId,taskId} + tenant は mission レコードから導出
├─ introductions      enforceIntroduction が封筒の mission/task で評価
├─ observations       tenant/tier は導出値として記録（呼び出し元は渡さない）
├─ provenance taint   mission 単位で投影 → egress floor
└─ op preflight       waterfall の標準段として上記を全 op に適用
        ↓
surfaces:            server 解決の viewer principal × tenant で投影フィルタ
```

**収束後の不変条件**:

- tenant/org/project はどの統治レコードにも**直接格納しない**。持つのは `mission_id`（+`task_id`）までで、上の階層は必ず owner-scope resolver で導出する。呼び出し元が渡す tenant 値は narrow のみ（等値一致の検証材料）で、異なれば `[POLICY_VIOLATION]`。
- 副作用の承認経路は**1本**（approval-store の held-action 化）。`pending` で中断する旧経路とキュー継続の新経路を並立させない。
- 監査（observation）・導入（introduction）・taint → egress の3段は **op-preflight waterfall の標準段**であって、actuator ごとの個別実装ではない。

## 2. 現状ギャップ（2026-10-03 時点）

| #   | ギャップ                                                                                                                                                     | 根拠                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| G1  | `security_scope` は service-actuator の `context.security_scope` でしか意味を持たない。他 actuator / pipeline op には封筒が届かない                          | `service-actuator-helpers.ts:598` `resolveTrustedScope` |
| G2  | held-action キュー（cloudflare-os-plane）と approval-store が別系統。submit の本番 caller は `automation-blueprint.ts` の introduction 要求のみ              | OS-01 は「器はあるが steering 以外未接続」と明記済み    |
| G3  | enforceIntroduction / recordObservation / projectTaint を呼ぶのは service-actuator だけ。file/code/browser/system ops は未通過                               | `service-actuator-helpers.ts:651,709,721`               |
| G4  | tenant の持ち方が非対称: workspace ledger は mission 経由導出、held action/observation は `tenantSlug` を直持ち。両者は今日は矛盾しないが、導出経路が2本ある | `HeldActionContext.tenantSlug` / `WorkspaceOwner`       |
| G5  | `CloudflareOsControlPlane` は各モジュールが `new` する分散インスタンス。共有は `control-plane.json` 永続化経由のみで、tenant 別の名前空間もない              | `service-actuator-helpers.ts:117` 等                    |
| G6  | `organization_id`/`project_id` はどちらの系統にも直接現れない（mission 経由の間接参照のみ）。監査・表面で「このアクションはどの project のものか」を引けない | entity-scope の宣言順とは未接続                         |
| G7  | surface 投影は presence-studio / chronos-mirror-v2 / computer-surface が個別実装。可視性ルールの重複                                                         | `os-control-plane.ts` × 3 系統                          |

## 3. 改善項目一覧

| ID    | タイトル                                                                         | 優先度 | 規模 | 関連                            |
| ----- | -------------------------------------------------------------------------------- | ------ | ---- | ------------------------------- |
| SC-01 | work-item scope 封筒の正規化 — `security_scope` を全 governed ディスパッチに拡張 | **P0** | M    | entity-scope-hierarchy / SO-04  |
| SC-02 | held-action の封筒アンカー化 + approval-store 統合（OS-01 完成）                 | **P0** | L    | OS-01 / KC-03                   |
| SC-03 | workspace owner の封筒整合 — session を含む owner 照合を統一                     | P1     | S    | WS-05                           |
| SC-04 | introduction/observation/taint を op-preflight waterfall の標準段化              | **P0** | M    | DH-01 / OS-03/04/05             |
| SC-05 | 制御プレーンの tenant 名前空間 + 単一ファサード                                  | P1     | M    | OS 系 / multi-tenant-operations |
| SC-06 | egress floor を write op に水平適用（taint → deny の choke point）               | P1     | M    | OS-05 / egress-policy           |
| SC-07 | surface 投影の共有アダプタ化                                                     | P2     | S    | ViewerContext / OS surface      |
| SC-08 | 統合アーキテクチャ文書 + 不変条件テスト                                          | P2     | S    | docs / check 系                 |

依存: SC-01 → (SC-02, SC-03, SC-04) → (SC-05, SC-06) → SC-07 → SC-08。

---

### SC-01: work-item scope 封筒の正規化（P0 / M）

**現状**: `security_scope`（`ContextSecurityScope`: mission_id/tenant_id/read_tiers/purpose/participant_id 等）は service-actuator と participant-context-resolver の周辺でしか意味を持たない。`op-preflight-defaults.ts` の `scopeResult` は個別フィールド（tenant_slug/organization_id/project_id/mission_id/task_id）を拾って `validateScopeContext` にかけるが、これは「呼び出し元が書いた値」の検証であり、runtime スタンプではない。

**実装**:

1. `ContextSecurityScope` を正準の「work-item scope 封筒」として昇格させ、項目を正準連鎖に合わせる: `{tenant_slug, organization_id?, project_id?, mission_id, task_id?, participant_id?, read_tiers, purpose, stamped_by}`。schema は `knowledge/product/schemas/` に登録し `validateContextSecurityScope` を拡張。
2. スタンプ点を dispatch 境界に固定: `runOpPreflight` 呼び出し側（pipeline executor / actuator dispatch / delegation spawn）が**1度だけ**封筒を付ける。すでに封筒がある入力はスタンプ上書きせず一致検証のみ（narrow のみ許可・矛盾は `[OP_SCOPE_DENIED]`）。
3. `organization_id`/`project_id` はスタンプ時に mission レコードから owner-scope 解決して封筒に含める（G6 解消）。呼び出し元が org/project を書くのは検証用の一致確認に限る。
4. mission_controller の task 発行・worker dispatch・pipeline runner の3経路で封筒が必ず届く回帰テスト。

**受入条件**: service-actuator の既存 `resolveTrustedScope` が新封筒をそのまま消費して退行しないこと / 封筒なしの governed op が `warn` ログで検出できること（enforce は SC-04 で段階導入）/ org/project が監査レコードに現れること。

### SC-02: held-action の封筒アンカー化 + approval-store 統合（P0 / L）

**現状**: `HeldActionContext` は `{missionId, taskId?, tenantSlug?}` で tenant を直持ち（G4）。キューは approval-store と別系統で、submit の実 caller は `automation-blueprint.ts` の introduction 要求のみ（G2）。steering だけが approval-store 経由の held execution（`ApprovalSteeringAction` → `scheduleSteeringApprovalExecution`）。

**実装**:

1. `HeldActionContext` を封筒参照に置き換える: `{missionId, taskId?, scope: ScopedRef}`。`tenantSlug` フィールドは**廃止し**、表示・フィルタ時に owner-scope resolver で導出（G4 解消）。既存永続レコードは読み取り時に tenantSlug を検証値として扱い、不一致なら監査警告。
2. `ApprovalSteeringAction` を一般化した `ApprovalHeldAction {op, params, effectBinding, scope}` を approval-store に導入し、`submitHeldAction` をその薄い写経にする。`decideApprovalRequest(approved)` が held action を単一 choke point（`applyHeldAction`）で実行する構造は維持。`resolvedBy`/`appliedAt` 必須・`payloadHash`+`effectBinding` 束縛はそのまま。
3. `enforceApprovalGate` の `approval_required` 中断経路に「中断せず held に積んで続行」分岐を op 宣言単位で追加（OS-01 §3-4 と同型）。シミュレート可否は op の `simulatable` 宣言。
4. steering を最初の移行例として新経路へ載せ替え、旧経路を削除。

**受入条件**: steering の回帰 / held action が承認で一度だけ実行される冪等 / 却下・期限切れで実行されない / `resolvedBy` なし適用が型・実行両面で不可能 / audit-chain に submit→decide→apply の3記録。

### SC-03: workspace owner の封筒整合（P1 / S）

**現状**: `WorkspaceOwner {mission_id?, task_id?, session_id?}` — tenant は持たず、sweep は「owning mission が terminal」で orphan 判定する正しい設計。ただし owner 照合はフィールド個別比較。

**実装**: `WorkspaceOwner` を SC-01 の封筒サブセット（mission_id/task_id/session_id）として型共有し、sweep・budget reclaim の orphan 判定で owner-scope 解決を統一利用（「terminal mission」「tenant 越境」両方を resolver 経由で）。`session_id` only owner（mission なし）は `system/` floor と明示。

**受入条件**: tenant A の mission を持つ workspace が tenant B の viewer/CLI から不可視（`workspace list` にも出ない）/ mission terminal → 掃除の既存挙動に退行なし。

### SC-04: introduction/observation/taint の op-preflight 標準段化（P0 / M）

**現状**: 3段とも service-actuator 内部の手続き呼び出し（G3）。`runOpPreflight` は既に serial admission waterfall + monotonic guard の器を持つ。

**実装**: waterfall に3段を標準 listener として追加し、service-actuator は薄い呼び出しに退化させる。

1. **scope 段**（既存 `scopeResult` を拡張）: 封筒の必須性を op 種別で判定（read のみ op は warn、write op は enforce）。
2. **introduction 段**: `enforceIntroduction(missionId, service/resourceRef, scope)`。op 入力の `resource_ref`/`service_id`/`target.application` 等から resource ref を正規化する op 別マッピング表を追加（最初は service/file/browser/system の4族）。
3. **observation 段**（post-op）: read 系 op の結果を `recordObservation` に流す。tenant/tier は封筒→resolver 導出で、呼び出し元入力は使わない。
4. **taint 段**: write 系 op の preflight で `projectTaint` を計算し egress context に添付（SC-06 で消費）。

**受入条件**: file/code/browser/system の read が observation に記録される / introduction 未付与の write が `[POLICY_VIOLATION]` で止まる / service-actuator 経由の既存テストが全て通る（薄い呼び出し化の回帰）。

### SC-05: 制御プレーンの tenant 名前空間 + 単一ファサード（P1 / M）

**現状**: モジュールごとの `new CloudflareOsControlPlane()` が単一 `control-plane.json` を共有（G5）。tenant 名付きレコードはあっても格納がフラット。

**実装**: `getControlPlaneForScope(scope)` ファサードを導入。永続化を `runtime/cloudflare-os/<tier>/<tenant|shared>/control-plane.json` に分割（storage-layout の floor 規則に従う）。解決不能な tenant のアクセスは fail-closed（owner-scope resolver と同じ「not found として読む」規則）。既存フラットファイルは起動時に tenant 別へ移行する one-shot マイグレーション。

**受入条件**: tenant A のプロセスが tenant B の held action/observation を列挙・決裁ともに不可能 / 移行前後で pending action の喪失なし / `KYBERION_TENANT` 非束縛プロセスは shared のみ見える。

### SC-06: egress floor の write op 水平適用（P1 / M）

**現状**: `assertEgressAllowed` は存在するが caller がほぼない。taint の tier 単調性（personal→confidential→public）+ tenant 包含の規則は実装済み。

**実装**: SC-04 の taint 段で付けた egress context を、外部送信系 op（presence dispatch、service write、publish、mail send）の monotonic guard で `assertEgressAllowed` に接続。`external` は常に拒否、tenant 不一致は拒否、tier 格下げ流出は拒否。audience floor（`egress-audience-floor`）と規則の重複を1つの判定関数に統合。

**受入条件**: confidential 観測後の public 宛 write が deny / tenant A 観測後の tenant B 宛 write が deny / taint なし mission は従来通り通過。

### SC-07: surface 投影の共有アダプタ化（P2 / S）

**現状**: presence-studio / chronos-mirror-v2 / computer-surface がそれぞれ access 解決+フィルタを実装（G7）。

**実装**: `CloudflareOsSurface`/`CloudflareOsReadOnlySurface` の上に `resolveOsSurfaceAccess(req)` 共有ヘルパを置き、3 surface はそれを呼ぶだけにする。`KYBERION_VIEWER_SCOPE` スタンプ済み viewer → `{principalId, tenantSlugs, tierAccess}` の解決を一元化。

**受入条件**: 3 surface で同一 viewer に同一の可視集合が返る契約テスト / decision 面は `human:` principal 必須のまま。

### SC-08: 統合アーキテクチャ文書 + 不変条件テスト（P2 / S）

**実装**: `knowledge/product/architecture/scope-governance-plane.md` を新設し、本計画 §1 の図・不変条件・各機構の責務分離を canonical として記述。`entity-scope-hierarchy.md`/`workspace-isolation.md`/`multi-tenant-operations.md` から相互リンク。不変条件は `check_*` 系に加える: (a) 統治レコードに tenant 直持ちフィールドが増えないスキーマ検査、(b) preflight 段順序の固定テスト、(c) G2/G4/G5 の回帰（approval 経路1本・tenant 導出1経路・制御プレーン名前空間）。

**受入条件**: 文書が mission dispatch の context pack に載る（role/phase affinity 付き）/ 不変条件テストが CI で fail-closed。

## 4. 段階

- **Phase 1（P0）**: SC-01 → SC-04 → SC-02。「封筒→全 op 通過→承認1本化」で概念の骨格を先に成立させる。
- **Phase 2（P1）**: SC-03 → SC-05 → SC-06。tenant 整合と egress choke point。
- **Phase 3（P2）**: SC-07 → SC-08。表面統一と文書化。

## 5. 実行者ノート

- `CloudflareOsControlPlane` は public API を壊さず内部を差し替える方針（SC-02/05 は互換 shim を先に置く）。
- tenant 直持ちフィールドの廃止（SC-02-1）は persisted state の後方互換読み取りを必須とする — 削除ではなく検証値化。
- 各 SC は独立 PR 可能な粒度にしてあるが、SC-01 無しの先行はしない（封筒が全項目の共通土台）。
- 本計画は OS-01/03/04/05 と WS-05 の「配線の水平展開」であり、新規概念の追加は SC-08 の統合文書のみ。
