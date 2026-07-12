# IP-12: スクリプト実行モードの統一と baseline-check 高速化

> 優先度: P2 / 規模: M / 依存: なし / 関連: IP-04(参照整合チェック)

## 背景と課題

### 実行モードが 3 系統併存

1. **コンパイル済み**: 113 の npm script が `node dist/scripts/*.js`
2. **ts-loader**: 34 の npm script が `node --import ./scripts/ts-loader.mjs scripts/*.ts`
3. **tsx フォールバック**: `scripts/run_pipeline.ts:803,832` が失敗時に `node --import tsx scripts/run_pipeline.ts` を spawn

問題:

- tsx は devDependency のため、**dist のみの本番配置ではフォールバックが黙って起動不能**。しかもフォールバックは未コンパイルの `.ts` を実行するため、dist が古いと**同一コマンドが別バージョンのコードを実行**し得る。
- `run_pipeline.ts:796-819` と `:825-845` はほぼ同一のコピペ(else 分岐と catch 分岐)。
- ts-loader 専用スクリプト(`sync:service-endpoints`, `task:*`, `customer:*`, `create:actuator` 等)は dist にビルドされないため、`pnpm build` は「全コマンドが動く」ことを保証しない。
- 逆に、ソース削除後も古い dist 成果物が残って動き続ける(`dist/scripts/run_janitor.js` 等。IP-04 参照)。

### baseline-check がセッション開始のたびに二重コールドスタート

`pipelines/baseline-check.json` は 1 ステップの `system:shell: node dist/scripts/run_baseline_check.js`。つまり毎セッション開始時に:
`node`(run_pipeline: @agent/core・Ajv・Trace・feedback loop をロード)→ **子 `node` を spawn**(run_baseline_check: @agent/core を再ロード)→ L0-L6 同期実行(`scanTenantDrift()` と `runCoworkHealthCheck()` を毎回フル実行、`run_baseline_check.ts:83,96-144`)。

## ゴール(受入条件)

1. tsx フォールバックの重複コードが 1 箇所に統合され、「dist が無い/古い場合」の挙動が明示的(警告ログ + 明確なエラー)になる。
2. 「どの npm script がどのモードで動くか」の規約が 1 つに定まり(推奨: 開発時 ts-loader / 配布時 dist の二本立てを維持しつつ、**両モードで全スクリプトが動くこと**をチェックで保証)、`pnpm build` 後の dist に全実行対象が含まれる。
3. `build` に stale dist の掃除(`clean`)が入り、削除済みソースの亡霊実行が起きない。
4. baseline-check のセッション開始所要時間が計測され、二重 spawn の解消などで短縮される(目標: 現状比 50%)。

## 実装タスク

### Task 1: run_pipeline のフォールバック統合 — `claude-sonnet-4`

1. `run_pipeline.ts:796-819` と `:825-845` を読み、共通ヘルパー `spawnTsFallback(reason: string)` に抽出する。
2. フォールバック実行時に `logger.warn` で「dist ではなくソースを実行している」ことと理由を必ず出す。tsx が解決できない場合は「pnpm build を実行せよ」という明確なエラーで exit する(黙って失敗しない)。
3. 既存テスト + `pnpm pipeline --input pipelines/baseline-check.json` の手動実行で確認。

### Task 2: ビルド完全性の保証 — `claude-sonnet-4`

1. `tsconfig.json` の include を確認し、ts-loader 専用だった 34 script が dist へビルドされるようにする(除外されている理由があるもの — 例: 型エラーで除外 — は棚卸しして表にする)。
2. `package.json` に `clean`(`rm -rf dist` 相当。ただしプラットフォーム非依存に `node -e` か既存ユーティリティで)を追加し、`build` の先頭に組み込む。CI のビルドキャッシュへの影響を確認する。
3. IP-04 の `check_script_integrity.ts` に「dist 参照 script のソース存在」チェックが入るため、ここでは「ソースがあるのに dist に出ない」方向の検証を `check:esm` あるいは新チェックに追加する。

### Task 3: baseline-check の計測と高速化 — `claude-sonnet-4`

1. 現状の `pnpm pipeline --input pipelines/baseline-check.json` の所要時間を 3 回計測して記録する(ベースライン)。
2. 二重 spawn の解消: `run_baseline_check` を `system:shell` で子 spawn する代わりに、(a) パイプラインを介さず直接 `node dist/scripts/run_baseline_check.js` を正とする(CLAUDE.md/AGENTS.md の記述更新を含む)か、(b) run_pipeline に in-process 実行の op を足すか、を比較し **(a) を既定案**として実施する。※ AGENTS.md の変更は 1 行(起動コマンドの置換)に留め、lifecycle の意味は変えない。
3. `run_baseline_check.ts` 内部のレイヤ実行(`:96-144`)で、`scanTenantDrift()` / `runCoworkHealthCheck()` に結果キャッシュ(`active/shared/runtime/` に TTL 付き、例: 1 時間)を導入できるか確認し、レポートに `cached: true` を明示する形で実装する。**キャッシュ不整合が怖い L0(git 状態)等はキャッシュ対象にしない**。
4. 変更後の所要時間を同条件で計測し、before/after を本文書末尾に追記する。

### Task 4: 実行モード規約の文書化 — `claude-haiku`

- `docs/developer/LOCAL_DEV.md` に「スクリプト実行モード」の節を追加: dist(正)/ ts-loader(開発)/ tsx フォールバック(緊急時のみ・警告付き)の使い分け、`pnpm build` が保証する範囲、新しい script を足すときのチェックリスト(両モードで動くこと、`check:script-integrity` が通ること)。

## 実装メモ

- Task 1/2/3/4 は実装済み。
- `run_pipeline.ts` / `run_pipeline.js` の tsx フォールバックは共通ヘルパーに集約した。
- `package.json` の `clean` は `scripts/clean.ts` 経由に移し、`build` の先頭で stale `dist/` を掃除するようにした。
- `pipelines/baseline-check.json` は `system:exec` で `node dist/scripts/run_baseline_check.js` を直接起動する。
- `scripts/run_baseline_check.ts` は `scanTenantDrift()` / `runCoworkHealthCheck()` を `active/shared/runtime/baseline-check-cache/` に TTL 1 時間でキャッシュし、`cache.tenant_drift.cached` / `cache.cowork_health.cached` を report に含める。
- `scripts/check_script_integrity.ts` は script source と build output の両方を検査する。
- `docs/developer/LOCAL_DEV.md` に script execution mode の節を追加した。
- baseline-check 実測(2026-07-03、`/usr/bin/time -p pnpm pipeline --input pipelines/baseline-check.json`)。
  - before: `real 1.92 / 0.96 / 0.96`(shell 経由)
  - after: `real 1.11 / 0.96 / 0.96`(direct exec + cache warm-up)
  - 2 回目以降の after: `real 0.96 / 0.96 / 0.96`
- 目標の「50%短縮」には届いていないが、二重 spawn の解消と cached report は実装済み。

## リスクと注意

- baseline-check はセッション開始ゲート(CLAUDE.md §3)なので、**変更中も常に動く状態を維持**する。(a) 案では `pipelines/baseline-check.json` 自体は互換のため残す(直接コマンドへの thin wrapper のまま)。
- キャッシュ導入は「劣化した状態を all_clear と誤報する」リスクと引き換え。TTL は短めに始め、キャッシュ対象は「変化が遅く、失敗時の影響が小さい」レイヤに限定する。
