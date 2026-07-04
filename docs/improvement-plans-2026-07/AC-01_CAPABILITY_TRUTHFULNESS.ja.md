# AC-01: 能力の正直さ — 能力プローブ全数化とカタログ/実装の整合

> 優先度: **P0** / 規模: M / 依存: なし / 関連: IP-04(参照整合)、AC-06(スタブ整理)

## 背景と課題

「その能力が今この環境で本当に使えるか」をシステムが正しく申告できていない。宣伝(カタログ/manifest)と実装と実行環境の3者がずれている。

- **能力プローブが 6/29 のみ**: `libs/core/src/actuator-capability.ts` が実環境チェックを持つのは browser/voice/vision/media/system/gemini-cli の 6 つだけ。**残り全アクチュエータはフォールバックで全 op を無条件 `available: true`**(`:81-86`)にしている。結果、実行時に `Missing runtime prerequisite` が **48 回**、`playwright not installed` / `spawn playwright ENOENT`、`capability 'browser-actuator' unavailable` などが未分類エラーレジストリに蓄積している(`active/shared/tmp/unclassified-error-registry.json`)。
- **具体例**: `code:semgrep_scan` は実装済み(`libs/actuators/code-actuator/src/code-pipeline-helpers.ts:267,275`)だが `spawnSync('semgrep', …)` は PATH に semgrep が無いと実行時に初めて落ちる。プローブが無いので事前検知できない。
- **カタログドリフト**: `CAPABILITIES_GUIDE.md:5` は「Total Actuators: 28」だが `libs/actuators/` は 30 ディレクトリ。**working-memory-actuator は manifest に 14 op を持つ完全実装なのにカタログ未掲載**。評価レポート(`docs/verification/evaluation_report.md`)の V-6-05「脆弱性スキャン未実装」も semgrep_scan 実装後の現状に対して陳腐化している。
- **manifest/型と実装のドリフト**: blockchain-actuator の型には `verify_anchor` があるが dispatch は未実装で default throw(`libs/actuators/blockchain-actuator/src/index.ts:25,79-81`)。service-actuator の旧 STREAM モードと network-actuator の旧 gist トランスポートは AC-06 で削除済み。

## ゴール(受入条件)

1. 全アクチュエータについて、manifest 宣言 op ごとに「実行環境で使えるか(binary/プラットフォーム/env/外部サービス)」をプローブでき、`available:false` には理由と充足手順(prerequisites)が付く。
2. 未充足の能力は実行前に分類済みエラー(「semgrep が未インストール。`brew install semgrep`」)として返り、`Missing runtime prerequisite` の未分類流入が止まる。
3. `CAPABILITIES_GUIDE.md` が manifest から再生成され、実体と一致する(30 dirs 中、掲載すべき 29 + retired 1 の扱いが明記される)。生成ドリフトを CI で検出する。
4. 実装の無い宣伝(verify_anchor)は AC-06 で処置されるまで、プローブが `available:false, reason:'not_implemented'` を返す。旧 STREAM / gist は削除済み。

## 実装タスク

### Task 1: manifest への前提条件宣言の導入 — `claude-sonnet-4`

1. `libs/actuators/*/manifest.json` のスキーマに `prerequisites` ブロックを追加する(例: `{ "binaries": ["semgrep"], "platforms": ["darwin"], "env": ["KYBERION_SMTP_HOST"], "services": ["comfyui"] }`)。スキーマは `schemas/` の既存 manifest スキーマを拡張し、`check:catalogs` の検証対象に含める。
2. 既知の前提を各 manifest に記入する(調査で判明している分): code→semgrep(op 単位)、browser/meeting-browser-driver→playwright、calendar/email(create_draft)→darwin、media-generation→ComfyUI 到達性、voice→プラットフォーム別エンジン、system の applescript 系→darwin。
3. 全 manifest が新スキーマで valid であることを確認。

### Task 2: 汎用プローブの実装 — `claude-sonnet-4`

1. `actuator-capability.ts` のフォールバック(`:81-86`)を、Task 1 の `prerequisites` を評価する汎用プローブに置換する: binary は `which` 相当、platform は `process.platform`、env は存在チェック、service は既存の到達性チェック(ComfyUI 等)を流用。宣言が無い op は従来どおり `available:true`(挙動互換)。
2. 既存の 6 個別プローブは残し、汎用プローブと合成する(個別が優先)。
3. unit test: prerequisites の各種別について available/unavailable の判定と reason 文字列を検証。

### Task 3: 実行前ゲートへの接続 — `claude-sonnet-4`

1. パイプライン実行(`run_pipeline` の step 実行前)とアクチュエータ CLI(IP-05 の共通ランナーがあればそこ、無ければ各 dispatch 冒頭)で、対象 op のプローブ結果が unavailable の場合に「理由 + 充足手順」を含む分類済みエラーを返す。
2. `unclassified-error-registry` に落ちていた `Missing runtime prerequisite` 系がこの分類に吸収されることを、代表 2 ケース(semgrep 無し、playwright 無し)の再現テストで確認する。
3. doctor / `control_plane_cli` の診断に「能力サマリ(available/unavailable と理由)」表示を追加する。

### Task 4: カタログ再生成と CI ゲート — `claude-sonnet-4`

1. `CAPABILITIES_GUIDE.md` を manifest 群から生成するスクリプトが存在するか確認する(「generated from manifest.json」と自称している)。あれば実行して working-memory-actuator を含む 29 掲載へ更新、無ければ `scripts/generate_capabilities_guide.ts` を新設する(表形式は現行踏襲、prerequisites 列を追加)。
2. `check:catalogs` に「生成結果とコミット済みガイドの一致」検査を追加(ドリフトで fail)。
3. `docs/verification/evaluation_report.md` の V-6-05 に「semgrep_scan 実装済み・実ギャップは前提条件」の追記(1行、日付付き)。

### Task 5: 検証 — `claude-haiku`

- `pnpm validate` 通過、`pnpm test:unit` 通過、semgrep を PATH から外した状態で `code:semgrep_scan` 実行 → 充足手順付きエラーが返ることを確認して報告。

## リスクと注意

- プローブの過剰厳格化で「実は動くのに unavailable」となる誤判定は体験を悪化させる。**宣言が無ければ available** のフェイルオープンを維持し、宣言は確実なものから足す。
- ComfyUI 等ネットワーク到達性のプローブは起動毎に走らせず、TTL 付きキャッシュ(既存の provider-cache の仕組みに相乗り)にする。

## 実装メモ

### 完了スライス — 2026-07-05

- **Task 1 補完**: manifest スキーマに `implemented: false` マーカーを追加(宣言のみで dispatch 未実装の op 用)。`blockchain-actuator` の `verify_anchor` に適用し、汎用プローブが `available:false, reason:'not_implemented'` を返す(受入条件4)。calendar / email(create_draft)の darwin 制約は既存の `platforms` 宣言を汎用プローブが評価することを確認済み(追加宣言不要)。
- **Task 3-2 補完**: 実行前ゲートの e2e 再現テストを `run_pipeline.test.ts` に追加(`blockchain:verify_anchor` step が dispatch 前に `capability ... unavailable: not_implemented` の分類済みエラーで停止)。`actuator-capability.test.ts` に `implemented:false` の unit テストを追加。
- **Task 3-3**: `pnpm doctor` は required capabilities の充足状況と欠落時の next step を表示済み(確認)。
- **副産物(重要)**: `libs/core/src/` に gitignore された古いコンパイル済み `.js` が 82 個残っており、vitest の ESM 解決が `.ts` ではなく stray `.js` を拾ってテストが古いコードを検証していた。全て削除(`.ts` 対応物の存在を確認済み)。scripts/ の追跡済みミラー `.js`(`run_pipeline.js` 等4本)は main 由来の既存パターンのため温存 — 生成同期の統一は IP-12 のスコープ。
- **残余(意図的)**: `services` prerequisite(ComfyUI 等の到達性)は専用プローブ未実装のため未宣言のまま(宣言すると常時 unavailable になる)。meeting-browser-driver の playwright は npm モジュール解決依存で binary プローブでは表現不能のため未宣言(fail-open 原則)。両者は AC-04 / AC-06 で引き取る。

### Task 1-2 representative slice — 2026-07-03

- `schemas/actuator-manifest.schema.json` に `capabilities[].prerequisites` を追加した。`binaries` / `platforms` / `env` / `services` / `install` を宣言できる。
- `libs/core/src/actuator-capability.ts` の fallback を、manifest prerequisites を評価する汎用プローブへ置換した。宣言が無い capability は従来どおり `available:true` のまま。
- 既存の個別プローブがある actuator は、個別プローブ結果と manifest prerequisites を op 単位で合成する。
- 代表ケースとして `libs/actuators/code-actuator/manifest.json` の `semgrep_scan` に `semgrep` binary prerequisite と install hint を追加した。
- 検証:
  - `pnpm exec vitest run libs/core/src/actuator-capability.test.ts`
  - `pnpm exec vitest run libs/core/src/actuator-capability.test.ts scripts/run_doctor.test.ts`
  - `pnpm run typecheck`
  - `pnpm run check:catalogs`
  - `pnpm --filter '@agent/core' build`
  - `pnpm run build:repo`
  - `pnpm capabilities` (`semgrep_scan` は現環境では semgrep が PATH にあるため available)

### Task 3 representative slice — 2026-07-03

- `scripts/run_pipeline.ts` の actuator dispatch 直前に manifest capability gate を追加した。
- 対象 op が manifest に存在し、probe 結果が `available:false` の場合は `capability <domain>:<op> unavailable: ... Prerequisites: ...` の分類可能なエラーで実行前に停止する。
- manifest に対象 op が無い場合は既存互換のため通す。
- 検証:
  - `pnpm run typecheck`
  - `pnpm exec vitest run scripts/run_pipeline.test.ts libs/core/src/actuator-capability.test.ts libs/core/error-classifier.test.ts`
  - `pnpm --filter '@agent/core' build`
  - `pnpm run build:repo`
  - `pnpm pipeline --input pipelines/storage-janitor.json --context '{"dry_run":true}'`

### Task 4 representative slice — 2026-07-03

- 既存の `scripts/sync_component_inventory.ts` が `CAPABILITIES_GUIDE.md` 生成元であることを確認し、生成表に `Prerequisites` 列を追加した。
- `pnpm exec tsx scripts/sync_component_inventory.ts` を実行し、`CAPABILITIES_GUIDE.md` を 29 current / 1 legacy の現行 manifest 状態へ更新した。`working-memory-actuator` が掲載され、`code-actuator` には `bin:semgrep` が表示される。
- `scripts/check_catalog_integrity.ts` に `CAPABILITIES_GUIDE.md` の actuator 数・掲載漏れ・Prerequisites 列のドリフト検査を追加した。
- `docs/verification/evaluation_report.md` の V-6-05 を、semgrep_scan 実装済み/残ギャップ prerequisites の `PARTIAL` 状態へ更新した。
- 検証:
  - `pnpm run typecheck`
  - `pnpm run build:repo`
  - `pnpm exec vitest run libs/core/src/actuator-capability.test.ts`
  - `pnpm run check:catalogs`
