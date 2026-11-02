---
title: 情報資産の外部操作を承認済み mission で実行する
tags: [information-assets, intake, mission, approval, work-item]
last_updated: 2026-11-02
---

# 情報資産の外部操作

仕分け・返信準備・アクション抽出・レビュー準備は Dot の pipeline admission から成果物を生成し、保存した内容のハッシュを再読して検証する。メール送信、レビュー指摘の解決、Jira の承認・状態遷移・追加情報の依頼は、内部の mission admission と外部サービスの承認をそれぞれ通る。

## 初期設定

対象 Dot の allowed_pipelines に knowledge/product/pipeline-templates/information-asset-work.json、allowed_work_shapes に pipeline と mission を登録する。mission_mandate_refs は、その tenant で有効な既存の包括委任だけを指定する。委任は work_type=information_asset.<recipe action>、リスク3、対象組織の active/organizations/confidential/<tenant>/<organization>/、固定サービス操作をカバーする必要がある。内部 admission は外部操作を許可しない。

外部操作の effect は google-workspace:gmail_reply、github:resolve_review_thread、jira:answer_request_approval、jira:transition_issue、jira:add_comment の該当分だけを包括委任に宣言する。委任が無い・失効した・Dot に明示されていない場合は mission proposal の生成を拒否する。包括委任の登録は既存の governance facade を使い、レシピや外部データから新たな権限を発行しない。

ソース binding には収集・確認用 read と必要な write 操作だけを登録する。readback 権限が足りない状態を完了扱いにしない。Jira 期限超過の selectors は overdue_transition_id と overdue_status_id を明示する。レビュー指摘は収集済み review_thread_id と現在の PR head を照合する。

## 正規の mission admission と owner 実行

外部操作レシピは mission-shaped WorkItem として admission される。既存 watchdog / mission alignment が正規の mission を準備・起動する。手動で準備する場合も既存の facade を使う。

```sh
pnpm exec tsx scripts/mission_alignment_request.ts --work-item <admitted-work-item-id> --json
pnpm kyberion approvals --approve <issued-alignment-approval-id>
```

watchdog の continuation が起動を完了してから、承認カードに表示された実際の mission ID と既存の mission_controller identity を用いて実行する。架空の ID で拒否を回避しない。

```sh
MISSION_ID=<issued-mission-id> MISSION_ROLE=mission_controller pnpm exec tsx scripts/information_asset_work.ts --work-item <admitted-work-item-id> --plan --json
MISSION_ID=<issued-mission-id> MISSION_ROLE=mission_controller pnpm exec tsx scripts/information_asset_work.ts --work-item <admitted-work-item-id> --json
```

承認用 brief は固定 pipeline・recipe・WorkItem ID・業務キーを含む。この facade は元の admission WorkItem を既存の WorkItem facade で再 claim する。別の業務 store や mission を作らない。現在の active mission、scope、包括委任、元の immutable Dot admission を再確認し、service actuator の PRESET admission / approval gate で外部操作する。

サービス承認待ちは同じ WorkItem の approval_request_id と execution receipt に結び付く。承認後は同じコマンドで再開する。相手待ちは理由・期限・再確認日を保持する。内部 mission の起動承認が未完了の場合は実行しない。

## 完了と不明な副作用

送信メールは元スレッド内の SENT メッセージと本文ハッシュ、レビュー指摘は同じ repository / PR / head / thread の解決状態、Jira は正しい承認 ID・状態 ID またはコメント本文ハッシュを独立した readback で確認する。書込応答だけで完了にしない。

不明な副作用は既存 WorkItem quarantine と execution receipt に保持する。再送前に、人による確認と既存の governed recovery を行う。書込先・解決内容・現在の source revision を確認できない場合も明示的に保留する。
