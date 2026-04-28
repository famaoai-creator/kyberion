# OpenHarness調査に基づく改善ポイント（2026-04-29）

## 背景
- OpenHarness は `tool schema + permission + hook + task/swarm` の実行面が強い。
- Kyberion は `Intent/ADF + tier/policy + mission governance` が強い。
- したがって「全面移植」ではなく「実行基盤パターンの限定取り込み」が最適。

## 今回の改善スコープ
1. Tool運用の標準化契約を追加する  
2. Tool→Actuator ルーティングをガバナンスデータで管理可能にする  
3. 既存の Intent/ADF ルーティングと競合しないよう、補助レイヤーとして実装する

## 設計方針
- Tool は実行要求の公開I/F（LLM向け）
- Actuator は実処理の実行エンジン
- ルーティングは `knowledge/public/governance` の契約で制御
- 最終的な実行可否は既存の tier/policy/authority が決定

## 追加した契約
- `knowledge/public/schemas/tool-actuator-routing-policy.schema.json`
- `knowledge/public/governance/tool-actuator-routing-policy.json`

## 追加した実装
- `libs/core/tool-actuator-routing.ts`
  - policyロード
  - ルート解決（tool名 + intent_id）
  - キャッシュリセット（テスト/再読込用）

## 協調モデル（既存ルーティングとの関係）
- 既存の `Intent -> (pipeline|mission|task_session|direct)` を主系とする
- Tool-Actuatorルーティングは「実行補助/推奨レイヤー」として使う
- 競合時は既存の Intent/ADF 決定を優先し、Tool-Actuatorは理由説明・実行計画補強に回す

## 今後の拡張
1. `surface-runtime-orchestrator` の execution receipt に `tool_route` を埋め込む
2. `intent-contract-memory` に actuator選択結果を取り込み、候補重みへ反映する
3. authority-role の `allowed_actuators` と route候補の整合チェックを preflight に追加する
