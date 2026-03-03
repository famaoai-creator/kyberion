# 勤怠承認 標準運用手順書 (Attendance Approval SOP)

*Version: 1.0.0*
*Role: Line Manager*

## 1. 目的 (Objective)
COMPANY 勤怠管理システムにおける部下の申請（勤怠、休暇等）を、ブラウザ自動操作により「承認から送信（確定）まで」一括で実行する。

## 2. 実行リソース (Prerequisites)
実行には以下の 3 つの資産が正しく配置されている必要がある。

1.  **認証情報**: `knowledge/personal/connections/company_attendance.json`
2.  **シナリオ**: `knowledge/personal/automation/scenarios/company_manager_complete.yaml`
3.  **スキル**: `skills/utilities/browser-navigator` (ビルド済みであること)

## 3. 即時実行コマンド (Quick Start)
リポジトリルートから以下のコマンドを実行する。

```bash
node skills/utilities/browser-navigator/dist/index.js 
  --scenario=knowledge/personal/automation/scenarios/company_manager_complete.yaml 
  --headless=false
```
※ `headless=false` を推奨（操作の可視化とオーバーレイ回避のため）。

## 4. 承認フローの仕様 (Workflow Logic)
本手順は、COMPANY 特有の「二段構え」の承認に対応している。

1.  **ログイン**: 自動ログイン。
2.  **遷移**: 「未処理一覧」へ直接遷移。
3.  **巡回**: 6 桁以上の申請番号を持つリンクを自動的に順番に開く。
4.  **一次承認**: 「承 認」ボタンをクリック。
5.  **二次確定**: 遷移後の確認画面で「送 信」または「確定」ボタンをクリック（重要）。
6.  **完了**: 成功レポートを生成。

## 5. トラブルシューティング (Troubleshooting)

### A. リンクがクリックされない場合
- **原因**: 画面前面に透明なオーバーレイ（`LB_overlay`）が存在し、クリックをブロックしている可能性がある。
- **対策**: スクリプト側で `force: true` オプションを使用するか、数秒待機してオーバーレイが消えるのを待つ。

### B. 「未処理」のまま残る場合
- **原因**: フレーム（iframe）構造が深く、`browser-navigator` がリンクを捕捉できていない。
- **対策**: `knowledge/personal/automation/company-attendance/manager_approval.py` (Python版) を使用して、再帰的フレーム探索で実行する。

## 6. エビデンスの出力
- 実行完了後、`active/missions/attendance_approval/` にスクリーンショットが保存される。
- 承認結果のテキストレポートがコンソールおよび内部ログに出力される。
