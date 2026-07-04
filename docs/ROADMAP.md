# Kyberion ロードマップ統合索引

> **この文書の役割**: 散在する Kyberion のロードマップ/計画文書を一望できる **単一の正本（索引）**。
> 各項目の詳細・最新ステータスは **リンク先の原文が権威** であり、本索引は要旨と所在をまとめる。
> 原文は移動・削除していない（索引化のみ）。
>
> 作成日: 2026-06-22 / メンテナンス方針は末尾「保守」を参照。

---

## 0. 北極星（マスターロードマップ）

製品全体の最上位ロードマップは [`docs/PRODUCTIZATION_ROADMAP.md`](./PRODUCTIZATION_ROADMAP.md)（_OSS Hardening & FDE-Readiness_）。
戦略は **OSS ファースト＋有償の導入支援/FDE**、SaaS はユーザー基盤確立後。フェーズ:

- **Phase A** — first-win を5分に（進行中）
- **Phase B** — 30日連続運用に耐える（基盤着地）
- **Phase C'** — 1週間未満で貢献可能に
- **Phase D'** — fork なしで FDE/導入支援を可能に

他のすべてのロードマップは、この4フェーズのいずれかに寄与する下位計画として位置づけられる。

---

## 1. 一覧（テーマ別ステータス）

ステータスは原文記載の自己申告値。空欄は「原文参照」。

| テーマ               | 文書                                                                                                                                             | 範囲                                                                                                                                                                                                                                                                                                                                                                                  | ステータス                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 製品全体             | [PRODUCTIZATION_ROADMAP](./PRODUCTIZATION_ROADMAP.md)                                                                                            | OSS強化・FDE対応の12ヶ月目標                                                                                                                                                                                                                                                                                                                                                          | Phase A 進行中 / D3 統一Trace 約25%                                                            |
| 完了台帳             | [ROADMAP_COMPLETION_LEDGER](./ROADMAP_COMPLETION_LEDGER.md)                                                                                      | 実装完了項目の横断整理                                                                                                                                                                                                                                                                                                                                                                | 新規                                                                                           |
| エコシステム進化     | [kyberion-ecosystem-evolution-roadmap](../knowledge/product/architecture/kyberion-ecosystem-evolution-roadmap-2026-06.md)                        | 承認UI→学習→Mesh信頼→助言型ルーティングの依存順                                                                                                                                                                                                                                                                                                                                       | 提案済 / E0開始前                                                                              |
| エンジン             | [ROADMAP_ENGINE_REFINEMENT](./ROADMAP_ENGINE_REFINEMENT.md)                                                                                      | パイプライン合成性・反応的知識・設計プロトコル汎化                                                                                                                                                                                                                                                                                                                                    | Phase 1–3 定義済                                                                               |
| タスク網羅           | [TASK_SCENARIO_ROADMAP](./TASK_SCENARIO_ROADMAP.md)                                                                                              | シナリオ×ワークフロー×CLIプロファイルの拡充                                                                                                                                                                                                                                                                                                                                           | 一部実装済                                                                                     |
| オンボUX             | [POST_ONBOARDING_UX_ROADMAP](./developer/architecture/POST_ONBOARDING_UX_ROADMAP.md)                                                             | 初回後の再開フロー・状態言語の洗練                                                                                                                                                                                                                                                                                                                                                    | —                                                                                              |
| 日本語意図           | [JAPANESE_CONTEXTUAL_INTENT_ALIGNMENT_ROADMAP](./developer/JAPANESE_CONTEXTUAL_INTENT_ALIGNMENT_ROADMAP.ja.md)                                   | 省略発話→意図/ゴール/実行ステップの安全な解決                                                                                                                                                                                                                                                                                                                                         | 現状分析+計画                                                                                  |
| UX監査               | [distill_product-ux-roadmap-audit](../knowledge/product/evolution/distill_product-ux-roadmap-audit-20260529_2026_05_28.md)                       | baseline/vitals/surface 横断のUX監査とロードマップ整合                                                                                                                                                                                                                                                                                                                                | 監査済(2026-05-29)                                                                             |
| 本番化               | [PRODUCTION_READINESS_PLAN](./developer/PRODUCTION_READINESS_PLAN.ja.md)                                                                         | 本番運用に必要な改善項目(P1-x)と受入条件                                                                                                                                                                                                                                                                                                                                              | 項目定義済                                                                                     |
| 全体改善計画         | [improvement-plans-2026-07](./developer/improvement-plans-2026-07/README.ja.md)                                                                  | 全体調査に基づく改善実装計画88件(+AR-01〜06 Actuatorリファクタ)。再レビュー: [REVIEW_FABLE5_2026-07-03](./developer/improvement-plans-2026-07/REVIEW_FABLE5_2026-07-03.ja.md)。旧82件(IP-01〜14 + UX-01〜06 + AC-01〜06 + KM-01〜04 + MO-01〜07 + DS-01〜05 + AA-01〜05 + SA-01〜05 + OP-01〜05 + IL-01〜05 + ONB-01〜03 + SU-01〜04 + HO-01〜02 + HN-01〜03 + AO-01〜04 + CO-01〜05) | 計画定義済(2026-07-02〜03)                                                                     |
| ハーネス思想         | [ORCHESTRATION_HARNESS_MODEL](./developer/ORCHESTRATION_HARNESS_MODEL.ja.md)                                                                     | Fable 5 のオーケストレーション原則体系(分解/ブリフ/順序/評価/改善ループ/通信/エージェントループ)と Kyberion 取り込みマッピング                                                                                                                                                                                                                                                        | 参照文書(2026-07-03)                                                                           |
| エージェント個体思想 | [FABLE5_AGENT_MODEL](./developer/FABLE5_AGENT_MODEL.ja.md)                                                                                       | Fable 5 個体の振る舞い原則(正直さ/読み手志向/自律性/検証/コンテキスト経済/安全)と Kyberion エージェントへの規範                                                                                                                                                                                                                                                                       | 参照文書(2026-07-03)                                                                           |
| 自律運用判断基準     | [AUTONOMOUS_MAINTENANCE_JUDGMENT](./developer/AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md)                                                             | 運用・保守/脆弱性パッチの判断ルーブリック(自動/承認の4軸・パッチ緊急度×リスク・運用ループ・エスカレーション)。opus/sonnet/haiku で同じ判断に至るための決定論基準                                                                                                                                                                                                                      | 参照文書(2026-07-03)                                                                           |
| 会社経営コンセプト   | [COMPANY_OS_CONCEPT](./developer/COMPANY_OS_CONCEPT.ja.md)                                                                                       | 「私+Kyberion で AIスタートアップを回す」構想の診断と、組織構成・業務プロセスを Kyberion プリミティブで表現する方法。Company OS 完成の gap は CO-01〜05                                                                                                                                                                                                                               | 参照文書(2026-07-03)                                                                           |
| 抽象化/安全          | [kyberion-abstraction-security-improvement-plan](../knowledge/product/architecture/kyberion-abstraction-security-improvement-plan-2026-04-06.md) | 抽象化境界とセキュリティ改善                                                                                                                                                                                                                                                                                                                                                          | Phase 1–2 実装済                                                                               |
| 競合吸収             | [harness-adoption-plan-2026-05](../knowledge/product/architecture/harness-adoption-plan-2026-05.md)                                              | 初回成功・マルチモーダル・再利用スキル・協働・ガバナンスの吸収                                                                                                                                                                                                                                                                                                                        | Phase 1–2 定義                                                                                 |
| ミッション分類       | [mission-task-classification-roadmap-5.4-mini](../knowledge/product/architecture/mission-task-classification-roadmap-5.4-mini.md)                | 契約/型整合→エスカレーション決定論化→オントロジー網羅                                                                                                                                                                                                                                                                                                                                 | Phase A/B/C                                                                                    |
| ミッション制御       | [mission-orchestration-control-plane](../knowledge/product/architecture/mission-orchestration-control-plane.md)                                  | ミッション・オーケストレーションの制御面                                                                                                                                                                                                                                                                                                                                              | —                                                                                              |
| 経営制御面           | [management-control-plane](../knowledge/product/architecture/management-control-plane.md)                                                        | promotion/delivery 等を統合したオペレータモデル                                                                                                                                                                                                                                                                                                                                       | —                                                                                              |
| Studio吸収           | [studio-agent-orchestration-absorption-plan](../knowledge/product/architecture/studio-agent-orchestration-absorption-plan.md)                    | ゴール駆動マルチエージェント協調＋明示ガバナンス                                                                                                                                                                                                                                                                                                                                      | 実装状況(2026-04-19)記載                                                                       |
| 協働基盤             | [work-coordination-platform-plan](../knowledge/product/orchestration/work-coordination-platform-plan.md)                                         | Kyberion間 peer の claim/handoff/status の協働コマンド                                                                                                                                                                                                                                                                                                                                | Non-Goals定義済                                                                                |
| ADF簡素化            | [adf-pipeline-simplification-mission-plan](../knowledge/product/orchestration/adf-pipeline-simplification-mission-plan.md)                       | パイプライン内の機械的処理を分離                                                                                                                                                                                                                                                                                                                                                      | Mission Goal定義                                                                               |
| ADF検証              | [adf-pipeline-validation-plan](../knowledge/product/orchestration/adf-pipeline-validation-plan.md)                                               | パイプライン群を3分類で再評価し骨格共通化                                                                                                                                                                                                                                                                                                                                             | 検証目的定義                                                                                   |
| 多言語化             | [polyglot-roadmap](../knowledge/product/orchestration/polyglot-roadmap.md)                                                                       | Node monolith→Sidecar→真の polyglot                                                                                                                                                                                                                                                                                                                                                   | Phase 1 現状                                                                                   |
| 動画                 | [NARRATED_VIDEO_CONTENT_IMPLEMENTATION_ROADMAP](./developer/NARRATED_VIDEO_CONTENT_IMPLEMENTATION_ROADMAP.ja.md)                                 | ナレーション動画briefの判断材料拡張と目標構成                                                                                                                                                                                                                                                                                                                                         | Phase 0〜 / 要[checkpoint](./developer/NARRATED_VIDEO_CONTENT_IMPLEMENTATION_CHECKPOINT.ja.md) |
| 動画配信             | [personal-voice-narrated-video-delivery-plan](../knowledge/product/architecture/personal-voice-narrated-video-delivery-plan.md)                  | 個人音声ナレーション動画の生成・配信                                                                                                                                                                                                                                                                                                                                                  | —                                                                                              |
| 音声生成             | [voice-generation-absorption-plan](../knowledge/product/architecture/voice-generation-absorption-plan.md)                                        | 音声生成能力の吸収                                                                                                                                                                                                                                                                                                                                                                    | Phase 1 着手                                                                                   |
| レジストリ分割       | [REGISTRY_SPLIT_PLAN](./developer/REGISTRY_SPLIT_PLAN.md)                                                                                        | レジストリ群の分割                                                                                                                                                                                                                                                                                                                                                                    | 一覧表                                                                                         |
| サービス統合         | [service-integration-plan](./developer/architecture/service-integration-plan.md)                                                                 | ローカルAI→通信/協働→検証/自動化                                                                                                                                                                                                                                                                                                                                                      | Phase 1 現状                                                                                   |
| 意図学習             | [stale-doc-cleanup-rationale](../knowledge/product/architecture/stale-doc-cleanup-rationale-2026-06.md)                                          | 意図学習のシードキャッシュ整理と移行根拠                                                                                                                                                                                                                                                                                                                                              | Non-goals定義                                                                                  |
| Cowork連携           | [COWORK_INTEGRATION_PLAN](./COWORK_INTEGRATION_PLAN.md)                                                                                          | MCPサーバ/surface/承認/知識同期/プラグイン化(Phase 0–5)                                                                                                                                                                                                                                                                                                                               | 計画+パッチ提出済                                                                              |
| 揮発ナレッジ         | [VOLATILE_KNOWLEDGE_PLAN](./VOLATILE_KNOWLEDGE_PLAN.ja.md)                                                                                       | スコープ×寿命の揮発層（作業記憶・日次・週次・GC・昇格）                                                                                                                                                                                                                                                                                                                               | Phase 0監査済、Phase 1-5実装中                                                                 |

---

## 2. テーマ別サマリ

### 2.1 製品全体・エンジン基盤

- **PRODUCTIZATION_ROADMAP** — マスター（§0 参照）。12ヶ月の指標と現状充足度を持つ。
- **ROADMAP_COMPLETION_LEDGER** — 主要 roadmap の完了済み項目を横断で集約する台帳。原文の状態表記を参照する。
- **kyberion-ecosystem-evolution-roadmap** — Mesh Hub v1 を起点に、承認可能な共同作業、候補化された学習、same-tenant Mesh 実証、公開鍵アイデンティティ、助言型の資源/モデルルーティングを依存順に実装する計画。マスターの OSS/FDE 方針を置き換えない。
- **ROADMAP_ENGINE_REFINEMENT** — エンジン洗練の3フェーズ: ①パイプライン合成性 ②反応的知識(Reactive Knowledge) ③Design Protocol の汎化。
- **TASK_SCENARIO_ROADMAP** — 「意図→シナリオ→ワークフロー→CLIプロファイル」の網羅拡充。一部 MVP 実装済。

### 2.2 UX・意図解釈

- **POST_ONBOARDING_UX_ROADMAP** — 初回後の体験。再開フローと状態を表す言葉(status language)の洗練。
- **JAPANESE_CONTEXTUAL_INTENT_ALIGNMENT_ROADMAP** — 日本語の省略発話を安全に意図/ゴール/実行ステップへ落とす実装計画。現状ギャップ分析を含む。
- **distill_product-ux-roadmap-audit** — baseline/vitals/surface を横断したUX監査とロードマップ整合の蒸留(2026-05-29)。

### 2.3 本番化・抽象化・安全・競合吸収

- **PRODUCTION_READINESS_PLAN** — 本番運用に必要な改善項目(P1-x)を目的・対象・受入条件で定義。
- **improvement-plans-2026-07** — リポジトリ全体調査(22領域並列)に基づく改善計画の索引+個別計画70件。カテゴリ: コード品質 IP-01〜14、ユーザー接点 UX-01〜06、Actuator能力 AC-01〜06、ナレッジ/メモリ KM-01〜04、ミッション遂行 MO-01〜07、デザインシステム DS-01〜05、エージェント間通信 AA-01〜05、セキュリティ/監査 SA-01〜05、運用/可観測性 OP-01〜05、インテントライフサイクル IL-01〜05、初回オンボード ONB-01〜03、Surface UI capability SU-01〜04、Handoff HO-01〜02。繰り返し現れた構造は「設計・実装は優秀だが配線されていない/fail-open」(kill-switch・Mesh配送・揮発メモリ層・コスト集計・UX契約バリデータ・品質ルーブリック severity・A2UI介入パネル・AI-DLC playbook が同型)。MO-07/SU/HO/IL の一部は Claude Code/Fable 5 ハーネスのオーケストレーション原則(best-of-N/judge/敵対検証/自己完結ハンドオフ/goal 貫通)を翻訳したもの。P0はガバナンスlint実効化・secure-io違反解消・CIゲート・クリティカルパステスト・エラー提示統一・能力プローブ全数化・揮発メモリ層の起動・ミッションタイプ実効化・フェーズゲート実効化。MO 系は Claude Code/Fable 5 ハーネスのオーケストレーション原則を翻訳したもの。各タスクに実装担当モデル(sonnet/haiku/opus)を割当済み。関連評価: [project-vision-evaluation-2026-07](./verification/project-vision-evaluation-2026-07.ja.md)。
- **実行モデルの読み替え** — improvement-plans-2026-07 内の `claude-opus` / `claude-sonnet-4` / `claude-haiku` は役割ラベル。Codex 実行時は必要に応じて OpenAI 側の `gpt-5.5` / `gpt-5.4-mini` / 軽量 mini 系へ読み替えてよい。
- **kyberion-abstraction-security-improvement-plan** — 抽象化境界とセキュリティ改善。Phase 1–2 は実質実装済。
- **harness-adoption-plan-2026-05** — 他製品の「初回成功・マルチモーダル・再利用スキル・耐久的協働・ガバナンス」を模倣でなく吸収する計画。

### 2.4 ミッション/オーケストレーション/協働

- **mission-task-classification-roadmap-5.4-mini** — 契約/型の整合(A)→エスカレーションの決定論化(B)→オントロジー全網羅(C)。GPT-5.4 mini を出力モデルに想定。
- **mission-orchestration-control-plane** / **management-control-plane** — ミッション制御面と、promotion/delivery を束ねる経営オペレータモデル。
- **studio-agent-orchestration-absorption-plan** — ゴール駆動のマルチエージェント協調＋明示的ガバナンス。`composeMissionTeamBrief` 等の実装状況記載(2026-04-19)。
- **work-coordination-platform-plan** — Kyberion 間 peer が board 操作でなく claim/handoff/status_update/review_request の協働コマンドを運ぶ基盤。

### 2.5 ADF / パイプライン

- **adf-pipeline-simplification-mission-plan** — パイプライン内に直書きされた機械的処理を分離するミッション計画。
- **adf-pipeline-validation-plan** — パイプライン群を3分類で再評価し、差分が目的だけのものは実行骨格を共通化。

### 2.6 アーキテクチャ変革

- **polyglot-roadmap** — Node.js monolith(現状)→Sidecar Bridge(移行)→真の polyglot(最終)。

### 2.7 メディア（音声・動画）

- **NARRATED_VIDEO_CONTENT_IMPLEMENTATION_ROADMAP** — ナレーション動画 brief の判断材料不足を補い、目標アーキテクチャへ。再開時は同梱の checkpoint を先に読む。
- **personal-voice-narrated-video-delivery-plan** — 個人音声によるナレーション動画の生成・キュー・配信。
- **voice-generation-absorption-plan** — 音声生成能力の吸収（Phase 1 着手）。

### 2.8 インフラ・連携

- **REGISTRY_SPLIT_PLAN** — レジストリ群の分割計画。
- **service-integration-plan** — ローカルAI基盤(現状)→通信/協働(Zoom/Teams scaffolding)→検証/自動化。
- **stale-doc-cleanup-rationale** — 意図学習のシードキャッシュ整理と Codex App の移行根拠。
- **COWORK_INTEGRATION_PLAN** — Claude Cowork との密連携(MCPサーバ/surface/承認/知識同期/プラグイン化、Phase 0–5)。実装パッチ提出済・レビュー済。

### 2.9 揮発ナレッジ層（Working Memory）

- **VOLATILE_KNOWLEDGE_PLAN** — 「永続ナレッジ (`knowledge/`)」と「揮発的作業記憶」を**スコープ×ライフタイム**で第一級化する計画。`active/` ツリーをハイブリッド方式で格上げし、既存の `MissionWorkingMemory`・`memory-promotion-queue` を完成させる。5フェーズ構成: ①スキーマ/ガバナンス ②アクチュエータ/ディスク永続化 ②b personal/日次/週次 ③GC/rollover/rollup ④distill昇格ブリッジ ⑤横断索引+Recovery統合。

---

## 3. この索引の対象外（意図的に除外）

以下は「Kyberion 自体のロードマップ」ではないため索引に含めない:

- **再利用テンプレート/設計図** — `knowledge/public/templates/blueprints/*`（project-management-plan, test-plan, rollback-plan, cutover-migration-plan, capacity-planning-report 等）、`knowledge/public/templates/reporting/*`、`travel-planning-playbook`。これらは成果物テンプレ/プレイブックであり計画ではない。
- **顧客固有のリリース計画** — `knowledge/confidential/sbinbs/*/release-planning.md`。**confidential tier のため本索引（上位tier）に内容を転記しない**（AGENTS.md R5 tier 隔離）。存在のみ記録。
- **スキーマ README** — `knowledge/product/schemas/README-*`。スキーマ説明でありロードマップではない。

---

## 4. 保守

- 新しいロードマップ/計画文書を追加したら、本索引の §1 表と §2 サマリに1行追記する。
- ステータスはリンク先原文を権威とし、本索引では概況のみ保持（詳細値の二重管理を避ける）。
- 大きな再編時は、本索引を起点に各原文の現況を棚卸しする。
- 関連: マスターは [PRODUCTIZATION_ROADMAP](./PRODUCTIZATION_ROADMAP.md)、ガバナンスは [AGENTS.md](../AGENTS.md)。
