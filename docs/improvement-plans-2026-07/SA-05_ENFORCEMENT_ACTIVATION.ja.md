# SA-05: 統制機構の実効化 — kill-switch 配線・ポリシー/承認ゲートの fail-closed 化

> 優先度: **P0** / 規模: M / 依存: なし / 関連: SA-01〜04(これらのブロック判定の受け皿)、MO-02(承認ゲート)
>
> **なぜ重要か**: Kyberion は「controlled autonomy with visible authority」を設計目標に掲げる(agent-mission-control-model)。その統制機構が**配線されておらず fail-open**であることは、構想の中核と実装の最大の乖離。

## 背景と課題

- **kill-switch が完全に不活性**(CRITICAL): `libs/core/kill-switch.ts` の `logAction()` / `startMonitor()` / `detectAnomalies()` は**本番呼び出し元ゼロ**(定義とユニットテストのみ)。`detectAnomalies` は空の `actionLogs`(`:85`)を見るため常に何も検知しない。`respond`(`:134-173`、`shutdownAgentRuntimeViaDaemon` 経由で agent を隔離/kill 可能)は実装されているのに**データを一切与えられず、監視ループも起動されない**。カバレッジ除外がこの死蔵を隠している。
- **ポリシーエンジンが file_write しかゲートしない + fail-open**: `policy-engine.ts`(16 ルール)の実運用呼び出しは `secure-io.ts:169` の 1 箇所(`file_write` のみ)。network/shell/delegation/actuator dispatch はゲートしない。しかも `[POLICY_BLOCKED]` 以外の例外(ポリシーファイル欠落・YAML parse 失敗)を握りつぶして**書き込みを許可**(`secure-io.ts:178-184`)。ポリシーファイルが壊れると静かにゲートが無効化。`operation` が file_write 以外・ring・delegation_depth・capability を条件とするルールは**発火文脈が渡らず死んでいる**。
- **承認ゲートのカバレッジが狭い + fail-open**: `enforceApprovalGate`(`approval-gate.ts:55-183`)自体は fail-closed で良くできているが、呼び出し元は procedure-dispatcher / browser-extension-bridge / risky-op-registry の数箇所のみ。一般の network/system/file 実行は通らない。`resolveApprovalPolicy`(`approval-policy.ts:62-65`)は設定欠落時 `requiresApproval=false`(fail-open)。CLI の `-y`/`--yes`(`core.ts:81-82`)は全プロンプトを無言承認。

## ゴール(受入条件)

1. kill-switch が実際にデータを受け取り監視する: アクチュエータ dispatch・A2A route・ポリシー違反・承認却下・trust 低下が `logAction` に流れ、監視ループが起動し、閾値超過で警告→隔離→kill の graduated response が発火する(kill は承認/オペレータ確認付き)。
2. ポリシーエンジンが file_write 以外(shell=SA-02、egress=SA-04、delegation=delegation-preflight、actuator dispatch)にも接続され、**fail-closed**(ポリシー欠落/parse 失敗は許可でなく拒否 or 承認要求)になる。
3. 承認ゲートの既定が fail-closed: 設定欠落時は「既知の危険 op は承認必須」のハードコードフォールバックが効く。`-y`/`--yes` は非破壊操作にのみ適用され、破壊的操作には効かない。
4. これらの統制が動作していることを示すテストと、operator が現在の統制状態(kill-switch armed / ポリシー件数 / 承認保留)を確認できる表示。

## 実装タスク

### Task 1: kill-switch の配線 — `claude-sonnet-4`

1. `killSwitch.logAction` を主要な実行接続点から呼ぶ: アクチュエータ dispatch(共通ランナー IP-05)、`a2aBridge.route`(AA 系)、ポリシー違反(Task 2)、承認却下(approval-gate)、trust 更新(AA-03)。1 箇所の共通フック(`recordGovernanceAction`)にまとめ、各所はそれを呼ぶ。
2. 監視ループ(`startMonitor`)をランタイム起動(supervisor daemon か baseline セッション)で開始する。anomaly 検知(rapid-fire / policy-violations / trust-degradation)の閾値を `knowledge/product/governance/` の設定に外出し。
3. graduated response: warn(ログ + operator 通知)→ isolate(該当 agent の新規 dispatch 停止)→ kill(runtime shutdown、**承認/オペレータ確認必須**、自動 kill は既定オフ)。
4. test(既存ユニットテストを実配線で拡張): logAction にデータ投入 → detectAnomalies が発火 → respond が適切な段階を返す。

### Task 2: ポリシーエンジンの拡張と fail-closed 化 — `claude-sonnet-4`

1. `policy-engine.evaluate` の呼び出しを file_write 以外へ拡大: shell(SA-02)・egress(SA-04)・delegation(delegation-preflight)・actuator dispatch の各接続点で、適切な context(operation/ring/delegation_depth/capability)を渡す。これにより死んでいたルールが機能する。
2. `secure-io.ts:178-184` の fail-open を解消: ポリシー評価の例外は「安全側(拒否 or 承認要求)」に倒す。ポリシーファイル欠落・parse 失敗は起動時 doctor で検知し、運用中は fail-closed。
3. カスタム YAML パーサ(`:195-262`)の脆弱性(ネスト配列 1 段のみ等)に対し、parse 結果のルール件数を検証し「期待件数と乖離したら警告 + fail-closed」を入れる(サイレントに少数ルールで動く事故の防止)。
4. test: 各 operation でのブロック、ポリシー欠落時の fail-closed、parse 不全の検知。

### Task 3: 承認ゲートの fail-closed 化とカバレッジ — `claude-sonnet-4`

1. `resolveApprovalPolicy`(`approval-policy.ts:62-65`)に**ハードコードの危険 op フォールバック**を追加: 設定欠落でも「shell 変更系・任意 egress・secret 操作・デプロイ・破壊的ファイル操作」は承認必須。設定はそれを緩める方向にのみ働く。
2. `core.confirm` の `-y`/`--yes`(`core.ts:81-82`)を「非破壊操作のみ自動 yes、破壊的フラグ付きプロンプトは無視して確認要求」に変更。
3. 一般実行路(network/system/file の変更系)を approval-gate に接続する範囲を、SA-02/SA-04 のポリシー判定 `require_approval` と統一する(承認要否の単一判定源)。
4. test: 設定欠落でも危険 op が承認必須、`-y` が破壊操作を素通ししないこと。

### Task 4: 統制状態の可視化 — `claude-haiku`

- doctor / dashboard に「統制サマリ」を追加: kill-switch armed 状態・直近 anomaly・ポリシールール件数(期待 vs ロード)・承認保留件数。`SECURITY.md` / `GOVERNANCE.md` に統制機構の実効化状況を追記。

## リスクと注意

- **fail-open → fail-closed は運用を止め得る最大リスク**。IP-08 の方針(まず可視化)を踏襲し、各ゲートは `warn`(違反をログ・通知するが通す)で観測期間を設けてから `enforce` に切り替える。ただし本 IP の完了条件は enforce 到達とする。
- kill-switch の自動 kill は誤検知で正常な作業を殺す。**自動は warn/isolate まで、kill は人間確認必須**を既定にし、閾値は観測データで調整する。
- 複数の SA 計画(02/04)とポリシー/承認判定を共有するため、判定の単一源(shell-command-policy / egress-policy / approval-policy)を先に確定し、本 IP はそれらを配線・fail-closed 化する統合レイヤーと位置づける。実施順は SA-02/SA-04 の判定エンジン → SA-05 の配線。

## 実装状況 (2026-07-12)

**Task 2(ポリシーエンジン拡張と fail-closed 化)完了。Task 3 は 3.1/3.2 完了済みを再確認。残: Task 1(kill-switch 配線)、3.3(承認要否の単一判定源化)、Task 4(統制状態の可視化)。**

- **重大発見2件(dormant enforcement)**: (1) 自作簡易 YAML パーサがネスト配列を解析できず、**全16ポリシーの rules が空配列 = ポリシーエンジンは稼働以来一度も何も執行していなかった**(evaluate は常に未マッチ→default allow)。js-yaml に置換し、parse 失敗時は 0 件ロード→evaluate が fail-closed で全拒否。rules 欠落ポリシーのドロップは警告(Task 2.3 のサイレント縮退防止)。(2) `matches` ルールの PCRE 形式 `(?i)` を JS RegExp が受理せず **injection 系ルールも全て不発だった** → `i` フラグへ変換。回帰テスト新設(全ポリシーの rules 非空・sovereign-shield・injection guard・ring3)。
- **Task 2.1 完了**: 発火文脈の接続 — `execute_command`(secure-io の safeExec/safeExecResult、message は実行ファイル名のみ: コマンド内容走査は SA-02 shell-command-policy の責務で二重規制を回避)/ `network_request`(secureFetch、hostname 付き)/ `reasoning_delegation`(runWithFailover 前段、`delegation_depth = 現在深度+1`)。新設 `libs/core/operation-policy-gate.ts`(`assertOperationPolicy` / `currentDelegationDepth` / `childDelegationEnv`)。深度は `KYBERION_DELEGATION_DEPTH` で追跡し、shell-claude-cli の spawn env で +1 伝搬。ring は `KYBERION_AGENT_RING`、tier は `KYBERION_AGENT_TIER`(root 既定 sovereign)。未マッチ操作は default allow のままなので、配線自体は挙動中立(ルールが狙った時だけ発火)。
- **Task 2.2**: 2026-07-04 解消済み(fail-closed)を確認。「allowing by default」の虚偽ログを修正し回帰テストで固定。
- **ルール整合**: ring3-read-only の op 名 `write_file` と実装の `file_write` の不一致を発見 → 両方をルールに併記。
