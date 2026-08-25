---
title: PR前CI準備チェックリスト
kind: runbook
scope: repository
authority: reference
phase: [execution, review]
tags: [governance, pull-request, ci, validation, generated-artifacts, testing, worktree]
importance: 9
author: Codex
last_updated: 2026-08-23
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [pull_request, github_actions, origin/main]
status: active
---

# PR前CI準備チェックリスト

## 目的

PRを出した後に、生成物の取りこぼし・build前提の検査・未実行のテスト・別worktreeの混入を原因としてCI修正を繰り返さないための、公開前の確認順を定める。

この文書は [CONTRIBUTING.md](../../../CONTRIBUTING.md) と [PR template](../../../.github/PULL_REQUEST_TEMPLATE.md) の補助であり、置き換えない。チェック結果はPR本文のTest plan、Evidence paths、Governed data欄へ記録する。

## 使い方

変更を一通り実装したら、次の順で確認する。各コマンドは対象範囲に応じて実行する。失敗したコマンドを原因未確認のまま再実行しない。

1. scope と基準点を固定する。
2. 生成物・snapshot・契約の同期を確認する。
3. build を先に通す。
4. 変更範囲の狭いテストから、CIと同じテスト群へ広げる。
5. 差分とPRのチェック結果を確認してから公開する。

## 0. scope、worktree、基準点

- [ ] `git status --short --branch` で、今回の変更と別作業の変更を分けて把握した。
- [ ] PR用branchは最新の `origin/main` を基準にしている。
- [ ] 混在したworktreeでは、別作業を含めてcommitしない。必要なら clean な専用worktreeを `origin/main` から作る。
- [ ] `git diff --name-only origin/main...HEAD` と `git diff --stat origin/main...HEAD` で、PRに含めるファイルだけを確認した。
- [ ] `git diff --check` が成功した。
- [ ] `.env`、生成済み `dist/`、`active/` のホスト依存状態、gitignored runtime fixtureをPRの根拠にしていない。

確認コマンド:

```bash
git fetch origin main
git diff --name-only origin/main...HEAD
git diff --stat origin/main...HEAD
git diff --check
```

## 1. 生成物・snapshot・catalogの同期

変更した領域に応じて、正本と生成物を同じcommitへ含める。生成コマンドの実行後は、生成された差分が今回の変更だけか再確認する。

| 変更した領域                         | 公開前に確認すること                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge/`、語彙、ユーザー向け文言 | `pnpm run generate:pseudo-locale`、`pnpm run check:pseudo-locale`、`pnpm run generate:knowledge-index`、`pnpm run check:catalogs` |
| vocabulary key / generated type      | `pnpm run generate:vocabulary-types`、`pnpm run check:vocabulary-types`                                                           |
| actuator manifest / operation        | `pnpm sync:component-inventory`、`pnpm run generate:op-registry`、`pnpm run check:op-registry`                                    |
| `agent-profiles/`                    | `agent-profile-index.json` を再生成し、差分を確認する                                                                             |
| `surfaces/*.json`                    | `active-surfaces.json` のsnapshotを同期し、`pnpm run check:governance-rules` を実行する                                           |
| `service-endpoints.json`             | 対応する `service-endpoints/` の正本が存在することを確認する                                                                      |
| actuator manifest / stable contract  | `pnpm run check:contract-semver` を実行し、必要なbaseline更新と理由をPRに記録する                                                 |
| improvement plan / roadmap           | 実装状況とcompletion ledgerを同じ変更で更新する                                                                                   |

最低限のcatalog確認:

```bash
pnpm run generate:knowledge-index
pnpm run check:catalogs
pnpm run check:pseudo-locale
pnpm run check:vocabulary-types
```

`knowledge/` を変更した場合、lint-stagedやcommit hookが `_index.md`、`_integrity-manifest.json` などを追加・更新することがある。commit後にもstaged diffとPR changed-filesを再確認する。

## 2. buildを先に通す

CIの多くのcheckerは `@agent/core` のpackage entrypointや `dist/` を読み込む。検査やテストをbuild前に実行すると、実装不良ではなく `ERR_MODULE_NOT_FOUND` や古い生成物を見て判断することになる。

- [ ] `pnpm install --frozen-lockfile` が成功する（依存関係やlockfileを変更した場合は必須）。
- [ ] `pnpm run build` が成功する。
- [ ] build後に `pnpm run typecheck` が成功する。
- [ ] `pnpm run check:esm`、`pnpm run check:packaging-contract` が成功する。
- [ ] `pnpm run lint` と `pnpm run format:check:ci` が成功する。
- [ ] source treeに `.js`、`.d.ts`、sourceをshadowするbuild artifactがない。

## 3. 変更範囲別のテスト

まず変更したファイルに最も近いテストを実行し、通過後にCIのsuiteへ広げる。

### 通常のcore変更

```bash
pnpm exec vitest run <変更に対応するテスト>
pnpm run test:core
```

coreがtier-guarded pathやmission stateを扱う場合は、CIと同じ環境を使う。

```bash
KYBERION_PERSONA=worker MISSION_ROLE=mission_controller pnpm run test:core
```

### scripts、actuators、integration

```bash
pnpm run test:scripts
pnpm run test:actuators
pnpm run test:integration
```

変更が複数領域にまたがる場合、1つのsuiteだけでgreenと判断しない。CIの `test (smoke)`、`test (core)`、`test (actuators)`、`test (scripts)`、`test (integration)` に対応する証跡を揃える。

### surface / Intent / TUI変更

- [ ] terminal、Slack、Presenceなどの入口が同じIntent Resolution Contractを通ることを確認した。
- [ ] `tenant_slug`、tier、viewer scopeをクライアント入力だけで認可に使っていない。
- [ ] unresolved / clarification、governed shape、approval-ready plan、direct replyの各経路を確認した。
- [ ] provider固有の委譲、mission team handoff、PresenceのA2A直通など、既存の専用経路をshared compilerで壊していない。
- [ ] voice入力、Enter送信、Escキャンセル、非TTY/snapshotの境界を確認した。
- [ ] Intent smokeとsurfaceの関連テストを実行した。

```bash
pnpm run build
pnpm run smoke:intent -- --output active/shared/tmp/intent-smoke
pnpm exec vitest run <surfaceまたはIntentの関連テスト>
```

### pipeline / ADF / governance変更

- [ ] `pnpm pipeline --input pipelines/baseline-check.json` が成功した。
- [ ] ADFを直接実行せず、draft → preflight → auto-repair → commit → executeの契約を確認した。
- [ ] `pnpm run check:contract-schemas`、`pnpm run check:governance-rules`、`pnpm run check:work-scope-policy` を実行した。

## 4. validateとCIの対応関係

広い変更では `pnpm run validate` を実行する。ただし、現行の `validate` はbuild・typecheck・catalog・governance系の検査をまとめたゲートであり、CIの全test matrix（core、actuators、scripts、integration、Cross-OS）を代替しない。

したがって、PR前の最低限の組み合わせは次の通りとする。

```bash
pnpm run validate
pnpm run test
pnpm run test:core
pnpm run test:actuators
pnpm run test:scripts
pnpm run test:integration
```

実行時間や環境制約で全suiteを実行できない場合は、未実行としてPR本文に明記し、CIで確認する対象を隠さない。

## 5. PRを出す直前の最終確認

- [ ] `pnpm run check:pr-title -- --title "<PR title>"` が成功する。
- [ ] commit titleとPR titleがConventional Commitsに従っている。
- [ ] user-visible changeなら `CHANGELOG.md` の `[Unreleased]` を更新した。
- [ ] stable surfaceを変更した場合、`EXTENSION_POINTS.md`を読み、必要なsemver bump / baseline更新を行った。
- [ ] PR templateのMission / Workitem / Evidence / Test planを実際の値で埋めた。
- [ ] staged diffに別作業、秘密情報、compiled artifact、不要なruntime stateがない。
- [ ] commit hook後に `git status`、staged diff、生成物を再確認した。
- [ ] push後に `gh pr checks <number>` で必須checkをすべて確認する。pendingをpassと数えない。
- [ ] CIが失敗した場合、最初にjob名・run ID・失敗step・ログを記録し、原因仮説を立ててから修正する。

## 6. よくある失敗と先回り

| CI症状                               | 先に確認すること                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| pseudo-locale drift                  | `pnpm run generate:pseudo-locale` → `pnpm run check:pseudo-locale`                                                |
| knowledge index / manifest drift     | `pnpm run generate:knowledge-index` → `pnpm run check:catalogs`                                                   |
| `ERR_MODULE_NOT_FOUND` for `dist/`   | buildを最初に実行したか。fresh checkoutでdistを前提にしていないか                                                 |
| scriptsだけ失敗                      | `pnpm run test:scripts` を単独実行し、gitignored runtime queue / fixture依存を除く                                |
| integrationだけ失敗                  | `pnpm run test:integration` と失敗テストのfocused runを実行し、surface delegation / approval / tenant scopeを確認 |
| surfaceの応答がclarificationへ変わる | shared compilerに入る条件とprovider / mission専用委譲の境界を比較                                                 |
| ローカルではpass、CIで失敗           | clean checkout、Node 24、Linux CJK font、macOS SQLite FTS5、Windows native testの差を確認                         |
| PRに不要な変更が混ざる               | `git diff origin/main...HEAD`、dedicated worktree、明示的なpath stagingを確認                                     |

## 完了条件

PR前チェックの完了は「ローカルの一部テストがpass」ではなく、次の証拠が揃った状態とする。

- 対象範囲と `origin/main` との差分が説明できる。
- 正本と生成物が同期している。
- build後の静的検査と対象test suiteが実行済みである。
- 未実行・環境依存・既知の失敗がPR本文に明記されている。
- push後のGitHub Actionsで、必須checkを全件確認している。
