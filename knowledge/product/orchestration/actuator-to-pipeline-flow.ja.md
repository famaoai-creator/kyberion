---
title: Actuatorからパイプライン登録までの流れ（利用→提携→登録）
category: Orchestration
tags: [actuator, playground, collaboration, adf, pipeline-promote, procedure, trust]
importance: 8
author: Kyberion
last_updated: 2026-10-03
role_affinity: [ecosystem_architect, mission_controller, operator, researcher]
phase_affinity: [alignment, execution, review]
---

# Actuatorからパイプライン登録までの流れ

正本は [actuator-to-pipeline-flow.md](./actuator-to-pipeline-flow.md)（英語）。
本書は運用用の日本語 aid です。乖離があれば英語が優先されます。

アクチュエータの試し打ちから再利用可能な登録までの最短経路は
**利用 → 提携 → 登録** の一本です。2026-10-03 に実機検証済み。

## 1. 調べる（何が動くか）

カタログは2層で粒度が違います。

- `manifest.json`（`libs/actuators/*/manifest.json`）— 粗い入口。
  pipeline 駆動型（file / browser / media / network / code）は `pipeline` のみ。
- `knowledge/product/orchestration/actuator-op-discovery.json` — `describeOps()`
  生成の細粒度 step op（`pnpm generate:op-registry` で再生成）。人向けは
  `CAPABILITIES_GUIDE.md`。

```bash
pnpm capabilities            # manifest走査（build不要）。+N step ops のヒント付き
pnpm generate:op-registry    # op変更後の再生成
```

## 2. 試す（playground）

```bash
pnpm playground --actuator <id> --op <op> --params '{...}' --check    # 検証のみ
pnpm playground --actuator <id> --op <op> --params '{...}' --dry-run  # 検証のみ（素のcapture系opは実行）
pnpm playground --actuator <id> --op <op> --params '{...}'           # 本実行
```

注意点:

- `--op` は manifest の op と discovery の step op の両方を受け付けます。
- `pipeline` を受け付ける actuator の discovery 専用 op は一段パイプライン
  （`{action:"pipeline", steps:[{type, op, params}]}`）に包んで実行します。
  本番 ADF と同じ形です。素の単体 action は「pure pipeline-driven」で拒否されます。
  `pipeline` を持たない actuator（agent/secret 等）は単体 action のままです。
- 包んだパイプラインの `--check` / `--dry-run` は検証のみ。
  本実行にはフラグを付けません。
- `secret-actuator set` の値付き live 実行は禁止。
  `pnpm kyberion secret introduce` / Concierge を使います。
- 知覚の本番経路は sense 動詞です（`perception-playbook.md`、
  `action-playbook.md`）: `pnpm kyberion read|see|listen|watch`。

## 3. 提携する（cowork / peer）

2系統を混同しないでください。

- **Cowork** = MCP facade + 知識同期（実行ブリッジなし）。
  `pipelines/cowork-integration-review.json` はヘルス確認のみ。
- **Peer** = 同一 tenant の runtime 間メッセージング。最短手順は
  `same-tenant-peer-quickstart.ja.md`（登録 → 同一 `tenant-id` → inspect →
  `peer:conversation`）、詳細は `peer-network.md`。

accept の断絶（仕様）:

- `pnpm kyberion peer collaboration accept` は**ローカル承認の記録のみ**。
  mission 状態を変更せず、WorkItem/A2A 提案も自動実行しません。
- accept 後も運用者が行います: 後続の追跡・実行 → 再利用するなら昇格（次節）。
  具体形: `pnpm work create-item --title "<件名>" --tenant-slug <tenant> --assignee-peer-id <peer> --tier confidential`。
  accept 時に CLI が `next_steps` を表示します。

## 4. 登録する（scratch → governed pipeline）

方針: まず成功まで持っていく（`active/shared/tmp/<job>/` か mission evidence
で scratch）。再利用見込みが出たら昇格します
（`pipeline-crystallization-memo.md`、`architecture/loop-closure-machinery.md`）。

昇格は2系統で入力が違います。

| 入力                                                         | コマンド                                                                                                   | 出力                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 成功済み **ADF 実行**一回分                                  | `pnpm pipeline:promote --input <adf>.json [--name <slug>] [--trace <id>] [--dry-run] [--no-llm] [--force]` | `pipelines/<slug>.json` + `promotion` 由来記録 + README カタログ行 |
| Browser **recording**（`active/shared/runtime/recordings/`） | `promote-procedure` パイプライン                                                                           | `ProcedureCatalog` 登録（Pattern A→B）                             |

ADF ライフサイクル: `draft → preflight → auto-repair → commit → execute`
（`validateAndRepairAdf`。permission/auth/config/env は fail-closed）。

配置:

- `pipelines/*.json` — システム self-ops のみ（pre-trust 実行可能）。
- `knowledge/product/pipeline-templates/*.json` — 正準ユーザーパターン
  （パラメータ化、preflight ゲート必須）。
- `knowledge/confidential/{tenant}/pipelines/*.json` — tenant 実装化。

Trust: `pipelines/` と templates 以外は `[TRUST_REQUIRED]` で失敗します。
`pnpm kyberion project-trust request <path>` → 人間が
`pnpm kyberion approve <id> project-trust` → `--project-trust-approval <id>`
付きで実行。編集で承認は無効化されます。
スケジュールは `schedule{id,cron,timezone,enabled}` ブロックと
`pnpm kyberion schedule register` が別途必要です。

## 5. 詰まり地図（今回直した箇所）

- playground が正当な step op を拒否（`Machine mode requires --op`）—
  discovery マージ＋ pipeline 受付型の自動包みで解消。
- `pnpm capabilities` が粗い op しか表示しない — `+N step ops` ヒントを追加。
- `pnpm pipeline:promote` が全件失敗 — 刻印する `promotion` キーを
  `pipeline-adf.schema.json` が拒否していた。スキーマと `PipelineAdf`
  契約に `promotion` を許可して解消。
- `pipeline:promote` と `promote-procedure` の混同 — 両方の usage に
  scope を明記。
- accept 後の停滞 — accept 時に `next_steps` を表示し、cowork レビューの
  完了ログにも次行動を記載。
