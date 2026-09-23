# screenshot-annotate — 画像注釈パッド → PNG + handoff → Kyberion

sketch-input の描画ツールを画像背景向けに流用した **127.0.0.1 限定ローカルポート**。貼り付け／ドロップ（推奨）または darwin `screencapture` で取り込み、注釈付き PNG と `handoff.json` を書き出す。

画面は共有 A2UI キット（`ui:toolbar` / `ui:sketch-board`（画像は背景） / `ui:textarea` / `ui:voice-input`）で描画し、キットは同じサーバの `/shared-ui/*` から読む。文言は語彙カタログ `screenshot_annotate`（en / ja / qps-ploc）、言語はリクエストごと（`?lang=` → `kb-ui-locale` cookie → `Accept-Language`）。

## 構成

| ファイル             | 役割                                                   |
| -------------------- | ------------------------------------------------------ |
| `page.ts`            | ページ（`renderPadPage` + ブートストラップ）           |
| `annotate-client.js` | ブラウザ側モジュール（ツールバー・ボード・指示・音声） |
| `server.ts`          | `/export`・`/screenshot`                               |
| `context.ts`         | `createLocalPadContext`（screenshot-annotate / sa）    |

## 機能

- 画像: 貼り付け / ドロップ / ファイル読み込み（MVP の主経路）
- 任意: `POST /screenshot` — `KYBERION_SCREENSHOT_PATH` があればその PNG、darwin なら `screencapture -x`（失敗時は 501、クラッシュしない）
- ツール: pen / rect / arrow / text（インライン入力）/ eraser / undo / clear（`ui:dialog` で確認、背景は残る）/ PNG ダウンロード
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
