# meeting-notepad — 会議メモパッド → 議事録 + handoff → Kyberion

sketch-input / report-review と同型の **127.0.0.1 限定ローカルポート**。メモ・口述・連続録音（+ STT）・カメラ/ファイル添付から議事録を作り、`handoff.json` を書き出して Kyberion に渡す。

外部リソース読込ゼロ（すべてインライン）。ファイル I/O は `@agent/core/secure-io` 経由。

## 構成 / Layout

| ファイル          | 役割                                                           |
| ----------------- | -------------------------------------------------------------- |
| `notepad-page.ts` | メモ UI（CSS+JS）の単一正本                                    |
| `server.ts`       | 127.0.0.1 で配信し、minutes / export / transcribe を受け付ける |
| `minutes.ts`      | メモ＋文字起こしから議事録 Markdown を生成                     |
| `context.ts`      | artifact / viewer / scope / receipt パス                       |

## 機能 / Features

- 会議タイトル・メモ・文字起こし・Kyberion 指示文
- 🎤ブラウザ音声認識 / OS ディクテーション（端末内・推奨）
- MediaRecorder による連続録音 → サーバ側 STT
- カメラ撮影 / ファイル添付
- **議事録を作成**（ローカル backend 経由）
- **Kyberionへ渡す**: 起動時に固定した出力先へ session + `handoff.json` を保存（MVP では mission 自動起動なし）

## 使い方 / Usage

```bash
KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/meeting-notepad/server.ts \
  [--out active/shared/tmp/meeting-notepad] \
  [--instruction "決定事項とアクションを整理して"] \
  [--title "週次ミーティング"] \
  [--artifact-ref artifact://… ] [--tier public|confidential|personal] [--tenant <slug>] \
  [port]
# → http://127.0.0.1:<port>/ を開く（既定ポート 8148）
```

- 保存先は起動時の1ディレクトリに固定・127.0.0.1 限定・トークン＋Origin 検査。
- confidential/personal はサーバー側スコープとして `KYBERION_TENANT` 必須。CLI の `--tenant` は検証用の一致確認にのみ使われます。
- 書き出し成功時は `active/shared/observability/meeting-notepad/.../receipts/` に証跡を残す。

### dry-run / check

```bash
node_modules/.bin/tsx scripts/meeting-notepad/server.ts --dry-run --json
```

## Kyberion での受け取り / Handoff

1. ブラウザでメモ・録音・添付を取り込み → 必要なら「議事録を作成」→ 「Kyberionへ渡す」
2. `<out>/handoff.json` と session 配下の成果物が書き出される
3. エージェント／オペレータが `handoff.json` のパスと指示を拾い、mission / pipeline で処理する

`handoff.json` の `processing.auto_start_mission` は MVP では `false`。

## Presence Studio

Presence Studio 内の議事録パネルは本パッドへ移行しました。Studio 側は起動手順の案内のみを表示します。

## セキュリティ / Security

- 🎤（Web Speech API）は機種により音声がブラウザ提供元クラウドへ送られる。機微な内容は OS ディクテーションを使う。
- ローカルトークンは人間承認の代替ではない（sketch-input / report-review と同じ分類）。
