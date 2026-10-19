# Web からの会社オンボーディング

## 対象と権限

Concierge の /setup/company は、本人認証済みの active owner が、既に許可された一つの tenant 内で使う。
最初の tenant は既存の first-run 手順（ホストで発行した一回限りの setup code → /setup/first-run）で作る。
完了画面から会社設定へ進める。既存の会社では Management の案内から進める。
任意の追加 tenant、token scope、member 権限はこの画面から増やせない。

## 一つずつ進む

1. 既存 tenant の名称と company template、最初の依頼を確認する。
2. 登録予定をレビューして会社を登録する。owner は認証済み member から導出し、入力で指定しない。
3. readiness の四つの probe を実行する。Web の整合性確認は、許可された tenant の registry / binding / organization / accountable human / memory policy に限定する。全 tenant の index・project の整合性監査は CLI の operator 検査として維持し、Web で実施済みとは表示しない。viewer scope が warn の場合は監査のみであり、アクセス拒否が enforce されているという意味ではない。
4. activation の承認申請を作り、本人が既存の承認一覧で内容を見て承認する。
5. 設定画面を更新し、承認済みの activation を適用する。
6. 最初の仕事の計画をレビューして project / work item を準備する。

「会社登録済み」「本人承認待ち」「有効化済み」「最初の仕事を準備済み」は別の状態である。
最後の状態も、成果物が生成済み、mission が実行済み、教訓が承認・再利用済みという意味ではない。
予算停止、provider の学習利用宣言、機密送信条件は別途必要で、会社設定から暗黙に許可されない。

## 承認の条件

Web activation は canonical service と共通 approval store を使用する。
対象 tenant / organization、責任者、NHI、service、probe の内容と時刻を固定した申請だけが使える。
probe は同一 scope の server 生成証跡で、15 分以内でなければならない。
本人の A2 以上の認証証拠と presented digest が必須で、agent の自己申告は使えない。
viewer mode、owner membership、binding、NHI、service または証跡が変われば新しい確認が必要になる。
適用は一度だけ claim される。失敗・中断した claim を画面が自動再実行することはない。
既存の手動 CLI activation の運用要件は変更していない。

## 失敗と復旧

- 登録失敗・応答不明: まず状態を更新する。既存データの強制上書きは提供しない。中途の登録は operator が証跡を確認して正規の復旧手順を選ぶ。
- 既存 tenant の isolation policy が不足: 自動で書き換えない。owner が別途変更内容を確認する。新しい first-run tenant には既存の strict-isolation default を設定する。
- 名前・責任者の競合: 既存 tenant 名と owner binding を保持し、転送・変更を暗黙に行わない。
- 期限切れ・内容変更: probe を再実行し、本人が新しい申請を承認する。
- 最初の project ID が既に別用途で存在: 勝手に再利用せず止める。
- 外部 provider や実行環境が未準備: 実行成功とは表示しない。既存の正式な接続・実行手順へ進む。

## 検証方法

共有 core service、HTTP 境界、UI のテストをそれぞれ実行する。別 tenant、非 owner、agent、期限切れ認証、未提示 digest、変更済み probe、再送、登録途中失敗、画面移動中の古い応答を含める。
合成 fixture の試験と実ブラウザ・provider 実行は区別する。本人承認を agent 操作で代替しない。

## 残る導線

- 準備済み work item から、同じ tenant / project を保持した mission 発行・実行の導線は未接続。既存の discussion / hearing の正式導線へ統合する。全 tenant 権限の旧 admin API を代替に使わない。
- provider 学習利用宣言は Web で本人承認できるが、申請・適用は CLI のまま。実行前に現在の宣言と送信条件を確認する。
- active profile の identity / vision と選択 tenant の整合確認は別途必要。画面選択だけで server 全体の stance を変更しない。
- service 型の最初の依頼には既存 service の選択が必要で、この画面にはまだ selector がない。project 型の準備と区別する。
