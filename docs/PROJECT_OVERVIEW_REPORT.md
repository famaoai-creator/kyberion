# Kyberion プロジェクト構造解析レポート

作成日: 2026-06-22 / 対象リビジョン: `05e5d2c1`（commit 総数 1,236）

---

## 1. プロジェクトの正体（一言で）

Kyberion は **「組織のワークループ・エンジン（organization work loop engine）」** を標榜する OSS プロジェクトです。
ユーザーは成果（outcome）を自然言語で述べるだけで、システムが計画（Plan）→ 実行（Result）→ 記憶（Memory）を回します。

> Intent（意図）→ Plan（計画）→ Result（結果）

設計の核心は「最も会話が上手な LLM が勝つのではなく、意図を確実に捕捉し、証跡を残し、組織的記憶を蓄積するエンジンが勝つ」という思想です。ChatGPT / Claude.ai（ステートレスなチャット）と Zapier / n8n / RPA（実行はできるが脆いルール連鎖）の中間を埋める存在として位置づけられています。

- **ライセンス**: MIT
- **ステータス**: OSS・活発に開発中（Pre-1.0）
- **言語方針**: 運用者向けルールは英語、概念・フェーズ・オンボーディング文書は日本語（バイリンガルが第一級）
- **収益モデル想定**: OSS ファースト → 有償の導入支援 / FDE（Forward Deployed Engineer）→ ユーザー基盤確立後に SaaS

---

## 2. 技術スタック

| 項目 | 内容 |
|---|---|
| 言語 | TypeScript（Node.js >= 24） |
| パッケージ管理 | pnpm workspace（モノレポ） |
| 規模 | TS/TSX 約 1,905 ファイル / 約 291,000 行 |
| テスト | Vitest、Playwright、fast-check（プロパティテスト）、c8/coverage |
| 主要ランタイム依存 | `@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/claude-code`、`@anthropic-ai/sdk`、`@openai/codex`、`@modelcontextprotocol/sdk`、`@agentclientprotocol/sdk` |
| ブラウザ自動化 | Playwright、Puppeteer |
| メディア/Office | exceljs、pptxgenjs、html-to-docx、mammoth、pdf-parse、jimp、tesseract.js（OCR）、gif-encoder-2 |
| 連携 | googleapis、@slack/bolt・web-api、express、ws、axios |
| スキーマ/検証 | ajv、zod、json-schema-to-typescript |
| ネイティブ | Swift ファイル（OCR / 仮想カメラ / 仮想オーディオ）も同梱 — macOS 連携を含む |
| 配布 | Dockerfile / docker-compose、CI（GitHub Actions） |

LLM バックエンドは Claude CLI / Anthropic API / Codex / Gemini CLI / OpenRouter / OpenAI 互換など複数を切替可能（`KYBERION_REASONING_BACKEND`）。ローカル `claude` CLI 認証時は API キー不要の `claude-cli` を優先する設計です。

---

## 3. ディレクトリ構造（モノレポ）

```
kyberion/
├── AGENTS.md            ← 正本のガバナンス憲章（CLAUDE/CODEX/GEMINI.md はシンボリックリンク）
├── libs/                ← ワークスペースパッケージ本体
│   ├── core/            ← 共有ランタイム・secure-io・ミッション/意図/監査の中核
│   │   └── src/         ← pipeline-engine, intent-compiler, trace, native-*-engine 等
│   ├── actuators/*      ← 実行能力（後述、約29種）
│   └── shared-*         ← business / media / nerve / network / vision のドメイン共有
├── scripts/             ← 154+ のオーケストレーション/CLI（mission_controller 他）
├── pipelines/           ← 宣言的 ADF パイプライン（43 JSON/YML + fragments）
├── schemas/             ← 94 の JSON スキーマ（契約検証用）
├── knowledge/           ← 3層記憶（personal / confidential / public）+ product / evolution
├── satellites/*         ← 外部チャネル（slack / discord / telegram / imessage / voice-hub / macos-camera）
├── presence/            ← ランタイム状態・表示・ブリッジ
├── customer/            ← 顧客オーバーレイ（fork なし FDE 用）
├── active/              ← 実行時状態・共有 tmp
├── docs/                ← user / operator / developer 向け文書 + 概念文書
├── vision/ vault/ migration/ templates/ plugins/ tools/
└── 各種設定（package.json, tsconfig, eslint, vitest, Docker 等）
```

---

## 4. アーキテクチャ：5層モデル

Kyberion は概念を 5 つの層に分けると理解しやすい構成です。

| 層 | 役割 | 代表的な構成要素 |
|---|---|---|
| **Intent（意図）** | 人間の要求・明確化・次アクション | intent-compiler、contextual-intent-*、operator interaction packet |
| **Control（制御）** | ミッション・プロジェクト・フェーズ・ゲート・台帳 | mission-controller、approval-gate、authority、ledger |
| **Knowledge（知識）** | 手順・スキーマ・テンプレ・ポリシー・カタログ | `knowledge/`、`schemas/`、各種 policy |
| **Execution（実行）** | アクチュエータ・パイプライン・配信 | `libs/actuators/*`、`pipelines/`、pipeline-engine |
| **Memory（記憶）** | 証跡・実行レポート・蒸留・知見 | trace、evidence-chain、audit-chain、distill |

データの流れ:

```
Sovereign intent
  → AGENTS.md ガバナンス + 5フェーズ・ライフサイクル
  → scripts / pipelines オーケストレーション
  → mission controller と協調契約
  → libs/core 共有ランタイム + secure I/O
  → libs/actuators/* 実行能力
  → knowledge/* 階層化された記憶・手順
  → active / presence ランタイム状態
  → satellites/* 外部チャネル
```

### 主要な永続コンテナ
- **Project** — 意味の長期コンテナ（リポジトリ・ミッション・サービスバインディング・成果物を所有）
- **Mission** — 自前の Git リポジトリを持つ実行＋監査単位（24時間以上の連続実行に耐える設計）
- **Task Session** — 会話的で軽量な実行契約（文書生成・サービス検査など）
- **Artifact** — 具体的な成果物（ファイル・要約・承認記録など）

---

## 5. アクチュエータ（実行能力カタログ）

`libs/actuators/` に約 29 種。Kyberion では「ブラウザは数あるツールの一つ」であり、コードもメディアも音声も対等な実行手段です。

agent / approval / artifact / blockchain / browser / calendar / code / daemon / email / file / **android・ios**（モバイル）/ media / media-generation / meeting・meeting-browser-driver / modeling / network / orchestrator / presence / process / secret / service / system / terminal / video-composition / vision / **voice** / **wisdom**（発散思考・相互批評）

カバー領域（README より）: ブラウザ自動化、音声ワークフロー、ファイル/メディア処理（PDF・PPTX・XLSX・DOCX・画像・動画）、コード支援、ネットワーク/サービス連携、システム操作、知識・記憶。

---

## 6. ガバナンスの中核ルール（AGENTS.md）

全フェーズで例外なく適用される運用規律：

1. **全ファイル I/O は `@agent/core/secure-io` 経由**（`node:fs` 直叩き禁止）。ミッションは `mission_controller.ts`（KSMC v2.0）で管理し、各ミッションは独立 Git リポジトリで原子的ロールバック可能。
2. **既存アクチュエータを優先**（独自コードを書く前に `CAPABILITIES_GUIDE.md` を参照）。
3. **サブエージェントによる戦略的委譲**（大量・専門タスクは `delegateTask()`）。
4. **検証済み ADF 契約のみ実行**（`draft → preflight → auto-repair → commit → execute`、失敗時はリトライせず分類・修復）。
5. **3層データ隔離の徹底**（personal → confidential → public への漏洩禁止）。
6. **1ミッション1オーナー**（ワーカーはタスク契約経由で協調）。
7. **実質的な作業はミッション化**（5条件のうち2つを満たせばパイプライン経由。顧客に「Kyberion 製ガバナンスの証拠」として出すものは必ずミッション経由＝dog-food ルール）。

### 5フェーズ・ライフサイクル
セッション開始時に `pnpm pipeline --input pipelines/baseline-check.json` を実行し、status により遷移：
① Onboarding → ② Recovery → ③ Alignment（意図解釈・目標合意、コード変更前）→ ④ Execution（一度に一つ変更し即テスト）→ ⑤ Review（成功/失敗から知見を `knowledge/` に蒸留、フィードバックループ生成）

---

## 7. 差別化ポイント（README「How It Compares」より）

| 比較対象 | Kyberion の付加価値 |
|---|---|
| ChatGPT / Claude.ai | ステートフルなミッション、ガバナンス実行、アクチュエータ群、監査チェーン、実行をまたぐ再利用記憶 |
| Cursor | コードは多数のアクチュエータの一つ。作業単位は単発チャットでなく永続状態を持つ長期ミッション |
| Computer Use / ブラウザエージェント | ミッションスコープの状態、層隔離された知識、顧客アグリゲーション。ブラウザは基盤でなく一ツール |
| Zapier / n8n / RPA | 脆いルール連鎖を意図駆動の計画に置換。Trace 由来の再利用ヒントでサイト変更にも耐える |
| AI Ops / agent SaaS | OSS・セルフホスト・顧客データはローカル維持。中央サーバ不要、FDE 対応 |

固有の仕組み:
- **ADF パイプライン形式** — 宣言的・スキーマ検証済み・サブパイプライン合成可能、`on_error` リカバリ付き
- **ミッション・ライフサイクル** — 各作業が独自 Git リポジトリ・状態・証跡を持つ
- **3層知識隔離** — ファイル I/O 境界で強制
- **顧客アグリゲーション** — `customer/{slug}/` オーバーレイで fork 不要のカスタマイズ
- **Trace + 監査** — OTel 風の構造化トレースと追記専用監査チェーン

---

## 8. ロードマップ（PRODUCTIZATION_ROADMAP）

- **Phase A** — first-win を5分に（進行中）
- **Phase B** — 30日連続運用に耐える（基盤着地済み）
- **Phase C'** — 1週間未満で貢献可能に
- **Phase D'** — fork なしで FDE / 導入支援を可能に

戦略的立ち位置は「OSS ファースト＋有償の導入支援 / FDE」。SaaS はユーザー基盤確立後。

---

## 9. 所見・まとめ

Kyberion は単なるエージェント・ラッパーではなく、**「意図 → ガバナンス実行 → 証跡 → 組織記憶」という業務ループ全体を製品化しようとする野心的な OSS フレームワーク**です。特徴的なのは次の3点：

1. **ガバナンスと監査が第一級** — secure-io 強制、ミッション単位の Git 隔離、追記専用監査チェーン、3層データ隔離。エンタープライズ/規制業務（FDE 提供）を明確に意識した設計。
2. **マルチモーダルな実行基盤** — 約29のアクチュエータでブラウザ・音声・映像・モバイル・Office・コードまでを対等に扱い、複数 LLM バックエンドを抽象化。
3. **学習する仕組み** — 実行 Trace から再利用ヒントを生成し、知識を3層で蓄積するフィードバックループを内蔵。

規模（29万行・1,236 commit・94 スキーマ）と網羅性から、相当に成熟したアーキテクチャ志向の高いプロジェクトと言えます。一方で Pre-1.0・活発開発中であり、「5分の first-win」「30日連続運用」がまだ磨き込み途上である点は README が率直に認めています。

---

### 主要参照ファイル
- `README.md` / `AGENTS.md`（ガバナンス憲章）
- `docs/WHY.md`（思想）・`docs/GLOSSARY.md`（用語）・`docs/COMPONENT_MAP.md`（構造）
- `docs/PRODUCTIZATION_ROADMAP.md`（ロードマップ）
- `libs/core/`・`libs/actuators/`・`pipelines/`・`schemas/`・`knowledge/`
