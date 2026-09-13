# clipboard-inbox — クリップボード受信箱 → items + handoff → Kyberion

meeting-notepad と同型の **127.0.0.1 限定ローカルポート**。貼り付けたテキストを一時保管し、`items.json` + `handoff.json` を書き出して Kyberion に渡す。

UI 文言は `resolveLocale()` の ja/en マップ（語彙カタログは後付け可）。

## 構成

| ファイル     | 役割                                            |
| ------------ | ----------------------------------------------- |
| `page.ts`    | リスト + 追加 / Pull / Hand off UI              |
| `server.ts`  | `/export`・`/clipboard-read`                    |
| `context.ts` | `createLocalPadContext`（clipboard-inbox / ci） |

## 機能

- アイテム一覧（プレビューは先頭 120 文字）・ラベル付き追加・削除
- **Pull clipboard**: darwin `pbpaste` / linux `xclip`（なければ 501、手動貼り付け）
- 指示文 + Hand off → session `items.json` + `handoff.json`
- `processing.redact_hint` で秘密情報への注意を明示

## 使い方

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/clipboard-inbox/server.ts \
  [--out active/shared/tmp/clipboard-inbox] \
  [--instruction "これらのクリップを整理して"] \
  [port]
# → http://127.0.0.1:8151/
```

- トークン: `X-CI-Token`
- dry-run: `node_modules/.bin/tsx scripts/clipboard-inbox/server.ts --dry-run --json`

## Handoff

`kind: clipboard-inbox-handoff` — `items_path`, `item_count`, `instruction`, `processing.auto_start_mission: false`
