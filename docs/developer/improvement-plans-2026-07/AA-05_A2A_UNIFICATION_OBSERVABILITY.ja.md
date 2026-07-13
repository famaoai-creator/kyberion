# AA-05: 「A2A」二重実装の整理とメッセージフローの統一観測

> 優先度: P2 / 規模: S〜M / 依存: AA-02(Mesh 稼働後に観測統合の価値が出る)

## 背景と課題

### 同名・非互換の「A2A」が2つある

- **`a2aBridge.route`**(`libs/core/a2a-bridge.ts`): ホスト内の同期 RPC。ミッション/surface の実運用経路。
- **`a2a-transport.ts`**(`libs/actuators/network-actuator/src/`): ファイルシステム inbox/outbox(`active/shared/runtime/a2a/{inbox,outbox}`、`:21-22`)+ RSA/AES ハイブリッド暗号。network パイプラインの `a2a_send`/`a2a_poll` op からのみ到達(`network-pipeline-helpers.ts:201-202,238`)。

両者は envelope の形は似ているが**一切相互運用しない**。しかもファイル版は読み取り時に unlink(`a2a-transport.ts:73`)= at-most-once で、**parse 失敗はメッセージを黙って消失させる**(`:75-77`)。名前の同一性は誤配線(「A2A で送ったのに届かない」)の温床。gist トランスポートのスタブは AC-06 Task 2 で処置済みの前提。

### ミッションのメッセージフローが 3 つのログに分断

- Plane 1: audit chain(`a2a-bridge.ts:84,141`)+ `a2a_message_routed` 観測イベント(`:116-135`)+ supervisor events(`agent-runtime-supervisor-events.jsonl`)
- ACP 子プロセス: メモリ内 200 エントリのリングバッファのみ(`acp-mediator.ts:75,84-88`)— 再起動で消失
- Plane 2: mesh-hub の delivery events(`mesh-message-broker.ts:344-361`)

**共通の相関 ID が無く**、オペレータは「ミッション X のメッセージフロー」を一望できない。

## ゴール(受入条件)

1. 2 つの A2A の役割と使い分けが明文化され、コード上も区別される(ファイル版のリネームまたは統合方針の決定・実施)。ファイル版の「parse 失敗で黙って消失」が解消される。
2. 全メッセージ(bridge / ACP ターン / mesh delivery)が共通の相関キー(`mission_id` + `conversation_id` / `correlation_id`)を運び、**1 コマンドでミッションのメッセージフロー時系列が出る**。
3. ACP のやり取りの要点(ターン開始/終了/エラー)が永続ログに残る(リングバッファ全量の永続化はしない)。

## 実装タスク

### Task 1: 二重実装の処置判断と実施 — `claude-sonnet-4`

1. `a2a_send`/`a2a_poll`(ファイル版)の利用実態を棚卸しする(pipelines / knowledge/product/pipeline-templates / docs を grep)。
2. 推奨処置(利用実態が薄い前提): ファイル版を `envelope-drop-transport` 等に**リネーム**し、network-actuator の op 名は互換エイリアスとして残す。ドキュメント(CAPABILITIES_GUIDE の境界節 = AC-06 Task 4)に「エージェント間のリアルタイム通信は a2aBridge、非同期のファイル受け渡しは envelope-drop」と明記。利用が厚い場合は統合(bridge の非同期モードとして吸収)を設計タスクに切り出して報告。
3. ファイル版の堅牢化(処置と独立に実施): parse 失敗時は unlink せず `inbox/.quarantine/` へ移動 + logger.warn(黙殺消失の解消)。読み取り→処理→unlink の順序を「処理成功後 unlink」に変更。テスト追加(`a2a-transport` は現在専用テスト無し)。

### Task 2: 相関 ID の貫通 — `claude-sonnet-4`

1. `a2aBridge.route` の envelope に `correlation_id`(呼び出し元が未指定なら生成)を追加し、(a) supervisor client の ask ペイロード → daemon → mediator へ引き回し、ACP のターン開始/終了ログに含める。(b) mission worker の dispatch(MO-03)と mesh 送信(`peer-messaging`)にも同キーを伝搬する。
2. ACP mediator のリングバッファのうち「ターン開始/終了/エラー」イベントのみを supervisor events JSONL へ永続化する(全 stdio は残さない — 容量と機密の両面から)。
3. 変更は各ログのフィールド**追加のみ**(既存読み手を壊さない)。

### Task 3: フロー閲覧コマンド — `claude-sonnet-4`

1. `pnpm cli -- mission flow <MISSION_ID>`(または control_plane_cli 配下)を追加: audit chain / supervisor events / mesh delivery events / mission-task-events を mission_id + correlation_id で突合し、時系列のメッセージフロー(送信者→受信者、performative、所要、成否)を表で出す。
2. 出力語彙は UX-05 の `renderStatus` を使い、生 enum を出さない。
3. fixture ログでの unit test + 実ミッション 1 件での手動確認。

### Task 4: 文書化 — `claude-haiku`

- `docs/developer/`(in-session-subagent-design.md または新設 `AGENT_COMMS.md`)に通信スタックの全体図(Plane 1 / Plane 2 / ファイル版の位置づけ、相関 ID の流れ、ログの所在)を 1 ページで記載し、`docs/COMPONENT_MAP.md` からリンクする。

## リスクと注意

- リネームは semver 上の破壊的変更になり得る(op 名)。互換エイリアスを 1 リリース維持し、`check:contract-semver` の判定に従う。
- 相関 ID の伝搬は複数モジュールを横断する薄い変更の集合で、コンフリクトしやすい。AA-01〜04 の実装が落ち着いた後に実施する(Wave 上も後段に置く)。

## 実装メモ

- 2026-07-14: Task 1.3(ファイル版の堅牢化)を実装。従来の `pollA2AInbox` は parse 失敗時に unlink しないだけで、同じ壊れたファイルを毎回再読込・再度 parse 失敗・再度エラーログ、という無限リトライになっていた(黙って消える訳ではないが、実質的に detectable でも回復不能だった)。`inbox/.quarantine/` へ1回だけ `safeMoveSync` で退避し `logger.warn` するよう変更(専用テスト0本だったため `a2a-transport.test.ts` を新設、送信/正常消費/quarantine/混在ポーリングの4本)。Task 1.1/1.2(二重実装の処置判断・リネーム方針)、Task 2(相関ID貫通)、Task 3(mission flowコマンド)は未着手のまま。
