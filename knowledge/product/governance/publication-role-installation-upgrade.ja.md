---
title: PR publication store の明示的な installation catalog 更新
tags: [governance, organization, roles, pr-publication, operations]
last_updated: '2026-10-22'
---

# PR publication store の installation catalog 更新

関連 worktree の新しいコードが canonical installation の古い policy を読む場合、未登録 role は拒否される。この拒否を capability の自動付与で回避しない。既存の charter、identity、approval、tenant registry は canonical installation に保持する。

## Preview と人の承認

新しいコードと同じ Git common directory に属する、build 済み worktree を source に指定する。canonical installation を `KYBERION_ROOT` とする organization facade から実行する。

これは installation 全体の保守手続きであり、保存された UI の tenant/project 選択は引き継がない。明示的な環境変数による tenant/org/project/mission/task 指定、実行中の scope envelope・resource ceiling・delegation・human execution・external operation・plugin の制約がある呼び出しは拒否する。別の unscoped operator process から行い、制約を消して scoped execution の中から広域化してはならない。

```sh
pnpm organization role migrate-publication-store --source-root <built-worktree>
```

Preview はファイルを変更しない。差分の本文、before/after SHA256、`digest`、`requestedEffect` を確認する。対象は `notification_preferences_reader`、`tool_runtime_policy_reader`、`person_charter_store`、`pr_publication_store` の role card、security-policy の対象 role permission、authority-role-index の対象 entry、role-assumption-policy の shared core role 登録に限定する。通知先と tool availability の読み取りは、承認要求を人に届ける既存の実行経路で必要になる。

terminal channel の authenticated human approval を取得する。`accountability.finalDecision` は `human_only`、`justification.requestedEffects` は preview の `requestedEffect` と全 `changes[].path` を、それぞれ完全一致する文字列として含める。agent が人の判断を代行して承認してはならない。

次のコマンドで、確認した preview を添付した pending human request を canonical store に作成する。この操作は catalog を変更しない。

```sh
pnpm organization role migrate-publication-store --source-root <built-worktree> --request-approval --expected-digest <reviewed-digest>
```

出力された approval id を人が authenticated surface で承認してから、同じ digest と承認 id で apply する。

同じ requester・preview digest・変更パス・protected review の内容を持つ有効な pending request は再利用する。承認済みの有効な human decision が一致する場合は `ready_to_apply` として同じ id を返す。期限切れ・失敗・別スコープ・別 payload の request を再利用しない。full preview は personal/shared の evidence artifact に保存し、共有承認レコードには変更パスと hash、protected artifact への参照だけを記録する。

```sh
pnpm organization role migrate-publication-store --source-root <built-worktree> --apply --expected-digest <reviewed-digest> --approval-id <human-approval-id>
```

Apply は最新 preview と digest を照合し、既存の異なる定義・明示的な deny・空の既存 grant の上書きを拒否する。source の role card と index、schema、shared role 登録を照合する。無関係な policy entry や system-role ごとの may_assume は保持する。apply の前後に hash 付き audit を記録する。

## 運用上の確認

Apply は catalog の変更前に canonical approval store へ一回限りの application claim を永続化し、成功・失敗の結果を保存する。途中失敗や receipt の記録失敗でも claim は解除しない。後で catalog を元の bytes に戻して同じ digest を再現しても、古い approval で権限を再付与できない。必要な再実行は実ファイルと claim/result を確認し、新しい human approval を取得する。

Apply は installation catalog の保守作業として実施する。同時に `organization role create/promote`、role catalog の生成・同期、手動 policy 更新を行わない。migration 同士は lock で直列化し、各ファイルの書き込み直前にも before hash を照合するが、既存の全 catalog writer が共通 lock を使用しているわけではない。

更新前は未登録 role の拒否を維持する。更新後も PR publication runtime の対象リソース制限と、canonical approval の認証・一回の effect・replay 拒否を確認する。catalog 更新は PR 作成の承認を兼ねない。

個々のファイル書き込みは atomic だが、複数 catalog 全体は単一 transaction ではない。途中失敗では audit と実ファイルを確認し、再度 preview を取得し、残る差分を人が確認して承認する。異なる定義や deny の変更はこの migration に混ぜず、別の policy review として扱う。role directory が空または存在しない installation は、index の既存 role を隠さないよう初期化を先に行う。
