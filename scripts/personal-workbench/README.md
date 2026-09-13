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
