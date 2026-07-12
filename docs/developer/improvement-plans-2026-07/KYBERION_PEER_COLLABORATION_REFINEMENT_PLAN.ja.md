# Kyberion 間連携の実証・改善計画

作成日: 2026-07-12
対象ミッション: `MSN-KYBERION-PEER-COLLAB-20260712`

## 1. 目的

同一ホスト内および同一 tenant の LAN 上にある Kyberion 同士が、単にメッセージを交換するだけでなく、次の一連の流れを監査可能に完遂できる状態を作る。

```text
peer discovery / presence
  -> conversation
  -> typed collaboration request
  -> recipient acceptance
  -> WorkItem または A2A task contract
  -> worker execution
  -> handoff / review packet
  -> mission owner accept or reject
  -> completion notification
```

Mesh Hub は control plane に限定し、mission lifecycle の変更権限は引き続き `mission_controller` だけが持つ。v1 の same-tenant、single-writer、明示的 peer 選択、personal tier 配送禁止を維持する。

## 2. 今回の実証結果

### 同一ホスト

- `kyberion-local-b` を `127.0.0.1:4101` で起動し、`kyberion-local-a` から署名付き `handoff` を配送した。
- session `PCS-MRGQ4C5O-EEFF7CD9` に送受信双方の transcript、`WI-PEER-COLLAB-SAME-HOST`、mission ID、同期 ACK が記録された。
- receipt は `accepted: true`、`processing_mode: synchronous_on_receive` で、HMAC transport と conversation persistence は機能した。
- peer messaging、conversation、WorkItem peer bridge、Mesh Hub adapter / broker の focused test は 5 files、16 tests が成功した。

### Mesh Hub

- operator inspection は peer 0、delivery 0、dead letter 0、topic 0 を返した。
- 静的 `peer-network.json` は存在するが、live presence と capability advertisement は自動的には生成されない。
- Mesh Hub adapter は受信要求を A2A / WorkItem proposal に変換できるが、conversation responder からこの adapter への governed bridge はない。

### LAN ホスト `192.168.128.173`

- `22/tcp` は到達可能。
- `4100/tcp` と `4101/tcp` には listener がない。
- SSH host key は確認できたが、`famaoai` の公開鍵認証は拒否されたため、リモート Kyberion の状態確認や設定変更は実施していない。

## 3. 現状の主要ギャップ

### 2026-07-12 同一ホスト実装更新

- PC-02 の最小実装: tenant-aware conversation listener の起動時 enrollment / capability advertisement / heartbeat / shutdown maintenance を実装した。
- PC-03: 署名済み `handoff` の明示的 `collaboration_request` を Mesh recipient proposal に変換した。通常会話は proposal 化しない。
- PC-04: proposal の `list` / `accept` / `reject` CLI と append-only decision journal を実装した。actor と reason は必須で、二重判定を拒否する。
- recipient、tenant、request kind、classification、TTL を proposal 永続化前に検証し、同じ `request_id` の再送を deduplicate する。
- 実 CLI で healthy presence、typed handoff、pending proposal、operator accept まで完走した。
- focused regression は 6 files、24 tests が成功した。
- acceptance 後の WorkItem/A2A 実行、task status projection、非同期 ACK は引き続き PC-05〜PC-07 の対象である。

| 優先度 | ギャップ                                                                  | 影響                                                                   |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P0     | conversation の受領と WorkItem / A2A proposal が別経路                    | 会話しても作業開始まで operator が手動で橋渡しする                     |
| P0     | peer listener 起動時に presence / capability を登録・更新・失効させない   | Mesh Hub の discovery と実 transport の状態が一致しない                |
| P0     | LAN peer bootstrap の安全な runbook と preflight がない                   | host、port、key、tenant、時刻差、policy の不備を実行時まで発見できない |
| P1     | recipient acceptance の queue / CLI / inspection が統一されていない       | 受領済みと実行許可済みを operator が判別しにくい                       |
| P1     | task の進捗・handoff・owner review が conversation session に投影されない | 「話した結果、何が進んだか」を一つの相関 ID で追えない                 |
| P1     | synchronous responder が処理完了まで HTTP ACK を返さない                  | 長い処理で timeout と重複送信が起きやすい                              |
| P1     | shared secret が静的 catalog の平文値を前提にする                         | 複数ホスト運用で配布・rotation・失効が弱い                             |
| P2     | 同一ホストの二つの peer が同じ runtime root を共有できる                  | transcript や single-writer state の責任境界が曖昧になる               |
| P2     | 物理ホスト間の failure / recovery E2E がない                              | partition、再起動、clock skew、重複配送の回帰を検出できない            |

## 4. 改善方針

### 4.1 Conversation を入口、typed request を実行境界にする

自然言語 conversation を直接実行しない。受信側は会話から明示的な `review.request`、`workitem.claim`、`workitem.handoff` などの proposal を生成し、schema、tenant、capability、data tier、authority を検証して acceptance queue に置く。

accept 後だけ WorkItem / A2A contract を作る。作業結果は元の `session_id`、`correlation_id`、`work_item_id` を保持した handoff として owner に返す。

### 4.2 Transport acceptance と work acceptance を分離する

HTTP 応答は durable inbox への保存後に速やかに返す。応答状態を次の二段階に分ける。

- `transport_accepted`: 署名、TTL、recipient、schema、dedup を通過して保存済み
- `work_accepted`: recipient policy または operator が task 化を承認済み

conversation UI / CLI / inspection では両者を別表示する。

### 4.3 Presence を listener lifecycle に結び付ける

peer runtime 起動時に enrollment を照合し、presence と capability advertisement を登録する。heartbeat を更新し、graceful shutdown で unavailable、TTL 超過で expired にする。静的 catalog は endpoint / key reference の bootstrap に限定する。

### 4.4 秘密値を catalog から分離する

catalog には `key_ref` のみを保存し、実値は環境変数または governed secret provider から解決する。peer 単位の key ID、rotation grace period、revocation、最終利用時刻を管理する。計画書・ログ・conversation metadata に秘密値を残さない。

### 4.5 一つの相関 ID で全経路を追跡する

以下を `correlation_id` で結ぶ。

- conversation session / message
- Mesh request / delivery
- acceptance decision
- WorkItem / task lease
- handoff / review decision
- completion notification

operator inspection は payload を表示せず、状態、peer、経過時間、失敗分類、次の操作だけを表示する。

## 5. 実施フェーズ

### Phase 0: 二台の runtime を安全に立ち上げる

成果物:

- peer bootstrap preflight
- host ごとの runtime root / peer ID / tenant ID / port の割当表
- secret provisioning / rotation runbook
- macOS launchd または systemd の listener / delivery driver 定義

`192.168.128.173` 側で必要な準備:

1. operator が SSH 公開鍵を許可するか、リモート端末上で直接操作する。
2. Kyberion の revision と baseline status を確認する。
3. peer ID、tenant ID、runtime root、listener port を確定する。
4. listener は LAN address または `0.0.0.0` に bind し、host firewall は送信元 LAN のみに制限する。
5. shared secret を secret provider に登録し、catalog には key reference を置く。
6. listener、presence heartbeat、Mesh delivery driver を起動する。

受入条件:

- 両ホストで baseline が成功する。
- peer ID と runtime root が重複しない。
- tenant mismatch、無効署名、期限切れ message が fail closed になる。
- operator inspection で双方の presence と capability が fresh と表示される。

### Phase 1: 同一ホストの完全 E2E

二つの独立 runtime root と port を使い、次を自動化する。

1. peer A / B 起動
2. presence / capability 確認
3. conversation open
4. `workitem.handoff` proposal 作成
5. recipient accept
6. worker claim と task lease 発行
7. status update と成果 artifact 作成
8. handoff
9. owner verify
10. conversation close と trace 検証

受入条件:

- mission state を変更するのは owner の controller だけである。
- worker は task-local output 以外を変更できない。
- 同じ idempotency key の再送で task が増えない。
- 全状態を一つの correlation ID で追跡できる。

### Phase 2: LAN E2E

Phase 1 と同じ scenario を `192.168.128.173` に対して実行する。payload 本体は tier-authorized artifact store に置き、Mesh / observability には metadata、reference、hash だけを残す。

追加受入条件:

- peer port は許可した LAN source 以外から到達できない。
- timeout 後の retry で重複実行しない。
- recipient 停止中は queued / retrying、復帰後は completed になる。
- clock skew が TTL 許容値を超える場合は preflight で停止する。
- confidential reference は same tenant だけで配送され、personal は拒否される。

### Phase 3: 会話しながら進める operator UX

conversation session に proposal、acceptance、task status、handoff、review を timeline として投影する。Kyberion は次の操作候補を返すが、自動承認はしない。

例:

```text
B: 要求を受領しました (transport_accepted)
B: WorkItem proposal WI-123 を作成しました。受諾待ちです
Operator B: accept WI-123
B: task lease TL-456 を取得し、作業を開始しました
B: 成果 AR-789 を handoff しました
A(owner): verified
A: session completed
```

### Phase 4: resilience / soak

- listener 強制停止と復帰
- ACK 消失と重複配送
- invalid HMAC / revoked key
- stale presence
- dead-letter と operator replay
- delivery driver 二重起動
- runtime root の誤共有
- 100 session / 1,000 message の bounded soak

## 6. 実装バックログ

| ID    | 優先度 | 作業                                             | 完了条件                                                                                                           |
| ----- | ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| PC-01 | P0     | `peer-collaboration-preflight` pipeline / CLI    | local と remote の baseline、port、tenant、clock、presence、capability、key reference を診断し、秘密値を出力しない |
| PC-02 | P0     | listener lifecycle と Mesh presence の統合       | 起動・heartbeat・shutdown・expiry が focused test と二 peer E2E で確認できる                                       |
| PC-03 | P0     | conversation-to-proposal bridge                  | 許可された message kind だけが validated proposal になり、mission mutation は常に deny                             |
| PC-04 | P0     | acceptance queue と operator command             | transport acceptance と work acceptance が分離され、accept / reject が監査される                                   |
| PC-05 | P1     | proposal-to-WorkItem / A2A dispatch              | task lease、idempotency、recipient policy を維持して実行できる                                                     |
| PC-06 | P1     | task status / handoff の conversation projection | correlation ID で conversation から owner review まで追跡できる                                                    |
| PC-07 | P1     | asynchronous receive boundary                    | durable write 後に ACK し、長時間処理を HTTP handler 外へ移す                                                      |
| PC-08 | P1     | `key_ref` 化と rotation                          | catalog に平文 secret がなく、rotation / revoke test が通る                                                        |
| PC-09 | P1     | physical two-host E2E pipeline                   | 同一 scenario が host parameter の差だけで local / LAN の双方を通る                                                |
| PC-10 | P2     | failure / soak suite                             | partition、duplicate、stale presence、dead-letter、二重 writer を再現できる                                        |
| PC-11 | P2     | unified inspection timeline                      | payload 非表示のまま session、delivery、task、review の状態と次操作を表示する                                      |

## 7. 推奨実施順

`PC-01 -> PC-02 -> PC-03 -> PC-04 -> PC-05 -> PC-06 -> PC-09` を最短の縦切りとする。`PC-07` と `PC-08` は LAN pilot 前の必須 gate、`PC-10` と `PC-11` は pilot 後の hardening とする。

最初の成功指標は「二台が自由会話すること」ではない。operator が一つの session を見て、誰が要求し、誰が受領し、何を承認し、どの task が実行され、owner が何を根拠に完了としたかを説明できることである。

## 8. 次回の実機検証開始条件

- `192.168.128.173` で operator がコマンドを実行できる、またはこのホストから SSH 公開鍵認証できる。
- リモートの Kyberion root と revision が判明している。
- peer port と host firewall 方針が合意されている。
- same-tenant の peer ID と secret `key_ref` が払い出されている。
- remote 変更前に両ホストの baseline report を保存している。
