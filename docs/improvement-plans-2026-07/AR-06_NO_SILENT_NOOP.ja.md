# AR-06: silent no-op の撲滅 — 未知 op を「成功」でなく「エラー」に

> 優先度: P1(小・高価値の即効) / 規模: S / 依存: AR-02(op 分類の正確化)推奨 / 関連: IP-08(エラー規律)、HN-03(無音打ち切り)
> **検証(2026-07-03, Fable)**: `file-pipeline-helpers.ts` に `default: return ctx;`(:178/:237/:249)を確認 — 未知/誤分類 op が **status=success のまま何もしない**。verb 経路は `:95` で throw(整合が取れていない)。

## 進捗(2026-07-04)

- **完了済み(Task 1 の大半)**: file / android / ios / code / media / modeling / network / orchestrator / system / wisdom の各 pipeline-helpers で silent `default: return ctx;`(および warn+素通し)を `throw new Error('[UNKNOWN_OP] Unknown op: ...')` に置換。file-actuator は未知 step type も `[UNKNOWN_TYPE]` エラー化。
- **完了済み(Task 3 の一部)**: android / ios の代表テストを「未知 op → status=failed + `[UNKNOWN_OP]` エラー」を固定する形に更新。
- **完了済み(Task 2 の一部)**: `determineActuatorStepType` の既定 `apply` フォールバックを除去し、未知 op は `file` / `media` / `system` を含む全体で `[UNKNOWN_OP]` エラーに倒れるようにした。
- **未完了**: 「近い op を suggest」する teach メッセージ(Task 1-1 後半 / Task 2-2)、正当な no-op の `skipped` 明示化(受入条件3)、silent default を検出する lint / 専用チェック(Task 3 前半)、AR-01 正準エンジンへの集約(Task 2-1)。

## 背景と課題

「動くはず」を裏切る最悪の体験: **op を打ち間違える/type を誤分類すると、エラーでなく `status:success` で無反応**になる。

- file-actuator の `opCapture`/`opTransform`/`opApply` は未知 op で **`default: return ctx;`**(`file-pipeline-helpers.ts:178,237,249`)= ctx を素通しして成功扱い。AR-02 で判明した op-registry ドリフト(`stat`/`exists`/`tail` の誤分類)がここに落ちると無反応になる。
- 同型の silent default が他アクチュエータの switch にもある(調査: 「mistyped op / 誤分類で status:success」)。
- 対照的に verb 経路は throw(`:95`)で、**同一アクチュエータ内でも整合していない**。
- これは HN-03 の「無音打ち切り禁止」原則の op dispatch 版。

## ゴール(受入条件)

1. **未知 op / 未対応 op は必ずエラー**(status=failed、teach するメッセージ: 「未知 op `foo`。近い op: bar/baz」)を返す。silent `default: return ctx;` を全アクチュエータで撲滅。
2. AR-02 の分類が「未知」を返した場合、エンジンが silent apply に落とさずエラーにする。
3. 正当な「no-op(条件不成立で何もしない)」は明示的に区別(status=skipped + 理由)し、エラーと混同しない。
4. 回帰防止: silent default を検出する lint / test を追加。

## 実装タスク

### Task 1: silent default の撲滅 — `claude-sonnet-4`(file でパターン)→ `claude-haiku`(横展開)

1. file-actuator の `default: return ctx;`(3箇所)を「未知 op エラー(近い op を suggest)」に置換。正当な skip は `{status:'skipped', reason}` で明示。
2. 全アクチュエータの switch `default` を grep し、silent 素通しを同パターンで修正。AR-01 の正準エンジンに未知 op ハンドリングを集約できれば per-actuator の default 自体を不要にする。

### Task 2: エンジン側の未知 op ガード — `claude-sonnet-4`

1. AR-01 の正準エンジンで、op-handler map に無い op は**即エラー**(AR-02 の分類「未知」と連携)。誤分類→silent apply の経路を断つ。
2. 「近い op」suggest は AR-02 の op index からレーベンシュタイン等で算出。

### Task 3: 回帰防止 — `claude-haiku`

- 「switch の `default: return ctx`(エラーを投げない素通し)」を検出する eslint `no-restricted-syntax` or 専用 check を追加(過剰なら test で代替)。代表アクチュエータで「未知 op → failed」を固定するテスト。

## リスクと注意

- **正当な no-op を error にしない**こと。条件不成立・任意 op の未指定は `skipped`(理由付き)で、未知/誤字 op のみ `failed`。区別を Task 1 で明確化。
- 未知 op を error 化すると、これまで silent に無視されていた「誤字テンプレ」が顕在化して落ちる可能性。まず warn(log + skip)で観測 → 誤字テンプレを修正 → error 化、の段階導入を許容(HN-03 の無音打ち切り解消と同方針)。
- AR-02 の正確な分類が前提。単独でも file の3箇所は即修正可(高価値の即効)。
