# AA-04: エージェント間会話モデルとバックプレッシャ

> 優先度: P1 / 規模: M / 依存: AA-01(セッション喪失検知) / 関連: MO-04(結果契約)

## 背景と課題

エージェント間のやり取りが「単発 RPC」の域を出ておらず、負荷制御も無い。

- **A2A は単発 request/response のみ**: `a2aBridge.route`(`a2a-bridge.ts:71`)は 1 リクエスト 1 応答。`conversation_id`/`parent_id` はヘッダに載る(`:37,166`)が、**会話ストアも履歴リプレイも応答のスレッド相関も無い**。多ターン継続性は provider セッション(ACP 内部)が生きていることに全面依存し、AA-01 で判明したとおりクラッシュ/再起動でセッションは**黙って消える**(会話用 cwd を温存する `runtimeContextKey='conversation'` の仕組み `:292-329` はあるが、中身のセッションは復元されない)。
- `onResponse` ハンドラ(`:183-187`)はプロセス内の fire-and-forget コールバックで、エラーは黙殺(`:177`)。
- **グループ/ブロードキャストはホスト内に無い**(Mesh 側の topic fan-out は AA-02 の駆動系が前提)。
- **バックプレッシャ皆無**: bridge にもデーモンにも inflight 上限が無い。`route` の burst は無制限にランタイム生成・キューイングされる。Mesh 契約には `available_slots/max_inflight`(`mesh-hub-contract.ts:77-81`)があるのに admission に未使用 — 設計語彙はあるのに使われていない典型。
- ランタイムの状態ゲートは `ready|busy|booting`(`agent-lifecycle.ts:179`)のみで、busy への追加要求の扱いが未定義。

## ゴール(受入条件)

1. **会話ストア**: `conversation_id` 単位のターン履歴(送受信 envelope の要約 + provider セッション識別子)が runtime root に永続化され、(a) 応答を進行中スレッドに相関できる、(b) セッション喪失(AA-01 の crash 検知)時に「履歴の要約を新セッションに再注入して継続する」復元経路が動く。
2. **バックプレッシャ**: デーモン/bridge に inflight 上限(全体 + agent 単位)が入り、超過時は即時の型付き拒否(`AgentBusyError`、retry-after ヒント付き)が返る。呼び出し側(mission worker 等)はこれを受けてキューイング/バックオフする。
3. busy 状態の agent への `route` の挙動が明示される(既定: 短時間の待ち + 上限で AgentBusyError)。
4. 観測: 会話スレッドと inflight 数が supervisor events から追える。

## 実装タスク

### Task 1: 会話ストア — `claude-sonnet-4`

1. `libs/core/a2a-conversation-store.ts` を新設: `active/shared/runtime/a2a-conversations/<conversation_id>.jsonl` にターン(ts / sender / receiver / performative / prompt 要約 200 字 / result 要約 200 字 / provider_session_id)を追記。書き込みは secure-io、要約はプロンプト/結果の先頭切出し(LLM 要約はしない — 決定論優先)。
2. `a2aBridge.route` の送信時・応答時にストアへ記録(`conversation_id` が無い呼び出しは記録しない = 現行互換)。`onResponse` のエラー黙殺(`:177`)は logger.warn に変更(IP-08 規約)。
3. サイズ管理: 1 会話 500 ターンでローテーション、KM-01 の janitor に TTL(30日)を登録。
4. unit test: 記録・相関(conversation_id での読み出し)・ローテーション。

### Task 2: セッション喪失からの会話復元 — `claude-sonnet-4`

1. AA-01 の `AgentRuntimeCrashedError` / restart 経路にフックし、`conversation_id` 付きの ask が新セッションで再実行される際、会話ストアの直近 N ターン(既定 10)の要約を「ここまでの経緯」としてプロンプト先頭に注入する `rehydrateConversation(conversationId)` を実装する。
2. 復元されたことを応答メタ(`rehydrated: true`)と supervisor events に明示する(黙って続けない — 受け手の判断材料)。
3. テスト: モック mediator で crash → restart → 再 ask に履歴が注入されること。

### Task 3: inflight 上限と admission — `claude-sonnet-4`

1. supervisor daemon の `handleRequest` に admission を追加: 全体上限(既定 8)と agent 単位上限(既定 2)を超える `ask` は `{ok:false, error:{type:'busy', retry_after_ms}}` で即応答。上限は env/設定で調整可能。
2. `a2aBridge.route` は busy 応答を `AgentBusyError` に変換。`withRetry` を使う呼び出し元(agent-actuator)が busy を retryable として扱うことを確認。mission worker(MO-03 の並列ディスパッチャ)は busy 時に該当 agent のキューを一時停止する。
3. in-process フォールバック経路にも同じセマフォ(`libs/core/semaphore.ts` が既存)を適用。
4. テスト: 上限超過で即拒否、解放後に通ること、agent 単位と全体上限の独立性。

### Task 4: 観測 — `claude-haiku`

- supervisor events に `inflight_total/inflight_by_agent` を定期(sweep 時)記録。`control_plane_cli` の status に「会話スレッド数 / inflight」を 1 行追加。`docs/developer/in-session-subagent-design.md` に会話モデルの節(単発 RPC / conversation_id 付き多ターン / 復元の3形態)を追記。

## リスクと注意

- 会話履歴の再注入は**古い文脈の混入**(すでに無効な指示の再適用)リスクがある。注入は要約 + 「これは復元された文脈であり、最新の指示を優先せよ」の定型前置きを必ず付ける。
- 会話ストアにはプロンプト要約が入るため tier 的には mission/runtime 領域(shared)。confidential ミッションの会話が要約経由で漏れないよう、記録時に mission tier を確認し、confidential 文脈ではプロンプト要約を省略(メタのみ記録)する。
- inflight 上限は小さすぎると MO-03 の並列化を殺す。既定値は MO-03 の `max_parallel_members`(3)と整合させ、双方の文書に相互参照を明記する。

## 実装メモ

- 2026-07-14 精査: STATUS の「残: inflight admission」は陳腐化と判明。`scripts/agent_runtime_supervisor_daemon.ts` の `ask` ハンドラは既に `GLOBAL_LIMIT`(既定8)/`AGENT_LIMIT`(既定2、env: `KYBERION_GLOBAL_INFLIGHT_LIMIT`/`KYBERION_AGENT_INFLIGHT_LIMIT`)超過を同期チェックし、超過時は `{ok:false, errorDetail:{type:'busy', retry_after_ms}}` を即返す。`a2a-bridge.ts` はこれを `AgentBusyError` に変換済み。`control_plane_cli` の status/A2A表示にも `threadCount`/`inflightCount` 行が実装済み。ただしこの admission 経路には単体テストが1本も無かったため、`scripts/agent_runtime_supervisor_daemon.test.ts` に「2並列 ask は許可・3並列目は busy 拒否・解放後に再許可」を検証するテストを追加(3回連続実行で安定を確認、typecheck/lint 緑)。残(軽微): `control_plane_cli` の inflight 表示行自体の単体テストは未着手。
