# OP-03: インストールと配布 — first-win の玄関を通れるようにする

> 優先度: P1 / 規模: M / 依存: IP-04(死んだ init 参照)、UX-06(オンボーディング整合) / 関連: 評価レポート Install=30%(最下位)・D1(first-win)最優先ボトルネック
>
> **なぜ重要か**: 評価レポートの最優先課題。OSS 採用も FDE 導入も「まず動かせる」が入口。現状は玄関(`pnpm init`)が壊れ、`npx` は構造的に不可能。

## 背景と課題

- **`npx kyberion` が構造的に不可能**: `package.json:4` が `"private": true`、`bin` フィールド無し、`publishConfig` 無し。npm 公開できないため、評価レポート推奨の `npx kyberion init` ワンライナーは**スクリプトでなくパッケージング構造の作業**を要する。
- **文書化された `pnpm init` が壊れている**: `package.json:174-175` は `init`→`init-wizard`→`node dist/scripts/init_wizard.js` だが、`scripts/init_wizard.ts` も `dist/scripts/init_wizard.js` も**存在しない**(IP-04 が hygiene として記載済みだが、**「インストールの玄関が死んでいる」影響としては未整理**)。動く入口は `pnpm onboard`。
- **公式 Docker イメージ無し**(V-1-05 NOT_IMPLEMENTED)、かつ配布用の整備が薄い。(2026-07-03 レビュー訂正: `Dockerfile` は**既に真のマルチステージ**で、production ステージ(`:42-57`)は builder からビルド済み `dist/` + 依存を COPY し `pnpm prune --prod` するだけで **build/validate を実行時に走らせない**。`validate`+`build` は builder ステージのビルド時(`:30,:33`)に走る=正常。)残る正当な論点は狭い: builder の `COPY . .`(フルソース投入)と、`docker-compose.yml` が `development` ターゲット(source mount)しか定義しない点。
- **README のインストールは 4 段のソースビルドのみ**(`README.md:48-52`)。
- Python 音声依存(`requirements-voice.txt`: mlx-audio/mlx-whisper 等)は **macOS/Apple Silicon 志向**で、隠れたプラットフォーム制約。

## ゴール(受入条件)

1. `pnpm init`(または明確に文書化された単一コマンド)が実際に動くオンボーディング入口になる(死んだ `init_wizard` 参照の解消)。
2. `npx kyberion <cmd>` を可能にする構造(公開可能なパッケージ化 or 明示的に「private のままローカル bin を張る」代替)の判断と実施。少なくとも `bin` フィールドでローカル CLI エイリアスが張れる。
3. ビルド済みの動く Docker イメージ(ソースフルビルドをイメージ実行時に走らせない)が `docker compose up` で起動し、CLI/主要サーフェスが動く。
4. README のインストール手順が実態と一致し、first-win までの最短経路(依存の前提・所要時間・音声パスの macOS 制約)が明示される。

## 実装タスク

### Task 1: 玄関の修復(即効・小)— `claude-sonnet-4`

1. `package.json` の `init`/`init-wizard` を、実在する `onboarding_wizard.js`(= `pnpm onboard`)へ統一するか、`init_wizard` を onboard の薄いエイリアスとして新規作成する。IP-04 の死活判定と整合(重複作業を避け、IP-04 側の該当エントリはこの解決を参照)。
2. `README.md:48-52` と `docs/INITIALIZATION.md` の入口コマンドを、動くもの + `pnpm build` 前提の明示に修正(UX-06 Task 4 の「dist 欠落時ガイド」と連携)。
3. 検証: クリーン clone → 手順どおりで onboard 到達。

### Task 2: bin フィールドとローカル CLI — `claude-sonnet-4`

1. `package.json` に `bin: { "kyberion": "dist/scripts/cli.js" }` を追加。`private: true` は維持(公開は経営判断)しつつ、`pnpm link --global` でローカルに `kyberion` コマンドを張れるようにする。
2. `npx` 公開の是非(構想評価の「製品人格」判断に依存)を本文書末尾に論点整理として記載し、**公開自体は市村さんの判断事項**として実装しない(bin までで CLI 体験は改善する)。
3. cli.js が bin 経由(引数・cwd の扱い)で正しく動くことを確認。

### Task 3: 動く Docker イメージ — `claude-sonnet-4`

1. (Dockerfile は既に真のマルチステージ — 上記訂正)残る整備に絞る: builder の `COPY . .` を必要物のみの COPY に狭め、`docker-compose.yml` に **deploy 用サービス定義**(source mount でなくビルド済みイメージ実行)を追加。実行時にビルドを走らせない現状は維持。
2. 音声/ブラウザ等の重い依存はオプションのイメージバリアント or プロファイルに分離(コア CLI イメージは軽量に)。macOS 専用の MLX 音声は Docker(Linux)では無効化される旨を明示。
3. `docker compose up` → `kyberion list implemented` 相当が通ることを確認。公式イメージの publish は Task 2 同様、判断事項として手順書化に留める。

### Task 4: インストール文書の整合 — `claude-haiku`

- README / INITIALIZATION / DEPLOYMENT のインストール節を実態に統一。first-win 最短経路(前提・所要・macOS 音声制約・Docker 経路)を 1 つの表にまとめる。評価レポートの D1 ボトルネックへの対応として `docs/verification/` に進捗を 1 行追記。

## リスクと注意

- npm 公開は**製品人格の判断(構想評価 §3-1)と OSS 公開範囲**に関わる経営マターなので、本計画は「公開可能にする構造 + ローカル bin」まで。公開の実行はしない。
- Docker のマルチステージ化でビルドが壊れやすい。既存の `pnpm build` 成果物をそのまま COPY する形にし、イメージ内ビルドを段階的に外す。
- 音声/ブラウザ依存の分離で既存の音声 first-win(ロードマップの目玉)を壊さないよう、macOS ネイティブ経路は Docker と別物として維持する。
