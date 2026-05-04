# Provider Capability Scan Framework

Kyberion は、プロバイダー固有のツール機能を `ADF` に直書きせず、`registry + scan policy + adapter registry` の 3 層で扱う。

## Layers

1. `harness-capability-registry.json`
   - 何を capability として扱うかを定義する。
   - 新しいツールを増やすときは、まずここに capability entry を追加する。

2. `provider-capability-scan-policy.json`
   - どの provider をどう probe するかを定義する。
   - `codex --help`、`gemini --help`、`gh --help` のような host/provider probe をここに集約する。
   - capability ごとの細かい evidence probe もここで差し込める。

3. `harness-adapter-registry.json`
   - capability をどの contract / surface で実行するかを定義する。
   - scan で見つかった capability は、ここに adapter があるかで governed execution へ進める。

## TODO: Common Override Layer

`fallback_contract` と `approval_behavior` は capability ごとに固定し切らず、将来的には共通ポリシーで上書きできるようにする。

解決順の想定:

1. capability default
2. provider-level override
3. mission / scenario override
4. runtime policy override

この段階では、registry に直接埋め込んだ値を正として扱うが、運用が安定したら上書きレイヤーを別ファイルに分離する。

## Runtime Flow

1. `discover_capabilities`
   - `code-actuator` が capability registry を読み込む。
   - scan policy に従って provider availability を probe する。
   - 可用な provider の capability を一覧化する。

2. `provider-capabilities:scan`
   - 運用用の JSON 出力。
   - どの provider が使えるか、どの capability が現時点で見えているかを確認する。

3. `provider-capabilities:report`
   - governance 用の Markdown 出力。
   - capability registry と adapter registry の整合と、provider 可用性をまとめる。

## Maintenance Rule

- 新しいツールを追加する場合は、まず `harness-capability-registry.json` に登録する。
- そのツールが新しい provider / runtime を必要とする場合のみ `provider-capability-scan-policy.json` を更新する。
- 実行 contract を追加する場合は `harness-adapter-registry.json` を更新する。
- これにより、scan ロジック自体はほぼ固定のまま保てる。
- `fallback_contract` と `approval_behavior` の共通上書きは TODO として別レイヤー化する。
