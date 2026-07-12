# 秘書コンシェルジェ surface とダッシュボード視覚化 — 設計と実装

> **作成日**: 2026-07-03
> **依頼**: presence surface の一つとして秘書(コンシェルジェ)を。アバターがいて音声/テキストの会話ベース、軽量なものは direct_reply。軽量なら 3D モデル。ダッシュボードもより視覚的に(グラフ)。**ドキュメント作成の上で実装まで実施。**
> **位置づけ**: 設計 + 実装記録。関連: [COMPANY_OS_CONCEPT](./COMPANY_OS_CONCEPT.ja.md)、UX-01/02(体裁)、DS-01(トークン)、SU 系(UI 機能)。

---

## 1. 秘書コンシェルジェ surface

### コンセプト

「主権者(あなた)の窓口となる、もてなし(Omotenashi)の AI 秘書」。既存の `sovereign_concierge` role(PROCEDURE.md: 「Sovereign の第一インターフェース、Omotenashi と alignment を担う」)と `surface-concierge` specialist(`presence-surface-agent` に紐付く)を UI として具現化する。アバターが表情・状態で応答し、音声/テキストで会話。**軽い依頼(挨拶・能力質問・知識検索・天気/場所など)は direct_reply で即答**し、重い依頼は task_session/mission へ自動昇格する。

### アバターの設計判断 — 軽量2.5D を第一版、3D はオプション

「可能でリソース軽量なら 3D」という条件に対し、**軽量性を優先して 2.5D(SVG + CSS アニメ)を第一版**とする。理由:

- 既存の presence-studio が 2D SVG(`<img>` swap、4表情)で、CSP も無く self-contained。
- 3D(Three.js/WebGL)は依存が重く(バンドル増)、常時レンダリングで GPU/バッテリを食い、CSP・self-contained 原則とも相性が悪い。
- 2.5D なら SVG + CSS keyframe で「呼吸・瞬き・パルス・発話の口パク」まで表現でき、依存ゼロ・軽量で「生きている感じ」を出せる。

→ **3D は将来オプション**として §4 に設計を残す(GLB + 軽量ローダの遅延読み込み、`prefers-reduced-motion`/低スペック時は 2.5D フォールバック)。

### アバターの状態(2.5D、CSS アニメ)

| 状態      | 表現                                    |
| --------- | --------------------------------------- |
| idle      | ゆっくり呼吸(scale/opacity)、たまに瞬き |
| listening | 外周パルスリング + 傾聴の表情           |
| thinking  | 回転する思考ドット                      |
| speaking  | 口パク(mouth path アニメ)+ 波形         |
| error     | 静かな赤系グロー + 中立表情             |

### バックエンド接続(既存受け皿を再利用)

- **主経路**: コンシェルジェの Express server が voice-hub(:3032)の `POST /api/ingest-text`(`{text, intent, source_id, speaker, reflect_to_surface, auto_reply}`)へプロキシ。voice-hub が `generateReply` で応答を生成し、軽い依頼は `buildVoiceFallbackReply`(挨拶・能力・礼)or `runSurfaceMessageConversation` → `handleSurfaceQueryRoute`(direct_reply)で即答、重い依頼は task_session/mission へ昇格 + `buildAsyncAcceptedReply`。presence 反映と TTS も voice-hub が担う。
- **音声入力**: ブラウザネイティブの Web Speech API(chronos SovereignChat と同方式、サーバ STT 不要で軽量)。より高品質が必要なら voice-hub `/api/listen-once`(ネイティブ STT)へ切替可能。
- **フォールバック**: voice-hub 不在時は server が「秘書が今応答できません」を返す(無音の失敗を作らない、UX-01 原則)。

### direct_reply の判定(再確認)

`runSurfaceMessageConversation` → `resolveSurfaceIntent().routeFamily`。`direct_reply` かつ receiver 無し → `handleSurfaceQueryRoute`(knowledge_search/location/weather/web_search)。重い依頼は `shouldPromoteToMission` で mission へ。**コンシェルジェは判定ロジックを持たず、既存 orchestrator に委ねる**(型が実行の形を決める、ORCHESTRATION_HARNESS_MODEL §1)。

### 実装ファイル

- `presence/displays/concierge/server.ts` — Express: `/health`、static 配信、`POST /api/message`(voice-hub プロキシ)、`GET /api/state`(状態)。presence-studio と同構造(package.json 不要、ルート tsc でコンパイル → `dist/presence/displays/concierge/server.js`)。
- `presence/displays/concierge/static/index.html` — 2.5D アバター(インライン SVG + CSS アニメ)+ 音声/テキスト会話 UI(vanilla JS、Web Speech API、`/api/message` へ fetch)。self-contained。
- `knowledge/product/governance/surfaces/concierge.json` — surface manifest(kind `ui`, port 3033, healthPath `/health`)。
- 起動: `pnpm build && pnpm surfaces:reconcile`(または `PRESENCE_CONCIERGE_PORT=3033 node dist/presence/displays/concierge/server.js`)。

---

## 2. ダッシュボードの視覚化(chronos-mirror-v2)

### 設計判断 — 依存追加なしの self-contained SVG

chronos にはチャートライブラリが無く CSP も無い。既存 `FocusedOperatorView` が手書き SVG を使っている。→ **依存を増やさず self-contained SVG チャート**を作り、A2UI レジストリに登録して agent 駆動でも使えるようにする(既存 `display:gauge` 等と同列)。

### チャート種別と対象データ(即チャート化できる実データ)

| チャート                 | A2UI type             | データ源                                                       |
| ------------------------ | --------------------- | -------------------------------------------------------------- |
| ドーナツ(状態分布)       | `display:donut`       | agent health(ready/busy/error)、mission control-tone、runtime  |
| 横棒(カテゴリ別)         | `display:bar-chart`   | per-agent turn/error、owner summaries                          |
| 積み上げ棒(状態バケット) | `display:stacked-bar` | workCoordination(backlog/ready/inProgress/blocked/review/done) |
| スパークライン(時系列)   | `display:sparkline`   | trace の status/error を時間バケットで                         |

### シリーズ色(デザインシステム整合)

`--kb-accent`(cyan, primary)、`--kb-warning`(gold, warning)+ status palette(emerald=ok/ready/done, amber=busy/attention, rose=error, violet=secondary)。KyberionCharts 内でトークン参照 + status→色マップを定義(DS-01 の正準トークンと将来統合)。

### 実装ファイル

- `presence/displays/chronos-mirror-v2/src/components/KyberionCharts.tsx` — `KyberionDonut` / `KyberionBarChart` / `KyberionStackedBar` / `KyberionSparkline`(すべて self-contained SVG、props 駆動、数値は number で渡す = sanitizeProps 安全)。
- `A2UIComponentLibrary.tsx` の `A2UI_COMPONENT_REGISTRY` に 4 種を登録。
- `AgentPanel.tsx` の health 表示(text pills, :294-296)にドーナツを併設(実適用の実証)。

---

## 3. 実装の検証

- chronos: `pnpm --dir presence/displays/chronos-mirror-v2 build`(next build --webpack)で型・ビルド確認。
- concierge: ルート `tsc`(build:repo)で `server.ts` がコンパイルされることを確認。static はビルド不要。
- 起動確認(可能な範囲): concierge server を起動し `/health` を叩く。

---

## 4. 将来オプション: 3D アバター

軽量性の条件が緩む場合の 3D 設計(本実装ではスコープ外、設計のみ):

- **形式**: GLB(単一ファイル、圧縮)を data URI or static で同梱。self-contained を保つ。
- **ローダ**: `<model-viewer>`(web component、比較的軽量)or 最小 Three.js を遅延読み込み。CSP が導入された場合は self-host。
- **段階的縮退**: `prefers-reduced-motion` / 低スペック(hardwareConcurrency 低、WebGL 不可)検出時は 2.5D SVG にフォールバック。
- **状態マッピング**: 2.5D と同じ状態(idle/listening/thinking/speaking/error)を 3D のアニメーションクリップ or morph target に対応させる。
- **口パク**: TTS の音素/振幅を viseme に写像(voice-hub の TTS からタイミングを受け取る)。
- 3D は「見栄え」の投資であり、機能(会話・direct_reply)は 2.5D で完結する。導入は体験評価の上で判断。

---

## 5. 実装記録(2026-07-03 実装・検証済み)

### 実装したファイル

**秘書コンシェルジェ surface**

- `presence/displays/concierge/server.ts` — Express。**再実装(2026-07-03, Fable 5): SPOF 除去の二経路 + 優雅な縮退**。(1) 主経路 = voice-hub `/api/ingest-text`(挨拶/能力Q&A + orchestrator + server-side TTS + presence 反映)、(2) 不達時 = **`@agent/core` を lazy import して `runSurfaceMessageConversation` を直接呼ぶ縮退経路**(chronos と同パターン。知識検索・ミッション化を voice-hub 無しで維持。happy path では orchestrator を読み込まず軽量)、(3) 両方失敗で実行可能な 503。`/health` は **voice-hub 到達性を probe** し `conversationMode`(voice-hub / orchestrator-fallback)を返す。エラーは実内容をログ(無音の失敗なし)。static は `pathResolver.rootDir()` 解決、127.0.0.1 バインド、ルート tsc でコンパイル。
- `presence/displays/concierge/static/index.html` — self-contained。2.5D SVG アバター(呼吸・瞬き・パルスリング・思考ドット・口パクを CSS keyframe で表現、5状態: idle/listening/thinking/speaking/error)+ 会話 UI(vanilla JS)+ Web Speech API 音声入力 + SpeechSynthesis 読み上げ + `/api/message` fetch。dark KDS テーマ(cyan accent)、日本語 UI、`prefers-reduced-motion` 対応。
- `knowledge/product/governance/surfaces/concierge.json` — surface manifest(kind `ui`, port 3033, healthPath `/health`)。

**ダッシュボード視覚化**

- `presence/displays/chronos-mirror-v2/src/components/KyberionCharts.tsx` — self-contained SVG チャート4種(`KyberionDonut`/`KyberionBarChart`/`KyberionStackedBar`/`KyberionSparkline`)+ デザイントークン整合の status→色マップ(`KB_SERIES`)。
- `A2UIComponentLibrary.tsx` — レジストリに `display:donut`/`display:bar-chart`/`display:stacked-bar`/`display:sparkline` を登録(agent 駆動でも利用可)。
- `AgentPanel.tsx` — エージェント健全性(ready/busy/error)をドーナツで可視化(実適用の実証)。

### ビルド・動作検証

- **ルート tsc**(`build:repo` 相当): exit 0、エラー 0。`dist/presence/displays/concierge/server.js` 生成を確認。
- **chronos next build**(`build:ui`): 正常完走(チャート関連のコンパイルエラー・Module not found なし)。
- **concierge 起動確認(初版)**: `/health` 200、static UI 200、voice-hub 不在時の `/api/message` は 503 + 明確なメッセージ。
- **concierge 再実装後の検証(2026-07-03)**: tsc exit 0 / eslint クリーン / static JS 構文 OK。起動して `/health` が `voiceHubReachable:false, conversationMode:orchestrator-fallback` を返すこと、`/api/message`(voice-hub 停止)が voice-hub 失敗をログ→**orchestrator 縮退経路を実際に試行**→(検証環境にバックエンド無しのため)実行可能な 503、を確認。ハングなし・SPOF 除去を実証。バックエンドのある環境では voice-hub 無しでも実応答を返す。

### 起動方法

1. `pnpm build`(全体ビルド)
2. `pnpm surfaces:reconcile`(manifest を surface レジストリへ登録)、または直接 `PRESENCE_CONCIERGE_PORT=3033 node dist/presence/displays/concierge/server.js`
3. ブラウザで `http://127.0.0.1:3033` を開く。会話するには voice-hub(:3032)を起動しておく(`VOICE_HUB_PORT=3032` で voice-hub server)。voice-hub 未起動でも UI・アバターは動作し、送信時に明確なガイドを返す。
4. チャートは chronos-mirror-v2(`pnpm chronos:dev` or ビルド済み)の Agent Registry パネルで確認できる。

### 既知の制約・今後

- **会話バックエンドは voice-hub 依存**(direct_reply/mission 判定・TTS を委譲)。voice-hub 未起動時は UI のみ動作。将来、server から直接 `runSurfaceMessageConversation` を呼ぶ経路を足せば voice-hub 非依存にできる。
- **アバターは 2.5D**(軽量優先)。3D は §4 の設計に沿って将来オプション。
- **統制未接続**: 現状ローカル(127.0.0.1)バインドのみ。SA 系(承認・egress・認証)の統制は未接続で、外部公開前に要接続。
- **surface 登録・起動はユーザー操作**(常駐プロセスを増やすため、`pnpm surfaces:reconcile` は明示実行)。
