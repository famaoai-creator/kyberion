---
title: 'Continuous Operations Loop Playbook'
tags: [orchestration, organization, autonomy, continuous-operations]
last_updated: 2026-11-02
runtime_stages: [planning, execution, review]
---

# 継続運営ループの設定と運転

## 初版の契約

同一 scope の JSON snapshot を収集して目標付き閾値ルールで分析し、問題ごとの永続 episode で重複を抑え、既存 dot へ pipeline 実行を提案する。実行は supervisor の dot executor が担う。CLI の apply は分配であり、その場で作業完了を意味しない。

project / mission 群は下記の接続済み経路で作成する。任意 SaaS の認証設定、自由文による戦略再編、進行中作業の強制取消は含まない。[設計・計画](../architecture/continuous-operations-loop.md)参照。

## 準備

1. 対象 tenant / organization / project を既存 facade で用意し、`pnpm scope use` で選択する。既存 scope を勝手に作り直さない。
2. [dot authoring](../../../dots/README.md)に従い、同一 tier / tenant / organization / project の charter を作る。CLI の運転 role は `organization_operator`。charter の `authority_role` もこれにそろえる。pipeline 形と対象 pipeline を `allowed_work_shapes` / `allowed_pipelines` で許可し、同時実行数・予算・承認方針を設定する。通知は inbox から始める。
3. 既存 tenant-ingest / connector とデータ別 adapter で観測 snapshot を生成する。collector は下記 JSON を読み取る。adapter は取得成功時だけ atomic に更新し、失敗時に古い値へ新しい時刻を付けない。
4. `knowledge/product/governance/continuous-operations/example.json` を新しい固定 ID の設定として作成し、scope、dot、source、metric、目標、閾値、実行 pipeline をレビューする。実データは設定に埋め込まない。設定はこの product governance directory 内の JSON に限定され、symlink は受け付けない。
5. 設定の `enabled` を true にする。初期 example と schedule は無効で出荷される。disabled でも charter と実行 scope の検証は必要。

snapshot の例（root は array、各 metric は一意）:

```json
[
  {
    "metric": "failed_jobs",
    "value": 3,
    "observed_at": "2026-10-18T00:00:00.000Z",
    "evidence_ref": "incident:job-failure-123"
  }
]
```

`observed_at` は取得時の UTC。1 source は 1 MiB / 1000 metric まで。source は設定 scope の runtime floor または同 tier の knowledge 配下に限定される。snapshot は action / scope / role を指定できない。evidence_ref は表示用の根拠参照であり、実行命令として解釈しない。

## 一回の運転

```sh
pnpm organization continuous run --config knowledge/product/governance/continuous-operations/<loop>.json --dry-run --json
pnpm organization continuous run --config knowledge/product/governance/continuous-operations/<loop>.json --apply --json
```

dry-run は source と状態を読んで候補を示し、checkpoint / WorkItem / 承認依頼を書かない。通常の read audit は記録され得る。

report の inventory は rule ごとに `objective_ref`、`observed_at`、根拠、現在値、前回値、差分、分配状態を示す。`proposed` だけで実行成功と解釈せず、`dot_status`、`reason`、`action_ref`、`work_item_id` を確認する。parked は承認待ち、shadow はその場では実行されない判定。refused / admission_error は error としてコマンドも失敗する。

同じ違反が続く間は再起票しない。正常化を観測し、その後再発し、cooldown を満たした場合だけ新しい episode を提案する。元の WorkItem を強制終了したり claim を奪ったりしない。

## 定期化

`pipelines/continuous-operations.json` を組織固有の pipeline として用意し、`config_ref` と `apply: true` を明示する。最初は dry-run の結果を確認する。

`pnpm organization` の operation facade でこの pipeline を execution target とする scheduled operation を登録し、既存 resident-dot `operations_cadence` から tick する。scheduled executor が organization_operator と tenant / organization を bind する。詳細な登録引数は `pnpm organization help` と [organization operations](../governance/organization-operations-runbook.md)に従う。新しい daemon は追加しない。

汎用 pipeline の schedule は disabled。組織 scope を持たないグローバル Chronos と resident cadence を二重に有効にしない。収集側の更新周期を鮮度上限より短くし、分析周期と分けて運転する。

supervisor の dot executor が許可された pipeline を claim して実行し、結果を既存 ledger に残す。`pnpm kyberion dot status` で承認待ち、予算停止、実行結果を確認する。

## 復旧と効果

全 source の検証後に checkpoint を書く。取得・鮮度エラーなら分配しない。admission 前に operation identity を保存するため、checkpoint 後のプロセス停止は同じ identity で自動復旧する。明示的な admission 例外や拒否は勝手に再試行しない。

原因を修正した後、同一 scope で次を実行する:

```sh
pnpm organization continuous run --config knowledge/product/governance/continuous-operations/<loop>.json --apply --recover-admissions --json
```

例外からの復旧は同じ operation identity を再利用し、確定済み拒否の再評価は cooldown 後に新しい identity を使う。parked / declined をこの flag で承認へ変更しない。状態破損は fail closed。状態ファイルを削除して再試行すると重複防止が失われるため行わない。保持できる rule 履歴は 1000 件。

指標差分は観測変化であり、施策の因果効果の証明ではない。`expected_effect` と charter の既存 KR / signal probes を設定し、dot feedback の settle window 後の結果と併せて評価する。未改善なら人または既存 mission が仮説・閾値・pipeline を見直す。

## 接続済みの運転経路（2026-10-18）

source.kind は snapshot（省略時も同じ）、organization_metrics、pipeline を受け付ける。organization_metrics は overdue_operations / open_incidents / pending_decisions / unhealthy_services の数値のみを返す。pipeline は pipeline_ref と生成先 path を宣言し、charter の allowed_pipelines に登録する。dry-run では collector を実行せず、既存 snapshot のみ読む。

自動分配に project / mission / mission_group が必要なルールは work_plan を設定し、pipeline_ref に pipelines/continuous-managed-work.json を指定する。project は name / summary / objective_ids、missions は key / title / goal / success_condition / mission_type / depends_on を持つ。最大16件、依存関係は循環不可。任意の観測値やモデル文章から work_plan を作らない。

managed work は強制的に人間承認へ送られる。承認後も各 mission の alignment approval は独立して検証する。owner は controller を通じて作成・開始・task dispatch・phase gate・検証へ進める。レビューや承認を機械が代行しない。未承認のため project / mission がまだ存在しない状態は正常な pending であり、成果の完了表示ではない。

定期運転は設定に schedule: { every_seconds: 900 } を置くと、既存 supervisor が担当 charter の権限で実行する。cadence checkpoint により同じ周期の実行を抑制し、静かな周期や source 障害の間も承認済み managed work の進捗を確認する。上の organization scheduled operation 方式と同時に同じループを登録しない。組織運営の接続済み設定はこの supervisor 方式を採用する。

通常のタスク成果物は pipelines/continuous-operations-report.json が生成する。実行中の dot WorkItem と attempt / lease を検証し、同一 scope の集計レポートを publish する。cycle の outcomes で action / approval / WorkItem / execution / artifact / managed work を追跡し、次周期の inventory で数値差分を確認する。

コードを更新した常駐プロセスは build 後、governed scheduler で再起動する。

```sh
pnpm kyberion scheduler restart --apply --daemon agent-runtime-supervisor
```

heartbeat の stale_code、healthy、PID と continuous cadence checkpoint を確認する。承認待ちや veto window を解除するために autonomy を下げたり、承認レコードを手書きしたりしない。既存 approvals UI / CLI から本人が判断する。

分配枠が満杯の場合は inventory の limited として待機し、admission identity を増やさない。枠が空き、cooldown を満たした周期で分配する。既に確定拒否された試行は上記 recover-admissions を明示的に使い、元の cooldown を保持する。指標が回復しても同じ episode の既存 action / WorkItem 参照は保持し、進行中の仕事と成果を追跡する。

managed lifecycle の controller runner は POSIX の専用 process group、Windows の kill-on-close Job Object で controller と子孫を監督する。期限・中断・出力超過に加え、controller の正常終了後に残った worker も終了する。Job Object を設定できない Windows 環境では未監督の実行をせず、エラーで停止する。snapshot の分析・dry-run と lifecycle 実行の対応環境を混同しない。

## 承認済み開発の継続実行

開発の継続実行も上の resident cadence と continuous owner を使う。`work_plan.missions[]` に次の `development` を含めてレビューする。省略した既存の運営missionの挙動は維持する。`mission_type` を省略した開発missionには `development` のprocess templateを使う。

```json
{
  "key": "improve",
  "title": "Improve the approved repository",
  "goal": "Implement the reviewed requirement and validate the result",
  "success_condition": "Independent review and required CI pass on the merged revision",
  "development": {
    "cwd": ".",
    "repository_url": "https://github.com/owner/repository",
    "source_edit_paths": ["libs/core/example.ts", "tests/example.test.ts"],
    "implementation_task_id": "execution-implement",
    "review_task_id": "self_review-code-review",
    "title": "feat: implement the reviewed requirement",
    "body_file": "evidence/pr-body.md",
    "max_repairs": 2
  }
}
```

ownerは専用checkoutから起動し、`cwd` はそのrootを表す `.` に固定する。`body_file` は対象mission内の `evidence/` 相対path。`source_edit_paths` は既存task tool grantと同じpublic code root内の正確なfileを1..64件列挙する。directory prefix・wildcard・重複・親directoryへの移動・`.git`・private/runtime storageは許可しない。実装とreviewを同じtaskにしたり、未定義の権限fieldや3を超える修復上限を追加したりできない。設定はsource-boundなadmission identityへ含まれ、mission作成後のdescriptor変更では再開しない。変更が必要なら既存の承認経路で新しい計画を確認する。

`repository_url` は承認対象の正確なHTTPS repositoryを固定する。実行時にoriginやPRのrepositoryが異なれば停止する。URLに資格情報・query・fragmentを埋め込まない。

開発descriptorに `mission_type` を明示する場合は `development` に限定する。レポート・文書制作など、別のprocess templateへ開発用の完了gateを適用しない。

初回の計画承認cardでは、repository・tier/tenant/organization・固定branch・正確な編集file件数・修復上限・自動のpush/PR/merge・専用完了gateの意味を先頭に表示する。security summary自体がcard上限を超える設定は拒否し、補足の目標文だけを短縮する。全編集fileと完全なdescriptorは同じactionの既存scoped ledgerへ記録され、cardの根拠にaction refとadmission SHA-256を示す。非公開の計画はshared indexではなく、そのtier/ownerの本文ledgerへリンクする。alignment briefにも全file・同じsummary・owner-bound descriptor参照を含め、変更された説明で古い同意を再利用しない。

一つのwork planに含める開発missionは一件までとし、開発runごとに専用checkoutを用意する。候補branchはrunの所有者へ束縛するため、前runのbranchを自動reset・転用しない。通常の運営missionだけのgroupや、一件の開発と運営missionを組み合わせたgroupは引き続き使える。次の開発runは新しいclean checkoutと確認済み計画で開始する。

設定には秘密情報や非公開の要求本文を埋め込まない。内容は対象tierのmission evidenceに置き、private repository・同一tenant/person・charter・provider egress・credentialの各境界を維持する。設定したtierは許可を作らない。public、confidential、personalのいずれでも実行scopeと個別操作の許可を満たす必要がある。

ownerは準備・実装の既存WorkItemを進め、開発continuationが指定WorkItemの修復・独立reviewと正規VCS公開経路を接続する。候補branchは `agent/kyberion-development`、統合先は `main`。CI待機・merge queue・承認待ちは次の既存cadenceで確認し、sourceが回復した周期や新しい提案がない周期も同じownerを再開する。未知の実行結果では再送せず既存証跡を照合する。

完了したtaskや成果物fileが存在するだけでは開発成功としない。実際のmerge revisionとCIが確認できるまではdeliveryの進行とmissionの成功確認を保留する。修復上限、予算、期限、権限取消し、scope不一致は停止理由として扱い、人間承認を作成・承認したことにしない。

承認済みdevelopment descriptorを持つowner missionでは、正規process plannerが三つの完了gateを専用の機械検証へ接続する。TESTS_PASSEDは既存evidence_existsを維持し、現在PR/head・必須CI policy・同じrevisionの正規QA証跡を再照合する。code reviewは現在revisionの独立receipt、deliveryは実merge commitと必須CIを再照会する。一般missionの `human_override` / `reviewer_approved`、alignmentの本人承認、machine-only gateの拒否条件は変更しない。merge確認後のdelivery／retrospective taskには、既存PR・mergeの根拠と報告のみ行う指示を渡し、公開を繰り返させない。

独立reviewとCIの実確認はmerge前に正規VCS境界で行う。ownerのself_review／delivery／retrospectiveのphase完了表示は、継続処理がmerge後の確認まで完了してから反映する。これにより通常のCI待機やbase更新を、先行するphase gateの失敗として隔離せず、次周期の再確認へ戻す。TESTS_PASSEDは継続処理が実CIの成功と正規QA証跡の作成を確認した後に評価する。修正前の古いreportだけでは通過できず、評価中にCIが変わった場合も、専用CI待機判定だけを次周期へ戻す。scope不整合・不正定義・timeoutは通常の失敗処理を維持する。

有効化は既存手順の同一scopeでのdry-run、計画と必要権限の確認、apply、`schedule.every_seconds` の設定で行う。初期化だけで常駐schedulerを有効にしたり、同じ仕事をChronosとresident cadenceへ二重登録したりしない。`continuous-managed-work.json` はowner専用markerのままであり、dot workerのmission禁止を解除する入口ではない。
