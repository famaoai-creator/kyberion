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
last_updated: 2026-09-17
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [pull_request, github_actions, origin/main]
status: active
---

# PR前CI準備チェックリスト

PR を開く前の必須 runbook。人間・エージェント共通。`gh pr create` でも `pnpm kyberion pr create` でも、ここに書かれた確認を省略しない。

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

完了条件:

- [ ] `git status --short --branch` と差分一覧で、別作業・秘密情報・生成済み `dist/`・不要な runtime state が混ざっていない。
- [ ] `git diff --check` が成功している。
- [ ] `pnpm check -- --scope pr` が緑。
- [ ] 例外表の該当行が緑（または N/A）。
- [ ] 実装と生成物の変更が同じ commit に含まれている。
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
