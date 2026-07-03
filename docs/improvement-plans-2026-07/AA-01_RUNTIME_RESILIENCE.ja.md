# AA-01: Agent runtime の耐障害化 — クラッシュ検知・タイムアウト・デーモン堅牢化

> 優先度: **P0** / 規模: M / 依存: なし / 関連: IP-08(エラー規律)、IP-07(テスト)

## 背景と課題

エージェント間通信の土台であるランタイム面(a2a-bridge → supervisor daemon → agent-lifecycle → ACP mediator → provider CLI 子プロセス)に、**故障を検知・回復する仕組みがほぼ無い**。

- **子プロセスのクラッシュを検知しない**: `ACPMediator` は stdout/stderr のハンドラは持つが **`child.on('exit'|'close'|'error')` が一切無い**(`libs/core/acp-mediator.ts` 全体で確認済み)。provider CLI が死んでも `booted: true` のまま、次の `ask` はハングする。
- **healthCheck がスタブ**: `agentLifecycle.healthCheck`(`agent-lifecycle.ts:448-465`)はコメントに「子プロセス生存確認」と書きながら、実際は記録済み status を返すだけ。死んだ子も `ready` と報告される。
- **`ask` にターンタイムアウトが無い**: `ACPMediator.ask`(`acp-mediator.ts:306-341`)は無期限待ち。上流のソケットタイムアウト 60 秒(`agent-runtime-supervisor-client.ts:66-70`)だけが命綱で、in-process フォールバック経路(`a2a-bridge.ts:155`)にはそれすら無い。boot 時の固定 `setTimeout(2000)`(`:283`)も雑。
- **デーモンが transient エラーで全滅する**: `server.on('error')` が即 process 終了(`agent_runtime_supervisor_daemon.ts:278-281`)。EADDRINUSE 一発でホスト内通信面全体が落ちる。lock/socket 処理まわりに空 catch が約8箇所(`:233-272`)。observability 書き込みも全エラー黙殺(`agent-runtime-supervisor.ts:64-67`)。
- **最重要3コンポーネントがテストゼロ**: `acp-mediator.ts`、`agent-lifecycle.ts`、supervisor daemon(IPC サーバ・lock singleton・error-exit 経路)。

## ゴール(受入条件)

1. provider 子プロセスの exit/error が即時検知され、該当ランタイムが `error` にマークされる。`ask` 実行中のクラッシュは「セッション喪失」の型付きエラーとして呼び出し元に返り(60秒ハング待ちではなく)、supervised restart(上限付き)が任意で働く。
2. `healthCheck` が実際に liveness を確認する(pid への signal-0。pid は `acp-mediator.ts:96` で取得可能)。
3. `ask` にターン単位のタイムアウト(既定 60s、呼び出し側指定可)が入り、in-process フォールバック経路にも適用される。
4. デーモンが transient bind エラーで死なない(既存デーモンの health を確認して exit 0 / リトライ)。空 catch は IP-08 の triage 規約(理由コメント or logger.warn)で処置される。
5. 3 コンポーネントに unit テストが付く(子プロセスはモック)。

## 実装タスク

## 実装状況 (2026-07-03)

- **完了(代表スライス)**: `ACPMediator` に `AgentRuntimeCrashedError` / `AgentTurnTimeoutError`、turn timeout(既定 60s、呼び出し側指定可)、pending `ask` の crash reject、recent log 添付、pid signal-0 の `isProcessAlive()` を追加。
- **完了(代表スライス)**: `agentLifecycle.healthCheck()` が ACP mediator の pid liveness を確認し、死活不明の agent を `error` に落とすように変更。`askAgentRuntime()` と supervisor daemon の `ask` payload から `timeoutMs` を渡せるようにした。
- **完了(代表スライス)**: supervisor event 書き込み失敗を初回のみ `logger.warn`、daemon の lock/socket cleanup の空 catch を warning 化し、`EADDRINUSE` は stale socket cleanup 後に 1 回 retry する。
- **検証済み**: `pnpm exec vitest run libs/core/acp-mediator.test.ts tests/agent-runtime-observability.test.ts libs/core/agent-runtime-supervisor.test.ts`、`pnpm run validate`。
- **完了(代表スライス拡張)**: `agentLifecycle.healthCheck()` から restart budget を見て ACP runtime を上限付きで自動再 spawn する経路を追加した(既定オフ、`restartPolicy` 指定時のみ)。`ACPMediator` の crash callback も残している。
- **完了(代替検証)**: daemon IPC の unit test を TCP transport で追加し、`ensure` / `ask` / `health` / malformed JSON の 4 ケースを通した。実環境の既定 transport は従来どおり unix socket のまま維持している。
- **完了**: exec adapter の子プロセス liveness を pid signal-0 で healthCheck に接続し、boot の固定 2 秒 sleep を ready signal + 上限待ちに置換した。

### Task 1: 子プロセス exit ハンドリング — `claude-sonnet-4`

1. `ACPMediator` の spawn 箇所(`:144` の `spawnManagedProcess`)に `exit`/`error`/`close` リスナーを追加: 状態を `crashed` に遷移、進行中の `ask` の pending promise を型付きエラー(`AgentRuntimeCrashedError { agentId, exitCode, signal }`)で reject、ring buffer の直近ログをエラーに添付。
2. exec アダプタ(Claude/Codex、`agent-lifecycle.ts:278-311`)にも同等の検知があるか確認し、無ければ揃える。
3. supervised restart: `agent-lifecycle` に「crashed 検知時、`restartPolicy: { maxRestarts: 2, window: 10min }` の範囲で自動 re-spawn」を追加(既定はオフ=現行互換。ミッション worker 経由の runtime のみオンにする判断は呼び出し側)。
4. unit test: モック child の exit → 状態遷移・pending reject・restart 上限。

### Task 2: healthCheck の実体化と ask タイムアウト — `claude-sonnet-4`

1. `healthCheck`(`agent-lifecycle.ts:448-465`)を pid signal-0 + mediator/adapter の応答性(直近 ask 成否)で判定する実装に置換。daemon の health メソッドと `runtimeSupervisor.startSweep`(`runtime-supervisor.ts:153-161`)がこれを使うことを確認。
2. `ACPMediator.ask` と in-process `askAgentRuntime` 経路に AbortSignal ベースのタイムアウトを追加(既定 60s、`route` のオプションで指定可)。タイムアウトは `AgentTurnTimeoutError` として分類し、AC-01 のエラー分類形式に合わせる。
3. boot の固定 2 秒 sleep(`acp-mediator.ts:283`)を「ready シグナル待ち + 上限」に置換できるか確認し、できなければ理由コメントを残して現状維持。
4. テスト: タイムアウト発火・正常完了・クラッシュ併発の3系。

### Task 3: デーモン堅牢化 — `claude-sonnet-4`

1. `server.on('error')`(`daemon:278-281`): EADDRINUSE の場合は既存デーモンへ health 照会 → 生きていれば exit 0(二重起動の正常収束)、死んでいれば stale socket 掃除 + 1 回リトライ。他エラーは現行どおり異常終了(ただしエラー内容を必ずログ)。
2. `:233-272` の空 catch 群を triage: lock/stat/unlink 系は理由コメント付き、JSON parse 失敗は logger.warn + 該当リクエストへのエラー応答。
3. `appendSupervisorEvent`(`agent-runtime-supervisor.ts:64-67`)の黙殺を「初回のみ logger.warn(log-once)」に変更。
4. デーモンの IPC を unit テスト化: 一時ディレクトリの socket でサーバ起動 → ensure/ask(モック lifecycle)/health/不正 JSON の4ケース。

### Task 4: 検証 — `claude-haiku`

- `pnpm test:core` 全体、新テスト、および手動確認手順(daemon 起動 → provider CLI の子プロセスを kill → `list` が error 表示 → 自動/手動 restart)を実行し結果を報告する。

## リスクと注意

- 自動 restart は「クラッシュループ」を作り得る。**上限と時間窓を必ず入れ、既定オフ**から始める。
- `ask` タイムアウトの導入で、これまで 60 秒超かかって成功していた長いターンが落ちるようになる可能性がある。導入前に supervisor events(`agent-runtime-supervisor-events.jsonl`)から実測の ask 所要分布を確認し、既定値を決める(60s が短ければ 120s)。
