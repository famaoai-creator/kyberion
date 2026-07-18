---
title: Hermes Agent 概念取り込み計画(HA-01〜09)
kind: improvement-plan
scope: core / knowledge / scheduler / execution-environment
authority: planning
status: proposed
---

# Hermes Agent 概念取り込み計画(HA-01〜09): 自律学習ループ・履歴全文検索・実行環境抽象・チャネル層硬化

> **作成日**: 2026-07-18
> **起点**: [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent)(Python + JS TUI、gateway 含め ~120k LOC 超の大規模モノレポ、MIT、極めて活発 — 分析時点の HEAD は 2026-07-17)の実コード分析(2026-07-18、shallow clone にて実施)。
> **位置づけ**: [OPENHARNESS_ADOPTION_PLAN_2026-07-18](./OPENHARNESS_ADOPTION_PLAN_2026-07-18.ja.md) と同じ「コードは取り込まず概念だけ既存契約へ昇華する」方式(browser-cli 方式)。OH 計画がコンテキスト経済・ガバナンス硬化を扱ったのに対し、本計画は Hermes の独自領域 = **経験からの自己改善ループ・生履歴のゼロ LLM コスト検索・実行環境の可搬性** を扱う。KM 系・LC-02(pipeline promote)・MO-04・AO-01 の未着手部分に実装参照を与える。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 1. 診断

### 1.1 Hermes Agent とは

Nous Research の「自己改善する」パーソナルエージェント。看板機能は**閉じた学習ループ**(経験からのスキル自動生成・使用中のスキル自己改善・記憶永続化の自己ナッジ・過去会話の自己検索・ユーザーモデルの深化)。研究組織の産物らしく、trajectory 生成・圧縮など訓練データ製造系も同居する。god-file(`cli.py` 16.5k 行等)を含む巨大リポジトリだが、**巧妙な機構は小さく分離されたモジュールに実装されており**、概念抽出に向く。

### 1.2 対応表(Hermes 実装 → Kyberion 現状 → 判定)

| 機構                                 | Hermes 実装                                                                                                                                   | Kyberion 現状                                                                                                                                              | 判定                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 学習ループ(スキル自動生成・自己改善) | `agent/background_review.py`(ターン後に同一キャッシュ継承のフォークが自省、tool whitelist 付き)+ `agent/curator.py`(アイドル時整理)           | `scripts/refactor/mission-distill.ts`(mission 完了時の自動蒸留)は成熟。ただし `pipeline_promote.ts` は**手動起動の慣行**で、既存スキルの自己改善機構は無し | **部分 → HA-01**       |
| 会話・履歴の全文検索                 | SQLite FTS5 二重索引(unicode61 + **CJK 用 trigram**)+ `session_search_tool.py`(LLM 不使用・3 モード)                                          | embedding ベースの knowledge index のみ。**生の会話/trace は検索不可**、想起は蒸留済み knowledge 依存                                                      | **欠落 → HA-02**       |
| スケジュール自動化                   | `cron/`(croniter + **Automation Blueprint** = スロットスキーマ単一定義 → GUI form / slash / agent 質問シード、`--deliver telegram`)           | `scripts/chronos_daemon.ts` + `schedule.cron` 付き pipeline 17 本で成熟。ただし**自然言語での定義面と配信の一級化が無い**(配信は mesh queue 経由の間接)    | **部分 → HA-03**       |
| ツール RPC スクリプティング(PTC)     | `tools/code_execution_tool.py`(モデルが書いた script に tool stub を生成、**stdout のみ文脈復帰**、allowed∩granted のツール制限 + token 認証) | 宣言的 ADF pipeline が同目的。actuator handler の直接 import は可能だが、モデル発の imperative 合成の一級経路は無し                                        | **部分 → HA-04**       |
| 実行環境抽象                         | `tools/environments/`(local/Docker/SSH/Singularity/Modal/Daytona、**task_id → snapshot 永続で hibernate/wake**)                               | `managed-process.ts` によるローカル child process のみ。Docker は自己配布用                                                                                | **欠落 → HA-05**       |
| コンテキスト圧縮                     | `agent/context_compressor.py`(安価な aux model・token 予算ベース保護尾部・filter-safe preamble・compression lock)                             | 無し(OH-01 で計画済み)                                                                                                                                     | **OH-01 の補強**(§2.1) |
| オペレータモデリング                 | Honcho dialectic(外部サービス)+ `USER.md`                                                                                                     | `libs/core/operator-learning.ts`(schema 化 profile + サンプル閾値昇格)                                                                                     | **既に同等以上**       |
| Provider 枯渇管理                    | `agent/credential_pool.py`(STATUS_EXHAUSTED + TTL cooldown)                                                                                   | `provider-health-registry.ts`(TTL demotion)                                                                                                                | 既に同等               |
| サブエージェント分離                 | `delegate_tool.py`(隔離文脈・summary のみ親へ)                                                                                                | `agent-dispatch.ts` + mission-team 系                                                                                                                      | 既に同等               |
| 完了検証ゲート                       | `agent/verification_stop.py`(evidence 収集で完了を gate)                                                                                      | working-philosophy「done requires evidence」+ MO 系 artifact review closure                                                                                | 既に同等(思想一致)     |
| チャネル(20 platform)                | `gateway/` + `plugins/platforms/`(WhatsApp/Signal/Feishu/LINE/Teams 等)                                                                       | slack/telegram/discord/imessage。拡張は OH-08 で需要待ち                                                                                                   | OH-08 に統合済み       |

### 1.3 最大の学び: 「学習ループの分業」と「想起の二経路」

1. **Hermes の memory nudge は文脈注入ではなくフォーク**。ターン/イテレーションのカウンタが閾値に達すると、会話スナップショットを**同一 provider 接続・同一 system prompt のまま**別スレッドの子エージェントに再生させる(prefix cache に乗るためほぼ無料)。子は memory/skill 系ツールだけ許可され、本流の作業を一切妨げない。レビュープロンプトには「**記録してはいけないもの**」(環境依存の失敗・ツールへの否定的断定・一過性エラー)が明文化されており、エージェントが自縄自縛の制約を固定化するのを防ぐ。
2. **想起は「精製知識の意味検索」と「生ログの全文検索」の二経路が要る**。Kyberion は前者(蒸留 → knowledge → embedding 検索)のみで、蒸留が走らなかった作業は想起不能。Hermes の FTS5 検索は LLM を一切呼ばず実 DB メッセージを返し、CJK 対応の trigram 索引と「cron セッションは除外でなく降格」というランキング補正(高頻度 cron 語彙が BM25 を占拠して対話セッションが埋もれる問題への対処)まで実証済み。日本語運用の Kyberion には trigram 索引が特に効く。

### 1.4 チャネル層追補(2026-07-18 同日追記: iMessage ほか)

Hermes の gateway は最大サブシステム(`gateway/platforms/` 35k LOC + plugin adapter 20 platform)。iMessage は **BlueBubbles server 経由**(`gateway/platforms/bluebubbles.py`、1,048 行: REST 送信 + webhook 受信、添付送受信、private API 有効時の typing/既読、group の wake-word mention gating)。特筆すべきは chat GUID 解決で**参加者一致 fallback を意図的に拒否**する設計 — 1:1 の返信が両者所属のグループへ漏れる事故の防止。

対する `satellites/imessage-bridge`(221 行、`imsg` CLI を 5 秒毎ポーリング)は experimental で、**まさにその逆の欠陥が現存**する:

| 観点           | Hermes (bluebubbles.py)                                      | Kyberion imessage-bridge                                             |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| グループ返信   | chatGuid 宛・participant fallback 拒否                       | **送信者個人への DM に飛ぶ**(`recipient: msg.sender`、chatId 不使用) |
| group gating   | wake-word mention gating(iMessage に bot mention が無いため) | 無し(全発言に反応)                                                   |
| 添付 / tapback | 送受信対応(HEIC→jpg、voice note)/ 受信認識                   | テキストのみ / 非対応                                                |
| ポーリング     | webhook push(ポーリング無し)                                 | 5 秒毎に全 chat × `imsg history` のサブプロセス起動(O(chats))        |
| typing/既読    | private API 経由                                             | 5 秒超過時の「処理中です…」ノートのみ                                |

4 satellite 横断では、共有 UX 層(`bridge-typing.ts` / `bridge-error-reply.ts`)は良く整理されている一方、**channel 非依存であるべき機能が Slack に偏在**している:

- **承認 UI が Slack 専用**: `slack-approval-ui.ts` は成熟(LC-10 ask-why 含む)だが、Telegram/Discord/iMessage の satellite は `conversation.approvalRequests` を見ておらず、**承認要求が黙って落ちる**。Hermes は base adapter の `send_exec_approval`/`send_clarify`/`send_slash_confirm` 契約 + ボタン非対応チャネル向け番号付きテキスト fallback で全チャネル対応。
- **surface outbox に retry 上限・backoff・dead-letter が無い**(無限リトライ)。しかも Discord/iMessage は outbox drain 自体が無く、宛先に enqueue された通知が永久に滞留する。Hermes は `SendResult.error_kind` 分類(forbidden/not_found → dead-target registry 登録、送信成功で self-heal)+ `retryable`/`retry_after`。皮肉なことに kyberion の `mesh-message-broker.ts` は完全な at-least-once 状態機械(backoff・dead-letter・冪等 dedup)を**既に持っている**が、A2A 配送専用で chat 配信には使われていない。
- **能力宣言と chunking の欠如**: `chunkBridgeMessage`(code-fence 対応)は存在するのに使うのは Discord のみ。Slack/Telegram は上限超過で送信失敗しうる。allowlist は Telegram のみ。Hermes は adapter class の capability flags(`MAX_MESSAGE_LENGTH`、`splits_long_messages`、`supports_draft_streaming`、UTF-16 長計算)で共通層が分割・整形を決める。

## 2. 採用方針

**コードは取り込まない**(Python 前提・god-file 構造でアーキテクチャ非互換)。概念のみ既存契約へ昇華する。

### 2.1 既存計画への補強(新規 ID を起こさない)

- **OH-01(ワーカーコンテキスト自動圧縮)**: Hermes `context_compressor.py` の実証済み詳細を実装参照に追加 — ① 要約は安価な補助モデルで行う、② 保護尾部は固定件数でなく token 予算で決める、③ 要約見出しを「Historical (reference-only)」とし能動的指示に読ませない(filter-safe preamble)、④ LLM 要約前に tool 出力の刈り込みプレパスを入れる、⑤ 同一セッションの二重圧縮を lock で防ぐ。
- **KM 系(memory)**: 「**frozen snapshot**」パターン — memory はセッション開始時に一度だけ prompt へ注入し、セッション中の書込みはディスクにのみ反映(prefix cache 温存)。claude-agent backend のワーカーに適用価値あり。

### 2.2 不採用(理由付き)

| 機構                                                                 | 不採用理由                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| trajectory 生成・圧縮(`batch_runner.py`・`trajectory_compressor.py`) | モデル訓練データ製造が目的(Nous は研究組織)。Kyberion はモデルを訓練しない。runtime 圧縮の知見のみ OH-01 補強へ吸収 |
| Honcho 外部サービスによるユーザーモデリング                          | `operator-learning.ts` が schema 統治付きで同等以上。外部 SaaS 依存を増やさない                                     |
| gateway 20 platform 対応                                             | チャネル拡張は OH-08(需要トリガー)で管理済み                                                                        |
| kanban・pet・achievements(エンゲージメント層)                        | プロダクト方向性が異なる                                                                                            |
| ACP adapter(エディタ統合)                                            | 需要が顕在化したら別計画化。現時点では MCP server(OH-05)を優先                                                      |
| LSP 統合                                                             | 別軸(実装エージェントは Claude Code 等の LSP を利用)                                                                |

## 3. 実装計画

### HA-01: 自律学習ループ — background review fork(P1 / M)

**内容**: mission/会話の節目で「記憶とスキルだけを触れる自省フォーク」を起動する仕組みを導入し、LC-02(`pipeline_promote.ts`)の手動慣行を自律トリガー化する。

- **ナッジカウンタ**: ワーカーループにターン数/ツール実行数の 2 カウンタ(既定 10、`skill`/knowledge 系 op の実使用でリセット、セッション再開時は剰余を引き継ぐ)。閾値到達で本流をブロックせずレビューを予約。
- **フォーク実行**: `delegateTask()` で会話スナップショットを再生する子ワーカーを起動。許可 op を memory/skill/knowledge 系(`enqueueMemoryPromotionCandidate`、`pipeline_promote`、SKILL.md patch)に**whitelist 制限**。claude-agent backend では親と同一セッション文脈を再利用し cache 効率を確保。フォーク内の再ナッジは無効化。
- **編集ポリシーの明文化**(Hermes のレビュープロンプトを参照に日本語版を作成): 新規作成より既存スキル/pipeline への patch を優先。「記録禁止リスト」(環境依存の失敗・provider への否定的断定・一過性エラー)を含め、`knowledge/` の汚染を防ぐ。実際に読んでいないスキルへの patch を禁止するガード。
- **curator**: アイドル時に agent 作成スキル/蒸留物の pin/統合/**archive(削除は不可・復元可能)** を行う定期整理を `chronos_daemon` のスケジュールに追加。対象はエージェント作成物のみ(provenance で bundled/手動作成物を保護)。

**受入条件**:

1. 長時間 mission でナッジ発火 → フォークが memory promotion candidate または pipeline promote 提案を生成することを E2E で検証。
2. フォークが whitelist 外の op を実行できない(governance テスト)。
3. 記録禁止リストに該当する内容(例: 一過性のネットワークエラー)が knowledge に昇格しないことをテストで検証。
4. curator が bundled/手動作成物に触れず、archive のみで削除しない。
5. 本流ワーカーのレイテンシに影響しない(非同期実行)。

**担当モデル**: opus(設計・プロンプト)+ sonnet(実装)

### HA-02: 会話・ミッション履歴の FTS 検索(P1 / M)

**内容**: 生の会話ログ(channel-surface conversations)・mission journal・trace を SQLite FTS5 に索引し、**LLM を呼ばないゼロコスト想起 op** を提供する。蒸留 → embedding 検索(`knowledge-index.ts`)と相補の二経路目。

- **二重索引**: unicode61 標準索引 + **trigram 索引**(日本語の部分文字列一致に必須)。trigger で本体テーブルと同期。`content || tool_name || tool_calls` 連結を索引対象とする(Hermes `hermes_state.py:916-945` 方式)。
- **検索 op**: 引数から 3 モード推定(DISCOVERY: FTS query → lineage 重複排除 → snippet + 前後窓 / SCROLL: 特定セッションの窓移動 / BROWSE: 直近一覧)。**cron/scheduled 実行由来のセッションは除外でなく降格**(BM25 占拠対策)、subagent 内部セッションは非表示。
- **堅牢性**: FTS 破損の self-healing(health probe → rebuild)。索引は tier 規約に従い mission/personal データの tier 境界を跨いだ検索結果を返さない(tier フィルタ必須)。

**受入条件**:

1. 過去の会話・mission を日本語部分文字列で検索でき、実メッセージ+前後文脈が返る(LLM 呼び出しゼロ)。
2. cron 由来セッションが対話セッションより上位に来ないランキングテスト。
3. tier 境界テスト: personal tier の会話が confidential/public スコープの検索から漏れない。
4. 索引破損時に自動 rebuild され、検索が可用に戻る。

**担当モデル**: sonnet

### HA-03: Automation Blueprint — スケジュール定義の NL 面と配信の一級化(P2 / S〜M)

**内容**: `chronos_daemon.ts` は成熟しているが定義面が「cron 式を ADF に手書き」のみ。Hermes の Blueprint パターン(**スロットスキーマの単一定義**から ①operator への質問シード ②Slack slash command ③既定値埋め込みフォームの 3 面を生成)を導入し、あわせて schedule スキーマに `deliver_to`(channel-surface 宛先)を一級フィールドとして追加する(現状は mesh-delivery queue 経由の間接配信のみ)。

- Blueprint カタログ: `pipelines/` の schedule 付き pipeline から自動抽出 + 手書きカタログ。recurrence の固定部は template が持ち、人間が決める部分(時刻・曜日)だけをスロット化。
- 完了物: 「毎朝 9 時に日次レポートを Slack #ops へ」を Slack から一往復で登録できる。

**受入条件**:

1. Blueprint 経由で新規スケジュールが cron 式を書かずに登録され、chronos_daemon が実行する。
2. `deliver_to` 指定の実行結果が指定チャネルに届く(mesh queue の 5 分待ちに依存しない)。
3. スロットスキーマが単一定義で、Slack slash / agent 質問の両面が同一定義から生成される。

**担当モデル**: sonnet

### HA-04: op 合成スクリプト実行 — Programmatic Tool Calling(P2 / M)

**内容**: モデルが書いたスクリプトから typed op を関数として呼び、**stdout のみを文脈へ返す**実行 op を追加する(Hermes `code_execution_tool.py` 方式)。多段 op 合成の中間結果が文脈を消費しない「ゼロ文脈コスト turn」を実現する。

- **[LAYERED_EXECUTION_PLAN](./LAYERED_EXECUTION_PLAN_2026-07-15.ja.md) との整合**: スクリプトは **op を呼ぶ糊に限定**し、計算・検証ロジックは従来どおり typed op 側に置く。再実行が見込まれる合成は従来どおり pipeline へ昇格(LC-02)— 本 op は「一度きりの探索的合成」の受け皿であり、`core:transform` JS-in-a-string の復活ではない。
- **ガバナンス**: 呼べる op = 事前定義の SANDBOX 許可集合 ∩ セッションで grant 済み op の**交差**。呼び出しは実 op レイヤ(policy gate・Trace)を必ず通す。per-run token 認証、call 数・stdout サイズ・timeout の上限。
- **stub 生成**: grant 済み op から TS/JS stub モジュールを生成し、子プロセスに UDS(RPC)で接続。

**受入条件**:

1. 多段 op 合成スクリプトの中間結果が親文脈に載らず、stdout 要約のみ返ることをテストで検証。
2. 交差集合外の op 呼び出しが拒否され、全呼び出しが Trace に記録される。
3. call 上限・timeout 超過が安全に停止する。

**担当モデル**: opus(設計)+ sonnet(実装)

### HA-05: 実行環境抽象 — EnvironmentBackend(P2 / L・条件付き)

**内容**: `managed-process.ts` の下に実行環境の抽象層(local / Docker / SSH、将来 serverless)を導入し、ワーカー・actuator の実行をローカル以外へ逃がせるようにする。Hermes `tools/environments/base.py` の設計(**spawn-per-call + 初期化時セッションスナップショットの再 source + CWD の in-band 引き継ぎ**、`task_id` → snapshot/overlay の永続対応で hibernate/wake)を参照実装とする。

- **着手条件**: リモート実行・強い分離・常時稼働 VM の需要が顕在化した時(例: 顧客環境での実行、危険度の高い actuator の隔離)。それまでは backlog。着手時は local + Docker の 2 backend から。
- SA 系(egress control)との整合を設計時に必須確認。

**受入条件**: 需要確定後に個別計画化(本計画では backlog 登録と設計参照の記録のみ)。

**担当モデル**: opus(設計)+ sonnet(実装)

### HA-06: チャネル承認・確認 UI の contract 化(P1 / M)

**内容**: 承認(approvalRequests)・確認・選択肢提示を channel-surface 契約の一部に昇格し、Slack Block Kit 専用の現状を解消する。per-surface renderer 方式: ボタン系チャネル(Slack 既存 / Discord components / Telegram inline keyboard)はボタン + `appr:<id>:<decision>` 相当の surface 非依存 callback 規約、非ボタン系(iMessage)は**番号付きテキスト + 返信インターセプト**の fallback(Hermes base adapter 方式)。決定の適用は既存 `applySlackApprovalDecision` を surface 非依存 API に一般化し、LC-10 ask-why(却下理由の追問)も共通層へ移す。

**受入条件**:

1. Telegram/Discord で承認ボタンが機能し、共通の decision API に到達する。
2. iMessage でテキスト fallback(番号返信)による承認/却下が機能する。
3. 承認要求がどの surface でも黙って消えない(renderer 未実装 surface では operator へエラー通知)。
4. Slack 既存フロー(ask-why 含む)の非退行。

**担当モデル**: sonnet

### HA-07: imessage-bridge 硬化(P1 / M)

**内容**: experimental 段階の imessage-bridge を実用水準へ。

- **グループ返信バグ修正**(最優先): 返信を `msg.chatId` 宛(`imsg send --chat-id`)にし、送信者個人 DM への誤送を解消。識別子解決で参加者一致 fallback を行わない(Hermes #24157 の教訓: 1:1 とグループの混線防止)。
- **mention gating**: グループでは wake word(既定: エージェント名)を含む発言のみ処理し、先頭 wake word は除去して渡す。
- **ポーリング効率化**: 全 chat 走査 × サブプロセス起動(現状 O(chats)/5 秒)を差分取得に改める。
- **配線完了**: outbox drain と customer-binding(型定義済み・未配線)を接続。
- **添付受信**: `imsg` の能力を確認の上対応。能力不足なら BlueBubbles server adapter への移行を評価(webhook push・添付・typing/既読が揃う)。

**受入条件**:

1. グループチャット受信への返信が同じグループに届く(回帰テスト)。
2. mention 無しのグループ発言に反応しない。
3. imessage 宛の surface outbox が drain される。
4. 1 tick あたりのサブプロセス起動数が chat 数に比例しない。

**担当モデル**: sonnet

### HA-08: surface 配信の堅牢化 — error 分類と dead-letter(P1 / S〜M)

**内容**: bridge 送信共通層に error taxonomy(`too_long | bad_format | forbidden | not_found | rate_limited | transient`)を導入し、surface outbox に attempt 上限 + 指数 backoff + dead-letter を追加する。実装は新造でなく **`mesh-message-broker.ts` の既存状態機械(accepted→queued→dispatched→acknowledged|dead_lettered、冪等 dedup、1s→60s backoff)を chat 配信へ流用**する(AA-02 と相互参照)。恒久エラー(forbidden/not_found)は dead-target registry に登録して以後の enqueue を短絡し、送信成功で self-heal(Hermes `dead_targets.py` 方式)。Discord/iMessage にも outbox drain を追加(HA-07 と分担)。

**受入条件**:

1. 恒久エラー(チャネル削除等)が無限リトライせず dead-letter + ops alert になる。
2. transient エラーが backoff 付きリトライで回復する。
3. dead target への enqueue が短絡され、成功送信でフラグが自動解除される。
4. `pnpm doctor` で outbox 滞留と dead-letter 状態が観測できる。

**担当モデル**: sonnet

### HA-09: surface capability 宣言と chunking の中央化(P2 / M)

**内容**: 各 satellite が `MAX_MESSAGE_LENGTH`・markdown 方言・typing 方式・ボタン可否・(将来)draft streaming 可否を宣言する capability manifest を channel-surface 契約に追加し、共通層が宣言に基づいて `chunkBridgeMessage`(code-fence 跨ぎ再オープン、UTF-16 長計算)と markdown 変換を適用する。Telegram の「markdown parse 失敗 → plain text 再送」fallback を全チャネル共通化。allowlist / グループ gating の設定も共通スキーマへ中央化(現状 Telegram のみ・他は無防備)。

**受入条件**:

1. Slack/Telegram で上限超過メッセージが分割送信され、code block が chunk 境界で壊れない。
2. markdown 不正時に plain text へ自動フォールバックする(全チャネル)。
3. allowlist が共通設定で全チャネルに効く(未設定時の既定は現行互換)。

**担当モデル**: sonnet

## 4. 推奨実施順序

1. **HA-07 のグループ返信バグ修正**(現存バグ・即時着手可)→ 2. **HA-02**(独立・日本語運用での想起力を即改善)→ 3. **HA-01**(P1 本丸、HA-02 の検索を自省フォークが利用可能)→ 4. **HA-06 → HA-08**(承認と配信の channel 非依存化・相互補完)→ 5. **HA-07 残り**(gating・効率化・配線)→ 6. **HA-03**(chronos 拡張・独立)→ 7. **HA-04**(AR-02/AR-03 の op registry 成熟後が望ましい)→ 8. **HA-09** → 9. **HA-05**(需要待ち)。

OH-01 実装時は §2.1 の補強詳細を必ず参照すること。HA-01 は KM-03(memory promotion governance)・LC-02(pipeline promote)、HA-03 は AA-02(mesh delivery)と実装状況を相互参照(重複着手禁止)。
