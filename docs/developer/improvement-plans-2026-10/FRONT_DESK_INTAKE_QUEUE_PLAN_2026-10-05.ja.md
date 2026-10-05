---
title: 'Front desk 依頼キューと実行結果の反映計画 (FQ-01〜08)'
tags: [front-desk, conversation, dots, work-items, chronos, autonomy, plan]
last_updated: 2026-10-05
status: active
---

# Front desk 依頼キューと実行結果の反映計画 (FQ-01〜08)

- 前提: PR #929（会話内の依頼記録と結果の反映）、[Resident dot 自律組織ループ計画](./DOT_ORG_LOOP_PLAN_2026-10-04.ja.md)
- 関連: [会話エンジン計画](./CONVERSATION_ENGINE_PLAN_2026-10-04.ja.md)、[front-desk-continuity](../front-desk-continuity.md)、[resident-dot-model](../../../knowledge/product/architecture/resident-dot-model.md)

## 背景

PR #929 で、会話の中の依頼は viewer スコープの transcript に記録され、その場で回答できたもの（runtime が `direct_answer` かつ `autonomous` と判定したもの）は `completed` として回答の抜粋を残すようになった。
一方、承認や実行が必要なもの（`needs_execution`）と、利用者への確認待ち（`awaiting_input`）は状態が付くだけで、実行する主体がいない。

本計画では、会話は**記録と受付だけ**を担い、その場で返せない依頼をキューに入れて自律的な実行者が処理し、**実行結果が元の依頼記録から見える**ところまでを閉じる。

## 方針（判断済み）

- **会話は記録のみ**: 会話 runtime は依頼を実行しない。その場で答えられたものは即 `completed`、それ以外はキューへ渡す。
- **自律度は work-scope-policy で決める**: キュー投入時の実行形態（`direct_reply` / `pipeline` / `task_session` / `mission`）は `resolveWorkScopeDecision` が決める。会話側で独自の判定基準を持たない。
- **実行は組織横断の常駐主体に寄せる**: 実行は resident dot（executor）と Chronos（スケジューラ / トリガ）が担う。front desk に実行ループを作らない。
- **テナント境界を越えない**: キュー・実行・結果参照のすべてで、依頼を記録した viewer のテナントスコープを引き継ぐ。

## 全体の流れ

1. 利用者の発話は front desk の transcript に依頼として記録される（PR #929）。
2. runtime の結果を `classifyConversationTurnOutcome` が分類する。
   - `answered` → 依頼を `completed` にし、回答の抜粋を残す（PR #929 で実装済み）。
   - `awaiting_input` → 利用者の返答を待つ。キューには入れない。
   - `needs_execution` → 3 へ。
3. front desk がテナントスコープの WorkItem を作り、依頼記録の `workItemId` に紐づける。
4. 担当の intake dot が wake し、work-scope-policy と dot の自律度ゲートを通して実行形態を決める。
5. dot executor が WorkItem を claim して実行し、結果を WorkItem に書く。
6. 利用者が会話で状況を聞くと、front desk は `workItemId` から WorkItem を viewer スコープで読み、実行状態と結果を返す。
7. Chronos は組織横断で未処理・停滞中の依頼を可視化する。

## 項目

| ID    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FQ-01 | **キュー投入**: `needs_execution` の依頼から WorkItem を作る（`createWorkItem`）。`source` は front desk、`sourceRef` は会話 ID と依頼 ID、`context` は viewer から解決した `tenant_slug → organization_id → project_id`。`metadata.dot_id` に intake dot を、`metadata.requested_work_shape` は FQ-03 の結果を入れる。作成後、依頼記録に `workItemId` を保存する。同じ依頼から二重に作らないよう、依頼 ID を冪等キーにする。 |
| FQ-02 | **intake dot**: テナントごとの front desk intake dot の charter を定義する（`surface` チャネルの `wake` トリガ）。dot-inbox には依頼本文を載せず、WorkItem ID などの参照だけを書く（inbox は system floor の共有ファイルで、テナントの文章を置けないため）。                                                                                                                                                                  |
| FQ-03 | **自律度の決定**: 依頼文と runtime の `intentResolution` を `resolveWorkScopeDecision` に渡して実行形態を決める。mandatory trigger や accumulation trigger で `mission` になったものは承認経路へ回す。dot の自律度（L0〜L4）と `autonomous-ops-gate` がさらに上限をかける。                                                                                                                                                   |
| FQ-04 | **実行**: dot executor の既存ルーティングに従う。`direct_reply` と許可済み pipeline は実行、`mission` は escalation（dot から mission を開始する拡張ができるまで）、`task_session` は拒否して理由を WorkItem に残す。拒否や escalation も「結果」として扱い、利用者に見えるようにする。                                                                                                                                       |
| FQ-05 | **結果の反映**: 依頼記録の状態は、`workItemId` がある場合は WorkItem から都度読み出して決める（`ready` / `claimed` → 実行中、`done` → 完了と結果、`failed` / `cancelled` → 理由）。dot には transcript への書き込み権限を与えない。transcript 側に結果を複製しないので、二重管理による不整合が起きない。                                                                                                                      |
| FQ-06 | **状況の回答**: `task_status_needs_execution` の文言を、WorkItem の状態に応じた語彙に置き換える（実行待ち・実行中・完了・失敗・承認待ち）。語彙は `user-facing-vocabulary.json`（en / ja）に追加する。                                                                                                                                                                                                                        |
| FQ-07 | **Chronos の可視化**: front desk 由来の WorkItem を Chronos の組織ビューに出す。閲覧は `ViewerContext` で解決したテナントスコープに限定し、停滞（一定時間 claim されない、承認待ちのまま）を検出したら dot の inbox か通知に回す。                                                                                                                                                                                            |
| FQ-08 | **取り消し・追記の連動**: 会話での取り消し（`task_cancellation`）は WorkItem の cancel 要求に、名前付きの追記（followup）は WorkItem への追記に変換する。どちらも実行中の場合は executor 側の判断に委ね、結果を FQ-05 の経路で返す。                                                                                                                                                                                          |

## テナント境界と権限

- WorkItem の `context.tenant_slug` は viewer のスコープから決める。クライアントが渡すテナント指定は絞り込みにしか使わない。
- dot executor は charter のテナントと WorkItem のテナントが異なる場合に claim しない（既存の拒否処理）。
- 依頼本文と結果の文章はテナント側の保存領域に置き、`system/` floor（dot-inbox を含む）には参照と区分だけを書く。
- 状況の回答は、依頼を記録した viewer のスコープで WorkItem を読めた場合に限る。読めない場合は「状況を確認できない」と返し、存在の有無も漏らさない。

## 段階

1. **FQ-01 / FQ-02 / FQ-05**: キュー投入、intake dot、状態の読み出し。ここまでで「記録 → 実行 → 結果が見える」が閉じる。
2. **FQ-03 / FQ-04 / FQ-06**: work-scope-policy による自律度の決定と、拒否・escalation を含む結果の語彙。
3. **FQ-07 / FQ-08**: Chronos の可視化と、取り消し・追記の連動。

## 検証

- 依頼 1 件ごとに、`needs_execution` → WorkItem 作成 → dot による claim → 完了 → 会話で結果が返る、までを結合テストで確認する。
- 冪等性: 同じ依頼で complete が再実行されても WorkItem は 1 件。
- 境界: 別テナントの viewer から `workItemId` を指定しても状態が返らない。dot が別テナントの WorkItem を claim しない。
- 退行: `answered` の依頼は WorkItem を作らず、PR #929 の `completed` の挙動が変わらない。
