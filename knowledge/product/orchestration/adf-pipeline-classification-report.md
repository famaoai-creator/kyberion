# ADF パイプライン分類レポート

**Date**: 2026-05-04  
**Basis**: `adf-pipeline-strategy-report.md` and `adf-pipeline-validation-plan.md`

## 1. Classification Summary

| Pipeline | Class | Reason |
|---|---|---|
| `trial-narrated-report.json` | Simplify | `system:shell` で preflight, heredoc, runtime checks, artifact verification を抱え込みすぎている |
| `meeting-facilitation-workflow.json` | Simplify | 会議進行の周辺処理を shell と複数の検証ステップに分散しており、実行意図が読みにくい |
| `platform-onboarding.json` | Abstract | 要件抽出・設計・テスト・タスク分解の SDLC 骨格が明確で、他の onboarding 系と共有可能 |
| `faas-add-api.json` | Abstract | 要件 → 設計 → task plan → 実行 の流れが共通化しやすい。個別差分は project-specific |
| `design-from-requirements.json` | Abstract | すでに共通 SDLC の一部として機能しており、fragment 化の候補として最も自然 |
| `ceo-strategic-report.json` | Concrete | 出力構造と必須データソースが曖昧で、Markdown テンプレートの固定が必要 |
| `list-capabilities.json` | Concrete | `reasoning:synthesize` の指示が高レベルすぎるため、見出しと必須項目を固定した方が安定する |

## 2. Simplify Candidates

### 2.1 `trial-narrated-report.json`

Observed traits:

- `system:shell` の preflight が長い
- `cat > ... <<'EOF'` で JSON アクションを直接組み立てている
- 音声生成、動画生成、検証が 1 パイプラインに密結合している

Recommended direction:

- `system:ensure_binaries` 相当の専用操作へ preflight を分離
- JSON アクション生成を reusable fragment へ移す
- audio / video の検証を共通 artifact-check helper に分離

### 2.2 `meeting-facilitation-workflow.json`

Observed traits:

- join / listen / leave の間に複数の `system:log` が入っている
- `system:shell` で meeting-actuator を直接叩いている
- action item 抽出や speaker fairness が同一フローに入り、責務境界がやや広い

Recommended direction:

- 会議接続・待機・退出を actuator 側に寄せる
- extracting / auditing は別 fragment へ分離
- 入出力ログは最小限にする

## 3. Abstract Candidates

### 3.1 `platform-onboarding.json`

Observed traits:

- requirements / design / test plan / task plan の定型 SDLC
- ほぼ全ての step が `wisdom:*` で構成されている
- 個別化されているのは `additional_context` だけ

Recommended direction:

- `pipelines/fragments/standard-sdlc-loop.json` に抽出
- 具体的パイプラインは `additional_context` と project metadata だけ上書きする

### 3.2 `faas-add-api.json`

Observed traits:

- onboarding と同型の SDLC に加えて execution がある
- request capture が shell で書かれている
- project 固有の deployment assumptions はあるが、骨格は共有可能

Recommended direction:

- `standard-sdlc-loop.json` を再利用
- request capture は別 fragment へ移す
- execution は downstream step として明示化する

### 3.3 `design-from-requirements.json`

Observed traits:

- かなり小さいが、抽象化候補の中核
- requirements draft から design spec を生成する単一責務

Recommended direction:

- SDLC fragment の `design` ステップとして取り込む
- 単独パイプラインとしては残してもよいが、主用途は再利用

## 4. Concrete Candidates

### 4.1 `ceo-strategic-report.json`

Observed traits:

- `system:glob_files`, `system:read_json`, `system:read_file`, `system:run_js` で情報を集めている
- 何を必須入力とみなすかがコードに埋まっている
- Markdown の section 仕様が変化しやすい

Recommended direction:

- 必須セクションを `params` 側で宣言する
- `VISION.md` などの必須ソースを固定する
- 出力テンプレートを別ファイルに分離する

### 4.2 `list-capabilities.json`

Observed traits:

- 入力は明確だが、出力フォーマットが `reasoning:synthesize` の自然言語指示に依存している
- section 分類が LLM 任せ

Recommended direction:

- 見出し・カテゴリ・項目レイアウトをテンプレート化する
- 出力 schema を明示する

## 5. Priority Order

1. `trial-narrated-report.json`
2. `meeting-facilitation-workflow.json`
3. `platform-onboarding.json`
4. `faas-add-api.json`
5. `design-from-requirements.json`
6. `ceo-strategic-report.json`
7. `list-capabilities.json`

## 6. Interpretation

This classification suggests the following operating rule:

- execution-heavy pipelines should be simplified by pushing mechanical work into actuators
- repeated SDLC flows should be abstracted into shared fragments
- executive-facing output should be concretized with templates and required sources

That is the cleanest split between reusable semantics and environment-specific mechanics.

---
*Report distilled on 2026-05-04*
