# RG-01: 統一推論・モデルガバナンス基盤

> 優先度: **P1** / 規模: L / 状態: 実装済み・検証済み・レビュー引き渡し待ち
> 関連: IP-07, IP-13, MO-05, HN-01, AA-01, OP-01, OP-05, ONB-01, SA-04

## 1. レビュー結論

AGY 側で作成された「ローカル LLM ランタイムとクラウド AI プロバイダーを横断して管理する」という方向性は、Kyberion の運用価値に合っている。ただし、提示仕様のまま実装を確定してはならない。現行リポジトリには既に次の機構が存在するためである。

- `libs/core/reasoning-backend.ts` に `ReasoningBackend` 契約、transient retry、provider health demotion、failover、spend guard、egress gate がある。
- `libs/core/reasoning-model-routing.ts` と `knowledge/product/governance/model-registry.json` に、モデル ID・tier・コスト・レイテンシ・役割適合性の管理がある。
- `knowledge/product/governance/reasoning-backend-policy.json` と `libs/core/reasoning-bootstrap.ts` に、CLI 系・API 系・OpenAI-compatible 系の選択と起動がある。
- `MO-05` はタスク単位の model tier / effort routing、`IP-13` はモデル ID 一元化、`OP-01` はコストと spend cap、`SA-04` は reasoning egress を既に所有している。

したがって本計画の対象は「新しい LLM 抽象を追加すること」ではなく、既存機構を壊さずに **runtime adapter / model / profile / role route / policy constraint** を一つの解決契約へ統合することである。

判定は **条件付き Go** とする。次の設計修正と受入条件を先に合意し、P0 契約を実装してから各ランタイムを横展開する。

## 実装状況 (2026-07-21)

RG-01 の P0〜P5 とレビュー指摘の修正を実装した。主な成果物は `reasoning-route-policy.json` / schema、`reasoning-route-resolver.ts`、role-aware backend、failure taxonomy、`reasoning-route-doctor.ts`、`pnpm reasoning:config`、Operator Surface の `/reasoning`、local runtime runbook、検証 pipeline である。AGY が追加した local runtime adapter 群は維持し、sampling/context/capability 契約の下へ接続した。

- `mode`(adapter) と `model`(identity) を profile/role route から分離した。
- role は `ReasoningCallOptions.role`、`KYBERION_REASONING_ROLE_*`、user overlay の順で解決し、選択理由と governance posture を `list --json` / `explain` で確認できる。
- user overlay は secure-io、schema 検証、backup/rollback を通り、egress・data tier・spend cap を持たないため、それらを上書きできない。
- sampling は adapter の supported parameter と照合し、OpenAI-compatible runtime の preset だけから context window を推測しない。
- transient/capacity/capability/auth/policy/request/cancelled を分類し、policy/auth/request/cancelled は無言の自動再送を行わない。
- tool access は deny-by-default、local endpoint は private network に限定し、unknown public egress は allowlist または明示 scope がない限り拒否する。
- model identity は `model_ref` から model registry の approved 状態を検証し、retry 上限・候補数・safe translation を failover 実装へ接続した。
- `reasoning:config doctor` と Operator Surface `/reasoning` が effective fallback、runtime readiness、next action を表示する。
- 対象 5 スイート 52 テスト、typecheck、lint、schema/catalog/env/script/pipeline governance gate、RG-01 validation pipeline を確認済み。

既存の未コミット差分に依存する mission reconciliation 系テストと、別領域の intent coverage/procedure cache テストは本計画の変更起因ではないため、実装成果と分離して扱う。

## 2. 提案仕様の主な指摘

### P0: `mode` と `model` の二項だけでは実行可能性を表せない

Ollama・vLLM・LM Studio・llama.cpp・MLX・LocalAI は、同じ OpenAI-compatible transport であっても、モデル ID の表記、`/v1` の有無、tool/vision/structured output、context limit、stop や sampling の対応が異なる。一方、Claude・Codex・AGY・Copilot は CLI/SDK/ACP のホストアダプタであり、OpenAI-compatible backend と同一視できない。

`mode` は transport/adapter の選択に限定し、モデルそのものと分離する。

### P0: fallback は「provider の配列」ではなく「要求を満たす候補の解決」である

`{ "mode": "agy-cli" }` のような候補では、モデル、認証、tool capability、データ tier、予算、deadline を検証できない。さらに、認証失敗・ポリシー拒否・不正リクエストまで別 provider に送ると、失敗を隠し、意図しない外部送信やコストを発生させる。

fallback は role/request ごとの候補 profile に対して、能力・安全制約・failure taxonomy を満たす場合だけ進める。context overflow は無条件 retry ではなく、明示的な縮約、別 context 対応候補、または operator への停止に分類する。

### P0: ユーザー override は security policy を上書きしてはならない

「ユーザー最優先」は利便性としては正しいが、egress、data tier、spend cap、承認要求、禁止モデル、secret source は override の対象外である。コード内 `options` や環境変数が、これらの制約を bypass できてはならない。

また、任意の deep merge は未知キー混入、配列の置換、policy の意図しない消失を招く。schema 検証済みの限定的な field overlay とし、解決結果に provenance を残す。

### P1: sampling/context は共通値として無条件送信できない

`temperature`、`top_p`、`top_k`、`min_p`、penalty、stop は provider/model ごとに対応範囲と意味が異なる。`context_window_tokens` も runtime preset の固定値ではなく、モデルの正準 registry、endpoint probe、operator 明示値の順に解決し、未知なら安全側に扱う。

各 adapter が capability を宣言し、unsupported parameter は `reject` / `warn-and-drop` / `translate` の policy に従う。無言で捨てたり、全 provider に同じ body を送ったりしない。

### P1: CLI は状態変更だけでなく「なぜそう解決されたか」を示す必要がある

`list` だけでは、環境変数・user overlay・policy・health demotion・fallback のどれが効いたか分からない。`explain`、`validate`、`doctor`、JSON 出力、dry-run、rollback を第一級にする。

## 3. 正準モデル

設計上の責務を次の五つに分ける。

| 概念                  | 責務                          | 代表的な情報                                                   |
| --------------------- | ----------------------------- | -------------------------------------------------------------- |
| Runtime adapter       | 接続方式と認証・送受信変換    | `ollama`, `vllm`, `anthropic-sdk`, `agy-cli`, endpoint ref     |
| Model registry entry  | モデルの正準 identity と能力  | `provider_model_id`, context, output limit, capabilities, cost |
| Runtime profile       | adapter と model の組み合わせ | runtime ref, model ref, timeout, parameter policy              |
| Role route            | 役割ごとの候補順と要求能力    | `subagent`, `code_architect`, `fast_classifier`, candidates    |
| Governance constraint | 全候補に適用する上限          | tier, egress, spend, approval, deadline, data residency        |

概念的な構造は次の通りとする。実際の JSON 名は既存 registry/schema と整合させて決める。

```json
{
  "runtimes": {
    "ollama-local": {
      "adapter": "openai-compatible",
      "preset": "ollama",
      "endpoint_ref": "env:KYBERION_OLLAMA_URL",
      "credential_ref": "env:KYBERION_OLLAMA_KEY"
    }
  },
  "models": {
    "agents-a1-4b": {
      "provider_model_id": "Agents-A1-4B",
      "runtime_refs": ["ollama-local"],
      "context_window_tokens": 262144,
      "capabilities": ["text", "structured_output"]
    }
  },
  "profiles": {
    "subagent-local": {
      "runtime_ref": "ollama-local",
      "model_ref": "agents-a1-4b",
      "sampling_policy": "local-balanced"
    }
  },
  "roles": {
    "subagent": {
      "candidates": ["subagent-local", "subagent-cloud"],
      "requires": ["text", "structured_output"]
    }
  }
}
```

credential は設定ファイルに値を保存せず、環境変数・secret resolver の参照だけを持つ。durable な user preference と、health/cache の runtime state も分離する。推奨は、user preference を personal overlay、health・last failure・resolved cache を `active/shared/state` に置く構成である。

## 4. 解決契約と優先順位

`resolveReasoningRoute(request, policy, overlays, capabilities)` は、次の不変な結果を返す。

```ts
type ResolvedReasoningRoute = {
  role: string;
  runtimeRef: string;
  modelRef: string;
  adapter: string;
  modelId: string;
  parameters: Record<string, unknown>;
  capabilities: string[];
  limits: { contextWindowTokens?: number; maxCompletionTokens?: number; timeoutMs: number };
  governance: { tier: string; egressDecision: string; spendDecision: string };
  provenance: Array<{ source: string; field: string }>;
};
```

解決順は、利便性のための値と制約を分ける。

1. request の role/model/profile 指定
2. user の role/profile overlay
3. organization/tenant overlay
4. product policy と model registry
5. 自動発見と health-aware candidate filtering
6. 全段階に security/cost/egress/tier の intersection を適用

1〜5 は通常の値の優先順位であり、6 は常に最終制約として残る。明示された `options.mode` も、未知 profile、禁止 endpoint、能力不足、spend cap 超過を bypass できない。

## 5. fallback failure taxonomy

| 分類                 | 例                                     | 次候補へ進むか                                          |
| -------------------- | -------------------------------------- | ------------------------------------------------------- |
| transient            | timeout、429、5xx、gateway unavailable | retry budget 内で retry、枯渇後に進む                   |
| capacity             | context overflow、max output 不足      | request 縮約または対応候補へ進む                        |
| capability           | tool/vision/structured output 非対応   | 要求を満たす候補へ進む                                  |
| auth                 | API key 不正、CLI 未ログイン           | 原則停止。別 credential policy が明示された場合のみ進む |
| policy               | egress deny、tier mismatch、spend cap  | 停止・承認要求。自動 fallback しない                    |
| request              | schema 不正、invalid parameter         | 停止して修正。retry しない                              |
| user cancel / safety | operator 中止、safety refusal          | 停止。別 provider に再送しない                          |

既存の `FailoverReasoningBackend` は再利用するが、候補に `capabilities`、`failurePolicy`、`budget`、`role`、`profileRef` を持たせ、現在の文字列パターン中心の判定を型付き分類へ段階移行する。provider health demotion は transient/capacity の候補から始め、policy/auth を短時間の health failure として扱わない。

## 6. 段階的実装計画

### RG-01-P0: 現行機構の inventory と契約固定 — P0 / S

対象: `reasoning-backend-policy.ts`、`reasoning-bootstrap.ts`、`reasoning-backend.ts`、`reasoning-model-routing.ts`、model registry/schema、既存 improvement plans。

- 現在の backend mode、adapter、model ID、env、probe、fallback、metrics、egress、spend の対応表を作る。
- `mode`、model registry、profile、role routing の責務境界を schema と TypeScript 型で固定する。
- 既存の `model-registry` を model identity の正本、`reasoning-level-policy`/`MO-05` を task tier/effort の正本として再利用する。
- 重複する `model_profiles` や role 定義を `reasoning-backend-policy.json` に直接増やす前に、正本の配置を決定する。

受入条件: 既存の全 backend が一つの inventory で表現され、既存 public API と未コミットのローカル runtime 拡張を壊さない。

### RG-01-P1: read-only resolver と explain — P0 / M

対象: 新規 resolver module、既存 policy loader、schema、`reasoning:setup`/doctor。

- profile/role/capability/constraint を解決する read-only API を追加する。
- deep merge ではなく、許可 field の explicit overlay と schema validation を実装する。
- `ResolvedReasoningRoute` と provenance を JSON で出力する。
- 既存の単一 backend 選択は adapter compatibility layer として resolver の下に接続し、挙動を shadow 比較する。

受入条件: 既存設定と新 resolver の結果が一致する fixture、未知 profile/role/model、未対応 parameter、secret 値のログ漏洩を検出するテストがある。

### RG-01-P2: capability-aware adapter contract — P0 / M

対象: `openai-compatible-backend.ts`、CLI/SDK/ACP adapter、capability probe。

- adapter ごとの capability descriptor と parameter translation を導入する。
- OpenAI-compatible 系は一つの共通送信実装を再利用し、runtime preset 固有の URL 正規化・モデル照会・tool/vision 対応を preset に閉じ込める。
- context window は preset の一律既定値を正本にせず、model registry → probe → 明示設定の順で解決する。未知値は安全側に縮約する。
- Anthropic/Codex/AGY/Copilot は専用 adapter のままにし、OpenAI-compatible body を強制しない。

受入条件: Ollama/vLLM/LM Studio/llama.cpp/MLX/LocalAI と CLI/SDK 系について、text・structured output・tools・vision・streaming・unsupported parameter の capability matrix が fixture test で確認できる。

### RG-01-P3: role binding と task routing の接続 — P1 / M

対象: `ReasoningCallOptions`、`reasoning-bootstrap.ts`、delegate/worker dispatch、`MO-05`、`HN-01`。

- `role` は任意文字列をそのまま env 名に変換せず、正規化・許可 role registry・未知 role の明示エラーを設ける。
- `subagent`、`code_architect`、`fast_classifier` 等を role route に接続する。
- MO-05 の task tier/effort hint と profile の model choice を統合する。既存の shadow/advisory を保持し、初期値は挙動を変えない。
- role route は provider/model の固定ではなく、要求 capability と governance constraint を満たす候補列を持つ。

受入条件: role 未指定、明示 role、task hint、user overlay、候補枯渇の各経路で、選択理由と実際の model/adapter が trace に残る。

### RG-01-P4: typed failover と予算・egress接続 — P1 / M

対象: `FailoverReasoningBackend`、provider health、`OP-01`、`SA-04`、AA-01。

- failure taxonomy を型付き結果へ移行し、retry/fallback/stop の decision table を実装する。
- 1 request の deadline、最大試行数、推定/実測 token、cost cap、context reduction を共通 envelope にする。
- policy/auth/data-tier/safety failure は silent fallback せず、operator 向け next action と監査を出す。
- fallback 時も egress gate と spend guard を各候補の送信直前に適用する。

受入条件: transient は制限内 retry、auth/policy/request は再送なし、context overflow は縮約または対応候補、spend/egress deny は外部送信なし、というテストがある。

### RG-01-P5: CLI・オンボード・運用可視化 — P1 / M

対象: `scripts/reasoning_setup.ts`、新規 `reasoning:config`、`run_doctor.ts`、ONB-01、OP-05。

- `list --effective`、`explain --role`、`validate`、`bind-role`、`set-fallback --role`、`rollback`、`--json`、`--dry-run` を提供する。
- 書き込みは secure-io、schema 検証、atomic write、許可された user overlay のみとする。
- CLI の `set-fallback <profile1,profile2>` のような role 非依存・provider だけの指定は廃止する。
- onboarding は候補の存在だけでなく、実際に要求 capability を満たす疎通確認と data egress/cost posture を表示する。

受入条件: operator が「現在の role がなぜこの候補を使うか」「次の候補はなぜ使えないか」「どの設定を戻せばよいか」を一つのコマンドで確認できる。

## 7. 検証計画

- schema contract: policy、registry、profile、overlay の valid/invalid、unknown key、range、secret ref。
- resolver property test: precedence、constraint intersection、候補順の決定性、同一入力の同一結果。
- adapter contract test: fake HTTP server / fake CLI で capability と parameter translation を検証する。実 API は unit test に持ち込まない。
- failover matrix: taxonomy ごとの retry、demotion、stop、fallback、deadline、spend、egress。
- integration: `KYBERION_REASONING_BACKEND=stub` の hermetic path、実 Ollama probe、各 CLI の availability probe を分離する。
- regression gate: `pnpm run typecheck`、対象 vitest、`pnpm run validate`、`git diff --check`。実装後は baseline pipeline を再実行する。

## 8. 運用リスクと rollout

1. P0〜P1 は read-only/shadow とし、既存の単一 backend 選択を壊さない。
2. P2 は adapter capability とパラメータ送信だけを provider ごとに段階導入する。
3. P3 は `KYBERION_REASONING_ROLE_ROUTING=advisory` を既定とし、trace で実測する。
4. P4 は transient fallback のみ enforce し、policy/auth/request は最初から停止する。
5. P5 の user override は個人環境で opt-in し、コスト・egress・tier 制約は常に enforce する。
6. 役割別の成功率、fallback 率、context 縮約率、latency、cost、stub taint、policy deny を 1〜2 週間観測してから default role binding を変更する。

## 9. 実装開始ゲート

次の状態になるまで、提示された `reasoning-backend-policy.json` の v1.1 拡張、role env の大量追加、全 provider の一括 fallback 実装は開始しない。

- canonical owner が `model-registry`、`reasoning-level-policy`、新 profile/route policy の間で明文化されている。
- `ResolvedReasoningRoute` と failure taxonomy の型・schema・fixture がレビュー済みである。
- user override が egress/tier/spend/approval を上書きできないことをテストで証明できる。
- CLI/SDK/ACP と OpenAI-compatible の adapter 境界が分離されている。
- 既存の未コミット local runtime 拡張を含む現行差分を、実装ブランチで個別に検証できる。

このゲートを満たした後、P0→P1→P2 の順で小さく実装し、各段階で検証結果をレビューへ引き渡す。
