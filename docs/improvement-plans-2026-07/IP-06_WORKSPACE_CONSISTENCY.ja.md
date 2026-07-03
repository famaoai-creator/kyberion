# IP-06: ワークスペース整合性の回復(package.json 欠落・命名不統一)

> 優先度: P1 / 規模: S / 依存: なし

## 背景と課題

- **package.json が無いのに workspace glob(`libs/actuators/*`)配下に居るアクチュエータが 5 つ**: `media-generation-actuator`(1,360 LOC)、`video-composition-actuator`(1,855)、`vision-actuator`(267)、`voice-actuator`(2,403)、`daemon-actuator`(retired スタブ)。依存を宣言できず、`pnpm --filter` でビルド・テストできず、`build:packages` から不可視。`tsconfig.actuators.json` のワイルドカードで偶然コンパイルされているだけ。
- **daemon-actuator は明示的に retired**(`src/index.ts:6-24` に "retired" と記載、`handleAction` は throw のみ、参照ゼロ)なのに live ツリーに残存。既存の退役先 `retired/actuators/` の慣例に反する。
- **npm scope が不統一**: 大半は `@actuator/*` だが、`@agent/blockchain-actuator`、`@agent/secret-actuator`、`@kyberion/email-actuator` が混在。
- **email-actuator** は `main` が `src/index.ts`(生 TS)を指す(他は全て `../../../dist/...`)。テストゼロ・`test` script も無し(working-memory-actuator もテストゼロ)。
- **satellites/discord-bridge/package.json が npm init の残骸**: name が unscoped、`main: index.js`(存在しない)、`test` が `exit 1` のプレースホルダ(実テスト `src/index.test.ts` は存在)。
- `satellites/voice-hub`(163KB の server.ts)と `presence-studio`・`computer-surface` は package.json 自体が無く workspace 外(voice-hub の分割は IP-10 で扱う。ここでは workspace 化のみ)。

## ゴール(受入条件)

1. `libs/actuators/*` 配下の全ディレクトリが有効な workspace パッケージになる(retire されるものを除く)。
2. `daemon-actuator` が `retired/actuators/` へ移動し、ビルド・テスト対象から外れる。
3. scope が `@actuator/*` に統一される(消費側の import も全て更新)。
4. discord-bridge / email-actuator のメタデータ不整合が解消し、`pnpm --filter <pkg> test` が全 bridge・全アクチュエータで意味のある結果を返す。

## 実装タスク

### Task 1: daemon-actuator の退役 — `claude-haiku`

1. `git mv libs/actuators/daemon-actuator retired/actuators/daemon-actuator`。
2. `tsconfig.actuators.json` がビルド対象から外していることを確認(retired/ は include 外のはず。含まれていれば exclude 追加)。
3. `pnpm build:actuators` と `pnpm test:unit` が通ることを確認。

### Task 2: package.json 欠落 4 パッケージの workspace 化 — `claude-sonnet-4`

1. 既存の標準形(例: `libs/actuators/process-actuator/package.json`)を雛形に、`media-generation-actuator` / `video-composition-actuator` / `vision-actuator` / `voice-actuator` へ package.json を追加する(name は `@actuator/<name>`、`main` は他と同じ `../../../dist/...` 規約、`test` script 付き)。
2. 各パッケージの import 文から実依存(`@agent/core` 以外の外部依存)を洗い出し、dependencies に明記する。ルート package.json に巻き上げられていた依存に暗黙依存していた場合はここで顕在化するので、パッケージ側に宣言する。
3. `pnpm install` → `pnpm build` → `pnpm --filter '@actuator/*' test`(テストの無いものは後述)で確認。
4. `voice-actuator` 直下の野良スクリプト `mms-jp-test.py`, `ms-voice-test.py`, `singing-test.py`, `voice-bridge.py` と `vision-actuator/override.txt`(0バイト)は IP-14 の対象なので触らない。

### Task 3: scope 統一 — `claude-sonnet-4`

1. `@agent/blockchain-actuator` → `@actuator/blockchain`、`@agent/secret-actuator` → `@actuator/secret`、`@kyberion/email-actuator` → `@actuator/email` にリネームする。
2. 事前に `grep -rn "@agent/blockchain-actuator\|@agent/secret-actuator\|@kyberion/email-actuator" --include='*.ts' --include='*.json' libs/ scripts/ satellites/ presence/ pipelines/ knowledge/product/` で全消費箇所を列挙し、import・manifest・パイプライン定義を一括更新する。
3. `pnpm install && pnpm build && pnpm test:unit` で確認。**ヒットが confidential 配下にあった場合は変更せず報告のみ**(tier 隔離)。

### Task 4: メタデータ修正 — `claude-haiku`

1. `satellites/discord-bridge/package.json` を他 bridge(`@kyberion/slack-bridge` 等)に合わせる: name `@kyberion/discord-bridge`、`main` → dist 規約、`test` → `vitest run src/`、license/description を siblings と統一。
2. `email-actuator` の `main` を dist 規約へ修正し、`test` script を追加。
3. `pnpm --filter '@kyberion/discord-bridge' test` が実テストを実行することを確認。

### Task 5: 最小テストの追加(email / working-memory)— `claude-sonnet-4`

- テストゼロの `email-actuator`(138 LOC)と `working-memory-actuator`(621 LOC、TODO 7件のホットスポット)に、`handleAction` の正常系 1 + 異常系 1 の baseline テストを追加する。他アクチュエータのテストスタイル(スタブ reasoning backend、in-memory)を踏襲する。

## リスクと注意

- Task 2 で依存をパッケージ側に宣言すると pnpm の hoisting 変化で他パッケージの解決が変わる可能性がある。`pnpm build` 全体と smoke テストで確認する。
- scope リネームは文字列参照(manifest.json の `package` フィールド、capability カタログ `knowledge/product/orchestration/global_actuator_index.json` 等)に漏れが出やすい。Task 3 の grep は `.md` を除く全拡張子で行い、`pnpm check:catalogs` を必ず実行する。
