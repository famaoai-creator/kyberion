---
title: VCS host API seam の設計 (gh CLI 依存の抽象化)
tags: [design, seam, vcs, github, distributed-runtime]
last_updated: 2026-11-07
kind: design
status: completed
---

# VCS host API seam の設計

基準は `4ab333ad7` (2026-11-04)。[seam 共通化](../SEAM_LIFECYCLE_CONSOLIDATION_2026-11-03.ja.md)
と `vcs-backend` seam (`libs/core/vcs/vcs-backend.ts`) を継承する。
#1390 の抽象化レビューで「GitHub API backend は command-runner seam に合わない」として
別設計に切り出した項目の設計である。

## 結論

`vcs-backend` に GitHub API provider を足すのではなく、**host 操作 (PR・checks・
repository metadata) の typed-verb seam `vcs-host` を新設する**。`vcs-backend` は
「git の argv をどこで実行するか」に限定したまま残す。

## 現状の調査結果

| ID    | 確認した事実                                                                                                                                                                                                                                        | 帰結                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VH-01 | `VcsBackend.run(command, args, options)` は **同期**で `VcsCommandResult` (stdout/stderr/status) を返す契約。                                                                                                                                       | HTTP は非同期。REST 呼び出しを同期 argv envelope に押し込むには `Atomics.wait` 等のブロッキングが要り、`fidelity` trait (git CLI と byte 一致) も満たせない。     |
| VH-02 | `github.ts` の gh 系関数 (`ghRun`/`ghPrView`/`ghPrList`/`ghPrChecks`/`ghPrMerge`/`ghPrCreate`/`ghRepositoryVisibility` など 9 箇所) の既定 runner は `safeExecResult` で、`vcsDefaultRunner` ではない。`ghMust` は `safeExec('gh', …)` を直接呼ぶ。 | **gh 操作は現在 `vcs-backend` seam を一切通っていない**。git verb (14 箇所) だけが seam 経由。                                                                    |
| VH-03 | 呼び出し側は `publication-host.ts`、`development-proof.ts`、`mission-development-continuation.ts`、`vcs-actuator/vcs-helpers.ts`、`system-pr-lifecycle.ts`、`scripts/pr_shadow.ts`、`scripts/publish_pull_request.ts`。                             | 公開関数のシグネチャを保てば呼び出し側は無変更で移行できる。                                                                                                      |
| VH-04 | 統治は verb 層にある: `governVcsCommand('vcs:pr_merge' …)` の effect snapshot と hash 再照合 (`VCS_SNAPSHOT_CHANGED`)、`--match-head-commit`、`expectedHeadSha`、approval artifact (`publication-host.ts`)、`sanitizeGhOutput`。                    | provider を差し替えても、承認・effect binding・出力 sanitize は provider の **外側** に残す必要がある。                                                           |
| VH-05 | `runExternalOperation` (async) は `governance/external-operation.ts` に既にある。`secureFetch` は egress policy、`authenticateRequest`、local-network 拒否を持つ。                                                                                  | 非同期 host verb を統治する部品は揃っている。新しい認可経路は不要。                                                                                               |
| VH-06 | `vcs-backend.json` に `remote_execute` purpose が「VCS host API or remote executor」として宣言されている。`vcs-backend.ts` の doc comment に「libgit2/github-api later」とある。                                                                    | 宣言が実際の境界とずれている。host API は `vcs-host` に移し、`remote_execute` は remote executor (別ノードの checkout で git を走らせる) だけを指すよう書き直す。 |

## 境界

```
caller (publication-host / actuators / scripts)
  │  ghPrCreate / ghPrMerge / ghPrView / ghPrChecks …   ← 公開 API は維持 (facade)
  ▼
vcs-host verb 層 (libs/core/vcs/vcs-host-verbs.ts)
  │  引数検証 (assertNotFlagLike, cwd scope) / effect 構築 / snapshot 再照合
  │  governVcsHostOperation(operationId, effect, execute, mutation)  ← 既存 operationId を維持
  │  出力 sanitize (sanitizeGhOutput 相当を全 provider の error/text に適用)
  ▼
VcsHostProvider (seam: vcs-host, resolve-one)
  ├─ gh-cli       … 既存 github.ts の gh 呼び出しを移設。既定。挙動は byte 一致。
  ├─ github-rest  … secureFetch + 登録済み GH_TOKEN/GITHUB_TOKEN。gh バイナリ不要。
  ├─ memory       … hermetic test 用 fixture。既定 chain に入れない。
  └─ (gitlab / forgejo は後続。provider 追加のみで verb 層は無変更)
```

`vcs-backend` (git argv の実行場所) と `vcs-host` (forge の API) は直交する。
ローカル git + GitHub REST、remote executor + gh CLI のような組合せを許す。

## 契約

```ts
export const VCS_HOST_SEAM = 'vcs-host';

export interface VcsRepositoryRef {
  slug: string; // owner/name
  url: string; // canonical https URL (既存 ghPrRepository と同じ正規化)
  host: string; // github.com / GHES hostname
}

export interface VcsHostProvider {
  readonly id: string;
  /** この runtime で使えるか (gh バイナリ有無 / token 登録有無)。安価・同期・副作用なし。 */
  isAvailable(ctx: VcsHostCallContext): boolean;
  /** 認証が通るか (gh auth status / GET /user)。diagnose 用で選択には使わない。 */
  authStatus(ctx: VcsHostCallContext): Promise<VcsHostAuthStatus>;

  // read
  repository(ctx): Promise<VcsRepositoryRef>; // cwd は ctx に含む
  commitSha(ctx, repo, ref: string): Promise<string>; // PR source/base の remote 照合用
  defaultBranch(ctx, repo: VcsRepositoryRef): Promise<string>;
  visibility(ctx, repo: VcsRepositoryRef): Promise<'public' | 'private' | 'internal'>;
  prView(ctx, repo, ref: string): Promise<VcsPullRequestSnapshot>;
  prList(ctx, repo, filter: VcsPrListFilter): Promise<VcsPullRequestSummary[]>;
  prChecks(ctx, repo, ref: string): Promise<VcsPrChecksResult>;
  prQueued(ctx, repo, number: number): Promise<boolean>;

  // mutation — 統治済みの execute クロージャ内でのみ呼ばれる
  prCreate(ctx, repo, input: VcsPrCreateInput): Promise<VcsPrCreateResult>;
  prMerge(ctx, repo, input: VcsPrMergeInput): Promise<VcsPrMergeResult>;
}
```

- **typed result**: provider は stdout 文字列ではなく正規化済みの値を返す。`gh-cli` は
  既存の `--json` 出力 parse を provider 内に閉じ込める。verb 層は JSON parse をしない。
- **エラー**: provider は `VcsHostError { code: 'auth' | 'not_found' | 'conflict' |
'rate_limited' | 'stale_head' | 'unavailable' | 'invalid'; message }` を throw する。
  verb 層が `diagnoseGhResult` 相当の診断と `[VCS_GH_FAILED]` 系メッセージに変換し、
  既存の `ghMust` 呼び出し側が見るエラー文字列の接頭辞を維持する。
- **`VcsPrMergeInput.expectedHeadSha` は必須**: gh-cli は `--match-head-commit`、
  github-rest は `PUT /pulls/{n}/merge` の `sha` で、head 不一致時に host 側で拒否させる
  (VH-04 の不変条件を provider 契約に格上げ)。
- **credential**: `ctx.env` は verb 層が登録済み env (`GH_TOKEN`/`GITHUB_TOKEN`) から
  組み立てる。provider が `process.env` を直接読むことは禁止 (既存 `ghExecOptions` と同じ)。

## 同期 → 非同期の移行

VH-01 が最大の制約で、gh 系公開関数は現在すべて同期。

1. **段階 1 (挙動不変)**: `vcs-host` seam と `gh-cli` provider を追加し、同期公開 API
   (`ghPrCreate` など) は従来どおり `safeExecResult` 経路で動かす。並行して async の
   `vcsHost.prCreate()` などを追加し、新規コードは async を使う。
2. **段階 2**: 呼び出し側 7 箇所を async verb へ移す。`publication-host.ts` は
   `runExternalOperationSync` → `runExternalOperation` に移行する。CLI entry
   (`pr_shadow`, `publish_pull_request`) は既に async main を持つため影響は局所的。
   actuator は ADF op handler が async を許すか確認したうえで移す。
3. **段階 3**: 同期 gh 関数を deprecated の thin wrapper にし、`gh-cli` provider 経由だけが
   残ることを AST check で強制する (`safeExec('gh'` / `run('gh'` の直接呼び出しを
   `libs/core/vcs/gh-cli-host-provider.ts` と同期 `github.ts` 以外で禁止)。

同期 API の上で REST を同期実行する経路は作らない (ブロッキング I/O と timeout 管理の
二重化を避ける)。`github-rest` は段階 2 以降の async 呼び出し側でだけ選べる。

## 選択ポリシー

`seam-provider-selection/vcs-host.json` (新規、index.json に登録)。

| provider      | fidelity | zero_config | headless | 備考                                                |
| ------------- | -------- | ----------- | -------- | --------------------------------------------------- |
| `gh-cli`      | 1        | 1           | 0        | 既存挙動。gh バイナリと auth が必要。               |
| `github-rest` | 0.9      | 0           | 1        | token 登録が必要。container / remote runtime 向け。 |
| `memory`      | 0        | 1           | 1        | test 専用。default chain 外。                       |

- `default_chains.default = ["gh-cli", "github-rest"]`。`isAvailable()` が真の最初の
  provider を使う (gh-cli は `gh --version` を process 内で 1 回だけ確認、github-rest は token
  登録の有無)。どれも使えなければ fail-closed (`[VCS_HOST_UNAVAILABLE]`)。
  ネットワークを伴う `authStatus()` は選択に使わない。
- 明示指定は呼び出しの `provider` option、運用者の既定は既存の `KYBERION_SEAM_DEFAULTS`
  (`vcs-host=github-rest`)。新しい env は追加しない。明示指定は egress policy や approval を緩めない。
- `vcs-backend.json` の `remote_execute` purpose の説明から「VCS host API」を削除し、
  `vcs-backend.ts` の doc comment の「github-api later」を `vcs-host` への参照に置き換える (VH-06)。

## 統治の不変条件 (受入条件)

| ID    | 条件                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VH-A1 | operationId (`vcs:github:read` / `vcs:pr_create` / `vcs:pr_merge`) と effect の形は provider に依らず同一。approval hash は provider 切替で変わらない (provider id は effect に入れない)。 |
| VH-A2 | merge は承認時の snapshot を execute 直前に再取得して hash 照合し、さらに host 側の head 一致条件を必ず付ける。どちらかが欠ける provider は登録時に拒否する。                              |
| VH-A3 | provider が返す全テキスト (PR body の echo、error message) は verb 層で sanitize されてから log・artifact・CLI 出力に出る。                                                                |
| VH-A4 | `github-rest` の通信は `secureFetch` 経由のみ。local-network 上の GHES は `secureFetch` が拒否する (opt-in は未実装・スコープ外)。                                                         |
| VH-A5 | token は登録済み env からのみ取得し、request header 以外 (URL・effect・trace・audit) に現れない。trace exporter には provider id と status だけを渡す。                                    |
| VH-A6 | `memory` provider は builtin 登録されず default chain にも入らない。test が明示登録したときだけ選択できる。                                                                                |
| VH-A7 | 同じ fixture に対する `gh-cli` と `github-rest` の正規化結果が一致する契約テストを 1 本の suite で両 provider に流す (`memory` は fixture 供給元)。                                        |

## readiness との接続

#1390 の `runtime-readiness-check` seam に `vcs-host` check を **登録しない**。forge の
可用性はランタイムの ready 条件ではない (PR を作らない runtime も ready であるべき)。
provider ごとの認証確認は `vcsHostAuthStatus()` で取得できる。`pnpm doctor` への表示は未実装 (doctor が
ネットワーク probe を伴うため、表示形式と test の hermetic 化を別途決める)。

## スコープ外

- GitLab / Forgejo provider の実装 (契約が host 非依存であることだけを本設計で保証する)。
- issue / release / comment 操作。現在の呼び出し側が使っていないため verb を追加しない。
- mission repo (`mission-git.ts`) の扱い。`vcs-backend` 同様この seam の対象外。

## 実装状況

| 段階 | 内容                                                                                                                                                                                                                                                                                                                                                                    | 状況 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1    | 契約・registry (`vcs-host.ts`)、`gh-cli` provider、登録手続き一式 (SEAM_ROLES、bindings、exports、policy + index、changelog.d、CAPABILITY_SEAMS.md)                                                                                                                                                                                                                     | 完了 |
| 2    | `memory` provider と VH-A7 契約テスト (`vcs-host.test.ts`: gh-cli と github-rest の正規化一致)                                                                                                                                                                                                                                                                          | 完了 |
| 3    | async verb (`vcs-host-verbs.ts`) と `github-rest` provider。VH-A1 (sync 経路と effect 完全一致)・A2・A3・A5 のテスト                                                                                                                                                                                                                                                    | 完了 |
| 4a   | 契約に収まる呼び出し側の移行: `system-pr-lifecycle` (checks + auto-merge)、vcs-actuator `pr_list` / `pr_checks` (watch 含む) / `repo_view`、mission development continuation の PR 照合。`vcsHostPrChecksWait` と provider 注入 (`hostProvider`) を追加                                                                                                                 | 完了 |
| 4b   | 残りの呼び出し側を移行: vcs-actuator `pr_view` (`prFields`, `VCS_PR_FIELDS` に限定)、`pr_shadow` (`PrReadPort` を async 化)、`development-proof` / `development-loop` (allowlist 付き `githubApiGet` 能力を追加して async 化)、`publication-host.ts` / `governance-host.ts` / `publish_pull_request` (approval host を async 化、認証 preflight は `vcsHostAuthStatus`) | 完了 |
| 5    | 同期 gh 関数の deprecate と AST check (`vcs-host-boundary`)                                                                                                                                                                                                                                                                                                             | 完了 |

段階 4b で契約に `prFields` (gh `--json` 名と形状、`VCS_PR_FIELDS` に限定) と任意能力 `githubApiGet`
(`repos/{slug}/` 配下の reviewed allowlist、dot segment と percent-encoded dot は拒否) を追加した。
同期 approval host は AsyncLocalStorage ベースの context だけで構成されているため、そのまま async に移した。
`gh_status` は gh CLI 自体の診断なので移行対象外 (provider 診断は `vcsHostAuthStatus()`)。

段階 1 では既存 `github.ts` の関数本体を移さず、同期 verb をそのまま残した。段階 5 では当初の
「同期 verb を async verb の thin wrapper にする」案を採らなかった。同期関数から async verb を呼ぶには
`Atomics.wait` 等のブロッキングが要り、VH-01 で退けた問題がそのまま戻るためである。代わりに次の形で閉じた。

- 同期 verb (`ghRun`/`ghMust`/`ghPrView`/`ghPrList`/`ghPrChecks`/`ghPrChecksWait`/`ghPrMerge`/`ghPrCreate`/
  `ghPrQueued`/`ghRepoDefaultBranch`) に `@deprecated` を付け、本番コードの呼び出しを 0 にした。
  async verb との effect 一致テスト (VH-A1) の基準として、テストからの参照だけを残す。
- `vcs-host-boundary` gate (`scripts/check_vcs_host_boundary.ts`, pr scope) が AST で次を拒否する:
  allowlist 外での `'gh'` リテラルを第 1 引数に取る exec 呼び出し、`github.ts` 外の本番コードからの
  deprecated 同期 verb の参照。allowlist (`github.ts`、`gh-cli-host-provider.ts`、`gh copilot` の
  provider-discovery、`gh` の有無を見る actuator-capability) は、該当しなくなった項目を stale として報告する。
- 同期のまま残す関数は 3 つ。`ghVersion`/`ghAuthStatus` は `gh_status` の CLI 診断、
  `ghRepositoryVisibility` は同期の `gitPush` と onboarding grant 作成が使う可視性 probe である。
  `gitPush` の async 化は呼び出し側が広いので本設計の範囲外とする。
- 変数に入れたコマンド名 (`safeExec(bin, …)`) は gate の対象外。リテラル以外の exec は
  role-assumption-reachability gate が unresolved site として別に数える。
