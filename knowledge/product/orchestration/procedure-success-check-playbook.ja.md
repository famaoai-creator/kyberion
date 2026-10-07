---
title: 手順の成功チェック プレイブック（golden シナリオ）
category: Orchestration
tags: [orchestration, procedure, golden-scenario, verification, browser, service, knowledge_steward]
importance: 6
last_updated: 2026-10-07
kind: playbook
scope: global
---

# 手順の成功チェック プレイブック

> 英語版 [procedure-success-check-playbook.md](./procedure-success-check-playbook.md) が正本です。本書は運用者向けの補助訳です。

記録した手順（ブラウザ / サービス）が `executed` を返しても、それは**動いた**だけで、**うまくいった**とは限りません。各手順は、昇格時に記録された成功条件である **golden シナリオ**を持っています。実行のたびに、その実行で得られた証拠を golden シナリオと照合し、判定を手順の録画に対するナレッジ検証台帳に記録します。

## 1. 自動で行われること

| タイミング                                                   | 内容                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 昇格（`promote_procedure`、サービス/ブラウザの昇格）         | golden シナリオを `<カタログのディレクトリ>/golden/<procedure_id>.v<version>.json` に保存し、カタログ項目（`golden_scenario_ref`）から紐付けます。          |
| 実行 — `service:preset`                                      | 期待する応答値が空でなく実際に返ってきたかを確認します（ステップが終わっても応答が空なら失敗）。                                                            |
| 実行 — Playwright                                            | 最後に読み取り専用のページスナップショットを取り、それだけを照合します。                                                                                    |
| 実行 — Chrome 拡張                                           | 実行完了後、拡張機能は条件に合うページ要素だけを送り、ネイティブホストが判定します（`submit_golden_evidence`）。判定は 1 実行につき 1 回です。              |
| 毎週日曜 03:00（`pipelines/knowledge-curation-weekly.json`） | 手順チェックレポートを `knowledge/personal/governance/PROCEDURE_CHECK_REPORT.md` に書き出します（個人ティア。公開の `CURATION_REPORT.md` には書きません）。 |

## 2. 判定の読み方

| 判定           | 意味                                                                                   | 記録                                                                                    |
| -------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pass`         | 強い条件（名前付きの値や表示テキスト）を満たし、満たせなかった条件がない               | 成功した実行（`evidence: golden`）。ワーカーには「成功チェックに合格」と表示            |
| `fail`         | 満たせなかった条件がある                                                               | 問題 `failed_check`（満たせなかった条件つき）。ワーカーには「成功チェックに失敗」と表示 |
| `inconclusive` | 判定できない：未対応の条件（スクリーンショット比較など）、証拠がない、弱い条件しかない | 記録しない（誤って合格にするよりは判定しない）                                          |

弱い条件だけでは合格になりません。弱い条件とは、テキストのない「ボタンが見えた」、サービスの最後のステップが終わっただけ、コンパイラの代替条件「最後に操作した要素がまだ見えている」（`params.anchor: last_action_target`）などです。

## 3. コマンド

```bash
pnpm kyberion procedure golden status               # 全手順を失敗から順に、やることつきで表示
pnpm kyberion procedure golden status --json
pnpm kyberion procedure golden backfill --dry-run   # golden シナリオ導入前に昇格した手順を確認
pnpm kyberion procedure golden backfill             # 作成して紐付け
pnpm kyberion procedure golden backfill --catalog knowledge/personal/procedures.json
```

`backfill` は手順自身の承認済み録画から golden シナリオを作り直します。カタログ項目は `golden_scenario_ref` を足す以外は変更しません。

## 4. 状態ごとの対応

| 状態                     | 対応                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no_golden_scenario`     | `backfill` を実行（まず `--dry-run`）。                                                                                                                                        |
| `weak_only`              | どの実行でも合格になりません。成功が画面に表示されるのを待つステップ（`wait_for_ref` で完了メッセージを待つ、`extract_text_ref` で結果を取る）を含めて録り直し、再昇格します。 |
| `failed_check`           | 実行はしたが成功状態に届いていません。サイト/サービス側の変更を確認し、修正（自己修復デルタ）するか録り直します。                                                              |
| `reported_problem`       | 人が誤り/古いと報告しました。修正するか置き換えます。                                                                                                                          |
| `changed_since_verified` | 最後に合格した後で録画が変わりました。一度実行して新しい版を確認します。                                                                                                       |
| `never_passed`           | 使える golden シナリオはあるが、まだ合格した実行がありません。一度実行します。                                                                                                 |

## 5. チェックできる手順の録り方

- 最後のクリックではなく**結果**で録画を終える：確認表示を待つ（ステータスメッセージに `wait_for_ref`）か、成功を示す値を取り出す。
- 汎用のボタンより、成功時にしか出ない文言（「申請を承認しました」、チケット番号など）を目印にする。
- サービスの録画では、大事な値を返すステップに出力チャネル名を付ける。そのチャネルが成功条件になります。

## 6. トラブルシューティング

- **週次ログに手順チェックレポートをスキップしたと出る**：個人ティアに書けるのは運用者のペルソナ（`personal` / `sovereign`）だけです。週次パイプラインを運用者として実行するか、自分の端末で `status` を使ってください。
- **手順があるのに `status` に何も出ない**：個人カタログを読めるのは、個人ティアを読めるペルソナのときだけです。
- **拡張機能の実行で「判定に失敗」と出る**：ページから証拠が返りませんでした（別ページに遷移した等）。何も記録されません。安定したページでもう一度実行してください。
- **いつも `inconclusive` になる**：golden シナリオに未対応か弱い条件しかありません。上の `weak_only` を参照。

関連：[knowledge_steward PROCEDURE §E](../roles/knowledge_steward/PROCEDURE.md)（台帳のルール）、[browser-automation-best-practices](./browser-automation-best-practices.md)。
