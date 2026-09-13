# memory-capture — 個人ブレインダンプ → notes + handoff → Kyberion

meeting-notepad / sketch-input と同型の **127.0.0.1 限定ローカルポート**。メモ・タグ・宛先・音声入力から `notes.md` / `meta.json` / `handoff.json` を書き出して Kyberion に渡す。

外部リソース読込ゼロ（すべてインライン）。ファイル I/O は `@agent/core/secure-io` 経由。UI 文言は `resolveLocale()` の ja/en マップ（語彙カタログは後付け可）。

## 構成 / Layout

| ファイル     | 役割                                                           |
| ------------ | -------------------------------------------------------------- |
| `page.ts`    | メモ UI（CSS+JS）の単一正本                                    |
| `server.ts`  | 127.0.0.1 で配信し、`/export` を受け付ける                     |
| `context.ts` | `createLocalPadContext`（serviceId memory-capture, prefix mc） |

## 機能 / Features

- メモ textarea・タグ・宛先（memory / now / todo）・指示文
- 🎤 Web Speech → メモ欄 / localStorage 下書きの復元・消去
- **Kyberionへ渡す**: session 配下に `notes.md` + `meta.json` + `handoff.json`（MVP では mission 自動起動なし）
- `processing.suggested_ops` は文字列のみ（actuator 呼び出しなし）

## 使い方 / Usage

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/memory-capture/server.ts \
  [--out active/shared/tmp/memory-capture] \
  [--instruction "このメモを作業記憶に整理して"] \
  [--artifact-ref artifact://… ] [--tier public|confidential|personal] [--tenant <slug>] \
  [port]
# → http://127.0.0.1:<port>/ を開く（既定ポート 8149）
```

- トークンヘッダ: `X-MC-Token`
- confidential/personal はサーバー側 `KYBERION_TENANT` 必須
- 証跡: `active/shared/observability/memory-capture/.../receipts/`

### dry-run / check

```bash
node_modules/.bin/tsx scripts/memory-capture/server.ts --dry-run --json
```

## Handoff

`kind: memory-capture-handoff` — `notes_path`, `tags[]`, `target`, `instruction`, `processing.auto_start_mission: false`
