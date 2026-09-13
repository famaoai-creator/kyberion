# daily-desk — Journal / TODO / NOW → handoff → Kyberion

meeting-notepad / sketch-input と同型の **127.0.0.1 限定ローカルポート (8152)**。今日の Journal・TODO・NOW を編集し、`handoff.json` を書き出して Kyberion に渡す。

## 使い方

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/daily-desk/server.ts \
  [--out active/shared/tmp/daily-desk] \
  [--instruction "今日のフォーカスを整理"] \
  [8152]
```

- 起動時に `pathResolver.volatile('personal', …)` 経由で今日の作業メモリ面を探索する。
  - Journal: `active/personal/journal/<YYYY-MM-DD>.md`
  - TODO: `active/personal/today/TODO.md`
  - NOW: `active/personal/NOW.md`
- 面が見つからなくても MVP として `--out` 配下に `journal.md` / `todo.md` / `now.md` + `handoff.json` (`kind: daily-desk-handoff`) を書く。作業メモリ面への同期はオペレータ作業。
- POST `/export` … 上記ファイル書き出し
- POST `/load` … `--out` または作業メモリ面から再読込
- トークンヘッダ: `X-DD-Token`
- 書き出し成功時は `active/shared/observability/daily-desk/.../receipts/` に証跡を残す。

## Dry-run

```bash
node_modules/.bin/tsx scripts/daily-desk/server.ts --dry-run --json
```

## 注意

- ローカルトークンは人間承認の代替ではない（artifact-review-port 分類）。
- 127.0.0.1 のみで listen する。
