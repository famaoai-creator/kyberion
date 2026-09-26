---
title: elizaOS から学ぶ 3 領域の改善計画(音声ターンテイキング / シナリオ評価 / プラグイン権限とビュー)
tags: [voice, realtime, eval, scenario, plugin, security, a2ui, improvement-plan, 2026-09]
last_updated: 2026-09-27
status: active
mission: MSN-ELIZA-ADOPTION-20260924
---

# elizaOS から学ぶ 3 領域の改善計画(EV / ES / EP)

## 1. 背景

2026-09-24 に [elizaOS](https://github.com/elizaOS/eliza)(commit `96b41bee2`, 2026-09-23)を調査し、Kyberion に取り込める設計を比較した。ユーザーの関心は「音声・ビデオ」「workspace / playground」「プラグインシステム」。調査の結論:

- **コードは持ち込まない。** elizaOS は Bun / Capacitor / PGLite 前提で、secure-io・ミッション統制・tenant scope と合わない。設計だけを Kyberion の流儀で再実装する。
- 差が大きく取り込み効果が高いのは次の 3 領域。

| 系列 | 領域                                     | elizaOS の参照元                                                                                                                       | Kyberion の現状                                                                                                    |
| ---- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| EV   | リアルタイム音声のターンテイキング       | `plugin-local-inference/src/services/voice/*`、`packages/ui/src/voice/*`、`shared/src/voice/*`                                         | 一段階 barge-in(既定 off)、VAD 無音だけの EOT、中止理由なし、応答ゲートなし。推論 8.5〜16.6 秒がボトルネック       |
| ES   | シナリオ評価ランナー(playground 相当)    | `packages/scenario-runner`(副作用で判定、仮想時計、evidence class、judge 独立性、trajectory)                                           | `eval_harness.ts` の既定 executor は stub の envelope を記録するだけ。副作用の観測・時計注入・再生可能な記録がない |
| EP   | プラグインの権限・ライフサイクル・ビュー | `core/plugin-lifecycle.ts`、`types/plugin.ts`(ViewDeclaration / RemotePluginPermissions)、`surface-manifest.ts`、`plugin-installer.ts` | 出自ゲートと承認は強い。ただし承認が内容 digest に束縛されない、権限宣言なし、所有台帳なし、ビューを提供できない   |

見送り(今回の対象外): VRM アバター(PA-09 の viseme 設計の方が先行)、動画取り込み(yt-dlp)、Set-of-Marks ビジョン、per-session `GIT_INDEX_FILE`。後続候補として §8 に残す。

## 2. 共通方針

- 判定ロジックは**時計を注入した純粋モジュール**に切り出し、I/O 側はアダプタにする(EV のワークベンチ、ES の仮想時計が同じ部品を実時間なしで回せる)。
- 未対応・未設定は**必ず `skipped` / fail-closed**。黙って `pass` や既定応答で埋めない(eliza の "honesty contract")。
- 既存 API は壊さない。新しいモードは明示フラグか env で有効化し、既定値の変更は後方互換の範囲に限る。
- 登録作業(env-registry、`libs/core/index*.ts`、語彙カタログと generated、schema、ci-gates、package.json scripts)は**オーケストレーターがゲートでまとめて行う**。実装エージェントは必要な登録を報告するだけ。
- UI 文言は `user-facing-vocabulary.json`(en/ja)経由。

## 3. EV: 音声ターンテイキング

### 現状(調査済み)

- `libs/core/barge-in-controller.ts`: エネルギー VAD × 2 倍閾値 × 250ms で `triggered`。`meeting-participation-coordinator.ts` も使うので API は維持。
- `libs/core/realtime-voice-loop.ts` L255 `bargeIn.enabled ?? false`。発火で即 `speech.stop()`。`thinking` 中のマイク入力は破棄。推論中止は `streamingSpeech.signal` 経由の間接のみ。
- `PlaybackHandle` は `stop()` のみ(pause なし)。
- 80 字 flush は `scripts/run_realtime_voice_conversation.ts` L922(`speech-segment-chars`)と `realtime-voice-conversation.ts` の `REALTIME_VOICE_REPLY_STREAM_FLUSH_CHARS=120` / `sentenceEndAt`(`、` は区切らない)。

### 項目

| ID    | 内容                                                                                                                                                                                                                                                                                     | 主なファイル                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| EV-01 | **二段階 barge-in**: VAD 検知 → `pause_tts`(暫定)→ STT partial が 1 語以上 → `hard_stop`。エコーなら `resume_tts('echo')`、猶予(600ms)内に語が無ければ `resume_tts('no_words')`。STT が無ければ持続 700ms で hard_stop。`bargeIn.mode: off\|legacy\|two_stage`(`enabled:true` は legacy) | 新規 `two-stage-barge-in.ts`、`streaming-voice-playback.ts` に任意の `pause/resume`                      |
| EV-02 | **ターン中止トークン**: 1 ターン 1 トークン、理由 `barge_in\|eot_revoked\|user_cancel\|timeout\|external`、冪等(最初の理由が勝つ)、中止後の listener は即時呼び出し、budget 超過で timeout、外部 signal と双方向。推論・TTS・STT feed・trace を束ねる                                    | 新規 `voice-turn-cancellation.ts`                                                                        |
| EV-03 | **日本語対応 EOT 保留**: 文末が「て/で/けど/が/し/から/ので/のに/たら/と/、」やフィラー(えーと/あの/まあ…)、英語の接続詞なら保留。`。！？` や「です/ます/ください/か」で確定。最大保留 1.5 秒で必ず確定                                                                                  | 新規 `voice-eot-scorer.ts`(`scoreEndOfTurn` + `EotHoldAggregator`)                                       |
| EV-04 | **フレーズ分割 + 初句キャッシュ**: 初句だけ `、` でも切る(`firstMaxChars` 24)、以降は文末か 80 字。初句音声キャッシュのキーは (engine, voiceId, voiceRevision, settingsFingerprint, text)。キャッシュは明示オプション時のみ、`shared/runtime` 配下、profile 削除時に消す                 | 新規 `voice-phrase-chunker.ts`、`voice-first-phrase-cache.ts`                                            |
| EV-05 | **推測応答開始**(明示有効時のみ): 仮無音 250ms で推論を先行起動し、生成はバッファのみ(発話しない)。発話再開で `abort('eot_revoked')`。確定文が一致すればバッファを流す。battery / metered では強制無効                                                                                   | 新規 `voice-speculative-policy.ts`                                                                       |
| EV-06 | **応答ゲート**: フィラーだけの発話と自分の TTS のエコー(文字 bigram 重なり、9 秒窓)は推論しない                                                                                                                                                                                          | 新規 `voice-respond-gate.ts`                                                                             |
| EV-07 | **ボイスワークベンチ**: 入力イベント(`vad_start/vad_silence/stt_partial/stt_final/tts_start/tts_end/tick`)の時系列 JSON を fake clock で再生し、EOT 遅延・誤 barge-in・TTFA を測る。`requires` を満たさないシナリオは必ず `skipped`                                                      | 新規 `voice-turn-taking.ts`(純粋状態機械)、`voice-workbench.ts`、`tests/fixtures/voice-workbench/*.json` |
| EV-08 | **ループ統合と登録**: `realtime-voice-loop.ts` をトークン・二段階 barge-in・EOT 保留・応答ゲートに接続、イベント `turn_cancelled / barge_in_provisional / barge_in_resumed` 追加、`describeLoopEvent` の直書き日本語を語彙へ、CLI フラグ、env 2 件、アーキ文書 §13                       | `realtime-voice-loop.ts`、`realtime-voice-conversation.ts`、`run_realtime_voice_conversation.ts`         |

主要インターフェース:

```ts
export type VoiceTurnCancelReason =
  'barge_in' | 'eot_revoked' | 'user_cancel' | 'timeout' | 'external';
export interface VoiceTurnCancellationToken {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly reason: VoiceTurnCancelReason | null;
  abort(r: VoiceTurnCancelReason): void;
  onAbort(l: (r: VoiceTurnCancelReason) => void): () => void;
}
export type BargeInAction =
  | { type: 'pause_tts' }
  | { type: 'resume_tts'; reason: 'no_words' | 'echo' }
  | { type: 'hard_stop'; words: string };
export interface EotScore {
  pDone: number;
  hold: boolean;
  cue?: 'continuation_particle' | 'filler' | 'conjunction' | 'terminal_punct' | 'none';
}
```

env: `KYBERION_VOICE_BARGE_IN_MODE`(off|legacy|two_stage)、`KYBERION_VOICE_SPECULATIVE_REPLY`(1 で有効)。既定: CLI の `low_latency` かつ streaming STT がある場合だけ `two_stage`、それ以外 `off`。

リスク: スピーカーエコー(AEC は対象外。エコー判定 + 猶予再開で緩和)、「〜が」等の誤保留(最大保留で遅延増に留まる)、個人音声のキャッシュ(personal tier 扱い、明示有効時のみ)。

## 4. ES: シナリオ評価ランナー

### 現状とシーム(調査済み)

- op 受付の観測点: `libs/core/op-preflight.ts` の listener / guard(呼び出し元 `adf-engine.ts:398`、`pipeline-execution-part-control.ts:472`)。
- op dispatch: `pipeline-execution-part-control.ts:665` `resolveActuatorOperation` → `pipeline-execution-part-bootstrap.ts:605` `loadActuatorDispatch`。
- 承認: `libs/core/risky-op-approval-port.ts` の sole seam `risky-approval-handler`。
- reasoning: `registerReasoningBackend`。stub-taint(LC-07)あり。
- 時計の注入点は無い(`foundation/time.ts` の `nowIso` のみ)。secure-io に書き込み observer は無い。

### 項目

| ID    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                        | 主なファイル                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ES-01 | **シナリオ schema**(`kyberion-scenario.v1`): `lane: pr-deterministic\|live-only`、`executionProfile: simulated\|provider-qualified`、`requires`、`seed`(context / files / approvals / clock)、`fixtures`(ops / reasoning)、`turns`(`pipeline\|intent\|advance_clock\|approval_decision`)、turn checks、閉じた union の `finalChecks`。不変条件はコードで強制(provider-qualified は live-only 限定、pr-deterministic は judge / intent 禁止) | 新規 `knowledge/product/schemas/kyberion-scenario.schema.json`、`libs/core/scenario-definition.ts`        |
| ES-02 | **副作用インターセプタ**: op は観測専用 preflight listener で記録。op stub は `actuator-op-registry.ts` の新 seam `scenario-op-override` を `resolveActuatorOperation` 先頭で参照し、simulated では fixture の無い op を `[SCENARIO_UNSTUBBED_OP]` で fail-closed。承認は scenario handler に一時差し替え。書き込みは run root の前後スナップショット差分で導出(secure-io 本体は触らない)                                                   | 新規 `libs/core/scenario-interceptor.ts`、`actuator-op-registry.ts`、`pipeline-execution-part-control.ts` |
| ES-03 | **分離実行コンテキスト**: run root `active/shared/tmp/scenarios/<run-id>`、シナリオ ID から決定的 ID、`dispose()`。仮想時計: 新 `foundation/clock.ts`(sole seam `core-clock`、未登録なら system)、`nowIso()` の既定値だけを差し替え(`Date.now()` 全面置換は対象外)                                                                                                                                                                          | 新規 `libs/core/scenario-run-context.ts`、`libs/core/foundation/clock.ts`                                 |
| ES-04 | **model fixture と evidence class**: `fixtures\|model-free`。fixture 外の reasoning は `[SCENARIO_FIXTURE_MISS]`、model-free では reasoning 呼び出し自体が違反。レポートに `evidence_class` を必須化し、`simulated` を provider evidence として登録しようとしたら拒否                                                                                                                                                                       | 新規 `libs/core/scenario-model-fixtures.ts`、`production-evidence-register.ts` 等の取り込み側             |
| ES-05 | **ランナー CLI とレポート**: `pnpm scenario run <file\|dir> [--lane pr-deterministic] [--keep] [--json]`、`report.{json,md}`(`kyberion-scenario-report.v1`)、live-only は `lane_skipped`。`eval_harness.ts` の既定 executor を fixture executor に置き換え、非 stub モデルで executor 未指定なら fail-closed                                                                                                                                | 新規 `scripts/scenario_runner.ts`、`libs/core/scenario-final-checks.ts`、`scenario-report.ts`             |
| ES-06 | **judge 独立性**: 被評価側の backend は実測(served mode と reasoning ログ)で取り、judge と同じなら拒否、実測できなければ `unavailable`。live-only 限定                                                                                                                                                                                                                                                                                      | 新規 `libs/core/scenario-judge.ts`                                                                        |
| ES-07 | **trajectory 書き出し**: trace + 副作用ログ → `steps[{observation digest, reasoning_calls[{backend, prompt_hash, output_hash}], op, outcome, approval}]`。本文は hash と長さだけ(既存の trace redaction を再利用)                                                                                                                                                                                                                           | 新規 `libs/core/scenario-trajectory.ts`、`knowledge/product/schemas/scenario-trajectory.schema.json`      |
| ES-08 | **初期シナリオ 5 本**(pr-deterministic / simulated / model-free): stub 化 apply、承認却下で副作用なし、承認で遷移、未 stub op の fail-closed、trace span と成果物。CI gate `scenario-pr-deterministic`(scope pr)                                                                                                                                                                                                                            | 新規 `eval/scenarios/*.json`、`eval/scenarios/fixtures/*`、`eval/scenarios/README.md`                     |

env: `KYBERION_SCENARIO_LANE`、`KYBERION_SCENARIO_KEEP_ROOT`(subsystem `eval`)。

リスク: override seam が本番経路に入る(未登録時 no-op、登録は runner プロセスのみをテストで保証)、`nowIso` 既定値変更の波及(system clock で出力完全一致を確認)、承認 seam の一時差し替えは disposer で戻す、`active/shared/tmp/scenarios/` が secure-io policy で書けるか実装前に `security-policy.json` を確認。

## 5. EP: プラグインの権限・ライフサイクル・ビュー

### 現状(調査済み)

- `plugin-contributions.ts`(DH-08): `provides` 宣言分だけ登録、disposer、途中失敗で全件 rollback。所有台帳と permissions は無い。
- `skill-wrapper.ts:170-190`: skill 実行ごとに load / dispose(常駐 host の activate/deactivate 経路は無い)。
- `plugin-managed-install.ts`: 承認の `payloadHash` は `plugin_id` / `trust` / `resolved_source_path` のみ。**内容 digest と version が承認に束縛されていない**(承認後に managed copy を書き換えても activatable のまま)。
- plugin op の handler は `pipeline-execution-part-bootstrap.ts:609` で guard を通らず直接呼ばれる。
- `sandbox-policy.ts` は ALS の `withSandboxPolicy`。network は bool のみ。

### 項目

| ID    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 主なファイル                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| EP-01 | **承認を内容 digest に束縛**: `computePluginContentDigest`(相対 path を sort し `path\0sha256` を連ねた sha256)。record に `contentDigest / manifestVersion / grantedPermissions / permissionsDigest`、承認 hash に digest・version・permissions digest。不一致は `blocked_digest_mismatch`。`import()` 直前にも再検証。digest の無い既存 managed record は `pending_approval` に戻す                                                                                                                                                                            | `plugin-managed-install.ts`、`skill-plugin-loader.ts`、`managed-plugin-record.schema.json`                                       |
| EP-02 | **権限宣言と承認時の絞り込み**: manifest `permissions`(network none/loopback/allowlist、fs none/readonly/readwrite + tier 付き path、`ops_invoke`、`env`、`secrets`)。未宣言は全て none。`narrowPluginPermissions(request, policy, trust)` は共通部分を返す純粋関数。重要項目がゼロまで絞られたら `PluginPermissionNarrowedError`(必要な昇格を文言で示す)。policy は trust ごとの上限 + narrow-only の tenant override。install 時に requested / ceiling / granted の差分表を表示                                                                                | 新規 `plugin-permissions.ts`、`knowledge/product/governance/plugin-permission-policy.json` + schema、`scripts/plugin_install.ts` |
| EP-03 | **実行時の適用**: 登録される op / hook / guard handler を `runWithPluginGrant` で包み、外側の sandbox policy と grant の**共通部分**で `withSandboxPolicy` を張る(決して広げない)。`SandboxPolicy.networkAllowlist` 追加、`ops_invoke` は core op guard `plugin-grant-ops`、`secrets` は `getSecret` 冒頭で拒否、`env` は絞った view を渡す。**in-process コードの `node:fs` / `process.env` 直接利用は止められない協調的な強制であり、悪意あるコードへの境界ではない**と明記                                                                                    | `plugin-contributions.ts`、`sandbox-policy.ts`、`op-preflight.ts`、`secret-guard.ts`                                             |
| EP-04 | **所有台帳とライフサイクル**: どの plugin が何を登録したかを記録、`activatePlugin / deactivatePlugin / reloadPlugin`(失敗時は旧 activation に戻す)。`applyPluginChange` の段階: 権限縮小・ビューのみ → `config_apply`、ops/hooks/prompt_sections/facets/views → `plugin_reload`、seams/providers → `restart_required`。reload は `?digest=` 付き再 import(旧 module はメモリに残る旨を文書化)。CLI `pnpm plugin:install --reload/--deactivate <id>`                                                                                                              | 新規 `plugin-lifecycle.ts`、`scripts/plugin_install.ts`                                                                          |
| EP-05 | **プラグイン提供ビュー**(`provides.views`、宣言的のみ): A2UI document(`kyberion-base` カタログ・component allowlist・語彙キー検証)、`isolation: in-process-a2ui`(`sandboxed-iframe` は今回 `[PLUGIN_VIEW_UNSUPPORTED]`)、capabilities 既定空、action の op は自 plugin の `provides.ops` かつ grant 内のみ、`authority: agent\|human`(human は既存承認 UI 経由)、paramsSchema は `additionalProperties:false` 必須。Chronos に `api/headless/a2ui/plugin-views` route(ViewerContext → `authorizeHeadlessOperation` → activatable かつ digest 一致の plugin のみ) | 新規 `plugin-view-contract.ts`、`plugin-view-declaration.schema.json`、Chronos route                                             |
| EP-06 | **サンプルと文書**: `plugins/fixtures/plugin-permissions-view-fixture/`(ops + view + permissions)で approve → activate → reload → deactivate の e2e、`plugins/README.md`、新規 `knowledge/product/architecture/plugin-permissions-and-views.md`、`docs/SURFACES.md`、語彙 `plugin.*`(en/ja)                                                                                                                                                                                                                                                                      | fixture、文書                                                                                                                    |

リスク(セキュリティ): 協調的な強制を「sandbox だから安全」と誤表示しない、ALS の policy 合成は必ず共通部分(テストで保証)、digest の TOCTOU(`import()` 直前検証で窓を最小化)、既存 managed record の再承認(リリースノート)、reload で旧 module が残る、view document 経由の XSS(allowlist と生 HTML 不可)、ViewerContext を省いた route を作らない。

## 6. 実装の進め方(ウェーブ)

実装はサブエージェント、オーケストレーターはレビューとゲート。1 ブランチ `agent/eliza-adoption-20260924`(worktree `kyberion-eliza`)、項目ごとにコミット。

| ウェーブ | 並行作業                                                                                                                    | ゲート                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| W1       | EV-A(EV-02/03/04/06 の純粋部品)、EV-B(EV-01/05/07 の判定器とワークベンチ)、ES-A(ES-01/03)、EP-A(EP-01/02 の install・trust) | 各テスト、typecheck                                |
| W2       | EV-C(EV-08 ループ統合)、ES-B(ES-02/04 インターセプタ・fixture・evidence ガード)、EP-B(EP-03/04 実行時適用・ライフサイクル)  | 各テスト、typecheck、core vitest                   |
| W3       | ES-C(ES-05/06/07/08 ランナー・レポート・judge・trajectory・シナリオ)、EP-C(EP-05/06 ビュー・route・fixture・文書)           | 登録作業一括、`pnpm check -- --scope pr`、全テスト |

最後に独立レビュー(別エージェント)→ 指摘修正 → PR。

## 7. 実装状況

2026-09-24 時点で全項目を実装(ブランチ `agent/eliza-adoption-20260924`)。独立レビュー 4 ラウンド(Blocking 計 5 件)の指摘を修正し、第 4 ラウンドで GO。

| ID           | 状態 | 備考                                                                                                                                                                                            |
| ------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EV-01〜EV-08 | done | 二段階 barge-in は CLI の `low_latency` + streaming STT で既定 on。推測応答は明示有効 + AC 電源 + 非従量課金のときだけ。日本語の手がかり語は `knowledge/product/voice/turn-taking-lexicon.json` |
| ES-01〜ES-08 | done | `pnpm scenario run eval/scenarios`(5 本)と CI gate `scenario-pr-deterministic`。時計は foundation のモジュール状態(seam ではない)                                                               |
| EP-01〜EP-06 | done | 予約 seam(承認・op 解決)と official 専用 seam(secret-resolver 等)、返り値(ストリーム・クロージャ・コレクション)まで grant 内で実行、ネストした manifest は拒否                                  |

## 8. 後続候補(今回対象外)

- シナリオの上書き(承認・op 解決)をプロセス全体ではなくシナリオ実行の非同期コンテキストに限定する(レビュー N7)。現状は simulated かつ fixture のある op に限定済み。
- 承認済み `human` 権限のビュー action を実行する経路(現状は承認要求の作成まで)。
- `playAudioFile` に一時停止(SIGSTOP/SIGCONT)を追加し、区切り再生の一時停止を「止めて頭から再生」から「その場で停止」にする。
- 推測応答のコスト区分をコードの一覧から reasoning provider 記述子へ移す。
- grant ラッパーの仕上げ(レビュー R4): 入れ子コレクションのコピーも memo で再利用する、走査予算を超えた大きな純データを Proxy ではなく遅延コピーにする、プラグイン由来 Proxy の `has` / `ownKeys` 等のトラップも grant 内で呼ぶ。

- 動画の取り込みと理解(yt-dlp + ffmpeg + 字幕優先の文字起こし、content hash キャッシュ)。
- ビジョンの Set-of-Marks(要素に番号を振り VLM に番号で指させる)と変化タイルだけの再記述。
- 並行エージェント用の per-session `GIT_INDEX_FILE`、登録したパスしか消さない workspace 予算台帳。
- `sandboxed-iframe` ビュー、personal-pads へのプラグインビュー合成。
- サブエージェントを「room に投稿する entity」として扱う連絡路(agent-collab view との統合)。

## 9. 第 2 期: 後続の仕上げ(FU-01〜05)

PR #784(2da6dce5a)のマージ後、§8 のうち取り込み済み機能の仕上げにあたる 5 項目を先に進める。ミッション `MSN-ELIZA-FOLLOWUPS-20260926`、ブランチ `agent/eliza-followups-20260926`。新しい機能(動画取り込み、Set-of-Marks、セッション別 git index など)はこの後に別途計画する。

| ID    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 主なファイル                                                                                              | 状態 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- |
| FU-01 | シナリオの op 上書き・承認上書きを、プロセス全体ではなくシナリオ実行の非同期コンテキスト(AsyncLocalStorage)に限定する。実行外の呼び出し(長時間ホストの別作業)は上書きを一切見ない。承認は fixture が提供する dispatch から来た要求だけに応える(レビュー N7)                                                                                                                                                                                                                                                                                                                                                                                                                                       | `scenario-interceptor.ts`、`actuator-op-registry.ts`、`risky-op-approval-port.ts`、`scenario-executor.ts` | done |
| FU-02 | プラグインビューの `authority: human` action を、承認後に実行する。承認要求の payload hash と照合し、同じ grant・同じ op preflight を通して 1 回だけ実行、結果を監査に残す。レビュー対応: preflight が params を書き換えたら拒否し handler には承認済み params だけを渡す、稼働中モジュールの grant digest も承認時と一致を要求、tenant を hash に含める、拒否はすべて監査、結果未記録の claim は `unknown`、sidecar 走査は新しい 200 件まで・7 日超の終了済みは削除。既知の制約: Chronos プロセス内でプラグインを有効化する仕組みがないため、Chronos から承認済み action は実行できない(一覧は `executable: false` と理由を返し、Execute ボタンの代わりに説明を表示)。Chronos 内での有効化は後続 | Chronos `plugin-views` route、`plugin-view-contract.ts`、承認の消費側                                     | done |
| FU-03 | `playAudioFile` のハンドルに一時停止・再開(POSIX は SIGSTOP/SIGCONT、非対応環境は従来どおり停止して頭から再生)を追加し、区切り再生の一時停止をその場で止める                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `audio-playback.ts`、`segmented-voice-playback.ts`                                                        | done |
| FU-04 | 推測応答のコスト区分(free / metered)をコード内の一覧から reasoning provider 記述子(`knowledge/product/governance/reasoning-providers/*.json`)の項目に移す。未記載は metered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `voice-speculative-policy.ts`、provider 記述子と schema                                                   | done |
| FU-05 | grant ラッパーの仕上げ: 入れ子コレクションのコピーも memo で再利用、走査予算を超えた純データは Proxy ではなく遅延コピー、プラグイン由来 Proxy の `has` / `ownKeys` / `deleteProperty` / `defineProperty` / `getPrototypeOf` / `setPrototypeOf` トラップも grant 内で呼ぶ                                                                                                                                                                                                                                                                                                                                                                                                                          | `plugin-grant-runtime.ts`                                                                                 | done |

## 10. 第 3 期: 残りの候補(PH / WS / MV)

PR #785 のマージ後、§8 に残した候補をすべて進める。ミッション `MSN-ELIZA-PHASE3-20260926`。PR は 2 本に分ける: PR-A(ブランチ `agent/eliza-phase3-20260926`、PH + WS)、PR-B(ブランチ `agent/eliza-media-20260926`、MV)。

| ID        | 内容                                                                                                                                                                                                                                                                                            | PR  | 状態        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------- |
| PH-01     | Chronos のプロセス内プラグインホスト(`libs/core/plugin-host.ts`)。activatable かつ digest 一致のプラグインだけを有効化し、digest・grant の変化で reload、失効で deactivate。既定 off(`KYBERION_CHRONOS_PLUGIN_HOST`)、対象 tenant を明示。これで承認済み human action が Chronos から実行できる | A   | done        |
| PH-02     | `sandboxed-iframe` ビュー。`views/*.html` を厳格な CSP(`sandbox allow-scripts`、`connect-src 'none'` など)で配信し、postMessage は `action.request` だけ。action は必ずホストの確認と既存の承認経路を通る                                                                                       | A   | done        |
| PH-03     | personal-pads にプラグインビューを表示(読み取り専用、tier と tenant は pads の範囲に限定)。agent 権限の action は opt-in のホストで実行                                                                                                                                                         | A   | done        |
| WS-01〜04 | 書き込み可能な委譲 CLI にセッション専用の `GIT_INDEX_FILE` を渡す(他エージェントの `git add` と混ざらない)。owner の commit は baseline から HEAD が動いていたら拒否                                                                                                                            | A   | done        |
| WS-05〜07 | workspace 台帳とディスク予算(上限・空き容量の下限)。削除は台帳に登録したパスだけ、孤児は TTL 後に janitor が回収。`pnpm kyberion workspace list                                                                                                                                                 | gc` | A           | done |
| MV-01〜06 | 動画の取り込み: yt-dlp(チェックサム固定、自動更新なし)と ffmpeg、字幕(手動 > 自動 > STT)、content hash キャッシュ、tier 降格の拒否、remote 取得は承認必須                                                                                                                                       | B   | done (PR-B) |
| MV-07〜11 | Set-of-Marks: OCR と DOM の枠を融合し番号付け、注記画像、`mark:<n>` をクリック対象として解決(期限と画像 hash で stale 判定)                                                                                                                                                                     | B   | done (PR-B) |
| MV-12〜14 | 変化タイルだけを再記述(dHash)、`vision:describe_screen_delta`、darwin/linux でも `describe_image` が動く `reasoning_vision` provider                                                                                                                                                            | B   | done (PR-B) |

## 11. 第 4 期: プラグインホストの実地検証と Set-of-Marks の検出器(PE / DT)

第 3 期(PR #787 / #788)のマージ後、単体テストだけで確かめていたプラグインホストとプラグインビューを、実際のサードパーティプラグインと実ブラウザで通しで検証する。あわせて Set-of-Marks に OCR 以外の検出器を足す。ミッション `MSN-ELIZA-PHASE4-20260927`。PR は 2 本に分ける: PR-A(ブランチ `agent/eliza-plugin-e2e-20260927`、PE)、PR-B(DT)。

| ID    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PR  | 状態 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- |
| PE-01 | E2E 用のサードパーティプラグイン fixture(`plugins/fixtures/plugin-view-e2e-fixture/`)。`sandboxed-iframe` ビュー 1 つが postMessage の `action.request` で `agent` 権限の action と `human` 権限の action を要求する。handler は無害で、結果はホスト側の記録(承認記録・監査)で観測する                                                                                                                                                                                                                                                                                                                                                  | A   | done |
| PE-02 | E2E ドライバ(`scripts/check_plugin_views_e2e.ts`)。`active/shared/tmp/` 配下に隔離した Kyberion root を作り、正規のインストール経路(`plugin_install --tenant` と運用 CLI での承認)で導入、tenant を明示してプラグインホストを有効にした Chronos(本番ビルドの `next start`)を空きポートで起動し、Playwright Chromium で一覧 → iframe ビュー → iframe 内クリック → ホスト確認 → agent action、human action → 承認 → 1 回だけ実行・2 回目は拒否、までを通す。検証はデータ(一覧、frame の応答ヘッダ、iframe 側で観測した opaque origin と `connect-src` 違反、承認記録、監査チェーン)で行い、失敗時もブラウザ・サーバ・一時 root を片付ける | A   | done |
| PE-03 | 実行入口 `pnpm kyberion check plugin-views-e2e`(`cli-commands.json` の module 登録)、CI の `first-win-clean-clone` job への step 追加(同 job のビルドと Chromium を再利用、約 15 秒)、`plugins/README.md` の手順                                                                                                                                                                                                                                                                                                                                                                                                                        | A   | done |
| DT-01 | Set-of-Marks の OCR 以外の検出器 `pixel_regions`(画素の領域分割から候補枠を作る)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | B   | PR-B |
| DT-02 | Set-of-Marks の OCR 以外の検出器 `os_accessibility`(OS のアクセシビリティツリーから候補枠を作る)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | B   | PR-B |

PE で見つかり、PR-A で直した不具合:

- Chronos の `instrumentation.ts` がプラグインホストを起動していたが、Next.js は instrumentation を別の webpack layer でビルドし、同梱された `@agent/core` の各モジュールを別インスタンスとして持つ。このためホストが登録した plugin op・有効化状態を route handler から参照できず、ビュー action がすべて `PLUGIN_VIEW_ACTION_UNAVAILABLE` になっていた。ホストは plugin-views の route からのみ起動する(instrumentation を削除)。
- `KYBERION_CHRONOS_PLUGIN_HOST_TENANTS` の tenant 検証が、personal tier の tenant registry を読めない実行 role のまま行われ、すべての tenant を未知として捨てていた。検証は `chronos_localadmin` role で読む。
- 承認要求の作成(`createApprovalRequest` → work-design の outcome catalog)を含む 3 つの governed catalog が、schema を cwd 相対で解決していた。Chronos は自分のパッケージディレクトリを cwd に動くため、Chronos からの承認要求の作成が常に失敗していた(human action がキューされない)。schema は Kyberion root 基準で解決する。

~~残課題: surface runtime 経由の起動は `SYSTEM_ROLE=chronos_mirror_v2` を注入するが、`resolveRole()` は `SYSTEM_ROLE` を `MISSION_ROLE` より優先するため、`withExecutionContext` による role 切り替え(viewer context、承認ストアの `mission_controller` 書き込み、上記の tenant 検証)がその起動方法では効かない。PE の E2E は `SYSTEM_ROLE` なしで起動しており、この経路は未検証。~~

解決済み(MSN-CHRONOS-ROLE-AUDIT-20260927 PR-A): `withExecutionContext*` が引き受けた role / persona を AsyncLocalStorage のスコープで持ち、`resolveRole()` はそれを `SYSTEM_ROLE` より先に使う(RA-01、並行リクエスト間の env 競合も解消)。`SYSTEM_ROLE` のあるプロセスが引き受けられる role は `role-assumption-policy.json` で制限する(RA-02、それ以外は `[ROLE_ASSUMPTION_DENIED]`)。plugin-views E2E は Chronos を直接起動と surface runtime と同じ env(`SYSTEM_ROLE=chronos_mirror_v2`)の両方で検証する(RA-03。変更前は surface runtime モードで tenant 検証が失敗し、変更後は両モードとも通る)。詳細は [AUTHORITY_MODEL §3.B2](../../../knowledge/product/governance/AUTHORITY_MODEL.md)。
