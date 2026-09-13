# personal-workbench

個人秘書ワークフローを一つの `127.0.0.1` ローカル inbox にまとめる pad です。

- **Link Inbox**: URL・引用・読む候補
- **Task Triage**: 今日・今週・待ち・保留のタスク候補
- **Follow-up Desk**: 相手、次の連絡、期限
- **Decision Log**: 決定、理由、再確認日
- **Receipt / Expense**: 領収書・金額・用途のメモ（画像解析は後段）
- **Daily Review**: Journal / TODO / NOW の振り返り

保存データは既定で `personal` tier です。各保存は `proposed` として handoff に記録され、人間承認なしにメール、カレンダー、知識ベースへ反映しません。

```bash
KYBERION_PERSONA=sovereign KYBERION_TENANT=<tenant> \
  node_modules/.bin/tsx scripts/personal-workbench/server.ts \
  --out active/shared/tmp/personal-workbench
```

`/capture` と `/load` は `X-PW-Token` が必要です。ローカルトークンは人間承認の代替ではありません。

認証済みセッションから `/action` を使うと、既存の governed workflow を呼び出せます。メール送信とカレンダー変更は `approved: true` が必須です。OCR は既定で `privacy_first`、知識登録は即時公開ではなく personal tier の promotion candidate としてキューに入ります。

```json
{
  "action": "calendar",
  "approved": true,
  "payload": {
    "summary": "定例",
    "start": "2026-09-14T10:00:00+09:00",
    "end": "2026-09-14T10:30:00+09:00"
  }
}
```

`/action` のリクエストも `X-PW-Token` が必要です。メール・カレンダーの `approved` は human approval の記録と合わせて使用し、単なるブラウザ token を承認の代替にしないでください。
