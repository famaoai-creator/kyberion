# tests_ai/ — AI 監査テスト層(KC-05)

lint や型では書けない**意味的不変条件**を、markdown 1 ファイル = 1 不変条件として置く層。
[KIMI_CLI_ADOPTION_PLAN §KC-05](../docs/developer/improvement-plans-2026-07/KIMI_CLI_ADOPTION_PLAN_2026-07-20.ja.md) の実装(kimi-cli `tests_ai/` 方式の Kyberion 版)。

## 実行方法

```bash
pnpm ai-test                                   # 明示実行(要 非 stub reasoning backend)
pnpm pipeline --input pipelines/ai-audit.json  # pipeline 経由(週次 schedule あり)
```

- 各不変条件を reasoning backend(`delegateStructured`)へ fan-out して監査し、
  `active/shared/tmp/ai-audit/report.json` に `{file, name, cases:[{name, pass, reason?}]}` を集約する。
- 1 件でも `pass: false` があれば exit 1。
- reasoning backend が stub の場合は `skipped` として exit 2（監査未実行を成功扱いしない）。
- **stub backend では skip**(`skipped: non-stub backend required`)— 偽の合格は返さない。
- `tests_ai/fixtures/` の意図的な違反 fixture は通常の `pnpm ai-test` から除外する。監査層自身の fail 経路は hermetic test で `includeSelfTestFixtures: true` として検証する。
- Trace は `active/shared/tmp/ai-audit/traces/` に JSONL で残る(report に trace_id / trace_path が入る)。

## 不変条件ファイルの書式

```markdown
# Invariant: <不変条件の名前>

## Scope

- `libs/core/xxx.ts` ← 監査対象ファイル(repo 相対パス、backtick 必須)
- `tests_ai/fixtures/*.ts` ← 同一ディレクトリ内の basename glob も可

## Requirements

- 満たすべき要件を自然言語で列挙する(監査 subagent がこの文面で判定する)

## Examples

- OK / NG の具体例(任意だが判定精度が上がる)
```

- ファイル名は kebab-case の `*.md`。`README*` は列挙対象外。
- Scope のファイルが存在しない場合は決定的に fail として報告される(LLM 不要)。

## fixtures/

`fixtures/` は監査層自体の自己検証用。**わざと違反を仕込んだ**ファイルを置き、
対応する不変条件(`fixture-error-message-guidance.md`)が確実に fail を報告することを保証する。
fixtures の違反を「修正」しないこと — fail することが仕様である。
hermetic な単体テストは `scripts/run_ai_audit.test.ts`(注入した判定関数で fail 経路を検証)。
