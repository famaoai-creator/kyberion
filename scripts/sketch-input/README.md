# sketch-input — ブラウザ描画ボード → PNG + handoff → Kyberion

report-review と同型の **127.0.0.1 限定ローカルポート**。ペイント風に図・テキストを描き（指示文は音声入力可）、PNG と `handoff.json` を書き出して Kyberion に渡す。

外部リソース読込ゼロ（すべてインライン）。ファイル I/O は `@agent/core/secure-io` 経由。

## 構成

| ファイル         | 役割                                                        |
| ---------------- | ----------------------------------------------------------- |
| `sketch-page.ts` | 描画 UI（CSS+JS）の単一正本                                 |
| `server.ts`      | 127.0.0.1 で配信し、`/export` で PNG + handoff を直書き保存 |
| `context.ts`     | artifact / viewer / scope / receipt パス                    |

## 機能

- ペン / 矩形 / 楕円 / 直線 / 矢印 / テキスト / 消しゴム / Undo / 消去
- Kyberion への指示文: **キーボード / OSディクテーション（端末内・推奨） / 🎤ブラウザ音声認識**
- PNG ダウンロード（ブラウザ側）
- **Kyberionへ渡す**: 起動時に固定した出力先へ PNG + `.handoff.json` を保存（MVP では mission 自動起動なし）

## 使い方

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/sketch-input/server.ts \
  [--out active/shared/tmp/sketch-input/latest.png] \
  [--instruction "この図を要件として整理して"] \
  [--artifact-ref artifact://… ] [--tier public|confidential|personal] [--tenant <slug>] \
  [port]
# → http://127.0.0.1:<port>/ を開く（既定ポート 8147）
```

- 保存先は起動時の1パスに固定・127.0.0.1 限定・トークン＋Origin 検査。
- confidential/personal は `--tenant`（または `KYBERION_TENANT`）必須。
- 書き出し成功時は `active/shared/observability/sketch-input/.../receipts/` に証跡を残す。

### dry-run / check

```bash
node_modules/.bin/tsx scripts/sketch-input/server.ts --dry-run --json
```

## Kyberion での受け取り

1. ブラウザで描画 → 指示を入力（必要なら🎤）→ 「Kyberionへ渡す」
2. `<out>.png` と `<outの拡張子なし>.handoff.json` が書き出される
3. エージェント／オペレータが `handoff.json` の `image_path` + `instruction` を拾い、vision / mission / pipeline で処理する

`handoff.json` の `processing.auto_start_mission` は MVP では `false`。

## セキュリティ

- 🎤（Web Speech API）は機種により音声がブラウザ提供元クラウドへ送られる。機微な内容は OS ディクテーションを使う。
- ローカルトークンは人間承認の代替ではない（report-review と同じ分類）。
