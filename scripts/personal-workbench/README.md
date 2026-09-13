# personal-workbench

個人秘書ワークフローを一つの `127.0.0.1` ローカル inbox にまとめる pad です。

- **Link Inbox**: URL・引用・読む候補
- **Task Triage**: 今日・今週・待ち・保留のタスク候補
- **Follow-up Desk**: 相手、次の連絡、期限
- **Decision Log**: 決定、理由、再確認日
- **Receipt / Expense**: 領収書・金額・用途のメモ（画像解析は後段）
- **Daily Review**: Journal / TODO / NOW の振り返り

保存データは既定で `personal` tier です。`/capture` は常に `proposed` handoff のみを書き、メール送信・カレンダー変更・知識キュー投入を自動では行いません。

```bash
KYBERION_PERSONA=sovereign KYBERION_TENANT=<tenant> \
  node_modules/.bin/tsx scripts/personal-workbench/server.ts \
  --out active/shared/tmp/personal-workbench
```

`/capture`・`/load`・`/action` は `X-PW-Token` が必要です。ローカルトークンは人間承認の代替ではありません。Origin は `127.0.0.1` / `localhost` のみ許可します。

## `/action` の境界

| action      | 挙動                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `ocr`       | governed OCR（既定 `privacy_first`）                                                                        |
| `knowledge` | 既存 handoff を evidence にして personal promotion candidate をキュー（自動公開なし）。capture 後に明示実行 |
| `email`     | **下書きのみ**（`draft_mode: true`）。送信はこの pad では不可                                               |
| `calendar`  | **実行しない**。提案は capture、変更は承認済みの governed calendar workflow へ                              |

```json
{
  "action": "email",
  "payload": {
    "to": "person@example.com",
    "subject": "下書き",
    "body_markdown": "本文"
  }
}
```
