---
title: "SOP: Multi-Agent Software Development & Review"
category: Governance
tags: [governance, development, review, multi-agent, sop]
importance: 10
author: Ecosystem Architect
last_updated: 2026-06-24
---

# SOP: Multi-Agent Software Development & Review

Kyberion 自体の機能拡張・ソフトウェア機能改修を行う際の標準プロセス。
設計レビュー → 指示書 → エージェント並列タスク → 統合レビュー → 修正 → 蒸留、までを一つのループとして規律化する。
intent ループ（[execution.md](./phases/execution.md) / [review.md](./phases/review.md)）の、自己開発タスク向け特化版。

## 0. 適用判断 (When to use)
全ての変更に重装備を課さない。**比例原則**で構える。
- **フル適用**: 機能拡張・基盤改修・セキュリティに関わる変更・複数レイヤーに波及する契約変更（例: ブラウザ自動化、dispatcher、approval）。CLAUDE.md §2 のミッションゲート条件（5+成果物 / 外部監査対象 / 再実行が見込まれる 等）と整合。
- **簡略 / スキップ**: 軽微なバグ修正・リネーム・ドキュメント・依存更新。並列レビュー艦隊は過剰。
- **規律**: 「動かないものを"完成"として出さない」を担保するためにレビュー工程を挟む。これが本 SOP の存在理由。

## 1. 契約先行設計 (Contract-First Design)
実装前に**指示書＝凍結契約**を固める。型・スキーマ・しきい値を先に確定させ、以降のレイヤーはそれに従う。
- **Action**: 共有型（`*-types.ts`）と JSON スキーマを最初に書き、`check_contract_schemas.ts` に登録する（明示レジストリ方式・自動スキャンではない）。
- **Benefit**: 後工程の型ドリフト（型・スキーマ・実装の不一致）を構造的に防ぐ。今回 `recording_ref` が型に無いまま host が参照していた不整合は、この規律の欠落が原因だった。

## 2. 段階実装 (Phased, Test-Gated Implementation)
一度に全部作らない。1段階ごとにテストで締める（CLAUDE.md §4「change one thing, test immediately」）。
- **Action**: P0(契約) → P1..Pn の順に、各段で `vitest run <該当>` と `tsc --noEmit` を通してから次へ。
- **規律**: 相互依存が強い修正（型→スキーマ→実装→テストに波及する類）は**並列化せず逐次で**行う。並列サブエージェントに振ると壊れる。

## 3. 多エージェント・アドバーサリアルレビュー (Adversarial Review)
実装が一段落したら、独立した観点で**並列に**レビューを振る。
- **次元分割**: security / architecture / UX / operability を別エージェントに。観点を混ぜない。
- **モデル階層化**: 最も難しい次元（security・architecture・整合性バグ探索）は Opus、軽い次元（UX・運用）は Sonnet。
- **収束をシグナルに**: 独立した複数エージェントが同じ所見に別経路で到達したら、それは強い真陽性シグナル。単発指摘より信頼する。
- **必須プロンプト要件（下記 §6 の落とし穴対策を毎回注入）**:
  1. セッションの運用制約を明示注入（**外部公開禁止・結果はテキストで返せ・会社端末/PI 制約**）。サブエージェントは親の制約を継承しない。
  2. 所見ごとに `file:line` の根拠を必須化（構造化出力スキーマ推奨）。「徹底レビュー」を薄い指示で渡すと浅くなり事実誤認を生む。
  3. 実ファイルを読ませる（パッチ要約だけで判断させない）。

## 4. 統合と検証 (Synthesis & Verification)
サブエージェントの主張は**統合前に必ず自分で検証**する。
- **Action**: CRITICAL/HIGH の争点、および tool 使用回数が極端に少ない結果は、自分で `grep`/`Read` して裏取りしてから採用する。
- **規律**: 検証で覆った所見は報告に「訂正」として明記する。誤った所見をそのまま修正に流さない。

## 5. 修正ループ (Fix Loop)
- **順序**: CRITICAL → HIGH → MEDIUM。比例原則で MEDIUM 以下は残課題として明示記録（黙って落とさない）。
- **ゲート**: 各修正後に `tsc --noEmit`（root と `libs/core/tsconfig.json` の両方）＋ `vitest run`。
- **回帰テスト**: CRITICAL/HIGH の修正には回帰テストを必ず追加する。
- **スモーク**: ビルド成果物として動くもの（host・CLI）は typecheck で満足せず、**実バイナリを実行**して確認する。

## 6. 既知の落とし穴 (Mandatory Guardrails)
過去に実際に踏んだ罠。毎回チェックする。
- **制約伝播**: サブエージェントへ運用制約を明示注入（§3-1）。怠ると外部公開等の事故が起きる。
- **品質ばらつき**: Sonnet への徹底レビューは根拠必須化で締める（§3-2）。
- **パッチ欠落**: `git diff HEAD` は**未追跡ファイルを黙って除外**する。パッチ生成前に新規ファイルを `git add -N` するか `git status` 駆動で収集（§7）。
- **二重ビルド**: `@agent/core` は `libs/core/dist/` に独自ビルドを持つ。root `tsc` だけでは barrel が更新されない。`pnpm build`（`build:packages` 含む）か `tsc -p libs/core/tsconfig.json` を併用（[ts-base-stabilization-sop](./ts-base-stabilization-sop.md) と整合）。

## 7. デリバリ (Delivery)
- **方式**: 会社端末・PI 制約により **PR は使わずパッチで授受**（`docs/*.patch`）。
- **Action**: パッチ生成手順 — ①新規/未追跡ファイルを `git add -N` → ②`git diff HEAD -- <files>` → ③`grep -c '^diff --git'` で対象ファイル数を確認し欠落がないか検算。
- **検証同梱**: パッチには「tsc 0 / tests N passed / schema check OK / 実バイナリ smoke」の検証結果を添えて報告する。

## 8. 蒸留 (Review & Distill)
完了後、成功・失敗の学びを `knowledge/` と運用メモリに残す（CLAUDE.md §5・[review.md](./phases/review.md)）。本 SOP 自体も、新たな罠を踏んだら更新する。

## 9. `vault` patch 抽出ルール (No-`rej` delivery)
`vault/` 配下の patch を取り込む、または `origin/main` との差分を patch として外部化する場合は、**`rej` を成果物にしない**。`rej` は「差分抽出の失敗」か「ベース不一致」のどちらかなので、配布物としては不合格とする。

- **基準点を固定する**: patch の元にする base SHA を先に確定する。`origin/main` の更新が入る前提なら、先に fetch して base を記録し、その SHA に対する差分だけを出す。
- **未追跡ファイルは黙って落とさない**: 新規ファイルを patch に含めるなら、`git add -N` か `git diff --no-index /dev/null <file>` で明示的に収集する。`git diff HEAD` だけに頼ると欠落する。
- **1 patch = 1 coherent scope**: 互いに独立した変更を 1 ファイルに束ねない。レビュー不能な巨大 patch は、apply 時の reject を増やす。
- **生成元と適用先を分ける**: patch は `git diff` / `git format-patch` で作り、適用検査は別の clean checkout で `git apply --check` を通す。失敗したら patch を修理せず、ベースを再同期して再生成する。
- **reject が出たら止める**: `patch` や `git apply --3way` で reject が出た時点で、配布用 patch としては失敗。以降は `origin/main` の再取得、未追跡ファイルの明示化、差分の再抽出を行う。
- **ベース差分の粒度を守る**: patch は「今の worktree」ではなく「base SHA からの正味差分」を表す。別ブランチの既存差分や partial apply の残骸を混ぜない。
- **検証を添える**: patch には `git diff --check`、`git apply --check`、関連テスト、必要なら `validate` の結果を添える。`rej` がなくても、検証がなければ採用しない。
