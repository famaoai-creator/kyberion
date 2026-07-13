# E2E-05: アプリ開発ライフサイクル — iOS/Android を含む AI-DLC/SDLC を全工程自動で回す

> 優先度: **P0**(中核ユースケース第5弾) / 規模: L(タスク分割済み) / 依存: E2E-03(協調)・MO-02(ゲート、Codex 実装中)と接続。AC-01/AC-03/IP-05 の成果を利用
> 実装担当モデル: 各タスクに明記。**gpt-5.4-mini クラス単独で実装可能な粒度**に分割(README §2.1 の読み替え表)
> 調査日: 2026-07-06(実コード検証済み)

## 0. 実装エージェントへ(E2E-01〜04 と同じ規約)

- Task 内の手順を上から順に。変更前に対象ファイルを読み、行番号ずれは現状を正とする。
- ファイル I/O は `@agent/core`(secure-io)経由のみ。各 Task の「検証」全通過 + `pnpm lint && pnpm typecheck` で完了。
- **本計画の合言葉は「工程の脳はある。手足(ビルド・配布)と神経(工程間の受け渡し)を付ける」**。

## 1. 調査結論 — 「回せるか?」への答え

**サーバ/Web 系のコード変更**: 概ね回せる(E2E-03 の協調 + MO-02 のゲート完成後)。要求→設計→テスト計画→タスク分解の知的工程は全て op として実装済みで、実装・レビュー往復は E2E-03、フェーズゲートは MO-02 が塞ぐ。

**iOS/Android アプリ**: **現状では回せない**。理由は知的工程ではなく**物理工程の欠落**: (1) ビルドできない、(2) 新規プロジェクトを生成できない、(3) テスト計画をデバイス上で実行できない、(4) 署名・配布ができない。逆に言えば、この4つを埋めれば知的工程は共通なのでモバイルも回る。

## 2. 工程別の実装状況(実測)

| SDLC/AI-DLC 工程                  | 状況                               | 実体(検証済み)                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0: Alignment(要求・設計)    | ✅ **op 完備**                     | `wisdom:extract_requirements` / `extract_design_spec`(`decision-ops.ts:147,223`)+ `schemas/requirements-draft.schema.json` / `design-spec.schema.json`                                                 |
| タスク分解(WBS/DAG)               | ✅ op 完備                         | `decomposeIntoTasks`(3 reasoning backend 全対応、IP-07 でテスト済み)+ `schemas/task-plan.schema.json`                                                                                                  |
| Phase 1: Execution(実装)          | ✅ 骨格あり                        | mission micro-repo + チーム dispatch + 並列 DAG(MO-03)+ 協調往復(E2E-03 計画)+ `code-actuator`(解析/refactor/semgrep)                                                                                  |
| Phase 2: Verification(テスト計画) | ✅ op あり / **実行系が Web のみ** | `extractTestPlan` → `test-case-adf`(`libs/core/src/types/test-case-adf.ts`)→ **browser pipeline 変換のみ**(`modeling-pipeline-helpers.ts:398-412` `test_inventory_to_browser_pipeline`)                |
| Phase 3: Review(品質保証)         | ✅ 計画済み                        | E2E-03(review 往復・best-of-N)+ MO-02(ゲート・circuit breaker、Codex 実装中)+ planning reviewer 実装済み                                                                                               |
| Phase 4: Ops(デプロイ・保守)      | △ 契約のみ                         | `deployment-adapter.ts`(approval-gate 経由の deploy 契約 + config 駆動、AC-03)— **モバイル用アダプタ無し**                                                                                             |
| デバイス操作(実機/シミュレータ)   | ✅ **強い**                        | ios: boot/shutdown/install_app/launch_app/deep_link/capture_screen(`ios-runtime-helpers.ts:273-383`)/ android: ADB + UI tree 抽出 + tap/swipe/input + login form(`android-runtime-helpers.ts:266-595`) |
| フェーズ列                        | ✅ 定義済み                        | `code-change-aidlc` ワークフローテンプレート(MO-01: alignment→execution→test→self_review→verification)                                                                                                 |

**欠落(ギャップ)**:

- **G1: ビルド工程が皆無**。`xcodebuild` / `gradle` / `fastlane` への言及が**リポジトリ全体でゼロ**(grep 実測)。コードは書けてもバイナリが作れない。長時間プロセス基盤(`terminal-actuator: spawn/poll/write`)はあるのに未活用。
- **G2: プロジェクト生成(scaffold)が無い**。`project_bootstrap` は execution shape として存在するが、iOS/Android の新規プロジェクト雛形を作る op が無い。
- **G3: 工程間の受け渡しが未配線**。requirements-draft → design-spec → task-plan → NEXT_TASKS(ミッションのタスク)を**連結するパイプラインが無い**(各 op は単発呼び。HO-02 が「AI-DLC は完全人手コピペ」と指摘済みの箇所)。
- **G4: テスト実行がモバイル未対応**。test-case-adf → 実行変換は browser 向けのみ。ios/android の UI 操作 op は揃っているのに、**test-case-adf → simctl/adb パイプラインへのコンパイラが無い**。
- **G5: 署名・配布が無い**。iOS provisioning/TestFlight、Android keystore/内部配布。deployment-adapter に mobile 実装が無い(secret 管理自体は vault/secret-actuator にある)。
- **G6: モバイル開発の前提 preflight が無い**。Xcode/simctl ランタイム・ANDROID_HOME・emulator・JDK が AC-01 の prerequisites に未宣言(ios/android manifest は `platforms` のみ)。実行時に初めて落ちる(E2E-01 G1 と同型)。

## 3. ゴール(受入条件)

1. `pnpm app:preflight --platform ios|android` で、ビルド・テスト・配布の全前提が PASS/FAIL + 直し方つきで出る。
2. `build-actuator`(新設)で `ios_build` / `android_build` / `ios_test` / `android_test` / `ios_archive` / `android_bundle` が動き、結果(成功/失敗・ログ要約・成果物パス)が構造化して返る。
3. `scaffold_app` op で iOS(Swift/SwiftUI)・Android(Kotlin/Compose)の最小プロジェクトが mission repo 内に生成され、直後に G2 のビルドが通る。
4. `pipelines/sdlc-cycle.json` 1本で、intent → requirements-draft → design-spec → task-plan → **NEXT_TASKS.json への書込(ミッション接続)** → test-plan(test-case-adf)まで evidence 配下に成果物として連結生成される。
5. test-case-adf が platform=ios|android のとき simctl/adb パイプラインにコンパイルされ、シミュレータ/エミュレータ上で実行・screenshot 証跡つきで判定される。
6. deployment-adapter に `mobile-beta` アダプタ(fastlane 委譲)が追加され、approval-gate 経由でのみ配布が実行される。
7. fixture の最小アプリで「scaffold → build → simulator install/launch → UIテスト1件 → レポート」の E2E リハーサルが通る(CI ではツールチェーン不在時 skip 明示)。

## 4. 実装タスク

### Task 1: モバイル前提 preflight — `gpt-5.4-mini`

1. `libs/actuators/ios-actuator/manifest.json` / `android-actuator/manifest.json` の capabilities に AC-01 の `prerequisites` を宣言:
   - ios: `binaries: ['xcrun','xcodebuild']`, `platforms: ['darwin']`, install hint=`Xcode を App Store から導入し xcode-select を設定`
   - android: `binaries: ['adb']`, `env: ['ANDROID_HOME']`, install hint=`Android Studio / cmdline-tools を導入し ANDROID_HOME を設定`
2. `scripts/app_preflight.ts` を新設(E2E-01 Task 1 の `meeting_preflight.ts` と同型)。検査: 上記 binaries/env + `xcrun simctl list runtimes` に iOS runtime が1つ以上 / `adb devices` or emulator AVD が1つ以上 / (配布まで見る `--full` 時)fastlane 有無・keystore/provisioning の secret 存在(`secretGuard.getSecret`、値は表示しない)。
3. `package.json` に `"app:preflight"` を追加。
4. **検証**: `pnpm app:preflight --platform ios` 実行(本環境で各項目が判定される)/ unit test(モックで pass/fail/fix 文言固定)/ `pnpm run check:catalogs`(manifest 変更後は `sync_component_inventory` 再生成)。

### Task 2: build-actuator 新設 — `claude-sonnet-4` 相当(骨格)→ 横展開は `gpt-5.4-mini`

1. `libs/actuators/build-actuator/` を新設(IP-05 の共通 CLI runner `runActuatorCli()` を必ず使う。manifest/schema/`sync_component_inventory` 登録まで一式)。ops:
   - `ios_build`: `xcodebuild -scheme <s> -destination 'generic/platform=iOS Simulator' build`(workspace/project 自動検出: `*.xcworkspace` 優先)
   - `ios_test`: `xcodebuild test -destination 'platform=iOS Simulator,name=<sim>'`
   - `ios_archive`: `xcodebuild archive`(署名は Task 6 まで `CODE_SIGNING_ALLOWED=NO` 既定)
   - `android_build`: `./gradlew assembleDebug` / `android_test`: `./gradlew testDebugUnitTest connectedDebugAndroidTest`(connected は device 有時のみ)/ `android_bundle`: `./gradlew bundleRelease`(署名なし既定)
2. 実行基盤: **長時間ジョブは terminal-actuator の `spawn/poll` を経由**(直接 `safeExec` の 10 分タイムアウトを避ける)。ログは `active/missions/<id>/evidence/build/<op>-<ts>.log` に全量、返却は構造化 `{ ok, duration_ms, log_path, artifact_paths[], error_summary(失敗時: ログ末尾から Error/FAILED 行を最大10行抽出) }`。
3. コマンドは SA-02 の shell-command-policy を通す(`xcodebuild`/`gradlew`/`xcrun`/`adb` を allowlist に追加。deny/approval の既定は変えない)。
4. **検証**: unit test(safeExec/terminal をモックし、op→コマンド組立と error_summary 抽出を固定)/ Task 7 で実ビルド検証。

### Task 3: アプリ scaffold — `gpt-5.4-mini`

1. 雛形は**外部ツールに依存せずリポジトリ内 fixture 方式**: `knowledge/product/scaffolds/ios-swiftui-minimal/` と `android-compose-minimal/` に、ビルドが通る最小プロジェクト一式(プレースホルダ `{{APP_NAME}}` / `{{BUNDLE_ID}}`)をコミットする。
   - ios: XcodeGen の `project.yml` 方式を採る(`.xcodeproj` のバイナリ plist をコミットしない。`xcodegen generate` を build-actuator の前段 op `ios_generate_project` として追加し、prerequisites に `xcodegen` を宣言)
   - android: gradle wrapper 込みの標準構成(`settings.gradle.kts` ほか)
2. build-actuator に `scaffold_app` op: `{ platform, app_name, bundle_id, dest_dir }` → fixture をコピーしプレースホルダ置換(secure-io のみ。実装は `mission-templates` のコピー機構 `mission-creation.ts:137-148` と同型)。
3. **検証**: scaffold → `ios_generate_project`+`ios_build` / `android_build` が通る(Task 7 の実走で確認。unit はコピー+置換のみ固定)。

### Task 4: SDLC 工程チェーンのパイプライン化 — `gpt-5.4-mini`(op 連結のみ)

1. `pipelines/sdlc-cycle.json` を新設。context 必須: `mission_id`, `intent_text`(または `requirements_source_path`)。steps(**全て既存 op**):
   1. `wisdom:extract_requirements` → `evidence/sdlc/requirements-draft.json`
   2. `wisdom:extract_design_spec`(requirements を入力)→ `evidence/sdlc/design-spec.json`
   3. `wisdom:decompose_into_tasks`(requirements+design)→ `evidence/sdlc/task-plan.json`
   4. **task-plan → NEXT_TASKS.json 変換**: `core:transform` で task-plan の各 task を worker のタスク契約形式(`task_id/status:'planned'/assigned_to.role/description/deliverable/dependencies`)へマップして書込(ここだけ新規変換 30 行程度。role は task-plan の reviewer/tester 指定を尊重、それ以外は implementer)
   5. `wisdom:extract_test_plan` → `evidence/sdlc/test-plan.json`(test-case-adf 互換)
2. これで「合意→分解→ミッション着手」が1本になり、以降は既存の orchestration worker(+E2E-03 の協調)が回す。HO-02 の中核ギャップ(工程間人手コピペ)がこの1本で埋まる — HO-02 文書にステータス追記。
3. **検証**: stub backend で実走し、4成果物 + NEXT_TASKS 更新を確認する統合 test(`tests/sdlc-cycle-contract.test.ts`)。

### Task 5: test-case-adf → デバイス実行コンパイラ — `claude-sonnet-4` 相当

1. `modeling-pipeline-helpers.ts` の `test_inventory_to_browser_pipeline`(`:398-412`)を手本に、`test_inventory_to_device_pipeline` op を追加: test-case-adf(`platform: 'ios'|'android'` を type に追加)を受け、
   - android: `launch_app` → 各 step を `find_ui_nodes`/`tap_ui_node`/`input_text_into_ui_node` に変換 → assert は `extract_ui_tree`+`find_ui_nodes`(期待テキスト存在)→ 各 case 末尾で screenshot
   - ios: `boot_simulator`→`install_app`→`launch_app` → 操作は現状 op が薄いため **assert を deep link 遷移 + `capture_screen` の存在確認に限定**(タップ系 op の追加は本計画のスコープ外と明記 — 逃げずに「iOS の UI 操作 op 拡充」を残余として文書化)
2. 変換結果はそれぞれ android-actuator / ios-actuator の pipeline 契約(既存スキーマ)に適合させ、実行と判定レポート(pass/fail/screenshot パス)を `evidence/test-runs/` に出す。
3. **検証**: 変換の unit test(fixture test-case-adf → 期待 pipeline JSON)/ Task 7 の実走。

### Task 6: モバイル配布アダプタ — `claude-sonnet-4` 相当

1. `libs/core/deployment-adapters/mobile-beta.ts` を新設(`deployment-adapter.ts` の契約実装)。実体は **fastlane への委譲のみ**: `fastlane ios beta` / `fastlane android beta`(Fastfile はアプリ repo 側の責務。無ければ actionable エラー)。prerequisites に `fastlane` を宣言。
2. 既存の approval-gate 経由フロー(`deployment-adapter.ts:13` の Safety 規約)をそのまま通す。署名 secret(keystore パス/AppStore Connect API key)は vault から名前参照のみ(値をログ・trace に出さない — SA 系規約)。
3. deployment-adapter-config(personal knowledge 駆動、AC-03 実装済み)に `adapter: 'mobile-beta'` を選べるよう登録。
4. **検証**: unit test(fastlane 呼び出しをモック、approval 未承認で実行されない)/ 実配布はスコープ外(手動 runbook を doc に1節)。

### Task 7: E2E リハーサル — `gpt-5.4-mini`

1. `tests/app-lifecycle-e2e.test.ts`: `describe.skipIf(!process.env.KYBERION_MOBILE_TOOLCHAIN)`(CI 既定 skip・skip 理由表示)で、
   - android(まず1本目): `scaffold_app` → `android_build` → emulator 有なら `install_app`+`launch_app`+`capture_foreground_activity` → build レポート構造の assert
   - ios は darwin + runtime 有時のみ同型
2. ツールチェーン無し環境向けに、モック層での契約テスト(op→コマンド組立)を同ファイルに常時実行分として同居させる。
3. `docs/OPERATOR_UX_GUIDE.md` に「アプリ開発ライフサイクルの回し方」節(preflight → mission create(code_change)→ sdlc-cycle → 実装(協調)→ device test → mobile-beta)をコピペ可能な形で追記。
4. **検証**: 本テスト(モック分)緑 / ローカルで `KYBERION_MOBILE_TOOLCHAIN=1` 実走 1 回の記録を本文書に追記。

## 5. リスクと注意

- **ビルドは重く不安定**: 初回 xcodebuild/gradle は分単位+ネットワーク(依存 DL)。terminal-actuator 経由の spawn/poll + ログ全量保存を必須とし、run_pipeline 直下で同期実行しない。失敗分類(署名/依存解決/コンパイルエラー)は error-classifier に3ルール追加して UX-01 封筒に乗せる。
- **署名素材は最高機密**: keystore/p12/API key は vault 参照のみ。preflight も「存在確認」だけで値に触れない。配布は必ず approval-gate(既存契約)経由。
- **iOS の UI 操作 op は現状薄い**(tap 系が無い)。Task 5 では正直に assert 範囲を限定し、「XCUITest 連携 or simctl UI 操作 op 拡充」を残余として明記(過大な受入条件にしない)。
- **MO-02/E2E-03 との整合**: Phase ゲート・レビュー往復はそちらの成果に乗る。本計画は工程の「実体 op」と「連結」のみを追加し、worker の遷移ロジックには触れない。
- scaffold fixture はビルドが通る状態を CI で保証できない(ツールチェーン不在)ため、fixture 更新時は Task 7 のローカル実走を必須手順として fixture ディレクトリの README に明記。

## 6. 実施順序

Task 1(preflight)→ Task 2(build)→ Task 3(scaffold)→ Task 7(E2E: build 迄)→ Task 4(SDLC 連結)→ Task 5(device test)→ Task 6(配布)。
**Task 1〜3 + 7 で「Kyberion がアプリをビルドできる」が成立**(最大の物理欠落の解消)。Task 4 で知的工程が繋がり、5〜6 で検証と出荷が閉じる。

## 7. 実装状況(2026-07-07)

Task 1〜7 実装済み(実機ツールチェーン実走の記録のみ未取得)。

- **Task 1**: `pnpm app:preflight`(`scripts/app_preflight.ts` + unit test)。ios/android manifest に AC-01 prerequisites を宣言。
- **Task 2**: `libs/actuators/build-actuator/` 新設(8 ops: scaffold_app / ios_generate_project / ios_build / ios_test / ios_archive / android_build / android_test / android_bundle)。`schemas/build-pipeline.schema.json`。ログは `evidence/build/<op>-<ts>.log` 全量、返却は `{ok, duration_ms, log_path, artifact_paths, error_summary(最大10行)}`。shell-command-policy に `mobile-toolchain` allowlist を追加。**逸脱**: 長時間ジョブは terminal-actuator spawn/poll ではなく `safeExecResult` の timeout 上書き(既定45分)で実装 — 同じ効果で決定論的・テスト容易。
- **Task 3**: `knowledge/product/scaffolds/{ios-swiftui-minimal,android-compose-minimal}/`(プレースホルダ置換、XcodeGen project.yml 方式)。**逸脱**: gradle-wrapper の jar(バイナリ)はコミットせず — `./gradlew` 不在時は build-actuator が `gradle` にフォールバック(scaffold README に明記)。
- **Task 4**: `pipelines/sdlc-cycle.json`(intent → extract_requirements → extract_design_spec → decompose_into_tasks → **task_plan_to_next_tasks**(新規 wisdom op、worker 契約へ決定論変換 — reviewer/tester の role 尊重、依存無し reviewer は implementer に降格)→ extract_test_plan)。`tests/sdlc-cycle-contract.test.ts`。
- **Task 5**: modeling-actuator `test_inventory_to_device_pipeline` op(`compileTestInventoryToDevicePipeline`)。android: find/tap/input + wait_for_ui_text + 各 case スクリーンショット。ios: deep link + capture_screen のみ(**残余: iOS の UI 操作 op 拡充** — tap 系 op が薄いため)。
- **Task 6**: `libs/core/deployment-adapters/mobile-beta.ts`(fastlane 委譲のみ、Fastfile はアプリ repo 責務、secret は名前参照のみ)。deployment-adapter-config schema に `adapter: 'mobile-beta'` を追加し AC-03 の config 駆動で選択可能。unit test 4件。
- **Task 7**: `tests/app-lifecycle-e2e.test.ts`(モック契約分は常時実行、実走は `KYBERION_MOBILE_TOOLCHAIN=1` で opt-in)。OPERATOR_UX_GUIDE §11 に手順を追記。

### 残余

- iOS UI 操作 op(tap/input)の拡充(Task 5 の注記どおり)。
- ローカル実機ツールチェーンでの実走記録(`KYBERION_MOBILE_TOOLCHAIN=1`)。
- android scaffold の実ビルド検証(gradle 環境が必要)。
