# AR-09: アクチュエータ共通能力の正本化

> 優先度: P1 / 規模: L(段階実装) / 依存: AR-02, AR-03 / 関連: IP-08, IP-09, AR-05, AA-01
> **起票日**: 2026-07-18
> **状態**: DONE

## 背景

アクチュエータ調査で、OCR と同じように複数の actuator が同一の意味を持つ実装を個別に抱えていることが分かった。特に次の5領域は、挙動のドリフト・セキュリティ境界の不統一・運用時の観測分断を生む。

なお、IP-09 が扱う `retry()` は「再試行アルゴリズムの正本化」であり、本計画の recovery policy は「manifest・既定値・分類器から actuator 用 retry options を構築する層」である。両者は重複しない。

## ゴール

1. actuator 固有の業務意味・既定値・権限ポリシーを維持したまま、共通の実行境界を `libs/core` に集約する。
2. 新しい actuator が同じ recovery policy / process / job / HTTP の実装を再作成しなくて済む。
3. 既存のリトライ回数、backoff、失敗分類、artifact path、job status の互換性を回帰テストで固定する。
4. `AGENTS.md` の secure-io / managed process / tier 境界を actuator 横断で実効化する。

## 実装スコープ

### Wave 1: recovery policy 共通化 (P0)

- `libs/core` に manifest の `recovery_policy` を読む共通 loader と、既定値・manifest値・明示overrideを合成する `buildGovernedRetryOptions` を追加する。
- `classifyError` と `retryable_categories` の扱いを統一する。
- actuator ごとの `DEFAULT_*_RETRY` と特殊な retry 制御は保持し、値の変更を行わない。
- `loadRecoveryPolicy` / `buildRetryOptions` の重複を全 actuator から除去する。

### Wave 2: managed process / native command 境界 (P1)

- `safeExecResult` と `managed-process` を基礎に、短命コマンド向けの構造化 command runner を追加する。
- stdout / stderr / exit code / timeout / JSON parse の扱いを正本化する。
- `code`、`modeling`、`media`、`voice`、`ocr-bridge` などの直接 `child_process` 利用を、意味を変えない範囲で移行する。
- long-running PTY、browser worker、interactive shell は無理に短命 command runnerへ統合しない。

### Wave 3: voice / audio capability facade (P1)

- TTS、voice probe、audio input/output、voice job の共通 capability contract を追加する。
- `system-actuator` と `voice-actuator` は facade として共通 capability を利用する。
- voice profile、voice cloning、個人データ、engine-specific rendering は `voice-actuator` に残す。

### Wave 4: durable job lifecycle (P2)

- job receipt、terminal status、poll / wait timeout、cancel、artifact refs の共通型と helper を追加する。
- `media-generation`、`video-composition`、`voice` の固有 backend 状態を共通 receipt へ射影する。
- backend ごとに異なる retry / cancellation semantics は保持する。

### Wave 5: governed HTTP boundary (P2)

- actuator の外向き HTTP は `secureFetch` を正本とする。
- browser CDP の loopback 接続と presence bridge の local dispatch を、用途固有の allowlist を残したまま共通 timeout / error boundaryへ寄せる。

## 受入条件

- [x] core の共通 helper に unit test があり、manifest override・default fallback・category allowlist・unknown error を検証する。
- [x] actuator の現行 retry options は manifest policy の回帰テスト( browser / media-generation / service )と共通 builder の unit test で固定する。
- [x] direct child_process の新規利用が増えず、短命 command の移行対象に raw spawn が残らない。長期 PTY と detached worker は managed boundary の対象外として維持する。
- [x] voice/audio capability は既存の virtual audio bridge を再利用し、TTS/probe facade の stub・実環境 probe 契約をテストで固定する。
- [x] job helper は completed / failed / cancelled / timed_out / not_found を終端状態として区別し、cancel polling と artifact ref の型を提供する。
- [x] secureFetch 移行後も browser CDP、presence bridge、Ollama の local-only 制約が維持される。
- [x] actuator targeted tests(589 passed / 11 skipped)、core tests、typecheck、build、op registry、lint が成功する。
- [x] Wave 単位のレビュー可能な変更として、本計画・共通部品・actuator 移行・テストを単一PRにまとめる。

## 実装結果 (2026-07-18)

- Wave 1: `buildGovernedRetryOptions` を追加し、全対象 actuator の manifest recovery policy を共通化。死んだ loader/cache/plain-object 定義を除去。
- Wave 2: `runGovernedCommand` と `spawnManagedProcess` を利用し、短命 native command・OCR Swift worker・video worker の境界を統一。
- Wave 3: `voice-capability-bridge` を追加し、system/voice actuator の native TTS probe/speak を共通 facade 経由へ移行。音声入出力は既存の core virtual audio bridge を正本として再利用。
- Wave 4: `job-lifecycle` に terminal vocabulary、receipt/artifact ref、wait/cancel helper を追加し、media-generation/video/voice の polling を移行。
- Wave 5: browser CDP、presence timeline、OCR の LLM/Ollama HTTP を `secureFetch` に統一し、認証情報・loopback 許可境界を維持。
- 検証: `pnpm run typecheck`、`pnpm lint`、`pnpm run build:packages`、`pnpm run build:actuators`、`pnpm run check:op-registry`、`pnpm run test:actuators` を実行済み。

## 実装順序

1. core helper と回帰テスト
2. recovery policy の actuator 移行
3. command runner と直接 process 呼び出しの安全移行
4. voice/audio facade
5. job lifecycle helper
6. HTTP boundary の残存 direct fetch 移行
7. cross-cutting validation とレビュー用PR

## 対象外

- `BaseActuator` のような巨大な継承階層の導入
- PDF / PPTX / XLSX / DOCX のドメインロジック統合
- Browser session semantics、approval / secret / meeting consent policy の統合
- artifact の業務意味を失わせる汎用 file helper 化

## 追跡

- Mission: `ACTUATOR-COMMONIZATION-20260718`
- Branch: `feat/actuator-commonization`
- 既存計画: [IP-09](./IP-09_SHARED_UTILITY_CONSOLIDATION.ja.md)、[AR-05](./AR-05_ACTUATOR_COHERENCE_SPLIT.ja.md)
