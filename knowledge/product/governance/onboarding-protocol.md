---
title: Sovereign Onboarding Protocol
category: Orchestration
tags: [onboarding, setup, concierge, identity]
importance: 8
related_roles: [Sovereign Concierge, Ecosystem Architect]
last_updated: 2026-10-18
kind: playbook
scope: global
authority: recipe
phase: [onboarding]
role_affinity: [sovereign_concierge, ecosystem_architect]
applies_to: [onboarding, identity, setup]
owner: sovereign_concierge
status: active
---

# 主権者オンボーディング・プロトコル (Sovereign Onboarding Protocol)

この文書は、新規ユーザー（主権者）が Kyberion エコシステムに参加する際の標準的な体験設計と、エージェント（Sovereign Concierge）の行動規範を定義する。

実行順と tenant / organization / activation のゲートは [オンボーディング標準フロー](./onboarding-flow.md) を正本とする。

## 1. 目的

主権者がエコシステムの構造を理解し、自身のアイデンティティを確立し、最初の任務（Mission）を遂行可能な状態に導くこと。

## 2. 5段階のオンボーディング・プロセス

### Stage 1: Greet (歓迎と儀礼)

- **役割**: Sovereign Concierge が主権者を迎える。
- **アクション**: エコシステムの目的を簡潔に説明し、歓迎の意を示す。
- **成果物**: 歓迎メッセージ。

### Stage 2: Sync (アイデンティティの調和)

- **役割**: 主権者の属性と好みを把握する。
- **アクション**: `pnpm onboarding` または reviewed JSON を使った `pnpm onboarding apply` で identity を設定する。active customer がある場合も、customer は stance overlay であり tenant registry の正本ではない。
- **成果物**: `my-identity.json` の永続化と、3-Tier ディレクトリ構造の確立。

### Stage 3: Provision (環境と capability overlay の配備)

- **役割**: 主権者のロールに応じたツールを準備する。
- **アクション**: **Sovereign Concierge** が必要な backend、接続、scope を確認し、標準フローの governed facade で設定する。実務に進む際の権限は work item / mission / role に応じて解決し、手書きの session ファイルで付与しない。
- **成果物**: readiness report と必要な接続・scope の確認結果。

### Stage 3a: First-Run Wizard (初回導線の固定)

- **役割**: 最初に何を設定すべきかを一つの入口にまとめる。
- **アクション**: LLM CLI からの初期設定は [プロンプト経由オンボーディング](../orchestration/prompt-first-onboarding.md)に従い、用途・本人・最初の仕事に必要な接続を会話で確認して既存 facade へ渡す。`launch-first-run-onboarding` pipeline は固定の identity を適用するデモ・自動検証用であり、実際の利用者には使わない。資料テーマ等はその仕事が必要になった時点で確認する。
- **UX**: ユーザーは「何を決めれば先に進めるか」を一度で理解できる。
- **成果物**: 初回セットアップ計画。

### Stage 3b: Integrate (組織ツールの接続)

- **役割**: 組織固有の CI/CD、通知、監査、配備フックを接続する。
- **アクション**: `configure-organization-toolchain` intent を使い、必要な連携先を棚卸ししたうえで、認証・承認・監査の境界を明示して登録する。
- **UX**: ここで何が自動化され、何が承認待ちになるかを先に見せると、初回体験の不安が減る。
- **成果物**: 組織ツール連携の登録レポート。

### Stage 3c: Bind Operating Context (顧客・テナント・組織の関連付け)

- **役割**: オンボーディング後の実行が、正しい customer overlay、tenant scope、organization operating model を使うようにする。
- **アクション**: `pnpm onboarding:context bind --customer-slug <customer> --tenant-slug <tenant> --dry-run` で書き込み範囲を確認し、承認後に `--apply` する。
- **UX**: `onboarding:context show --json` が返す `customer_slug`、`tenant_slug`、`organization_id`、tier、owner、first-work link を context card の入力として表示する。未解決または不一致の場合は実行を止める。各 surface のカード表示はこの stable JSON を投影し、表示文言を判定ロジックへ埋め込まない。
- **成果物**: `customer/{slug}/onboarding/organization-context.json` と tenant-scoped organization state。

binding は activation ではない。最初の仕事の apply 前に、[オンボーディング標準フロー](./onboarding-flow.md) の tenant activation gate（viewer scope、NHI、service readiness、isolation probe、人間の受け入れ）を通過させる。

### Stage 3d: Style Sync (資料の見た目を先に覚える)

- **役割**: 最初の資料作成で迷わないように、テーマと質問セットを先に保存する。
- **アクション**: `register-presentation-preference-profile` intent を使い、デッキ用途ごとの初動質問とテーマヒントを `presentation-preference-registry` に保存する。
- **UX**: 初回から「何を聞かれるか」と「どう見えるか」が揃うので、以後の資料生成が一貫する。
- **成果物**: `presentation-preference-profile` の登録。

### Stage 4: Navigate & Execute (ナビゲーションと最初の任務)

- **役割**: ナビゲーションを継続しながらの実務理解。
- **アクション**: コンシェルジュがナビゲーションを提供し続け、tenant activation が `active` になり、first-work の human review が済むまで伴走する。その後に governed mission controller または organization work を発火させる。

### Stage 5: Refine (フィードバックと蒸留)

- **役割**: オンボーディング体験の改善。
- **アクション**: 初回任務の振り返り（Judge & Distill）を行い、得られた知見を `knowledge/` に蒸留する。
- **成果物**: 蒸留されたナレッジ。

## 3. Sovereign Concierge の行動指針 (Omotenashi Principles)

1.  **先回り**: ユーザーが次に何をすべきか、常に選択肢を提示する。
2.  **透明性**: 技術的な初期化が必要な場合は、その意図と安全性を明確に説明する。
3.  **規律**: 3-Tier Sovereign Knowledge（階層型知識管理）を遵守し、主権者の機密を保護する。

## 4. 再起動への耐性

再開時は active profile の onboarding summary / state と、必要に応じて context binding・activation receipt を確認する。初期設定のためだけに mission を要求しない。mission-shaped な作業へ進んだ後の証跡は mission controller で記録する。会話履歴や手編集したチェックリストを正本にしない。

## 5. 関連ドキュメントとの関係

- `governance/phases/onboarding.md`: 技術的実行ステップ (Stage 1-3)。AGENTS.md から参照される主要プロトコル。
- **この文書**: Sovereign Concierge の行動規範と体験設計。
- `orchestration/onboarding-directives/00_sovereign_onboarding.md`: 初回ミッションとしての勝利条件定義。
