# screenshot-annotate — 画像注釈パッド → PNG + handoff → Kyberion

sketch-input の描画ツールを画像背景向けに流用した **127.0.0.1 限定ローカルポート**。貼り付け／ドロップ（推奨）または darwin `screencapture` で取り込み、注釈付き PNG と `handoff.json` を書き出す。

UI 文言は `resolveLocale()` の ja/en マップ（語彙カタログは後付け可）。

## 構成

| ファイル     | 役割                                                |
| ------------ | --------------------------------------------------- |
| `page.ts`    | ドロップ／貼り付け + canvas 注釈 UI                 |
| `server.ts`  | `/export`・`/screenshot`                            |
| `context.ts` | `createLocalPadContext`（screenshot-annotate / sa） |

## 機能

- 画像: 貼り付け / ドロップ / ファイル読み込み（MVP の主経路）
- 任意: `POST /screenshot` — `KYBERION_SCREENSHOT_PATH` があればその PNG、darwin なら `screencapture -x`（失敗時は 501、クラッシュしない）
- ツール: pen / rect / arrow / text / eraser / undo / clear
- 指示文 + 🎤 / Hand off → `latest.png` + `handoff.json`

## 使い方

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/screenshot-annotate/server.ts \
  [--out active/shared/tmp/screenshot-annotate] \
  [--instruction "この注釈を要件に整理して"] \
  [port]
# → http://127.0.0.1:8150/
```

- トークン: `X-SA-Token`
- dry-run: `node_modules/.bin/tsx scripts/screenshot-annotate/server.ts --dry-run --json`

## Handoff

`kind: screenshot-annotate-handoff` — `image_path`, `instruction`, `processing.auto_start_mission: false`
