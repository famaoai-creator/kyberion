# IP-14: リポジトリ衛生(ハードコードパス・死んだ共有ライブラリ・陳腐化ドキュメント)

> 優先度: P2 / 規模: S / 依存: なし

## 背景と課題(独立した小粒の債務の寄せ集め)

### A. ハードコードされた個人環境パス

- `libs/core/src/native-xlsx-engine/examples/gen_wbs.ts:458` — `/Users/motonobu.ichimura/Downloads/...xlsx`
- `libs/core/src/native-pptx-engine/examples/gen_project_plan.ts:496` — `/Users/motonobu.ichimura/Downloads/...pptx`
- `libs/actuators/media-generation-actuator/src/media-generation-helpers.ts:35` — `/Users/famaoai/Documents/comfy/ComfyUI/output`(env フォールバック付き・`governance-allow-abs-path` 注釈あり)
- `libs/actuators/media-generation-actuator/src/index.js:9` — 同パスだが**注釈なしのコンパイル済み `.js` がソースツリーにコミットされている**

### B. 死んだ/瀕死の共有ライブラリ

- `@agent/shared-business`(25 LOC)— import **0 件**
- `@agent/shared-nerve` — 1 件、`@agent/shared-network` — 1 件、`shared-media`/`shared-vision` — 各 3 件

### C. 追跡されているテスト成果物

- `test-results/.last-run.json` が git 追跡下(`.gitignore` は `coverage/` のみで `test-results/` 未記載)

### D. 野良ファイル

- `libs/actuators/voice-actuator/` 直下の scratch スクリプト: `mms-jp-test.py`, `ms-voice-test.py`, `singing-test.py`, `voice-bridge.py`
- `libs/actuators/vision-actuator/override.txt`(0 バイト)
- `tools/chronos-mirror/`(`public/` のみ。実体は `presence/displays/chronos-mirror-v2` で、置き去りの疑い)

### E. 陳腐化・自己矛盾ドキュメント

- `docs/DOC_INVENTORY.md`(2026-05-07)— 「root 19 ファイル・subdirs 4」と記載、実際は 34 ファイル・6 subdirs
- `docs/DOCUMENTATION_LOCALIZATION_POLICY.md` — 推奨する `docs/i18n/ja/` 構造が実在せず(実慣行は `.ja.md` 併置)、`/Users/famao/kyberion/...` という誤った絶対パスリンクを含む

## ゴール(受入条件)

A〜E がそれぞれ解消され、`pnpm build && pnpm lint && pnpm test:unit && pnpm validate` が通る。

## 実装タスク

### Task 1: パスと成果物(A・C)— `claude-sonnet-4`

1. examples 2 本の出力先を `active/shared/tmp/` 配下の相対パス(`pathResolver` 経由)に変更する。
2. `media-generation-helpers.ts:35` のフォールバックを `active/shared/tmp/comfy/output` に変更し(env 上書きは維持)、`governance-allow-abs-path` 注釈を除去する。ComfyUI 連携の実運用があるため、変更内容を PR/パッチ説明で明示し、`KYBERION_COMFY_OUTPUT_DIR` の設定手順を `docs/developer/LOCAL_DEV.md` 等の適所に 2 行追記する。
3. コミット済み `media-generation-actuator/src/index.js` は、対応する `.ts` が正であることを確認して削除する(dist ビルドで生成される経路を確認)。
4. `git rm --cached test-results/.last-run.json` + `.gitignore` に `test-results/` を追加。

### Task 2: 共有ライブラリの死活処置(B)— `claude-sonnet-4`

1. 各 `@agent/shared-*` について、静的 import に加えて**動的/文字列参照**(`grep -rn "shared-business\|shared-nerve\|shared-network" --include='*.ts' --include='*.json' libs/ scripts/ pipelines/ knowledge/product/ manifest` )を確認する。
2. 参照ゼロが確定した `shared-business` は `retired/libs/` へ移動し、workspace 定義(`package.json:15-22`, `pnpm-workspace.yaml`)・`build:packages` の filter から除去する。
3. 参照 1 件の `shared-nerve` / `shared-network` は、消費箇所が本当に使っているか読んで判断し、「利用実態あり=維持」「形骸=消費側を直して retire」を個別に決めて報告する。**この 2 つは削除まで進めず判断材料の提示まででもよい**。
4. `pnpm install && pnpm build && pnpm test:unit` で確認。

### Task 3: 野良ファイル(D)— `claude-haiku`

1. voice-actuator の `.py` 4 本: 参照 grep(scripts/pipelines/manifest/docs)でゼロを確認して削除。参照があれば `scripts/demos/` へ移動して参照を更新。
2. `vision-actuator/override.txt` を削除。
3. `tools/chronos-mirror/`: `grep -rn "tools/chronos-mirror"` で参照ゼロを確認して削除(参照があれば sonnet に差し戻し)。

### Task 4: ドキュメント鮮度(E)— `claude-sonnet-4`

1. `docs/DOC_INVENTORY.md`: 冒頭に「2026-05-07 時点のスナップショット(歴史的記録)」の注記を追加する(全面更新はしない。棚卸しは別途)。
2. `docs/DOCUMENTATION_LOCALIZATION_POLICY.md`: (a) `docs/i18n/ja/` 推奨の節を実慣行(`.ja.md` 併置)に合わせて改訂、(b) `/Users/famao/...` 絶対パスをリポジトリ相対リンクに修正。ポリシーの中身(English-first 原則、語彙カタログ)は変えない。
3. リンク切れ確認: 変更した 2 文書内の相対リンクを手繰って実在確認する。

## リスクと注意

- Task 1-2 の ComfyUI パス変更は、famaoai 端末での実運用に影響し得る。**挙動フォールバックの変更であることをレビュー時に必ず伝える**こと。
- shared ライブラリの retire は、`dist/` の既存ビルド成果物や `knowledge/product/orchestration/` のカタログに名前が残っていると `check:catalogs` で落ちる。`pnpm validate` まで回して確認する。
