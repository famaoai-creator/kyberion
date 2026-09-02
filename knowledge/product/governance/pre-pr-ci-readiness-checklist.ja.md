---
title: PR前CI準備チェックリスト
kind: runbook
scope: repository
authority: reference
phase: [execution, review]
tags: [governance, pull-request, ci, validation, generated-artifacts, testing, worktree]
importance: 9
author: Codex
last_updated: 2026-09-02
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [pull_request, github_actions, origin/main]
status: active
---

# PR前CI準備チェックリスト

## 標準手順

通常の PR は、実装と差分確認の後に次の 1 コマンドを実行する。これは manifest に登録された PR gate の正本であり、CI の PR validation と同じ gate 集合を実行する。

```bash
pnpm check -- --scope pr
```

完了条件は、コマンドが全 gate を通過し、次の確認ができることである。

- [ ] `git status --short --branch` と `git diff --name-only origin/main...HEAD` で、別作業・秘密情報・生成済み `dist/`・不要な runtime state が混ざっていない。
- [ ] `git diff --check` が成功している。
- [ ] 実装状況と生成物の変更が同じ commit に含まれている。
- [ ] push 後に `gh pr checks <number>` を確認し、pending を pass と数えていない。
- [ ] 未実行の suite、環境依存の検査、既知の CI failure は PR 本文の Test plan / Evidence に明記している。

`pnpm check -- --scope pr` は build、typecheck、lint、test matrix の代替ではない。これらは PR workflow が実行するため、ローカルで追加実行した場合だけ実測済みとして記録する。CI failure は job 名・run ID・失敗 step・ログを先に記録し、原因仮説を更新してから修正する。

## 例外表

次の変更だけは、標準手順に加えて該当行を実行する。該当しない行は実行しない。

| 変更範囲                                      | 追加確認                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge/`、語彙、生成 catalog              | `pnpm generate:knowledge-index`、`pnpm check -- --scope full --only catalogs`。語彙／pseudo-locale を変更した場合は対応する generator と `vocabulary-types`／`pseudo-locale` gate も実行する。                                                                                                           |
| actuator manifest、operation、stable contract | `pnpm kyberion sync component-inventory`、`pnpm generate:op-registry -- --check`、`pnpm check -- --scope full --only contract-semver`。schema の互換性を変更した場合は baseline 更新理由を PR に記録する。                                                                                               |
| pipeline、ADF、governance policy              | `pnpm pipeline --input pipelines/baseline-check.json`、`pnpm check -- --scope full --only contract-schemas`、`pnpm check -- --scope full --only governance-rules`、`pnpm check -- --scope full --only work-scope-policy`。ADF は `draft → preflight → auto-repair → commit → execute` の境界で確認する。 |
| surface、Intent、TUI、voice                   | `pnpm kyberion smoke intent --output active/shared/tmp/intent-smoke` と変更に対応する focused test。viewer / tenant / tier は client input を認可根拠にしない。                                                                                                                                          |
| dependency、lockfile、install script          | `pnpm install --frozen-lockfile`、`pnpm check -- --scope pr --only pinned-deps`、`pnpm check -- --scope pr --only install-script-allowlist`、`pnpm check -- --scope pr --only lockfile-commit-gate`。                                                                                                    |
| Node／OS／native capability                   | Cross-OS Smoke の対象 gate と、必要なら `pnpm run build`／該当 suite を実行する。macOS／Windows 固有の結果を Linux の結果で代用しない。                                                                                                                                                                  |
| user-visible behavior                         | `CHANGELOG.md` の `[Unreleased]` と public terminology を更新し、`pnpm check -- --scope pr --only ux-contract-docs` を確認する。                                                                                                                                                                         |
| 大規模変更、release、CI failure repair        | `pnpm run validate` または `pnpm check -- --scope full` を実行し、全 test suite と未実行項目を PR 本文へ記録する。                                                                                                                                                                                       |

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
