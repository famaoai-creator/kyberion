---
title: PR前CI準備チェックリスト
kind: runbook
scope: repository
authority: reference
phase: [execution, review]
tags:
  [
    governance,
    pull-request,
    ci,
    validation,
    generated-artifacts,
    testing,
    worktree,
    type-ratchet,
    contract-semver,
    env-registry,
  ]
importance: 9
author: Codex
last_updated: 2026-09-22
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [pull_request, github_actions, origin/main]
status: active
---

# PR前CI準備チェックリスト

PR を開く前の必須 runbook。人間・エージェント共通。PR 作成の手順（コマンドの順序）の正本もこの文書である。
`AGENTS.md`、`CONTRIBUTING.md`、`git-flow-standards.md`、`kyberion-development-practices.md` はここを参照する。

## PR 作成手順（この順で実行する）

```bash
# 0. 専用 worktree で作業する（main checkout や他 agent の worktree では作らない）
git fetch origin
git worktree add -b <prefix>/<topic>-<yyyymmdd> ../kyberion-<topic> origin/main

# 1〜4. 実装・commit のあと、PR 前確認（下の「エージェント必須手順」）
git diff --name-only origin/main...HEAD
pnpm check -- --scope pr

# 5. PR 全体を表すタイトルを決めて検査する
pnpm check:pr-title -- --title "<type>(<scope>): <summary>"

# 6. 本文をテンプレートから作る（一時ファイルは active/shared/tmp/ に置く）
cp .github/PULL_REQUEST_TEMPLATE.md active/shared/tmp/pr-body-<topic>.md
#    → Summary / Type / Area / Test plan（実行したコマンドと結果）/ 該当チェック欄を埋める

# 7. push してから作成する
git push -u origin <branch>
pnpm kyberion pr create \
  --title "<type>(<scope>): <summary>" \
  --body-file active/shared/tmp/pr-body-<topic>.md \
  --no-draft            # レビュー可能な場合。作業途中なら付けずに draft のまま

# 8. CI を最後まで見る
gh pr checks <number> --watch
```

守ること:

- **base は `main`**。PR Validation は base が `main` / `develop` の PR でしか起動しない。別 PR の上に積む
  （stacked）と CI が走らないので、依存先がマージされるのを待って rebase するか、base を `main` にする。
- **`--title` を必ず渡す**。省略すると HEAD commit の件名がタイトルになり、最後の小さな修正 commit が
  PR 名になる。
- **`--body-file` を必ず渡す**。省略すると `gh --fill` で commit 一覧が本文になり、テンプレートの
  Test plan やチェック欄が抜ける。
- **`pnpm kyberion pr create --help` を実行しない**。ヘルプは表示されず、そのまま readiness gate と
  PR 作成が走る。オプションはこの文書で確認する。
- **push を先に行う**。`pr create` は push しない。未 push だと `No commits between main and <branch>` で失敗する。
- **draft がデフォルト**。レビューに出すときは `--no-draft` を付けるか、作成後に `gh pr ready <number>` を実行する。
- **`gh pr create` を直接使うのは例外**。使う場合も手順 1〜6 と 8 は省略せず、`--title` と `--body-file` を渡す。
- **CI の pending を成功と数えない**。macOS smoke などが concurrency で cancel された場合は
  `gh run rerun <run-id> --failed` で再実行し、結果を待つ。
- **レビュー修正は同じ worktree・同じ branch で行う**。マージ後は `git worktree remove` で片付ける。

## エージェント必須手順

実装と差分確認のあと、PR 作成より先に次を完了する。

1. `git diff --name-only origin/main...HEAD`（または PR 対象 base）で変更範囲を列挙する。
2. 下記「例外表」から該当行を選ぶ（該当しない行は実行しない）。
3. 標準コマンドを実行する:

```bash
pnpm check -- --scope pr
```

4. 例外表の追加確認を実行し、生成物 drift があれば同じ commit に含める。
5. push 後は `gh pr checks <number>` で確認し、**pending を pass と数えない**。
6. 未実行 suite・環境依存・既知 failure は PR 本文の Test plan / Evidence に明記する。

`pnpm kyberion pr create`（`scripts/publish_pull_request.ts`）はデフォルトで手順 3 を実行する。緊急回避のみ `--skip-readiness`。エージェントは通常パスで skip しない。

`knowledge/` 配下を 1 ファイルでも変更したら、commit 前に `pnpm generate:knowledge-index` を実行して
`knowledge/_index.md` と `knowledge/_integrity-manifest.json` を同じ commit に含める。忘れると CI の `catalogs` gate が落ちる。

完了条件:

- [ ] `git status --short --branch` と差分一覧で、別作業・秘密情報・生成済み `dist/`・不要な runtime state が混ざっていない。
- [ ] `git diff --check` が成功している。
- [ ] `pnpm check -- --scope pr` が緑。
- [ ] 例外表の該当行が緑（または N/A）。
- [ ] 実装と生成物の変更が同じ commit に含まれている。
- [ ] PR の base が `main`（または `develop`）で、タイトルが PR 全体を表す Conventional Commit になっている。
- [ ] PR 本文がテンプレートに沿い、Test plan に実行したコマンドと結果が書かれている。
- [ ] push 後の `gh pr checks` がすべて pass（pending 待ちは未完了）。

`pnpm check -- --scope pr` は build / typecheck / lint / test matrix の代替ではない。これらは PR workflow が実行するため、ローカルで追加実行した場合だけ実測済みとして記録する。CI failure は job 名・run ID・失敗 step・ログを先に記録し、原因仮説を更新してから修正する。

## 例外表

次の変更だけは、標準手順に加えて該当行を実行する。

| 変更範囲                                              | 追加確認                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge/`、語彙、生成 catalog                      | `pnpm generate:knowledge-index`、`pnpm check -- --scope pr --only catalogs`。語彙／pseudo-locale を変更した場合は対応する generator と `vocabulary-types`／`pseudo-locale` gate も実行する。                                                                                                             |
| actuator manifest、operation、schema、stable contract | `pnpm kyberion sync component-inventory`、`pnpm generate:op-registry -- --check`、必要なら version bump のうえ `pnpm check:contract-semver -- --rebaseline` して baseline を commit。`contract-semver` は PR scope に含まれるが、**rebaseline は自動では走らない**。互換性変更の理由を PR に記録する。   |
| 新規 / 変更 `KYBERION_*`                              | `pnpm generate:env-registry` で登録し、`pnpm check -- --scope pr --only env-registry` を緑にする。                                                                                                                                                                                                       |
| `libs/core` export / actuator 境界の型                | `pnpm typecheck` だけでは足りない。`pnpm --filter @agent/core build && pnpm run build:actuators` で dist 解決の型エラーを先に潰す。                                                                                                                                                                      |
| テストのモック型                                      | 新規 `as any` / `AnyKeyword` は `type-ratchet` で落ちる。`vi.mocked()` や型付きモックに置換する。                                                                                                                                                                                                        |
| pipeline、ADF、governance policy                      | `pnpm pipeline --input pipelines/baseline-check.json`、`pnpm check -- --scope full --only contract-schemas`、`pnpm check -- --scope full --only governance-rules`、`pnpm check -- --scope full --only work-scope-policy`。ADF は `draft → preflight → auto-repair → commit → execute` の境界で確認する。 |
| surface、Intent、TUI、voice                           | `pnpm kyberion smoke intent --output active/shared/tmp/intent-smoke` と変更に対応する focused test。viewer / tenant / tier は client input を認可根拠にしない。                                                                                                                                          |
| dependency、lockfile、install script                  | `pnpm install --frozen-lockfile`、`pnpm check -- --scope pr --only pinned-deps`、`pnpm check -- --scope pr --only install-script-allowlist`、`pnpm check -- --scope pr --only lockfile-commit-gate`。                                                                                                    |
| Node／OS／native capability                           | Cross-OS Smoke の対象 gate と、必要なら `pnpm run build`／該当 suite を実行する。macOS／Windows 固有の結果を Linux の結果で代用しない。                                                                                                                                                                  |
| user-visible behavior                                 | `CHANGELOG.md` の `[Unreleased]` と public terminology を更新し、`pnpm check -- --scope pr --only ux-contract-docs` を確認する。                                                                                                                                                                         |
| 大規模変更、release、CI failure repair                | `pnpm run validate` または `pnpm check -- --scope full` を実行し、全 test suite と未実行項目を PR 本文へ記録する。                                                                                                                                                                                       |

## よく落ちる gate（実測パターン）

| Gate / 症状                | 典型原因                                                   | 直し方                                                                                                              |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `type-ratchet`             | テストや実装に `as any` / `AnyKeyword` を増やした          | `vi.mocked()`・generics・narrowing に置換。baseline を安易に上げない                                                |
| `contract-semver`          | actuator version / schema / ops を変えたが baseline 未更新 | intentional bump なら rebaseline して `scripts/contract-baseline.json` を commit。ついでに component-inventory sync |
| `env-registry`             | コードに新しい `KYBERION_*` を追加したが registry 未更新   | `pnpm generate:env-registry` → curated 説明を埋める → `--check`                                                     |
| `build:actuators` / TS2345 | source path typecheck は通るが dist export 経由で型不一致  | core build 後に `build:actuators`。呼び出し側の型を `GenerationBackend` など実際の公開型に合わせる                  |
| component-inventory drift  | CAPABILITIES / global index が manifest と不一致           | `pnpm kyberion sync component-inventory`                                                                            |

## 失敗時の原則

- 生成物 drift は canonical generator を先に実行し、手編集で manifest や snapshot を合わせない。
- `ERR_MODULE_NOT_FOUND` は build 前提の gate を build 後に再実行する。原因未確認のまま同じコマンドを繰り返さない。
- ローカル pass と CI failure が異なる場合は clean checkout、Node 24、Linux CJK font、macOS／Windows native test、権限・環境変数の差を比較する。
- worktree が混在している場合は、PR 対象を専用 worktree／明示的な path staging に分離し、他作業の変更を取り込まない。

## 参照

- [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [ci-gates.json](./ci-gates.json)
- [PR template](../../../.github/PULL_REQUEST_TEMPLATE.md)
- [Kyberion development practices](./kyberion-development-practices.md)
- [EXTENSION_POINTS.md](../../../docs/developer/EXTENSION_POINTS.md)
