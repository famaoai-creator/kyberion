---
title: SIMPLICITY ABSTRACTION PLAN 2026 08 25
tags: [improvement-plan, 2026-08]
last_updated: 2026-08-25
status: active
---

# シンプルさ・使いやすさ・共通化 改善計画(SX-01〜SX-14)

> 優先度: P0〜P2 / 規模: XL(段階実装) / 関連: AR-09(actuator 共通化), EG(エンティティ統一), MG-08(語彙衝突), LC(ライフサイクル円滑化), REGISTRY_SPLIT_PLAN
> **起票日**: 2026-08-25
> **状態**: EXECUTING(段階実装中。残項目は下記の実装状況を正本とする)
> **監査対象**: `libs/core`(839 flat files / 33 万行)、`scripts/`(319 npm scripts / 273 実行体)、`pipelines/`+`libs/actuators/*`(181 pipelines / 33 actuators)、`presence/`+`satellites/`(12 surface)、`knowledge/product/governance/*.json`(176 catalog)、`docs/`+`knowledge/`(1,126 md)

---

## 0. 結論(先に)

Kyberion のコンセプト([WHY](../../WHY.md) / [INTENT_LOOP_CONCEPT](../../INTENT_LOOP_CONCEPT.md) / [USER_EXPERIENCE_CONTRACT](../../USER_EXPERIENCE_CONTRACT.md))は明確で一貫している:

- **不可換なのは意図ループ 6 段の閉包だけ**。推論モデル・CLI・actuator・schema 名は可換。
- 人間との境界では **4 概念(request / execution unit / deliverable / next action)** だけを露出する。
- 「曖昧な入力を意図を失わず成果まで運ぶ」保証を、モデルの賢さでなく **仕組み** で担保する。

実装はこのコンセプトを **機能面ではほぼ満たしている** が、**「シンプルさ・使いやすさ」の面ではコンセプトと逆行**している。6 領域の監査から、症状は多数あるが根本原因は次の 5 つに収斂する:

| #   | 根本原因                                                 | 代表的な証拠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **共通化の種は存在するが採用されない**(「作って終わり」) | `secure-io.loadJson` 呼び出し **0** vs 手書き `JSON.parse(safeReadFile())` **489**。`getRegisteredEnv` 6 箇所 vs 生 `process.env` 460 箇所。`ScopedRegistry<T>` 4 利用 vs 手書き registry/catalog/store/ledger 65。`authorizeSurfaceMutation` 2 surface vs 独自 viewer/auth 4 系統。`validateAndRepairAdf`(AGENTS.md が必須と書く関数)本番呼び出し **0**。`missionSteeringRouteHandler` 外部利用 **0**                                                                                              |
| R2  | **境界ルールが「能力」だけで「方向」が無い**             | eslint は `fs` 禁止・`process.exit` 禁止のみ。`import/no-cycle` 無し。core 内 8 モジュールが自身の barrel を import。`libs/core/src/` は層でなく化石(双方向依存)。結果 839 ファイルがフラットのまま、`index.ts` 2,691 行 / 970 export、691 ファイルが bare barrel を import                                                                                                                                                                                                                         |
| R3  | **入口が多重化し、同じ問いに複数の脳が答える**           | CLI 5 系統(`cli.ts` 34 cmd / `kyberion_home.ts` 12 / `mission_controller.ts` 30 / `control_plane_cli.ts` / `tui`)、`bin.kyberion` と `pnpm kyberion` が別プログラム。自由文の意図解釈が **6 実装**(voice-hub が独自 180 行ルータで shared orchestrator の前段に居座り、concierge/presence-studio がそれを経由)。「環境は準備できているか」に答えるコマンド **18**(実装 11 本、Playwright/ffmpeg を 4 箇所で独立 probe)                                                                              |
| R4  | **ガバナンス機構の自己増殖**                             | governance JSON 176(スキーマ無し 70、うち `security-policy` `approval-policy` 等の最重要 7 件。コード参照ゼロ 20 — `restricted-capabilities.json` は enforcement に見えて何も読まない)。catalog loader 約 **151** 個の手書き(Ajv 83 / `ensureValidator` 62 / `errorsFrom` 48 / `FALLBACK_*` 48)。`check:*` 62 のうち CI が走らせるのは 31。`pnpm validate` は 39 連 `&&`。状態の「正本」を名乗る文書 6、うち 2 つは優先規則が正反対。改善計画 182 本(docs/ の 58%)中 152 本が完了済み・未アーカイブ |
| R5  | **UX 契約が書かれているが執行されない**                  | Glossary 117 語 : 外部語彙 4 語。README は外部 4 語 **0/4**、内部限定語(actuator 11 / ADF 1)を露出。4 問(理解/不足/次/成果)を構造化した `IntentResolutionContract` は全ターンで計算されるが描画するのは TUI と `kyberion_home` だけ。承認時の契約分岐(`approval_required`)は呼び元ゼロで死んでいる。初回導線は 3 文書で 10/11/13 コマンドと食い違い、かつ **全部が `build` 前に `dist/` 依存コマンドを走らせて必ず失敗する**                                                                        |

したがって本計画の主眼は「新しい抽象を増やすこと」ではなく、**①既にある正しい抽象へ全員を寄せて分岐を削除する、②方向性の境界を機械で守る、③入口と正本を一つずつにする、④UX 契約を CI で執行する** の 4 点である。**新規抽象は各領域につき 1 個まで**(下表の太字)に絞る。

---

## 1. 設計原則(改善の判断軸)

1. **Adopt-or-delete**: 共通 helper を追加するときは、旧経路を同一 PR で codemod + lint 禁止まで行う。「両方残す」は禁止(R1 の再発防止)。`loadJson` / `getRegisteredEnv` / `ScopedRegistry` / `authorizeSurfaceMutation` / `missionSteeringRouteHandler` / `validateAndRepairAdf` はこの原則の最初の適用対象。
2. **方向を先に、移動は後に**: ディレクトリ再編(git mv)は import 方向ルールと cycle 検出が CI で green になってから行う。順序を逆にすると絡まりを付け替えるだけになる。
3. **一つの問いに一つの入口**: 「何をしたい?」「今どうなっている?」「環境は大丈夫?」「PR を出せる?」の各問いに対し、ユーザー向けコマンドを 1 つに定める。残りは alias ではなく削除。
4. **宣言に寄せる(manifest-driven)**: check / generator / probe / gate はコードでなく registry JSON に宣言し、1 つのランナーが回す。CI と `pnpm validate` の乖離をゼロにする。
5. **コンセプトの語彙を外に、内部語彙を中に**: 前扉 3 文書(README / QUICKSTART / OPERATOR_UX_GUIDE)は外部 4 概念で書き、内部語を lint で弾く。Glossary は階層化する。
6. **削減はラチェットで固定**: 本計画の各項目は「削る数」を受入基準に持ち、`check_type_ratchet` と同じ方式で **上限を CI に焼き込み、再増加を止める**。

---

## 2. 計画一覧

| ID    | 領域       | 内容                                                                                                                                                            | 優先   | 規模 | 依存        | 根本原因 |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- | ----------- | -------- |
| SX-01 | 導線       | 初回導線の修復(`build` 順序、fence 崩れ、3 文書→1 文書、5 コマンドで PNG)                                                                                       | **P0** | S    | —           | R5       |
| SX-02 | 境界       | import 方向ルール + cycle 検出 + 4 層宣言(`foundation → contracts → domain → orchestration`)                                                                    | **P0** | M    | —           | R2       |
| SX-03 | core       | **foundation 層**の確立(ajv / json / env / text / time)と 5 つの「未採用 helper」の adopt-or-delete codemod                                                     | **P0** | L    | SX-02       | R1       |
| SX-04 | governance | **`defineCatalog<T>()`** 単一ローダー + 全 catalog schema 必須 + schema 根統合 + 未参照 20 件の処分                                                             | **P0** | L    | SX-03       | R1,R4    |
| SX-05 | CLI        | **`kyberion <noun> <verb>`** 単一 CLI(command registry)/ `bin` と `pnpm kyberion` の一致 / doctor 11→1 / npm scripts 319→〜120                                  | P1     | L    | SX-06       | R3       |
| SX-06 | scripts    | **`defineScript()` / `defineGenerator()`** harness(argv・`--json`・`--dry-run`・`--check`・exit code の一本化)/ 孤児 74 本の処分                                | P1     | M    | SX-03       | R1       |
| SX-07 | CI         | **manifest-driven `pnpm check`**(`ci-gates.json`)/ validate と CI の一致 / 走っていない 32 checker の処分 / ラチェット集約                                      | P1     | M    | SX-06       | R4       |
| SX-08 | surface    | 意図解釈の一本化(voice-hub `generateReply` 廃止、`intent` 系 CLI 統合)/ `IntentResolutionContract` を全 surface で描画 / `approval_required` の配線             | P1     | L    | —           | R3,R5    |
| SX-09 | surface    | **`ChannelAdapter` + `runChannelTurn()`**(4 bridge のターン/outbox/thread 履歴を統合)/ viewer-auth 5→1 / vocabulary API 6→1 / read-model から文言排除           | P1     | L    | SX-08       | R1       |
| SX-10 | 実行層     | **`defineActuator()`** SDK(executePipeline 12・preflight 31・retry 29 の複製削除)/ scaffold を実態に合わせる / ABI 4→1 / `run_pipeline` にライブラリ入口        | P1     | L    | SX-03       | R1,R3    |
| SX-11 | 実行層     | ADF ライフサイクルを 1 関数に(`runAdfLifecycle`)/ repair 二重実装の解消 / `system:exec` スクリプト包み 68 件の guardrail / 語彙統一(`role` vs `type`, bare op)  | P2     | M    | SX-10       | R1,R4    |
| SX-12 | core       | god module 分割(`mission-orchestration-worker` 7,012 行ほか 10 本)/ 重複概念の統合(mission façade 4→1、read-model 5→1、状態機械 2→1、seam 21→`createSeam<T>()`) | P2     | XL   | SX-02,SX-03 | R2       |
| SX-13 | docs       | 正本の一本化(状態台帳 6→1、概念文書 6→1、onboarding 8→1)/ 完了計画のアーカイブ / Glossary 階層化 / knowledge コーパス清掃                                       | P1     | M    | —           | R4,R5    |
| SX-14 | UX         | 前扉 3 文書への UX 契約 lint(内部語禁止・外部 4 語必須)/ `surface-roles.json` の tagline_key 完備 / `env-registry` の品質修正                                   | P2     | S    | SX-13       | R5       |

**Wave 構成**: Wave 0 = SX-01(即日)/ Wave 1 = SX-02, SX-03, SX-04, SX-13(土台)/ Wave 2 = SX-05, SX-06, SX-07(入口と CI)/ Wave 3 = SX-08, SX-09, SX-10(surface と実行層)/ Wave 4 = SX-11, SX-12, SX-14(仕上げ)。Wave 内は並列可、Wave 間はゲート(§4)。

---

## 3. 各計画

### SX-01: 初回導線の修復(P0 / S)

**症状**: `README.md:96` / `QUICKSTART.md:33,40` / `INITIALIZATION.md:15,50` の全てが `pnpm prereq:check`(= `node dist/scripts/bootstrap_environment.js`)を `pnpm build` の **前** に置いており、clean clone では `Cannot find module` で止まる。`README.md:68` の「No build needed」も虚偽(`doctor` は `dist/` 依存)。`INITIALIZATION.md` は L46/L95/L123/L322 の fence が不整合で、Stage 1〜12 と tenant/organization 比較表(約 200 行)が 1 つのコードブロックとして描画される。3 文書はコマンド数 10/11/13 で食い違い、正本を名乗る INITIALIZATION.md だけが first-win 成果物を生まない。

**実装**:

1. 順序を `install → build → prereq:check → doctor → pipeline --input pipelines/verify-session.json` に統一(5 コマンドで `first-win-session.png`)。
2. fence を修復し、markdown fence-balance lint を docs gate に追加。
3. 入口文書を 1 つ(`docs/QUICKSTART.md`)に定め、README は 5 行の要約 + リンク、INITIALIZATION は「Day 2(company/tenant/organization/19 種 backend 選択)」に降格。tenant activation の `--probe-ref` 4 個(`QUICKSTART.md:65-74`)は Day 2 へ移す。
4. CI job `first-win-clean-clone`: 文書に書かれた one-liner を clean checkout で実行し PNG 生成を assert(`check:first-win-smoke` は存在するが CI 未接続 — これを接続)。

**受入基準**: clean clone で文書通りに打って 5 コマンド以内に PNG。3 文書のコマンド列が機械抽出で一致。

### SX-02: import 方向ルールと cycle 検出(P0 / M)

**症状**: `eslint.config.js` の制約は fs / child_process / process.exit の「能力」制約のみ。`import/no-cycle` 無し。core 内 8 モジュールが `./index.js` / `@agent/core` を import。`surface-runtime-orchestrator ↔ mission-team-plan-composer ↔ mission-context-pack` が環。`libs/core/src/`(pipeline 期の化石)と root が双方向。

**実装**:

1. 4 層を宣言: `foundation`(secure-io / path-resolver / ajv / json / env / text / time — core 内 import 不可)→ `contracts`(型・schema・entity-scope・vocabulary)→ `domain`(mission / work / intent / reasoning / surface / organization …)→ `orchestration`(worker / dispatcher / surface-runtime-orchestrator / pipeline engine)。
2. `no-restricted-imports` patterns で下位→上位を禁止、`import/no-cycle` を有効化。既存違反は `scripts/check_type_ratchet` と同方式で **baseline に凍結し、増加のみ禁止**(初日から green にする)。
3. `scripts/check_module_invariants.ts`(現在 4 モジュールのみ)を層宣言のチェッカに拡張。
4. `libs/core/src/` の解消方針を決める(root へ統合)。移動自体は SX-12。

**受入基準**: cycle 数と方向違反数が baseline 化され CI で減少のみ許可。新規ファイルは層ディレクトリ配下必須。

### SX-03: foundation 層と「未採用 helper」の adopt-or-delete(P0 / L)

**症状(数)**: Ajv ESM interop ボイラープレート 161 ファイル(うち 96 は `schema-loader` を import しながら自前 Ajv を作る — `compileSchemaFromPath(ajv, path)` が Ajv を引数に取る設計が原因)。私的 `readJson*`/`writeJson*` 40 ファイル、`appendJsonLine` 利用 2 vs `.jsonl` 触る 78 ファイル / 独自 `append*` 24。`process.env.KYBERION_*` 直読 136 ファイル・345 変数。`normalize*` 私的定義 161(`normalizeText` は 6 種の意味)。`isRecord` 10 / `nowIso` 12 / `clamp*` 12。

**実装**:

1. `libs/core/foundation/` に `ajv.ts`(Ajv を所有、`compileSchema(path)`)、`json.ts`(`readJson` / `writeJson` / `appendJsonLine` / `readJsonl`)、`env.ts`(`getRegisteredEnv` を昇格。registry から typed `config.ts` を生成)、`text.ts`(`normalizeText` を意味ごとに命名、`slugify` `clamp` `isRecord` `asString` `asRecord`)、`time.ts`(`nowIso` `parseIso` `normalizeIso`)。
2. **codemod 5 本**(各 1 PR): `JSON.parse(safeReadFile(` → `readJson`(489 箇所)/ `new Ajv(` → foundation(161)/ `process.env.KYBERION_` → `config.`(460)/ 私的 `isRecord|nowIso|clamp` → foundation / `.jsonl` append → `appendJsonLine`。
3. 各 codemod と同一 PR で eslint `no-restricted-syntax` を追加し旧形を禁止。
4. `secure-io.loadJson`(0 callers)は foundation の `readJson` に統合して削除。`adapters/adapter-types.safeEnv` 削除。

**受入基準**: 上記 5 パターンの出現数が **0**、lint で再発不可。foundation は core 内から何も import しない(SX-02 で機械検証)。

### SX-04: 単一 catalog ローダーとスキーマ必須化(P0 / L)

**症状**: `knowledge/product/governance` を直接 resolve するモジュール 151、`load*/get*Catalog|Registry|Policy` 114 関数、`FALLBACK_*` 定数 48(governance データの未テストな第二コピー)、`config-fallback-registry` の配線 6/151。`schemas/`(105)と `knowledge/product/schemas/`(348)の 2 根で同名 5 件が内容不一致。`ENTITY_SCOPE_HIERARCHY` と `SCOPED_REGISTRY_LEVELS` が同じ 6 段の二重定義。`*_PATH` 上書き env 29 個が各 loader 固有の分岐。REGISTRY_SPLIT_PLAN の「互換 snapshot」9 組が無期限。

**実装**:

1. `libs/core/foundation/governed-catalog.ts`: `defineCatalog<T>({ id, schema, fallback?, tierOverridable? })` → `{ load(), path(), reset() }`。共有 Ajv、compiled validator cache、path+mtime キャッシュ、fallback 時は自動で `recordConfigFallback`。tier 別 `*_PATH` 上書きはここで一元解決。
2. 移行順: `media-drawio-*-policy.ts` 5 本(同一ファイル ×5)→ `tracker-sheet-policy` / `media-style-policy` 型の 55 行プロローグを持つ約 80 本 → 残り。1 PR あたり 10〜15 本。
3. `check:catalogs` / `check:governance-rules`(手書き配列 41+11 件、計 2,900 行)を「`governance/*.json` 全件に対応 schema 必須」のディレクトリ走査に置換。最初に schema を付けるのは `security-policy` `approval-policy` `spend-policy` `trust-policy` `egress-policy` `shell-command-policy` `permission-presets`。
4. schema 根を `knowledge/product/schemas/` に統合、衝突 5 件を解決、`rootResolve('schemas/...')` 約 12 箇所を修正。
5. コード参照ゼロの 20 件は削除するか `documentation_only: true` を付け、未参照 catalog を fail する check を追加。
6. `SCOPED_REGISTRY_LEVELS` を `ENTITY_SCOPE_HIERARCHY` から導出。REGISTRY_SPLIT 互換 snapshot に廃止期日を設定。
7. `FALLBACK_*` はビルド時に JSON から生成するか削除して fail-closed。

**受入基準**: 手書き loader 0、schema 無し catalog 0、schema 根 1、未参照 catalog 0(または明示マーク)、`*_PATH` env 29 → 0。

### SX-05: 単一 CLI(P1 / L)

**症状**: `bin.kyberion` → `cli.js`(34 cmd)だが `pnpm kyberion` → `kyberion_home.js`(12 cmd)。`cli.ts:137` の `APPROVED_PACKET_COMMAND_SCRIPTS` は 3 件で、319 scripts の **約 1%** しか bin から到達できない。`pnpm org`(1,059 行で 2 コマンド)/ `organization`(30 subcmd)/ `project` / `company:*` が重複(`organization project list` と `project list` は別実装)。doctor 系 11 実装 / 18 コマンド。runner が dist(114)/ts-loader(142)/tsx(4) の三つ巴。命名は `noun:verb` 168 / `noun:kebab-verb` 108 / colon 無し 6 / 裸 37。

**実装**:

1. command registry(`knowledge/product/governance/cli-commands.json`: id, noun, verb, entry, audience=`user|operator|dev`)から `kyberion <noun> <verb>` を lazy-load で構築。`cli.ts` / `kyberion_home.ts` / `mission_controller.ts` / `control_plane_cli.ts` はこの registry の entry になる(ファイルは残す、入口だけ統合)。`bin` と `pnpm kyberion` を同一に。
2. `kyberion doctor [--surface browser|voice|media|meeting|service]`: probe registry 1 つに 11 実装を畳む(Playwright/ffmpeg probe は 1 箇所)。
3. `pnpm pipeline <preset>`: `run_pipeline --input <固定 path>` の 12 alias を preset index に。`run_with_env` 10 alias は宣言 env に。flag 違いの 89 alias → 31。
4. `org` を `organization` に吸収、`project list` の二重実装を 1 つに、`company:*` を `onboard` 系へ。
5. runner を ts-loader(dev)/ 単一ビルド済み bin(prod)に統一。`onboard:*` の inline `existsSync('dist/…')` guard を撤去。
6. 命名規約 `noun:verb`(kebab)に統一、`build:all`(実体は typecheck)等の誤名を修正。

**受入基準**: npm scripts 319 → **≤120**(ユーザー向けは `kyberion --help` で全件発見可能)、doctor 実装 1、「環境は大丈夫?」コマンド 1。

### SX-06: script harness と generator 抽象(P1 / M)

**症状**: `process.argv` 直読 197 / `createStandardYargs` 69 / `parseArgs` 24 / 自前 parser 26。`--check` 14・`--dry-run` 20・`--json` 49 が各自実装。`process.exit` 234 vs `exitCode=1` 75 の二流儀。entrypoint guard が 3 種。`main().catch` 127 回。generator/checker 9 組が 5 通りの失敗規約(`exit(1)` / `exitCode=1` / 独自 normalize …)。`sync_*` 7 本は `--check` 無しで drift 無防備。生成物 15+ のうち `.generated.` マークは 3。孤児実行体 74。

**実装**:

1. `scripts/lib/harness.ts`: `defineScript({ name, flags, run })` — argv、`--json/--dry-run/--quiet`、exit code、entrypoint guard、出力 printer を一本化。
2. `defineGenerator({ id, outputs, render })`: `--check` を 1 実装に。9 組 + `sync_*` 7 本を移行し、出力に generated ヘッダ/拡張子を強制。SX-07 の check registry に自動登録。
3. 孤児 74 本: 採用(registry 登録)か削除。`setup-report.ts` / `setup_report.ts` のような重複は削除。

**受入基準**: `process.argv` 直読 0、`process.exit` 直呼び 0(harness 経由のみ)、generator の `--check` 実装 1、孤児 0。

### SX-07: manifest-driven `pnpm check`(P1 / M)

**症状**: `check:*` 62、CI が走らせるのは 31、残り 32 は `pnpm validate`(39 連 `&&`、release.yml でしか走らない)だけ。`CONTRIBUTING.md:29` の「validate が green なら OK」は CI と乖離。pre-PR checklist は 187 行・45 項目・6 コマンドで、§6 は「ゲート機構自体のトラブルシュート表」。ラチェット/baseline 5 種が別々の場所。ci.yml は checkout/pnpm/node/install/build を 4 回複製。

**実装**:

1. `knowledge/product/governance/ci-gates.json`(id, script, scope=`pr|full|release`, baseline, owner, rationale)+ `pnpm check [--scope pr] [--only id] [--fix]`: 並列実行・単一サマリ・first-failure で隠れない。
2. `pnpm validate` はこのランナーの alias にし、CI の PR job も同じコマンドを叩く(乖離ゼロ)。
3. 走っていない 32 checker を promote / delete で判定。
4. baseline 5 種を `ci-gates.json` から参照する 1 形式に。
5. ci.yml の重複 setup を composite action に。
6. pre-PR checklist は「`pnpm check --scope pr` を打つ」1 行 + 例外表のみに縮約。

**受入基準**: PR に必要な手順 1 コマンド。CI と `validate` の check 集合が同一(機械検証)。

### SX-08: 意図解釈の一本化と UX 契約の描画(P1 / L)

**症状**: 自由文の解釈が 6 実装 — `runSurfaceMessageConversation`(7 surface 採用)、voice-hub `generateReply`(`server.ts:4346-4525`、独自ヒューリスティック梯子を shared orchestrator の **前** に置き、concierge 主経路と presence-studio がこれを経由)、`kyberion intent`(procedure catalog)、`cli intent`(`resolveIntentResolutionPacket`)、`run_intent.ts`(同関数だが後続が別)、`resolveAndExecuteIntent`。concierge は voice-hub の生死で contract shape が変わる(`api/message/route.ts:150-156`)。`IntentResolutionContract`(4 問の構造化)は全ターンで計算されるが描画は TUI と `kyberion_home` のみ。`validateSurfaceUxContract` の `approval_required` 分岐は呼び元ゼロ。chronos は `query: 'はい'` を確認プロトコルにハードコード(`page.tsx:1026`)。

**実装**:

1. voice-hub `generateReply` の梯子を撤去し、voice 固有能力(location/weather/browser 会話)は intent catalog の handler として shared orchestrator に登録。concierge は orchestrator 直結、voice-hub は音声 I/O 専任に。
2. `intent` 系 CLI 3 本を `kyberion ask`(= orchestrator)+ `kyberion ask --explain`(contract 表示)に統合。`run_intent.ts` / `scripts/intent.ts` は inspection 用に改名。
3. 全 surface と 4 bridge で `result.intentResolution` を描画(理解/不足/次/成果)。bridge はテキスト整形、Web は構造化カード。
4. orchestrator `:2680` に `approval_required` を配線し、承認時の「待つ/却下の帰結 + unblock 手順」ルールを実際に発火させる。確認トークンを typed intent に(`'はい'` 直書き廃止)。

**受入基準**: 自由文解釈の入口 1(grep で他実装 0)。全 surface で 4 問が描画される contract test。承認応答の契約 test が本番経路で通る。

### SX-09: ChannelAdapter・viewer・vocabulary の統合(P1 / L)

**症状**: 4 bridge が同じ 7 段ターン(access → approval reply → mission proposal → thread ctx → typing → conversation → 分岐 → error)、同じ 20 行 outbox drain、discord/telegram で 90 行の thread 履歴コードを複製。`SurfaceAsyncChannel = string` で telegram/discord/imessage は `as any`。viewer/auth が chronos(472 行)/ concierge(227)/ presence-studio(481)/ computer-surface(28)で独立実装、shared `authorizeSurfaceMutation` を使うのは 2 surface。vocabulary lookup 6 実装(concierge は既定 locale が catalog と逆)。core read-model に英語文(`operator-home-summary.ts:560-604`)と日本語文(`ceo-surface-summary.ts:198-217`)が直書きされ、`next_action_ja` に英語が入るバグ。design tokens 3 箇所 byte 同一、status 色マップ 5 箇所、mission 操作の動詞集合 3 系統(互いに superset でない)、onboarding UI 2 実装。

**実装**:

1. `libs/core/channel-adapter.ts`: `ChannelAdapter { send, sendApproval, typing, threadContext, actorId }` + `runChannelTurn(adapter, msg)` + `drainSurfaceOutbox(surface, send)` + 共通 thread 履歴。4 bridge を移行し `SurfaceAsyncChannel` を manifest 由来 union に戻す。Slack 専用 `buildSlack*` fork は generic 版へ寄せる。
2. `resolveSurfaceViewer(req)`(loopback / bearer / token registry / tenant-org-project narrowing)を core に 1 つ。4 fork 削除。
3. vocabulary は `libs/core/t.ts` の browser-safe build 1 つに。chronos `ux-vocabulary.ts`(216 行)/ concierge `i18n.ts` 削除、operator-surface を catalog 化。
4. read-model は文言でなく vocabulary key + params を返す。`statusLabel` / `nextAction.title` / `status_ja` / `summary_ja` を key 化。
5. mission 操作は `surface-mission-steering.ts` の verb 集合を唯一に(TUI の `mission_controller.js` spawn と chronos `mission_control` action を置換)。chronos `/api/intelligence`(2,917 行)を headless operation manifest 配下の per-action route に分割。
6. read 経路は `createHeadlessEnvelope` に統一し typed fetch client を 1 つ提供(`{summary}` vs `{ok, summary}` 解消)。design tokens を 1 パッケージ、status 色は `renderStatus` に集約、onboarding UI は concierge `/setup` に一本化。

**受入基準**: bridge 実装行数 −500 以上、`as any` 0、viewer 実装 1、vocabulary API 1、core に自然言語リテラル 0(lint)、mission verb 集合 1。

### SX-10: actuator SDK と ABI 統一(P1 / L)

**症状**: `runActuatorCli` 採用 28/33 だが、それ以外は各自配線 — `executePipeline` 私的実装 12、`opControl` if/while 8、`PipelineStep` ローカル型 12、`MANIFEST_PATH` 30、`buildRetryOptions` wrapper 29、preflight 8 行ブロック 31、`OpSpecKind` ローカル型 28。結果 envelope が `failed/success/ok/error/denied` + `ok:boolean` の 6 流儀。`create_actuator.ts` は **第 4 の ABI**(`dispatchDecisionOp`、op-catalog 無し、registry 不可視)を生成し、`run_pipeline.ts:616-855` は 4 ABI を **エラーメッセージ文字列の一致** で判別。`describeOps` の戻り型が 3 種で `generate_op_registry.ts` が 30 個を手 import。op 入力契約は 514 op 中 66(4 domain)で 87% が未検証、wisdom の 79 op は `{type:'object'}` の空 schema。`run_pipeline.ts`(3,409 行)にライブラリ入口が無く、27 箇所が subprocess 起動で各自 stdout を parse。

**実装**:

1. `libs/core/actuator-sdk.ts`: `defineActuator({ id, ops: { [op]: { kind, input, handler } } })` — manifest path / retry policy / preflight / unknown-op error / control flow / result envelope / `describeOps` を id から導出。AR-09 の共通 recovery policy をこの上に載せる。
2. `create_actuator.ts` を SDK 出力に変更、`generate_op_registry.ts` は `libs/actuators/*/src/op-catalog.ts` の glob へ。`dispatchDecisionOp` 分岐と legacy direct-action fallback を `run_pipeline.ts` から削除(文字列判別の廃止)。
3. `executePipelineFile(path, opts)` を export し、27 spawn 箇所を置換。`full-health-report.json` 等の shell 経由 sub-pipeline は `core:include` に。
4. op 入力 schema を op-catalog 側に置き、`describeOps` の戻り型を共有型に(wisdom の `owner/idempotency/execution_kind` を共通化)。目標カバレッジ 100%。
5. `working-memory` を registry に登録、孤児 domain `codex/gemini/gh`(20 op)を削除。

**受入基準**: actuator ABI 1、`index.ts` の中央値 ≤ 40 行、op schema カバレッジ 100%、`run_pipeline.js` subprocess 起動 0(scripts 以外)。

### SX-11: ADF ライフサイクルと pipeline 語彙(P2 / M)

**症状**: `draft → preflight → auto-repair → commit → execute` を名前として持つコードが無い(4 モジュールに散在)。`validateAndRepairAdf`(AGENTS.md が必須と書く)本番呼び出し 0、実際は `attemptAutonomousRepair`。`check_golden_output.ts:113` と `libs/core/orchestrator.ts`(第二の legacy engine、`index.ts:757` で export)が検証を迂回。`system:exec/shell` 143 step(19%)、うち 68 がスクリプト包み(CLAUDE.md が禁ずるが guardrail 無し)、actuator を `node dist/libs/actuators/...` で直接起動する pipeline 4 本。`transform-script-oversized` は `warn`。`role`(1,529)vs `type`(19)、`produces`(565)vs `export_as`(72)、bare op 13 種 65 箇所(暗黙 `system:` 付与)、kebab 動詞 10、`cmd` vs `command`。末尾 `system:log` が 82/181 pipeline(全 step の 23%)。fragment 75 のうち未参照 22。`on_error` 利用 3/181。

**実装**:

1. `runAdfLifecycle(path, opts)` を 1 関数として export し 5 段を名前付きに。repair は 1 実装に統合(AGENTS.md も追従)。`orchestrator.ts` を `retired/` へ、`check_golden_output` を validated path に。
2. guardrail: `system:exec/shell` が `node dist/` `npx tsx` `pnpm exec` `dist/libs/actuators/` を指す場合 error。`transform-script-oversized` を error に。
3. 語彙統一: `role` のみ、`produces` のみ、namespace 必須、snake_case、`command` のみ。`normalizePipelineOp` の alias 10 件を削除。
4. engine が run summary を出し、末尾 `system:log` を撤去。未参照 fragment 22 を削除。

**受入基準**: ライフサイクル関数 1、repair 実装 1、スクリプト包み `system:exec` 0、alias 0、pipeline step 数 −15%。

### SX-12: god module 分割と重複概念の統合(P2 / XL)

**症状**: `mission-orchestration-worker.ts` 7,012 行 / 22 export(private 6,700 行がテスト不能)、責務 12 種(既に import している `worker-goal-driver` `mission-gate-engine` `planning-packet-contract` … へ戻すだけで良い)。`mission-workitem-dispatch.ts` 3,479 行 / 実質 1 関数。`organization-operating-model.ts` 3,360 行 / 118 export = 11 entity × CRUD 4 種の手書き(SX-04 の `RecordStore<T>` で表に畳める)。`surface-runtime-orchestrator.ts` に Slack 固有ロジック(`deriveSlackIntentLabel` 等)。`reasoning-backend.ts` に要件/設計/テスト DTO 約 35 型。`mission-lifecycle.ts` に認可(`grantMissionSudo`)と data migration。mission façade 4(`mission-lifecycle` / `-lifecycle-service` / `mission-system` / `mission-creation`)、read-model 5 名(`mission-read-model` / `operator-home-summary` / `ceo-surface-summary` / `buildOrganizationManagementView` / …)、40 行の状態遷移機が 2 コピー(`mission-status` / `gate-status`)、register/get/reset/failover/stub の seam パターンが 21 モジュールで手書き(`ScopedRegistry` 4 利用)。`adapters/` は 5 本の 6 行 re-export shim。`mission-team-composer.ts` は 1 行 alias。reasoning route resolver 5 本・cache 4 個。

**実装**(SX-02 green 後、各 1 PR):

1. `createSeam<T>()` で 21 seam を統一。`RecordStore<T>`(`ScopedRegistry` 拡張)で 65 registry/store/ledger を移行、`organization-operating-model` を entity descriptor 11 件の表に。
2. `mission-orchestration-worker` を import 先モジュールへ分配、`dispatchMissionNextTasks` を `mission-workitem-dispatch` に委譲。
3. mission façade 4→1、read-model は `mission-read-model` を合成する形に 1 本化、状態機械 2→1 の汎用 transition-table。reasoning resolver 5→1、cache 1。
4. `adapters/` を実体化(`agent-adapter.ts` を分配)、同形で `providers/<vendor>/`。`reasoning-backend.ts` から DTO を `contracts/` へ。
5. クラスタをディレクトリ化(`mission/` 57 files → `surface/` → `reasoning/` → `intent/` → `work/`(work-* と worker-* を統合)→ `voice/` → `video/`)、`src/` を統合。barrel を domain 別(`@agent/core/mission` …)に分割し `package.json exports` を生成、bare barrel import 691 箇所を codemod。

**受入基準**: 最大ファイル ≤ 1,500 行、`index.ts` ≤ 300 行、seam 手書き 0、`reset*Cache` export 90 → ≤ 10、bare barrel import 0。

### SX-13: 文書とナレッジの正本一本化(P1 / M)

**症状**: 状態正本 6(STATUS.ja.md / PRODUCTIZATION_ROADMAP / ROADMAP / ROADMAP_COMPLETION_LEDGER / CHANGELOG(2026-05-16 で停止)/ 2026-08 README)、STATUS と 2026-08 README の優先規則が正反対、STATUS.ja.md:3 は 4,271 文字 1 行。改善計画 182 本(docs/ の 58%)中 152 本が完了記述、frontmatter `status` は 3 本、`docs/archive/` は 6 本のみ。「Kyberion とは何か」を説明する文書 6(`enterprise-operating-kernel` と `organization-work-loop` は同日・同 importance・同冒頭)、onboarding 正本 8。Localization policy(英語正本)と実態(`.ja.md` 212 本中、英語版あり 4)が乖離し、AGENTS.md は別ルールを明記。`knowledge/_manifest.json` は tags 0 / summary 0 の inventory で retrieval index ではない。frontmatter 無し 273/813、`incident-UNKNOWN-mock-skill-*` テスト fixture 19 本、「None extracted automatically」24 本、同名重複 8 組。

**実装**:

1. 状態正本を `docs/developer/improvement-plans-2026-08/README.ja.md`(月次索引)+ 各計画の「実装状況」節に **1 本化**。`STATUS.ja.md` は 2026-07 の凍結台帳として表形式に整形、`ROADMAP.md` / `ROADMAP_COMPLETION_LEDGER.md` はアーカイブ、`CHANGELOG.md` はリリース手順に組み込むか削除。
2. 全計画に `status:` frontmatter を付与し、`implemented|completed` を `improvement-plans-archive/` へ移動(docs/developer 240 → <100)。AGENTS.md からのリンク切れを check。
3. 概念文書は `organization-work-loop.md` を入口、他 5 本を「補足」に降格。`COMPONENT_MAP.md:5-19` の 13 リンクを 1 つに。onboarding は QUICKSTART(SX-01)を正本に。
4. Localization policy を実態に合わせて改訂(「rules 英語 / 計画・運用文書 日本語」を正式化)し、英語名で日本語本文の 4 ロードマップに `.ja` を付ける。
5. Glossary を 3 階層(first-win 6 語 / contributor 約 30 語 / FDE 全語)に分割し README からリンク。未定義 5 語(mission context pack / handoff packet / semantic brief / knowledge card / design cascade)を追加または既存語へ統合。`work_shape` / `execution_shape` の説明衝突(MG-08 の文書側)を解消。
6. knowledge: `_manifest.json` を `_integrity-manifest.json` に改名し、retrieval は `knowledge-slices` 経由と README に明記。fixture 19 本・空 distill 24 本・重複 8 組を削除。frontmatter 無し 273 本は付与するか slice で除外。

**受入基準**: 「正本」を名乗る状態文書 1、完了計画のアーカイブ率 100%、Glossary 3 階層、knowledge の frontmatter カバレッジ 100%(または除外明示)。

### SX-14: UX 契約の執行(P2 / S)

**症状**: `USER_EXPERIENCE_CONTRACT.md` §Contract Test Hook の「内部語を漏らさない」検査は誰も走らせていない。README は外部 4 語 0/4、`actuator` 11 回。`QUICKSTART.md:15-19` は初画面で Actuator/ADF を紹介。`OPERATOR_UX_GUIDE` §4 は「バックエンドモデルを説明する方法」(契約と逆)。`surface-roles.json` の `tagline_key` は 5 surface 中 1。`env-registry.json` は 426 変数中 documented 53、`required` 0(validator が構造的に error を出せない)、regex 由来の偽変数 7、`*_TOKENS` を secret 誤分類。

**実装**:

1. `check:ux-contract-docs`: README / QUICKSTART / OPERATOR_UX_GUIDE に対し内部限定語(mission / actuator / ADF / packet / ledger / capability bundle)を fail、外部 4 語の出現を require。前扉 3 文書を書き直す(内部語は「開発者向け」節にのみ許可)。
2. `surface-roles.json` 全 surface に `tagline_key`。
3. `generate_env_registry.ts` の分類・偽変数を修正、`required: true` を実際に必須な変数へ付与し `validateEnv` を起動時に実行(diagnostics 専用を脱する)。

**受入基準**: 3 文書が lint green、env validator が実際に error を出せる。

---

## 4. Wave ゲート(進行条件)

| Wave              | 完了条件(次 Wave 着手のゲート)                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 0(SX-01)          | clean-clone first-win CI job が green                                                                                      |
| 1(SX-02/03/04/13) | 方向違反・cycle が baseline 化され減少中。foundation 5 パターンの再発 lint が有効。catalog loader 移行率 ≥ 50%。状態正本 1 |
| 2(SX-05/06/07)    | `pnpm check --scope pr` が CI と同一集合。`kyberion --help` で全ユーザーコマンド発見可能。npm scripts ≤ 120                |
| 3(SX-08/09/10)    | 自由文解釈の入口 1。4 bridge が `runChannelTurn`。actuator ABI 1                                                           |
| 4(SX-11/12/14)    | 最大ファイル ≤ 1,500 行、barrel ≤ 300 行、UX 契約 lint green                                                               |

各 Wave は [orchestrator-review working mode](../../../knowledge/product/governance/working-philosophy.md) 準拠: subagent が実装、ファイル所有を分離、task 単位 commit、Wave 末に横断レビュー。

---

## 5. 削減目標(ラチェットとして CI に固定)

> **2026-08-25 実測更新**: 以下の初期値は監査時点のスナップショットとして保持する。実装波後の検証値は、空白を含まない厳密な `JSON.parse(safeReadFile(` と空白許容パターンがともに **0 occurrences**、foundation 外の自前 `new Ajv(` が **0 occurrences**、`process.env.KYBERION_*` の non-test が **0 occurrences**、旧式JSONL append が **0 occurrences**、`defineCatalog` が **65 core implementations**、import boundary は **177 cycles / 114 direction violations** となった。JSON/env/Ajv/JSONL の foundation adoption とCLI未知コマンドのfail-closed化は完了したが、私的 text helperの意味統合、全catalogのschema根統合、cycle削減、CLI/harness全移行は未完のため、SX-03〜07は引き続き PARTIAL とする。

| 指標                                                     | 現状  | 目標   | 担当     |
| -------------------------------------------------------- | ----- | ------ | -------- |
| `JSON.parse(\s*safeReadFile(`（空白許容）                | 0     | 0      | SX-03    |
| 自前 `new Ajv(` (foundation 外)                          | 0     | 0      | SX-03/04 |
| `process.env.KYBERION_*` 直読                            | 0     | 0      | SX-03    |
| 旧式 JSONL append (`safeAppendFile*` + `JSON.stringify`) | 0     | 0      | SX-03    |
| 手書き catalog loader                                    | ~151  | 0      | SX-04    |
| schema 無し governance catalog (root)                    | 157   | 0      | SX-04    |
| npm scripts                                              | 325   | ≤120   | SX-05    |
| CLI 入口                                                 | 5     | 1      | SX-05    |
| doctor/preflight 実装                                    | 11    | 1      | SX-05    |
| `process.argv` 直読 script                               | 371   | 0      | SX-06    |
| `check:*` で CI 未実行                                   | 32    | 0      | SX-07    |
| PR 前に打つコマンド                                      | 6     | 1      | SX-07    |
| 自由文解釈の実装                                         | 6     | 1      | SX-08    |
| `IntentResolutionContract` 描画 surface                  | 2/12  | 12/12  | SX-08    |
| viewer/auth 実装                                         | 5     | 1      | SX-09    |
| vocabulary lookup 実装                                   | 6     | 1      | SX-09    |
| actuator ABI                                             | 4     | 1      | SX-10    |
| op 入力 schema カバレッジ                                | 13%   | 100%   | SX-10    |
| `system:exec` スクリプト包み                             | 68    | 0      | SX-11    |
| 最大ファイル行数                                         | 7,012 | ≤1,500 | SX-12    |
| `index.ts` barrel 行数                                   | 2,691 | ≤300   | SX-12    |
| 状態「正本」文書                                         | 6     | 1      | SX-13    |
| docs/developer 配下 md                                   | 240   | <100   | SX-13    |
| README の外部 4 語カバレッジ                             | 0/4   | 4/4    | SX-14    |

---

## 6. 非目標・リスク

- **非目標**: 機能追加、性能改善、新 surface。意図ループ 6 段・tier 隔離・mission 制御の **不可換部分は一切変えない**(§1 原則 1 の codemod は挙動同値を test で担保)。
- **リスク: 大規模 codemod の回帰** — 各 codemod は 1 パターン 1 PR、既存 test(core 749 本)+ `pnpm check --scope full` を通す。挙動差が疑われる箇所は codemod 対象から外し手動で扱う。
- **リスク: 並行開発との衝突** — SX-12 のディレクトリ移動は他計画の PR が閉じた窓で実施(git mv のみの PR、ロジック変更を混ぜない)。
- **リスク: 「共通化のための共通化」の再発** — 新規抽象は §2 太字の 7 個(foundation / defineCatalog / CLI registry / defineScript+defineGenerator / ci-gates / ChannelAdapter / defineActuator)に限定し、それ以外は既存 helper への adopt-or-delete のみ。追加提案は本計画の改訂として議論する。

---

## 7. 実装状況

| ID    | 状態        | 備考                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SX-01 | IMPLEMENTED | `check:first-win-docs` と 3 文書の機械検証を追加。clean-clone の実行証跡は未完。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SX-02 | BASELINED   | 4 層宣言、cycle/方向チェッカー、baseline ratchet を追加。既存違反は baseline 内。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SX-03 | PARTIAL     | `foundation/{ajv,json,env,text,time}` を追加し、旧JSON読み込み・env読み取り・JSONL appendをfoundation経由へ移行。`env-validator` の互換APIも foundation parser へ委譲し、provider-health/operator-identity/locale/format/generation-quota/ingest-quota/browser-onboarding、system focus、history index、work graph、retention catalog、lifecycle hooks、plugin pack、curation/feedbackおよび補助scriptのruntime JSON読み込みも `readJson` へ寄せた。foundation adoption checkはJSON/Ajv/env/JSONLを全て0で固定したが、専用状態パーサー等の同形JSON読込が本番コード37ファイル残り、意味の異なる私的text/clamp helperの統合とsecure-ioの残存低レベル経路整理も未完。 |
| SX-04 | PARTIAL     | `defineCatalog<T>()` を追加し、対象policy loaderをschema付きへ移行。CLI registry、mission review gate、service bootstrap catalog、approval policy、reasoning level/backend policyも共通ローダーへ移行し、customer overlayの既存入力形式をschemaへ反映した。governance rootにはschemaまたはdocumentation_only分類のないJSONが157件残り、全loader移行・schema根統合・未参照catalog処分は未完。                                                                                                                                                                                                                                                                       |
| SX-05 | PARTIAL     | command registryを`id/noun/verb/entry/audience`単位へ拡張し、schema検証・entrypoint route整合性・未知commandのfail-closedを追加。doctor統合、alias削減、npm scripts 325→120以下は未完。                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SX-06 | PARTIAL     | `defineScript`/`defineGenerator` と harness test を追加し、script ごとの `flags` 宣言を可能にした。pseudo-locale / vocabulary-types / env-registry / op-registry / model-registry / intent-contract-memory / deterministic checkers / pii-rules / trace-docs / capability-seams / subagent-definitions / doctor / CLI manifest checker を共通 harness へ移行。生成器の出力宣言・比較正規化・実行コンテキストも共通化した。既存 script 全移行は未完。                                                                                                                                                                                                               |
| SX-07 | PARTIAL     | manifest-driven `pnpm check` とPR workflow gateを追加し、未知scope・空集合・scope外`--only`・未知flagをfail-closed化。pnpm区切り`--`とJSON error出力も固定した。CIの個別checker重複と全checker集合のmanifest統合は未完。                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SX-08 | PARTIAL     | voice の旧梯子を削除し共有 `generateReply` を入口化。voice-hub の `replyText` と `IntentResolutionContract` を Concierge へ伝播し、clarification/approval の shape と next action を描画可能にした。Chronos `/api/agent` も契約を構造化 JSON と A2UI section へ出し、承認UIは `action: approve_mission` を送るようにした。`kyberion ask --explain` も同じ共有入口の契約を表示する。旧 `intent` 系CLIの整理、4 bridge以外の全surface描画、approval本番経路接続は未完。                                                                                                                                                                                              |
| SX-09 | PARTIAL     | `ChannelAdapter`/`runChannelTurn` を追加し、4 bridgeの共通turn lifecycleとthreadContextを採用。provider-neutralなthread formatterと、text-only channelへapproval/clarificationのnext action・consequenceを配送する共通formatterを追加し、4 bridgeの会話入口から不要な `as any` キャストを除去した。viewer resolver 3系統、bridge固有thread履歴、read-model・配送統合は未完。                                                                                                                                                                                                                                                                                       |
| SX-10 | PARTIAL     | `runActuatorCli` を SDK dispatch へ移行し、`executePipelineFile()` と html-to-pptx の in-process 経路を追加。全 ABI/schema 統合は未完。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SX-11 | PARTIAL     | `runAdfLifecycle` と canonical repair を実行入口へ接続し、`core:include` に fragment context/result envelope を追加。raw command形式に加えて`command + args`形式の`node dist`/`pnpm exec`/`npx tsx` wrapperも拒否するguardrailを追加した。super-nerveの重複repair・語彙移行は未完。                                                                                                                                                                                                                                                                                                                                                                                |
| SX-12 | PARTIAL     | 21 seam の生成入口を `createSeam<T>()` に統一。god module/store/façade の分割は未着手。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SX-13 | PARTIAL     | 2026-08 計画群36文書へ metadata checker/gate を追加し frontmatter を補正。状態正本・知識コーパス整理は未完。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SX-14 | PARTIAL     | front-door UX contract lint と env registry 品質修正を追加し、enabled surface の `tagline_key` が語彙 catalog に存在することをPR gateで検査。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 参照

- 監査で参照した主要ファイル: `libs/core/index.ts`, `libs/core/schema-loader.ts`, `libs/core/secure-io.ts:187`, `libs/core/env-validator.ts:120`, `libs/core/scoped-registry.ts`, `libs/core/config-fallback-registry.ts`, `scripts/cli.ts:137`, `scripts/run_pipeline.ts:616-882`, `scripts/create_actuator.ts:116-195`, `libs/core/adf-repair-agent.ts:48`, `satellites/voice-hub/server.ts:4346-4525`, `libs/core/surface-runtime-orchestrator.ts:2345,2680`, `libs/core/ceo-surface-summary.ts:228`, `eslint.config.js:151-249`, `.github/workflows/ci.yml`, `docs/INITIALIZATION.md:46-123`
- 先行計画: [AR-09](../improvement-plans-2026-07/AR-09_ACTUATOR_COMMONIZATION.ja.md)(actuator 共通実行境界 — SX-10 はその上に SDK を載せる)、[ENTITY_GOVERNANCE_UNIFICATION](./ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md)(SX-04 の scope 二重定義解消と整合)、[MISSION_GATE_COHERENCE MG-08](./MISSION_GATE_COHERENCE_PLAN_2026-08-10.ja.md)(SX-13 の語彙衝突の文書側)、[REGISTRY_SPLIT_PLAN](../REGISTRY_SPLIT_PLAN.md)(SX-04 の互換 snapshot 期限)
