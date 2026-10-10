---
title: Kyberion 性能・リソース効率レビューと Luna 向け改善計画
tags: [performance, resource-efficiency, review, luna, implementation-plan]
last_updated: 2026-10-07
---

# Kyberion 性能・リソース効率レビューと Luna 向け改善計画

## 結論と対象

改善は必要。最優先は SSE の無効な変更抑制と、閲覧者数・履歴量に比例する全件再読込。次にスケジューラの同一レジストリ反復書込と埋め込み要求の上限を扱う。実装は本レビューの対象外。Luna は下記を一タスク一変更として実行する。

対象はコア知識検索・埋め込み・モデル成績、観測ログ、Chronos UI/SSE、常駐スケジューラ、起動・ビルド・既存性能検証。静的レビューであり、全機能の本番負荷試験やブラウザ FPS、LLM 課金量、長時間リークは未測定。下記優先度は発生経路と増加特性によるもので、本番での最大ボトルネック順位を確定するものではない。

## 確認した既存対策

- knowledge-index.ts:364-441 はディスクキャッシュの LRU と既定 200MB 予算を持つ。scope/model 別キーも存在する。新たに同等キャッシュを重複実装しない。
- scripts/bundle_entrypoints.mjs は主要 CLI をバンドル済み。コメントの過去測定値は今回の実測ではない。
- Chronos はリーダー lease と schedule claim を持つ。非同期 interval だけを理由に二重実行と断定しない。
- SSE の共通 poll loop は重複 poll と終了時 cleanup を持つ。出力 ring buffer の制限は入力履歴の読込量を制限しない。
- pipelines/ce-chronos-perf.json と pipelines/soak-endurance.json がある。性能計測基盤を別系統で作り直さず拡張する。

## 測定した範囲

2026-10-07 の baseline-check は all_clear。以前の L10 異常は現在の性能障害の証拠にしない。
共有 readJsonLines に合成 JSONL を渡す単一プロセスの簡易測定:

|    件数 | 入力 bytes | elapsed ms | 測定時 RSS MB |
| ------: | ---------: | ---------: | ------------: |
|   1,000 |    306,000 |       1.28 |         175.8 |
|  10,000 |  3,060,000 |       8.91 |         187.7 |
| 100,000 | 30,600,000 |      95.62 |         286.2 |

RSS は生成用文字列、以前の試行、GC の影響を含む累積値で、ピークやリーク量ではない。1回測定なので統計的な比較ではない。これは全件処理の増加を示す補助証拠で、HTTP p95 ではない。結果は mission evidence/jsonl-benchmark.json。

## 指摘と Luna 実装タスク

### PERF-01 / P1 / S: intelligence SSE の変更抑制を修復

根拠: presence/displays/chronos-mirror-v2/src/app/api/intelligence/stream/route.ts:278,329,346。比較前に revision と ts を毎回生成するため、状態不変でも2秒ごとに full frame が変わる。
変更範囲: 当該 route と focused test。domain payload を比較し、送信が必要な時だけ revision/ts を付与する。keepalive は維持。
受入条件: fake clock 30秒で不変データの追加 data frame が0、状態変更時に1 frame、revision が送信順に増加。切断 cleanup と認可を維持。

### PERF-02 / P1 / M: intelligence の観測履歴読込をまとめる

根拠: stream/route.ts:251-258、src/lib/agent-message-feed.ts:97-134,169-182、api/intelligence/intelligence-control-data.ts:118-159。複数 collector が同じ履歴を全件読込・sort し、各 subscriber が繰り返す。foundation/json.ts:76 は全文読込。
第1変更: 一回の snapshot 内で観測読込を共有し二重解析を除去。第2変更: 必要なら safeReadFileRange と既存 projection を調べ、append offset を持つ bounded projection を導入。初回 load と増分 load を分ける。全 JSONL の意味を tail に置換しない。
受入条件: 同じ snapshot で同じログの全件読込1回以下。追加1件では次回その差分だけ解析。truncate/rotate/部分行から復旧。複数接続の共通読込は同一の認可スコープでだけ共有し、viewer/tier/tenant ごとに出力を認可。認可失効・scope変更・symlink置換を検証。

### PERF-03 / P2 / M: discussion SSE の room 全件 replay を抑制

根拠: src/app/api/discussions/[id]/stream/route.ts:73-100、libs/core/discussion/discussion-store.ts:51-86。180msごとに読込・reduce後にsignature比較。10接続で毎秒約56回の完全 replay。
変更範囲: room store projection と route。初回 replay 後はファイル変更検知/増分読込。同一roomを共有しても subscriber の認可は個別。
受入条件: 不変roomは初回以降の全件 replay 0。新規イベントと外部 approval 更新は現在の応答性を維持。terminal終了、切断、変更時の失効を確認。履歴件数上限は維持。

### PERF-04 / P2 / M: Chronos registry の no-op 抑制と一括更新

根拠: scripts/chronos_daemon.ts:60-74,463-501,723-725、libs/core/pipeline/pipeline-scheduler.ts:228-244。tickごとにpipeline探索し、scheduleごとにregistry全体をload/write。S件の登録でregistryの総serialize量は概ね S² に増える。
第1変更: registry reconciliationをtyped opとして一括実行し、不変なら書込しない。第2変更: 計測で必要なら validated pipeline discoveryを変更検知で再利用。
受入条件: 不変tickのregistry書込0、変更1件の書込1、削除反映、tenant suspension反映、symlink/path改変を実行時にも拒否。leader leaseとschedule claimを維持。新しいenvは登録儀式に従う。

### PERF-05 / P2 / S: モデル成績の重複 outcome で index 再構築を避ける

根拠: libs/core/reasoning/model-performance-index.ts:251-264。append候補が空でも validated.length を条件にrebuildする。重複入力で履歴走査・index書込を再実行する。
変更範囲: recordModelRoleOutcomes と focused test。appendが発生した場合だけ再構築。index欠損時の復旧要件を先に確認し、必要なら別分岐にする。
受入条件: 同一outcomeを再送してもindex再構築0、新規/状態/provider変更は1回。既存dedup semanticsと欠損復旧を維持。

### PERF-06 / P2 / M: 埋め込み batch サイズと同時実行に上限

根拠: libs/core/knowledge/knowledge-index.ts:613,1390。未キャッシュ集合を一括embedBatchする。providerごとの上限と実装を確認してから分割する。
変更範囲: embedding contract/backend と知識索引。件数/byte予算でchunk化し、bounded concurrencyを適用。scope/modelのキャッシュキーを維持。
受入条件: mock backendで入力数増加時も1要求の上限と同時実行上限を超えない。結果順序・vector数・次元を検証。中間失敗は壊れたindexをpublishしない。実providerの上限は実装前に公式資料で確認し、無根拠の定数を固定しない。

### PERF-07 / P2 / S→M: baseline の audit freshness 読込量を減らす

根拠: scripts/run_baseline_check.ts:115-147。freshness確認のため全日付ファイルを全文parseしreverseする。
第1変更: 同一評価内でfreshness結果を再利用。第2変更: 最新timestampの集計 projection またはbounded逆読みを検討。日付順だけで最大timestampを保証できるか先に調べる。
受入条件: 監査完全性検証の経路は変更しない。旧日付ファイルへの遅延append、異常timestamp、壊れた末尾、rotationを含め既存判定と一致。条件を保証できない場合はfallback全文走査を維持。

## 実行順と検証

Luna の順序は 01 → 05 → 04 → 06 → 02 → 03 → 07。02/03のtenant-safe共有と04の実行時認可は設計レビュー後に着手。1タスク1差分で、先に反証可能なfixture/testを作る。

各タスクに before/after を同じNode・fixture・warmup条件で保存。1k/10k/100k履歴、1/10接続、10/100scheduleで、p50/p95、CPU、RSS、event-loop delay、read bytes/count、write bytes/count、request数を測る。wall timeだけをCI固定閾値にせず、I/O回数や並列上限の決定的assertionを併用。

libs/core変更は pnpm --filter @agent/core run build と関連vitest、surface変更は既存SSE/authorizationテスト、全体は pnpm check -- --scope pr と変更pathの例外表を実施。ブラウザ準備後は既存 chronos-perf、実行可能な環境で soak-endurance を実施する。今回はこれらの性能試験は未実行。

rollbackはタスク単位のrevert。認可漏れ、順序崩れ、missing event、registry lost update が1件でも出れば効果の数値に関わらず停止。

## 引継ぎ

この文書は実装計画。改善コードは未変更、commit/push/PRは未実施。既存のミッション修復差分は本レビューに含めない。Luna は各taskの測定根拠・差分・実行した検証を記録し、独立reviewに引き渡す。

## 追加の全体レビュー項目

### PERF-08 / P2 / S→M: artifact照会の全履歴走査

根拠: libs/core/workforce/artifact-registry.ts:186-196,241-256。全履歴のlatest化後にquery filterするため、小さなscope照会も全履歴に比例。既存のcompactionとlockは維持する。まず同一処理内のsnapshot再利用、次に変更検知付きbounded cacheを検討。受入: 同一snapshotの連続queryで読込1回、append/compaction後更新、owner付替えとoffboarding履歴を維持、scopeごとの出力認可。02と共通projectionを導入する前に重複設計を避ける。

### PERF-09 / 条件付きP1 / S: MLX同期子プロセス

根拠: libs/core/mlx-embedding-backend.ts:96-109。async API内のexecFileSyncがNodeイベントループを止める。120秒timeoutと応答検証はあるが、参照先scripts/mlx_embed.pyが現在checkoutに存在せず、既定構成の実害は未確認。まず登録状態と実行可能性を確認。使用中なら既存の承認付きprocess基盤を使い非同期化。受入: 遅い模擬子プロセス中にtimerが進む、timeoutで子終了、stderr診断とvector形状維持。モデル常駐化は別タスク。
