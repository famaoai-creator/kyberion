# SN-01: 表面非依存オーケストレーション

CLI・Slack 以外のチャンネル(telegram / iMessage / chronos / terminal)からの依頼でも、
同一のオーケストレーション連鎖(issue → prewarm → kickoff → followup⇄reconciliation →
distillation → completion)が透過的に動き、**依頼元の surface に結果が返る**ようにする。

## 現状の表面依存(2026-07-16 実地調査)

| 箇所                   | 依存                                                                                  | 影響                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 発行 API               | `issueSlackMissionFromProposal` のみ(Slack 固有の命名・イベント)                      | 他 surface は自前実装が必要                                    |
| イベント payload       | `SlackPayload`(channel / threadTs)に surface 識別なし                                 | ワーカーが返信先 surface を知らない                            |
| ワーカーの観測イベント | `emitSlackMissionEvent` が `channels/slack/missions.jsonl` 固定                       | 非 Slack ミッションも slack ストリームに記録                   |
| 結果返却               | reconciliation / completion が slack outbox + chronos outbox を無条件に書く           | terminal / telegram 発は結果が届かない                         |
| CLI 権限               | orchestration イベント書込は slack_bridge / chronos_gateway / chronos_localadmin のみ | CLI(mission_controller)から発行不可 → CLI ミッションは手動運転 |

## 設計方針

既存の汎用部品に寄せる(新機構は作らない):

- surface 識別: `SurfaceAsyncChannel`(拡張可能 string)を payload に載せる
- 結果返却: `enqueueSurfaceOutboxMessage({ surface, channel, threadTs, text })` —
  各ブリッジ(slack / telegram / chronos / …)は自分の outbox を drain する既存契約のまま
- 観測: `emitChannelSurfaceEvent(agent, surface, 'missions', …)` に surface を透過
- terminal の結果返却: outbox(耐久レコード、`mission_controller status` で参照)+
  完了/ブロック時は `notifyOperator`(operator の設定チャネルへ push)

## フェーズ

### Phase 1(本 PR)

1. **payload**: `SlackPayload` に `surface?: SurfaceAsyncChannel` を追加(未指定は 'slack' = 後方互換)。
2. **発行 API の中立化**: `issueMissionFromProposal({ surface, channel, thread, proposal, … })` を
   canonical にし、`issueSlackMissionFromProposal` は薄いラッパーとして維持。
   ミッション ID プレフィクス・観測ストリームは surface から導出。
3. **ワーカーの surface ルーティング**: `emitSlackMissionEvent` → `emitMissionSurfaceEvent`
   (payload.surface で `channels/<surface>/missions.jsonl` へ)。reconciliation / completion の
   結果返却は `payload.surface` 宛の汎用 outbox 1本 + chronos ミラー(現行仕様、best-effort)。
   completion 成功時は surface を問わず `notifyOperator('mission_completed')`(dedupe あり)。
4. **CLI 権限**: `mission_controller` authority role に
   `active/shared/coordination/orchestration/` の write scope を付与
   (KSMC がライフサイクルイベントを発行できるのは設計意図に合致)。
5. **CLI 配線**: `run_intent` のコンパイル結果が `execution_shape: mission` のとき、
   `issueMissionFromProposal({ surface: 'terminal', … })` で自動発行 —
   CLI からの依頼も同じ連鎖に透過的に乗る。

### Phase 2(別 PR 候補)

- telegram / iMessage ブリッジの受信側に mission proposal 確認 UX を接続
  (Slack の `1 / やめる` パターンの共通化 — `surface-mission-proposals` の確認判定は既に汎用)。
- terminal outbox の drain: `mission_controller status` / chronos UI に「未読の結果」を表示。
- chronos ミラーの権限修正(worker identity で chronos outbox に書けるように role 整理)。

## 検証

- 単体: 発行 API の surface 別 payload / ID プレフィクス、ワーカーの outbox ルーティング。
- 実地: terminal 発ミッションを 1 本流し、orchestration 連鎖の完走と
  terminal outbox / operator 通知への結果着地を確認する。
