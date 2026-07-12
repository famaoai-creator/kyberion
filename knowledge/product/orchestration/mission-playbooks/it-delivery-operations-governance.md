---
title: ミッション・プレイブック：IT デリバリ＆運用ガバナンス
category: Orchestration
tags:
  [
    orchestration,
    mission-playbooks,
    sdlc,
    feature-expansion,
    incident-response,
    gating,
    governance-body,
    会議体,
  ]
importance: 9
author: Ecosystem Architect
last_updated: 2026-07-08
---

# ミッション・プレイブック：IT デリバリ＆運用ガバナンス

ソフトウェア開発・インフラ構築・インフラ運用を営む IT 企業の3つの中核プロセスを、kyberion のインテント→ゴール→リザルト・ループに取り込んだもの。過去の実プロジェクト(Waterfall + フェーズゲート G1–G6、RACI、prepared/private/public 成熟度バケット、インシデント調査報告構成)の一般化された骨格を product ティアに institutionalize している。**顧客・テナント固有情報(顧客名、システム名、チケットID、証明書/秘密鍵、private/prepared の物理名)は一切含めない** — 個別運用は `knowledge/confidential/{tenant}/` に置く。

## 対象プロセスと実体

| プロセス              | ミッションワークフロー       | インテント                   | 会議体(ゲート)                                                                            |
| --------------------- | ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| A. 機能拡張デリバリ   | `feature-expansion-delivery` | `feature-expansion-delivery` | 企画審査会/要件定義レビュー会/設計審査会/CAB/検証判定会/リリース判定会議/クローズレビュー |
| B. インシデント対応   | `incident-response`          | `incident-response`          | インシデント対応会議/ポストインシデントレビュー                                           |
| C. ゲーティング会議体 | `gate-review-session`        | `gate-review-session`        | 上記すべての判定会を運用する汎用セレモニー                                                |

共通基盤:

- ゲート定義: `knowledge/product/governance/gate-profiles/gate-profile-registry.json`(SDLC 7ゲート + インシデント4ゲート。`sdlc-gating-model.md` が参照)
- 会議体カタログ: `knowledge/product/governance/governance-body-registry.json`(開催事前条件・アジェンダ・入口/出口クライテリア・決裁者・定足数)
- スキーマ: `schemas/gate-profile.schema.json`, `schemas/governance-body-registry.schema.json`
- 重大度モデル: `knowledge/product/operations/incident-severity-model.md`(SEV0–SEV3)

各ゲートは「決裁者・必要成果物・exit基準」の3点を固定する(`sdlc-gating-model.md`: この3点が曖昧なゲートは判断会議ではなく単なるレビュー会になる)。ミッションワークフローの `exit_gate`(機械チェック)と会議体(人間判断)は 1:1 対応し、`gate-profile-registry` の `mission_gate_id` で結ばれる。

---

## A. 機能拡張デリバリ (`feature-expansion-delivery`)

顧客要件ヒアリングを起点に、既存サービスへの機能拡張を G1–G7 のフェーズゲートで進める。

| フェーズ           | 種別          | ゲート                  | 会議体             | 人間承認    |
| ------------------ | ------------- | ----------------------- | ------------------ | ----------- |
| 企画・提案 (G1)    | approval      | `PROPOSAL_APPROVED`     | 企画審査会         | ✅          |
| 顧客要件ヒアリング | judgment      | `HEARING_DONE`          | —                  | —           |
| 要件定義 (G2)      | judgment      | `REQUIREMENTS_BASELINE` | 要件定義レビュー会 | ✅ 顧客合意 |
| 基本設計 (G3)      | judgment      | `DESIGN_DRAFTED`        | —                  | —           |
| 設計審査           | review        | `DESIGN_APPROVED`       | 設計審査会         | ✅          |
| 実装 (G4)          | judgment      | `BUILD_DONE`            | CAB                | —           |
| 検証 (G5)          | deterministic | `VALIDATION_DONE`       | 検証判定会         | —           |
| 受入(UAT)          | review        | `UAT_PASSED`            | 検証判定会         | ✅ 顧客受入 |
| リリース (G6)      | approval      | `RELEASE_READINESS`     | リリース判定会議   | ✅ Go/No-Go |
| 振り返り (G7)      | judgment      | `CLOSURE_REVIEW`        | クローズレビュー   | —           |

判断フェーズは semantic brief、ヒアリング/設計/実装/検証/リリースは既存パイプライン(`requirements-elicitation` / `design-from-requirements` / `execute-task-plan` / `test-plan-from-requirements` / `deploy-release` / `post-release-retrospective`)を再利用する。`mission_class: product_delivery` + `risk_profile: approval_required` で strict レビューモード。チームは `product_development`。

---

## B. インシデント対応 (`incident-response`)

速報性を優先し `intake`/`classification` を省略、検知から直行する。

| フェーズ               | 種別          | ゲート                 | 会議体/判定                   | 人間承認        |
| ---------------------- | ------------- | ---------------------- | ----------------------------- | --------------- |
| 検知・受付             | judgment      | `DETECTION_LOGGED`     | —                             | —               |
| トリアージ・重大度判定 | judgment      | `SEVERITY_GATE`        | インシデント対応会議(SEV確定) | ✅ 重大度・体制 |
| 封じ込め               | approval      | `CONTAINMENT_APPROVED` | インシデント対応会議          | ✅ 実行承認     |
| 恒久対応               | judgment      | `REMEDIATION_APPROVED` | インシデント対応会議          | ✅              |
| 復旧確認               | deterministic | `RECOVERY_VALIDATED`   | —                             | —               |
| ポストモーテム         | judgment      | `POSTMORTEM_DRAFTED`   | —                             | —               |
| 振り返りレビュー       | review        | `POST_INCIDENT_REVIEW` | ポストインシデントレビュー    | —               |
| 報告・クローズ         | approval      | `INCIDENT_CLOSED`      | —                             | ✅              |

重大度は `incident-severity-model.md` の3軸(影響範囲・事業影響・回避可能性)で判定。SEV0/1 は `incident-command` を即時招集、SEV0 は `steering-committee` へ自動エスカレーション。封じ込めは `security-incident-containment` フラグメント(人間承認ステップ内蔵)、根本原因分析は `incident-post-mortem` パイプラインを再利用。`mission_class: operations_and_release` + `risk_profile: high_stakes`。チームは `incident`。

---

## C. ゲーティング会議体 (`gate-review-session` + レジストリ)

「ゲーティングの会議体の設定」= `governance-body-registry.json` に標準会議体を定義し、`gate-review-session` ワークフローで各判定会を運用する。

各会議体は次を保持する(ユーザー要望の「アジェンダ・クライテリア・開催事前条件」):

- **開催事前条件 (preconditions)** — 事前配布資料・前提の充足
- **アジェンダ (agenda)** — 進行順
- **入口クライテリア (entry_criteria)** — 判定に必要な入力/成果物
- **出口クライテリア (exit_criteria)** — GO を出すための条件
- **決裁者 (decision_owner)** と **定足数 (quorum)**
- **判定 (decisions)** — Go / Conditional Go / No-Go / Hold
- **所管ゲート (gates_owned)**

登録済み会議体: 企画審査会 / 要件定義レビュー会 / 設計審査会 / 変更諮問会議(CAB) / 検証判定会 / リリース判定会議 / クローズレビュー / インシデント対応会議 / ポストインシデントレビュー / ステアリングコミッティ。

`gate-review-session` ワークフロー: 判定資料準備(`gate-review-packet` 作成、開催事前条件の確認) → 判定会(定足数のもと Go/No-Go を判定・記録) → 議事録記録。どのゲート・どの会議体にも適用でき、A/B のワークフローのゲートを正式な判断会議として運用する。

---

## 実行手順(共通)

```bash
# 例: 機能拡張
node dist/scripts/mission_controller.js create MSN-FEAT-<slug> \
  --tier confidential --tenant-slug <tenant> \
  --mission-type feature-expansion-delivery --intent-id feature-expansion-delivery \
  --track-type delivery --lifecycle-model default-sdlc
node dist/scripts/compose_mission_team.js --mission-id MSN-FEAT-<slug> --request "..." --write
node dist/scripts/mission_controller.js start MSN-FEAT-<slug>
node dist/scripts/mission_controller.js plan-tasks MSN-FEAT-<slug>
node dist/scripts/mission_controller.js dispatch-workitems MSN-FEAT-<slug>
# 各判定会(会議体)で gate-pass:
node dist/scripts/mission_controller.js gate-pass MSN-FEAT-<slug> REQUIREMENTS_BASELINE --note "要件定義レビュー会: 顧客合意"
node dist/scripts/mission_controller.js gate-pass MSN-FEAT-<slug> RELEASE_READINESS --note "リリース判定会議: GO"

# 例: インシデント(track-type incident / lifecycle incident-response)
node dist/scripts/mission_controller.js create MSN-INC-<slug> --tier confidential \
  --mission-type incident-response --intent-id incident-response \
  --track-type incident --lifecycle-model incident-response
```

## 顧客ごとの実体化とティア分離

- 再利用テンプレート・会議体定義・ゲートプロファイルは **product ティア**(一般化・固有情報なし)。
- 顧客個別の SLA・連絡先・会議体メンバー・システム名・チケット体系は **confidential ティア** (`knowledge/confidential/{tenant}/`) に上書き定義。
- private/prepared 相当の物理名・内部見積り・顧客議事録は confidential のミッション証跡に取り込み、public へは昇格しない。

→ 関連: [security-audit-service.md](./security-audit-service.md) · `sdlc-gating-model.md` · `incident-management-excellence.md` · `governance-body-registry.json`
