---
title: 知覚プレイブック（read / see / listen / watch — 感覚ごとに入口はひとつ）
category: Orchestration
tags:
  [
    orchestration,
    perception,
    ocr,
    stt,
    video,
    image,
    audio,
    html,
    markdown,
    vision-actuator,
    voice-actuator,
  ]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-25
role_affinity: [ecosystem_architect, knowledge_steward, researcher, analyst, mission_controller]
phase_affinity: [alignment, execution]
---

# 知覚プレイブック

エージェントが何かを**取り込む**（文書・Web ページ・スクリーンショット・録音・動画）ときは、感覚ごとにコマンドがひとつある。どれもリポジトリ内のファイルを読み、標準出力に Markdown を出し（`--json` で構造、`--out` でファイル出力）、ログは標準出力に混ぜず、既定で**ローカル完結**（データを外に出さない）。正本は英語版 [perception-playbook.md](./perception-playbook.md)。

## 1. 4つの感覚

| 感覚       | コマンド                                                       | 入力                                                 | エンジン（パイプライン op と共有）                                                               |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 文章を読む | `pnpm kyberion read <file> [--ocr]`                            | pdf, pptx, docx, xlsx/xlsm, html/htm, md, txt        | `@agent/core/document-reader` = `media:document_digest`                                          |
| 画像を見る | `pnpm kyberion see <image> [--describe]`                       | png, jpg, webp, gif, heic, tiff, bmp                 | `@agent/core/ocr-bridge`（ローカル）= `vision:ocr_image`、`--describe` = `vision:describe_image` |
| 話を聞く   | `pnpm kyberion listen <audio> [--timestamps]`                  | wav, mp3, m4a, aac, flac, ogg, opus, webm, caf, aiff | 音声認識シーム（`@agent/core/speech-to-text-bridge`）= `voice:transcribe`                        |
| 動画を見る | `pnpm kyberion watch <video> [--every <sec>] [--frames <dir>]` | mp4, mov, m4v, webm, mkv, avi                        | ffprobe/ffmpeg → コマは `see` の OCR、音声は `listen` へ                                         |

`watch` は新しいエンジンではなく組み合わせである。コマは `see` と同じく OCR し、音声トラックは `listen` と同じく文字起こしし、時系列に統合する（`## Transcript`、`### mm:ss` 見出し付きの `## Frames`。ほぼ同じコマは省く）。OCR で足りないとき（グラフ・図・人物）は `--frames <dir>` で抜き出したコマを PNG で残し、直接見る。

文書の詳細ルール（形式別エンジン・取込・OCR の罠）は [document-file-reading-playbook.ja.md](./document-file-reading-playbook.ja.md)。

## 2. まず目的を決める

| 目的                             | 使うもの                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| その場で理解する（保存しない）   | 上の感覚コマンド                                                                                   |
| 同じことをパイプライン内で       | `media:document_digest`, `vision:ocr_image`, `voice:transcribe`                                    |
| 議事録（話者・アクション）       | `pnpm minutes:record`（マイク実時間）/ `ingest:meeting_digest`（meeting-operations-playbook 参照） |
| テナントのナレッジとして取り込む | `pnpm ingest --tenant <slug> --file <file> [--ocr]`（文書・html・md）                              |
| Web ページ（URL）                | 外部通信が統制された `network:fetch` で保存し、保存したファイルを `read`                           |

## 3. 実行方法

```bash
mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<file> active/shared/tmp/<job>/
pnpm kyberion see    active/shared/tmp/<job>/screenshot.png --lang ja
pnpm kyberion listen active/shared/tmp/<job>/call.m4a --timestamps
pnpm kyberion watch  active/shared/tmp/<job>/demo.mp4 --every 5 --frames active/shared/tmp/<job>/frames
pnpm kyberion read   active/shared/tmp/<job>/page.html
```

警告は本文の後に `> [<command>] …` 行で出る。「何も出ない＝何もない」と扱わず、警告（文字起こしなし、コマの省略など）に対処する。

## 4. 罠

1. **入力はリポジトリ内に置く。** 一意な名前の `active/shared/tmp/<job>/` にコピーし、終わったら消す。
2. **`listen` には実際の音声認識バックエンドが必要。** スタブや合成結果は偽の文字を出さずに拒否する（終了コード 1）。`pnpm kyberion voice setup` で用意する。macOS の Apple Speech バックエンドは「音声認識」の権限も必要（`speech_permission_0` は未許可を示す）。`watch` では文字起こしなしは警告にとどまる。
3. **`--describe` は外に出る場合がある。** OCR はローカルだが、画像説明は解決された説明プロバイダに送られる（現状 macOS では該当なしで警告になる）。プロバイダがローカルでない限り機密画像に使わない。
4. **`watch` のコマ時刻はサンプリング位置**であり、動画から読んだ時刻ではない。`--every N` ならおよそ「長さ ÷ N」枚。スライドが速く変わるなら `--every` を小さくする。
5. **OCR は表の構造を失う**（文書プレイブックの罠 3 と同じ）。画像やコマ内の表・グラフは `--frames` で画像を見て書き起こす。
6. **知覚を自作しない。** `tesseract`、`whisper` / `mlx_whisper`、`ffmpeg … %04d.png` による連番コマの書き出し、pytesseract / cv2 / whisper のスクリプトはシェルポリシー（`media-hand-perception`）が拒否し、この文書へ案内する。通常の ffmpeg による制作作業（エンコード・合成）は対象外。

## 5. 対象外（現時点）

- **URL** — `read` は意図的に拒否する。リモートの内容は外部通信が統制された `network:fetch` を通す。
- **音楽・音声以外の音** — 解析エンジンはない（音楽生成のみ）。
- **行為側**（会話する・手を動かす・移動する） — [action-playbook.ja.md](./action-playbook.ja.md) を参照。
- **URL・いまの画面・作る側（`read` の逆）・記憶の軸** — どれに動詞があり、どれにないかは [capability-verb-inventory.ja.md](./capability-verb-inventory.ja.md) で管理する。
