# personal-workbench

個人秘書ワークフローを一つの `127.0.0.1` ローカル inbox にまとめる pad です。

- **Link Inbox** / **Task Triage** / **Follow-up Desk** / **Decision Log** / **Expense** / **Daily Review**
- **カレンダー**: 提案 → UI 確認 → 承認して作成（一気通貫）

保存データは既定で `personal` tier です。`/capture` は常に `proposed` handoff のみを書き、知識キュー投入を自動では行いません。

```bash
KYBERION_PERSONA=sovereign KYBERION_TENANT=<tenant> \
  node_modules/.bin/tsx scripts/personal-workbench/server.ts \
  --out active/shared/tmp/personal-workbench
```

## カレンダーの使い方（ユーザフロー）

1. 画面の「カレンダー」欄に件名・開始・終了を入れる
2. **提案する** → approval request と proposal ファイルを作成（まだカレンダーには書かない）
3. 内容を見て確認チェックを入れる
4. **承認して作成** → 承認レコードを `manual`（CLI の `pnpm kyberion approve` と同じ系統）で確定し、`createCalendarEvent` を実行

CLI でも承認できます:

```bash
pnpm kyberion approvals
pnpm kyberion approve <request-id> personal-workbench
# その後 pad で「承認して作成」（既に approved なら作成のみ）
```

## `/action` の境界

| action                                        | 挙動                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| `calendar` + `stage:propose`                  | 承認リクエスト＋提案ファイル作成                             |
| `calendar` + `stage:apply` + `confirmed:true` | 承認してカレンダー作成                                       |
| `ocr`                                         | governed OCR（既定 `privacy_first`）                         |
| `knowledge`                                   | 既存 handoff を evidence にして promotion candidate をキュー |
| `email`                                       | **下書きのみ**                                               |

`/capture`・`/load`・`/action` は `X-PW-Token` と localhost Origin が必要です。ローカルトークン単体は人間承認の代替ではありません。カレンダー作成時の承認は UI 確認後に `authMethod=manual` の承認レコードとして残します。
