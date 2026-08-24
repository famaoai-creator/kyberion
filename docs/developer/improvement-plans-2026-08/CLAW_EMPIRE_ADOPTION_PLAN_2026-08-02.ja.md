---
title: CLAW EMPIRE ADOPTION PLAN 2026 08 02
tags: [improvement-plan, 2026-08]
last_updated: 2026-08-25
status: active
---

# claw-empire 分析・採択計画(CE-01〜12)

> **作成日**: 2026-08-02
> **分析対象**: [GreenSheep01201/claw-empire](https://github.com/GreenSheep01201/claw-empire) @ `66a24ea`(v2.0.4 相当。clone はセッション一時領域、分析後に削除可)
> **位置づけ**: OPENHARNESS / KIMI / QM 採択計画と同型の「外部システム分析 → kyberion への選択的取り込み」計画。**主対象は UI/可視化**(オペレータが元々構想していた領域 — SU-01〜04 / UX-02 / UX-07 / MO-09 / ONB-04 の後続)で、Chronos operator console(`presence/displays/chronos-mirror-v2`)と Terminal HUD の双方に射影する。
> **前提**: kyberion の非目標(SaaS 化・マルチテナント GUI)は維持。claw-empire の「会社シミュレーションゲーム」性そのものではなく、**抽象状態を身体的状態へ写像する可視化文法と、それを支える実時間同期規律**を選択採用する。

## 1. claw-empire とは何か(要約)

claw-empire は自己ホスト型の「AI エージェント会社シミュレータ」。ユーザーは CEO としてドット絵オフィスを歩き、CLI エージェント(Claude Code / Codex / Gemini / OpenCode 等 7 種)が部署の「社員」として実タスクを実行する。フロントは Vite + React 19 + **PixiJS 8**(オフィスは WebGL、他は DOM)~44k 行、バックは Express + ws + SQLite。タスク生成 → 部署/社員への自動アサイン → CLI サブプロセス実行 → 進捗のオフィス可視化 → 部署別レポート統合、が中核ループ。XP/レベル、会議(議事録)、意思決定インボックス、Telegram 連携、スキル学習を備える。

### kyberion との構造対比

| 軸           | claw-empire                                                                                                                           | kyberion                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web 表面     | Vite+React SPA(6 ビュー + Pixi オフィス)に一元化                                                                                      | **7 表面 3 スタック**に分散(Chronos / concierge / MOS / computer-surface / presence-studio / terminal-bridge / virtual_office。共有コンポーネント層なし — SR-01 残余)                                                                      |
| 実時間同期   | WS 15 イベント種 = **無効化シグナル**、REST が正本。等価性ベイルアウト + サーバ側種別別バッチング                                     | 表面はポーリング中心。event bus(JSONL + fs.watch)への単一購読エンドポイントなし                                                                                                                                                            |
| ワーカー出力 | `cli_output` WS ストリーム(250ms バッチ)+ ブラウザ側サブエージェント検出                                                              | KC-02 worker event stream(構造化済み)。オペレータ表面への実時間投影なし                                                                                                                                                                    |
| 状態可視化   | エージェント状態 + quota 消費を**身体的状態**(汗・ベッド・休憩室)へ写像                                                               | オフィスメタファーは **`scripts/virtual_office.ts`(`pnpm office`)として既に存在**(部屋=ミッション・休憩室・SVG キャラ・working/review/blocked/idle)— ただし静的 HTML 生成 + meta-refresh の袋小路で、surface manifest 外・ドリルダウン不能 |
| 資源会計     | **token/コスト会計は不在**(provider quota のポーリングのみ。pack の `cost_profile_json` は保存されるが実行時に一切読まれない死に設定) | OP-01 コスト会計 + Chronos cost API(この軸は kyberion が優位)                                                                                                                                                                              |
| 介入         | pause → interrupt proof → inject → resume(端末ドロワーから)                                                                           | SO-04 steering + 承認フロー(表面からの一気通貫 UI なし)                                                                                                                                                                                    |
| 品質ゲート   | Playwright+CDP で **fps/heap の性能ベースライン CI**、コントラスト監査                                                                | `check:chronos-dom-contrast` / DS-05/06(性能ゲートなし)                                                                                                                                                                                    |

**採択の基本判断**: claw-empire の最大の資産は (a) 「派手なレンダラを WS 洪水の下で安全に保つ同期規律」と (b) 「メトリクスを読ませず身体状態で見せる可視化文法」の 2 点で、いずれもレンダリング技術(Pixi)と独立に kyberion へ移植できる。ゲーム性の器(歩行操作・スプライト素材・会議エンジン)は採らない(§3 非採用)。

## 2. 改善項目一覧

| ID    | タイトル                                                        | 優先度 | 規模 | 対応する既存計画                            |
| ----- | --------------------------------------------------------------- | ------ | ---- | ------------------------------------------- |
| CE-01 | ライブ同期規律(無効化シグナル + 正本 REST + 等価性ベイルアウト) | **P0** | M    | UX-02 / SU-02 後続                          |
| CE-02 | ワーカーイベント単一購読エンドポイント(SSE)と種別別バッチング   | **P0** | M    | KC-02 / GE-08 後続                          |
| CE-03 | オフィスビューの昇格(virtual_office → Chronos、状態差分駆動)    | **P1** | L    | AO-05 / CO-06 / UX-07 / MO-09 / ONB-04 後続 |
| CE-04 | 資源消費 → 視覚的重症度ラダー(quota・demotion の身体化)         | **P1** | S    | OP-04 / XP-04 後続                          |
| CE-05 | ライブ端末ビュー + 進行ヒント + 介入ループ                      | **P1** | M    | SU-02 / SO-04 後続                          |
| CE-06 | ストリーム消費の有界化規律(前置フィルタ・尾部バッファ・上限)    | P2     | S    | AA-04 / KC-02 後続                          |
| CE-07 | 役割別セクション + 統合の完了報告レンダリング                   | P2     | M    | MO-08 / SU-03 後続                          |
| CE-08 | 可視化の性能・コントラスト CI ゲート                            | P2     | S    | DS-05 / DS-06 後続                          |
| CE-09 | 手続き的テーマ導出(accent+tone → パレット、YIQ 可読性)          | P3     | S    | DS-01 / DS-02 後続                          |
| CE-10 | エージェント実績の蓄積表示(XP/ランク)                           | P3     | S    | NI-01 / AO-05 後続                          |
| CE-11 | 一発助言実行の no-tools 強制 + 漏出ガード                       | P2     | S    | KD-05 / SA-02 後続                          |
| CE-12 | 多信号の孤児 run 生存判定と完了リプレイ                         | P2     | S    | QM-01 / MO-06 後続                          |

---

### CE-01: ライブ同期規律(P0 / M)

**claw-empire の設計**: `useLiveSyncScheduler` — WS イベントの大半は再取得予約(60〜160ms 合流)に落とし、実データは `Promise.all` の一括 REST 取得を正本とする。in-flight ガード + 再取得キューフラグ、そして **深い等価比較によるベイルアウト**(`areTaskListsEquivalent` 等)で「変わっていなければ React 状態の同一性を保つ」— これが高価なレンダラ(Pixi 全再構築)を洪水の下で成立させている唯一の防壁。細粒度イベント(`agent_status` 等)のみ楽観的に単体パッチ。5 秒間隔の背景同期は `visibilitychange` で停止/再開。

**kyberion の現状**: Chronos は API ルート群への個別ポーリングが中心。唯一の SSE `/api/intelligence/stream` は **~2 秒ごとにスナップショット全再収集 + diff という擬似リアルタイム**で、更新通知→合流取得→等価ベイルアウトの規律がない。Terminal HUD も chokidar + 5 秒間隔の全再読込で、subprocess アクション中は UI がブロックする。

**実装**:

1. `presence/displays/chronos-mirror-v2/src/lib/live-sync.ts` を新設: 無効化シグナル受信(CE-02 の SSE)→ 合流窓付き一括再取得 → 種別ごとの等価比較ベイルアウト。既存 `hooks.ts` のポーリングをこの経路へ段階収束。
2. `visibilitychange` / フォーカス喪失で背景同期を停止し、復帰時に一回全量取得。
3. Terminal HUD 側も同型のヘルパ(イベント合流 + 差分がある panel のみ再描画)を `libs/terminal-hud` に導入。

**受入条件**: 同一データ再取得で React 状態参照が変わらないテスト / イベント 100 連発が 1 回の再取得に合流するテスト / 非表示タブで背景同期が止まるテスト。

### CE-02: ワーカーイベント単一購読エンドポイント(P0 / M)

**claw-empire の設計**: 単一 WS チャネルに 15 イベント種。サーバ hub が**種別ごとのバッチ窓**(`cli_output` 250ms、`subtask_update` 150ms。初発は即時、キュー上限 60 で最古 shed)を持つ。クライアントは `on(type, handler)` の宣言的購読。

**kyberion の現状**: 発生源は揃っている — `WorkerEventStream`(`libs/core/worker-event-stream.ts`、zod 検証済み 20 種イベント + JSONL recorder)、agent-collaboration-event v1 + 決定的 projection、mission-control イベントログ、heartbeats、run graphs。しかし **WorkerEventStream はプロセスローカル**(`Symbol.for` のプロセスグローバル)で別プロセスの UI は購読できず、全 UI がディスク上の JSONL ポーリングへ縮退している。UX-07 Phase 3 で `/api/collaboration/stream`(SSE)は**明示的に先送りされたまま未実装**。

**実装**(= UX-07 の先送り分の実装を、claw-empire の hub 仕様で行う):

1. Chronos API に `GET /api/collaboration/stream`(SSE)を新設。転送は JSONL tail(worker-events / mission-control / heartbeats 差分 / run-graph 更新)を単一ストリームへ投影する — WorkerEventStream 本体はプロセスローカルのままにし、**recorder が書く JSONL を正本とする**(新しい IPC は増やさない)。tier ゲートは既存 api-guard に従い、public 投影のみを既定とする。
2. 種別別バッチ窓と上限付きキューをサーバ側に実装(claw-empire hub と同仕様: 初発即時 + 窓合流 + 上限 60 最古 shed)。
3. イベントに GE-08 の `trace_id`/`artifact_path` を携行し、UI から trace/run-graph へ辿れるようにする。
4. 再接続は指数バックオフ + `Last-Event-ID` による取りこぼし再送(JSONL の日付 + オフセットを ID に使う)。UX-07 の成功指標 `p95 ≤ 2s` の実測計装(受信ラグ)もここで入れる。

**受入条件**: SSE 経由で mission/work-item/provider/worker イベントが届く統合テスト / 高頻度種別がバッチされるテスト / tier 外イベントが漏れない境界テスト / 切断→再接続で欠落なしのテスト。

### CE-03: オフィスビューの昇格 — virtual_office → Chronos(P1 / L)

**claw-empire の設計**: 部署 = 部屋、エージェント = デスクに座るスプライト。レイアウトはタイルマップでなく**定数からの計算グリッド**(部署数 → 列数 → 部屋高さ)。可視化文法の中核は 2 つ:

- **状態 → 身体写像**: `working` = タイピング + 星パーティクル、`idle` = 静止、`offline` = 半透明 + 💤、`break` = デスクから消えて休憩室で雑談。進行中タスクは頭上の吹き出し(タイトル 16 字)。
- **状態差分駆動アニメーション**: 前回状態との diff からのみ演出を発火 — 新規アサイン = CEO から 📋 が放物線で飛ぶ、サブエージェント出現 = 煙 + 花火、消滅 = 退場パフ、部署間連携 = 書類を持った分身が床を歩いて渡す。装飾でなく**遷移の通知**としてのアニメーション。

サブエージェントは親の脇に縮小クローン(最大 3 + `+N` チップ)。会議は出席者がテーブルへ歩いて着席し、シーン全再構築を跨いで宣言的状態(presence)から冪等に再着席される。

**kyberion の現状**: **オフィスメタファーは既に実装されている** — `scripts/virtual_office.ts`(~1,045 行、`pnpm office`)が部屋 = ミッション、席 = エージェント、休憩室 = 待機、フロント = 商談、メール室 = inbox/承認、掲示板 = ops アラートという構成で、SVG キャラクター(working/review/blocked/idle の状態差 + 役割アクセサリ)と組織図・実績統計まで持つ `OfficeSnapshot` を生成する。**問題は器**: meta-refresh の静的 HTML で、surface manifest 外・非対話・ドリルダウン不能・ライブ出力なしの袋小路。加えて Chronos 側の `AgentOpsBoards`(かんばん + activity board)と**同じデータを別コードパスで読む分断**があり(MO-09 の三重レンダリング問題と同根)、UX-07 の collaboration projection とも接続されていない。

**実装**(新規構築ではなく **virtual_office の Chronos への昇格・統合**。段階分割):

1. **データモデルの共通化**: `OfficeSnapshot` 組成ロジックを `scripts/virtual_office.ts` から `libs/core/office-snapshot.ts` へ抽出し、mission read-model / agent-activity-board / collaboration projection という既存の正本から組む(virtual_office と AgentOpsBoards の二重読取を解消)。レイアウトは org/mission registry からのデータ駆動生成を維持(手書き office pack は作らない)。
2. **状態機械 → 視覚写像**: worker 状態(idle / working / blocked / 承認待ち / quota 劣化 / offline)を CE-02 のストリームから導出し、既存 SVG キャラクターの見た目差(色・姿勢・バッジ・吹き出し = 最新イベント要約)へ写像。React 化は DOM + CSS で行い、canvas 化はパフォーマンス実測が要求した場合のみ(claw-empire の Pixi 全再構築は反面教師。§3)。
3. **差分駆動演出**: `prevState` diff からのみアニメーションを発火(新規 claim・完了・blocked 遷移・承認要求発生)。アニメーションは delta-time ベース(tick カウント方式は採らない)。
4. **サイドバー**: 役割別 working/total カウンタ + attention items(既存 `buildAttentionItems`)のバッジ統合。
5. **ドリルダウン**: 席 → CE-05 のライブ端末、部屋 → mission progress、吹き出し → trace viewer、部屋の進行 → run-graph の簡易 DAG 表示(`GraphRunArtifact` は存在するのに**レンダラがどの UI にもない**現状の解消。GE-08 後続)。
6. 旧 `pnpm office` は同じ `office-snapshot.ts` から静的出力を吐く互換モードとして残す(オフライン確認用)。

**受入条件**: OfficeSnapshot が単一モジュールから組まれ virtual_office / Chronos が共用するテスト / 状態遷移ごとに一度だけ演出が発火するテスト(diff 駆動)/ 全状態の写像スナップショットテスト / 席クリック → 端末ビュー遷移の e2e / run-graph DAG が描画されるスナップショットテスト。

### CE-04: 資源消費 → 視覚的重症度ラダー(P1 / S)

**claw-empire の設計**: provider quota 消費率を 3 閾値(0.6 / 0.8 / 1.0)で段階写像 — 60% で汗、80% で紅潮 + 頻繁な汗、**100% でベッドに寝かされ目を回す**(デスクがベッドに差し替わり、⭐ が頭上を周回)。同じ閾値で DOM 側の quota バーも emerald/amber/red に変色。「数字を読まずに分かる」の極致。

**kyberion の現状**: provider demotion(降格)機構と heartbeats はあるが、表示は HUD のヘルスストリップ(up/down)のみ。飽和に向かう途中経過(rate limit 接近・並行予算圧迫)が見えない。

**実装**:

1. provider ごとの利用率シグナル(rate-limit 残・並行予算 XP-06・demotion 状態)を正規化した `provider_pressure`(0..1)として heartbeats に追加。
2. Chronos: provider チップと CE-03 の席表示に 3 閾値ラダーを適用(バッジ/色/演出)。demotion = 「ベッド」状態とし、復帰予定時刻(バックオフ期限)を添える。
3. Terminal HUD: 同じ閾値をヘルスストリップの色 + グリフ(通常 → ⚠ → 休止 + 復帰カウントダウン)に写像。閾値定数は 1 箇所(`libs/core` の語彙カタログ)で共有。

**受入条件**: pressure 算出の単体テスト / 3 閾値の写像が HUD と Chronos で同一定数を参照する境界テスト / demotion 時に復帰期限が表示されるテスト。

### CE-05: ライブ端末ビュー + 進行ヒント + 介入ループ(P1 / M)

**claw-empire の設計**: タスク別端末ドロワー。全尾部再取得ポーリングという弱点はあるが、細部が優秀 — (a) FOLLOW/PAUSED 自動スクロール(50px 以上手動スクロールで自動解除)、(b) システム/エラーイベントの**タイムライン・マーカー帯**、(c) **進行ヒントフッター**「… `{tool}` in progress: {summary}」+ `current_file` + ✓ 完了項目リスト(沈黙中のエージェントが生きていると分かる)、(d) 介入パネル: pause → interrupt proof(session_id + control_token、バックオフ付き 4 回試行)→ prompt 注入 → resume。

**kyberion の現状**: **ワーカーのライブ出力はどの表面にも流れていない**。Chronos の agent ログは pull 型(`action:'logs'`, limit 100)、HUD はサーフェスログ 10 行 tail のみ。唯一の実ストリーム(terminal-bridge の WS + xterm.js)は**手動シェル専用でエージェントランタイムと未接続**。SO-04 で steering・承認は実装済みだが、表面から「見ながら介入する」一気通貫の UI がない。SU-02(live mission intervention)の未実装部分に相当。

**実装**:

1. Chronos に work-item 別端末ビューを新設。CE-02 の worker イベント(KC-02 構造化済み)を追記型で描画 — 全再取得でなくインクリメンタル追記 + リングバッファ(work-item あたり上限 2k 行)。thinking/tool_use/output の種別で折りたたみ。生 PTY が必要な場面は既存 terminal-bridge(xterm.js + WS + backlog replay)をエージェントランタイムのセッションに接続して再利用し、新規端末スタックは作らない。
2. 進行ヒント: KC-02 イベントから「実行中 tool + 対象ファイル + 直近完了項目」をサーバ側で集約し、フッター帯として表示。
3. 介入: 既存 SO-04 steering API と承認フローに接続した pause / inject / resume ボタン。inject は owner 権限 + mission 境界の再検証(SO-04 の実行直前再アサート)を通す。
4. FOLLOW/PAUSED・マーカー帯は claw-empire 仕様を踏襲。

**受入条件**: イベント → 追記描画の等価スナップショットテスト / リングバッファ上限テスト / 非 owner の inject が拒否される境界テスト / pause→inject→resume の統合テスト。

### CE-06: ストリーム消費の有界化規律(P2 / S)

**claw-empire の設計**: (a) stdout チャンクの JSON.parse 前に**部分文字列マーカーの前置フィルタ**、(b) チャンク境界を跨ぐ行のための**尾部バッファ**(16k 上限)、(c) あらゆる蓄積物に上限 — ライブメッセージ 600、配達アニメ、スレッド束縛 Map(30 分 TTL + 2,000 件上限)、既読 ID Set の FIFO trim。

**kyberion の現状**: AA-04(inflight admission)・KD 系で predecessor はあるが、表面/HUD の消費側(event tail・trace feed・agent-message-feed)に統一の有界化規律がない。長時間運転で表面がメモリを喰う余地がある。

**実装**: `libs/core` に `bounded-stream-consumer.ts`(前置フィルタ + 尾部バッファ + 上限付きリング + TTL Map)を新設し、Chronos の feed 系 lib(trace-feed / agent-message-feed)と Terminal HUD の event ticker をこれに載せ替える。上限値は語彙カタログで一元管理。

**受入条件**: チャンク境界分割入力の再結合テスト / 上限超過時の最古 shed テスト / TTL 失効テスト / 30 日相当のイベント量を流してもヒープが有界に留まる soak テスト(AO-04 の枠で)。

### CE-07: 役割別セクション + 統合の完了報告レンダリング(P2 / M)

**claw-empire の設計**: タスク完了時、関与した各部署のリードがセクションを書き、「チームリーダー統合版」がそれを合成した最終報告を生成。UI はプロジェクト別グループ + 部署タブ + 証跡ファイルパス付きで閲覧できる(Report ビュー)。

**kyberion の現状**: MO-08(hash-bound 成果物レビュー)と SU-03(deliverable inbox)は DONE だが、報告は単一文書中心。レビュー receipt(code-reviewer 役割 + implementer)という多役割構造は既にあるのに、表示が役割視点で分かれていない。

**実装**:

1. mission finish の evidence 組成に「役割別セクション」構造(implementer / reviewer / orchestrator の各視点 + 統合サマリ)を追加。生成は既存の worker 委譲で行い、統合は orchestrator の semantic brief とする(頻出パターンにつき `pipelines/` 化)。
2. Chronos deliverable inbox に役割タブ + 証跡リンク(trace / run-graph / receipt)レンダリングを追加。
3. Telegram/Slack への要約配信は既存 surface outbox(HA-08)へ接続(新経路は作らない)。

**受入条件**: 役割別セクション付き evidence の schema テスト / inbox でタブ切替 + 証跡リンクが機能する e2e / 統合サマリが各セクションの主張とリンクしている(捏造セクションなし)検証テスト。

### CE-08: 可視化の性能・コントラスト CI ゲート(P2 / S)

**claw-empire の設計**: `scripts/qa/office-performance-baseline.mjs` が Playwright + CDP tracing で実走し、**`avg_fps < 55` または `JS heap > 120MiB` で fail**、JSON レポートを出力。他に console smoke・解像度比較・テーマ要件(コントラスト監査)も CI スクリプト化。「可視化の品質を目視でなくゲートで守る」。

**kyberion の現状**: `check:chronos-dom-contrast`(DS-06)と light/dark Playwright ゲートは既にある。性能(fps/ヒープ)のベースラインゲートがない。CE-03 のような動的ビューを入れるなら必須の安全網。

**実装**: `scripts/check_chronos_perf_baseline.ts` を新設(Playwright + CDP。CE-03 ビューを含む主要 3 ビューで fps/heap を計測、閾値超過で fail、JSON レポートを `active/shared/observability/` へ)。`validate` チェーンには載せず(実ブラウザ依存のため)、週次 Chronos schedule + PR ラベル起動とする。

**受入条件**: ベースライン超過で fail することの自己テスト(閾値を人工的に下げて確認)/ レポート JSON の schema テスト / 週次実行が schedule registry に登録されている。

### CE-09: 手続き的テーマ導出(P3 / S)

**claw-empire の設計**: `deriveTheme(accent, tone)` — アクセント色 1 つ + トーンスライダから部屋パレット(床 2 色 + 壁)を白/灰へのブレンドで生成し、`contrastTextColor()`(YIQ)でラベル文字色を自動選択。ユーザー入力は 2 値だけで、破綻しない配色が出る。

**kyberion の現状**: DS-01(design tokens)/ DS-02(tenant branding)は DONE で、`ensureReadableOn()`(MP-04 で追加)という同型の可読性検証も既にある。欠けているのは「テナント/役割のアクセント 1 色 → 派生パレット全体」の導出器。

**実装**: `resolveCreativeDesign` の design-defaults cascade に `deriveAccentPalette(accent, tone)` を追加し、CE-03 の部屋配色・Chronos のテナントブランディング・PPTX テーマの 3 消費者から共用。可読性は既存 `ensureReadableOn()` を通す。

**受入条件**: 任意 accent 入力で AA コントラストを満たすパレットが出る property テスト / 3 消費者が同一導出器を参照する境界テスト。

### CE-10: エージェント実績の蓄積表示(P3 / S)

**claw-empire の設計**: タスク完了で XP、Bronze→Master のランク帯(色 + グロー + アイコン)、Dashboard に 3 位までの表彰台。エージェントに「歴史」があるように見え、継続運用の愛着と直感的な実績比較を生む。

**kyberion の現状**: NI-01(AgentIdentity 台帳、journal-backed)が完了済みで、task 粒度の実績イベントは既に記録されている。表示だけがない。

**実装**: identity journal から完了 task 数・レビュー通過率・provider 別実績を投影する `agent-track-record.ts` を Chronos に追加し、roster カード + CE-03 の席ツールチップに表示。ランク帯はゲーム的意匠でなく実績帯(件数閾値)として控えめに。**XP 数値の演出(fanfare)は採らない** — 実績の可視化のみ。

**受入条件**: journal → 投影の単体テスト / 実績帯閾値の語彙カタログ化 / roster カード表示の snapshot テスト。

### CE-11: 一発助言実行の no-tools 強制 + 漏出ガード(P2 / S)

**claw-empire の設計**: 実行モードが二層 — 長時間の作業 run と、会議発言・チャット返信・要約用の**一発(one-shot)助言 run**。後者は provider ごとの read-only フラグ(`--tools=` / `--sandbox read-only` / `--approval-mode plan`)を組み立てる単一の `buildAgentArgs(provider, …, {noTools})` に加え、**フラグが効かなかった場合の実行時ガード**を持つ: ストリームに tool-use JSON が現れた時点で run を `NO_TOOLS_POLICY_ERROR` として中断する。宣言と実挙動の二重防御。

**kyberion の現状**: wisdom:* / semantic brief / planner 系の「助言だけさせたい」一発呼び出しは多数あるが、read-only 性は KD-05 の能力ティア宣言(planner の no-exec 近似拒否)止まりで、**実行時に tool 実行が漏れたことを検出して中断する層がない**。

**実装**: reasoning backend の delegate/一発実行経路に `advisory: true` オプションを追加。(a) provider adapter が各 CLI/SDK の read-only 射影を組み立て(KD-05 の表を再利用)、(b) ストリーム消費側で tool-use イベント検出時に abort + `advisory_policy_violation` を監査へ記録。stub backend でも検証可能なようイベント注入テストを用意。

**受入条件**: 全 adapter で advisory 射影が組まれる単体テスト / tool-use 漏出を注入すると run が中断され監査記録が残るテスト / 既存 wisdom ops が advisory 指定で退行しない回帰。

### CE-12: 多信号の孤児 run 生存判定と完了リプレイ(P2 / S)

**claw-empire の設計**: サーバ再起動を跨いだ孤児 run の回復が慎重 — 死んだと断定する前に (1) in-memory ハンドル、(2) `isPidAlive(pid)`、(3) 直近の task_logs 行、(4) **ログファイル mtime** の 4 信号を順に確認し、さらにログ末尾に `RUN completed (exit code: N)` が残っていれば**結果を破棄せず完了ハンドラをリプレイ**する。「プロセスは死んだが仕事は終わっていた」ケースで成果を失わない。

**kyberion の現状**: watchdog による stale claim 回収はあり、QM-01(リーストークン・park)が計画済みだが、回収時の判定は heartbeat 中心で、**成果が出ていたのに claim ごと破棄される**経路が残る。MO-06(durable resume)/ GE-04(run journal)と接続できる。

**実装**: QM-01 の reaper 拡張に判定順序を追加 — heartbeat 喪失 → pid 生存確認 → mission ledger / run journal(GE-04)の末尾走査 → 完了 evidence があれば `completeWorkItem` をリプレイ(リーストークン検証は QM-01 に従う)、なければ park。リプレイは冪等(同一 receipt の二重計上拒否)。

**受入条件**: 「プロセス死亡 + journal に完了記録あり」で成果がリプレイされるテスト / 完了記録なしで park されるテスト / リプレイの冪等性テスト。

---

## 3. 非採用(明示)

| claw-empire の要素                                                                | 非採用の理由                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CEO 歩行操作(WASD)・仮想パッド                                                    | 情報価値に対し実装/保守コストが大きい。CE-03 はクリックナビゲーションで足りる。後日「あそび」として再評価可                                                                                                                           |
| Pixi 全シーン再構築方式                                                           | 反面教師。等価ベイルアウトが唯一の防壁という脆い構造。CE-03 は差分レンダリング(DOM/React)で設計                                                                                                                                       |
| tick カウントアニメーション                                                       | フレームレート依存で 120Hz 環境で倍速になる。delta-time を規律とする                                                                                                                                                                  |
| スプライト素材の流用                                                              | ライセンス出所不明(doro 系)。必要になれば自前生成(claw-empire 同様の SVG→PNG 生成器は参考可)                                                                                                                                          |
| 会議エンジン(多エージェント討論ラウンド)                                          | kyberion には wisdom:* / A2A / devils_advocate の既存機構があり、N×M の LLM 呼び出しを焚く会議シミュレーションは冗長                                                                                                                  |
| SQLite への状態移行                                                               | kyberion はファイルベース + 監査チェーンが正本(QM 計画 §4 と同判断)                                                                                                                                                                   |
| Telegram ブリッジ                                                                 | HA-07/HA-08 で surface outbox 系として実装済み                                                                                                                                                                                        |
| ブラウザ側での生 stdout パース(サブエージェント検出)                              | kyberion は KC-02 で構造化済みイベントを持つ。クライアントでの正規表現パースは採らない                                                                                                                                                |
| ブラウザ内 OAuth ハブ                                                             | 資格情報は server 側管理が既に確立(OAuth 表面の追加は非目標)                                                                                                                                                                          |
| 権限バイパス実行(`--yolo` / `--dangerously-skip-permissions` + `--max-turns 200`) | claw-empire は全タスク run で権限確認を無効化し、隔離は git worktree のみ(コンテナ/サンドボックス境界なし)。kyberion は KD-05/XP-02 の sandbox・approval 射影が正反対の設計であり、**絶対に採らない**。CE-11 はむしろこの逆方向の強化 |
| 自由文への状態エンコード(`[REPORT FLOW] key=value` を description へ追記)         | ワークフロー状態を正規カラムでなくタスク説明文 + 正規表現で管理する反面教師。kyberion の typed contract / journal 方式を維持                                                                                                          |
| timer チェーンによる進行制御(`setTimeout(1000+rand)` の演出遅延が正しさに結合)    | 耐久ジョブキューなしで演出タイミングが制御フローを兼ねる構造。GE 系の完了駆動スケジューラと相容れない                                                                                                                                 |

## 4. 実装順序と依存

```
CE-01(同期規律)──┐
CE-02(SSE 購読)──┼─→ CE-03(オフィスビュー)─→ CE-04(重症度ラダー)
                    └─→ CE-05(ライブ端末 + 介入)
CE-06(有界化)は CE-02/05 の実装内で同時に導入
CE-07(報告レンダリング)は独立(MO-08/SU-03 の後続)
CE-08(CI ゲート)は CE-03 マージ前に用意
CE-09 / CE-10 は独立の小粒後続
CE-11 / CE-12 は非 UI の独立小粒(CE-12 は QM-01 実装時に同時対応するのが最安)
```

P0 の 2 件(CE-01/02)が土台。**オペレータの本命である CE-03 は、この 2 件なしに実装すると claw-empire と同じ「全再構築 + ベイルアウト頼み」の脆さを踏む**ため、順序を守る。

## 5. 実装状況

| ID    | 状態     | 備考                                                                                                                                        |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| CE-01 | 実装済み | `LiveSyncScheduler`: SSE は無効化シグナル、REST が正本、合流窓・visibility 制御・等価性ベイルアウト。                                       |
| CE-02 | 実装済み | `/api/collaboration/stream` と種別別 `CollaborationEventBatcher` を追加。`Last-Event-ID` / JSONL 検証 / keep-alive 対応。                   |
| CE-03 | 実装済み | `libs/core/office-snapshot.ts` を正本入口にし、`pnpm office` と Chronos の部屋・席投影を共用。Chronos は DOM の差分更新。                   |
| CE-04 | 実装済み | quota・同時実行数・demotion を `deriveProviderPressure` の normal/watch/elevated/saturated に統一し、Chronos の席表示へ反映。               |
| CE-05 | 実装済み | work-item 端末ドロワー、2,000 行要求、FOLLOW/PAUSED、SSE 更新、進行ログ、owner 境界付き mission Pause/Resume/Steer を追加。                 |
| CE-06 | 実装済み | tail、SSE queue、message/handoff/trace feed、work-item ログに上限付き ring buffer を適用。                                                  |
| CE-07 | 実装済み | inbox 契約に役割別 section と evidence binding を追加し、deliverables 表示で統合要約と役割別主張を表示。                                    |
| CE-08 | 実装済み | `check:chronos-dom-contrast` に加え、Playwright FPS/heap の `check:chronos-perf` と週次 pipeline を追加。ブラウザ実測値は初回実行時に確定。 |
| CE-09 | 実装済み | `resolveCreativeDesign` から accent+tone の読取可能な手続き的 palette を返す。                                                              |
| CE-10 | 実装済み | work-item の完了数・review pass rate・rank を投影し、Chronos roster/office に表示。                                                         |
| CE-11 | 実装済み | advisory reasoning の provider permission profile を planner に固定し、tool call を検出したら `NO_TOOLS_POLICY_ERROR` で fail closed。      |
| CE-12 | 実装済み | 孤児判定を alive/park/replay_complete に分け、completion evidence がある lease は claim を破棄せず done へ replay。                         |

実装検証ミッション: `MSN-CE-ADOPTION-20260802`。実装した契約テストは core/Chronos 合計 33 件が green。既存 Chronos 全体 typecheck には本変更と無関係な既存エラーが残るため、詳細は mission の review handoff に記録する。
