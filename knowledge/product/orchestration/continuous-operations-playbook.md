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
2. [dot authoring](../../../dots/README.md)に従い、同一 tier / tenant / organization / project の charter を作る。CLI の運転 role は `organization_operator`。charter の `authority_role` もこれにそろえる。pipeline 形と対象 pipeline を `allowed_execution_shapes` / `allowed_pipelines` で許可し、同時実行数・予算・承認方針を設定する。通知は inbox から始める。
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

特定の承認済み WorkItem を既存 owner で確認する操作は、同じ scope を選択して実行する。

```sh
pnpm organization continuous owner-tick --config knowledge/product/governance/continuous-operations/<loop>.json --work-item-id <id>
```

このコマンドは対象の WorkItem を最大1回進める。停止したプロジェクト作成は、同じ操作キーと承認済みの項目を持つプロジェクト、および組織への登録が確認できた場合に続行する。プロジェクトが見つからない場合や別の効果の不確実性が残る場合は停止を保持する。

出力の inventory の `admission_dot_status` は受付時に記録された値。outcomes の `dot_status`、`work_item_status`、`managed_work.status` は実績から観測した値。

全 source の検証後に checkpoint を書く。取得・鮮度エラーなら分配しない。admission 前に operation identity を保存するため、checkpoint 後のプロセス停止は同じ identity で自動復旧する。明示的な admission 例外や拒否は勝手に再試行しない。

原因を修正した後、同一 scope で次を実行する:

```sh
pnpm organization continuous run --config knowledge/product/governance/continuous-operations/<loop>.json --apply --recover-admissions --json
```

例外からの復旧は同じ operation identity を再利用し、確定済み拒否の再評価は cooldown 後に新しい identity を使う。parked / declined をこの flag で承認へ変更しない。状態破損は fail closed。状態ファイルを削除して再試行すると重複防止が失われるため行わない。保持できる rule 履歴は 1000 件。

指標差分は観測変化であり、施策の因果効果の証明ではない。`expected_effect` と charter の既存 KR / signal probes を設定し、dot feedback の settle window 後の結果と併せて評価する。未改善なら人または既存 mission が仮説・閾値・pipeline を見直す。

## 接続済みの運転経路（2026-10-18）

source.kind は `snapshot`（省略時も同じ）、`organization_metrics`、`pipeline`、`pipeline_schedule_health` を受け付ける。組織 Operation の `overdue_operations`、`failing_operations`、`blocked_operations` は、対象組織の運用状態から集計する。`pipeline` は pipeline_ref と生成先 path を宣言し、charter の allowed_pipelines に登録する。Pipeline はコンテキストの `collector_attempt_id` を使い、出力を `{"collector_attempt_id":"<current-id>","observations":[...]}` として atomic に書く。観測配列の各要素は通常の snapshot と同じ形式。別 Pipeline の生成先を同じパスに設定すると構成エラーになる。dry-run は Pipeline を起動せず、完了記録の試行 ID に一致する観測だけを読む。

`pipeline_schedule_health` はレビュー済み設定の `pipeline_ref` で指定した Chronos の定期ジョブを読み取り、`registered_pipeline_schedules`、`failing_pipeline_schedules`、`due_pipeline_schedules` を既存のルールに渡す。同じテナントの Pipeline またはテナント非所属の public 設定から参照するリポジトリ Pipeline を対象とする。同一テナントの他の組織と共有する依存先は、Pipeline の稼働状態として扱う。個々の実行を観測元の組織や Project の成果に帰属させるには別途記録が必要。状態を読む際も Chronos が定期実行を担当し、collector が Pipeline を起動することはない。Project の `outer-loop` プレビューも、Project の `pipeline_refs` に明示された定期ジョブを同じ方法で観測する。

プレビューは登録状態、前回結果、登録情報から計算した期限の到来、実行可否の判定元を分けて表示する。期限の到来は Chronos ホストでの実行許可を確定しない。ホスト側のポリシーを観測できない場合は `chronos_policy_unobserved` を返す。

自動分配に project / mission / mission_group が必要なルールは work_plan を設定し、pipeline_ref に pipelines/continuous-managed-work.json を指定する。project は name / summary / objective_ids、missions は key / title / goal / success_condition / mission_type / depends_on を持つ。最大16件、依存関係は循環不可。任意の観測値やモデル文章から work_plan を作らない。

managed work は強制的に人間承認へ送られる。承認後も各 mission の alignment approval は独立して検証する。owner は controller を通じて作成・開始・task dispatch・phase gate・検証へ進める。レビューや承認を機械が代行しない。未承認のため project / mission がまだ存在しない状態は正常な pending であり、成果の完了表示ではない。

定期運転は設定に schedule: { every_seconds: 900 } を置くと、既存 supervisor が担当 charter の権限で実行する。cadence checkpoint により同じ周期の実行を抑制し、静かな周期や source 障害の間も承認済み managed work の進捗を確認する。上の organization scheduled operation 方式と同時に同じループを登録しない。組織運営の接続済み設定はこの supervisor 方式を採用する。

通常のタスク成果物は pipelines/continuous-operations-report.json が生成する。実行中の dot WorkItem と attempt / lease を検証し、同一 scope の集計レポートを publish する。cycle の outcomes で action / approval / WorkItem / execution / artifact / managed work を追跡し、次周期の inventory で数値差分を確認する。

コードを更新した常駐プロセスは build 後、governed scheduler で再起動する。

停滞時は supervisor の heartbeat と、対象スコープの cadence checkpoint を照合する。

`pnpm organization continuous status --config <governed-config.json>` は、選択したスコープのチェックポイントから直近の試行・完了・次回実行可能時刻を返す。`due` は周期が到来した状態を示す。実際に実行できるかは、supervisor の稼働、circuit、停止・予算の判定にも従う。

出力は定常運用の `organization_cadence` と、観測ルールの `continuous_operations` を分ける。チェックポイントの `last_observation_at` は、観測と起票判定まで到達した周期を示す。その周期に起票エラーがある場合は件数を `last_admission_error_count` に記録し、`last_success_at` の更新を保留する。

Supervisor は観測と起票済み作業の進行を、それぞれ複数の有界な実行枠で処理する。定期実行と手動の `--apply` は、同一スコープ・同一 Pipeline のロックを共有し、起動前に試行 ID を記録する。子プロセスは期限、運用停止、組織停止、charter の失効、許可の取り消し、Personal charter の所有者変更で停止する。ネストされた Pipeline にも親 collector のデータ tier、テナント、推論送信制約を引き継ぐ。正常終了が確認できない場合は、その collector と依存ルールだけを保留し、独立した観測・起票・起票済み作業の進行を続ける。取得後に Pipeline の許可が取り消された場合も、該当する観測元の起票だけを保留する。保留中の観測元は周期結果の `withheld_sources` に表示される。正常終了した collector の出力は同じロック内で取得し、欠落・破損・期限切れの観測元は周期から除外する。

起動ファイルの欠落や Pipeline の事前検証エラーなど、副作用の開始前と確認できる失敗は `not_started` と記録し、原因解消後に次の周期で再試行する。`continuous status` の `reason_code` と `next` で原因と確認先を参照できる。正常終了した試行は完了結果を先に記録する。直後に停止や権限変更があった周期では、その観測を起票に使わない。

`continuous status` の `collectors` で `unconfirmed` の試行 ID と開始時刻、起動前に確保した `pipeline_run_id` を確認する。同じホストで登録済みのプロセスグループ（Windows では Job のコントローラー）の停止確認が必要。停止を確認できない場合、保留を維持する。停止確認の時刻は承認依頼の前に `stop_confirmed_at` として保存する。承認を待つ間も試行は `unconfirmed` のまま維持され、承認後は保存済みの停止確認を使う。プロセスの登録を必要としなかった旧形式の未確認記録も保留を維持する。対応する Pipeline 履歴と副作用を照合し、安全に次の周期へ進める状態にしたうえで、証跡の参照を指定して承認を依頼する。人間の承認後、同じ引数で `--request-approval` を `--approval-request-id <id>` に置き換える。解除は指定した試行にだけ適用される。次の手動実行または予定周期が新しい試行を開始する。collector の履歴は汎用 Pipeline CLI で再開できない。承認後に同じ実行を継続する処理は、承認と再開を管理できる managed WorkItem に配置する。組織や charter を停止している間も、権限のある担当者は同じスコープで試行を照合できる。解除は charter の実行権限を変更しない。

```sh
pnpm organization continuous reconcile-collector --config <ref> --pipeline-ref <ref> --attempt-id <id> --evidence <ref> --request-approval
```

Personal のファイル観測は、charter の所有者・組織・プロジェクトに対応する dot 状態ディレクトリの `continuous-operations/snapshots/` 配下に置く。他の所有者のパスを指定した場合は、読み取りや Pipeline 実行の前に拒否する。Personal の観測と起票は同じ所有者に結び付ける。所有者が変わった場合は取得済みの観測での起票を止め、新しい所有者は独立した起票状態を使う。

組織が未構成・停止中・廃止済みの間は、既存の安全な観測に留め、新規起票と managed work の副作用を保留する。起票エラーの circuit が開いている間も観測を続ける。Chronos の opt-in を観測できないジョブは `timing_due` を未確定として返し、周期上の期限が到来していれば `unconfirmed_due_pipeline_schedules` に計上する。

限定稼働のレビューでは、同一スコープの低リスクなレポートを1件選び、承認待ちの別件と並行して観測する。機能面では起票件数・重複・承認後の再開・成果物を、NFR では停止から最初の正常周期までの時間と処理可能な作業の滞留を、運用 UX では状態と次の確認先を判定できるかを記録する。成果の完了後に採取した観測は `observation_comparison` の目標・前後の根拠・差分を確認する。自律範囲の昇格・降格は、取得した証跡をもとに既存のテナント承認とポリシーで判断する。

| 観測                                           | 次の確認                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| heartbeat が古い                               | supervisor の稼働状態と直近の sweep を確認する。                                                                                |
| `last_run_at` が進み、`last_success_at` が古い | 進行中の周期と `dot-continuous-cadence` のアラートを確認する。失敗後は次の予定周期または circuit の cooldown 後に再評価される。 |
| 両方が進むが managed work が滞留する           | 対象 WorkItem の状態・承認と `dot-continuous-owner` のアラートを確認する。owner の circuit が開いていても観測は続く。           |
| 両方が進み、起票がない                         | 周期レポートで閾値、cooldown、重複、容量の判断を確認する。閾値内で起票なしなら正常。                                            |

```sh
pnpm kyberion scheduler restart --apply --daemon agent-runtime-supervisor
```

launchd / systemd 配下の agent-runtime-supervisor は、build 完了後に dist の stamp が 2 回連続で同じで、sweep・ask・busy runtime・delegated worker が無いときに自分で終了コード 75 で再起動する（15 分に 1 回まで、heartbeat の `last_self_recycle_at` に記録。`KYBERION_AGENT_RUNTIME_SUPERVISOR_STALE_CODE_RECYCLE=0` で無効）。stale_code が続く場合だけ上の restart を使う。heartbeat の stale_code、healthy、PID と continuous cadence checkpoint を確認する。承認待ちや veto window を解除するために autonomy を下げたり、承認レコードを手書きしたりしない。既存 approvals UI / CLI から本人が判断する。

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
