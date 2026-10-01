---
title: 'Coherence 監査 改善計画 (2026-10-01)'
tags: [improvement-plan, cli, registry, i18n, orphan, docs]
last_updated: 2026-10-01
---

# Coherence 監査 改善計画 (2026-10-01)

Mission: `MSN-COHERENCE-AUDIT-20261001`

2026-10-01 の全体監査（孤立機能 / 拡張性を損なうハードコード / 使い方の伝達不足 / 直感性）で見つかった項目をすべて解消する。
4 ブランチ（= 4 PR）に分け、ファイル所有を分離して並行実装する。

| ブランチ                       | worktree                 | 範囲                                                                     |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------ |
| `agent/cli-ux-20261001`        | `kyberion-cli-ux`        | CLI 安全性・ヘルプ・命名・環境チェック・ドキュメント (CU-*)              |
| `agent/registry-ssot-20261001` | `kyberion-registry-ssot` | プロバイダ / サーフェス / チャネル / op / mediator の単一情報源化 (RS-*) |
| `agent/i18n-tokens-20261001`   | `kyberion-i18n-tokens`   | 意図語彙・UI 文字列・ロケール・デザイントークン (IT-*)                   |
| `agent/orphan-wiring-20261001` | `kyberion-orphan-wiring` | 孤立機能の接続 or retire、UI 孤立ページ / API (OW-*)                     |

## 方針（判断済み）

- **後方互換**: コマンド名の変更は旧名を deprecated alias として残し、警告を出す。
- **孤立機能**: 自然な本番呼び出し元がある場合は接続（必要なら opt-in env フラグ）。ない場合は `retired/` へ移し理由を `retired/README.md` に記録。git 履歴から復元可能。
- **除外**: `compute-actuator` は `feat/compute-actuator-colab-driver` で開発中、`install_chronos_launchd.ts` / generation-schedule daemon は PR #846 で扱うため本計画では触らない。
- **i18n**: UI / 応答文字列は `user-facing-vocabulary.json`（en + ja 必須）経由。意図判定の語彙はロケール別フレーズとして knowledge に置く。
- **単一情報源**: 一覧の複製はレジストリ JSON から導出し、乖離を検出するチェックを追加する。

## CU — CLI / UX / ドキュメント

| ID    | 内容                                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CU-01 | 共通 `--help` ガード: 副作用のあるコマンド（`pr create`, `secrets encrypt`, `manifests sign`, `onboard` ほか）が `--help`/`-h` で実行されない。未知フラグを拒否する。                    |
| CU-02 | `kyberion` から起動する長時間・対話コマンドを inherit stdio・タイムアウトなしで起動（manifest に `interactive`/`long_running`）。                                                        |
| CU-03 | `cli-commands.json` に `description`（en/ja 語彙キー）を追加し、`kyberion --help` を用途別グループ表示。dev コマンドは既定で非表示。`kyberion help` と統一。                             |
| CU-04 | 未知コマンドに「もしかして」と `--help` 案内。dead な `organization-roles` 分岐を削除。                                                                                                  |
| CU-05 | 同名衝突（governed vs script）を manifest チェックで禁止。`pnpm intent` → `intent:trace`。                                                                                               |
| CU-06 | `dist/` 未ビルド時に「先に `pnpm build`」と案内する共通ガード。                                                                                                                          |
| CU-07 | 未知 `KYBERION_*` 変数は CI 以外では警告に格下げ。pads のテナントエラーに `--tier public` / tenant 一覧の案内。`mission status` 等の読み取り系は推論バックエンド探査をスキップ。         |
| CU-08 | スクリプト命名を `noun:verb` に統一（旧名 alias）。`dev` → `verify`、`chronos`(scheduler) → `scheduler`、`inventory` → `work:inventory`、`customer:*` → `stance:*`。命名 lint を追加。   |
| CU-09 | 診断系を `kyberion doctor --scope env                                                                                                                                                    | service | voice | meeting`に、セットアップ系を`kyberion setup <area>` に集約（既存コマンドは alias）。 |
| CU-10 | ドキュメント修正: `pnpm doctor` → `pnpm kyberion doctor`、存在しないコマンド、リンク切れ、存在しないパイプライン、`pnpm onboard` の説明、pads ポート。                                   |
| CU-11 | 未記載の scripts / サブコマンド / パイプラインを文書化（pipelines/README を全件化）。                                                                                                    |
| CU-12 | 入口を QUICKSTART に一本化し他は参照に。オンボーディング入口の関係表を追加。重複 docs（OPERATIONS_READINESS_MATRIX 等）を統合。古い自己記述を更新。                                      |
| CU-13 | COMPONENT_MAP のトップレベルディレクトリ表を実在ディレクトリと一致させ、CI で検出。GLOSSARY に Surface/Presence/Satellite/Pad/Concierge/Front Desk/Stance を追加し、5 概念ページを新設。 |
| CU-14 | docs drift チェック（存在しないコマンド・リンク切れ・パイプライン未記載・COMPONENT_MAP）を `pnpm check` に追加。                                                                         |

## RS — レジストリ単一情報源化

| ID    | 内容                                                                                                                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RS-01 | reasoning-provider JSON に `binary`, `version_args`, `bin_env_key`, `sandbox_args`, `model_env_keys`, `endpoint`, `egress_provider_id`, `install` を追加し、`KNOWN_MODES`・capability profile・環境プローブ・conformance・cli-mode-presence・model env マップ・egress endpoint・managed-env を導出に置換。 |
| RS-02 | ハードコードされたモデル ID を `resolveRuntimeModelId(role)` 経由に（`codex-fast`, `grok-default`, `gemini-image`, `ollama-vision` ロール追加）。`provider-config.json` の gemini 不整合を解消。                                                                                                           |
| RS-03 | プロバイダ別 if/ternary（intent-contract, workitem-dispatch-review, route-doctor, api-provider ほか）をレジストリ駆動に。未知プロバイダの黙った codex 変換を廃止。                                                                                                                                         |
| RS-04 | サーフェス: 説明・ポート・remediation を `active-surfaces.json` から導出。ハードコードポート撤去。operator-surface / pads / terminal-hud を登録。surface-roles との整合チェック。ゲートウェイ（slack/telegram/imessage）既定 off。                                                                         |
| RS-05 | ACP mediator のツール→アクチュエータ対応をマニフェスト駆動に（全アクチュエータ網羅、未知は deny）。                                                                                                                                                                                                        |
| RS-06 | チャネルアダプタレジストリ（一覧・エスケープ・特殊処理）。会議プラットフォーム分岐をレジストリへ。                                                                                                                                                                                                         |
| RS-07 | coordination kind → actuator 対応、procedure executor をレジストリ化。op ディスパッチの巨大 switch をハンドラマップ化（system / browser / modeling）。                                                                                                                                                     |
| RS-08 | 雑多なハードコード: 絶対パス、ComfyUI URL、リポジトリ URL、例示 tenant slug。                                                                                                                                                                                                                              |

## IT — i18n / デザイントークン

| ID    | 内容                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IT-01 | 意図判定の日英正規表現（138 箇所）をロケール別フレーズ knowledge に移し、共通マッチャで判定。                                                                 |
| IT-02 | ユーザー向け日本語リテラルを `user-facing-vocabulary.json` 経由に（surface 応答、approval UI、slack onboarding、meeting digest ほか）。ロケールに従って応答。 |
| IT-03 | `=== 'ja'` 系比較と `'ja-JP'` リテラルを `SupportedLocale` ヘルパに置換。                                                                                     |
| IT-04 | media / video / pptx の hex カラーをテーマパック・ブランドトークン経由に（テナント overlay が届く）。                                                         |
| IT-05 | ハードコード日本語/英語の検出チェック（ratchet）を追加。                                                                                                      |

## OW — 孤立機能

| ID    | 内容                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OW-01 | サブシステム（best-of-providers, herdr pane runtime, operator-learning, judgment backends / assist, approval-decision-routing, mesh-router）を接続 or retire。 |
| OW-02 | 未使用 libs/core モジュール約 40 件を接続 or retire。                                                                                                          |
| OW-03 | 起動経路のないスクリプト約 45 件: 運用ツールは CLI 登録、不要なものは retire。                                                                                 |
| OW-04 | 到達不能パイプライン: 定期実行想定は schedule 付与、README 掲載、不要は retire。未使用 fragment の扱い。                                                       |
| OW-05 | 呼び出し元のない actuator op の扱い（接続 / 文書化 / 削除）。                                                                                                  |
| OW-06 | UI 孤立ページ（Chronos /discussion /experience、operator /inbox、presence-studio /ui-gallery /work）と呼び出し元のない API の接続 or 削除。                    |
| OW-07 | 孤立検出チェック（ratchet）を追加し再発防止。                                                                                                                  |
