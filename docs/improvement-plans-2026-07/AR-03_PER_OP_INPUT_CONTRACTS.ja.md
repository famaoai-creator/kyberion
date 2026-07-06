# AR-03: per-op 入力契約 — `params: any` を検証付き契約に

> 優先度: P1 / 規模: M〜L / 依存: AR-02(op 単一源) / 関連: IP-11(型安全)、HN-02(schema-forced)、IP-05(入力検証)
> **検証(2026-07-03, Fable)**: 各アクチュエータのスキーマは op 名を enum で縛るのみで `params: { type: "object" }`(per-op プロパティ無し)。verb 系は op 名すら自由形式のものあり。`resolveWriteArtifactSpec` は runtime で `write_artifact requires params.path or output_path` を throw(必須が事前宣言されていない)。

## 背景と課題

- **per-op の入力契約が実質存在しない**。envelope 系は op 名 enum のみ、`params` は `object` 素通し。verb 系(media-generation/voice/wisdom)は `params: { type: object }`。結果 `params` は全アクチュエータで `any` として dispatch に届く(IP-11 と連結)。
- **必須/任意が不可視**。必須はコードの imperative throw にしかない(`logic-utils.ts` の `resolveWriteArtifactSpec` 等)。
- **per-op の example がどこにも無い**(manifest/schema に `examples` なし)。作者は 99 テンプレを逆解析するしかない。
- 誤った op/param は silent no-op(AR-06)や runtime throw になり、事前に teach されない。

## 進捗(2026-07-06)

- **完了済み(一部)**: `resolveRequiredStringParam` を導入し、`write_artifact` の `params.path` / `params.output_path` 必須判定を共通化した。file-actuator でも `write` / `append` / `delete` / `mkdir` / `copy` / `move` の path 系必須入力を前倒しで検証するようにした。
- **完了済み(一部)**: `libs/core/op-input-contracts.ts` を追加し、browser/file/system の主要 op に JSON Schema を付与した。browser recording の compile/run と file pipeline の dispatch 前、`system-actuator` の capture/apply 入口、さらに `run_pipeline` の system/browser/file dispatch 前で `validateOpInput()` を通すようにした。
- **完了済み(一部)**: `system:notify` に加えて `system:read_file` / `system:read_json` / `system:open_file` / `system:app_quit` / `system:process_kill` も input contract に追加し、host notification と host file/path/process 系の入力を前倒しで検証できるようにした。
- **完了済み(一部)**: `system-actuator` の `describeOps()` に `input_schema` / examples を載せ、`generate_op_registry` の discovery 出力に反映できるようにした。
- **完了済み(一部)**: `actuator-op-discovery.json` も contract-backed op について `input_schema` / examples を持つように再生成した。
- **未完了**: AR-01 の正準 dispatch に全面接続すること、browser/system/file/service の残り高頻度 op への横展開、型付き params の dispatch 伝播。

## ゴール(受入条件)

1. 各 op に **入力スキーマ(`schema_ref`)** が付き、必須/任意・型・例を宣言する(AR-02 の `OpSpec` に `input_schema` を持たせる)。
2. dispatch **前**に `params` を検証(Ajv/Zod)。不正は「不足: `path`(例: …)」の teach するエラー(silent no-op でなく)。
3. 外部入力に晒される op(browser/system/file/service の高頻度 op)から段階整備。全 op 完備はスコープ外(上位から)。
4. 検証済み `params` を型付きで dispatch に渡し、`params: any` を減らす(IP-11 のラチェットに寄与)。

## 実装タスク

### Task 1: OpSpec への input_schema 追加 — `claude-sonnet-4`

1. AR-02 の `describeOps(): OpSpec[]` に `input_schema`(Zod or JSON Schema)を追加。必須/任意・型・`examples` を宣言。
2. 既存の imperative throw(`resolveWriteArtifactSpec` 等)を input_schema の必須宣言に移し、runtime throw を事前検証に格上げ。

### Task 2: dispatch 前検証 — `claude-sonnet-4`

1. AR-01 の正準エンジンの op dispatch 直前に、当該 op の input_schema で `params` を検証する共通ゲートを入れる。不正は teach エラー(不足フィールド + 例)。HN-02 の schema-forced と検証層を共有。
2. 検証通過後の `params` を型付きで handler に渡す。

### Task 3: 高頻度 op のスキーマ整備 — `claude-sonnet-4`(上位順)→ `claude-haiku`(横展開)

1. 外部入力順(browser fill/click/goto、system exec/screenshot、file read/write、service api)で input_schema + example を起こす。1 op ごとに不正入力テスト1件。
2. 残りは「未整備」を op index に記録(AR-02 の生成物に反映)して段階化。

## リスクと注意

- 全 op の完全スキーマ化は大きい。**外部入力に晒される高リスク op から**着手し、内部 op は段階化(IP-05/AR-02 と歩調)。
- 事前検証の厳格化で、これまで通っていた緩い入力が弾かれ得る。まず warn(検証失敗をログするが通す)で観測 → enforce。
- example は実テンプレから採取(99テンプレが供給源)。捏造しない。
