# 外部 actuator 実制御シミュレーション（2026-10-21）

実 approval gate/store、charter registry/ledger、永続実行予約、actuator の公開入口、pipeline dispatch/journal を通した。外部通信・機器・Gitコマンドの最終 transport は模擬し、合成人間による承認は Vitest の隔離 store 内でのみ作成した。実サービスや実機での成功を意味しない。

最終一括実行は **8 suites / 66 tests 成功**。内訳は新規シミュレーション 4 suites / 12 cases と、共通 admission/runtime/store/approval-resume の回帰 4 suites / 54 tests。最終実行では active leak / approval leftover の警告なし。

| 対象             | 実行で確認した結果                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| email / pipeline | 承認前送信0、承認後1。前段nodeは1回、後段まで完了。completed resumeは送信を省略、強制再実行も予約で拒否。不明結果のmodel repairは0        |
| calendar         | 承認後1回、再実行拒否。承認後のpayload変更は0回。不明応答は1回で停止                                                                      |
| charter          | 実acceptanceとledgerを使用。無人実行成功→確認された失敗→宣言済tripwireで次の作用を拒否。consumption/start/outcomeを2組、tripwireを1件確認 |
| service          | 実actuator→実engine→模擬HTTP。承認後POST1回、再実行拒否                                                                                   |
| meeting          | 実actuator→登録driver。承認後join/leave各1回、再参加拒否                                                                                  |
| browser          | 実click入口→模擬page。承認前0、承認後1、再実行後も1                                                                                       |
| VCS              | 実gitPush→模擬command runner。承認されたURL/SHAでpush1回。承認後SHA差替えは送信0                                                          |
| voice            | 実登録speaker入口。承認前0、承認後の応答不明は1回で停止、再生を再試行しない                                                               |

## 見つかった不具合と修正

対話中の承認要求にはscoped review artifact参照が入り、無人再開では参照が消えていた。そのため同じ外部作用でも承認payload hashが変わり、実email pipelineが `effect_mismatch` で停止した。`external-operation-runtime.ts` でtenantに結び付くheadless実行にも同じ決定的artifact参照を作るよう修正。effect/hashによる認可は弱めていない。修正前失敗と修正後成功を実pipelineシミュレーションで確認した。

## 再実行

```sh
node node_modules/vitest/vitest.mjs run scripts/external-actuator-adapters-simulation.test.ts scripts/external-actuator-simulation.test.ts scripts/external-actuator-services-simulation.test.ts scripts/external-actuator-pipeline-simulation.test.ts libs/core/governance/external-operation-runtime.test.ts libs/core/governance/external-operation.test.ts libs/core/governance/external-operation-store.test.ts libs/core/pipeline/pipeline-approval-resume.test.ts --reporter=dot
```

実行JSON（scratch保持期間内）：

- pipelineの承認ID・journal・node回数: `active/shared/tmp/external-actuator-simulation/2a52767b-7a93-4b5b-8a03-42edf0f74c88/pipeline-report.json`
- calendarとcharter ledger: `active/shared/tmp/external-actuator-simulation/5f73a87c-d557-4b7a-9bde-58edb4e87d73/report.json`
- serviceとmeeting: `active/shared/tmp/external-actuator-simulation/296ebd56-927a-4c47-8887-685bf079c23c/services-report.json`
- browser・VCS・voice: `active/shared/tmp/external-actuator-simulation/b614840e-4319-47e4-95ab-ccdc0ec745a9/adapters-report.json`

## 検証の境界と付帯確認

pipeline再開のprocess launchは模擬し、実runnerを同一process内で保存journalから再開した。独立CLI subprocessの入力ファイル読込み・OS再起動は未検証。meetingは参加・退出を検証し、実音声からの議事録生成は今回の12 casesに含まない。media生成・deployment等も今回の実制御シミュレーション対象には含まない。

package build、repo/actuator build（5 entrypoints）、対象ESLint、通常の型検査（declaration/declarationMap無効）、diff checkは成功。既定のroot noEmitは変更範囲外の2件のTS2742（`organization_continuous_operations.ts:14` / `surface_runtime.ts:557`）で失敗したため、既定型検査全体のgreenは主張しない。baselineも既知のL10 scheduler権限でneeds_attention。service engineの通常credential読取りはsecure-ioに拒否され、既存fallbackで空設定となった。実credentialは使用していない。

独立static reviewで通知抑止と証拠記録順序を修正し、最終reviewに未解決のactionable findingなし。

## PR向けの最新main上での再検証

専用worktreeを `28c4d6dce` から作成し、既存の委任実行・決済release・tenant learningを保持して差分を移植した。型検査は既定オプションのroot noEmitも成功。変更対象58ファイルの776テスト成功、漏出・承認store残留の警告なし。別途PR publisher/preflightのテストも実行した。先の検証記録とは選択範囲が異なるため件数を合算しない。

最新mainで加わった録音同意はmockせず、実standing-grant承認APIと同意resolverでテスト用のtenant・会議URLに限定して設定した。grant前の拒否も確認している。

既存のdelegated/human claimの内側で共通境界が二度目の承認を要求すると、外側claimがunknownになり再開不能になることを独立レビューで検出した。実service/action/request/authが完全一致するprivate実行証明を共通境界へ引き継ぎ、二重承認・消費を防いだ。実permit/承認storeを使う5ケースで、直接mapped service呼出し、human apply claim、payload/auth/tenant差替え、失効、同一実行再送を検証した。証明をtransport直前にも再検証し、予約と監査は省略しない。
