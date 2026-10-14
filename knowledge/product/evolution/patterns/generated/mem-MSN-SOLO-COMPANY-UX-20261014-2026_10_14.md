---
record_id: mem-MSN-SOLO-COMPANY-UX-20261014-2026_10_14
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SOLO-COMPANY-UX-20261014-2026_10_14
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-14T04:41:07.748Z
source_branch: feat/solo-company-demo-ux-20261014
source_commit: f58684a4b92670f1a034620754622210b7f3cb17
---

# 一人AI会社デモのUX検証と復旧導線

初回設定から依頼・判断・成果までを同じ会社とプロジェクトで辿り、失敗から安全に復帰できることを確認する。

## Applicability

- mission
- mission:MSN-SOLO-COMPANY-UX-20261014

## Reusable Steps

1. 初回設定から依頼・判断・成果までを同じ会社とプロジェクトで辿り、失敗から安全に復帰できることを確認する

## Expected Outcome

# 一人AI会社デモのUX検証

## 検証の原則

- 初回設定の状態は成功した応答の既知の状態だけで判断する。通信失敗を設定済みや成功と扱わず、読取の再試行を用意する。
- 判断と成果の一覧を取得できない間は古い承認操作を隠す。再試行はGETだけを実行し、実行や承認を再送しない。
- 会社・プロジェクトの作成と編集を開いたら入力へフォーカスする。依頼ダイアログは履歴を確認できてから入力へフォーカスする。
- 管理画面の組織・プロジェクトと依頼履歴GET・送信POSTは同じURL解決規則を使う。snake/camel表記が混在する回帰ケースも固定する。
- 空の判断一覧は待機する説明に加えて、AIへ依頼する既存の導線を用意する。

## デモのリハーサル

1. 架空データだけを持つ会社を選択し、会社名・権限・プロジェクトを確認する。
2. 会社・プロジェクト管理から初期の目的を入力し、レビュー画面で内容を確認して保存する。
3. AIへの依頼を開き、目的・期待する成果・成功条件を入力する。送信前後で選択中の会社とプロジェクトが維持されることを確認する。
4. 実際の進捗と、承認が必要な操作を表示する。準備された案と実行済みの結果を区別する。
5. 実際に生成された成果を開く。成果がない場合は完了と主張しない。
6. 一覧読込や初回設定の接続失敗を模擬し、再試行で復帰し、仕事や承認を重複送信しないことを確認する。

## 証拠の区別

回帰テスト、本番ビルド、PR readiness、実ブラウザ操作を別々に記録する。ブラウザが利用できない場合、画面のレイアウト・スクロール・実キーボード操作を検証済みと主張しない。

## Evidence

- active/missions/public/MSN-SOLO-COMPANY-UX-20261014/evidence/implementation-report.md
- active/missions/public/MSN-SOLO-COMPANY-UX-20261014/evidence/test-report.md
- active/missions/public/MSN-SOLO-COMPANY-UX-20261014/evidence/REVIEW-execution-implement.md

## Artifacts
