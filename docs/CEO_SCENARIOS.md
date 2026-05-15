# CEO 業務シナリオ評価

> Executive / decision-support view. Canonical breadth lives in [`USE_CASES.md`](./USE_CASES.md); this doc keeps the CEO-focused matrix and examples compact.

CEO の実業務を 10 パターンに分類し、Kyberion での実行可能性をシミュレートした結果。

## 評価サマリー

| # | シナリオ | 判定 | Intent | Hint | Procedure | Actuator |
|---|---------|------|--------|------|-----------|----------|
| 1 | 月次経営レポート生成 | PASS | generate-report | browser-dashboard-patrol | executive-reporting | media + browser |
| 2 | 取締役会資料作成 | PASS | generate-presentation | pdf-to-pptx-defaults | generate-proposal-pptx | media |
| 3 | 採用面接スケジュール管理 | PASS | open-site | browser-calendar-management | calendar-management | browser |
| 4 | 契約書レビュー | PASS | knowledge-query | document-digest | (LLM analysis) | media |
| 5 | 競合分析レポート | PASS | generate-report | browser-dashboard-patrol | executive-reporting | browser + media |
| 6 | 社内 Slack 運用 | PASS | knowledge-query | (slack-sensor) | sync-saas-data | service |
| 7 | GitHub PR/Issue 管理 | PASS | (shell) | github-pr-management | github-pr-management | system |
| 8 | 請求・入金管理 | PASS | generate-report | browser-approval-workflow | generate-invoice-pdf | media + browser |
| 9 | セキュリティインシデント対応 | PASS | (shell) | security-incident-response | security-incident-response | system + approval |
| 10 | 四半期 OKR 進捗確認 | PASS | generate-report | browser-dashboard-patrol | project-lifecycle-management | browser + media |

**結果: 10/10 実行可能**

---

## 各シナリオ詳細

### 1. 月次経営レポート生成

**CEO の発話例**: 「今月の経営レポートを作って」

**実行パス**:
```
intent: generate-report
  → browser-actuator: 各ダッシュボード（GA, Salesforce, Datadog）を巡回
  → file-actuator: データをステージング
  → media-actuator: document_outline_from_brief → brief_to_design_protocol → generate_document
  → 成果物: XLSX or PPTX
```

**使用するリソース**:
- Hint: `browser-dashboard-patrol.json` (Pattern D: 複数サイト横断)
- Procedure: `executive-reporting.md`
- Actuator ops: `goto`, `snapshot`, `content` (browser) → `document_digest`, `generate_document` (media)

---

### 2. 取締役会資料作成

**CEO の発話例**: 「来週の取締役会用のプレゼンを作って。Q4 実績と来期計画で」

**実行パス**:
```
intent: generate-presentation
  → media-actuator: document-brief (artifact_family: presentation, document_type: proposal)
  → テーマ適用: kyberion-standard or カスタムテーマ
  → native-pptx-engine: Protocol → PPTX 生成
  → 成果物: PPTX
```

**使用するリソース**:
- Hint: `pdf-to-pptx-defaults.json` (テーマ・レイアウト定義)
- Procedure: `generate-proposal-pptx.md`
- テーマカタログ: `knowledge/public/design-patterns/media-templates/themes/`

---

### 3. 採用面接スケジュール管理

**CEO の発話例**: 「来週の面接候補日を確認して、田中さんの面接をセットして」

**実行パス**:
```
intent: open-site (calendar)
  → browser-actuator: Google Calendar / Outlook にログイン
  → pause_for_operator: 初回認証は人間が実施
  → export_session_handoff: セッション保持
  → snapshot: 週間カレンダーを取得し空き時間を分析
  → click_ref + fill_ref: イベント作成
  → 成果物: カレンダーイベント作成完了
```

**使用するリソース**:
- Hint: `browser-calendar-management.json` (Pattern B: 認証のみ人間)
- Procedure: `browser/calendar-management.md`
- セッション永続化: `export_session_handoff` / `import_session_handoff`

---

### 4. 契約書レビュー

**CEO の発話例**: 「この契約書を確認して、リスクがある条項を教えて」

**実行パス**:
```
intent: knowledge-query + document analysis
  → media-actuator: document_digest (PDF → Markdown)
  → LLM: Markdown を分析し、リスク条項を抽出
  → 成果物: リスク箇所のリストと推奨対応
```

**使用するリソース**:
- Hint: `document-digest.json` (Pattern A: 完全自動)
- 新機能: `protocolToMarkdown()` + `document_digest` オペレーション
- PDF テーブル抽出: `extractTablesFromPage()` で金額表・条件表を構造化

---

### 5. 競合分析レポート

**CEO の発話例**: 「競合 3 社の最新状況をまとめて」

**実行パス**:
```
intent: generate-report + live-query
  → browser-actuator: 各競合サイトを巡回（料金ページ、プレスリリース、採用情報）
  → snapshot + screenshot: 前回との差分を検出
  → media-actuator: 収集データからレポート生成
  → 成果物: 競合分析 DOCX/PPTX
```

**使用するリソース**:
- Hint: `browser-dashboard-patrol.json` (Pattern D: 複数サイト横断)
- Procedure: `executive-reporting.md`
- ブラウザ操作: `goto` → `snapshot` → `screenshot` → `content`

---

### 6. 社内 Slack 運用

**CEO の発話例**: 「今日の Slack で重要なメッセージを要約して」

**実行パス**:
```
intent: knowledge-query
  → service-actuator: Slack API (conversations.history) でメッセージ取得
  → LLM: メッセージを重要度分類し要約
  → service-actuator: chat.postMessage で応答送信（必要に応じて）
  → 成果物: チャネル別要約
```

**使用するリソース**:
- Sensor: `slack-sensor.adf.json` (継続的監視)
- Procedure: `sync-saas-data.md` (Slack 連携設定)
- Service-Actuator: API mode + secret-guard でトークン管理

---

### 7. GitHub PR/Issue 管理

**CEO の発話例**: 「今のオープン PR を確認して、問題なければマージして」

**実行パス**:
```
intent: (shell operation)
  → system-actuator: gh pr list --json (PR 一覧取得)
  → system-actuator: gh pr view + gh pr diff (詳細・差分確認)
  → LLM: diff を分析し、品質・セキュリティ・アーキテクチャ観点でレビュー
  → system-actuator: gh pr review --approve (承認)
  → approval-gate: マージ前の承認チェック
  → system-actuator: gh pr merge (マージ実行)
  → 成果物: レビューコメント + マージ完了
```

**使用するリソース**:
- Hint: `github-pr-management.json` (Pattern B: gh CLI 認証後は自動)
- Procedure: `system/github-pr-management.md`
- 安全装置: protected branch へのマージは `enforceApprovalGate()` 通過

---

### 8. 請求・入金管理

**CEO の発話例**: 「今月の請求書を発行して、先月の入金を確認して」

**実行パス**:
```
intent: generate-report + open-site
  → media-actuator: document_pdf_from_brief (請求書 PDF 生成)
  → browser-actuator: 会計システムにログイン → 入金一覧を取得
  → LLM: 請求と入金の突合・消込判定
  → 成果物: 請求書 PDF + 消込結果レポート
```

**使用するリソース**:
- Hint: `browser-approval-workflow.json` (承認フロー)
- Procedure: `generate-invoice-pdf.md`
- 金額突合: `protocolToMarkdown()` で PDF テーブルを構造化し比較

---

### 9. セキュリティインシデント対応

**CEO の発話例**: 「本番環境のセキュリティアラートを確認して対応して」

**実行パス**:
```
intent: (incident response)
  → sensor: log-watcher が CRITICAL/UNAUTHORIZED を検知
  → system-actuator: ログ収集・影響範囲調査
  → LLM: 重要度分類（P1-P4）
  → approval-gate: P1/P2 は CEO 承認必須
  → system-actuator: 対応実行（認証情報無効化、サービス隔離等）
  → media-actuator: インシデントレポート生成
  → audit-chain: 全操作をハッシュチェーンで記録
  → 成果物: インシデントレポート + 監査証跡
```

**使用するリソース**:
- Hint: `security-incident-response.json` (Pattern C: 調査は自動、対応は承認必須)
- Procedure: `system/security-incident-response.md`
- Sensor: `log-watcher.adf.json`
- ガバナンス: `enforceApprovalGate()` + `auditChain.record()`

---

### 10. 四半期 OKR 進捗確認

**CEO の発話例**: 「今四半期の OKR 進捗をまとめて」

**実行パス**:
```
intent: generate-report
  → browser-actuator: プロジェクト管理ツール（Jira, Linear 等）を巡回
  → snapshot: 各チームの進捗データを取得
  → file-actuator: データ集約
  → media-actuator: OKR 進捗レポート生成（PPTX/XLSX）
  → 成果物: OKR ダッシュボードレポート
```

**使用するリソース**:
- Hint: `browser-dashboard-patrol.json` (Pattern D: 複数サイト横断)
- Procedure: `project-lifecycle-management.md`, `executive-reporting.md`
- if/while 制御フロー: チーム数分のループ処理

---

## 改善履歴

| 日付 | シナリオ | 改善内容 |
|------|---------|---------|
| 2026-04-14 | #3 カレンダー管理 | hint + procedure 追加 (browser-calendar-management) |
| 2026-04-14 | #7 GitHub PR 管理 | hint + procedure 追加 (github-pr-management) |
| 2026-04-14 | #9 インシデント対応 | hint + procedure + playbook 追加 (security-incident-response) |

## 共通パターン

すべてのシナリオは以下の 4 パターンに分類できる:

| パターン | 説明 | 該当シナリオ |
|---------|------|-------------|
| **A: 完全自動** | 認証不要、定期実行可能 | #4 契約書, #6 Slack |
| **B: 認証のみ人間** | 初回ログインは人間、以降自動 | #3 カレンダー, #7 GitHub, #8 請求 |
| **C: 判断分岐あり** | 条件によって自動/人間確認を分岐 | #1 レポート, #9 インシデント |
| **D: 複数サイト横断** | N サイトからデータ集約 | #2 取締役会, #5 競合, #10 OKR |

## 追加利用可能な Governed Stack（origin/main 取り込み後）

以下は origin/main で追加された governed actuator stack。既存シナリオの拡張に利用可能：

| Stack | 代表 ops / contract | 推奨シナリオ拡張 |
|---|---|---|
| **Voice (governed)** | `voice-generation-runtime`、`voice-engine-registry`、personal voice profile | #2 取締役会資料のナレーション版、#4 契約書レビューの口頭サマリ、#9 インシデント通知の音声配信、#10 OKR 月次ダイジェストの音声版 |
| **Video Composition (deterministic)** | `video-composition-compiler`、`narrated-video-brief-compiler`、`video-render-runtime` | #2 取締役会資料の動画プレビュー、#5 競合分析のサマリ動画、外部向けイントロムービー |
| **Decision Support** | `stakeholder-consensus-orchestrator`、`hypothesis-tree`、`negotiation-rehearsal`、`counterfactual-branch` | #11（未分類）重大意思決定の事前合意形成・リハーサル系は `mission_class: decision_support` に該当 |

既存シナリオ #2 / #5 / #9 / #10 は media actuator に加えて voice/video の governed stack を組み合わせることで、成果物形態の選択肢（PPTX → PPTX+ナレーション動画）を拡張できる。個別の scenario 詳細はユースケース発生時に追記する。

## 判断支援系シナリオ（11-15）

origin/main 取り込み後に first-class 化された判断支援ミッション例。`mission_class: decision_support` としてルーティングされる：

| # | シナリオ | Intent | Procedure / Pipeline | Mission Sub-type |
|---|---|---|---|---|
| 11 | 新組織構造の根回し | build-stakeholder-consensus | stakeholder-consensus-orchestrator.json | consensus_building |
| 12 | 投資判断の仮説検証 | explore-hypotheses | hypothesis-tree.json | hypothesis_exploration |
| 13 | 役員会プレゼンのリハ | rehearse-session | negotiation-rehearsal.json | rehearsal |
| 14 | 大型契約の交渉準備 | prepare-negotiation | （契約書 protocol-to-markdown + negotiation-state） | negotiation_prep |
| 15 | 直観記録 | capture-intuition | （intuition-capture-protocol） | intuition_capture |

判定ゲート：`STAKEHOLDER_ALIGNMENT` / `DISSENT_RESOLUTION` / `REHEARSAL_READINESS` / `INTENT_DRIFT`。
