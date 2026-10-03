---
title: Scope Governance 統合計画 (SC-01〜09)
tags: [improvement-plan, 2026-10, entity-scope, workspace, cloudflare-os, governance]
last_updated: 2026-10-03
status: draft
revision: 2
---

# Scope Governance 統合計画 (SC-01〜09)

> **作成日**: 2026-10-03（rev.2 同日改訂）
> **対象**: entity-scope 階層（tenant→org→project→mission→task→session）・workspace 隔離（WS-01〜07）・cloudflare-os 制御プレーン（OS-01〜15）の3系統の整合
> **位置づけ**: [ENTITY_GOVERNANCE_UNIFICATION_PLAN](../improvement-plans-2026-08/ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)・[CLOUDFLARE_OS_ADOPTION_PLAN](../improvement-plans-archive/2026-08/CLOUDFLARE_OS_ADOPTION_PLAN_2026-08-09.ja.md)・workspace-isolation の後続。3系統が「たまたま同じ mission_id を持つ並立機構」から「1つのスコープ平面に投影される1つの統治モデル」へ進めるための収束計画。

## 0. 改訂履歴（rev.1 → rev.2）

rev.1 をコード（`main` @ `dc3330dd`）と突き合わせた結果、前提の誤りと設計上の欠落があったため以下を改訂した。

| 区分     | rev.1                                                     | rev.2                                                                                                                                          |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 前提修正 | `security_scope` は service-actuator でしか意味を持たない | `op-preflight-defaults.ts` の `scopeResult` が既に検証・block している。ギャップは「届かない」ではなく「呼び出し元が作り、runtime が作らない」 |
| 前提修正 | `ContextSecurityScope` に正準連鎖の項目を「足す」         | 項目は既にある。不足は**型の並立**（4種）と信頼アンカーの欠如。新型 `ScopedRef` は作らず `ScopeContext` に収束                                 |
| 前提修正 | surface は3系統                                           | `new CloudflareOsControlPlane()` は5箇所（operator-surface を含む）                                                                            |
| 概念変更 | tenant は記録に持たず read 時に resolver で導出           | **dispatch 時に1度スナップショットして不変保存、read 時は resolver で一致検証**（監査の自己完結性・tenant 分割保存と両立）                     |
| 概念変更 | 封筒 = 1つのフラットな構造                                | 封筒 = **識別（identity）層 + 方針（policy）層**の2層。policy は委譲時に narrow のみ可能な減衰型ケイパビリティ                                 |
| 追加     | —                                                         | 制御プレーン永続化の**多プロセス lost-update** 解消（SC-03）                                                                                   |
| 追加     | —                                                         | held action の**再起動後実行不能**の解消（executor レジストリ・SC-04）                                                                         |
| 追加     | —                                                         | op の**副作用宣言**（read/write/egress）を manifest に導入（SC-02）                                                                            |
| 追加     | —                                                         | taint の**承認付き declassify** 経路、observation の集約・容量設計、mission なし作業の封筒                                                     |
| 順序変更 | SC-01 → SC-04 → SC-02 → SC-03 → SC-05 → SC-06             | 永続化の土台（SC-03）を held-action 統合（SC-04）の前に置き、データ移行を1回で済ませる                                                         |

ID 対応: rev.1 SC-01→SC-01 / SC-02→SC-04 / SC-03→SC-07 / SC-04→SC-05 / SC-05→SC-03・SC-08 に分割 / SC-06→SC-06 / SC-07→SC-08 / SC-08→SC-09。SC-02 は新設。

## 1. 統合コンセプト（何に収束するか）

**「runtime が発行する2層スコープ封筒」**: 作業アイテムの正準コンテキスト連鎖（`libs/core/entity-scope.ts` の `ENTITY_SCOPE_HIERARCHY`）を、runtime が dispatch 時に**1度だけ**発行する。封筒は呼び出し元の入力から組み立てず、**プロセスの認証済み身元**（`MISSION_ID` 等の登録 env・work-item claim・session）から導出する。

```
封筒 (ScopeEnvelope)
├─ identity: ScopeContext            … tenant_slug → organization_id → project_id → mission_id → task_id → session_id
│                                       （libs/core/scope-context-validation.ts の既存型。新型を作らない）
│                                       → 統治レコードに「スナップショット」として不変保存
└─ policy:   ScopePolicy             … read_tiers / write_tier / purpose / external_egress / allowed_reasoning_backends
                                        → op ごと・委譲ごとに narrow のみ可能（attenuation）
```

```
work item 作成:   context chain 宣言（typed context）
      ↓ dispatch（mission_controller task 発行 / worker spawn / pipeline runner / delegateTask）
runtime:          身元から封筒を発行（mint）。入力に封筒があれば「narrow 要求」として扱い、拡大は [OP_SCOPE_DENIED]
      ↓
op-preflight waterfall（op の effect 宣言で段を選択）
  scope 段 → introduction 段 → taint/egress 段 → (op 実行) → observation 段
      ↓
統治レコード（held action / observation / introduction / workspace / audit）
  identity スナップショットを保存 → read 時に owner-scope resolver で一致検証（不一致は監査警告、認可は fail-closed）
      ↓
surfaces:         server 解決の viewer principal × tenant で投影（共有アダプタ1本）
```

**収束後の不変条件**:

1. **封筒は runtime だけが発行する**。呼び出し元が渡す scope 値は narrow 要求か一致検証の材料に限られ、封筒を拡大しない。`stamped_by` のような自己申告フィールドは信頼根拠にしない。
2. **識別はスナップショット + 検証**。統治レコードは dispatch 時の identity を保存し、後から書き換えない。認可判定は保存値と resolver 導出値の両方が一致した場合のみ通す（mission ledger 消失後も監査レコードは自己完結で読める）。
3. **スコープ型は1つ**。identity は `ScopeContext`、`EventScope`・`WorkspaceOwner`・held-action の scope はその部分型/射影。新たな並立型を追加しない。
4. **副作用の承認経路は1本**（approval-store）。承認時に実行関数が引けないキュー（再起動で fail-closed になる executor closure）を残さない。
5. **introduction / taint→egress / observation は op-preflight waterfall の標準段**であり、actuator 個別実装ではない。どの段を通すかは op の **effect 宣言**で決まり、宣言なしは write 扱い。
6. **制御プレーンの状態は単一書き手規律**（ロック or 追記ジャーナル）に従い、tenant 別に分割保存される。

## 2. 現状ギャップ（2026-10-03 時点・`main` @ `dc3330dd`）

| #   | ギャップ                                                                                                                                                                                                                       | 根拠                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| G1  | 封筒は**呼び出し元が作る**。`scopeResult` は入力中の `security_scope` を構文検証するだけで、信頼アンカーは service-actuator の「`MISSION_ID` env と一致するか」のみ                                                            | `libs/core/pipeline/op-preflight-defaults.ts` `scopeResult` / `service-actuator-helpers.ts` `resolveTrustedScope`         |
| G2  | スコープ型が4種並立: `ScopeContext`（`EventScope` の基底）/ `ContextSecurityScope` / `WorkspaceOwner` / `HeldActionContext`。approval レコードは既に `scope?: EventScope` を持つ                                               | `scope-context-validation.ts` / `context-security-scope.ts` / `workspace-ledger.ts` / `cloudflare-os-control-plane.ts`    |
| G3  | service-actuator の observation/egress が互換 alias `scope.tenant_id` を読む。`tenant_slug` のみの封筒では tenant が `undefined` になる                                                                                        | `service-actuator-helpers.ts` `prepareServiceObservation` / `prepareServiceEgressContext`                                 |
| G4  | held-action キューと approval-store が別系統。submit の本番 caller は `automation-blueprint.ts` の introduction 要求のみ。steering だけが approval-store 経由                                                                  | `submitHeldAction` / `ApprovalSteeringAction` / `scheduleSteeringApprovalExecution`                                       |
| G5  | **held action は再起動後に実行不能**。`persistState` は `apply`/`params` を保存せず、`restoreState` は executor を「必ず throw する関数」に差し替える。承認が別プロセス（surface）で起きる設計と噛み合わない                   | `cloudflare-os-control-plane.ts` `persistState` / `restoreState`                                                          |
| G6  | **多プロセス lost-update**。5箇所の `new CloudflareOsControlPlane()` が構築時に1度だけ `control-plane.json` を読み、変更ごとに全量スナップショットを書く（ロック・書込前再読込なし）。他プロセスの決裁・observation が消えうる | service-actuator / `cloudflare-os-surface.ts` 既定引数 / chronos share-grants route / computer-surface / operator-surface |
| G7  | 制御プレーンは tenant 名前空間を持たない単一ファイル。observation は無制限に配列追記                                                                                                                                           | `pathResolver.shared('runtime/cloudflare-os/control-plane.json')`                                                         |
| G8  | introduction / observation / taint を呼ぶのは service-actuator だけ。file/code/browser/system op は未通過                                                                                                                      | `service-actuator-helpers.ts` `enforceResourceIntroduction` 他                                                            |
| G9  | op の副作用種別（read/write/egress）を宣言する場所がない。actuator manifest は `op`/`schema_ref`/`platforms` のみ                                                                                                              | `libs/actuators/*/manifest.json`                                                                                          |
| G10 | taint は mission 単位で単調増加のみ。confidential を読んで public 向け要約を書く正当な mission を下げる手段がない                                                                                                              | `projectTaint` / `assertEgressAllowed`                                                                                    |
| G11 | `ContextSecurityScope.mission_id` が必須のため、mission を持たない `task_session` / `pipeline` 実行形（work-scope-policy で許可済み）に封筒が発行できない                                                                      | `context-security-scope.ts` / `work-scope-policy.json`                                                                    |
| G12 | surface 投影（access 解決 + フィルタ）が presence-studio / chronos-mirror-v2 / computer-surface / operator-surface で個別実装                                                                                                  | 各 surface の `os-control-plane.ts` / `data.ts`                                                                           |

## 3. 改善項目一覧

| ID    | タイトル                                                                | 優先度 | 規模 | 解消ギャップ    |
| ----- | ----------------------------------------------------------------------- | ------ | ---- | --------------- |
| SC-01 | 2層スコープ封筒の runtime 発行（mint）と型の一本化                      | **P0** | M    | G1, G2, G3, G11 |
| SC-02 | op 副作用宣言（`effect`）の manifest 導入                               | **P0** | S    | G9              |
| SC-03 | 制御プレーン永続化: 単一書き手規律 + tenant 名前空間 + observation 集約 | **P0** | M    | G6, G7          |
| SC-04 | held action の approval-store 統合 + 型付き executor レジストリ         | **P0** | L    | G4, G5          |
| SC-05 | introduction / taint / observation の op-preflight 標準段化             | P1     | M    | G8              |
| SC-06 | egress choke point の水平適用 + 承認付き declassify                     | P1     | M    | G10             |
| SC-07 | workspace owner の封筒整合                                              | P1     | S    | G2              |
| SC-08 | 制御プレーン単一ファサード + surface 投影の共有アダプタ                 | P2     | S    | G6, G12         |
| SC-09 | 統合アーキテクチャ文書 + 不変条件テスト                                 | P2     | S    | —               |

依存: SC-01 → SC-02 → SC-03 → SC-04 → SC-05 → SC-06。SC-07 は SC-01 後いつでも可。SC-08 は SC-03 後。SC-09 は最後。

---

### SC-01: 2層スコープ封筒の runtime 発行と型の一本化（P0 / M）

**現状**: G1・G2・G3・G11。`ContextSecurityScope` は正準連鎖の項目（tenant_slug/organization_id/project_id/task_id/session_id）と方針項目（read_tiers/write_tier/purpose/external_egress/allowed_reasoning_backends）を既に持つが、両者が1つのフラット構造に混在し、生成者が呼び出し元である。

**実装**:

1. **型の一本化**: `ScopeEnvelope = { identity: ScopeContext; policy: ScopePolicy; minted_at; mint_ref }` を `libs/core/context-security-scope.ts` に定義。`identity` は既存 `ScopeContext`（`scope-context-validation.ts`）をそのまま使い、新しい識別型を作らない。`ContextSecurityScope` は `ScopeEnvelope` からの互換射影として残し（読み取りのみ）、producer は新型へ移行する。
2. **mint を runtime に限定**: `mintScopeEnvelope(source)` を dispatch 境界（mission_controller の task 発行 / worker spawn / pipeline runner / `delegateTask`）だけが呼べる関数として置く。identity は入力からではなく、登録 env（`MISSION_ID` 等）・work-item claim・session から owner-scope resolver（`resolveOwnerScope`）で導出する。`mint_ref` は runtime 内の発行台帳へのハンドルで、自己申告の `stamped_by` は廃止。
3. **入力中の封筒は narrow 要求として扱う**: 既存 `scopeResult` は「入力の `security_scope` が mint 済み封筒の部分集合か」を検証する段に変える。identity の不一致・policy の拡大（read_tiers 追加、write_tier 格下げ禁止の緩和、external_egress を allow へ）は `[OP_SCOPE_DENIED]`。
4. **委譲時の減衰**: `delegateTask` / co-session worker へ渡す封筒は親の policy 以下に narrow したものだけ。子が親より広い封筒を持つ経路を型レベルで作れないようにする（`narrowScopeEnvelope(parent, request)` のみが子封筒を返す）。
5. **mission なし作業**: `identity.mission_id` を optional にし、mission なし封筒は `session_id` 必須・tenant は session の束縛（`KYBERION_TENANT`）から導出。tenant 未束縛 session の封筒は `system/` floor かつ `read_tiers=['public']` に固定。
6. **G3 の即時修正**: service-actuator の observation / egress が `tenant_slug` を正、`tenant_id` を alias として `context-security-scope.ts` の `resolveTenantAlias`（現在は非 export・export して共用）経由で読むように直す（SC-01 の最初のコミットとして単独で入れられる）。

**受入条件**:

- mission_controller task 発行 / worker dispatch / pipeline runner / delegateTask の4経路で、mint 済み封筒が op に届く回帰テスト。
- 入力に偽造封筒（別 mission_id・別 tenant・read_tiers 拡大）を与えた op が `[OP_SCOPE_DENIED]` で止まる。
- 子封筒が親より広くならないことの property テスト。
- `tenant_slug` のみの封筒で observation に tenant が記録される（G3 回帰）。
- 封筒なしの governed op は当面 `warn`（`what — why | next | evidence` 形式）で検出され、件数が計測できる。

### SC-02: op 副作用宣言（`effect`）の manifest 導入（P0 / S）

**現状**: G9。preflight の段選択（read なら observation、write なら introduction enforce、egress なら taint 判定）に必要な情報がどこにも宣言されていない。

**実装**:

1. actuator manifest の `capabilities[]` に `effect: "read" | "write" | "egress" | "none"` と、必要な op には `resource_ref_from`（入力中のどのフィールドが resource ref か: 例 `params.path` / `target.url` / `service_id+resource_ref`）を追加。schema は `knowledge/product/schemas/` に登録。
2. **宣言なしは `write` として扱う**（fail-safe）。`egress` は外部送信（presence dispatch / service write / publish / mail send / provider 送信）。
3. 既存 33 actuator を一括宣言する移行 PR を用意し、`check_*` 系で「全 capability に effect がある」を検査（最初は warn、全宣言後に enforce）。
4. `simulatable` / `irreversible` も op 宣言に移し、SC-04 の held 判定に使う。

**受入条件**: 全 manifest が schema 検証を通る / effect 未宣言 op の preflight 挙動が write と同一であるテスト / boundary-test allowlist の更新が registration ceremony に沿う。

### SC-03: 制御プレーン永続化 — 単一書き手規律 + tenant 名前空間 + observation 集約（P0 / M）

**現状**: G6・G7。複数プロセスが同じ JSON を全量上書きする。observation は無制限追記。

**実装**:

1. **状態とイベントを分ける**: 決裁・introduction・observation・held action の状態遷移を**追記専用ジャーナル**（JSONL、1イベント1行、`withLock` で append）に記録し、インメモリ状態はジャーナルの再生で構築する。スナップショットはジャーナル位置付きのキャッシュとして扱い、正本にしない。書込前に必ずジャーナル末尾まで追随する。
2. **tenant 名前空間**: 保存先を storage-layout の floor 規則に揃え、`active/shared/runtime/<tier>/<tenant|shared>/cloudflare-os/` 配下に分割（`libs/core/storage-layout.ts` に登録）。tenant は SC-01 の identity スナップショットから**書き込み時に**確定する。tenant データを `system/` に置かない。
3. **observation の集約**: `(mission_id, resource_ref, tier)` 単位で初回時刻・最終時刻・回数に集約し、生イベントは logging-policy の compaction 規則（audit/traces と同系）でローテーション。taint 計算は集約値だけで行えるようにする。
4. **移行**: 既存フラット `control-plane.json` を起動時 one-shot で tenant 別ジャーナルへ変換。変換不能（tenant 解決不可）なレコードは `quarantine` に退避し監査記録（黙って捨てない）。

**受入条件**:

- 2プロセスが同時に決裁 / observation を書いても両方が残る並行テスト（現行実装で fail することを先に再現）。
- tenant A のプロセスから tenant B の held action / observation を列挙・決裁できない。
- 移行前後で pending action と introduction の件数が一致（quarantine 分は監査に出る）。
- 1万件の read observation でジャーナル・集約のサイズが上限内に収まるベンチ。

### SC-04: held action の approval-store 統合 + 型付き executor レジストリ（P0 / L）

**現状**: G4・G5。held action の executor は submit 時の closure で、再起動・別プロセスでは実行できない。一方 steering は approval-store に「種別付きの直列化可能な効果記述」（`ApprovalSteeringAction`）を載せ、決裁 choke point（`decideApprovalRequest`）が種別から実行関数を引く — こちらが正しい形。

**実装**:

1. **executor レジストリ**: `registerHeldEffect(kind, { paramsSchema, apply, simulate?, revert?, irreversible })` を `libs/core/governance/` に置き、効果は `kind` 名 + 直列化可能な `params` で記述する。closure を submit しない。レジストリは各プロセスの boot で同一内容が登録される（actuator 側の registration ceremony と同じ扱い）。
2. **秘匿値の扱い**: `params` に資格情報・個人データを直接入れない。secret は secret-store 参照、payload 本体は tier 付き artifact 参照（`writeScopedArtifact`）として保存し、`payloadHash` で束縛する。直列化できない効果は held 不可と op 宣言（SC-02）で判定し、従来の `approval_required` 中断に回す。
3. **approval-store へ統合**: `ApprovalSteeringAction` を一般化した `ApprovalHeldEffect { kind, params, effectBinding, payloadHash, dependsOn }` を `ApprovalRequestRecord` に追加。scope は既存の `scope?: EventScope`（= SC-01 identity スナップショット）を使い、`HeldActionContext.tenantSlug` は廃止。`submitHeldAction` は approval request 作成の薄い互換 shim にする。
4. **単一 choke point**: `decideApprovalRequest(approved)` → レジストリから `kind` を引いて `applyHeldEffect` を1度だけ実行（冪等キー = request id + payloadHash）。`resolvedBy`/`appliedAt` 必須、`decidedAuthMethod` の弱い認証では `irreversible` 効果を適用しない。
5. **held 継続分岐**: `enforceApprovalGate` の `approval_required` に「中断せず held に積んで続行」分岐を追加。可否は op 宣言の `simulatable`（SC-02）で決める。
6. **移行順**: steering を新レジストリの最初の kind として載せ替え → automation-blueprint の introduction 要求 → 旧 `CloudflareOsControlPlane.held` を削除。

**受入条件**:

- submit したプロセスとは別のプロセス・再起動後でも、承認された held effect が1度だけ実行される。
- 却下 / 期限切れ / payloadHash 不一致で実行されない。
- `resolvedBy` なしの適用が型・実行の両面で不可能。
- audit-chain に submit → decide → apply の3記録。
- steering の既存テストが無変更で通る。

### SC-05: introduction / taint / observation の op-preflight 標準段化（P1 / M）

**現状**: G8。`runOpPreflight` は serial admission waterfall + monotonic guard の器を持つが、3段は service-actuator 内の手続き呼び出し。

**実装**: waterfall に標準 listener を追加し、service-actuator の個別実装は削除（薄い呼び出しにも残さない）。段の選択は SC-02 の `effect` 宣言による。

1. **scope 段**（order 100・既存を SC-01 仕様へ置換）: mint 済み封筒の存在と narrow 検証。
2. **introduction 段**（order 105）: `effect ∈ {write, egress}` の op で `enforceIntroduction(identity, resource_ref, scope)`。resource ref は manifest の `resource_ref_from` で正規化。
3. **taint 段**（order 115）: `effect = egress` の op で taint を計算し egress context に添付（SC-06 で消費）。
4. **observation 段**（post-op）: `effect = read` の op の結果を集約 observation（SC-03）へ。tenant/tier は封筒 identity から取り、op 入力は使わない。
5. **ロールアウト**: 段ごと・op 族（service → file → browser → system → code）ごとに `warn` → `enforce`。warn 件数を op 族別に計測し、「7日間 warn 0 件 or 全件が既知の allowlist」を enforce 昇格条件とする。モードは governance policy JSON で op 族単位に持つ（env の一時スイッチにしない）。
6. **性能予算**: preflight 全段で op あたり p95 5ms 以内（暫定目標。SC-05 着手時に現行 preflight を計測して確定）。owner-scope 解決は既存キャッシュ（`clearOwnerScopeCache` 系）を使い、封筒 1 つにつき 1 回に限る。

**受入条件**: file/code/browser/system の read が observation に集約記録される / introduction 未付与の write が enforce 族で `[POLICY_VIOLATION]` / service-actuator 経由の既存テストが全て通る / 段順序固定テスト / 性能予算のベンチ。

### SC-06: egress choke point の水平適用 + 承認付き declassify（P1 / M）

**現状**: G10。`assertEgressAllowed` の規則（tier 単調性 + tenant 包含）は実装済みだが、caller は少なく、taint を下げる手段がない。

**実装**:

1. SC-05 の taint 段の結果を、`effect = egress` の op の monotonic guard で `assertEgressAllowed` に接続。`external` は常に拒否、tenant 不一致は拒否、tier を下げる流出は拒否。
2. `egress-policy.ts` の audience floor 判定と control plane の egress 判定を**1つの判定関数**に統合（規則の二重実装をなくす）。
3. **declassify**: 「confidential 観測後に public 向け成果物を出す」正当ケース用に、`declassify` を SC-04 の held effect kind として定義。対象は**特定の成果物（payloadHash 束縛）**に限定し、mission の taint 自体は下げない。承認は `human:` principal 必須、監査に入力 observation 一覧と出力 hash を残す。
4. taint の粒度は当面 mission 単位とし、task 単位化は declassify の運用実績を見て判断する（非目標に明記）。

**受入条件**: confidential 観測後の public 宛 egress が deny / declassify 承認済みの同一 payloadHash だけが通り、内容を変えると再び deny / tenant A 観測後の tenant B 宛 egress が deny / taint なし mission は従来通り通過。

### SC-07: workspace owner の封筒整合（P1 / S）

**現状**: `WorkspaceOwner {mission_id?, task_id?, session_id?}` は tenant を持たず、「owning mission が terminal」で orphan 判定する正しい設計（`withLockSync` による単一書き手も既にある）。ただし owner 照合はフィールドごとの個別比較で、型も独立している。

**実装**: `WorkspaceOwner` を `Pick<ScopeContext, 'mission_id' | 'task_id' | 'session_id'>` として型を共有。sweep・budget reclaim の orphan 判定と、list 時の可視性判定を owner-scope resolver に統一。session のみの owner は SC-01 の mission なし封筒規則（tenant 未束縛なら `system/` floor）に従う。

**受入条件**: tenant A の mission を持つ workspace が tenant B の viewer / CLI（`KYBERION_TENANT`）から不可視（`workspace list` にも出ない）/ mission terminal → 掃除の既存挙動に退行なし。

### SC-08: 制御プレーン単一ファサード + surface 投影の共有アダプタ（P2 / S）

**現状**: G6（インスタンス分散）・G12。

**実装**:

1. `getControlPlaneForScope(identity)` ファサードを導入し、5箇所の `new CloudflareOsControlPlane()` を置き換える。`CloudflareOsSurface` の既定引数での `new` も削除。解決できない tenant は fail-closed（owner-scope resolver と同じ「not found として読む」規則）。
2. `resolveOsSurfaceAccess(req)` 共有ヘルパを置き、presence-studio / chronos-mirror-v2 / computer-surface / operator-surface はそれを呼ぶだけにする。`KYBERION_VIEWER_SCOPE` スタンプ済み viewer → `{principalId, tenantSlugs, tierAccess}` の解決を一元化（client 指定の tenant/tier は narrow のみ）。

**受入条件**: 4 surface で同一 viewer に同一の可視集合が返る契約テスト / decision 面は `human:` principal 必須のまま / `new CloudflareOsControlPlane(` がファサード以外に現れないことを `check_*` で検査。

### SC-09: 統合アーキテクチャ文書 + 不変条件テスト（P2 / S）

**実装**: `knowledge/product/architecture/scope-governance-plane.md` を新設し、§1 の2層封筒・図・不変条件・各機構の責務を canonical として記述（frontmatter に role/phase affinity）。`entity-scope-hierarchy.md` / `workspace-isolation.md` / `multi-tenant-operations.md` から相互リンク。不変条件は `check_*` 系に追加:

- (a) `mintScopeEnvelope` の呼び出し元が dispatch 境界モジュールに限られる（import 境界検査）
- (b) 統治レコード schema に identity 以外の場所で tenant/org/project を持つフィールドが増えない
- (c) preflight 段順序の固定
- (d) approval 経路1本（`CloudflareOsControlPlane.held` の再出現禁止）・制御プレーン生成はファサードのみ
- (e) 全 manifest capability に `effect` 宣言

**受入条件**: 文書が mission dispatch の context pack に載る / 不変条件テストが CI で fail-closed。

## 4. 段階

- **Phase 1（P0・土台）**: SC-01 → SC-02 → SC-03 → SC-04。「runtime 発行の封筒 → op 副作用宣言 → 壊れない永続化 → 承認1本化」。SC-01-6（G3 修正）は先行して単独 PR 可。
- **Phase 2（P1・水平展開）**: SC-05 → SC-06、並行して SC-07。各段は warn で入れ、§SC-05-5 の昇格条件で enforce へ。
- **Phase 3（P2・表面と固定化）**: SC-08 → SC-09。

## 5. 非目標

- taint の task 単位化・情報フロー解析（SC-06 の declassify 運用実績を見て別計画）。
- 封筒の暗号署名（同一ホスト内は runtime 発行台帳で足りる。distinct runtime 間は Peer Messaging 側の認証に委ねる）。
- 新しい承認 UI。既存 surface の decision 面を再利用する。

## 6. 実行者ノート

- `CloudflareOsControlPlane` の public API は SC-04 完了まで互換 shim を維持し、内部だけ差し替える。
- tenant 直持ちフィールド（`HeldActionContext.tenantSlug` 等）は削除ではなく「identity スナップショットへの移送 + 読み取り時の一致検証」で廃止する。persisted state の後方互換読み取りは必須。
- SC-03 の並行テストは「現行実装で lost-update が再現する」ことを先に示してから修正する（one change, one verification）。
- 各 SC は独立 PR 可能な粒度だが、SC-01 無しの先行はしない（封筒が全項目の共通土台）。例外は SC-01-6 と SC-02。
- 本計画で新たに導入する概念は「2層封筒（identity/policy）」「op effect 宣言」「held effect レジストリ」の3つ。それ以外は OS-01/03/04/05・WS-05・DH-01 の配線の水平展開である。

## 7. 未決事項

1. mint 発行台帳の置き場所: プロセス内メモリ（worker 単位）で十分か、`active/shared/runtime/system/` に永続化して surface からも検証可能にするか。
2. `effect` 宣言の粒度: op 単位で足りるか、`service-actuator` のように同一 op で method により read/write が変わるものを `effect_from`（入力依存）で表すか。
3. declassify の承認者: mission owner で足りるか、tenant の Sovereign 承認を要求するか（tier 別に分けるか）。
