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
last_updated: 2026-10-22
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [pull_request, github_actions, origin/main]
status: active
---

# PR前CI準備チェックリスト

PR を開く前の必須 runbook。人間・エージェント共通。PR 作成の手順（コマンドの順序）の正本もこの文書である。
`AGENTS.md`、`CONTRIBUTING.md`、`git-flow-standards.md`、`kyberion-development-practices.md` はここを参照する。

## PR 作成手順（この順で実行する）

```bash
# 0. 専用 worktree で作業する（main checkout や他 agent の worktree では作らない。`.git` を触るのは mission owner）
git fetch origin
git worktree add -b <prefix>/<topic>-<yyyymmdd> ../kyberion-<topic> origin/main
#    worktree ごとにゼロから用意する（main checkout の node_modules を symlink しない）
(cd ../kyberion-<topic> && CI=true pnpm install --frozen-lockfile && pnpm build)
#    以降の script 実行では依存関係を暗黙に再インストールしない。
#    依存を変更した場合は frozen install を明示的に再実行する。

# 1〜4. 実装・commit のあと、PR 前確認（下の「エージェント必須手順」）
git diff --name-only origin/main...HEAD
pnpm check -- --changed     # pr gate 全部 + 変更パスに該当する full-only gate

# 4.5 ミッション作業なら、学びを同じ PR に入れる（verify → distill → curate → promote --target-root）
#    手順は phases/execution.md の「Ship the learnings in the same PR as the code」。
#    product ドメインの記録だけをこのブランチに commit する（organization / personal は入れない）

# 5. PR 全体を表すタイトルを決めて検査する
pnpm check:pr-title -- --title "<type>(<scope>): <summary>"

# 6. 本文をテンプレートから作る（一時ファイルは active/shared/tmp/ に置く）
cp .github/PULL_REQUEST_TEMPLATE.md active/shared/tmp/pr-body-<topic>.md
#    → Summary / Type / Area / Test plan（実行したコマンドと結果）/ Knowledge / 該当チェック欄を埋める

# 6.5 push 前に preflight を通す（PR は作らない。title 検査 + `check --changed` + Knowledge 検査）
pnpm kyberion pr preflight \
  --title "<type>(<scope>): <summary>" \
  --body-file active/shared/tmp/pr-body-<topic>.md

# 7. push してから作成する（`pr create` も同じ readiness gate を実行する）
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
- **`## Knowledge` 欄を必ず埋める**。Mission ID を書いた PR は、そのミッションの学びの候補を全件
  `promoted` / `rejected` / `routed` のどれかで宣言する。ミッションなしの PR は `none — <理由>`。
  `pr create` は、未解決・未宣言の候補、diff に入っていない昇格記録、`knowledge/confidential/`・`knowledge/personal/`
  配下へのファイル追加（既に追跡済みのファイルの変更は対象外）があると PR を作らない。この検査は `--skip-readiness` でも迂回できない。ミッションの記録が
  main checkout にある場合は、主 worktree を自動で探す（明示するなら `--mission-root <path>`）。
- **`pnpm kyberion pr create --help` を実行しない**。ヘルプは表示されず、そのまま readiness gate と
  PR 作成が走る。オプションはこの文書で確認する。
- **push を先に行う**。`pr create` は push しない。未 push だと `No commits between main and <branch>` で失敗する。
- **draft がデフォルト**。レビューに出すときは `--no-draft` を付けるか、作成後に `gh pr ready <number>` を実行する。
- **`gh pr create` を直接使うのは例外**。使う場合も手順 1〜6 と 8 は省略せず、`--title` と `--body-file` を渡す。
  **ミッション作業の PR では使わない**。Knowledge 検査を通らないため、必ず `pnpm kyberion pr create` で作る。
- **CI の pending を成功と数えない**。macOS smoke などが concurrency で cancel された場合は
  `gh run rerun <run-id> --failed` で再実行し、結果を待つ。
- **外部サービスの quota 失敗はコード失敗と混同しない**。`Code scanning AI findings`（GitHub
  Copilot code scanning）の 402 quota 超過のようなインフラ起因失敗は、diff を直しても緑にならない。
  判別法: ジョブログに quota/billing/rate-limit 系のエラータイプがあるかを確認する。対応は
  (a) クォータ回復を待つ、(b) リポジトリ管理者が必須チェックから一時除外する、のどちらかであり、
  コード側の workaround を書かない。失敗が外部起因だと確認できたら、その旨を PR にコメントして
  追跡しやすくする。
- **レビュー修正は同じ worktree・同じ branch で行う**。マージ後は `git worktree remove` で片付ける。

### worktree と人間承認の継続

`pr create` の readiness / Knowledge 検査は作業中の worktree で実行する。
単独 CLI からの公開では、Git の common directory が同じであることを確認し、元 checkout の
approval-store・本人情報・charter・利用台帳を正本として使う。表示される
`Approval and charter authority: <path>` が承認を操作する場所である。
これらの状態を worktree にコピーしたり、`active/` や `knowledge/personal/` を symlink したりしない。
別の tenant や保存済み scope が混入しないよう、作業元の scope は明示的に引き継ぐ。

baseline の L3 も同じ Git common directory の正本 checkout に本人設定があるかを参照し、
`identity_readiness.governance_root` に参照先を表示する。参照できない場合は
`needs_attention` として復旧先を表示するので、本人設定の不存在と区別する。
`pnpm onboarding authority` は正本 checkout で操作する。worktree から実行した場合は
scope を保った実行コマンドを表示する。`--file` / `--out` は元の絶対パスに固定されるため、
正本外のファイルを別ファイルとして読み替えない。正本の active personal profile 内に計画を置き、
`preview --file <plan> --out <profile>/onboarding/activation-reviewed.json` で保存した
同じ envelope を `request --file <reviewed-file>` に渡す。既存の reviewed file は上書きしない。

mission の本人設定・ライフサイクルは引き続き owner checkout が管理する。
新しい worktree で `Sovereign profile incomplete` が出た場合、同じ人の onboarding / charter を
worktree ごとに作り直さない。作業 worktree にビルド済み runtime を用意したうえで、
既存の owner checkout を明示してライフサイクルを実行する:

```bash
# 作業 worktree から、既存の本人設定と mission 正本を使う
KYBERION_ROOT=<owner-checkout> pnpm mission kickoff <ID> --tier public \
  --goal "<goal>" --success-condition "<observable conditions>"
KYBERION_ROOT=<owner-checkout> pnpm mission record-evidence <ID> <task-id> \
  "<worktree path, source commit, result>" --actor-id <agent-id>
```

コード編集・ビルド・テストでは通常の worktree を使う。`KYBERION_ROOT` を shell 全体に export せず、
owner のライフサイクル操作にだけ付ける。mission evidence に作業 worktree と source commit を記録し、
学びは既存の `memory-promote --target-root <worktree>` で同じ PR に入れる。

承認が必要な場合、ヘッドレス実行でも依頼を保存し、依頼 ID と完全な公開内容の確認先を表示する。
人間がその確認先で repository / head・base の SHA / title / body を確認し、表示された正本 checkout の
人間用ターミナルで `pnpm kyberion approvals --approve <id>` を実行する。その後、作業 worktree で
**同じ `pr create` コマンドを再実行する**。同じ公開内容の依頼は再利用され、コミット・本文・公開先が
変わった場合は別の依頼になる。承認拒否・失効・取り消し・charter の停止条件は引き続き適用される。
人間の TTY 確認をエージェントから代行しない。

有効な charter の repository grant が使える場合も、本文の情報区分は別に判定する。
区分不明の scratch ファイルは、元 checkout に転送しただけでは public にならない。
公開が意図された本文を public の storage floor に置く場合も、その分類は作業元で確定する。
実行結果が不明な場合や既に実行予約がある場合は、GitHub 上の PR の有無を確認してから復旧する。
承認 ID を変えたり worktree を作り直したりして二重実行しない。

### メモリ制約のある環境での同時実行数

`pnpm check -- --changed --jobs 1`（`--scope pr --jobs 1` も同様）で検査を直列に実行できる。`--jobs` は整数 1〜6、
省略時は従来どおり 6。同じ全検査を実行し、判定基準・制限時間・結果順序・失敗時の終了コードは変えない。
PR 作成時も `pnpm kyberion pr create --check-jobs 1 --title "<conventional title>" --body-file <body-file>`
として、公開ヘルパーが実行する readiness 検査に同じ値を渡す（`pr preflight` も `--check-jobs` を受け付ける）。
リソース不足による終了も失敗として扱い、単独検査の成功や `--skip-readiness` で代用しない。

## エージェント必須手順

実装と差分確認のあと、PR 作成より先に次を完了する。

1. `git diff --name-only origin/main...HEAD`（または PR 対象 base）で変更範囲を列挙する。
2. 下記「例外表」から該当行を選ぶ（該当しない行は実行しない。`check --changed` が自動選択する gate は手で `--only` 実行しなくてよい）。
3. 標準コマンドを実行する:

```bash
pnpm check -- --changed              # base は origin/main（無ければ main）。別 base は --base <ref>
# または PR を作らずに PR 作成時と同じ readiness 一式を通す
pnpm kyberion pr preflight --title "<conventional title>" --body-file <body-file>
```

`--changed` は merge-base 以降の commit 済み・未 commit・未追跡ファイルを集め、`pr` gate 全部に加えて
`knowledge/product/governance/ci-gates.json` の `paths`（glob）がいずれかの変更ファイルに一致する
`full` / `release` gate を実行する。追加で選ばれた gate と、一致したファイル・パターンを先頭に表示する。
CI の `lint-and-validate`（`--scope full`）でしか落ちなかった op-registry / governance-rules / catalogs などの drift を
ローカルで先に検出するための仕組みで、`--scope pr` / `--scope full` の意味は変わらない。
`paths` を持たない full gate（`chronos-dom-contrast` は UI build が必要、`audit-continuity` は runtime の監査ログ依存）は
`--changed` では選ばれないので、必要なら `--scope full --only <id>` で実行する。
`pr` scope の `registration-tests` gate は、`tests/` の登録・境界ラチェット（shared-tmp allowlist、mission lookup、
`node:fs` / `child_process` / managed process の allowlist、package boundary など）を実行する。

4. 例外表の残りの追加確認（gate では表現できない手順）を実行し、生成物 drift があれば同じ commit に含める。
5. push 後は `gh pr checks <number>` で確認し、**pending を pass と数えない**。
6. 未実行 suite・環境依存・既知 failure は PR 本文の Test plan / Evidence に明記する。

`pnpm kyberion pr create`（`scripts/publish_pull_request.ts`）と `pnpm kyberion pr preflight`（`scripts/pr_preflight.ts`）は
デフォルトで手順 3 の `pnpm check -- --changed` を実行する（`--base <branch>` を渡すと `origin/<branch>` を base にする）。
`pr preflight` は PR title 検査と、`--body-file` を渡した場合の Knowledge 検査も行うが、gh には触れない。
実装エージェント（または専用の preflight エージェント）は push 前に `pr preflight` を通して自分の push を gate する。
緊急回避のみ `pr create --skip-readiness`。エージェントは通常パスで skip しない。

`knowledge/` 配下を 1 ファイルでも変更したら、commit 前に `pnpm generate:knowledge-index` を実行して
`knowledge/_index.md` を同じ commit に含める。忘れると CI の `catalogs` gate が落ちる。
`knowledge/_integrity-manifest.json` は gitignore 済みのローカル生成物（`pnpm build` が再生成）なので commit しない。

`main` を取り込んだ（merge / rebase）あと、または freshness gate が drift を報告したときは `pnpm kyberion resolve generated` を実行する。
**この 1 コマンドで、CI が drift を検査する生成物をすべて**（op-registry、pseudo-locale、vocabulary-types、pii-rules、CLI reference、capability seams、subagent 定義、provider hooks、env registry、role-assumption reachability、knowledge index）依存順に再生成して stage し、changelog fragment を検証する。個別の `generate:*` を手で順に実行しない。
`--check` は書き込まずに drift したファイルを全件列挙して非 0 で終了する。`.husky/pre-push` が `--check --fast`（約 100 秒かかる role-assumption 解析だけを省略。CI gate では実行される）を実行し、失敗時は修正コマンドを表示する（1 回だけ飛ばすときは `KYBERION_SKIP_PRE_PUSH=1 git push`）。
生成物（`_index.md`、`CONFIGURATION.md`、`env.example`、reachability report）の衝突は手で直さない。
conflict marker が残っていても、このコマンドが index の conflict stage から組み直して再生成する（merge driver は不要）。
`env-registry.json` で同じ entry が両側で別々に変更された場合だけ手で直してから再実行する。
merge driver（`pnpm kyberion resolve install-driver`）は repository owner が一度だけ入れる任意設定で、`pnpm install` は git config を書かない。
GitHub の web 画面は merge driver を使わないので、衝突表示が出たらローカルで `main` を merge してから実行する
（詳細は [kyberion-development-practices §6.1](./kyberion-development-practices.md#61-generated-files-and-merges)）。

完了条件:

- [ ] `git status --short --branch` と差分一覧で、別作業・秘密情報・生成済み `dist/`・不要な runtime state が混ざっていない。
- [ ] `git diff --check` が成功している。
- [ ] `pnpm check -- --changed`（または `pnpm kyberion pr preflight`）が緑。
- [ ] 例外表のうち `--changed` が自動選択しない行が緑（または N/A）。
- [ ] 実装と生成物の変更が同じ commit に含まれている。
- [ ] PR の base が `main`（または `develop`）で、タイトルが PR 全体を表す Conventional Commit になっている。
- [ ] `git log --oneline origin/main..HEAD` がこの作業のコミットだけを含む。別の作業用ブランチから切ってしまうと base が `main` でも無関係なコミット（とその CI 失敗）が PR に混入する — `git rebase --onto origin/main <mix-in の起点>` で切り離す。
- [ ] PR 本文がテンプレートに沿い、Test plan に実行したコマンドと結果が書かれている。
- [ ] ミッション作業なら、学びの昇格記録が同じ PR に入り、`## Knowledge` 欄で全候補を宣言している。
- [ ] push 後の `gh pr checks` がすべて pass（pending 待ちは未完了）。

`pnpm check -- --changed`（`--scope pr` も）は build / typecheck / lint / test matrix の代替ではない。これらは PR workflow が実行するため、ローカルで追加実行した場合だけ実測済みとして記録する。CI failure は job 名・run ID・失敗 step・ログを先に記録し、原因仮説を更新してから修正する。

## 例外表

次の変更だけは、標準手順に加えて該当行を実行する。

**gate で表現できる行は機械化済み**: 各行の `pnpm check -- --scope full --only <gate>`（`catalogs`、`vocabulary-types`、
`pseudo-locale`、`op-registry`、`contract-schemas`、`governance-rules`、`work-scope-policy` など）は、
`ci-gates.json` の gate ごとの `paths` に変更範囲として登録してあり、`pnpm check -- --changed`
（`pr create` / `pr preflight` の readiness gate）が該当ファイルの変更時に自動で実行する。
新しい full-only gate を追加するとき、または gate が読む入力が増えたときは、同じ PR でその gate の `paths` を更新する。
この表に残るのは、生成コマンドの実行（`generate:*`、`sync component-inventory`、`--rebaseline`）、build 順序、
手動確認など、gate の選択だけでは代替できない手順である。

| 変更範囲                                              | 追加確認                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge/`、語彙、生成 catalog                      | `pnpm generate:knowledge-index`、`pnpm check -- --scope full --only catalogs`。語彙／pseudo-locale を変更した場合は対応する generator と `vocabulary-types`／`pseudo-locale` gate も実行する。                                                                                                                                                                                                                   |
| actuator manifest、operation、schema、stable contract | `pnpm kyberion sync component-inventory`、`pnpm generate:op-registry -- --check`、必要なら version bump のうえ `pnpm check:contract-semver -- --rebaseline` して baseline を commit。`contract-semver` は PR scope に含まれるが、**rebaseline は自動では走らない**。互換性変更の理由を PR に記録する。                                                                                                           |
| actuator CLI の失敗応答・terminal capability          | failed/denied の外側応答と one-shot exit code を確認する。pipe fallback の resize は成功にしない。→ [operations-hygiene-runbook §11](./operations-hygiene-runbook.md#11-actuator-failure-receipts-and-terminal-capabilities)                                                                                                                                                                                     |
| 新規 / 変更 `KYBERION_*`                              | `pnpm generate:env-registry` で登録し、`pnpm check -- --scope pr --only env-registry` を緑にする。                                                                                                                                                                                                                                                                                                               |
| `libs/core` export / actuator 境界の型                | `pnpm typecheck` だけでは足りない。`pnpm --filter @agent/core build && pnpm run build:actuators` で dist 解決の型エラーを先に潰す。                                                                                                                                                                                                                                                                              |
| テストのモック型                                      | 新規 `as any` / `AnyKeyword` は `type-ratchet` で落ちる。`vi.mocked()` や型付きモックに置換する。                                                                                                                                                                                                                                                                                                                |
| pipeline、ADF、governance policy                      | `pnpm pipeline --input pipelines/baseline-check.json`、`pnpm check -- --scope full --only contract-schemas`、`pnpm check -- --scope full --only governance-rules`、`pnpm check -- --scope full --only work-scope-policy`。ADF は `draft → preflight → auto-repair → commit → execute` の境界で確認する。                                                                                                         |
| surface、Intent、TUI、voice                           | `pnpm kyberion smoke intent --output active/shared/tmp/intent-smoke` と変更に対応する focused test。viewer / tenant / tier は client input を認可根拠にしない。                                                                                                                                                                                                                                                  |
| dependency、lockfile、install script                  | `pnpm install --frozen-lockfile`、`pnpm check -- --scope pr --only pinned-deps`、`pnpm check -- --scope pr --only install-script-allowlist`、`pnpm check -- --scope pr --only lockfile-commit-gate`。                                                                                                                                                                                                            |
| Node／OS／native capability                           | Cross-OS Smoke の対象 gate と、必要なら `pnpm run build`／該当 suite を実行する。macOS／Windows 固有の結果を Linux の結果で代用しない。                                                                                                                                                                                                                                                                          |
| user-visible behavior                                 | `changelog.d/<short-slug>.md` fragment を追加し（`CHANGELOG.md` は直接編集しない。形式は `changelog.d/README.md`）、public terminology を更新して `pnpm check -- --scope pr --only changelog-fragments` と `--only ux-contract-docs` を確認する。                                                                                                                                                                |
| `.github/workflows`、composite action                 | `pnpm check -- --scope pr --only ci-workflow-contract`（全 job に `timeout-minutes`、PR workflow に `concurrency`、Node 24 系 action、core の二重 build 禁止）。PR で各 suite を流す workflow は 1 つだけにする（`.github/workflows/README.md`）。`tests/` に workflow 文字列を固定した test がないか `grep -rn "actions/" tests` で確認する。→ [operations-hygiene-runbook §1](./operations-hygiene-runbook.md) |
| `active/shared/runtime/` に新しい store を追加        | 同じ PR で `storage-retention-catalog.json` に entry を追加し、`pnpm check -- --scope pr --only runtime-store-retention` を緑にする。hot path で増え続ける ledger を全件読みしない（`readJsonLinesCached`）。→ [operations-hygiene-runbook §2](./operations-hygiene-runbook.md)                                                                                                                                  |
| daemon、常駐 loop、child process                      | in-flight guard、SIGTERM/SIGINT 処理、停止 heartbeat、child の deadline と `'error'` listener を確認する。library は stdout に書かない（`no-console`）。→ [operations-hygiene-runbook §3–§4](./operations-hygiene-runbook.md)                                                                                                                                                                                    |
| テスト追加・変更                                      | 実行後に `active/shared/tmp/vitest-active-leaks.json` が空であること（CI は strict）。host binary 依存は所有 module の probe で skip する。→ [operations-hygiene-runbook §5](./operations-hygiene-runbook.md)                                                                                                                                                                                                    |
| `type-ratchet` の上限に触れる実装変更                 | 先に `prettier --check` を通し、**整形後の行数**で上限に収める（pre-commit hook が整形し直すため、手詰めの行数は無効）。helper 抽出等の正直な縮減で対応し、baseline を安易に上げない。                                                                                                                                                                                                                           |
| golden snapshot に差分が出た変更                      | まずクリーンツリー対照（`git stash -u` → check → `git stash pop`）で環境由来（他セッションの runtime state 等）を証明する。環境由来なら rebaseline しない。意図的な出力変更のみ rebaseline して理由を PR に記録する。                                                                                                                                                                                            |
| モジュール全体に効く状態の新設・変更                  | 影響面を共有する全テストファイルを列挙実行する（例: `grep -rln "process.stderr" --include="*.test.ts"` → `vitest run` で該当全ファイル）。自分の新規テストが緑なのは必要条件。リセットフックは作成だけでなく既存テストの `beforeEach`/`afterEach` への組込み完了を Done 条件にする。失敗模擬（`throw` するモック）を含むファイルは要注意箇所として必ず含める。                                                   |
| `libs/core` の振る舞い変更                            | 変更モジュールを import するテストファイル群をファイル全体で実行する（単体 `it` ではなくファイル全体。順序依存・共有状態の検出のため）。                                                                                                                                                                                                                                                                         |
| mission `evidence/` に書く generator                  | template が `deliverable` として宣言する path に書かない（存在しないときに作るのも禁止）。生成物には別のファイル名を使い、手書き deliverable が byte 単位で残る test を追加する。→ [operations-hygiene-runbook §8](./operations-hygiene-runbook.md)                                                                                                                                                              |
| project / track の lifecycle command・status 更新     | 専用 lifecycle command と汎用 status 更新が同じ guarded facade を通ること、archive からの復帰は明示的な restore だけであることを確認し、`libs/core/project/project-management.test.ts` の lifecycle regression と core + repo CLI の build を通す。→ [operations-hygiene-runbook §9](./operations-hygiene-runbook.md)                                                                                            |
| 大規模変更、release、CI failure repair                | `pnpm run validate` または `pnpm check -- --scope full` を実行し、全 test suite と未実行項目を PR 本文へ記録する。                                                                                                                                                                                                                                                                                               |
| locale 解決・語彙文字列の変更                         | CI と同じ環境 `env -u KYBERION_LOCALE LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=true ./node_modules/.bin/vitest run` でも全 suite を流す（日本語ロケールの開発機は locale 未固定の test を隠す）。→ [multi-branch-audit-delivery-lessons](../orchestration/multi-branch-audit-delivery-lessons.md)                                                                                                                          |     |

### 語彙カタログを変更した場合

文言の変更・キーの追加削除後は、`pnpm generate:vocabulary-types` と
`pnpm generate:pseudo-locale` を実行し、生成された差分も同じPRに含める。
`pnpm check -- --only vocabulary-types,pseudo-locale` で生成物の一致を確認する。
PR scopeには `vocabulary-types` が含まれないため、PR scopeの成功だけでは
型定義の更新漏れを検出できない。上記の追加検査とlocale行の全suite検証を行う。

## よく落ちる gate（実測パターン）

| Gate / 症状                                          | 典型原因                                                                                                                                             | 直し方                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type-ratchet`                                       | テストや実装に `as any` / `AnyKeyword` を増やした                                                                                                    | `vi.mocked()`・generics・narrowing に置換。baseline を安易に上げない                                                                                                                                                                                                                                                                                                                              |
| `governance-import-baseline`（`test (integration)`） | テストやソースが `node:fs` / `child_process` を直接 import するようになったが baseline fixture が未更新                                              | `tests/fixtures/governance-import-baseline.json` にファイルを登録。`node:fs` は `tests/core-fs-exception-boundary.test.ts` `allowedCoreFsImports` にも、`child_process` は `tests/runtime-child-process-boundary.test.ts` にも登録が必要（2箇所セット、[kyberion-development-practices](./kyberion-development-practices.md) 参照）。secure-io / `spawnManagedProcess` で迂回できるならそちらが先 |
| `contract-semver`                                    | actuator version / schema / ops を変えたが baseline 未更新                                                                                           | intentional bump なら rebaseline して `scripts/contract-baseline.json` を commit。ついでに component-inventory sync                                                                                                                                                                                                                                                                               |
| `env-registry`                                       | コードに新しい `KYBERION_*` を追加したが registry 未更新                                                                                             | `pnpm generate:env-registry` → curated 説明を埋める → `--check`                                                                                                                                                                                                                                                                                                                                   |
| `build:actuators` / TS2345                           | source path typecheck は通るが dist export 経由で型不一致                                                                                            | core build 後に `build:actuators`。呼び出し側の型を `GenerationBackend` など実際の公開型に合わせる                                                                                                                                                                                                                                                                                                |
| component-inventory drift                            | CAPABILITIES / global index が manifest と不一致                                                                                                     | `pnpm kyberion sync component-inventory`                                                                                                                                                                                                                                                                                                                                                          |
| CodeQL（PR の code scanning）                        | 変更行のアラートだけが出る。sink を移すと既存アラートが「新規」になる。汎用 `safeExec*` に `sh`/`bash`/`cmd` + `-c` を渡すと全呼び出し元が指摘される | 手元の CodeQL CLI でテストを含めて解析して確かめる。シェル実行は `safeExecShellScript*` を使う。移動しただけの既存アラートは根拠を書いて扱いを決める                                                                                                                                                                                                                                              |

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

Dot 実行の変更では、[タイムアウト後の副作用所有権と実行順の継続](./operations-hygiene-runbook.md#13-timed-out-effects-and-executor-continuation)を維持し、隔離した遅延書き込みとプロセス再起動の評価証跡を残す。
