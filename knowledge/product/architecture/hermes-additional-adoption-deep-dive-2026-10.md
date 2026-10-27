---
title: Hermes additional adoption deep dive after the October runtime integration
tags: [hermes-agent, comparative-research, security, operations, memory, ux, evaluation]
last_updated: 2026-10-28
status: researched
runtime_stages: [planning, review]
---

# Hermes 追加採用候補の詳細比較

## 要旨

前回までの UI/UX、CLI 費用計測、runtime 6項目を除外して比較し、14件の追加差分候補と、2件の横断的な改善案を整理した。
次の実装候補としては、非対話 Git probe の防御、Unicode 検査範囲、取得結果の状態契約、bounded read の状態表示、plugin 更新 transaction を優先する。
外部接続の完了追跡、承認 review 導線、原因別ジョブ incident も、既存 facade を使って利用体験を改善できる。

これは静的比較に基づく採用調査であり、現行 checkout での攻撃成立、性能改善、実サービスでの復旧成功を実証した報告ではない。
今回、production コードの変更、第三者 plugin の導入、認証変更、Hermes の実行、有料 model probe は行っていない。

## 調査範囲と判断方法

- Hermes: 実 clone の固定コミット [`e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6`](https://github.com/NousResearch/hermes-agent/tree/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6)。最新版全般への主張ではない。
- Kyberion: `/Volumes/data/prod/kyberion` の調査中に読み取った作業ツリー。調査開始時 HEAD は `d71593cbf` であり、直前の実装を含む未コミット差分も比較した。調査中に共有 checkout の HEAD が `68d3b5094` へ進んだため、単一の commit 全体に対する再監査とは主張しない。各候補は示した読取経路の範囲に限定し、実装着手時にその後の差分を再照合する。
- Hermes のコードと関連テスト、Kyberion の実 caller と隣接機構を照合した。テストは内容の確認であり、今回実行した結果ではない。
- 記憶・context・復旧、権限・tool・plugin、接続・TUI・運用を分担して調査し、評価・検証証跡・既採用項目との重複を統合確認した。
- 「検索で見つからない」を不存在の証明にしない。差分は特定の caller、返却契約、表示経路に限定した。
- 確度は静的根拠への確信度であり、安全性や効果の保証ではない。工数 S/M/L は相対規模で、納期の見積もりではない。

既採用範囲は [UI/UX](hermes-ui-ux-adoption-2026-10.md)、[CLI 費用](hermes-cli-cost-accounting.md)、[runtime と連続実行](hermes-runtime-adoption-2026-10.md) を参照する。

## 候補一覧

P1 は次の限定実装へ進めやすい候補、P2 は境界・運用設計を先に確定する候補、P3 は需要を確認してから扱う候補。
番号は発見管理用であり、脆弱性の severity ではない。

| ID  | 候補                                                 | 優先度 | 規模 | 確度 | 位置付け                                 |
| --- | ---------------------------------------------------- | ------ | ---- | ---- | ---------------------------------------- |
| A01 | 自動 Git probe の repository-config 実行 sink 抑止   | P1     | M    | 高   | 新規、Hermes 実装・対照テストあり        |
| A02 | 不可視 Unicode と provenance を考慮した scanner      | P1     | S    | 高   | 新規、具体的な検査範囲の差               |
| A03 | 想起の empty / unavailable / rejected を分離         | P1     | S–M  | 高   | 新規、Hermes の表示機構からの適用設計    |
| A04 | TUI bounded read の欠落・エラー状態を返す            | P1     | S    | 高   | 新規、既存の status 表示へ接続           |
| A05 | 外部接続の開始から完了まで追う操作カード             | P1     | M    | 高   | 新規、前回の検索・owner 表示とは別       |
| A06 | plugin 更新の旧版保持と transaction recovery         | P1     | M    | 高   | 新規、既存 staging / digest gate を拡張  |
| A07 | 定期ジョブの原因別 ack・復旧・再発 projection        | P1     | M    | 中高 | 新規、通知 dedup 自体は既存              |
| A08 | task-local credential resolver binding               | P2     | M–L  | 中高 | 新規、共有 process の lookup isolation   |
| A09 | TUI の承認内容確認・review 先への導線                | P1     | S–M  | 高   | 新規、承認 engine の新設ではない         |
| A10 | 明示的な TUI 入力キューの編集・取消                  | P2     | M–L  | 高   | 前回意図的に見送った範囲の再評価         |
| A11 | 正常な圧縮にも durability receipt を要求可能にする   | P2     | M    | 高   | 新規、上流は契約・テスト段階の限定あり   |
| A12 | compaction snapshot の lineage と現行世代解決        | P2     | M    | 高   | 新規、汎用 session resume は既存         |
| A13 | agent 指示ファイル変更を専用 effect として識別       | P2     | M    | 中高 | 新規、承認済み範囲は再利用               |
| A14 | 学習成果の参照切れ・孤立状況を診断                   | P3     | S–M  | 中   | 新規、advisory のみ                      |
| X01 | 検証結果の鮮度・範囲を workspace 表示へ接続          | P2     | M    | 中高 | 横断的適用案、既存 evidence fence は維持 |
| X02 | 実ループ replay と品質・費用・待ち時間の比較 battery | P1     | M    | 高   | 評価方法の採用、既存 A/B engine を再利用 |

## 権限・実行境界

### A01: 非対話 Git probe の防御

- **Hermes 根拠:** [`_subprocess_compat.py:288–302,512–523`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/hermes_cli/_subprocess_compat.py#L288) は fsmonitor、hooks、editor、credential helper と repository 固有 filter を抑止・検査する。diff は `:49` で external diff / textconv を抑止する。`tests/security/test_gitspawn_config_injection.py:141,165–180,305` に未防御経路の対照と回帰がある。
- **Kyberion の差分:** [session-git-index.ts:119–120,211–212](../../../libs/core/session-git-index.ts) は `safeExecResult('git', …)` を使う。権限付き process 実行と、Git が repository 設定から起動する executable の抑止は別の境界である。
- **適用:** 外部 checkout を含む自動・非対話の読み取り probe に、共通の hardened 引数・環境 builder を使う。通常のユーザー承認済み Git 操作を一律に無効化しない。
- **注意と検証:** 正当な filter を必要とする操作は unavailable と区別する。隔離 fixture で fsmonitor / named filter / diff helper の sentinel が発火しないことを確認する。現 Kyberion での exploit 実行はしていない。

### A02: Unicode と provenance を考慮した検査

- **Hermes 根拠:** [`threat_patterns.py:110–112`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/tools/threat_patterns.py#L110)、`tools/cronjob_prompt_scan.py:121–144` は不可視・方向制御文字と raw / skill 由来の違いを扱う。`tests/tools/test_cron_prompt_injection.py:36–43`、`tests/cron/test_cron_prompt_injection_skill.py:229,345` が分断文字と過検知を扱う。
- **Kyberion の差分:** [untrusted-content.ts:111–134,174–186](../../../libs/core/untrusted-content.ts) の instruction 検出と不可視文字集合には、調べた範囲では U+2063 / U+2068 の扱いに差がある。
- **適用:** 既存 scanner に検査専用の normalized view と indicator を追加する。原文・source evidence は保持する。
- **注意と検証:** 日本語、emoji の ZWJ、引用された攻撃例、code sample を用いた false-positive 回帰が必要。検知器を tenant authorization や実行許可の代わりにしない。

### A06: plugin 更新 transaction

- **Hermes 根拠:** [`plugins_transaction.py:17–49,198–208`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/hermes_cli/plugins_transaction.py#L17) は staged tree、旧・新 metadata、commit 時の target digest を関連付ける。`tests/hermes_cli/test_plugin_update_transaction.py:169–203` は複数の失敗点で旧状態を保持する。
- **Kyberion の差分:** [plugin-managed-install.ts:958–974](../../../libs/core/plugin/plugin-managed-install.ts) には staging と manifest / digest の検査がある。一方 `:1045–1055` は旧 managed directory を除去して移動した後に approval request を作る。既存の安全な activation gate とは別に、途中失敗・同時更新からの復旧を強化できる。
- **適用:** plugin 単位 lock、旧 digest の再照合、旧 directory の退避、code / install record / approval identity の一体的 publication と recovery。
- **注意と検証:** 旧 grant を新 code に引き継がない。失敗注入と競合更新で旧 code・metadata・承認の対応が崩れないことを検証する。Python dependency installer 自体を移植する必要はない。

### A08: task-local credential binding

- **Hermes 根拠:** [`secret_scope.py:110,230–260`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/secret_scope.py#L230) の multiplex mode は未束縛 scope を拒否し、scope 内にない key を ambient process env に fallback しない。`tests/agent/test_secret_scope.py:36–53` がその契約を確認する。
- **実際の適用経路:** `gateway/run.py:1805–1827,1854–1861` が profile scope と multiplex mode を設定し、webhook / shared ingress がその context に入る。`cron/scheduler.py:3243–3258,3321` にも設定と解除がある。helper / test だけの機構ではない。
- **Kyberion の既存境界と差分:** [secret-guard.ts:307–355](../../../libs/core/secret/secret-guard.ts) には plugin / service / temporal grant がある。その後の env・personal cache・vault lookup を、trusted task / tenant の credential binding と一体化する余地がある。[provider-permission-profiles.ts:460–482](../../../libs/core/provider/provider-permission-profiles.ts) の provider 単位 env allowlist は、同一 provider 内の tenant 別 credential 選択とは別軸である。
- **適用:** 既存の実行コンテキストに resolver binding を付け、tenant 実行での miss が personal / global credential を拾わないようにする。provider spawn env も同じ binding を使う。
- **経路を混同しない:** service は `service-binding.ts:66–71` → `service-secret-resolver.ts:5–9` → secret guard、CLI は `shell-claude-cli-backend.ts:1066–1074` → `provider-spawn-env.ts:57–63` → provider allowlist、API は `openai-compatible-backend.ts:554–565,657,721–722` の key 選択・instance 保持・送信である。CLI / API が現在 `getSecret` を共通利用しているとは説明しない。追加の検証対象は、各経路の credential 選択・cache・instance の帰属である。
- **注意と検証:** 現在の cross-tenant 漏えいを確認したという主張ではない。service scope や profile 名を tenant authorization と同一視しない。並行 tenant fixture と単独 operator mode を分けて検証する。

### A13: 永続的な agent 指示の変更を識別

- **Hermes 根拠:** [`file_tools_write_guards.py:177–190,211–219,260–278`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/tools/file_tools_write_guards.py#L177) は指示ファイルを入力名と realpath で照合する。`tests/tools/test_file_write_safety.py:676–685,740–746` と `tests/tools/test_protected_instruction_cli_channel.py:26–38` に回帰がある。
- **Kyberion の差分:** [secure-io-path-guard.ts:407–419](../../../libs/core/secure-io-path-guard.ts) の write 権限と、[approval-policy.ts:344–351](../../../libs/core/governance/approval-policy.ts) の injection 時承認は既存。通常文書の更新と、将来の agent 行動を変える変更の effect 分類を分けることが追加候補である。
- **適用:** 既存 external-operation / approval に、正規化済み対象・変更 digest・許可範囲を持つ effect を追加し、file tool と shell / patch 経路をそろえる。
- **注意と検証:** 毎回の再質問を増やす案ではない。ユーザーが既に認めた変更範囲を利用し、symlink、別名、部分差分、承認後の内容変更を検証する。上流の file-tool guard だけで全書込経路が保護されるとも断定しない。
- **上流の適用限界:** file tools の呼出元は `tools/file_tools.py:788,875`。terminal は `tools/terminal_tool.py:1084–1090` の別 guard であり、`tools/approval.py:1157–1199` には早期許可や別実行経路の限界がある。採用案は部分的 gate の複製ではなく、Kyberion の共通 effect / authority 境界での統一である。

## 記憶・context・復旧

### A03: 想起結果の状態契約

- **Hermes 根拠:** [`turn_context.py:918–940`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/turn_context.py#L918)、`agent/memory_manager.py:409` は prefetch と recall indicator を model の自己申告とは別に扱う。`tests/agent/test_memory_provider.py:344,1347` 以降が merge と trivial-query gate を扱う。
- **Kyberion の差分:** 実 caller は [mission-context-pack-knowledge.ts:564](../../../libs/core/mission/mission-context-pack-knowledge.ts)。[tenant-knowledge-retrieval.ts:270–350](../../../libs/core/organization/tenant-knowledge-retrieval.ts) は blank、不正 scope、例外の経路がいずれも hit 配列 `[]` となる。warning と knowledge-gap 記録は既にある。
- **適用:** 互換 wrapper で `hits + outcome + source refs + effective scope` を返し、caller と表示で empty / unavailable / scope-rejected を区別する。外部 memory provider は不要。
- **注意と検証:** この status taxonomy 全体を Hermes が実装しているという意味ではない。Hermes の deterministic indicator を参考にした Kyberion 向け設計案である。権限拒否に他 tenant の存在・件数を含めず、正常0件と障害を別 fixture で検証する。

### A11: 圧縮前 durability receipt

- **Hermes 根拠:** [`conversation_compression.py:2889,3809`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/conversation_compression.py#L2889)、`agent/memory_manager.py:693` は checkpoint 必須時の API v2 契約を検査する。`tests/agent/test_pre_compress_checkpoint_contract.py:155,171,265,277` に拒否・成功の契約テストがある。
- **上流の成熟度の限定:** `agent/memory_provider.py:107` の base は API v1 であり、調査範囲では production provider が API v2 を advertise する実装を確認できなかった。Hermes 標準が生履歴を immutable 保存済みとは評価しない。採用対象は fail-closed の保存成功契約である。
- **Kyberion の差分:** [worker-context-compaction.ts:483,617](../../../libs/core/workforce/worker-context-compaction.ts) の通常 summary artifact は要約・carryover・保護尾部を保存し、pre_compact hook は観測用である。前回追加した [worker-compaction-recovery.ts:65](../../../libs/core/workforce/worker-compaction-recovery.ts) の全文 archive は stall 回復用。正常圧縮でも削除対象全文の保存 receipt を要求可能にする点が増分である。
- **適用と検証:** 元 scope と content hash を持つ既存 scoped artifact の receipt を確認してから context を置換する。保存失敗・取消・古い世代は置換しない。
- **注意:** raw 履歴の secret・個人情報・tool 出力について、保存 tier、閲覧権限、保持期限、削除手順を先に定める。保存を memory 公開や承認と扱わない。無条件の永久保存は採用しない。

### A12: compaction snapshot の世代解決

- **Hermes 根拠:** [`hermes_state_compression.py:882–895`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/hermes_state_compression.py#L882) の chain / tip 解決を、`tui_gateway/methods_session.py:536,833` と `hermes_cli/sessions_adopt.py:42` が使う。`tests/agent/test_compression_closed_adoption.py:67–157` は continuation の一度だけの採用と fail-closed を扱う。
- **Kyberion の既存境界と差分:** [worker-state-journal.ts:23–34,546,710](../../../libs/core/workforce/worker-state-journal.ts) は silent replay、fork / cancel hygiene、goal / delegation / reminder の復元を持つ。追加対象は、compaction artifact の親 snapshot・hash・現行 generation を選ぶ契約に限る。
- **適用:** 既存 journal に compaction commit と親 generation を記録し、復元で唯一の有効 snapshot を選択する。新 session DB は不要。
- **注意と検証:** tool・通知・外部作用を replay しない。曖昧な分岐は自動選択せず、圧縮中 crash、二重 commit、古い snapshot の復元を検証する。

### A14: 学習成果の関係・孤立診断

- **Hermes 根拠:** [`learning_graph.py:125–132,192,207–227`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/learning_graph.py#L125) は関連 skill、孤立率、external mount の除外を扱う。実 caller は `tui_gateway/methods_tools.py:1340` と `hermes_cli/web_routers/status.py:697`。`tests/agent/test_learning_graph.py:23,64,84` が根拠。
- **Kyberion の差分:** [knowledge-usage-aggregate.ts:13](../../../libs/core/knowledge/knowledge-usage-aggregate.ts) に配信・使用、[knowledge-curation-report.ts:146,546](../../../libs/core/knowledge/knowledge-curation-report.ts) に low-yield / freshness、[memory-provenance.ts:217](../../../libs/core/knowledge/memory-provenance.ts) 以降に content-bound lineage がある。効果測定全体が欠けているわけではない。
- **適用:** 明示参照と typed provenance による参照切れ・孤立診断を、既存 curation report に advisory として追加する。
- **注意と検証:** 語彙の一致は仮説に限定する。edge が承認・公開権限や事実を生まないようにし、cross-tenant edge を作らない。

## UI/UX・運用

### A04: bounded read の状態表示

- **Hermes 根拠:** [`createGatewayEventHandler.ts:1246–1256`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/ui-tui/src/app/createGatewayEventHandler.ts#L1246) は replay gap 時に focused session を再 attach する。`ui-tui/src/__tests__/replayGapReattach.test.tsx:17–28,80–103` は subscriber overflow を扱う。
- **Kyberion の差分:** [tail.ts:19–57](../../../presence/displays/terminal-hud/src/store/tail.ts) は先頭断片や malformed 行を除外するが、その metadata を返さず、I/O 例外も `[]` にする。[use-poll-watch.ts:60–69](../../../presence/displays/terminal-hud/src/store/use-poll-watch.ts) は loader が throw すれば前回値と error を保持できる。
- **反証と適用:** [agent-graph.ts:77,354–356](../../../presence/displays/terminal-hud/src/store/agent-graph.ts) の collaboration projection には bounded / stale 表示が既にある。新 replay protocol を作らず、tail facade の truncated / skippedLines / readError を既存表示と refresh へ接続する。
- **検証:** 正常0件、途中行、壊れた行、権限拒否、ローテーション、前回値保持を区別し、行ごとの警告洪水を防ぐ。

### A05: 外部接続の操作カード

- **Hermes 根拠:** [`connectionOperationStore.ts:11–19,64–125`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/ui-tui/src/app/connectionOperationStore.ts#L64) は opId、seq、期限と dismiss を保持する。`createGatewayEventHandler.test.ts:237–266`、`connectorAccounts.test.ts:91–99` が更新順序と完了後の表示を扱う。
- **Kyberion の差分:** [settings/page.tsx:707–748](../../../presence/displays/concierge/src/app/settings/page.tsx) は OAuth 開始と URL を開く処理の終了で busy を解除する。[ServicesSection.tsx:120–124](../../../presence/displays/concierge/src/app/settings/sections/ServicesSection.tsx) の一覧とは別に、開始した接続操作の完了・期限切れを追う表示が候補となる。
- **適用:** 既存 OAuth attempt と接続 read facade に結び付いた「ブラウザ承認待ち／確認中／接続済み／期限切れ」カード。TUI は同じ状態と GUI link を使う。
- **注意と検証:** dismiss と cancel を分ける。秘密 URL・コードを状態イベントに入れず、別タブ・遅延 callback・期限切れ・別 viewer の誤結合を検証する。

### A07: 定期ジョブの原因別 incident

- **Hermes 根拠:** [`cron/incidents.py:137–199,237–249`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/cron/incidents.py#L137) は job＋正規化エラー署名、ack、closed と resolved を区別する。`tests/cron/test_cron_incidents.py:123–137,221–300` と `test_cron_incidents_resolve.py:22–43` が根拠。
- **Kyberion の既存境界と差分:** [feedback-loop.ts:280–351](../../../libs/core/knowledge/feedback-loop.ts) は失敗集約・連続失敗・成功時 reset を持ち、[scheduler-alert-markers.ts:1–35](../../../libs/core/scheduler-alert-markers.ts) に durable dedup がある。追加対象は job＋原因への ack と、復旧・別原因での再発の関係である。
- **適用:** 既存 ops alert / inbox / 実行履歴の上に projection を置き、「この原因は確認済み」「復旧」「別原因で再発」を表示する。
- **注意と検証:** error code と原因分類を優先し、文字列だけで無関係な障害をまとめない。同原因、原因変更、成功後再発、ack 期限、tenant 分離を検証する。

### A09: TUI から承認内容の確認へ

- **Hermes 根拠:** [`prompts.tsx:28–98`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/ui-tui/src/components/prompts.tsx#L28)、`ui-tui/src/__tests__/approvalAction.test.ts:6–28,54–106` は `req.choices` がある場合に server 提示候補へ制限する。未指定時は legacy の smartDenied / allowPermanent / default 候補へ fallback するため、常に server 候補だけを使う実装とは評価しない。
- **Kyberion の差分:** [operator-cockpit.tsx:82–83](../../../presence/displays/terminal-hud/src/components/operator-cockpit.tsx) は pending 件数、[agent-graph.ts:107](../../../presence/displays/terminal-hud/src/store/agent-graph.ts) は承認待ちを認識する。実 decision は既存 [approvals API:24–25,64–94](../../../presence/displays/concierge/src/app/api/approvals/[id]/route.ts) が viewer と tenant 等を確認する。
- **適用:** TUI に対象、理由、期限、内容 digest、該当 review 先への link を表示する。端末からの decision は既存の本人確認条件を満たす場合だけ追加する。
- **注意と検証:** 新しい approval store や Session / Always grant は不要。期限切れ・内容更新・別 viewer・表示を閉じた場合の挙動を区別する。

### A10: 明示的な入力キュー

- **Hermes 根拠:** [`useQueue.ts:18–71,246–251,292–327`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/ui-tui/src/hooks/useQueue.ts#L18) は submission ID、宛先・添付、server-owned cancel を扱う。`busyQueueAdmission.test.tsx:103–261` と `queueEditKeepsFields.test.ts:9` が根拠。
- **Kyberion の差分:** [terminal app.tsx:147–149](../../../presence/displays/terminal-hud/src/app.tsx) と [app.test.ts:98–124](../../../presence/displays/terminal-hud/src/app.test.ts) は busy 時の draft を保持するが、送信・queue 化しないことを意図している。前回未導入だった範囲である。
- **適用:** 既存 task session / WorkItem admission に結び付いた「次に送る」、編集、取消を追加する。local FIFO の無条件自動送信にはしない。
- **注意と検証:** 宛先・scope・添付の保持、変更時の submission ID、再接続の二重送信、取消拒否と不明な配送結果を検証する。

## 横断的な適用案

### X01: 検証範囲と鮮度の表示

- **Hermes 根拠:** [`verification_evidence.py:551–591,706–805`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/verification_evidence.py#L706) は targeted / full の区別と edit 後の stale を扱う。module 自身が passive であり、completion gate ではないと明記している。
- **Kyberion の反証:** [mission-task-evidence-binding.ts:18–24,150–190](../../../libs/core/mission/mission-task-evidence-binding.ts) は lease / scope と artifact / source hash を検査する。証跡の束縛が欠けているわけではなく、ここは Hermes より強い境界を維持する。
- **追加するなら:** [operator-home-summary.ts:240–264](../../../libs/core/surface/operator-home-summary.ts) は latest quality report の recommendation・generatedAt・evidenceRefs を投影する。この表示に「現在の source snapshot と一致」「一部のみ」「更新後未検証」を追加する。新しい SQLite 証跡 DB や、文字列からの検証済み認定を導入しない。
- **検証:** 未コミット差分、別 worktree、検証後の編集、部分テスト、scope 内で読めない source を含める。content-bound receipt がない場合は unknown とする。

### X02: 実ループ replay と比較評価 battery

- **Hermes 根拠:** [`evals/token_accounting/replay_gates.py:1–18`](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/evals/token_accounting/replay_gates.py) は provider usage と byte 推定が意図的に食い違う fake server で実ループを駆動し、CLI と JSON round-trip を挟む gateway を比較する。`evals/core_tool_deferral/tasks.py:1–16` の task battery と `report.py:34–63` は品質・turn・token・時間・error をまとめる。
- **Kyberion の反証:** [eval-scenario.ts:1–23](../../../libs/core/harnessing/eval-scenario.ts)、[contrastive-session.ts:43–68,296–305](../../../libs/core/harnessing/contrastive-session.ts)、[probe-runner.ts:30–76](../../../libs/core/harnessing/probe-runner.ts)、[decision-axis.ts:11–30](../../../libs/core/harnessing/decision-axis.ts) に既存の比較・実行・指標・証跡がある。A/B engine 不在とは評価しない。
- **採用する要素:** 既存 harness 用のシナリオと grader を増やす。provider usage の乖離、restart / reconnect、古い callback、モデル切替、partial SSE、quota reset、server-owned queue、cancel 後の遅延結果を一つの runtime battery として比較する。
- **注意と検証:** 品質を落として token が減った結果を採用しない。まず fake provider と仮想時間で再現し、実 provider 比較は別の明示的な予算を設ける。上流の sample 結果を Kyberion の性能証明に使わない。

## 重複と採用しない挙動

| 検討対象                                                            | 判定と根拠                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 履歴 FTS / CJK trigram の新設                                       | 既存 [history-search-index.ts:24,250](../../../libs/core/history-search-index.ts) を再利用する                                                                                                 |
| 汎用 session resume / fork の新造                                   | worker journal の silent replay と active→paused、fork hygiene が既存。A12 の圧縮 snapshot 増分だけを検討                                                                                      |
| 通知 dedup と曖昧配送の再送防止                                     | 既存 [operator-notifications.ts:535–550](../../../libs/core/surface/operator-notifications.ts) と回帰テストを維持                                                                              |
| MCP 起動承認・実行直前の interface 再照合                           | 既存 [service-mcp-execution.ts:82–129](../../../libs/core/service/service-mcp-execution.ts) と [remote-mcp-interface.ts:86–99](../../../libs/core/governance/remote-mcp-interface.ts) を再利用 |
| MCP の名前単位 Session / Always と readOnlyHint を authority にする | 上流 `tools/mcp_tool_handlers.py:60–73,133–135` の簡便さを exact arguments / schema digest / tenant / effect の代わりにしない                                                                  |
| single-profile の process env fallback を tenant 実行にも使う       | `agent/secret_scope.py:233–247` の単独運用側ではなく、A08 の multiplex fail-closed 側だけを参考にする                                                                                          |
| 語彙 graph から事実・承認・公開を自動確定                           | 語彙一致は advisory。既存 content-bound provenance と scope を優先する                                                                                                                         |
| 指示ファイルの変更ごとに必ず再承認を求める                          | 既に許可された範囲を再利用し、通常の作業を反復質問で止めない                                                                                                                                   |
| 新しい global task / incident / knowledge store を先に追加          | 既存 WorkItem、journal、alert、inbox、curation report に projection / contract を追加する                                                                                                      |
| 固定の総実行時間上限へ戻す                                          | ユーザーの連続実行方針と前回の実装を維持する。単発の待機期限と、監督された継続実行は別の軸                                                                                                     |

## 以前からの保留事項との区別

- **MoA / heterogeneous advisors:** 新発見ではない。`agent/moa_loop.py:1276–1338` の user_turn / every_n cadence は有用だが、既存 typed perspective fanout を使い、費用・egress・不完全な助言を明示する任意機能として別に設計する。
- **requested / provider-reported served model:** 以前のルーティング調査での保留候補。`agent/served_model.py:20–68` を参考にできるが、proxy header に入る API base をそのまま公開しない。
- **環境 backend 抽象化:** 元の [HA-05:166–173](../../../docs/developer/improvement-plans-2026-07/HERMES_AGENT_ADOPTION_PLAN_2026-07-18.ja.md) の条件付き保留。A01 の限定防御を、この大きな移行まで待つ必要はない。
- **frozen memory prefix / 外部 memory provider:** 前者は既存 stable-prefix の再利用、後者は明示的な scope・同意を持つ adapter を必要時に検討する。今回の A03 のために外部同期は不要。

## 推奨する実装順と検証

1. **小さな防御と状態契約:** A01、A02、A03、A04。異常を正常な空状態にしないこと、権限を広げないことを確認する。
2. **運用と利用者の待ち時間:** A05、A06、A07、A09。操作 ID、旧 digest、job＋原因、approval digest を既存の authority に束縛する。
3. **共有実行と長期 context:** A08、A11、A12、A13。保持期限、復旧、曖昧な結果、scope の設計を先にレビューする。
4. **必要性の確認後:** A10、A14、以前からの MoA 等。操作量・知識量の実測があるときに優先度を上げる。
5. X02 の再現シナリオを各段階に追加し、X01 で検証範囲と鮮度を表示する。unit test の件数だけで長期運用の有効性を認定しない。

この順序は静的な比較からの提案であり、実装の許可や公開・deploy の承認ではない。
調査の証跡は `MSN-HERMES-DEEPDIVE-20261028` に記録する。

## 実装への反映

後続の実装依頼に基づく変更・運用条件は [追加採用の実装記録](hermes-additional-adoption-implementation-2026-10.md) に記載する。
上記の静的調査時点と、後続の実装・検証時点を区別する。A10 / A14 等の需要条件は維持する。
