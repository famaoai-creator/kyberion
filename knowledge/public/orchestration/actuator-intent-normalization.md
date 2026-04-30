# Actuator Intent Normalization

曖昧な依頼をそのまま actuator 実行へ落とさず、まず `guided-coordination-brief` に正規化するための考え方です。
この shared brief は booking や presentation だけでなく、全ての repeated coordination intent の最初の共通層として扱います。

The shared coordination flow is documented in [guided-coordination-protocol.md](knowledge/public/orchestration/guided-coordination-protocol.md).

## Core Rule

- 自然言語の依頼をそのまま actuator へ渡さない
- 最低でも次を明示する
  - 何を作るか
  - 何を根拠にするか
  - 何が不足しているか
  - どの actuator 群に落ちるか
  - 何を成果物とするか

## Two-Step Contract

1. `guided-coordination-brief`

- request の正規化
- coordination kind の判定
- service binding の参照を保持
- missing input と assumption の明示
- LLM が最初に作る semantic brief

2. `actuator-execution-brief`

- shared brief を元にした実行向けの正規化
- archetype 判定
- target actuator と deliverable の確定
- service binding 参照を実行層へ引き継ぐ

3. `actuator-resolution-plan`

- 実行 phase
- 使用 actuator
- 期待 artifact
- exit criteria

4. `operator-interaction-packet`

- LLM が人間に返すための対話契約
- clarification / execution-preview / status-summary を分離
- 内部 plan をそのまま見せず、必要な説明だけを返す

This packet is the human-facing surface of the shared coordination protocol.

## Recommended Flow

1. request text を archetype へ分類
2. brief を生成
3. brief を元に intent contract を生成する
4. missing input が重大なら clarification
5. plan へ落とす
6. `pipeline bundle` を生成する
7. その後に individual actuator template を埋めて実行する

## Pipeline Bundle Rule

- `resolution plan` だけで終わらせない
- 不足入力が残る場合は `status: clarification_required`
- 入力が揃ったら `status: ready` の `actuator-pipeline-bundle` を生成する
- bundle には少なくとも次を含める
  - `actuator`
  - `template_path`
  - `recommended_procedure`
  - `parameter_overrides`
  - `outputs`

## LLM Touchpoint Rule

- LLM の主な接点は `operator-interaction-packet`
- actuator 実行層と人間向け返答層を分ける
- LLM は少なくとも次を明示する
  - 理解した依頼
  - readiness
  - 足りない入力
  - 次の一手
- 可能なら LLM は `guided-coordination-brief` を先に作り、その brief を execution brief / intent contract / work loop の根拠にする
- 内部の `pipeline bundle` や `execution plan set` は必要に応じて要約し、対話では平文化する
