# OP-04: 長期運用のための健全性・劣化監視

> 優先度: P1 / 規模: M / 依存: なし / 関連: AA-01(runtime 耐障害化)、Phase B「30 日連続運用・人手介入 週1回以下」
>
> **なぜ重要か**: Phase B の受入条件は「壊れる前に次アクションが分かる」こと。現状は壊れてから doctor を手動実行するしかなく、劣化の予兆を掴む手段が無い。

## 背景と課題

- **長期運用の劣化検知が無い**: supervisor は agent を restart できる(`agent-runtime-supervisor.ts:328`)が、メモリリーク/クラッシュループ/劣化/閾値/アラートのロジックは無い(grep 済み)。「システムが徐々に劣化している」を運用者に伝えるものが無い。`MetricsCollector.detectRegressions()` はあるが呼ばれない(OP-01/観測ギャップと同根)。
- **provider health がメモリのみ**: `provider-health-registry.ts` の状態はプロセス再起動でリセット(module-level map、`clearProviderHealth() :122`)。30 日運用で不可避の再起動をまたいでフェイルオーバー履歴が失われる。
- **Chronos Mirror に health/metrics エンドポイント無し・プッシュアラート無し**: Chronos Mirror の API は `api/{traces,agent,intelligence,...}` のみで `/healthz`・`/metrics`・`/status` が無い。(2026-07-03 レビュー訂正: `operator-surface/src/app/health/page.tsx` は health surface として稼働し、一部 satellite bridge も `/health` を持つ — 「全く無い」は誇張。正しくは「集約された機械可読 health/metrics エンドポイントと、異常のプッシュ通知経路が無い」。)異常検知時に人へ届ける sink は AO-03 が所有し、本計画はそれに依存する。
- **健全性シグナルが多数の JSONL に分散**し rollup が無い。「システムは健全か」の単一指標が `pnpm doctor` の手動再実行以外に無い。
- telemetry(`telemetry.ts`)はメモリ内スタブで未永続(`:14-21`)。

## 実装状況 (2026-07-11)

- **完了済み(Task 2 v1)**: chronos-mirror-v2 に `/api/healthz`(無認証 liveness、最小情報のみ)と `/api/status`(既存 surface 認証必須。uptime・永続化された provider demotion・直近1時間の trace エラー率・🟢/🟡/🔴 rollup + 根拠)を追加。集約ロジックは `src/lib/system-status.ts` に分離しテスト済み。mesh backlog(AA-02)/バックアップ時刻(OP-02)/当日コスト(OP-01)は各 runtime 面の安定後に collectSystemStatus へ追加する拡張点としてコメントに明記。

- **完了済み(Task 3)**: `provider-health-registry.ts` の demotion 状態を `active/shared/runtime/provider-health.json` にミラーし、起動時ロード(絶対時刻 `until` により TTL は再起動をまたいで自然回復)+ `reloadProviderHealthFromDisk()` を追加。永続化は best-effort(壊れた state file は空で継続)。vitest 下では `KYBERION_PROVIDER_HEALTH_STATE_PATH` を明示したテスト以外は永続化無効(worker 間の state 共有によるテスト汚染防止、operator-notifications と同パターン)。

## ゴール(受入条件)

1. **劣化検知**: メモリ増加傾向・クラッシュ/restart 頻度・推論レイテンシ悪化・エラー率上昇・provider demotion 多発を継続監視し、閾値超過で「壊れる前に」operator へ通知。`detectRegressions()` が実際に定期実行される。**単一オーナー(2026-07-03 レビュー): `metrics.ts` の `detectRegressions()` 配線は本計画が所有**(OP-01 は cost 集計、AO-01 は保守ループの起動に集中し、regression 配線は本計画に委ねる)。通知は AO-03 の `ops-alert.ts` sink を利用。
2. **health エンドポイント**: Chronos(または軽量常駐)に `/healthz`(liveness)と `/status`(集約された健全性: runtime 稼働・provider 状態・直近エラー率・バックログ)を追加。
3. **provider health の永続化**: 再起動をまたいで demotion 履歴/failover 状態が保持される。
4. **単一健全性指標**: doctor / dashboard に「システム健全性: 🟢/🟡/🔴 + 根拠」の rollup が出る(baseline-check の status 表現と統一)。

## 実装タスク

### Task 1: 劣化検知ループ — `claude-sonnet-4`

1. supervisor daemon(または KM-01 の cron)に定期評価を追加: `MetricsCollector.detectRegressions()`(`metrics.ts`)と、プロセス RSS/heap 推移・agent restart 頻度・provider demotion 頻度の閾値評価。閾値は `knowledge/product/governance/health-thresholds.json`。
2. 超過時のアクション: warn(operator 通知 + trace)、深刻時は SA-05 の kill-switch へ anomaly として供給(統合)。自動対処(restart 等)は既存 supervisor 機能に接続、ただし過剰 restart はループ検知で止める(AA-01 の restart 上限と整合)。
3. test: メトリクス fixture で regression 検知 → 通知が出ること。

### Task 2: health/status エンドポイント — `claude-sonnet-4`

1. Chronos Mirror に `app/api/healthz`(即時 200/503 の liveness)と `app/api/status`(runtime 稼働数・provider 状態・直近 1h エラー率・mesh backlog(AA-02)・最終バックアップ時刻(OP-02)・コスト当日累計(OP-01)を集約 JSON)を追加。
2. 認証: status は運用情報を含むため既存の surface 認証に従う(healthz は無認証 liveness のみ)。
3. 外部監視(将来の Datadog/Prometheus)が叩ける形(OpenTelemetry/Prometheus 形式)への拡張余地をコメントで残す(実装は将来 — architecture_recommendations の OTel 提案は別途)。
4. test: healthz の up/down、status の集約内容。

### Task 3: provider health 永続化 — `claude-sonnet-4`

1. `provider-health-registry.ts` の module-level map を、runtime root への JSONL/state 永続に変更(起動時ロード)。demotion/failover 履歴が再起動をまたぐ。
2. TTL 付きで古い demotion は自然回復(既存の rate-limit demotion ロジックを尊重)。
3. test: 永続 → 再ロードで状態復元、TTL 回復。

### Task 4: 健全性 rollup — `claude-haiku`

- doctor / dashboard に「システム健全性 🟢/🟡/🔴」を追加(Task 1 の評価 + baseline-check 結果 + Task 2 status の要約)。判定根拠を 3 行以内で表示。`docs/OPERATOR_UX_GUIDE.md` に「30 日運用で見るべき健全性指標」の節を追記。

## リスクと注意

- 監視自体がリソースを食う/誤報でアラート疲れを起こす。評価間隔は分〜十分単位、閾値は保守的に始め、warn を観測してから通知を厳しくする。
- health エンドポイントは攻撃面になり得る(内部状態の露出)。healthz は最小情報、status は認証必須を厳守。
- 完全な APM(OpenTelemetry + 外部バックエンド)は architecture_recommendations の大きな提案であり本計画のスコープ外。ここは「自己完結の劣化検知 + health 表示 + 予兆通知」までとし、OTel 移行は将来計画として本文書に「次の一手」で記す。
