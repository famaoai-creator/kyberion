# AA-02: Mesh Hub 配送ドライバの実装 — 休眠中の at-least-once 配送を起動する

> 優先度: **P0**(KM-01 と同型の「実装済み・未稼働」) / 規模: M / 依存: なし / 関連: ecosystem roadmap E3(same-tenant Mesh 実証)、MO-06(ミッション内バスとは別物)

## 背景と課題

クロスホスト(same-tenant)エージェント通信のための **Mesh Hub は、配送保証の状態機械まで実装済みなのに、それを前進させる駆動系が存在しない**。

- 実装済み: `MeshMessageBroker`(`libs/core/mesh-message-broker.ts:419`)は JSONL 台帳(`active/shared/runtime/mesh-hub/**/deliveries.jsonl` + `dead-letter.jsonl`、`:119-125`)、idempotency dedup(`sha256(tenant_id:idempotency_key)`、`:194-204`)、状態機械 `accepted→queued→dispatched→acknowledged/completed | rejected | expired | dead_lettered`(`mesh-hub-contract.ts:20-30`)、指数バックオフ(1s→60s、max 5 attempts、`:81-85,246-250`)、TTL、観測イベント、検査レポート(`mesh-hub-inspection.ts:193`)まで持つ。HTTP+HMAC の peer 送信(`peer-messaging.ts:509-517`)、peer directory / presence heartbeat / topic registry / router も実装済み。
- **しかし駆動系ゼロ**: `claimDueMeshDeliveries` / `retryMeshDelivery` / `expireMeshDeliveries` / `acknowledgeMeshDelivery` の**本番呼び出し元が存在しない**(テストのみ)。broker と `MeshHubPeerMessagingAdapter.dispatchToPeer` を繋ぐ配線も無い。at-least-once・リトライ・dead-letter・TTL はすべて「潜在能力」で、キューは積まれても永遠に配送されない。
- 付随の弱点: writer fencing(`claimWriter`、`:363-369`)がプロセス内メモリのみで、同一 runtime root を共有する複数プロセス間の排他になっていない。受信側 down 時は `sendPeerMessage` が throw して outbox に `failed` 行を書くだけ(`peer-messaging.ts:546-556`)で、requeue する者がいない。

## ゴール(受入条件)

1. 配送ドライバが存在し、queued な delivery を claim → peer へ HTTP 配送 → ack/失敗記録 → バックオフ再試行 → 上限で dead-letter、のループを自動で回す。
2. 2 プロセス(送信側/受信側)のローカル実証で、(a) 正常配送、(b) 受信側停止→復帰後の再配送成功、(c) 5 回失敗→dead-letter、(d) 重複 idempotency_key の dedup、が E2E テストとして動く(roadmap E3 の実証環境の土台)。
3. writer fencing がプロセス間でも有効になる(ファイルロック)。
4. dead-letter とリトライ滞留がオペレータから見える(`mesh-hub-inspection` の既存レポートを doctor / 週次サマリに接続)。

## 実装状況 (2026-07-05)

- **完了(Task 1 / 受入1)**: `libs/core/mesh-delivery-driver.ts`(`runMeshDeliveryPass`)+ `scripts/mesh_delivery_driver.ts`(`pnpm mesh:deliver`)。ループ: `expireMeshDeliveries`(TTL 掃除)→ `claimDueMeshDeliveries(batch)` → 配送先 peer を catalog から解決 → `MeshHubPeerMessagingAdapter.dispatchToPeer`(HTTP+HMAC)→ 成功 `acknowledgeMeshDelivery` / 失敗 `retryMeshDelivery`(バックオフ・dead-letter は broker に委譲)。delivery 行に永続化済みの `idempotency_key` / `expires_at` を復元して再配送でも受信側 dedup が効く。既定はシングルパス(cron 向け)、`--loop` で常駐。`pipelines/mesh-delivery.json`(5分毎 cron)で chronos に登録。route が `requires_operator_selection` / peer 未解決のものは**自動選択せず** retry 経路へ(`automatic_peer_selection: deny` 維持)。
- **Task 2(設計変更あり)**: `claimWriter` のファイルロック化は、並列 vitest ワーカーが同一 runtime root で broker を構築する既存テスト群を壊すリスクが高いため見送り。多重起動防止(at-N-times 化の防止)は**ドライバ側**の `acquireLock('mesh-delivery-driver')`(`lock-utils`、プロセス間ファイルロック)で実現 — 二重起動時は後発が即終了。broker 内 fencing のプロセス間化は soak(AO-04)で必要性を再評価。
- **一部(Task 3 / 受入2)**: 状態遷移((a) 正常配送 → ack、(b) 失敗 → retry、(c) broker による dead-letter 遷移の計上、(d) idempotency_key 保全、unroutable、TTL expiry)は `mesh-delivery-driver.test.ts` 6 件で担保。**2 プロセス実 HTTP の E2E は未実施(残余)** — roadmap E3 パイロット時に実施。
- **完了(Task 4 / 受入4)**: `pnpm doctor` に「Mesh delivery」セクションを追加(総数 / in-flight / dead-letter 件数、最古の滞留 delivery、dead-letter 時の点検導線)。
- 検証: typecheck / lint / driver unit 6 件 + broker・doctor 既存テスト緑。空キューでのシングルパス実走(`--json`)確認済み。

## 実装タスク

### Task 1: 配送ドライバ本体 — `claude-sonnet-4`

1. `scripts/mesh_delivery_driver.ts` を新設(agent-runtime supervisor daemon の構造を踏襲: PID lock singleton、SIGINT/SIGTERM クリーンアップ)。ループ: `claimDueMeshDeliveries(batch)` → 各 delivery を `MeshHubPeerMessagingAdapter.dispatchToPeer` で送信 → 成功は `acknowledgeMeshDelivery`(受信側 ack 応答があれば completed、無ければ dispatched 止まりの二段階を契約 `mesh-hub-contract.ts` の定義に従って正しく使う)→ 失敗は `retryMeshDelivery`(バックオフは broker 側実装に委譲)。アイドル時は 2〜5 秒ポーリング。
2. 起動経路: (a) 常駐(daemon として)、(b) KM-01 の chronos cron から定期起動(数分間隔)の両対応にし、既定は (b)(常駐プロセスを増やさない)。
3. `expireMeshDeliveries` をループ先頭で実行(TTL 掃除)。
4. unit test: モック adapter で成功/失敗/リトライ/dead-letter の遷移。

### Task 2: プロセス間 writer fencing — `claude-sonnet-4`

- `claimWriter`(`mesh-message-broker.ts:363-369`)を、runtime root 配下のロックファイル(既存の `withLock` 機構が `libs/core` にあるため流用)でプロセス間排他に拡張する。fenced 時の挙動(待つ/譲る)は現行契約(`mesh_hub_writer_fenced`)を維持。テスト: 2 インスタンス同時 claim で片方が fenced。

### Task 3: E2E 実証(E3 パイロットの最小形)— `claude-sonnet-4`

1. `tests/` に 2 peer のローカル E2E を追加: 一時ディレクトリ 2 つを runtime root にし、受信側は `peer-messaging` の受信ハンドラ(HTTP サーバ)をローカル起動、peer catalog は fixture。ゴールの (a)〜(d) を検証。
2. 実行時間が長い場合(バックオフ待ち)は broker のバックオフ設定を fixture で短縮(1s→10ms)する — 設定が注入可能であることを確認し、不可なら注入口を追加(±20行)。
3. 結果を ecosystem roadmap E3 の項に「最小実証テスト実装済み(AA-02)」としてステータス追記。

### Task 4: 可観測化 — `claude-haiku`

- `formatMeshHubInspectionReport` の出力を `control_plane_cli` の doctor(または dashboard)に 1 セクション追加し、dead-letter 件数・最古の滞留 delivery を表示。週次サマリ(KM-01)にも 1 行(「Mesh 配送: 滞留 N / dead-letter M」)を追加。

## リスクと注意

- ドライバの多重起動は at-least-once を「at-N-times」にする。Task 2 の fencing を Task 1 より先か同時に入れること(受信側 dedup があるため実害は限定的だが、無駄な重複配送を避ける)。
- `automatic_peer_selection: 'deny'` ポリシー(`mesh-hub-contract.ts:224`)は**変えない**。本計画は配送機構の稼働までで、「どの peer に送るか」の自動化は roadmap E3/E5 の統治判断に委ねる。
- Mesh は confidential/テナント境界をまたぎ得る面。E2E fixture はダミーテナントのみ使用し、実 peer catalog(`knowledge/product/orchestration/peer-network.json`)に触れない。
