---
title: KNOWLEDGE IN PR PLAN 2026 09 30
tags: [improvement-plan, 2026-09, governance, mission, knowledge, distillation, pull-request]
last_updated: 2026-09-30
status: active
---

# ミッションの学びをコードと同じ PR に含める(KL-01〜KL-07)

> 優先度: P1 / 規模: M / ミッション: `MSN-KNOWLEDGE-IN-PR-20260930`
> 関連: [review.md](../../../knowledge/product/governance/phases/review.md), [execution.md](../../../knowledge/product/governance/phases/execution.md), [pre-pr-ci-readiness-checklist](../../../knowledge/product/governance/pre-pr-ci-readiness-checklist.ja.md), [mission-kickoff-playbook](../../../knowledge/product/orchestration/mission-kickoff-playbook.md)
> **起票日**: 2026-09-30
> **状態**: ACTIVE(alignment 済み)

---

## 0. 結論

ミッションの学び(distill → curate → promote)を **PR の前** に行い、product ドメインの昇格記録を **コードと同じ PR** に含める。PR レビューを steward 審査とみなし、`finish` 時に記録が `origin/main` に入っていることを確かめて確定する。移行は段階導入せず、`pnpm kyberion pr create` の検査は最初からブロッキングにする(警告期間は負債になるため)。

## 1. 背景と現状の問題

| 観点         | 現状                                                                                                               | 問題                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 順序         | `execution.md` は PR/merge → `verify` → `distill` → `finish`                                                       | 学びは PR 後に回り、後回し・未昇格が常態化する   |
| 昇格の実態   | 804dd0bc1 のように、後から学びだけの PR を手作業で出している                                                       | コードとナレッジの時点がずれ、レビューも通らない |
| 承認         | `memory-approve` は実装者本人でも承認でき、`decided_by` は形式検査のみ                                             | curation ゲートの独立性がない                    |
| 書き込み先   | ミッションとキューは作成した checkout の `active/` にあり、`memory-promote` はその checkout の `knowledge/` に書く | 作業用 worktree のブランチに記録が入らない       |
| PR 作成      | `pr create` は `pnpm check -- --scope pr` だけを実行し、ミッションを知らない                                       | 学びの扱いを確認する場所がない                   |
| テンプレート | Coordination に Mission ID はあるが、学びの欄がない                                                                | 宣言の場がない                                   |

## 2. 新しい順序

```
実装 → verify → distill → curate / approve(--approval-channel pr_review)
     → memory-promote --target-root <worktree>(product のみ)→ ブランチに commit
     → pnpm kyberion pr create(Knowledge 検査)→ PR レビュー = steward 審査 → merge
     → finish(昇格記録が origin/main にあることを確認して ratify)
```

- `verify` は delivery タスクの完了を要求しないため、PR 前に実行できる(`libs/core/mission/mission-lifecycle.ts` の `verifyMission`)。
- `memory-promote` はミッションの状態を見ないため、`finish` 前でも実行できる。
- organization / personal ドメインの学びは従来どおりの経路で扱い、**PR には絶対に含めない**(tier の漏洩)。

## 3. タスク

### KL-01 手順書の並び替え

`execution.md`、`review.md`、`pre-pr-ci-readiness-checklist.ja.md`、`mission-kickoff-playbook.md`、`wisdom-policy-guide.md` を新しい順序に揃える。

- distill と promote を PR 前に移す。
- PR に入れてよいのは product ドメインだけと明記する。
- PR レビュー = steward 審査、`finish` = ratify の役割分担を書く。
- merge 後に出た学びは、小さな後追い PR で扱う。

### KL-02 PR テンプレートに Knowledge 欄

`.github/PULL_REQUEST_TEMPLATE.md` に `## Knowledge` 欄を追加する。ミッションの各候補について、次のどれにしたかを 1 行で書く。

- `promoted: <candidate_id> → <path>`
- `rejected: <candidate_id> — <reason>`
- `routed: <candidate_id> → organization|personal`(PR には含めない)
- `none — <reason>`(ミッションなしの PR、または学びがない場合)

### KL-03 `pr create` の Knowledge 検査(ブロッキング)

`scripts/publish_pull_request.ts` に検査を追加する(ロジックは `libs/core` 側の純粋関数にする)。

1. `--body-file` の Coordination 欄から Mission ID を読む。空欄(ミッションなしの PR)なら、Knowledge 欄があることだけを確認する。
2. ミッション記録の root を解決する。
   - `--mission-root` を指定されていればそれを使う。
   - 指定がなければ、現在の root を探し、見つからなければ `git worktree list --porcelain` の主 worktree を探す。
3. `source_ref === mission:<ID>` の候補を読み、次のいずれかで失敗させる。
   - 候補が 1 件もない(distill 未実行)
   - `queued` または `approved` のまま残っている product 候補がある
   - `promoted` なのに、`promoted_ref` のファイルが `git diff origin/main...HEAD` に含まれていない
   - 候補の ID が本文の Knowledge 欄に書かれていない
   - diff で `knowledge/confidential/` または `knowledge/personal/` 配下にファイルが追加されている(漏洩。既に追跡済みのファイルの変更は対象外)
   - 宣言の種類が候補の状態と一致しない、または `promoted:` のパスが `promoted_ref` と一致しない
4. 検査をスキップするフラグは作らない。`--skip-readiness` も Knowledge 検査は迂回しない。

CI の `pr` スコープの gate には入れない。CI には `active/` のミッション記録が存在しないためで、この検査はローカルの `pr create` 専用とする。

### KL-04 PR レビューを承認とする(`approval_channel: pr_review`)と finish での ratify

- `memory-approve` に `--approval-channel pr_review|steward` を追加し、候補に記録する(既定は `steward` で、従来と同じ動作)。
- `memory-candidate.schema.json` に次の項目を追加する: `approval_channel`、`ratified_at`、`ratified_commit`、`ratification_target`(`origin/main`)。
- `finishMission` の memory ステップ: `approval_channel === 'pr_review'` で `promoted` の候補について、`git cat-file -e origin/main:<promoted_ref>` で存在を確認する。
  - 存在する場合は `ratified_at` と `ratified_commit`(origin/main の sha)を記録する。
  - 存在しない場合は finish をブロックし、次の案内を出す。「`git fetch` 後に再実行。PR で記録を削った場合は `memory-reject`」。
- ネットワークにはアクセスしない(fetch はユーザーの責務)。

### KL-05 promote の書き込み先指定と出どころの記録

- `memory-promote` / `memory-promote-pending` に `--target-root <path>` を追加する。
  - 対象は同じリポジトリの worktree に限る(`git rev-parse --git-common-dir` が一致すること)。
  - 記録ファイルは対象 root 配下に書く。キューと候補の状態はミッション側の root に残す。
- 昇格記録(generated record の JSON と Markdown の frontmatter)に `source_branch` と `source_commit` を追加する。どちらも対象 root の HEAD から取得する。
- 根拠パス(`active/missions/...`)は従来どおり残す。PR 内では git の履歴が出どころの役割を担う。

### KL-06 テスト

- KL-03: 検査関数の単体テスト(候補の状態、diff、本文の解析、漏洩の各パターン)と、`publish_pull_request.test.ts` の配線テスト。
- KL-04: `approval_channel` の保存と、finish での ratify(存在する場合と存在しない場合)。
- KL-05: `--target-root` の検証(別リポジトリを拒否する)と、`source_branch` / `source_commit` の出力。
- 各テストは一時 git リポジトリを使うハーメティックなものにする。

### KL-07 自己適用

この計画を届ける PR 自体を、新しい順序で出す。`MSN-KNOWLEDGE-IN-PR-20260930` の distill → curate → promote で得た product の学びを、同じ PR に含める。

## 4. 非対象

- CI 上で Knowledge 欄を検証する gate(ミッション記録を参照できないため)。
- 過去の `knowledge/product/evolution/distill_*.md` の移行。
- organization / personal ドメインの昇格経路の変更。

## 5. 状態

| ID    | 内容                                | 状態           |
| ----- | ----------------------------------- | -------------- |
| KL-01 | 手順書の並び替え                    | 実装済み(PR)   |
| KL-02 | PR テンプレートの Knowledge 欄      | 実装済み(PR)   |
| KL-03 | `pr create` の Knowledge 検査       | 実装済み(PR)   |
| KL-04 | pr_review 承認と finish での ratify | 実装済み(PR)   |
| KL-05 | `--target-root` と出どころの記録    | 実装済み(PR)   |
| KL-06 | テスト                              | 実装済み(PR)   |
| KL-07 | 自己適用                            | この PR で適用 |
