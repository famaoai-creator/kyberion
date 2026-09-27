---
title: 能力動詞の棚卸し（どの能力が一語になっていて、どれがなっていないか）
category: Orchestration
tags:
  [
    orchestration,
    perception,
    action,
    memory,
    cli,
    verbs,
    inventory,
    document-generation,
    media,
    working-memory,
  ]
importance: 7
author: Ecosystem Architect
last_updated: 2026-09-27
role_affinity: [ecosystem_architect, knowledge_steward, mission_controller, operator]
phase_affinity: [alignment]
---

# 能力動詞の棚卸し

[perception playbook](./perception-playbook.ja.md) は感覚ごとに 1 コマンドを与え、
[action playbook](./action-playbook.ja.md) は行為を対象ごとに分けている。本書はその
上の層で、**どの能力が既に一語で届いていて、どれが op やパイプライン経由しかなく、
どれがそもそも存在しないか**を記録する。次に能力を整理するとき、既に入口があるもの
に 2 つ目の入口を足してしまわないための台帳である。
英語版（正典）: [capability-verb-inventory.md](./capability-verb-inventory.md)。

## 1. 一語動詞を与えてよい条件

一語の動詞が正当化されるのは、**形式やデバイスを 1 つの契約の裏に隠す統合 op が既に
ある場合だけ**。`read` がその模範で、`media:document_digest` が `pdf_extract` /
`pptx_extract` / `docx_extract` / `xlsx_extract` を吸収しているため、CLI は 5 つでは
なく 1 つの動詞で足りる。

統合 op がなく、承認ゲートが本当に異なる場合は、能力は**対象ごとに分かれたまま**に
する。行為側に単一の `do` がなく `browser-actuator` / `system-actuator` /
`terminal-actuator` に分かれているのはそのため。統合 op なしに動詞を足すのは、分岐を
CLI に移すだけになる。

## 2. 取り込む ↔ 出す

| 方向                | 統合 op                                 | 動詞                   | 状態                              |
| ------------------- | --------------------------------------- | ---------------------- | --------------------------------- |
| 文書 → テキスト     | `media:document_digest`                 | `pnpm kyberion read`   | 統合済み                          |
| ブリーフ → 文書     | `media:generate_document`               | `pnpm kyberion write`  | 統合済み                          |
| 画像 → テキスト     | `vision:ocr_image` / `describe_image`   | `pnpm kyberion see`    | 統合済み                          |
| 指示 → 画像         | `media-generation:generate_image`       | `pnpm kyberion draw`   | 統合済み                          |
| 音声 → テキスト     | `voice:transcribe`                      | `pnpm kyberion listen` | 統合済み                          |
| テキスト → 音声     | `voice:generate_voice` / `speak_local`  | `pnpm kyberion speak`  | 統合済み                          |
| 動画 → タイムライン | フレーム＋書き起こしの合成              | `pnpm kyberion watch`  | 統合済み                          |
| ブリーフ → 動画     | `video-composition:*`, `generate_video` | —                      | **動詞がなく、エンジンが 2 系統** |

`write` は §1 の実例。`media:generate_document` は既に `render_target`
（pptx / docx / xlsx / pdf）で分岐しており、形式ごとの `pptx_render` / `docx_render` /
`xlsx_render` / `pdf_render` は既に互換アダプタ扱いだった（`warnLegacyMediaOp` が
`document_outline_from_brief → brief_to_design_protocol → generate_document` を案内）。
統合 op が既にあったので、動詞はその薄い入口で済み、自前の分岐を持たない。
`pnpm kyberion write <brief.json> --out <file>` は描画対象を `--to` →
ブリーフの `render_target` → `--out` の拡張子の順で解決し、テーマとレイアウトは
デザインのカスケードに任せる。成果物ごとの手引きは
[presentation-authoring-playbook](./presentation-authoring-playbook.md)、
[blog-authoring-playbook](./blog-authoring-playbook.md)、
[narrated-video-production-playbook](./narrated-video-production-playbook.md)
にある。

`draw` は `see` の逆。統合層は画像生成ブリッジ（`libs/core/media/image-generation-bridge.ts`
の `generateImage` / `planImageGeneration`）で、プロバイダの選択は既に 1 つのルーターに
隠れていた。行が空だった理由は外部送信の判断だったので、動詞はそこだけを受け持つ。
既定では、データを端末の外に出さず無人で完了するプロバイダだけが候補になる。
`--allow-cloud` でクラウドのプロバイダを、`--allow-handoff` でホストエージェントへの
委譲を最後の手段として加える（終了コード 100。同じコマンドの再実行で回収するのは、その依頼に対して
ホストが保存した画像だけで、元からあったファイルは回収しない — `libs/core/host-image-handoff.ts`）。
この制限はルーターがすべての選択経路で適用する明示的な許可リスト
（`ImageGenerationRequest.allowedProviders`）で実装している。`mode: 'local_only'` だけでは
足りない。ホストブリッジはローカルで動くが、依頼をホストエージェントのモデルに転送するため。
参照画像（`--ref`）は PA-10 に従う。クラウドまたは委譲先のプロバイダには、そのプロバイダを
名指しした実行ごとの同意が必要で、`--dry-run` で送信前にどこへ送られるかを確認できる。

動画の行は、まだ**同じ扱いにできない**。エンジンが 2 系統（ナレーション合成の
`video-composition:*` とモデル生成の `generate_video`）あり、選択を隠す統合 op がない。

## 3. ファイルでない入力

感覚動詞はいずれもリポジトリ内のパスを取る。そのため実務で最も多い 2 つの入力に動詞
が対応していない。

| 入力             | 現状                                                                                                         | まだ動詞でない理由                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| URL / Web ページ | `network:fetch`（外部通信統制）で保存 → 保存ファイルを `read`                                                | `read` は意図的に URL を拒否（`document-reader.ts`）。fetch を畳み込むと外部通信の判断が感覚動詞の下に入る |
| いまの画面       | `media-generation:capture_screen` / `capture_focused_window`、`system:list_displays`、`system:record_screen` | capture は画面フレームの遮蔽を適用し行為側に属する。`see` はファイルしか読まない                           |

2026-09-27 解決（MSN-CAPTURE-RECORD-20260927）: capture は 2 動詞になった。
`pnpm kyberion capture [--screen|--window|--camera]`（静止画。`system:screenshot` / `system:capture_photo` 経由）と
`pnpm kyberion record screen|audio|camera`（時系列。`system:record_screen` / `system:record_audio` / `system:record_camera` 経由）。
遮蔽ゲートはアクチュエータ側に残し、動詞は引数解釈とリポジトリ境界だけを持つ。`see` は設計通りファイルのみ。
未対応: `read <url>`（外部通信ゲートが未解決）、明示の `browser:record`（セッション生命定数が必要なため意図的に延期）、モバイル動画（デバイスブリッジなし）。

どちらも現状 2 段で、1 動詞（`read <url>`、`see --screen`）に畳むのは容易。論点は
エンジンの有無ではなく、外部通信・遮蔽のゲートをどこで評価するか。

## 4. ライブ vs 録ったもの — 唯一の語の衝突

`listen` と `speak` はそれぞれ 2 つの異なるものを指している。

| 語       | ファイル／バッチの意味                                | ライブ／ストリームの意味                                               |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `listen` | `pnpm kyberion listen <audio>`（録音の書き起こし）    | `meeting:listen`（capture op）、`pnpm minutes:record`（マイク実時間）  |
| `speak`  | `pnpm kyberion speak "<text>"`（TTS、ファイル出力可） | `meeting:speak`、`pnpm kyberion voice conversation-turn`（実時間対話） |

これは統合すべき重複ではない。録音とライブストリームは失敗モードが異なり、同意要件も
異なる（`meeting:check_consent`）。両方が現れる場所では **2 つの軸として明示**し、
「listen」を選ぶエージェントが自分が扱うのはファイルかセッションかを判別できるように
する必要がある。

## 5. 第 3 の軸：記憶

知覚と行為は整理されているが、記憶は整理されていない。入口が無関係な 3 つの面に散って
いる。

| 目的                     | 入口                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 作業状態を書く／思い出す | `working-memory` ドメイン（`note`, `read`, `list`, `daily-open`, `weekly-open`, `todo-*`, `nominate-promotion`） |
| 蓄積ナレッジを探す       | `wisdom:knowledge_search` / `knowledge_read` / `knowledge_inject`、`pnpm knowledge`                              |
| 過去セッションを探す     | `wisdom:history_search`、`pnpm history:search`                                                                   |
| テナントに取り込む       | `pnpm ingest --tenant <slug> --file <file>`                                                                      |

この軸を扱う playbook はなく、「覚える」「思い出す」に相当する動詞もないため、同じ
探索がミッションごとに再発明されている。未整理領域としては最大。ただし §2 §3 と違い、
CLI 入口より先に概念の決定（何を working memory に置き、何を `knowledge/` に置くか）が
必要。

## 6. 存在しないと判明している能力

再調査を防ぐために記録する。

- **音楽・非音声オーディオの解析** — 生成のみ（`generate_music`）で解析エンジンは
  ない。perception playbook に既記載。
- **物理的な移動** — ロボティクス／GPS の層はない。「移動」は hands 実行系の中での
  フォーカス変更。action playbook に既記載。
