# 統一認可ポリシー設計メモ

> ステータス: 設計検討メモ（未承認）。実装着手は別ミッション。
> 作成: 2026-11-02 / 関連: MSN-CREDENTIAL-REQ-20261102（command-credential-policy の先行例）

## 1. 背景と問題意識

Kyberion の「人間承認・認可」の **執行基盤は統一済み** だが、**方針（何にどの権威が要るか）は各実装が個別に後付け**しており、統一的に宣言・監査できない。

### 現状の定量評価

| 兆候                             | 実測                                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel:` リテラルの散在        | 163 ファイル。閉じた enum ではなく各プロデューサが任意に命名                                                                                                                                                                      |
| `requestApproval` 直接呼出       | 44 ファイル — organization / mission / knowledge / agent / dot / surface / service / plugin / workforce 全域                                                                                                                      |
| サブシステム固有の承認モジュール | `scoped-learning-approval*`、`tenant-activation-approval`、`mission-scope-approval`、`agent-prompt-approval`、`pipeline-approval-resume`、`service-recording-review-approval`、`first-job-approval*` 等 — 共有 store 上の並列実装 |
| 「何にどの権威」の宣言系統       | **4系統に分離**: intent キー（`approval-policy.json`）/ op キー（`PROTECTED_ARGUMENTS`、`ExternalOperationGrant`）/ capability キー（`grant-capability-policy.json`）/ verb キー（`command-credential-policy.ts`）                |

### 関所（boundary）の現状

`libs/core/governance/external-operation.ts` は外部効果の admission → commit → 証明検証の単一関所として機能しており、`vcs`/`email`/`meeting`/`voice`/`media`/`service-mcp` 等 ~10 アダプタが実際に通過する。**しかし2つの構造的欠陥がある**:

1. **「全ての外部効果がここを通る」という不変条件が未宣言**。`actuator-op-registry.json` に op の「外部効果」マーカーが存在せず、関所通過はアダプタ作者の任意 — 新しい外部効果 op が素通りしても構造的検知手段がない。
2. **内部承認面は別経路**。steward/inbox/operator/mission/pipeline/scenario/system/terminal の承認は `approval-store` に直行し、admission 形を経由しない。

## 2. 参照設計: AWS Bedrock AgentCore

| 要素             | AgentCore                                                                                                     | 示唆                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 関所             | Gateway が全 agent→tool トラフィックをインターセプト                                                          | 関所は1つ、全トラフィックを通す                                      |
| ポリシー言語     | Cedar（CNCF Sandbox, 2025-10）— deny-by-default、permit/forbid、Lean 形式検証                                 | 言語は交換可能。判定は permit/deny の2値                             |
| エージェント系列 | Dogwood（Apache 2.0）— `when temporal` 節でイベント履歴を参照。MCP ツールマニフェストから action スキーマ生成 | 「prior claim event が存在するか」のような系列条件をポリシーで書ける |
| ガードレール     | 確率的制御（コンテンツフィルタ）はポリシー内のシグナル                                                        | 決定制御と確率制御のレイヤー分離                                     |

**本質的な教訓**（Grid Dynamics の実証）: 共通にできるのは言語ではなく **「host が信頼ソースから組み立てる正規化認可リクエスト」+「判定→実行の写像」**。OPA と Cedar に同じ正規化リクエストを食わせれば同じ外部結果が出た。判定は `permit | forbid | require_approval(class)` の3値で抽象化すれば言語非依存になる。

## 3. 提案アーキテクチャ

既存資産を残したまま、**宣言レイヤーを1枚に集約**する。`command-credential-policy.ts`（MSN-CREDENTIAL-REQ）を雛形とする。

```
                        ┌────────────────────────────────────┐
                        │  Authorization Registry（宣言層）    │
                        │                                     │
                        │  op ──→ effect_class ──→ authority │
                        │         （閉集合）         requirement│
                        └──────────────┬─────────────────────┘
                                       │ route
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
   ┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────┐
   │ external-operation│   │  internal admission   │   │ credential/binding│
   │ （既存、据え置き）  │   │  （approval 系カテゴリ │   │ （既存 binding 系）│
   │                  │   │   を同一 admission 形に）│   │                  │
   └────────┬─────────┘   └──────────┬───────────┘   └────────┬─────────┘
            └────────────────────────┼────────────────────────┘
                                     ▼
                    ┌─────────────────────────────────┐
                    │ approval-store / decision engine │
                    │ （既存の共有基盤、そのまま）        │
                    └─────────────────────────────────┘
```

### 3.1 effect_class — 効果分類の閉集合

既存の `action_class` 語彙（`charter-decision-vocabulary.json`: `credential_change`/`internal_decision`/`payment`/`publish_public`/`send_message_external`/`sign_contract`）を骨格に、技術的効果面で拡張:

```ts
type EffectClass =
  | 'external_mutation' // 外部システムへの状態変更（vcs:push/merge/create, email:send, slack post…）→ external-operation 関所
  | 'external_read' // 外部への情報送信を伴う読取（browser:goto, egress を伴う fetch）
  | 'internal_decision' // 人間判断の記録（steward 承認, inbox 裁定, scope-approve…）→ admission で権威検証
  | 'knowledge_write' // governed ナレッジへの書込（memory-approve/promote, scoped learning）
  | 'credential_use' // credential/binding の消費・発行
  | 'system_control' // kill-switch, halt, daemon 制御
  | 'local_only'; // 外部効果なし（宣言により関所フリー）
```

### 3.2 Authorization Registry — op → (effect_class, authority_requirement) の宣言テーブル

`libs/core/foundation/` に新設（`command-credential-policy.ts` と同階層・同構造）:

```ts
interface OperationAuthorization {
  effectClass: EffectClass;
  /** require_approval(class) の判定に使う権威要求 */
  authority:
    | { kind: 'free' } // local_only のみ
    | { kind: 'admission'; boundary: 'external' | 'internal' } // admission 必須
    | { kind: 'approval'; assurance?: 'A1' | 'A2' | 'A3'; dualKey?: boolean }
    | { kind: 'binding'; scope: 'tenant' | 'task' };
}
```

- **未宣言 op は fail-safe**: `external_mutation` 扱いで関所必須（= deny-by-default と同値）
- 既存の `approval-policy.json` rules（intent → assurance/dual_key）はこのレジストリの「判定詳細層」として残し、キーを統一
- `PROTECTED_ARGUMENTS`（引数保護対象）と `ExternalOperationGrant`（delegation 可能ターゲット形状）は「関所内の検査詳細」として既存のまま — 統合するのは**入口の宣言**であって関所内部の機構ではない

### 3.3 admission 形の一般化

`external-operation.ts` の admission→commit→proof ライフサイクルを `internal_decision`/`knowledge_write` にも適用する:

- 現状: 内部承認は各所から `approval-store` に直行（channel リテラルで分類）
- 目標: 同一の `admit → commit → verify` 形を内部効果にも適用し、**channel は effect_class から導出**（プロデューサの自由命名を廃止）

これで「承認の入口」が1形になる。steward/inbox/operator 等の現 channel は `internal_decision` 内のサブ分類に降格させる。

### 3.4 未経由検知ゲート

`tests/platform-read-boundary.test.ts` と同じ発想:

- `external_mutation`/`external_read` を宣言された op、および「効果を実行する既知の op 実装」が `runExternalOperation` 系で包まれているかを**静的ゲートで検査**
- 縮小専用 allowlist で既存の素通り箇所を棚卸し、新規素通りをブロック
- `actuator-op-registry.json` に `effect_class` フィールドを追加し、op 登録時に必須化（レジストリと TS レジストリの乖離は catalog ゲートで検査）

### 3.5 ポリシー形式 — Cedar 互換への寄せ方

即時のエンジン導入はしない（Dogwood 参照実装は本番非推奨）。代わりに:

1. **正規化認可リクエストを仕様化**: `principal(credentialExecutionIdentity) + action(op+effect_class) + resource + context(envelope, lineage, assurance)` — モデル入力から絶縁して host が組み立てる（既に実質存在するものを契約として固定）
2. **判定を3値で固定**: `permit | forbid | require_approval { assurance, dualKey }`
3. レジストリのシリアライズ形を **Cedar 風の permit/forbid 条件に写像可能**な形に保つ — 将来 Cedar/Dogwood 評価器を入れても宣言を書き換えなくてよい
4. 系列条件（claim lineage, prior event）は Dogwood `when temporal` の概念に対応 — 現行は envelope/lineage 検証コードのまま、宣言レイヤーでは「requires_lineage: true」として表現

## 4. 段階的移行

| Phase | 内容                                                                                                   | 検証                                                   |
| ----- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| P0    | `AuthorizationRegistry` 骨格 + effect_class enum + 未宣言 fail-safe のみ導入（動作変更なし、計測のみ） | 既存テスト全パス、宣言カバレッジレポート               |
| P1    | 外部効果 op の棚卸し宣言 + 未経由検知ゲート導入                                                        | ゲート緑、既存外部効果が全て関所通過を確認             |
| P2    | 内部承認カテゴリの admission 形統一（steward/inbox/operator から順に）                                 | channel → effect_class 移行、承認 store の記録後方互換 |
| P3    | `approval-policy.json`/`PROTECTED_ARGUMENTS`/`grant-capability-policy` のキー統合                      | 4系統→1レジストリ+詳細層に収斂                         |
| P4    | Cedar 互換シリアライズ形式の固定（将来エンジン差し替え余地）                                           | サンプルポリシーの Cedar 変換が意味保存することを検証  |

各 phase は独立してマージ可能。P0/P1 が「袋小路対策として最も効く」部分（外部効果の検知と fail-safe）。

## 5. Accountability Charter との関係

charter は「**要件を満たす権威の供給側**」であり、本設計のレジストリ（要件の宣言側）と直交する。この2軸を分離するのが設計の要点。

### 役割の対比

| 層                             | 担当                                          | 既存実装                                                                                                    |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **要件（requirement）**        | この op/effect_class にどの権威が要るかを宣言 | 本設計の `AuthorizationRegistry`（新設）                                                                    |
| **権威の供給（satisfaction）** | 要件を誰が・どの形で満たすか                  | 人間承認（approval-store）/ **charter（責任者署名の事前許可封筒）** / credential binding / delegation grant |

### charter の現行機構（据え置きでよい部分）

- `approval-gate-charter.ts`: 責任者が署名した **封筒（envelope）** の内側は AUTO-ALLOW（= 個別承認不要の事前委任）、外側は人間承認必須 — 「legacy policy が通しても charter の外なら人間へ」という**締める方向だけ**の設計で、fail-safe と整合する
- `EXTERNAL_OPERATION_DELEGATION`: op ごとの「charter grant を参照してよい（delegable）」レジストリ + grant ターゲット形状 + `reputational_class` A/B
- `charter-decision-vocabulary.json`: 封筒が語る分類語彙（`action_class`: payment / send_message_external / sign_contract / credential_change / publish_public / internal_decision）

### 統合ポイント

1. **判定写像にそのまま乗る**: 「op は approval class X を要求」（レジストリ）→「X は charter の封筒内か？」（`approval-gate-charter` 評価）→ 内なら `permit`（charter provenance 付き）、外なら `require_approval`。hardened（dual_key 等）は charter を経由せず常に人間 — 3値判定 `permit | forbid | require_approval` と整合

2. **delegable をレジストリの属性に**: 現在 `EXTERNAL_OPERATION_DELEGATION` という別テーブルにある「この op は charter grant を参照してよい」「ターゲット形状はこれ」「reputational_class は A/B」を、`OperationAuthorization` のフィールドに移す:

   ```ts
   authority: {
     kind: 'approval',
     assurance: 'A3',
     delegable?: {
       targetFields: ['repository', 'branch'],
       optionalFields?: ['visibility'],
       reputationalClass: 'A' | 'B',
     }
   }
   ```

3. **effect_class と action_class の軸分離**: 本設計の `effect_class` は**技術的効果**の分類（external_mutation 等）、charter の `action_class` は**事業的意思決定**の分類（payment, sign_contract 等）。2軸は混ぜず、レジストリは `effectClass` に加えて optional な `actionClass` も持てる形にする — 外部送信が「単なる通知」か「payment を伴う契約送信」かは技術効果だけでは分からず、封筒の価格付けは action_class 側を見る

4. **封筒の価格付けは変えない**: amount / reversibility / who-acts-for-whom による `charter_delegable` 判定は `approval-gate-charter` 内部の機構として据え置き。統一するのは「要件と delegability の宣言入口」だけ

### 結果としての流れ

```
op → Registry[op] = (effect_class, authority=X, delegable?)
   → 関所（effect_class でルーティング）
   → 判定: binding? charter envelope 内? standing grant?
        → permit（provenance: charter|grant|binding）
        → いずれも無 → require_approval（human, assurance クラス付き）
        → hardened → 常に require_approval（charter 迂回不可）
```

charter は「人間の意思決定を封筒として事前委任する」供給側の1形態であり、レジストリが宣言する要件を満たす手段の一つ — **レジストリは charter の存在を知るが、charter はレジストリが宣言した要件を迂回できない**。

## 6. 宣言の拡張経路: 3層レジストリ

「レジストリがソース埋め込みだと拡張性がなくなる」への回答として、宣言テーブルは3層構造とする（MSN-UNIFIED-AUTHZ-20261102 で実装済み）。

```
Layer 0 コード正本   libs/core/foundation/authorization-registry.ts
                    — EffectClass 型・lookup・fail-safe・レビュー済み op の正本。
                      ゲート: 境界を通る op は source==='code' 必須（宣言と実装を同じ PR に縛る）
Layer 1 JSON overlay knowledge/product/governance/authorization-registry.json
                    （customer 上書き: policy/authorization-registry.json）
                    — governed-catalog 経路で schema 検証 + 署名キャッシュ。
                      fallbackOnInvalid: 壊れた overlay は全体を無視（部分適用しない）
Layer 2 plugin manifest  managed plugin の manifest `authorizations` ブロック
                    — activation 許可済み managed コピーのみ。digest が宣言を
                      インストール時承認に結びつける（EP-01/EP-02）
```

### マージ規則（緩和不能性）

- **コード常勝**: コード宣言にマッチする id は overlay/plugin の宣言を一切見ない — データは「カバレッジの追加」だけでき「レビュー済み宣言の緩和」はできない（より長い影 prefix での覆いも不可）
- **データ層は admission 未満を宣言できない**: schema が `local_only` と `authority.kind:'free'` を全データ層で禁止 — 境界回避は必ずコードレビュー済み宣言を要する（ゲートが拾えない非リテラル call site があっても、データで `free` 化する経路を塞ぐ）。`local_only` のデータ宣言が本当に必要になったら「局所性の証明方法」と共に別途設計する
- **衝突は除去+警告**: overlay/plugin がコード所有キーを宣言したらロード時に drop して warn（作者に不活性であることを通知）
- **exact > prefix、先勝ち**: 層を跨いで exact は全 prefix に勝ち（overlay 順に非依存）、prefix 同士は最長が勝ち、同長は先に供給された層が勝つ
- **provenance 記録**: 解決結果は `source: 'code' | 'overlay' | 'plugin:<id>'` を持ち、監査で宣言の出自を追える
- **残留リスク（文書化）**: 境界ゲートはリテラル `operationId` のみ抽出するため、変数経由の call site は検出不能 — ただし上記の `free`/`local_only` 禁止により、検出漏れの op は最悪でも「admission 必須」側にしか倒れない

### 適用基準

| 宣言したいもの                                          | 置き場所                           |
| ------------------------------------------------------- | ---------------------------------- |
| `runExternalOperation` 等で境界を通る op                | コード（ゲートが強制）             |
| コードに現れない設定由来 op（将来のサービス preset 等） | JSON overlay                       |
| プラグイン持ち込み op                                   | manifest `authorizations` ブロック |

## 7. リスクと未解決事項

- **網羅性**: 「効果を持つ op」の棚卸しは調査ベースで漏れ得る → allowlist 縮小ゲートで漸進管理（platform-facts と同戦術）
- **破壊的変更面**: channel リテラルの再分類は承認 store 記録の互換性に影響 → 記録は旧 channel を保存したまま新分類を併記
- **エンジン成熟度**: Dogwood は本番非推奨 → Cedar 互換は「形式」への準拠に留め、評価は自前のまま
- **境界**: この統一は「認可・承認の方針面」であり、credential の割当/束縛ライフサイクル（credential-proof-boundary）の不変条件は変更しない
- **スコープ**: cross-system の credential/approval 境界変更のため、実装は専用ミッション（要件 + UX 契約 + 独立レビュー）必須

## 8. 結論

- `external-operation.ts` は**外部効果の関所として据え置きで正しい** — 作り直しではなく「宣言 → 関所ルーティング」の上に一枚乗せる
- 統一の核心は **effect_class 宣言レジストリ + 未経由検知ゲート** — REASONING_FREE_ACTIONS → command-credential-policy と同じ変換を認可全面に適用する
- ポリシー言語は**正規化リクエスト + 3値判定を契約として固定**し、Cedar/Dogwood 互換の形式に寄せる。言語採用自体は急がない
