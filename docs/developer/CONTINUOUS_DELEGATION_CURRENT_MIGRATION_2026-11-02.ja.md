---
title: 継続委任を現行charterとVCS actuatorへ統合する
tags: [delegation, onboarding, vcs, governance, migration, review]
last_updated: 2026-11-02
status: implemented_pending_live_validation
---

# 現行基盤への統合

## 基準と旧成果の保全

旧実装の基準は `101b9ad9315f967842fe89189c1693728f267d52`（2026-08-11）。今回の基準は、作業開始時にfetchした `origin/main` の `88ac78e0fbfadecbebe1b564ac620ef35b6f0c50`（2026-11-02）で、間には1,209コミットある。専用branchは `feat/continuous-delegation-current-20261102`、missionは `MSN-DELEGATION-CURRENT-20261102`。

旧checkoutのtracked patchとuntracked archiveを、旧checkout内の `active/shared/staging/delegation-rebase-20261102/` に保存した。SHA256はそれぞれ `5865f8e51196363053288218436dcd29649a8185e68e83ff0d5df7a849bb15d2` と `622a0a36eb39bf2d97aea8f5de9d76c7b86db6e74929577317e9ba071a6ca3f4`。旧ソースや別checkoutの未追跡patchを削除・reset・上書きしていない。

旧版のテスト成功は現行版の適合証拠には使わない。旧diffの一括適用、古い権限モデルの再導入、GitHub直結の別経路追加は行わず、現行コードの不足だけを実装する。

## 対応表

| 要求 | 現行の正本 | 今回の差分 |
| --- | --- | --- |
| 人間の一度の同意と継続委任 | onboarding-authority / accountability-charter-registry / external-operation | 正本を維持。NHI有効化と開発grantを同じ確認にまとめて案内 |
| public / confidential / personal | charter data_tier、scope envelope、tier guard、tenant registry | 明示したsource tier・実行ceiling・正しいperson/tenant・verified private repositoryを照合 |
| 承認済みの操作・対象 | external-operation-target / delegated-execution policy / decision vocabulary | labelを権限にせず、正確なrepo/branch/operationとdecision変更を承認文へ表示 |
| PR・push・merge | vcs-actuator → vcs/publication-host → external-operation → vcs/github | 独自REST transportを移さず、既存経路を利用 |
| 秘密情報 | Grant / credential-allocations / TaskCredentialBinding / SecretReference / secret-introduction | 既存の主体・task・tenant束縛とrotation承認を維持。旧secret brokerを移さない |
| 監査・保持 | EventScope付きaudit chain、forwarder publisher、storage retention catalog | 外部先未定のため既存ローカル監査を維持。旧独自spool/storeを移さない |
| 自律開発の確認ループ | WorkItem / mission executor / artifact review receipt / VCS | 準備済みWorkItemの現在revision・独立review・server必須CI・merge後CIを照合する `development_loop` を追加 |
| 初期設定画面 | Concierge OnboardingAuthorityPanel / owner API / passkey承認 | tier、private destination、開発bundleを既存UIへ追加。別の承認画面やidentity storeを作らない |

## 委任の条件

publicは既存のpublic read / write空配列と互換。personalは本人のperson scope、confidentialは実在する同一tenantのorganization scopeを使う。非公開sourceは、明示したcharter read token、runtime tier/read ceiling、完全一致のprivate destination grant、実repositoryの非公開確認をすべて満たす必要がある。本文をpublicと申告したり、公開用ファイルを渡したりしても、実行scopeを格下げできない。

本文の出所は実ファイルのcanonicalなknowledge/runtime partitionから分類し、worktree間の既存transportでも保持する。shared prefix、group/system registry、存在しないtenant、分類不明のscratchをtenant所有と推測しない。

初期開発bundleは `vcs:pr_create`、`vcs:push`（`agent/kyberion-development`）、`vcs:pr_merge`（`main`）。mainへの直接pushを自動許可しない。候補branchの作成・実装・修復・並行claimは既存WorkItem executorの責任。任意のbranch wildcard権限を新設していない。

## VCS確認ループ

`vcs:development_loop` は既定でdry-run。`pipelines/vcs-development-preflight.json` の `context` に `cwd`、`pr_ref`、`work_item_id`、`review_task_id` を与える。pipeline CLIの `--context` はJSON文字列であり、ファイル名ではない。

独立artifact review receiptのmanifestは、repo、head/base SHA、候補/統合先branch、WorkItem、CI policy digestを固定する。現在のrevisionとserver側の必須check・出所を読み直し、不足・変更・曖昧な証拠では昇格しない。CI pendingは待機、実際の失敗は修復要求として扱う。

このopは、実装済みWorkItemを既存の公開基盤へつなぐ確認処理であり、別のモデル実行hostを導入しない。実装・修復が必要なら既存mission executorの次作業を返す。merge受付やqueue投入を完了とせず、実merge SHAとそのCIを確認する。

## 検証と実運用の境界

既存の認証済みowner同意、実charter保存、NHI有効化、正規VCS境界を使ったhermetic回帰試験を行う。mockしたGitHub metadataやHTTP認証transportはlive成功と区別する。実GitHubの権限変更・保護条件変更・merge、実秘密鍵のrotation、外部監査先の導入は行わない。

旧版の実Seatbelt試験は、現行provider/permission modelの証明として移さない。現行sandbox・credential allocation・WorkItem境界を維持する。外部サービスが決まった後は、既存service/secret/audit拡張点へ接続し、実repoでのcanaryを別途確認する。

利用手順：[外部操作のオンボーディング](../../knowledge/product/orchestration/onboarding-action-authority.md)。
