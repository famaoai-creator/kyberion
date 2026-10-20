---
title: 'Scope-aware continuous workplaces'
tags: [architecture, workspace, project, organization, autonomy, scope]
last_updated: 2026-10-21
---

# スコープを共有する継続的な仕事場

仕事場は既存 owner の目標・仕事・資料・判断・自律ループをまとめる projection である。
別の所有者、権限ストア、仕事台帳は作らない。Chronos の Home と Concierge の会話・資料取込を
同じ選択範囲で往復する。

## 所属と選択

正本の所属順序は `tenant_slug → organization_id → project_id → mission_id → task_id`。
organization と project のない公開・個人 Project も、実レコードの optional な親を保つ。
`public`、`personal`、`shared` を tenant として補わない。

Operation は組織の定常業務への参照であり、所属階層を増やさない。Project と Operation は
同時に選択しない。URL は希望範囲であり、認証済み viewer をサーバーで縮小し、registry の
実在・親・tier を照合する。許可された ID 同士でも親が違えば拒否する。

## 画面と実データ

| 表示     | 正本と境界                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| 目標     | organization purpose、Project summary、Operation purpose                                                                 |
| 仕事     | WorkItems と Operation runs。WorkItem の tier は実 owner または凍結済み admission から確認し、不明なものを公開扱いしない |
| 資料     | 既存 ArtifactRecord / ownership registry と成果物。Project 資料は既存 mission context pack の取得経路で再利用する        |
| 判断     | 既存 approval-store と scoped learning。選択に合わない更新も副作用前に拒否する                                           |
| 自律運転 | 既存 DotCharter・activation gate・executor・budget governor                                                              |

資料追加は Concierge の取込画面へ同じ選択を渡す。文書 reader、PII/secret gate、
`writeScopedArtifact` と publish を通し、source hash、actor、実 storage scope を残す。
Project 資料を tenant 全体の knowledge card に変換しない。Operation の資料は明示した
組織共有ライブラリへ保存する。作業資料、curated knowledge、実行結果・receipt は区別する。

API は取得失敗を `unavailable` で表し、画面は件数を `—` にする。scope の親を変更した場合は
子選択と古い行選択を外し、遅延した応答や確認画面を別の範囲へ流用しない。

## 継続的な責任と有限の実行

Project の active は、自律ループが有効であることや、仕事が実行中であることを意味しない。
常駐責任は既存 dot、有限の実行と claim は既存 WorkItem / Mission が持つ。新しい daemon や
Project ごとの常時モデル消費は追加しない。

Operation 専用 dot は `work_binding: { operation_id: "weekly-report" }` を持つ。
`scope` は組織までとし、Project や組織全体の `operations_cadence` と混在させない。
この参照は責任と provenance であり、ツール実行権限ではない。既存 role、accountability
charter、mission mandate、effect approval の境界は維持する。

operation の実在・tenant・組織・tier は authoring、activation、execution で確認する。
binding は admission identity、承認の provenance と dedupe key、WorkItem metadata に凍結する。
binding の変更・解除後は古い承認や未完了の投入を新しい仕事として再解釈しない。
元の parked / uncertain 状態を残し、正規の reconciliation を使う。

Home の停止はその dot の今後の wakeup を止める。進行中の仕事の取消や、外部処理の停止確認を
代用しない。親 owner、兄弟業務、他の dot は同時に停止しない。予算表示は既存 governor の
組織・tenant・system 集計であり、独立した Project / Operation 割当ではない。集計範囲全体を
読めない viewer には表示せず、不明・部分集計も明記する。

## 初期設定

組織・Project・Operation は `pnpm organization` / `pnpm project` の既存 facade で作る。
reviewed draft の scope、goal / success_signals、triggers、wake budget、既存 authority role と
必要な charter / pipeline / mandate の参照を決める。

```bash
pnpm kyberion dot create --file active/shared/tmp/system/<job>/reviewed-draft.json
pnpm kyberion dot create --file active/shared/tmp/system/<job>/reviewed-draft.json --apply
pnpm kyberion dot validate <dot-id>
pnpm kyberion dot activate <dot-id>
```

create は既定で preview。適用しても draft のままで、activation は既存 gate を通る。
tenant の draft は `knowledge/confidential/<tenant>/dots/` に配置し、公開 repo の `dots/` に
機密目標を書かない。既存の公開 Project は公開 draft を使える。個人専用 dot の新規 authoring と
Concierge の personal tier 会話は既存 policy が提供しないため、公開への自動変換はしない。
personal Project の実 owner と資料は既存 private storage のまま扱う。

関連: [scope governance](scope-governance-plane.md)、
[organization operations](../governance/organization-operations-runbook.md)、
[continuous operations](continuous-operations-loop.md)。
