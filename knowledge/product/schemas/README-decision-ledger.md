# 決定台帳(decision ledger)のスキーマ

概念名は SSOD(Single Source of Decisions)。コード・パス・画面では `decision-ledger` / `decisions` / 「決定台帳」を使う。

`decision-*.schema.json` と `product-concept.schema.json` は、テナント配下の**決定台帳**の器です。
計画: [SSOD_HEARING_INTEGRATION_PLAN_2026-09-14](../../../docs/developer/improvement-plans-2026-09/SSOD_HEARING_INTEGRATION_PLAN_2026-09-14.ja.md)。
実装: `libs/core/decision-ledger/`、facade: `pnpm decisions`。

| スキーマ                               | 器                                                                                                             | 誰が書くか                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `decision-record.schema.json`          | 決定 1 件(`decisions.jsonl` の 1 行)。item × key に対して active は 1 件。後の決定は `supersedes` を名指しする | 人(`pnpm decisions decide / import` 経由のみ) |
| `decision-observed.schema.json`        | 実装から観測した値の集合(版つき)                                                                               | 機械(観測器)                                  |
| `decision-lock.schema.json`            | 実装が検査された decided 決定の凍結。実装 repo にコミットして CI で再検査                                      | 機械(`pnpm decisions check`)                  |
| `decision-customer-actors.schema.json` | テナントの顧客の決定アクター。`customer-value` はここに載る actor の承認証跡があるときだけ decided             | テナントの owner                              |
| `product-concept.schema.json`          | プロダクトが何で、誰のため、何を約束し、何をしないか。greenfield ヒアリングの出力型                            | ヒアリングの決定                              |

## 決定の 2 階建てと権限(`level × actor`)

| level            | 意味                                       | decided にできる人                                                  |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `product-fixed`  | プロダクトが決め、顧客は変えられない       | プロダクト側の owner / approver                                     |
| `product-axis`   | プロダクトが「選べる軸」と選択肢を宣言する | 同上。**`options` が空なら decided にならない**                     |
| `customer-value` | 顧客が軸上の値を選ぶ                       | 顧客 actor(`on_behalf_of` + `evidence`)。無ければ `proposed` のまま |
| `undecided`      | まだ level が無い                          | 誰も。先に level を決める                                           |

## 権限ポリシー(`decision-authority-policy.schema.json`)

上の表は `knowledge/product/governance/decision-authority-policy.json` が正本で、`promote.ts` はそれを引数に取る純関数(既定値は同じ内容のコード内ミラー)。
level ごとに `deciding_roles`・`requires_options`・`customer_actor_required`・`customer_evidence_required` を持つ。

## 状態機械

`observed / enacted`(機械が抽出・稼働実績)→ `proposed`(会話の答え・上流の提案)→ `decided`(人・根拠つき)→ lock → 検査。
拒否理由は文字列コード(`basis_required` / `supersedes_required` / `customer_approval_required` …)で返り、文言は語彙側で解決する。

## 置き場

```
knowledge/confidential/<tenant>/decisions/<case>/decisions.jsonl
knowledge/confidential/<tenant>/decisions/<case>/observed.json
knowledge/confidential/<tenant>/decisions/<case>/lock.json
knowledge/confidential/<tenant>/decisions/<case>/report.json
knowledge/confidential/<tenant>/decisions/<case>/concepts/PC-*.json
knowledge/confidential/<tenant>/customers/<customer>/actors.json
```

確定した決定は会話の一時領域(`active/shared/tmp/hearing/`)には残さない。

## 観測器(SD-06)— `decision-probes.schema.json`

実装を読む観測器はテナント固有のコードにしない。案件の台帳に `probes.json`(何のファイルのどの正規表現を、どう読むか)を
データとして置き、`pnpm decisions probe --impl <repo 内の checkout> [--commit <sha>]` が `observed.json` を作る。
`capture` は `string / number / boolean / json / list / count / exists`、`stale_if` は「古い版の参照」の検出。
実装リポジトリ側の CI からは、同じ probes を実行した `observed.json` を `pnpm decisions check --observed` に渡す。
secure-io はリポジトリ外を読めないので、`--impl` は `active/shared/tmp/` 配下などリポジトリ内の checkout を指す。

## 投影キャンバス(SD-05)

台帳ヒアリング(`scenario=decisions-<case>-<actor>`)のキャンバスはモデル生成ではなく、台帳・観測・突合結果からの決定論的な投影
(`libs/core/decision-ledger/projection.ts` → presence-studio `hearing-ledger-canvas.ts`)。デザインは `resolveCreativeDesign` のトークンのみ。
