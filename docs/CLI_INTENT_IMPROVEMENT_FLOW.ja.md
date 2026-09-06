---
title: CLI インテント実行・改善ループ
tags: [cli, intent, procedure, approval, feedback, distill]
last_updated: 2026-08-10
---

# CLI インテント実行・改善ループ

`pnpm kyberion` を最初の利用入口とし、インテント解決から実行結果の改善候補化までを同じ相関で追跡する。

## 基本導線

```text
intent
  → procedure candidate
  → inspect / preflight
  → approval gate
  → execute
  → execution feedback
  → distill candidate
  → human review
  → procedure update
```

## CLI操作

```sh
pnpm kyberion intent "<request>" --locale ja
pnpm kyberion procedure list
pnpm kyberion procedure inspect <procedure-id>
pnpm kyberion procedure run <procedure-id> --inputs '{}' --record-video --record-trace
pnpm kyberion feedback <intent-id> \
  --outcome partially_satisfied \
  --correction "対象範囲を確認してから実行する" \
  --correlation-id <correlation-id>
pnpm kyberion improvements
pnpm kyberion improvements --approve <candidate-id>
```

`procedure run` は手順の substrate に応じて既存の dispatcher を使う。サービス手順はそのまま実行し、ブラウザ手順は Playwright 基板(`execution_substrate: playwright`)で `browser-actuator` を起動する。既定はスタンドアロン Chromium（`--tab-id` 不要）。既存 Chrome に付けるときだけ `--cdp-url` / `--cdp-port` と任意の `--tab-id` を渡す。同じ入口として `pnpm kyberion browser run --procedure-id <id>`（カタログ）/ `--recording <path>`（承認済み録画）/ `--adf <example.json>`（手書き example）がある。ブラウザのtrace/videoは既定で有効で、結果JSONの`evidence`に保存先を返す。既存ChromeへCDP接続する場合にvideoが利用できなければ、`video_recording_pending`等の状態を返し、未取得を成功扱いにしない。

## OS実演（desktop / screen evidence）

ブラウザ以外のGUI操作は、OS観測と画面証跡を同じCLIから開始する。

```sh
pnpm kyberion record desktop --duration 30 --fps 1 --locale ja
pnpm kyberion recording inspect active/shared/runtime/recordings/<recording-id>.json
pnpm kyberion recording review active/shared/runtime/recordings/<recording-id>.json --approve-recording --approve-intent
pnpm kyberion procedure promote <id> \
  --substrate desktop \
  --recording active/shared/runtime/recordings/<recording-id>.json \
  --intent "<request>"
pnpm kyberion intent "<request>" --substrate desktop --locale ja
pnpm kyberion procedure run <id> --inputs '{}'
```

`record desktop` はOSイベント・アクティブウィンドウ・AX情報を手順再構成用に収集し、画面MP4を証跡として保存する。映像だけを手順の根拠にせず、観測イベントを一次情報として扱う。画面取得権限がない場合は画面証跡を `unavailable` と明示し、OS記録を黙って欠落させない。

ネイティブイベントを取得できなかった場合も、記録自体は破棄せず `state-observation-only` の観測証跡として保存する。ただし手順昇格は許可せず、CLI はアクセシビリティ権限を有効にして再記録する次の一手だけを提示する。昇格可能な記録は `recording_hash`、OSイベント、レビュー状態、画面MP4の実体ハッシュを保持し、`pipelines/desktop/<procedure-id>.json` と個人手順カタログへ同一の記録参照・ハッシュを登録する。

画面録画が利用できない環境でもOSイベントと観測記録は独立して検証される。MP4が作成された場合はファイルのSHA-256を記録本体に含め、昇格時に実ファイルと再照合する。これにより、画面証跡の欠落を成功扱いにせず、映像だけを実行契約にすることも防ぐ。

CLI出力は統一locale解決を使う。`--locale en|ja|qps-ploc`、`KYBERION_LOCALE`、identity、OS localeの順で解決され、今回のrecorder導線の表示文言は vocabulary catalog から取得する。

## 安全境界

- `intent` が曖昧な場合は実行せず候補を表示する。
- 録画が未レビュー、対象originが不一致、またはrecording hashが不一致の場合は停止する。
- 高リスク操作は `pnpm kyberion approvals` の人間承認を通過するまで実行しない。
- 入力値やsecretは手順録画へ保存しない。実行時入力としてのみ渡す。
- `feedback` は実行手順を直接書き換えず、`distill-candidate` を `proposed` で作成する。
- `improvements --approve` は改善候補を人間レビュー済みにするが、手順カタログは自動変更しない。実装・検証後に governed promotion で反映する。

## UIへの拡張

Presence Studio、Operator Surface、ブラウザ拡張はこのCLIの各状態を表示するUIとして実装する。UIから独自に実行・昇格を実装せず、intent resolution、dispatcher、approval store、execution feedback、distill candidate registryを共有する。
