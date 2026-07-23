# ユーザインテントからユースケースシナリオへの接続

Kyberion は、ユーザの自由文をいきなり actuator や pipeline に渡さない。まず「何をしたいのか」をユースケースシナリオとして可視化し、そのシナリオを実行契約とガバナンスへ接続する。

## 基本フロー

```text
ユーザの自由文
  ↓
IntentResolutionPacket
  - 候補 intent
  - confidence
  - execution shape
  - capability bundle候補
  ↓
IntentUseCaseScenario
  - actor / trigger / goal
  - preconditions / inputs
  - steps / outputs
  - success conditions
  - approval / review / missing inputs
  - 次の handoff
  ↓
ExecutionBrief + IntentContract
  ↓
OrganizationWorkLoop
  ↓
clarification / approval / runtime recovery / execution
```

`IntentUseCaseScenario` は、LLMの説明文ではなく、`intent-resolution-packet.schema.json`、`intent-contract.schema.json`、`organization-work-loop.schema.json` の結果を結合した検証可能な中間契約である。

## オペレーターが確認する

副作用を発生させずにシナリオだけを確認する。

```sh
pnpm build
pnpm intent:scenario "既存のSTT/VAD/TTSでリアルタイム音声チャットを試したい"
```

結果の `use_case_scenario.handoff` を確認する。

- `ready` + `execute`: 実行経路へ進める
- `needs_clarification` + `clarify_inputs`: `missing_inputs` と clarification packet をユーザへ返す
- `ready` + `request_approval`: approval gate へ渡す
- `ready` + `confirm_scope`: review / scope確認を先に行う
- `blocked` + `resolve_runtime`: runtime readiness を回復する

実行する場合は通常の入口を使う。

```sh
pnpm intent:run "既存のSTT/VAD/TTSでリアルタイム音声チャットを試したい"
```

## Surface 経由

Surface では、短い通常メッセージや明示的な直接委譲はレイテンシを優先して従来の高速経路を使う。一方、Task Session と判定された入力、長文、改行を含む入力は `compileUserIntentFlow` を通り、生成された `IntentUseCaseScenario` を Surface agent の構造化コンテキストへ渡す。

Surface agent はシナリオの handoff に従って、次のいずれかをユーザ向けに説明・実行する。

- 不足入力がある: 必要な情報だけを確認する
- 承認が必要: 実行内容と承認を依頼する
- runtime が未準備: 復旧に必要な手順を案内する
- 実行可能: シナリオの手順と成功条件に沿って進める

## 今回の音声バックエンド導入への適用

今回のように「軽量なSTT/VAD/TTSを導入して実際に試したい」という依頼は、次の順で具体化する。

1. 目的: リアルタイム音声チャットを利用可能にする
2. 入力: 対象OS、マイク・スピーカー、言語、既存runtime、必要な外部モデル
3. シナリオ: backend候補の選定、setup、health probe、実音声smoke、fallback確認
4. 成功条件: 音声入力が取得でき、VADが発話を区切り、STT/TTSが接続され、実際の会話または明示的な不足理由を返せる
5. handoff: 不足デバイス・runtime・認証があれば実行せず、質問またはrecovery intentへ戻す

これにより、`PR` や `マージしました` のような後続操作も、元のシナリオと検証結果を追跡できる。
