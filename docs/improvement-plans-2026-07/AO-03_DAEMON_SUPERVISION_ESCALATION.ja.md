# AO-03: デーモン監督と人間へのエスカレーション

> 優先度: **P0**(無人運用の前提) / 規模: M / 依存: なし / 関連: AA-01(agent-runtime crash — 別レイヤー)、SA-05(kill-switch)、OP-04(健全性)、[AUTONOMOUS_MAINTENANCE_JUDGMENT](../AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md) §5
>
> **なぜ前提か**: 無人運用では「デーモンが死んだら誰も再起動せず、問題が起きても誰にも伝わらない」状態が致命的。現状まさにそれ。AA-01 が「エージェントランタイムの子プロセス」の耐障害なのに対し、AO-03 は「**デーモンプロセス自体の監督**」と「**人間を呼ぶ経路**」。

## 背景と課題

- **デーモンを監督する者がいない(supervisor-of-supervisors 不在)**: `agent_runtime_supervisor_daemon` は子ランタイムを restart できる(`:187-200`)が、自身の server エラーでは `process.exit(1)`(`:278-281`)。`chronos_daemon` も fatal で `process.exit(1)`(`:150-152`)。**どちらが死んでも再起動する仕組みが無い**。
- **launchd 未整備・chronos に再起動設定なし**: systemd unit は `agent-runtime:supervisor` 向けに `Restart=on-failure` がドキュメントにある(`DEPLOYMENT.md:163-186`)が、**launchd 版は TODO**(`DEPLOYMENT.md:112` に literally "TODO: ship this template")。chronos_daemon には systemd/launchd 設定がどこにも無い。死ねば定期保守が永久停止。
- **人間へのアラート sink が実在しない**: 運用問題(ミッション結果でなく)を Slack/email/webhook で知らせる sink がゼロ。`agent-slo.ts:85` に burn-rate アラート概念はあるが dispatch 機構なし。(2026-07-03 レビュー訂正: `watch_tenant_drift.ts:18` の `notify-slack.sh` は docstring の「Cron 例」コメントで、当該スクリプトを実際には**呼ばない**[read-only]。「配線済みだが壊れたアラート機構」ではなく「そもそも sink が無い」が正確。`notify-slack.sh` がリポジトリに無いのは事実。)
- **自己修復が無承認で危険な変更をする**: `attemptAutonomousRepair`(`run_pipeline.ts:632-673`)は LLM に**ADF・`.env`・authority roles の編集を許す**(`:650-652`)のに approval-policy に一切ゲートされない。境界が逆転している(安全な cleanup に自律性なし、危険な config/secret 書き換えに無制限自律)。

## ゴール(受入条件)

1. **デーモン監督**: chronos_daemon と agent-runtime-supervisor-daemon が、死んだら自動再起動される(launchd/systemd 完備 + heartbeat watchdog)。どちらかの死を検知して再起動し、記録する。
2. **launchd plist の TODO 解消**と chronos 用の常駐設定追加。macOS でも無人常駐が成立。
3. **実アラート sink**: 運用問題(repair 失敗・デーモン死・disk/SLO 閾値・CVE 緊急・予算危険)を Slack/email/webhook で人間に通知する経路が実在する(`notify-slack.sh` の欠落解消)。判断基準 §5 のリッチ framing(材料付き)。
4. **自己修復の承認ゲート化**: `attemptAutonomousRepair` の `.env`/authority/config 書き換えを SA-05 の承認ゲート下に置く。安全な cleanup/restart は AO-01 のポリシーで自動、config/secret 変更は承認必須(判断基準 §2 の境界を正す)。

## 実装タスク

### Task 1: デーモンの常駐設定完備 — `claude-sonnet-4`

1. `DEPLOYMENT.md:112` の TODO の launchd plist を実際に用意(agent-runtime-supervisor 用)。chronos_daemon 用の systemd unit + launchd plist を新設(`Restart=on-failure`/`KeepAlive` 相当)。
2. 各デーモンが起動時に PID/heartbeat を書き、異常終了しても OS レベルで再起動されることを確認。DEPLOYMENT.md に無人常駐のセットアップ手順を追記。

### Task 2: heartbeat watchdog — `claude-sonnet-4`

1. `libs/core/daemon-heartbeat.ts`: 各デーモンが定期(30秒)に heartbeat を `active/shared/runtime/heartbeats/<daemon>.json` へ書く。
2. 軽量な watchdog(baseline-check セッション開始フック or 独立の最小プロセス)が heartbeat の鮮度を確認し、stale(例: 3分超)なら OS の再起動が効いているか検査、効いていなければアラート(Task 3)。
3. OS 常駐(Task 1)と watchdog(Task 2)の二重化で「片方が失敗しても検知」する。テスト: heartbeat stale 検知。

### Task 3: 実アラート sink — `claude-sonnet-4`

1. `libs/core/ops-alert.ts`: 運用アラートを既存の satellite bridge(slack-bridge、UX-01 で堅牢化)や webhook/email に送る sink。`sendOpsAlert({ severity, title, context, options, recommendation })` — 判断基準 §5 の材料付き framing(何が起きた/影響/自動で試したこと/選択肢と推奨/帰結)。
2. `watch_tenant_drift.ts` の欠落 `notify-slack.sh` 参照をこの sink に置換。トリガ源を配線: AO-01 の repair 失敗、AO-03 のデーモン死、OP-04 の劣化/SLO、AO-02 の緊急 CVE、OP-01 の予算危険。
3. 多重通知抑制(同一問題はレート制限、UX-01 と同じ)。テスト: 各トリガでアラートが framing 付きで飛ぶこと、抑制。

### Task 4: 自己修復の境界是正 — `claude-sonnet-4`

1. `attemptAutonomousRepair`(`run_pipeline.ts:632-673`)を AO-01 の ops-gate / SA-05 の承認ゲート下に置く: ADF の構造修復は自動可、**`.env`/authority/config/secret の書き換えは承認必須**(判断基準 §2)。承認が取れない無人時は修復を諦めてエスカレート(Task 3)。
2. 修復が行った変更を必ず監査(SA-01)に残す。
3. テスト: 安全な修復は自動、config/secret 書き換えは承認要求 or エスカレート。

## リスクと注意

- **watchdog 自身が死ぬ問題**(誰が watchdog を見るか)は、OS 常駐(Task 1)を第一防壁、watchdog(Task 2)を第二防壁の二重化で緩和する。両方同時死は OS 再起動 + 起動時 baseline-check で回復。
- アラートの実 sink は外部送信(SA-04 の egress)。ops アラートの宛先は egress allowlist に入れ、confidential を本文に含めない(参照のみ)。
- 自己修復の承認ゲート化は「無人時に修復できない」状況を生む。その場合はエスカレート + 安全側停止(暴走修復より停止が安全)を既定にする(判断基準 §6 fail-closed)。
