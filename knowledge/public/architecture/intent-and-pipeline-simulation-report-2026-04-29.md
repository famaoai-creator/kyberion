---
title: Intent and Pipeline Simulation Report
category: Architecture
tags: [intent, pipeline, simulation, evaluation, governance, mission, runtime]
importance: 10
author: Codex
audit_date: 2026-04-29
last_updated: 2026-04-29
---

# Intent / Pipeline シミュレーション報告

## 1. 目的

この文書は、Kyberion に既存の `intent` と `pipeline` が
**どのように動くか** を、実装・運用・知識文書を横断して
シミュレーションし、その評価と改善点をまとめたものである。

対象は次の 3 層である。

| 層 | 見るもの |
|---|---|
| Intent layer | ユーザー発話がどの意図に正規化されるか |
| Pipeline layer | その意図がどの ADF / workflow に落ちるか |
| Runtime layer | mission、team、actuator、evidence、audit がどう繋がるか |

## 2. 参照した主な資産

- [`kyberion-intent-catalog.md`](./kyberion-intent-catalog.md)
- [`kyberion-scenario-coverage-matrix.md`](./kyberion-scenario-coverage-matrix.md)
- [`intent-domain-evaluation-2026-04-29.md`](./intent-domain-evaluation-2026-04-29.md)
- [`mission-workflow-catalog.json`](../governance/mission-workflow-catalog.json)
- [`mission-classification-policy.json`](../governance/mission-classification-policy.json)
- [`standard-intents.json`](../governance/standard-intents.json)
- [`intent-coverage-matrix.json`](../governance/intent-coverage-matrix.json)
- [`pipelines/README.md`](../../../pipelines/README.md)
- [`simulation-findings.md`](./simulation-findings.md)
- [`agent-mission-control-model.md`](./agent-mission-control-model.md)
- [`mission-team-composition-model.md`](./mission-team-composition-model.md)

## 3. シミュレーション方法

完全な全件実行ではなく、次の 3 種類を組み合わせた。

1. **静的レビュー**
   - intent catalog と scenario coverage matrix を読み、ユーザー面の網羅性を確認した。
   - workflow catalog と mission classification policy を読み、実行形の一貫性を確認した。
   - pipeline README と主要 ADF 定義を読み、実装済みの runtime flow を確認した。

2. **実行ゲートの実地確認**
   - `pnpm pipeline --input pipelines/baseline-check.json`
   - `node dist/scripts/mission_controller.js create ...`
   - `node dist/scripts/mission_controller.js start ...`

3. **実装経路の読み合わせ**
   - `mission_controller`
   - `mission-team` composition
   - provider / model resolution
   - evidence / audit / distill の流れ

### 3.1 実地 probe の要約

| Probe | 結果 | 含意 |
|---|---|---|
| `pnpm pipeline --input pipelines/baseline-check.json` | 成功 | session start gate は稼働している |
| `node dist/scripts/mission_controller.js create ... --dry-run` | 成功 | CLI 引数解釈は正常 |
| `node dist/scripts/mission_controller.js start ...` | 成功 | mission activation 経路は成立 |
| `node dist/scripts/mission_controller.js create ...` と `start ...` の同時実行 | 一方が失敗 | 同一 mission ID の bootstrap は直列化が必要 |

## 4. 総合結論

Kyberion の intent / pipeline は、かなり高い完成度で
**「要求を governed execution に落とす」** 方向に揃っている。

特に強いのは次の 3 点である。

- 目的遂行系の intent が、mission class と workflow に落ちる
- decision support 系が divergence / critique / simulation に分かれている
- mission / audit / evidence / distill が一連のループとして成立している

一方で、改善余地ははっきりしている。

- intent の上位分類がまだ文書間で分散している
- knowledge lifecycle と mission process が「内部実装」として強い一方、user-facing intent としては薄い
- `dist/` の更新漏れのような runtime drift が、実行時にすぐ露出する
- mission 起動時の repo/bootstrap 耐性がもう少し必要

## 5. 領域別シミュレーション評価

### 5.1 目的遂行 intent

#### 代表フロー

- `code_change`
  - `implementation-plan` → `execute-task-plan` → `code-review-cycle`
- `customer_engagement`
  - `requirements-elicitation` → `design-from-requirements` → `test-plan-from-requirements` → `execute-task-plan`
- `operations_and_release`
  - `release-package` → `deploy-release`

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| 意図の正規化 | A- | 成果物への落とし込みは明確 |
| workflow への接続 | B+ | mission class 経由で安定するが、直結ではない intent もある |
| 実行の再現性 | B+ | gate は強いが、自然言語の揺れを吸う層はまだ薄い |

#### 改善点

- `standard-intents.json` に `target/action/object` ベースの正本を追加する
- `analysis` 依存の intent を、より具体的な mission class / workflow に寄せる
- 成果物種別ごとの canonical happy path を golden scenario 化する

### 5.2 Decision support / simulation intent

#### 代表フロー

- `hypothesis-tree`
  - divergence → cross-critique → report render
- `counterfactual-branch`
  - fork → simulate → rubric → convergence
- `negotiation-rehearsal`
  - synthetic counterparty → roleplay → debrief
- `stakeholder-consensus-orchestrator`
  - relationship graph → readiness matrix → recommendation

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| divergence quality | A | 複数視点の出し分けが強い |
| governed output | A- | シミュレーション結果が evidence として残る |
| input normalization | B | 入口の自然言語揺れを吸う規約はさらに必要 |
| rerun robustness | B+ | ensemble / rubric はあるが、比較と収束の UX は改善余地あり |

#### 改善点

- `hypothesis-tree` と `counterfactual-branch` の入力テンプレートを共通化する
- `simulation-summary.json` と `simulation-quality.json` の比較ビューを標準化する
- `warn/poor` の再実行ポリシーを intent 単位で見える化する

### 5.3 状態確認 / health / diagnostics

#### 代表フロー

- `baseline-check`
  - session start gate
- `vital-check`
  - critical metrics snapshot
- `full-health-report`
  - full-stack health
- `system-diagnostics`
  - deeper diagnostics
- `agent-provider-check`
  - reasoning provider connectivity

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| 網羅性 | A | 起動・状態・診断の基礎が揃っている |
| 失敗時の説明力 | B+ | status は返るが、intent からの resolution はまだ直感的ではない |
| operator UX | B | 人間向け summary と機械向け diagnostics を分ける余地がある |

#### 改善点

- `check-kyberion-baseline` / `diagnose-kyberion-system` を intent として前面に出す
- `needs_recovery` / `needs_onboarding` / `needs_attention` を自然言語の応答形に明示する
- health report を `State -> Cause -> Next action` の順で標準化する

### 5.4 環境整備 / platform onboarding

#### 代表フロー

- `platform-onboarding`
  - discovery transcript → requirements → design → test plan → task plan
- `agent-provider-check`
  - provider connectivity / backend availability
- `system-upgrade-check` → `system-upgrade-execute`
- voice / STT / CI-CD / secret resolver 系の環境統合

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| readiness model | A- | manifest と policy が揃っている |
| user-facing intent 化 | B | 実装はあるが、catalog の見通しをもう少し上げられる |
| failure isolation | B+ | 障害時に止まる設計は良い |

#### 改善点

- 環境整備 intent を user-facing catalog に一級化する
- readiness manifest と intent resolution の接続を明文化する
- provider / model 選択を環境変数だけでなく intent 要求にもつなげる

### 5.5 Knowledge lifecycle

#### 代表フロー

- `mission_controller distill`
- memory candidate / approve / promote
- post-release retrospective
- incident distillation

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| 学習ループ | A- | distill と promotion は既に有効 |
| 公開/非公開の統治 | A | tier boundary が強い |
| lifecycle の明示性 | B | search は強いが organize / retire / sanitize が intent として薄い |

#### 改善点

- `knowledge_lifecycle` を独立した intent 群として前面化する
- `organize`, `promote`, `retire`, `sanitize`, `reconcile` を user-facing に分ける
- knowledge 操作の結果を execution receipt に標準化する

### 5.6 Mission process / team composition

#### 代表フロー

- `mission_controller create`
- `mission_controller start`
- `checkpoint`
- `verify`
- `distill`
- `finish`
- team composition / prewarm / handoff / staffing

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| lifecycle completeness | A | mission の状態遷移は明確 |
| team binding | A- | role / capability / provider の結線がかなり安定した |
| UX | B | ミッション作成の引数群は強いが、自然言語からの導線はまだ補強余地あり |

#### 実地観察

今回のローカル確認では、`mission_controller` の実行が `dist/` の stale 生成物に依存していると、
旧い `preferred_agents` 参照で落ちるケースがあった。これは simulation というより runtime drift の例である。

#### 改善点

- `dist/` と source の同期を validate gate に入れる
- `mission_controller create/start` の前に build/state preflight を標準化する
- mission bootstrap の partial repo 残骸に対する自動修復を追加する

### 5.7 Cross-device / voice / browser / handoff

#### 代表フロー

- web session handoff
- mobile WebView handoff
- meeting proxy
- voice recording / STT / synthesis

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| 実用性 | A- | 具体的な runtime surface に落ちている |
| 契約の明確さ | A | schema と procedure が揃っている |
| 追加の改善 | B | 体験の一貫性はまだ伸ばせる |

#### 改善点

- handoff 系の最終成果物を intent catalog から辿れるようにする
- voice / browser / mobile の共通 summary schema を作る

### 5.8 外部検証 / governance

#### 代表フロー

- validation bundle export
- rubric disclosure
- audit chain / tenant scope / tier hygiene
- regulated validation support

#### 評価

| 観点 | 評価 | コメント |
|---|---:|---|
| governance strength | A | 説明責任はかなり強い |
| bundle completeness | A- | bundle の構成は十分だが、生成をもっと自動化したい |
| operator burden | B | 手作業の比率がまだある |

#### 改善点

- validation bundle を一発生成する command を実装する
- audit / prompt / model / policy の snapshot を自動添付する

## 6. パイプライン層の評価

### 6.1 `baseline-check`

#### 観察

- session start gate としては機能していた
- `all_clear` 系のゲートは、任意の作業前の前提確認として適切

#### 改善点

- ユーザーに返すときの文言を `State` として固定する
- `needs_attention` の場合に、次に何をすべきかを one-line で返す

### 6.2 `hypothesis-tree` / `counterfactual-branch`

#### 観察

- divergence と rubric の分離は良い
- ensemble と収束の概念は強い

#### 改善点

- 複数実行結果の比較ビューを標準出力に加える
- `quality != ok` の再実行ポリシーを intent 単位で出す

### 6.3 `platform-onboarding`

#### 観察

- discovery → requirements → design → test → task の流れは妥当
- adapter / secret / deployment の境界が明確

#### 改善点

- onboarding の完了条件を readiness manifest と強く結びつける
- 新規導入先向けの差分テンプレートを作る

### 6.4 `documentation-*` / `knowledge-*`

#### 観察

- 文書生成と知識抽出は、パイプラインとして十分に扱える
- ただし intent の一級分類がまだ弱い

#### 改善点

- documentation / knowledge lifecycle を intent catalog 側で分離する
- 出力形式を report / digest / distill / diff で標準化する

### 6.5 `release-*` / `deploy-*`

#### 観察

- release と deploy は stage-gated で扱われており、運用に向いている

#### 改善点

- release 前の readout を `State -> Risk -> Next gate` で統一する
- deploy の依存関係を intent coverage gate にも反映する

## 7. ローカル実地で見えた具体的な改善点

### 7.1 `dist/` と source の同期

今回のシミュレーションでは、`dist/libs/core/mission-team-composer.js` に古い実装が残っており、
`mission_controller create/start` が `preferred_agents` 参照で失敗した。

これは次の改善が必要だという強いシグナルである。

- `build` 後に stale output を検査する
- `mission_controller` の起動前に source/dist sync をチェックする
- 生成物が古い場合は自動で fail fast する

### 7.2 mission bootstrap の並行実行競合

同じ mission ID に対して `create` と `start` を同時に叩くと、
`git init` が hook テンプレートのコピー競合で失敗した。

改善点:

- mission `create` / `start` を同時実行しないよう、CLI 側で順序保証を入れる
- `create` を idempotent に近づける
- bootstrap 競合を検出したら、`resume` / `repair` / `retry` を提案する

## 8. 優先改善案

### P0

1. `dist` 同期チェックを validate / mission bootstrap に入れる
2. `mission_controller` の partial mission repo 修復を追加する
3. intent / pipeline の上位 ontology を追加する

### P1

1. knowledge lifecycle intent pack と conversation intent pack を user-facing 化する
2. state / diagnostics intent pack を分離する
3. mission process intent pack を分離する

### P2

1. simulation bundle の自動生成
2. ensemble comparison の標準ビュー
3. readiness manifest と intent 要求の結線

## 9. 結論

Kyberion の既存 intent / pipeline は、全体としてはかなり良くできている。
特に **目的遂行、decision support、mission lifecycle、audit / evidence** は強い。

ただし、今の課題は「能力不足」よりも「結線不足」である。

- intent の上位分類
- human / LLM conversation intents の一級化
- pipeline と mission class の対応
- runtime drift の検出
- knowledge lifecycle の一級化

この 4 点を補強すると、Kyberion は「動く」だけでなく、
**なぜその intent がその pipeline に落ちたのかを説明できる**
システムになる。
