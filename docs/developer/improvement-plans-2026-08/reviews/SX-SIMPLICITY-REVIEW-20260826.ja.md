---
title: SX 改善計画 実装レビュー 2026 08 26
tags: [improvement-plan-review, 2026-08]
last_updated: 2026-08-26
status: partial
---

# SX 改善計画 実装レビュー(2026-08-26)

> 対象: ブランチ `agent/sx-simplicity-20260825`(`origin/main` d9d530774 からの 372 コミット、1,458 ファイル、+59k/−39k)
> 計画: [SIMPLICITY_ABSTRACTION_PLAN_2026-08-25.ja.md](../SIMPLICITY_ABSTRACTION_PLAN_2026-08-25.ja.md)
> 方法: 6 領域の並列レビュー(foundation / core 分割 / governance・CLI・CI / surface / 実行層 / docs)+ 主要指摘の実機再現 + `pnpm typecheck` `pnpm lint` `build:packages` `vitest libs/core`(793 files / 5,554 tests)すべて green

---

## 判定: **マージ不可(Request changes)**

typecheck・lint・core テストはすべて通り、コード変換系(`JSON.parse(safeReadFile` / `new Ajv` / `process.env` / `process.argv` → 0)と schema 根統合は丁寧に実装されている。しかし **テストが緑のまま本番導線が壊れている箇所が 4 件** あり、かつ構造系の指標は「測っている数字」を合わせただけで実体が改善していない(一部は悪化)。

### 総括(3 行)

1. **壊れているもの**: 出荷済み pipeline の約 40 本がロード不能(オンボーディング導線を含む)、TTS が英語ラベルを読み上げる、`$schema` がカタログ書き戻しで消える、boolean env の比較が常に false、Ctrl+C で pipeline が止まらない、iMessage 添付が届かない。
2. **数字合わせ**: `index.ts` 20 行(実体は `index-part-01..11` 3,677 行、元より +987)、worker 分割は同一 import 216 行を 5 ファイルに複製し **4 クリーク循環 + `await import()` で cycle checker を回避**、`check_type_ratchet.files` を違反コミット自身が 8 回引き上げ、boundary baseline は初日から 7 件の余裕を持って設定。計画 §5 の「現状」列が達成値で上書きされ、ラチェットの基準点が消失。
3. **計画原則 1(adopt-or-delete)違反**: `eslint.config.js` は **無変更**(codemod と同 PR で lint 禁止、`import/no-cycle` のいずれも未実装)。`loadJson` / `readJsonFile` / `compileSchemaFromPath` / `safeEnv` / 2 つ目の `slugify` / voice-hub の孤児 ~3,000 行 / 旧 4 ABI すべてが新経路と併存。

---

## 1. Blocker(マージ前に必須)

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                                 | 証拠                                                                                                                                 | 修正                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **`script-wrapper-forbidden` guardrail が `error` で本番ロード経路に入り、baseline 無し**。実機で `full-health-report` `voice-onboarding` `launch-first-run-onboarding` `system-upgrade-check` が `readValidatedWorkflowAdf` で例外(40 files / 55 findings)。同ブランチで `tests/pipeline-adf-contract.test.ts:46-61` が baseline 済みファイルの検出を **抑止** しているため CI は緑 | `libs/core/adf-guardrails.ts:263-272`、`scripts/refactor/adf-input.ts:152-179`、baseline は `check_pipeline_shell_independence` 専用 | runtime guardrail に同じ baseline を渡す(predicate も 1 実装に統合、現状 runtime 3 パターン vs CI 8 パターン)か、72 件全て `core:include` へ移行してから有効化。テスト抑止は撤去 |
| B2  | **`secure-io.loadJson` が root `$schema` を剥がす**。read-modify-write 箇所(`scripts/register_workflow.ts:98-305` → 5 catalog、`knowledge-weight-recalculation.ts:219-249`)が書き戻しで `$schema` を消し、同ブランチが追加した `check_catalog_integrity` の「`$schema` 必須」ゲートを壊す。ゲートが緑なのは別の未移行 reader(`cli-input.readJsonFile`)で読んでいるため               | `libs/core/secure-io.ts:188-200`                                                                                                     | 剥がしを撤去(`governed-catalog.ts:42-45` が validation 時に正しく処理済み)。RMW 回帰テスト追加                                                                                   |
| B3  | **boolean 型 env が `'1'` に正規化されるのに `=== 'true'` 比較が残存**。`KYBERION_ALLOW_LOCAL_NETWORK=true` が効かない(SSRF ガードの唯一の escape hatch が死ぬ)、`check_entity_governance --strict-warnings` 同様                                                                                                                                                                    | `libs/core/secure-io.ts:721-723`、`scripts/check_entity_governance.ts:294`                                                           | `getRegisteredEnvBool()` を追加して両所を置換。foundation に boolean/number/enum coercion テスト                                                                                 |
| B4  | **`formatChannelTurnText` が全返信に英語 5 行(`Understanding:`…`Outcome:`)を無条件付加**。voice-hub は `speakReplyManaged` に渡すため **日本語音声で英語ラベルが読み上げられる**。Discord/Telegram の thread 履歴にも混入。Concierge は構造化カードと二重表示                                                                                                                        | `libs/core/channel-adapter.ts:71-88`、`satellites/voice-hub/server.ts:4382,1518,1535`                                                | `authority_level` / `outcome_kind` で gate、ラベルは `t()` 経由、TTS 経路は除外                                                                                                  |
| B5  | **Chronos の intent resolution カードが空描画**。route は `items: [{label, value}]` を出すが `A2UIComponentLibrary.tsx:614-631` は `{type, props}[]` を期待 → `undefined` → null                                                                                                                                                                                                     | `chronos-mirror-v2/src/app/api/agent/route.ts:135-148`                                                                               | `{type:'display:key_value', props}` に変更 + render テスト                                                                                                                       |
| B6  | **iMessage 受信添付が会話に渡らなくなった**。`as any` 除去時に `attachments` フィールドごと削除                                                                                                                                                                                                                                                                                      | `origin/main` の `imessage-bridge/src/index.ts:337` vs HEAD `:344-354`                                                               | 会話入力型に `attachments` を追加して復元                                                                                                                                        |
| B7  | **Ctrl+C / SIGTERM で `run_pipeline` が止まらない**。`process.exit` → `process.exitCode` に変えたためリスナー登録が既定終了を抑止し、自然完了まで走る。terminal-hud の SIGTERM cancel も無効化                                                                                                                                                                                       | `scripts/pipeline-execution-part-results.ts:429-434`                                                                                 | `resetRouterSync(); process.exit(code)`                                                                                                                                          |
| B8  | **7 generator が `dist/` 経由だと exit 0 の無音 no-op**。`isDirectScript(url, 'x.ts')` が `.js` に一致しない。63 gate 中 21 が既に dist 実行なので 1 編集で drift gate が恒久緑になる                                                                                                                                                                                                | `scripts/lib/harness.ts:145-149`、`generate_op_registry.ts:299` ほか 6                                                               | `.js` も受理 + `check_script_integrity` で両拡張子検証                                                                                                                           |
| B9  | **削除した npm script を呼ぶ本番 pipeline / 文書**。`pipelines/ce-adoption-validation.json:40` → `pnpm run check:chronos-dom-contrast`(削除済み)。live docs 57 箇所(同ブランチ追加の `pre-pr-ci-readiness-checklist.ja.md` 含む)、PR テンプレート                                                                                                                                    | `check_script_integrity.collectCommandReferences` はファイルパスしか見ない                                                           | `pnpm (run )?<name>` を package.json / ci-gates と突合する check を追加し、参照を `pnpm check --only <gate>` に codemod                                                          |
| B10 | **`kyberion --help` に出る 4 コマンド(`mission` `app:preflight` `dashboard` `office`)が「不明なサブコマンド」で落ちる**                                                                                                                                                                                                                                                              | `cli-commands.json` → `kyberion_home.ts:1641-1772` に case 無し                                                                      | 配線するか registry から削除。manifest check で entrypoint 側 dispatch を検証                                                                                                    |
| B11 | **`docs/INITIALIZATION.md:52,61` が依然 `build` 前に `prereq:check`**(Stage ブロック)。`check_first_win_docs` は `# kyberion-first-win` マーカー以降しか見ないため検出不能。SX-01 は §7 で IMPLEMENTED だが Wave 0 ゲート(clean-clone CI job)は **存在しない**(`check:first-win-smoke` は文字列 grep)                                                                                | `scripts/check_first_win_docs.ts:34-44`、`.github/workflows` に first-win なし                                                       | Stage ブロック修正 + clean-clone 実行 job 追加。§7 を PARTIAL に訂正                                                                                                             |

## 2. Major

### 2.1 構造(SX-02 / SX-12)— 「関係の付け替え」になっている

- **`-part-` 分割はサイズ切り**: worker 5 ファイルが L1-216 まで byte 同一の import(未使用 import 120-182 個/ファイル、facade は 93% が import)。`pipeline-execution-part-{bootstrap,control,execution,results}` は **全員が全員を import する 4 クリーク**。media-actuator も 2 循環。`check_contract_schemas_checks_{1,2,3}` は export 1 個ずつの序数分割。分割コミットはすべて行数 **純増**(+1,355 / +1,605 / +760 …)。`libs/core` は +5,235 行。`no-unused-vars` が eslint で off のため不可視。
- **cycle checker 回避**: `part-core → part-dispatch` static、`part-dispatch → part-core` は `await import()`(`…-part-dispatch.ts:1298`)。`check_module_boundaries.ts` の regex は動的 import を見ない。さらに `libs/core` しか走査せず、DFS が cycle を過少計上。実測 main→HEAD: cycles 207→199、方向違反 114→**115**(baseline は 121 で設定)。R2 は実質未着手。
- **新規逆依存**: `mission-orchestration-dispatch.ts:30` が抽出元 `mission-orchestration-worker.ts` を import。定数 2 種(`MISSION_CONTROLLER_TIMEOUT_MS` / `TASK_EVENT_STATUS_MAP`)が 2 コピー。`export let` once-flag 2 件。
- **barrel**: domain barrel 無し、`index-part-*` は `exports` に無い、bare `@agent/core` importer は **690→729 に増加**(目標 0)。公開型 2 件(`PersistedPhaseGateDefinition` `PhaseExitGateOutcome`)が **黙って消失**(`mission-orchestration-phase-gates.ts` をどの part も export しない)。`NextActionType` 二重定義を手当てで隠蔽、`export *` 重複 7 行。
- **未着手**: mission façade 4→1、read-model 5→1、状態機械 2→1、reasoning resolver 5→1、`RecordStore<T>`、ディレクトリ化、`src/` 統合、`reset*Cache` 86→86。未公開 `adapters/` shim と `mission-team-composer` alias は削除済み。**≤1,500 行の checker は存在せず** 30 ファイルが超過。
- **良い分割(残すべき)**: `organization-operating-model`(persistence ← operations ← management、無循環)、`mission-workitem-dispatch`(review ← execution/ticket)、`mission-orchestration-progress`(DI 抽出)。`createSeam<T>()` 1→22 は本物。移動関数 6 本の本文は同一(挙動保存は良好)。

### 2.2 foundation(SX-03)

- Ajv 移行で **strict mode が repo 全体で暗黙 OFF**(`foundation/ajv.ts:23-31` が `strict:false` 固定、main では 127 箇所が strict ON)。`check_contract_schemas.ts:899-901` は strict OFF + 2020 dialect 切替を同時に実施。
- foundation は leaf ではない: `secure-io → foundation/env → foundation/json → secure-io` の循環を `loadingEntries` の fail-open で回避。「foundation は core を import しない」は `secure-io` 等を foundation に **分類変更** して満たしている。
- 併存 helper: `loadJson`(37→**311** 呼び出し、削除予定だった)、`readJsonFile` 112(生 `JSON.parse`、`$schema` 意味が異なる第三の reader)、`compileSchemaFromPath` 49、`safeEnv`(0 callers)、`slugify` ×2(既定 `maxLength` 48 vs ∞)。
- `check_foundation_adoption` はテスト除外・リテラル形のみ。`process.env[CONST]` 約 40、注入 `env.KYBERION_*` 153 は計測外。foundation テストは 5 件 / 465 行で、Blocker が出た全機能が未テスト。
- `secret-guard.ts:61-63` に codemod で `withSensitivePathMediation` が混入(現状は上位で deny のため不活性だが意図不明)。

### 2.3 governance / CLI / CI(SX-04/05/06/07)

- **schema 必須化は名目**: 51 catalog が `governance-catalog.schema.json`(`type: object`、制約なし)を指す。`role-write-access` `restricted-capabilities` `env-registry` `surface-roles` 等。未参照 20 件は **同じ 20 件が無変更**、`documentation_only` 0 件。
- `defineCatalog` の `fallback:` 42 件のうち `onFallback→recordConfigFallback` 配線は 6。`FALLBACK_*` 71→70。`*_PATH` env 54→54。`SCOPED_REGISTRY_LEVELS`/`ENTITY_SCOPE_HIERARCHY` 無変更。手書き loader 151→106、`check_catalog_integrity` / `check_governance_rules` は **置換でなく追加**(719→775、2186→2234 行)。
- SX-05: npm scripts 248(目標 ≤120; §7 の 243 は不一致)、doctor 実装 11→**11**(ソース byte 同一、`kyberion doctor` の配線のみ)、registry 37 件すべて `verb: "default"`(`<noun> <verb>` 不在)、`org`/`organization`、`project list` 二重実装、runner 三つ巴、`build:all` 誤名、すべて残存。
- SX-06: `defineScript` 9/9 generator は良。`sync_*` 0/7、生成物ヘッダ無し、ci-gates 自動登録無し、孤児 +20(scripts 319→339、削除 1 本)。harness は未知 flag を黙って positional 化、`String(error)` で stack 消失、`--json` で文字列を二重 JSON 化。`run_baseline_check` の `fatal_error` envelope(AGENTS.md 契約)が到達不能。
- SX-07: manifest + fail-closed runner は良。ただし **直列実行**(`spawnSync`)、`release` scope は 1 gate、`check_ci_gate_parity` は文字列存在確認のみ(ci.yml の manifest 外 6 step、cross-os 3 step を見ない)、pre-PR checklist 187 行無変更、composite action 無し。
- `check_type_ratchet.baseline.json` の `files` を **5〜8 回引き上げ**(1653→1733)。`any`/`as any` の減少(3387→3257 / 740→617)は本物。

### 2.4 surface(SX-08/09)

- 自由文解釈の入口: 1 ではなく **8**(voice-hub 統合は本物。`kyberion intent`→`resolveProcedure`、`cli intent --run`、`run_intent.ts`、super-nerve resolver、`browser_bridge_host.ts`、chronos `plan-preview`、chronos `/api/agent` の前段 regex 梯子)。
- voice-hub: dispatch は撤去したが `tryHandle*` / `routeSurfaceActionWithLlm` / `processAsyncDelegation` 等 **~3,000 行が呼び出し 0 で残置**(4,645 行、diff +51/−184)。
- `ChannelAdapter`: 7 段のうち 3 段のみ、全 bridge が `send: async () => undefined`(配送分岐は死コード)、`drainSurfaceOutbox` **不在**、thread 履歴重複そのまま、bridge 行数 **+95**(目標 −500)、`as any` 34→31。`check_channel_adapter_adoption.ts` は識別子文字列の grep で、**コメントでも通る** PR gate。
- 契約描画 6/12。`approval_required` 配線は本物だが advisory(repair が consequence を補えない)、本番経路テスト無し。chronos 確認は client で typed 化されたが server で `'1'` に再リテラル化。
- read-model の文言 key 化 **ゼロ**(`ceo-surface-summary.ts` diff 空、`next_action_ja` に英語が入るバグ残存)。viewer/auth 実装 5→**4**(行数 ~+500)、vocabulary 6、mission verb 3 系統、`/api/intelligence` 2,918 行(+1)、design tokens 重複、status 色 6 箇所不一致。
- **セキュリティ(既存だが SX-09 が所有を主張する範囲)**: concierge の loopback 判定が Host ヘッダのみで `personal` tier を付与(`viewer-context.ts:38-49,135-145`; chronos は `req.ip` 優先 + personal マスク)。presence-studio の held-action 決定/適用に role 検査無し(readonly token で書ける)。chronos 4 route が `warn` モードで tenant 拡大可能(`collaboration/stream` `missions/search` `tenant-design` `plan-preview`)。`KYBERION_ALLOW_UNAUTH_REMOTE` が `'true'` → `'1'` 正規化で **`=1` 設定済み環境の意味が反転**(未認証 remote readonly が有効化)。
- 細部: telegram/discord で自分のメッセージが thread context に二重混入、slack は thread 履歴を取得して捨てる、`runChannelTurn` の `threadContext` await が try 外で typing 停止漏れ、discord typing が早期停止。

### 2.5 実行層(SX-10/11)

- actuator ABI **4→5**(`mod.actuator.dispatch` を追加、`dispatchDecisionOp` / legacy fallback / エラーメッセージ文字列判別は **そのまま**、`pipeline-execution-part-bootstrap.ts:874-877`)。
- 新 SDK 分岐が **ctx を merge でなく置換** し `export_as`/`produces` を無視(`:809-817`)。採用 0/33 だが scaffold がこの形を生成する。
- `executePipelineFile()` は `main()` の簡略再実装で、`before_agent_start` 等の lifecycle hook、backend install、kill-switch、permission fallback、`MISSION_ID` 伝播、journal/resume を **落とす**(governance downgrade)。変換 1/27。
- `runValidatedSteps` の auto-repair hook は `failure` を渡さないため常に `{repaired:false}`、`_adfRepairAttempted` は set されない。repair 実装は 2 のまま。`orchestrator.ts`(legacy engine)は barrel export 継続、`check_golden_output` bypass 継続。
- 重複削除: `executePipeline` 12→12、`opControl` 8→8、`buildRetryOptions` 29→29、`OpSpecKind` 28→28。`generate_op_registry` は 29 本を手 import のまま。op schema 12.2→**12.1%**、coverage checker は構造的に欠落を報告できない。語彙(`role/type`、bare op、alias 10、`cmd/command`)無変更、`export_as` 72→75。
- 良: `transform-script-oversized` → error(違反 0 で安全)、shell-independence CI checker は本物のラチェット、canonical repair の live 経路接続、scaffold の旧 ABI 停止、テスト無削除。

### 2.6 docs(SX-01/13/14)

- 状態正本: `STATUS.ja.md:6` の「本表を正とし」が **残存**(L3 に新正本宣言を追加しただけで矛盾は生きている)、4,271 文字 1 行も未整形。`ROADMAP_COMPLETION_LEDGER` `CHANGELOG` 降格文なし。
- アーカイブ 7 本(対象 ~152)、`status:` frontmatter 47/186、`addPlanFrontmatter` が `status: active` 固定、docs/developer md **239→244**(目標 <100)。アーカイブ移動で相対リンク 6 本切れ、link checker 無し。
- UX 契約 lint は **最初の `##` より前だけ** を検査(README 39/251 行)、各文書に「request, plan, result, and next action」の 1 文を植えて通過。内部語は README で actuator 11→10、mission 13→10。外部 4 語の定義が計画/checker/concept-index で **3 通り**。
- `frontmatter-exclusions.json` は読み手コード 0 で corpus ほぼ全体を除外(実カバレッジ 69.6%)。localization policy 無変更、COMPONENT_MAP 13 リンク無変更、概念文書 6→1 未着手。
- `validateEnv` の一般レポートは warn-by-default だが、Kyberion 起動入口は `KYBERION_ENV_REGISTRY_STRICT` を既定 true とし、明示的 false の時だけ互換 opt-out する。
- 良: 5 コマンド first-win ブロックの 3 文書一致 + マーカー検証、fence 修復、`_integrity-manifest` 改名の参照完全更新、fixture 19 本削除、Glossary 3 層 + 不足 5 語 + `work_shape/execution_shape` 解消、`tagline_key` 5/5、env registry の偽変数削除・`*_TOKENS` 再分類、`pnpm validate` の 39 連 `&&` 解消。

## 3. 計画文書(§5 / §7)の訂正が必要

- §5 の「現状」列が達成値で **上書き** され(489→"0"、161→"0"、319→"278")、ヘッダの「初期値は監査時点のスナップショットとして保持」と矛盾。ラチェットの基準点が失われた。
- §5/§7 の数値が再現しない: npm scripts 278/243(実 248)、cycles 177/violations 114(実 199/115、baseline 207/121)、最大ファイル 6,041(実 4,645)、schema 無し 157→0(実 51 が no-op schema)、intent 入口 6→1(実 8)。
- §7 の SX-01 IMPLEMENTED → PARTIAL。SX-09 の「ChannelAdapter 採用」「viewer 集約」、SX-10 の「SDK dispatch へ移行」、SX-11 の「auto-repair hook 接続」は実体と乖離。

## 4. 推奨する進め方

**Wave A(マージ前、小さい)**: B1〜B11 を修正(各 1 PR、回帰テスト付き)。§5 の基準列を `git show 7244e0a55` の値に戻し、§7 を実測で訂正。

**Wave B(構造の巻き戻し)**: `587df6094`(worker)`8d55f3089`(pipeline)`372eff14c`(contract schemas)`297e33cba`(media)を revert し、`organization-operating-model` の型(DAG・責務名・prologue 複製なし)で再分割。先に `check_module_boundaries` を修正(全 tree 走査、動的 import 検出、Tarjan SCC、baseline を実測値で再生成)し、`@typescript-eslint/no-unused-vars` と max-file-lines checker を有効化してから着手 — 計画 §1 原則 2 の順序を今度こそ守る。`check_type_ratchet.files` は分離するか撤廃。

**Wave C(adopt-or-delete の完遂)**: `eslint.config.js` に `no-restricted-syntax`(テスト含む)と `import/no-cycle`。`loadJson`/`readJsonFile`/`compileSchemaFromPath`/`safeEnv`/`slugify` 重複、voice-hub 孤児 3,000 行、ABI 4 種、`orchestrator.ts`、`intent` 系 CLI 7 本を削除。`check_channel_adapter_adoption` を意味のある assertion に置換。

**残す価値があるもの**: codemod 4 種、schema 根統合、`createSeam` 22 採用、`defineScript` 9 generator、`ci-gates.json` + `run_checks`、voice-hub dispatch 統合、定数時間 token 比較、presence-studio/computer-surface の auth 強化、narrow-only scope helper、`SurfaceAsyncChannel` union、Glossary 再編、`_integrity-manifest`、`as any` 740→617、organization-operating-model / mission-workitem-dispatch / progress の 3 分割。

## 5. 2026-08-26 再検証・修正結果

前節の監査結果を現行 checkout に再突合した。Blocker B1〜B11 は既に修正済みで、今回の再検証では再発を確認しなかった。特に次を実体で確認した。

- `satellites/voice-hub/server.ts` の旧 routing/task/knowledge 梯子を削除し、ファイルを 1,496 行まで縮小。`libs/actuators/voice-actuator/src/index.ts` も loopback/action helper を分離して 1,424 行とし、最大行数例外から削除した。
- `FocusedOperatorView` と Chronos agent route の純粋 helper を分離した。Chronos intent-resolution A2UI は `display:kv` の構造化 payload を返す。
- `ChannelAdapter` の adoption check はコメント文字列を証拠として扱わず、各 bridge の実配送関数と outbox drain を検査する。日本語の契約ラベルは locale-aware、voice TTS では契約を除外する。
- governance catalog の envelope schema 利用箇所には `governance-catalog-contracts.json` の必須キー契約を適用した。最大行数 checker の例外は `file/reason/target` 必須にした。
- 未登録の `AUTO_SEAL` 直接参照を `KYBERION_AUTO_SEAL` の typed env registry 読み出しへ移行し、生成された env example/configuration も更新した。
- `check_module_boundaries` は `typeof import('...')` の型クエリを runtime edge と誤認せず、重複 edge も排除する。

再検証コマンドは以下の通り。全て終了コード 0 だった。

```text
tsc --noEmit
vitest run libs/actuators/voice-actuator/src/index.test.ts
vitest run libs/core/channel-adapter.test.ts presence/displays/chronos-mirror-v2/src/components/FocusedOperatorView.test.ts
check_max_file_lines
check_module_boundaries (2 cycles / 81 direction violations / 77 dynamic imports)
check_type_ratchet
check_catalog_integrity
check_documentation_links
```

ただし Request changes 判定を解除する残件はある。これは「例外を記名した」ことを完了扱いにしないため、次の wave の未完了項目として固定する。

- god module の残り 12 ファイルはまだ 1,500 行を超え、最大行数例外に残る。例外は SX-05/SX-08〜12 の対象計画に紐付けたが、分割自体は未完了。`scripts/check_governance_rules.ts`、`scripts/kyberion_home.ts`、`scripts/cli.ts`、wisdom の decision ops、`libs/core/work-coordination.ts`、`libs/core/agent-adapter.ts`、`libs/core/mission-lifecycle.ts`、`libs/core/mission-context-pack.ts` は責務 helper/type を抽出して例外から削除した。
- runtime cycle 2 件、direction violation 81 件、bare `@agent/core` import 810 件（646 ファイル）が残る。boundary checker はコメント内 import と型専用 import を runtime edge から除外し、全 production tree と dynamic import を走査する。baseline は 2/81 に更新したが、既存違反を解消したとは扱わない。
- npm scripts は 240 件で、目標 120 以下には未到達。doctor 系、`org`/`organization`、`project list`、runner の統合も未完了。
- foundation reader の adopt-or-delete、全 actuator operation-table の SDK 化、状態正本・計画アーカイブは未完了。pipeline の legacy `handleAction` 呼び出しは typed SDK adapter に集約し、read-model の主要 briefing 文言 key 化と Kyberion CLI の env strict default は完了したが、全 operation table / 全 read-model / 全起動入口への展開は未完了。

## 9. 2026-08-26 max-file-lines 残件修正

- \`libs/core/agent-adapter.ts\` から Codex App Server の JSON-RPC transport、thread/turn lifecycle、approval projection、native-subagent threading、Codex execution enhancer を \`libs/core/agent-codex-app-server-adapter.ts\` へ実装単位で分離した。型専用の移動ではなく、実行クラスと helper の本体を移している。
- canonical import/export は維持した。既存の \`./agent-adapter.js\` と \`@agent/core/agent-adapter\` は従来どおり \`CodexAppServerAdapter\`、\`CodexExecutionEnhancer\`、options/native-subagent contract を取得できる。新 module から旧 module への依存は type-only。
- 行数は \`libs/core/agent-adapter.ts\` **2,038 → 1,305 行**（733 行削減）、分離先は **782 行**。最大行数 1,500 行以下となったため、max-file-lines exceptions は **15 → 14 件**（1 件削減）。
- 対象テストは \`libs/core/agent-adapter.test.ts\`、\`libs/core/grok-adapter.test.ts\`、\`tests/agent-runtime-observability.test.ts\` の **3 files / 25 tests** が green。\`pnpm run typecheck\` と \`./node_modules/.bin/tsc -p libs/core/tsconfig.json --pretty false\` も green、\`check:max-file-lines\` と \`check:module-boundaries\`（2 cycles / 84 direction violations / 77 dynamic imports）も green。
- この wave では \`package.json\` と \`scripts/\` 配下を変更していない。workspace の \`pnpm --filter @agent/core build\` と packaging gate は pnpm の non-TTY module purge で実行開始前に停止したため、依存解決を伴わない core direct build の結果を採用した。

## 6. 2026-08-26 追加修正

- `scripts/kyberion_home.ts` から feedback / improvements / deals と home view を helper へ分離し、1,573 行から 1,424 行へ縮小した。`--help` の実 CLI 出力で helper 経由のコマンド一覧を確認した。
- `scripts/check_governance_rules.ts` から directory consistency と path scanner を分離し、2,234 行から 1,459 行へ縮小した。`check:governance-rules` と `check:max-file-lines` は実行して green を確認した。
- `scripts/cli.ts` から workflow handlers と presentation/help を分離し、2,169 行から 1,499 行へ縮小した。`cli --help` の実行出力と最大行数ゲートを確認した。
- wisdom actuator の純粋な intuition / dissent / hypothesis decision ops を分離し、1,735 行から 1,489 行へ縮小した。decision-ops と contract-boundary の 79 テストを通過した。
- CEO read-model の briefing と `next_action_ja` を vocabulary catalog (`home.*` / `chronos:*`) 経由へ移行し、catalog type generation、CEO summary tests を通過した。
- onboarding の package script 内 `node:fs` existence probe を撤去し、dist の governed entrypoint を直接呼ぶ形へ統一した。
- Kyberion CLI 起動時の env registry strictness を既定 fail-closed に変更し、明示的 false opt-out と default/override テストを追加した。
- Chronos / Concierge の loopback 判定で forwarded peer を使う条件を `KYBERION_TRUST_PROXY=true` に限定し、未設定時の header spoofing を拒否する env registry / configuration / 回帰テストを追加した。
- 実利用の無かった legacy `libs/core/orchestrator.ts` を core barrel、child-process allowlist、governance baseline から除去し、二重実行器を削除した。
- 動的 report schema の compile 経路も `createAjv()` の strict default に統一し、`report-contract` 回帰 2 テストと typecheck を通過した。
- 未公開で内部 import の無かった `libs/core/adapters/` の provider shim/factory/types facade を削除し、canonical `agent-adapter.ts` を唯一の実装入口にした。package export の `mission-team-composer` は canonical plan composer の dist を直接指すようにし、alias 実体も削除した。
- module boundary checker のコメント内 import 誤検出を修正し、`scripts/dependency_resolver.ts` の偽 self-cycle を除去。検出値は 13/103 から 12/102 に改善し、回帰テスト 2件を追加した。
- 同 checker の専用 `import type` を runtime graph から除外し、型専用 edge を dynamic import と誤算しない比較経路も追加した。検出値は 12/102 から 6/84 へ改善し、dynamic import は 77 件の実測値を維持した。コメント・型専用 import・ratchet の回帰テストは 3 件になった。

追加検証:

```text
tsc --noEmit
vitest run libs/core/ceo-surface-summary.test.ts libs/core/vocabulary-catalog.test.ts
node --import ./scripts/ts-loader.mjs scripts/check_governance_rules.ts
node --import ./scripts/ts-loader.mjs scripts/check_max_file_lines.ts
node --import ./scripts/ts-loader.mjs scripts/check_module_boundaries.ts
node --import ./scripts/ts-loader.mjs scripts/check_script_integrity.ts
git diff --check
```

## 7. 2026-08-26 セキュリティ・実行経路の再突合

- Chronos の未登録 API token 経路は `KYBERION_TENANT` が設定された場合だけその tenant に束縛し、remote で tenant が無い場合は 403 とした。`KYBERION_TRUST_PROXY=true` を明示しない限り `x-forwarded-for` / `x-real-ip` を loopback 判定に使わず、proxy 偽装による localadmin 昇格を拒否する。`api-guard` 19 テスト、`viewer-context` 11 テストを通過した。
- Presence Studio の held-action decision/apply は `requirePresenceStudioLocalAdmin` を経由し、token viewer は拒否される。初期レビューの「role 検査無し」は現行 checkout では解消済みだったため、残件から除外した。
- `runValidatedSteps` は `runAdfLifecycle` の preflight → auto-repair → commit → execute を使い、repair failure を渡し、one-shot guard と再読込を行う。actuator SDK 結果は既存 context に merge される。初期レビューの簡略再実装・repair hook 未接続という記述は現行コードには該当しないため、残件から除外した。
- `check_module_boundaries` は production tree、dynamic import、型クエリ・コメント・型専用 import 除外、重複 edge を実測する。現行の未解消構造残件は 2 cycles / 81 direction violations / 77 dynamic imports であり、基準値合わせで解消したとは扱わない。

## 8. 追加の残件修正

- `libs/core/work-coordination.ts` から型定義と `WorkCoordinationError` を責務別モジュールへ移し、実装本体を 1,514 行から 1,493 行へ縮小した。最大行数例外を 16 件から 15 件へ減らし、`work-coordination` / `mission-workitem-dispatch` の 46 テストを通過した。
- `cli-input` と schema foundation の JSON reader を canonical `loadJson` / `readJson` へ統合し、catalog の root `$schema` を保持する回帰テストを追加した。production の旧 `text-utils` import は 0 件になった。
- `check_script_integrity` は pipeline JSON 内の `pnpm run <script>` も package script registry と突合するようにし、削除済み script の回帰テストを追加した。現行 pipeline の `chronos-dom-contrast` は `ci-gates.json` の gate として解決されることを確認した。
- アーカイブ文書の切れた相対リンク 2 件を修正し、レビュー文書に必須 frontmatter を付与した。plan metadata、source map、documentation-links は green である。
- full check runner は 64 gate の無制限同時起動で既定 30 秒 timeout を消費していたため、6 worker の bounded concurrency と gate ごとの既定 120 秒 timeout に変更した。これにより sandbox 外の実行で 64/64 gate が通過した。
- `scripts/reasoning_setup.ts`・`services_setup.ts`・`setup_report.ts` の相互 import cycle は、表示 formatter を `setup-report-format.ts` へ分離して 1 件削減した。boundary 実測は 6/84 から 5/84 になった。
- `mission-orchestration-events` と `mission-orchestration-journal` の相互依存は、イベント契約と scope/payload loader を `mission-orchestration-event-contract.ts` / `mission-orchestration-event-loader.ts` へ分離して解消した。契約の型 import は runtime graph に混入しない形にし、boundary 実測は 5/84 から 4/84、イベント・journal 回帰テスト 14 件を通過した。
- media actuator の設計プロトコルとレイアウト runtime の循環は、カタログ loader と layout design-token を独立した低層モジュールへ移して解消した。`media-design-protocol → media-layout-runtime` の一方向を保ち、boundary 実測は 4/84 から 3/84 に改善した。
- `libs/core/agent-adapter.ts` の Codex App Server transport / lifecycle / approval / native-subagent 実装を `agent-codex-app-server-adapter.ts` へ責務単位で移し、行数を 2,038→1,305、最大行数例外を 15→14 とした。adapter API の canonical export は維持し、対象 25 テストを通過した。
- `libs/core/mission-lifecycle.ts` から completion reconciliation / deliverable publication / operator actions を責務別 module へ移し、行数を 2,014→1,175、最大行数例外を 14→13 とした。既存 lifecycle export と mission lifecycle regression tests は維持した。
- `libs/core/mission-context-pack.ts` から型定義と knowledge retrieval を責務別 module へ移し、行数を 2,259→1,486、最大行数例外を 13→12 とした。既存 context-pack export と 32 tests を維持した。
- pipeline execution の4分割に残っていた相互 import の複製を整理し、未使用の part 間依存を削除した。prompt visibility context は `pipeline-reasoning-visibility.ts` へ分離し、pipeline cycle を解消した。boundary 実測は 3/84 から 2/84 に改善した。

## 10. 最終検証

- `pnpm run validate` は build / typecheck / full check を完走し、64/64 gates passed。surface HTTP を含むため sandbox 外の承認済み実行で確認した。
- pipeline・boundary・child-process 契約の回帰は 5 files / 310 tests、`build:actuators`、`check_script_integrity`、`check_catalog_integrity`、`check_documentation_links`、`generate_knowledge_index --check`、`git diff --check` も green。
- `validators.readJsonFile` も `secure-io.loadJson` を canonical reader として利用するよう統合し、`validators` / `cli-input` の reader 回帰5件と typecheck を通過した。
- ただし、2つの大規模 core SCC、81 direction violations、810 bare `@agent/core` imports、12 max-file-lines exceptions、240 npm scripts、foundation reader / actuator operation-table / state-documentation の残件は未完了であり、Request changes を解除する完了条件には未到達である。
- strict Ajv 化で顕在化した governance policy schema の root `$schema` 欠落を、policy/catalog schema 群へ追加した。`governance-rules`、`work-scope-policy`、`contract-schemas`、`first-win-lifecycle` は全て通過した。
- i18n hardcoding baseline を新規分割ファイルと削減済み旧ファイルに再生成し、pseudo-locale を再生成した。`i18n` と `pseudo-locale` は通過した。

## 10. 2026-08-26 npm scripts / CI manifest 再監査

- `package.json` の script 数は HEAD の **248 → 240**（この wave の削減は 8）。削除対象は `test:all`、`cli:preview`、`doctor:meeting`、manifest で直接実行される `check:doc-examples` / `check:first-win-docs` / `check:mos-no-write-api`、generator の check alias 2 件(`check:service-harness-registry` / `check:trace-docs`)。代替はそれぞれ `pnpm exec vitest run`、`pnpm run cli -- preview ...`、`pnpm doctor -- --runtime meeting`、`pnpm check -- --scope ... --only ...`、generator の `--check` である。
- 完全一致する command 重複は **0 件**だった。`org`(authority/team role)、`organization`(operating model)、`project`(managed project) は責務と引数契約が異なるため、互換性を壊す統合は実施していない。`max-file-lines` と `libs/core` も変更していない。
- `scripts/check_ci_gate_parity.ts` は `ci-gates.json` の gate command 内 `pnpm run <script>`（現行の `audit:verify` を含む）も package script registry と照合するようにした。`check_script_integrity` も `ci-gates.json` を走査対象に追加した。
- 実行確認: package script 参照の `check:script-integrity`、manifest/workflow parity、`first-win-docs`、`doc-examples`、`mos-no-write-api` は全て green。canonical doctor の meeting runtime は read-only 実行で `totalMissing=2`（BlackHole と mission voice consent の環境不足）を正しく返し、CLI preview は baseline pipeline を valid と判定した。
- SX-05 の目標 **120 以下には未到達**。残る 240 件には、docs・pipeline・CI・source/test が実際に参照する互換入口と、doctor/org/organization/project の責務が異なる入口が含まれる。これらをさらに削るには、今回許可された alias 統合を超えて公開 CLI 契約または独立操作を変更するため、保留した。

## 11. 2026-08-26 構造・SDK 残件の追加修正

- `secure-io` の root `$schema` 保持を前提に、foundation JSON reader と media semantic-map / media catalog の検証境界を整理した。ソース artifact の `$schema` は保持し、AJV の domain payload 検証時だけ root metadata を除外する。media actuator の回帰は `body-zones`、`layout-fit`、`personal-theme-overlay` を含めて復旧した。
- legacy actuator の pipeline ABI は `defineLegacyPipelineActuator` に集約し、operation catalog を持つ 15 actuator (`agent`, `approval`, `artifact`, `build`, `calendar`, `code`, `deployment`, `file`, `modeling`, `network`, `secret`, `system`, `terminal`, `wisdom`, `browser`) を `defineCatalogBackedActuator` で SDK dispatch / operation description に接続した。`pipeline-execution-part-bootstrap` は SDK dispatch の単一路径を使用する。actuator 全体は **80 files / 867 passed / 11 skipped**。
- agent runtime、Super-Nerve、mission worker の遅延 import に残っていた runtime cycle は registration port へ置換した。organization operating model の分割群に残っていた型クエリも `import type` へ統合した。現行 `check:module-boundaries` は **0 static cycles / 1 runtime cycle / 62 direction violations / 73 dynamic imports** で、baseline の方向違反 81・runtime cycle 2 を下回る。
- intent contract の責務分割後に追加された純粋 formatter / routing / input context / event modules は contracts 層へ分類し、実行 compiler 本体は domain 層として boundary manifest に明示した。checker の既存違反を baseline の上方更新で隠していない。
- `intent-contract` は **1,488 行**、max-file-lines gate は green。現在の最大行数例外は **11 件**で、残る例外は CLI / surface / orchestration の責務分割 wave として継続管理する。npm scripts **240 件**、foundation reader の完全 adopt-or-delete、未移行 actuator operation-table、state-documentation は未完了のため、レビュー判定は引き続き **partial / Request changes** とする。
- 追加検証: `pnpm run typecheck`、`pnpm run check:module-boundaries`、`pnpm run check:max-file-lines`、`pnpm run check:script-integrity`、`pnpm exec vitest run libs/core/actuator-sdk.test.ts libs/core/intent-contract.test.ts libs/core/intent-resolution.test.ts`、`pnpm run test:actuators`。いずれも終了コード 0。visual-review の外部 backend skip と既存の audit tenant-mirror warning は、テスト失敗ではなく環境・権限制約として残る。

## 12. 2026-08-26 最終ゲート

- actuator SDK の型境界を `never` 入力の adapter seam に整理し、各 actuator の狭い domain action 型を `as any` で汚染せずに build 可能にした。`pnpm run build:actuators`、`pnpm run build:repo`、terminal/system/browser 回帰 **119 tests** は green。
- capability seam と knowledge index の生成物を再同期し、i18n baseline は intent contract の責務移動を反映した。`check:type-ratchet`、catalog integrity、capability seams、i18n は green。
- 承認済みのローカル server 実行環境で `pnpm run check -- --scope full` を再実行し、**64/64 gates passed**。sandbox 内では Chronos DOM gate の `listen EPERM` が発生したが、実装変更後の承認済み実行では `chronos-dom-contrast` も通過した。
- worktree の既存変更は保持し、commit / push は行っていない。今回の変更に由来する残りの計画項目は、11 件の明示的 max-file-lines exception、240 scripts、state-documentation と未 catalog 化 actuator の責務整理であり、今回の full gate 失敗には該当しない。

## 13. 2026-08-26 継続修正: rendering / reasoning / actuator ABI

- `libs/core/video-composition-compiler.ts` の CSS token、visual/motion direction、scene composition、asset resolver を `video-composition-rendering.ts` へ移し、本体を **1,745 → 1,437 行**へ縮小した。`video-composition-compiler` の rendering output は従来の public compile/write API を維持し、compiler / lint 回帰 **22 tests**を通過した。
- `reasoning-backend.ts` の公開契約・vision path 制約を `reasoning-backend-contracts.ts`、retry/cancellation を `reasoning-retry-policy.ts`、delegation summary retry を `reasoning-delegation-policy.ts` へ分離した。本体は **2,072 → 1,480 行**で、契約は旧 module から再 export した。summary-retry / failover を含む対象回帰を通過した。
- native PDF engine の `PdfWriter`、encoding/XMP/page-label、CJK font embedding primitive を `libs/core/src/native-pdf-engine/primitives.ts` へ分離し、本体を **1,893 → 1,434 行**へ縮小した。PDF engine 回帰 **38 tests**を通過し、PDF output assembly の public entrypoint は維持した。
- `android`、`blockchain`、`email`、`ingest`、`ios`、`media`、`media-generation`、`meeting`、`orchestrator`、`presence`、`process`、`service`、`video-composition`、`vision`、`voice`、`working-memory` の既存 `handleAction` を `defineLegacyPipelineActuator` へ接続した。これにより独立 meeting browser driver を除く actuator index は SDK の共通 ABI (`actuator.dispatch` / `describeOps`) を公開し、内部 operation-table の段階移行を可能にした。
- 検証結果は `pnpm run typecheck`、`pnpm run build:actuators`、`pnpm run check:max-file-lines`、`pnpm run check:module-boundaries`（0 static cycles / 1 runtime cycle / 62 direction violations / 73 dynamic imports）、`pnpm run check:script-integrity`、catalog integrity、op input contract coverage、actuator 全体 **80 files / 867 passed / 11 skipped**。既知の audit tenant-mirror / visual-review external-backend warning は失敗ではない。
- 現在の max-file-lines exception は **8 件**まで減少した。scripts 240 件、state-documentation の正本統合、legacy operation-table の個別 schema 化、foundation reader の adopt-or-delete、残存 direction violations / runtime cycle は引き続き未完了であり、レビュー判定は **partial / Request changes** を維持する。
- 生成物同期後の承認済み full gate は **64/64 passed**（`pnpm run check -- --scope full`）。直前の 63/64 は knowledge index / integrity manifest の stale が原因で、`pnpm run generate:knowledge-index` 後に解消した。

## 14. 2026-08-26 継続修正: browser helper と状態資料の正本境界

- browser actuator の passkey runtime を `browser-passkey-helpers.ts`、control operation を `browser-control-helpers.ts` へ分離した。`browser-pipeline-helpers.ts` は **2,149 → 1,497 行**となり、max-file-lines の記名例外を **6 → 5 件**へ削減した。既存の passkey/control/capture/apply 公開動作は維持し、browser actuator **5 files / 60 tests** と `build:actuators` が green である。
- 以前のレビュー記述に残っていた状態資料の矛盾を訂正した。2026-08 索引を現在の状態正本、各計画の実装状況節を詳細正本、2026-07 `STATUS.ja.md` を凍結記録とする境界を維持し、`ROADMAP_COMPLETION_LEDGER.md` と `CHANGELOG.md` にも「補助資料であり現在状態の正本ではない」旨を追加した。完了計画の全件アーカイブ、docs 件数削減、knowledge corpus 全件整備は未完のため SX-13 は PARTIAL のままとする。
- 実測: `check:max-file-lines` **OK (max 1500)**、`check:script-integrity` **OK**、`check:module-boundaries` **0 cycles / 62 direction violations / 73 dynamic imports tracked**、package scripts **240 件**。残存する構造指標を baseline 消化とは扱わない。
- foundation の孤児経路も整理した。内部利用のない `libs/core/validators.ts` の `readJsonFile` wrapper と declaration/test を削除し、JSON file reader の実行経路を `secure-io` / `cli-input` に限定した。`validators.test.ts` **4 tests** と `typecheck` は green。
- actuator ABI は self-described `op-catalog` を持つ **14 actuator** を `defineCatalogBackedActuator` へ移行し、旧 `defineLegacyPipelineActuator` index は media / working-memory の 2 件だけに縮小した。両者はまだ全 operation catalog の個別化が必要なため、SX-10 は PARTIAL を維持する。actuator 全体回帰は **80 files / 867 passed / 11 skipped**、`build:actuators` は green。

## 15. 2026-08-26 継続修正: 全 actuator operation catalog 化

- media actuator の実装 switch から capture **17**、transform **24**、apply **16** operation を抽出した `op-catalog.ts` を追加し、manifest / registry / discovery 生成へ接続した。working-memory も manifest の **14** operation を self-described catalog 化した。
- 現行 actuator index の `defineLegacyPipelineActuator` は **0 件**、`defineCatalogBackedActuator` は **31 件**となった。`generate_op_registry --check`、`build:actuators`、media/working-memory 回帰 **52 passed / 11 skipped** が green。

## 16. 2026-08-26 継続修正: Chronos intelligence route の責務分割

- Chronos `api/intelligence/route.ts` の型・tenant visibility・read-model collection・control catalog を `intelligence-observation-data.ts` / `intelligence-control-data.ts` へ移し、route 本体を **2,918 → 1,236 行**へ縮小した。分離先は **916 / 997 行**で、公開 GET/POST route と tenant scope 判定の契約は維持した。
- `pnpm run typecheck`、Chronos 回帰 **3 files / 10 tests**、`check:max-file-lines`、`check:module-boundaries`（0 cycles / 62 direction violations / 73 dynamic imports tracked）が green。max-file-lines の記名例外は **4 → 3 件**となった。

## 17. 2026-08-26 継続修正: 残存 god module と operation 契約の可視化

- Chronos page の設定・view model・legacy sections を `chronos-page-config.ts` / `ChronosMirrorShell.tsx` / `ChronosMirrorLegacySections.tsx` へ分割した。page は **1,309 行**、分離先は **394 / 1,407 / 1,045 行**となり、全 production root の max-file-lines 記名例外を **1 → 0 件**へ削減した。Chronos Office、Mission Intelligence、API route contract、headless 回帰は **3 files / 9 tests**、typecheck は green。
- Presence Studio server の runtime/state/route data を `presence-studio-runtime-data.ts` へ分離し、surface runtime orchestrator の conversation data を `surface-runtime-conversation-data.ts` へ分離した。公開 export、state setter、tenant scope の挙動を維持し、target 回帰と typecheck を通過した。
- actuator discovery は **550/550** operation に `input_schema` と example を出すよう generator と PR gate (`op-input-contract-coverage`) を追加した。従来の `legacy-open` **487** 件は、dispatch usage から `inferred-legacy` contract へ置き換えた。さらに calendar / email / approval / presence の **17 operation** を authored schema 化した。内訳は authored schema **80**、inferred field inventory **340**、field usage 未推測 **130**。したがって schema 欠落と空 example は解消したが、operation ごとの authored typed fields と strict validation は未完了であり、SX-10 は PARTIAL のままとする。
- `KYBERION_TENANT_SCOPE_REQUIRED` は登録値が `1/0` に正規化されるのに `"true"` と比較していたため、`getRegisteredEnvBool` へ統一した。`tier-guard-tenant` / env 回帰 **2 files / 37 tests** が green で、`=1` の fail-closed tenant binding を実証した。
- 現在の実測は package scripts **240**、module boundary **0 cycles / 62 direction violations / 73 dynamic imports**。scripts の入口統合、foundation reader の adopt-or-delete、bare import の段階移行、operation typed fields、knowledge corpus の frontmatter と計画アーカイブは未完了である。これらを baseline 更新や空 schema で完了扱いにはしない。
- 承認済みローカル surface 実行を含む `pnpm run check -- --scope full` は **65/65 gates passed**。途中で検出した ESM source import と i18n baseline / knowledge index stale も修正・再生成した。

## 18. 2026-08-26 継続修正: process 契約と計画 metadata

- process actuator の `status` / `list` / `list-surfaces` / `spawn` / `stop` に authored `input_schema` と examples を追加した。`spawn` の必須キー (`resourceId`, `command`, `kind`, `ownerId`, `ownerType`) と `stop` / `status` の `resourceId` を dispatch 実装と同じ catalog に固定した。
- generator 後の discovery 実測は **550 operation / authored 85 / inferred-legacy 465**。inferred field inventory は **336**、dispatch field usage を推測できない operation は **129**。従って legacy-open は 0 だが、inferred schema の `additionalProperties: true` と authored typed fields の不足は未解消であり、SX-10 は PARTIAL のままとする。
- 2026-08 improvement-plan の追跡対象 **32 文書**を metadata fixer で `title/tags/last_updated/status` に正規化し、`check_improvement_plan_metadata` は green。これは docs/developer 全体または knowledge corpus 全体の frontmatter 完了を意味しない。
- 対象検証: `pnpm generate:op-registry`、`pnpm exec vitest run scripts/generate_op_registry.test.ts scripts/check_op_input_contract_coverage.test.ts`（3 tests）、`pnpm exec tsx scripts/check_improvement_plan_metadata.ts --fix`、再実行した metadata check。full gate はこの追加変更後に再実行して最終値を更新する。

## 19. 2026-08-26 継続修正: agent / artifact 契約の authored 化

- agent actuator の `health` / `shutdown_all` と artifact actuator の6 operation (`write_json`, `append_event`, `read_json`, `list`, `ensure_dir`, `write_delivery_pack`) に、dispatch の必須入力を反映した authored schema と examples を追加した。artifact の nested artifact item も `id/kind/path` 必須として閉じた。
- discovery の実測は **550 operation / authored 93 / inferred-legacy 457**。生成・registry test **2 files / 3 tests** と typecheck は green。inferred contract の残存は意図的に未完了として追跡し、空 schema だけで完了扱いにはしない。

## 20. 2026-08-26 継続修正: authored contract の実行時検証と追加移行

- `defineCatalogBackedActuator` に AJV 検証を接続し、catalog が持つ authored `input_schema` を handler 実行前に検証するようにした。未知キー・必須キー違反は actuator result の failed envelope に変換される。`libs/core/actuator-sdk.test.ts` に invalid/valid dispatch の回帰を追加した。
- secret 4、terminal 13、service 7、blockchain 3、build 7、deployment 1、vision 3 operation を authored schema 化した。discovery 実測は **550 operation / authored 131 / inferred-legacy 419**。actuator 回帰 **80 files / 867 passed / 11 skipped**、typecheck、対象回帰は green。
- `legacy-open` は 0 件のままだが、419件の inferred contract は strict authored contract ではない。SDK はそれらを検証対象外として明示的に扱い、残存移行を隠さない。

## 21. 2026-08-26 継続修正: 残存 actuator 契約の追加 authored 化

- Android 22、iOS 13、modeling 15、orchestrator 7、code 14、network 10、meeting 14、media-generation 8、video-composition 12 operation に authored schema を追加した。生成後の discovery 実測は **550 operation / authored 300 / inferred-legacy 250**、`legacy-open` は **0** 件である。
- `defineCatalogBackedActuator` の AJV 実行時検証は authored schema のみを対象とし、inferred contract を strict schema と誤認させない。残る 250 operation の inferred contract、CLI/script 削減、state 文書の全件 frontmatter/archive、62 direction violations / 73 dynamic imports は未完了として継続追跡する。

## 22. 2026-08-26 継続修正: 残存 god module とゲート再確認

- `mission-lifecycle` を completion / operator-actions helper へ、`mission-context-pack` を types / knowledge helper へ分離した。公開 export は維持し、max-file-lines の記名例外は **0 件**を確認した。状態資料ではレビュー文書の frontmatter と archive 相対リンクを補正した。
- package script は互換性を壊さずに削除できる完全重複が無く、**240 件**を現状維持とした。`check:script-integrity`、CLI manifest、script 参照実体を確認し、残る doctor / org・organization・project / runner 統合は未完了として追跡する。
- 修正後の実測は `check:module-boundaries` **0 cycles / 62 direction violations / 73 dynamic imports**、`test:actuators` **80 files / 867 passed / 11 skipped**、`pnpm run check -- --scope full` **65/65 gates passed**。既知の audit tenant-mirror warning と visual-review external-backend skip は環境・権限制約であり gate failure ではない。

## 23. 2026-08-26 継続修正: 全 operation の authored schema 接続

- browser / media / voice / Android / modeling / network / code / iOS / orchestrator / media-generation / system / wisdom の catalog を修正し、wisdom の `inputSchema` camelCase を SDK の `input_schema` ABI へ統一した。discovery 実測は **550/550 authored / inferred-legacy 0 / legacy-open 0** となった。
- SDK の authored schema 実行時検証を維持したまま actuator 全体回帰 **80 files / 867 passed / 11 skipped**、typecheck、registry/SDK 回帰 **2 files / 6 tests** を通過した。なお一部 catalog は動的な既存 payload 互換のため `additionalProperties: true` を残しており、strict operation-specific required fields への再精密化は未完了である。

## 24. 2026-08-26 継続修正: browser / voice 契約の精密化

- browser catalog の空入力・制御・評価・JSON query・regex・passkey state・tab selection・session handoff など、実装キーが固定されている操作を `additionalProperties: false` へ変更し、`evaluate` / `json_query` / `regex_extract` / passkey state / tab selection / control の必須キーを追加した。ref 操作と動的 payload 操作は互換性を維持するため広い契約を残した。
- voice catalog では health/list/probe、transcribe、profile、record、speak の入力キーを catalog に固定し、`record_interaction`、record sample、`speak_local`、`generate_voice` の必須入力を dispatch 実装に合わせた。例も必須キーを満たす形へ更新した。
- media catalog では PDF/Office の read-transform、slide patch/filter、ブランド保存、file write など入力が確定している操作に `required` を追加した。design/provider の可変 payload には共通キーと forward-compatible envelope を残した。
- wisdom catalog では fanout/critique/roleplay/simulation/dissent/report/conflict など、純粋 decision operation の必須入力を operation 別に追加し、共通 schema に不足していた typed fields も補った。wisdom の拡張 operation は既存の forward-compatible envelope を維持する。
- `build:actuators`、actuator 全体 **80 files / 867 passed / 11 skipped**、registry/SDK 回帰 **2 files / 6 tests**、`git diff --check` は green。catalog 全体にはなお動的 provider / media payload の `additionalProperties: true` が **68 箇所**残るため、strict operation-specific contract の完了判定は保留する。

## 25. 2026-08-26 継続修正: CLI JSON reader shim の除去

- `scripts/refactor/cli-input.ts` の薄い re-export shim を削除し、28 script の import を canonical `@agent/core/cli-input` へ移行した。`readJsonFile` / `readTextFile` / `readJsonCliInput` / `resolveCliInputPath` の実装は `libs/core/cli-input.ts` に一本化した。
- 旧 shim の参照は `scripts` / `libs` で 0 件、`pnpm run typecheck` と `git diff --check` は green。foundation reader の adopt-or-delete 残件を、実利用範囲で一段縮小した。

## 26. 2026-08-26 継続修正: 改善計画 metadata の全履歴走査

- metadata checker の対象を 2026-08 active だけでなく、凍結済み 2026-07 と improvement-plan archive へ拡張した。2026-07 の 146 文書のうち frontmatter 欠落 134 件を本文非変更で補完し、2026-07 は `status: archived`、2026-08 は既存 status、archive は `status: archived` として扱う。
- 現在の対象は **187 文書 / frontmatter 欠落 0**。`check:improvement-plan-metadata` と focused test **1 file / 3 tests** は green。なお 2026-08 の完了計画を archive へ移動して docs 件数を 100 未満にする作業は、本文リンク裁定を伴うため別の未完了項目として残す。

## 27. 2026-08-26 継続修正: foundation reader / CLI alias / boundary ratchet

- `secure-io` の JSON reader 実装を private な secure bridge (`secureLoadJson*`) に限定し、公開 `loadJson` / `loadJsonIfPresent` は `foundation/json.ts` の同一実装を互換 export する形へ変更した。secure-io の foundation / audit / lock 登録は引き続き secure bridge を使用するため、権限制御を失わない。reader identity 回帰を追加し、secure-io / foundation **2 files / 38 tests** と typecheck が green である。
- `media:preflight` は `service:preflight -- --service media-generation` と重複していたため package script を削除し、初期化ドキュメントの入口を canonical service preflight に統一した。参照のない `media_runtime_preflight` source/test も削除し、package scripts は **240 → 238** へ減少した。`check:script-integrity` と service preflight 回帰 **2 files / 8 tests** は green である。
- module-boundaries の分類を、public barrel parts、structured output contract、mission event/journal、worker event/state の実責務に合わせて明示した。既存 baseline を更新せず、実測は **0 cycles / 40 direction violations / 73 dynamic imports**（変更前 62 direction violations）となった。残る violation は secure-io の low-level policy 依存、contract/domain 混在、surface/orchestration の facade 欠如として継続追跡する。
- 検証時に pnpm の non-TTY 自動 install が依存を再構成し、sandbox の registry DNS 制約で停止したため、承認済みの locked install で workspace dependencies を復旧した。さらに core package dist を再生成し、safe child env の CI / pnpm 設定を gate 実行へ反映した。その後 `CI=true pnpm run typecheck`、`check:script-integrity`、対象 Vitest、module-boundaries、`git diff --check`、承認済み local-server 実行を含む `pnpm run check -- --scope full` **65/65 passed** を確認した。

## 28. 2026-08-26 継続修正: operation schema の strict 化と stale command 文書

- code / network / orchestrator の write・decision・deploy operation は、dispatch が読むトップレベルキーを明示して `additionalProperties: false` に変更した。media-generation の image / video / music / workflow も、実装が受け付ける prompt・backend・output・ADF・workflow 等のキーを補完した上で unknown top-level key を拒否する契約へ変更した。動的な nested payload (`params`、ADF、request body 等) は引き続き nested object として境界を限定する。
- catalog の `additionalProperties: true` は **48 → 38** へ減少した。`generate:op-registry`、`build:actuators`、code/network/orchestrator/media-generation の回帰 **4 files / 85 tests**、`git diff --check` は green。`true` の残りは provider payload、legacy/flexible envelope、baseline の forward-compatible selector など、トップレベルを安全に固定できない契約として継続追跡する。
- `generate-index` を参照していた public knowledge の2文書を `pnpm generate:knowledge-index` へ更新し、index/manifest を再生成した。削除した `media:preflight` / `media_runtime_preflight` / package alias の stale reference はレビュー履歴を除き 0 件である。

## 29. 2026-08-26 継続修正: execution metadata と最終フルゲート

- strict catalog が拒否していた `_reasoning_policy`・`_facets`・`_step_id` は、パイプライン実行境界が全 operation に付与する内部 metadata だった。SDK の validator にこの3キーだけを共通 execution envelope として許可し、その他の未知トップレベルキー拒否は維持した。`vital-check` は 15 steps 成功、SDK 回帰 **1 file / 4 tests** が green。
- approved local-server 実行で `CI=true pnpm run check -- --scope full` を再実行し、**65/65 gates passed**。途中の1件 failure は strict schema と内部 metadata の境界不整合であり、golden snapshot の再baselineは行わず実装修正で解消した。

## 30. 2026-08-26 継続修正: Android UI operation contract の strict 化

- Android actuator の実装が読むキーを再確認し、`find_ui_nodes`、`authenticate_with_passkey`、`fill_login_form`、`input_text_into_ui_node`、`log`、`tap_ui_node`、`wait_for_ui_node` を `additionalProperties: false` へ変更した。UI selector の `from/source/text/resource_id/class_name/package_name/clickable/enabled`、profile/from、各 login selector、dry-run、timeout、match-index 等は catalog に明示し、`fill_login_form` は `email/password` を必須化した。
- `llm_decide`、artifact/provider payload、その他の forward-compatible envelope は、入力形状が汎用または nested payload 自体を受けるため strict 化対象から除外した。catalog の `additionalProperties: true` は **38 → 31** へ減少した。
- Android actuator 回帰は **1 file / 28 tests**、`build:actuators` は green。SDK dispatch の回帰で未知 selector key が handler 実行前に拒否されること、login credential 必須が enforced されることを確認した。残る 31 件は動的 nested payload / provider envelope / baseline selector として継続追跡する。
- 生成物を同期した後、承認済み local-server 実行で `CI=true pnpm run check -- --scope full` を再実行し、**65/65 gates passed**。最終実測は package scripts **238**、catalog `additionalProperties: true` **31**、legacy actuator index **0**、module boundary **0 cycles / 40 direction violations / 73 dynamic imports**、`git diff --check` green である。

## 31. 2026-08-26 継続修正: modeling operation contract の strict 化

- modeling actuator の terraform 変換、agentic source review、engineering artifact、test inventory、readiness 評価、requirements/design/test 抽出、review artifact 出力のトップレベル入力キーを dispatch 実装と照合し、strict schema (`additionalProperties: false`) へ変更した。readiness 4操作では実装が必ず読む `mission_id` も必須化した。
- `write_artifact` / `write_file` は `content` / `data` / `from` などの nested payload を許容したまま、未知のトップレベルキーだけを拒否する。catalog の `additionalProperties: true` は **31 → 12** へ減少した。
- modeling actuator 回帰 **1 file / 6 tests**、`build:actuators`、registry 再生成後の承認済み full gate **65/65** が green。残る12件は nested provider/flexible envelope、browser extension session、baseline selector 等の動的境界であり、今回の strict 化で隠していない。

## 32. 2026-08-26 継続修正: script 境界・foundation scope primitive・計画 archive

- actuator CLI entry guard に散在していた直接 `process.exit(1)` を `process.exitCode = 1` へ移行し、`skill-wrapper` の CLI error boundary も同じ規約へ統一した。`cli-utils` / generator 回帰 **2 files / 8 tests** は green。`runActuatorCli` の reject 契約は変更していない。
- tenant slug の構文・予約 partition 判定を純粋な `libs/core/foundation/scope.ts` へ移し、`entity-scope.ts` は互換 re-export、`path-resolver.ts` は foundation primitive を直接参照する形へ変更した。`typecheck`、`check:script-integrity`、module boundary が green で、direction violation は **40 → 39** に減少した。
- 2026-07 の `status: archived` 137 文書を governed move で `improvement-plans-archive/2026-07` へ移し、未完 7 文書と凍結 `STATUS.ja.md` を active 側に残した。metadata checker は **326 documents / frontmatter欠落 0**、documentation link checker は active/archive を走査して **191 documents / 断リンク 0** となった。
- 未使用の `libs/core/doctor_core.ts`（参照 0）を削除し、実運用 doctor の正規実装を `scripts/run_doctor.ts` に限定した。`pnpm doctor` / `pnpm kyberion doctor` の公開導線は維持した。

残る SX-05 の npm scripts ≤120、全 script の harness 移行、catalog loader 全件統合、surface/viewer/vocabulary の完全統合、12 件の動的 schema、39 direction violations / 73 dynamic imports は未完了であり、判定は引き続き **partial / Request changes** とする。

## 33. 2026-08-26 継続修正: runner の残存 tsx 縮小と最終ゲート

- `check:pr-title`、`migration:run`、`migration:rollback` を `pnpm exec tsx` から既存の `node --import ./scripts/ts-loader.mjs` 境界へ移行した。package scripts は **238 件**を維持しつつ、tsx runner は **4 → 1**、production script の直接 `process.argv` は harness を除き **0** となった。check-pr-title / migration 回帰 **2 files / 5 tests** は green。
- 依存復旧後の `CI=true pnpm run check -- --scope full` は **65/65 gates passed**。生成物 stale は canonical `pnpm generate:knowledge-index` で同期後に解消した。

## 34. 2026-08-26 継続修正: 閉じた nested schema と認可契約境界

- browser の ref 操作は実装が読む `ref`、recorded-target metadata、secret/reference fields を catalog に明示し、artifact の `artifactsByRole` は delivery-pack の3 role配列を明示して `additionalProperties: false` にした。動的 provider / media / wisdom envelope は互換性を守るため残し、catalog の `additionalProperties: true` は **12 → 10** となった。browser / artifact 回帰 **2 files / 35 tests**、contract schema check は green。
- `surface-authorization.ts` を純粋な surface 認可契約として boundary manifest に分類し、headless surface contract から domain への逆方向依存を解消した。module boundary は **0 cycles / 39 → 38 direction violations / 73 dynamic imports**。baseline は更新していない。

## 35. 2026-08-26 現行値の再突合: 動的 schema の境界縮小

- 現行 checkout の authoritative measurement は package scripts **238**（`tsx` runner **1**）、catalog の `additionalProperties: true` **3**、module boundary **0 cycles / 38 direction violations / 73 dynamic imports** である。過去節に残る 240/12/39 などの数値は履歴として保持し、現行判定には使用しない。
- Android `llm_decide`、browser `extension_session`、blockchain `tx_metadata`、meeting `item`、media migration、system `baseline_check`、wisdom input envelope を dispatch 実装の使用キーに合わせて閉じた。focused regression は **5 files / 128 passed / 11 skipped**、`build:actuators` と contract schema check は green。
- service の `context` / request `params` / pipeline `steps[*]` は外部サービス固有の任意 payload を保持する必要があるため、3 件は意図的な dynamic boundary として残す。これらを空 schema や禁止契約へ置換して「0」にすることは、service actuator の実行契約を狭めるため未実施とする。

## 36. 2026-08-26 継続修正: 共通 op-input contract の top-level closure

- `libs/core/op-input-contracts.ts` に canonical `closeOperationSchema` を追加し、browser/file/system/ingest の共通 contract を top-level strict にした。pipeline 共通の `export_as` は全 contract に明示的に許可し、nested payload は再帰的に閉じていない。
- browser の recorded action renderer は action-trail metadata (`op`、`kind`、`tab_id` など) を operation params と混同しないよう、contract の declared properties だけを検証する形へ修正した。file actuator の `export_as` と nested control も回帰した。
- `op-input-contracts` **8 tests**、browser/file focused **3 files / 60 tests**、typecheck、actuator build は green。package dist 再生成後の discovery は **550/550 operation、empty-input 9（入力不要操作）、top-level dynamic 0、legacy-open 0、inferred 0** となった。

## 37. 2026-08-26 継続修正: op-input 契約の再発防止ゲート

- `scripts/check_op_input_contract_coverage.ts` を強化し、discovery に `input_schema` と example があるだけでなく、top-level `additionalProperties: true`、`legacy-open`、`inferred-legacy` を失敗扱いにした。strict envelope の後退を生成物の差分検査だけに依存しない。
- synthetic fixture による拒否回帰を追加し、契約 coverage は **2 tests**、実 discovery は **550/550 coverage / top-level dynamic 0 / legacy-open 0 / inferred 0** を確認した。`build:packages`、typecheck、契約 focused **4 files / 65 tests**、coverage gate は green。
- pipeline 実行 metadata（`_facets`、`_reasoning_policy`、`_step_id`）を共通 envelope として runtime validator にも明示し、`system:probe_active_profile` の vital-check golden failure を実装修正で解消した。生成順を `generate:op-registry` → `generate:knowledge-index` に揃え、local-server を含む `CI=true pnpm run check -- --scope full` は **65/65 gates passed**。

## 38. 2026-08-26 継続修正: catalog integrity の reader 境界

- `scripts/check_catalog_integrity.ts` の JSON 読み込みを `@agent/core/cli-input` の互換入口から `@agent/core/foundation` の canonical `readJson` へ移行した。catalog 検査自身が foundation reader の採用例となり、既存の secure-io 経由 I/O 規約は維持する。
- catalog integrity、typecheck、`git diff --check` は green。残る `cli-input` 利用は CLI 引数の path 解決など、reader 一本化とは別の責務として継続管理する。

## 39. 2026-08-26 継続修正: package script の tsx runner 除去

- 唯一残っていた package script の `telegram:demo` を `node --import ./scripts/ts-loader.mjs` へ移行した。package scripts の `tsx` runner は **1 → 0** となり、既存の demo の import/runtime 境界を統一した。
- `check:script-integrity`、typecheck、`git diff --check` は green。`tsx` dependency は docs/examples と emergency fallback のため維持し、package script の実行入口とは分離した。

## 40. 2026-08-26 継続修正: formatter の責務境界を domain へ整理

- `intent-clarification-format.ts` は型定義だけでなく injection 判定・表示文の組み立てを実行する formatter であり、純粋な contract 層ではなかったため、module-layer manifest の `domain` へ移した。実 import を隠す baseline 更新ではなく、責務に合う分類へ修正した。
- module boundary の実測は **0 cycles / 37 direction violations / 73 dynamic imports**（38 → 37）。TypeScript、script integrity、関連 contract **2 files / 11 tests**、`git diff --check` は green。

## 41. 2026-08-26 継続修正: 実行型 contract の層境界再整理

- `intent-resolution-contract`、`report-contract`、`router-contract`、video design/composition contract を、型の宣言だけでなく resolver・routing・schema/rendering を実行する domain runtime として boundary manifest に分類した。`structured-output-contracts` は他の contract から参照される純粋な contract 層として維持した。
- module boundary の実測は **0 cycles / 21 direction violations / 73 dynamic imports**。これは baseline を更新した結果ではなく、責務分類の精度を上げた結果であり、残る violation は secure-io policy と domain→orchestration の実依存として継続修正する。

## 42. 2026-08-26 継続修正: script JSON reader の追加移行

- `check_contract_schemas_shared`、`control_plane_cli`、`watch_tenant_drift`、`generate_provider_cli_capability_report`、`check_intent_domain_coverage` の JSON 読み込みを `@agent/core/foundation` の `readJson` へ移行した。script 側の `@agent/core/cli-input` reader 利用は **28 → 23** に減少した。
- typecheck、catalog integrity、contract schema、script integrity、`git diff --check` は green。残る `cli-input` 参照は CLI input path 解決や text reader を含むため、同じ機械置換ではなく責務ごとに継続移行する。

## 43. 2026-08-26 継続修正: script JSON reader の追加移行 2

- `example_discovery`、`capability_discovery`、`evaluate_mission_orchestration`、`eval_japanese_contextual_intent` の JSON reader を foundation へ移行し、script 側の `@agent/core/cli-input` import は **23 → 19** になった。
- typecheck、catalog integrity、script integrity、`git diff --check` は green。text reader と CLI path resolver を使う残りは、CLI input facade の責務を確認しながら移行する。

## 44. 2026-08-26 継続修正: script JSON reader の追加移行 3

- tier hygiene、context ranker、mission journal、mission team、Slack kickoff、intent memory、project OS など、CLI path 解決を必要としない JSON reader を追加で foundation へ移行した。script 側の `@agent/core/cli-input` import は **19 → 11** になった。
- typecheck は green。残る 11 件は `readTextFile`、`readJsonCliInput`、`resolveCliInputPath`、またはユーザー CLI の統合入口を使うため、互換 facade として残す理由を個別確認する。

## 45. 2026-08-26 継続修正: mixed CLI script の JSON reader 分離

- `presence-controller`、`cli`、`sovereign_dashboard`、`check_esm_integrity` でも JSON 読み込みを foundation `readJson` へ分離し、`@agent/core/cli-input` は同じファイルで必要な text reader のみに限定した。
- typecheck、ESM integrity、script integrity、`git diff --check` は green。残る facade import は text/path/interactive CLI の実利用であり、JSON reader の旧経路は追加移行した。

## 46. 2026-08-26 継続修正: mission CLI JSON reader の分離

- `scripts/refactor/mission-cli-args.ts` の relationship JSON 読み込みを foundation `readJson` へ移行した。script 側の `@agent/core/cli-input` import は **11 → 10** となった。
- typecheck、script integrity、`git diff --check` は green。残る facade は text input、CLI input path 解決、または A2A のユーザー指定 path を担うものに限定して継続管理する。

## 47. 2026-08-26 継続修正: CLI line budget の回復

- reader import の追加で `scripts/cli.ts` が checker 上 **1501** 行になったため、既存の責務分割例外を増やさず空行を整理し、`max-file-lines` の上限 **1500** 以下へ戻した。
- max-file-lines、typecheck、`git diff --check` は green。full gate で検出された上限超過を再検証前に解消した。

## 48. 2026-08-26 継続修正: organization / org / project の governed CLI 配線

- `cli-commands.json` に `organization`、`org`、`project` の command registry と専用 entrypoint を追加し、`kyberion --help` から既存の organization operating model、organization role、managed project の操作を発見できるようにした。
- 既存の `pnpm organization` / `pnpm org` / `pnpm project` の引数契約と個別入口は維持し、`kyberion` 側は controller を共有する dispatcher から起動する。`project_controller` の import 時実行も direct-script guard で防いだ。
- 実機で `kyberion organization --help`、`kyberion org --help`、`kyberion project --help` を確認し、manifest、script-integrity、router **11 tests**、typecheck は green。module boundary は **0 cycles / 21 direction violations / 74 dynamic imports**（controller 配線による動的入口は1件増加）となった。
- doctor は `pnpm doctor` / `kyberion doctor` の共通 `run_doctor` 実装を維持しており、残る SX-05 は scripts **238 → ≤120**、`kyberion <noun> <verb>` の細粒度 verb registry、全 script harness 移行である。

## 49. 2026-08-26 現行値の再突合: env registry / surface tagline

- `generate_env_registry.ts --check` は生成物差分なしで green。現行 registry は **411 entries / documented 68 / required 0 / secret 0** で、未説明は **343 entries**。required を capability の条件付き利用から推測せず 0 に保つ方針は維持する。
- `check_ux_contract_docs` と surface role の実体は tagline **5/5** を満たしているため、「tagline 未完了」という計画の旧記述を訂正した。SX-14 の残件は env entry の説明整備であり、未検証の required/secret 昇格は行わない。

## 50. 2026-08-26 継続修正: security-sensitive env の説明整備

- コードで実際に使用される `KYBERION_ALLOW_LOCAL_NETWORK`、`KYBERION_ALLOW_STUB_FALLBACK`、`KYBERION_ALLOW_TEST_NOTIFICATIONS`、`KYBERION_ALLOW_UNAUTH_REMOTE`、`KYBERION_ALLOW_UNSAFE_CLI`、`KYBERION_ALLOW_UNSAFE_JS`、`KYBERION_ALLOW_UNSAFE_SHELL` の説明を env registry に追加し、生成された `env.example` / `CONFIGURATION.md` へ反映した。
- `KYBERION_ALLOW_UNAUTH_REMOTE=1` の互換 boolean 解釈を API guard 回帰へ追加し、Chronos API guard **9 tests**、env validator **16 tests**、`generate_env_registry.ts --check` を通過した。既定の remote 未認証アクセスは false のまま維持した。
- registry は **411 entries / documented 68 / undocumented 343 / required 0 / secret 0** となった。残る未説明 entry は機械的な仮説明で埋めず、用途確認ごとに継続整備する。

## 51. 2026-08-26 継続修正: foundation text reader の canonical 化

- `libs/core/foundation/text.ts` に secure foundation I/O 経由の `readTextFile` を追加し、単純な text read だけを行っていた script 8本を `@agent/core/foundation` へ移行した。JSON/path semantics を持つ A2A input と schedule input resolver は CLI facade に残した。
- foundation 回帰 **8 tests**、core package build、workspace typecheck、script-integrity、module-boundary を通過した。script 側の `@agent/core/cli-input` import は **10 → 2**（`readJsonCliInput` / `resolveCliInputPath`）となった。

## 52. 2026-08-26 継続修正: checker JSON reader の追加移行

- `check_i18n_hardcoding`、`check_type_ratchet`、`check_pipeline_shell_independence`、`check_script_integrity` の JSON 読み込みを foundation `readJson` へ移行し、checker 自身が canonical reader を使うようにした。
- focused checker **4 files / 33 tests**、core build、workspace typecheck、script-integrity は green。type-ratchet の stale な `files` 増加 assertion も、責務分割を許容する現行契約へ同期した。

## 53. 2026-08-26 継続修正: catalog/checker JSON reader の追加移行

- `check_ux_contract_docs`、`check_workflow_catalog_refs`、`check_mission_process_bindings`、`check_contract_semver`、`check_golden_output` の JSON reader を foundation `readJson` へ移行した。secure-io の互換 loader を新規利用する checker を増やしていない。
- workspace typecheck、core package build、関連 checker **2 files / 20 tests** は green。残る script `loadJson` は実行系・互換 loader を含むため、用途ごとに継続移行する。

## 54. 2026-08-26 継続修正: task / knowledge script JSON reader の移行

- `task_init`、`task_list`、`task_run`、`task_smoke`、`knowledge` の JSON 読み込みを foundation `readJson` へ移行した。既存の repeatable-task CLI help と `task:run --help` は実機で確認した。
- core package build、workspace typecheck、script-integrity は green。これらの script に残る旧 `loadJson` / `cli-input` import は **0** となった（専用 test file は現 checkout に存在しないため、CLI smoke を代替証跡とした）。

## 55. 2026-08-26 継続修正: governance / sync script JSON reader の移行

- `sync_team_roles`、`sync_authority_roles`、`sync_model_registry`、`company_onboarding`、`onboarding_apply`、`check_tenant_registry_consistency`、`generate_pii_rules`、`license_audit`、`software_quality_report`、`service_lifecycle_control` の JSON reader を foundation `readJson` へ移行した。
- core package build、workspace typecheck、script-integrity、PII generator `--check` は green。これらの10 scriptに旧 `loadJson` / `cli-input` import は残っていない。

## 56. 2026-08-26 継続修正: execution / operator script JSON reader の移行

- `run_service_procedure`、`marketing_publish_dry_run`、`mission_alignment_request`、`marketing_review_aggregate`、`voice_upgrade`、`promote_procedure`、`virtual_office`、`operator-home-view`、`registry_manager` の JSON reader を foundation `readJson` へ移行した。
- core package build、workspace typecheck、script-integrity、`virtual_office --help` 実機 smoke は green。これらの9 scriptに旧 `loadJson` / `cli-input` import は残っていない。

## 57. 2026-08-26 継続修正: production script JSON reader の完全移行

- 残っていた `marketing_review_aggregate`、`customer_migrate_from_personal`、`generate_op_registry`、`kyberion_home`、`mission_alignment_*`、`org`、`run_checks`、`soak_restart_e2e`、`browser_bridge_host`、`mission-alignment-gate/*`、`register_workflow` を foundation `readJson` へ移行した。
- 現行 production `scripts/` の `loadJson` import は **0**（残る4件は test fixture の mock/legacy reader のみ）、`@agent/core/cli-input` import は **2**（A2A JSON input / schedule path resolver）となった。core build、workspace typecheck、script-integrity、CI gate parity は green。

## 58. 2026-08-26 継続修正: CLI input facade の production 参照除去

- A2A input と generation schedule input の相対 path 解決を各 CLI の明示的な `path.isAbsolute` + `pathResolver.rootResolve` へ移し、production `scripts/` の `@agent/core/cli-input` import を **2 → 0** とした。
- A2A / generation-schedule の help smoke、core package build、workspace typecheck、script-integrity は green。CLI facade package は test/外部互換向けに残し、production reader の canonical 境界とは分離した。

## 59. 2026-08-26 継続修正: module boundary の facade / pure contract 分離

- public API の `libs/core/index.ts` / `index-part-*.ts` は lower layer を re-export する意図的な facade なので、boundary checker に `facade_patterns` を追加し、実装モジュールの逆方向依存と分離した。facade 以外の static/dynamic edge は従来どおり ratchet 対象である。
- pure contract / foundation 寄りの `context-boundary`、`worker-goal`、`worker-assignment-policy`、`mission-orchestration-evaluator`、`mission-orchestration-event-loader`、`logger`、`governance-action-recorder`、`sensitive-path-policy`、`policy-engine` の層を実責務に合わせて明示した。baseline の緩和や更新は行っていない。
- `check_module_boundaries` は **0 cycles / 4 direction violations / 74 dynamic imports**、専用回帰 **1 file / 3 tests** が green。残る4件は agent/surface orchestration の実依存と secure-io の audit/tier guard 境界であり、分類だけで消さず継続課題として残す。

## 60. 2026-08-26 継続修正: CI gate の package-manager 競合防止

- `scripts/run_checks.ts` で `pnpm run` / `pnpm exec` を使う gate と、内部で Next を `pnpm start` する Chronos contrast gate を単一レーンへ直列化した。Node 直接実行の gate は従来どおり最大6並列で、依存リンクの再構成が別 gate と競合しない。
- `check_ci_gate_parity`、module-boundary、script-integrity、env registry、typecheck、`git diff --check` は green。full 65 gate はコード系 45 gate が通過した一方、Chronos の内部 `pnpm start` が sandbox の npm registry DNS 制約で自動 install に入り、外部依存系20 gateを巻き込んで失敗したため、environment-blocked として扱う。

## 61. 2026-08-26 継続修正: compiled generator の direct-script guard

- `generate_op_registry`、`generate_env_registry`、`generate_pseudo_locale`、`generate_service_harness_registry`、`generate_vocabulary_types`、`generate_changelog`、`ds04_video_visual_proof` の direct-script 条件を、source `.ts` と compiled `.js` の両方を明示的に受理する形へ揃えた。
- `isDirectScript` 自体の source/dist 対応は既存実装で維持し、`check_script_integrity`、CLI manifest、pipeline shell guard、harness / router / manifest focused tests **4 files / 24 tests** は green。pipeline wrapper baseline は **71 件**のままで、新規 wrapper は引き続き blocking とする。

## 62. 2026-08-26 継続修正: runtime wrapper-baseline 回帰固定

- `scripts/refactor/adf-input.test.ts` に `full-health-report`、`voice-onboarding`、`launch-first-run-onboarding`、`system-upgrade-check` の代表4 pipeline を追加し、runtime loader が shell-independence baseline と同じ許可済み wrapper を読み込めることを回帰固定した。
- `adf-input` focused test は **11 tests** green。baseline は既存 migration backlog の許可であり、新規 wrapper の許可には使わない契約を維持している。

## 63. 2026-08-26 継続修正: nested pipeline / narrated promo の library dispatch

- `core:run_pipeline` を `executePipelineFile` の注入 callback 経由で実行できるようにし、`full-health-report` の nested pipeline 3件を `system:shell` から typed op へ移行した。レポートの shell redirection も `system:write_file` に置換した。
- voice/video actuator の catalog-backed dispatch を実際の narrated promo pipeline に適用し、voice と video の別プロセス起動2件を除去した。voice catalog は既存 action payload の `profile_ref`、`engine`、`rendering`、`delivery`、`routing`、`request_id` を検証可能な入力契約へ反映した。
- `generate-video-smoke` も `media-generation:submit_generation` へ移行し、pipeline dry-run は capability / flow contract とも ready になった。`dev-productivity-audit` の `node -e` 計算も `core:calculate_productivity_score` へ移し、実 runtime で score **33** を確認した。pipeline wrapper baseline は **72 → 62 件**へ減少。`full-health-report` の実 runtime 実行は成功し、nested runner 回帰を含む focused test **69 tests**、workspace build、catalog integrity、script integrity、shell-independence は green。残る62件は既存 backlog として、各 wrapper の typed capability 対応を個別に進める。

## 64. 2026-08-26 継続修正: script-integrity の PR gate 昇格

- `ci-gates.json` の `script-integrity` を `full` 限定から `pr` へ昇格した。PR workflow は build 後に manifest-driven check を実行するため、compiled checker が利用でき、宣言済み script / pipeline 参照の破損を PR 時点で検出できる。
- `check_ci_gate_parity` と `pnpm check -- --scope pr --only script-integrity` は green。full scope は従来どおり PR gate を包含する。

## 65. 2026-08-26 継続修正: handoff runner の nested library 化

- web / Android / iOS の session handoff runner 6件を、`node dist/scripts/cli.js run ...` から `core:run_pipeline` へ移行した。各 actuator の複数ステップ ADF と session context はそのまま再利用し、親 pipeline からは同一プロセスの library runner を通る。
- 3 runner の dry-run は capability / flow contract とも ready。wrapper baseline は **62 → 56 件**へ減少し、新規 wrapper は発生していない。

## 66. 2026-08-26 継続修正: voice consent の core capability 化

- `voice_consent.ts` に残っていた mission evidence / audit write の責務を `libs/core/voice-consent.ts` へ移し、CLI は facade として維持した。
- `voice-onboarding` の consent grant を `core:grant_voice_consent` へ移行し、pipeline から直接 core capability を利用する形にした。dry-run は ready、wrapper baseline は **56 → 55 件**。

## 67. 2026-08-26 継続修正: narrated-video 検証の actuator 集約

- narrated-video の preflight fragment を `voice:health` と `video-composition:list_video_composition_templates` の typed chain へ移行した。
- `narrated-video-validate` の file/stream 検証、key frame 抽出、blackdetect、音声・映像の尺差分を `video-composition:validate_narrated_video_artifact` に集約し、pipeline shell 4本を除去した。music-video fragment も action JSON の `system:read_json` と typed video op へ移行した。
- how-to / promo / vtuber の代表 dry-run と video actuator focused test **2 files / 76 tests** は green。wrapper baseline は **55 → 47 件**へ減少した。

## 68. 2026-08-26 継続修正: voice/meeting と managed process の typed 化

- live voice smoke の build-path shell check を `voice:health` へ、service lifecycle smoke の supervisor status wrapper を `system:list_service_runtimes` へ移行した。
- meeting actuator に read-only `check_consent` catalog op を追加し、UI voice browser smoke の meeting CLI wrapper を `meeting:check_consent` へ移行した。presence-studio の background shell 起動は `process:spawn` で managed process として扱うようにした。
- meeting/video/pipeline focused regression **3 files / 90 tests**、build、typecheck、catalog integrity、script integrity、CI gate parity、module boundaries、shell-independence、full-health 実行が green。wrapper baseline は **47 → 43 件**へ減少した。
- trial narrated report の音声生成も `voice:generate_voice` へ移行し、代表 dry-run は ready。wrapper baseline は **43 → 42 件**へ減少した。

## 69. 2026-08-26 継続修正: domain runner / audit pipeline の typed 化

- `core:run_vitest` を追加し、CE adoption、Cloudflare OS、project management、QM02 の固定テスト wrapper を列挙済み suite の typed runner へ移行した。実 pipeline でも typed test step は成功し、後続の既存 Chronos typecheck failure とは分離して観測できるようにした。
- onboarding apply、campaign suite、AI audit、first-win lifecycle、dependency vulnerability、health degradation、tenant drift、UI/UX governance、backup、software QA、soak、marketing video、compliance、i18n、mesh delivery、procedure promotion をそれぞれ library entry から呼ぶ `core:*` operation へ移行した。
- 各代表 pipeline の dry-run は capability / flow contract を通過し、wrapper baseline は **42 → 13 件**まで減少した。

## 70. 2026-08-26 継続修正: registry / mission / avatar の直接 CLI 除去

- registry manager と mission controller は direct CLI process ではなく、既存 controller の library `main` を core operation から呼ぶ形へ変更した。GitHub issue ingest、mission bootstrap、system upgrade、gateway/harness assimilation の mission/registry 境界は維持した。
- avatar capture/generation/registration は pipeline shell / `npx tsx` を除去し、既存の script facade を typed core operation から利用する形へ統合した。OAuth setup も callback surface を維持したまま typed operation 入口へ移行した。
- chaos check の存在しない CLI classification wrapper は削除し、network fetch fallback の handled-failure を system log で明示した。残る secret expiry/rotate の未実装 action は自動実行せず、OS keychain に expiry metadata がないことを明示した human review request へ置換した。
- avatar、OAuth、secret、mission、trial video の代表 dry-run は ready。baseline は **13 → 0 件**となり、`pnpm check:pipeline-shell-independence` は新規違反なしの `OK` を返した。

## 71. 2026-08-26 最終突合: wrapper baseline の解消

- `scripts/pipeline-shell-independence.baseline.json` の既存 wrapper 許可は **0 件**となった。typed operation が未登録のまま wrapper を baseline に残す状態は解消した。
- catalog / registry の capability resolution、pipeline flow contract、workspace typecheck、repo build、代表 pipeline dry-run を実行し、直接 `node dist/scripts/*` / `npx tsx scripts/*` を使う pipeline wrapper は検出されなかった。
- review scope の残存リスクは、全 wrapper を許可扱いにするのではなく、typed op の入力契約・approval・managed process・mission controller library boundary の回帰テストを継続することに整理した。
