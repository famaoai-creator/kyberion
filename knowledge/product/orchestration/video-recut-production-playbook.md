---
title: 動画素材からの字幕付き短縮編集
kind: playbook
scope: repository
authority: reference
phase: [alignment, execution, review]
role_affinity: [media_producer, ecosystem_architect]
tags: [video, recut, subtitles, hyperframes, source-map]
last_updated: 2026-10-19
---

# 動画素材からの字幕付き短縮編集

既存動画と対応する VTT 字幕を入力し、字幕間の長い空白を短くした動画を作る。
ナレーション原稿から映像を作る経路とは別で、元映像と元音声を同じ区間で切り出す。
取得元、作品名、クレジットは実装に固定せず、実行時の入力として扱う。

## 適用範囲

- public のローカル素材を扱う。入力 JSON、動画、字幕と明示指定の出力先はリポジトリの `active/shared/tmp/` 配下とする。
- confidential / personal / tenant の素材は受け付けない。共有領域へコピーして制限を回避しない。
- リモート動画の取得は含まない。取得・権利確認を済ませた素材を配置してから実行する。
- 字幕のない区間を無音とは判断しない。音楽・環境音・演出上の間が必要なら、素材を見て字幕・対象範囲・閾値を調整する。
- 音声認識、失敗テイクの意味判定、BGM・図の選定は別工程。まず既存の `watch` / `listen` で素材を把握する。

## 入力と実行

入力 JSON の例。パスは手元の素材に合わせる。字幕の時刻は元動画を基準にする。

```json
{
  "source_path": "active/shared/tmp/recut-input/source.mp4",
  "subtitles_path": "active/shared/tmp/recut-input/captions.vtt",
  "window": { "start_sec": 0, "end_sec": 20 },
  "padding": { "before_sec": 0.12, "after_sec": 0.18 },
  "gap_threshold_sec": 1.2,
  "attribution": {
    "title": "出典と編集内容",
    "lines": ["提供者と利用条件", "変更: 抜粋・間の短縮・字幕追加"],
    "duration_sec": 4
  }
}
```

`window` は省略すると全編。採用する字幕を途中で切る境界は指定しない。
出典表示は任意入力だが、素材の利用条件が求める場合は記載する。固定の作品名や出典は自動付与されない。

```sh
# 編集計画・時刻対応表・描画バンドルを準備する
pnpm exec tsx scripts/video_recut.ts --input active/shared/tmp/recut-input/request.json --json

# 同じ入力から、新規バンドルを準備して MP4 まで描画する
pnpm exec tsx scripts/video_recut.ts --input active/shared/tmp/recut-input/request.json --render --json
```

読み取りには ffprobe、描画には登録済み HyperFrames バックエンドと有効な描画ポリシーが必要。
描画は明示指定時だけ行い、失敗時は停止する。元映像を静止画の代替成果物に置き換えない。
`bundle_dir` を省略すると、workspace ledger に登録された専用作業領域へ出力する。
指定する場合は新規の一時領域を使い、既存成果物を上書きしない。

## 出力と確認

準備結果の JSON にバンドル、HTML、source map、尺が返る。描画時は MP4 のパスも返る。
source map には、採用した元動画の範囲と編集後の開始時刻、字幕の対応を残す。
元ファイルを保持し、バンドルには使用する素材をコピーする。

1. 元映像の順序、発話と字幕の対応、切り捨てた間が適切かを source map と動画で確認する。
2. `pnpm exec hyperframes check <bundle>` で描画を検査する。
3. `pnpm kyberion watch <output.mp4> --frames <scratch-frames>` で字幕・切り替え・出典表示を確認する。
4. 全編を音付きで試聴し、語頭・語尾の欠け、音の段差、字幕の読みやすさを確認する。技術検証だけで品質確認済みとしない。
5. 素材と尺を変えて再実行する。採用された判断を編集入力に残し、必要になった段階で上位の pipeline へ組み込む。

## 編集の判断

- カット: 言い直しや待ち時間の候補を整理し、意味・呼吸・感情のための間を残す。
- 字幕: 自然な意味単位で改行し、名前・数字・否定語を確認する。短縮後の時間へ必ず再配置する。
- 補助映像: 説明対象に対応する実画面・比較・図を選ぶ。現在の入口では自動生成・挿入しない。
- 強調: 通常・強調・注意の役割を設計し、全行を強調しない。見た目の追加は design-defaults へ集約する。
- 音: 声の聞き取りを優先する。効果音や BGM は試聴して採否を決める。

隣接する生成系の手順: [ナレーション動画制作](narrated-video-production-playbook.md)。
