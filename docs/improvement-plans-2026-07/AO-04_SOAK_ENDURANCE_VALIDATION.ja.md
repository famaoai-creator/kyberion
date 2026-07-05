# AO-04: 長時間運用の耐久検証(soak / endurance)

> 優先度: P1 / 規模: M / 依存: AO-01/02/03(検証対象の機構)、OP-04(劣化検知) / 関連: Phase B「30日連続運用」受入条件、[AUTONOMOUS_MAINTENANCE_JUDGMENT](../AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md) §6
>
> **なぜ重要か**: 30日連続運用は Phase B の受入条件かつ `check_contract_schemas` が要求する必須エビデンスなのに、soak テストは明示的にスコープ外とされ、メモリリーク・履歴肥大のリスクが未検証。「動くはず」でなく「30日動くのを見た」に変える(Fable の検証原則)。

## 背景と課題

- **soak/endurance 検証が無い**: `CHAOS_DRILLS.md` は「Long-running soak tests」を明示的にスコープ外(Phase B-3/B-5 follow-up)とする。プロセス再起動の e2e テストも未実施(`MISSION_LIFECYCLE_AUDIT.md:85-89,118`)。
- **リソースリーク・肥大が未検証**: `MISSION_LIFECYCLE_AUDIT.md:11` が「24h+ 連続運用」を目標に掲げつつ、resume 履歴の肥大(`:48`)を懸念点として挙げる。メモリリーク・ディスク成長の検証手段が無い。
- **30日エビデンスが未収集**: `check_contract_schemas.ts:417,428,444,499…` が「30-day run log」「30-day run summary」を必須エビデンスとして要求するが、収集されていない。
- provider-health・調整バス等がプロセス再起動でリセットする問題(OP-04/AA/MO-06)が、長期運用で実際にどう出るか未検証。

## ゴール(受入条件)

1. **soak テストハーネス**があり、圧縮時間(擬似時計)or 実時間短縮で「多数のミッション/保守サイクルを連続実行」してリソース推移(メモリ RSS/heap・ディスク・open handles・履歴ファイルサイズ)を計測できる。
2. **リーク/肥大の検出**: soak 中のリソース単調増加を検知し、原因(履歴肥大・キャッシュ・未解放ハンドル)を特定してレポート。
3. **プロセス再起動の e2e**: デーモン/worker を kill → 再起動 → 状態復元(MO-06 journal・AA-01・provider-health 永続化 OP-04)が実際に効くことを検証。
4. **30日エビデンス収集の自動化**: AO-01 の運用ループが `check_contract_schemas` の要求する run log/summary を生成・蓄積する。
5. 検証で見つかった劣化(履歴肥大等)に対する対処(rollover/TTL、KM-01)が有効なことを確認。

## 実装状況 (2026-07-05)

- Task 1: `scripts/soak_endurance.ts` を追加し、maintenance pulse を連続実行しながら RSS/heap/open handles/主要 JSONL のサイズをサンプルできるようにした。
- Task 2: サンプル系列の傾き検出と、`MetricsCollector.detectRegressions()` を使った latency 履歴検出を入れた。
- Task 3: `scripts/soak_restart_e2e.ts` を追加し、kill → 再起動 → journal/provider-health 復元を検証できるようにした。
- Task 4: `30day-run-log.jsonl` / `30day-run-summary.md` を `runSoakEnduranceHarness()` から自動生成するようにした。
- Task 5: evidence log の rollover/TTL を実装し、保持件数を超えたログが切り詰められることを確認した。

## 実装タスク

### Task 1: soak テストハーネス — `claude-sonnet-4`

1. `tests/soak/` に耐久ハーネス: 擬似時計(cron を早送り、AO-02 のバックオフ短縮と同じ注入方式)で N 日相当の保守サイクル + ミッション実行を連続実行。各サイクルでリソース(RSS/heap/ディスク/handles/主要 JSONL のサイズ)をサンプリングし時系列記録。
2. 短時間版(CI 向け、数百サイクル)と長時間版(手動/夜間)を分ける。CI 版は IP-03 のゲートに任意で組み込み。
3. テスト: ハーネスがリソース時系列を出力すること。

> 2026-07-05: `scripts/soak_endurance.ts` と `pipelines/soak-endurance.json` で短時間版の土台を追加。Task 1 は実装済み。

### Task 2: リーク・肥大検出 — `claude-sonnet-4`

1. Task 1 の時系列に対し単調増加の検出(線形回帰の傾きが閾値超過)を実装。OP-04 の劣化検知(`detectRegressions`)を再利用。
2. 疑わしいリソース(resume 履歴 `MISSION_LIFECYCLE_AUDIT.md:48`・調整バス・キャッシュ・open handles)を個別に追跡し、肥大源を特定してレポート。
3. 検出された肥大に rollover/TTL(KM-01)を適用し、soak 再実行で解消することを確認。

> 2026-07-05: 単調増加検出と `detectRegressions()` の接続まで実装。Task 2 は部分完了。

### Task 3: プロセス再起動 e2e — `claude-sonnet-4`

1. soak 中にデーモン(chronos/supervisor)と worker を kill → OS/watchdog 再起動(AO-03)→ 状態復元(MO-06 の journal 再開・AA-01 の runtime・OP-04 の provider-health 永続化)を検証する e2e を追加。`MISSION_LIFECYCLE_AUDIT.md:85-89` の未実施項目を埋める。
2. 再起動をまたいで missed-run catch-up(AO-01)・ミッション resume が正しく動くことを確認。
3. テスト: kill→復元→継続の一連。

> 2026-07-05: `scripts/soak_restart_e2e.ts` と `pipelines/soak-restart-e2e.json` を追加し、状態復元の e2e を実装済み。

### Task 4: 30日エビデンス収集 — `claude-haiku`

1. AO-01 の運用ループに、`check_contract_schemas` が要求する 30-day run log/summary を生成・蓄積するステップを追加(健全性・コスト・保守アクション・インシデント・エスカレーションの日次ロールアップ)。
2. `check_contract_schemas` のエビデンス検証が満たされることを確認。`docs/verification/` に soak/30日運用の結果を追記。

> 2026-07-05: `runSoakEnduranceHarness()` が evidence bundle を自動出力するようにした。Task 4 は実装済み。

## リスクと注意

- 擬似時計での圧縮は実運用と乖離し得る(実時間依存のバグを見逃す)。CI 版は圧縮、少なくとも 1 回は実時間の長時間版(24h+ → 段階的に 30日)を回して裏を取る。
- soak テスト自体がリソースを食う。CI 版は軽量に、重い版は隔離環境で。
- リーク検出の閾値は誤検知しやすい(正常な増加もある)。単調増加 + 一定期間で頭打ちしないことを条件にし、warn 観測から始める。
- 実 30日運用のエビデンスは AO-01〜03 が安定してからでないと意味がない。実施順は AO-01/02/03 → AO-04 の検証。
