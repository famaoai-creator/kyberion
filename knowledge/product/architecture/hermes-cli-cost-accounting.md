---
title: Hermes CLI cost accounting findings and Kyberion adoption
tags: [hermes-agent, cli, cost, accounting, reasoning-backend]
last_updated: 2026-10-28
runtime_stages: [execution, review]
---

# Hermes CLI cost accounting

## 調査対象

NousResearch/hermes-agent を実際に shallow clone し、コミット
`e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6` のソースを確認した。
上流コードの実行、認証情報の読み出し、有料 API の呼び出しは行っていない。

Hermes は「CLI を実行すれば何でも料金が分かる」方式ではない。
Codex app-server の構造化された利用量を取り込む専用経路と、料金情報を解決する共通層がある。
任意の terminal command の出力を料金情報として解釈する仕組みとは区別する必要がある。

- [agent/codex_runtime.py](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/codex_runtime.py#L149): `token_usage_last` を取得する。input は cache を含むため、cached input を差し引いてから canonical な cache bucket に分離し、二重計上を避ける。利用量がない呼び出しも呼び出し回数として残す。
- [agent/usage_pricing.py](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/usage_pricing.py#L686): provider が返す費用を優先し、契約内の経路は `included`、単価がない場合は `unknown`、単価からの算出は `estimated` とする。未知の cache 単価も黙ってゼロにしない。
- [tools/delegate_tool_child_run.py](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/tools/delegate_tool_child_run.py#L598): 子エージェントの費用と状態を親へ返す。親子集計と請求対象の一次記録を混同しない設計が必要になる。
- [Claude Code skill](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/skills/autonomous-ai-agents/claude-code/SKILL.md#L153): JSON の `usage` と `total_cost_usd` を使う手順を説明している。手順の記載と Hermes 共通台帳への自動取り込みは別の機能である。

## Kyberion への適用契約

既存の CLI adapter、usage ledger、費用レポートを拡張し、別の料金台帳は作らない。
Codex、Claude、Gemini の構造化された transport envelope から利用量を取得し、モデルが生成した本文は計測根拠として扱わない。
実測利用量が取得できない成功応答の文字数推定は、推定であることを明示する。
起動失敗を入力文字数だけで課金済みと見なさない。

費用の状態 `actual / estimated / included / unknown`、課金方式、利用量の取得元、費用の取得元を区別する。
これは resource の actual/committed といったライフサイクルとは別の軸である。
CLI の名前だけで定額契約を推定しない。
Claude の `total_cost_usd` も課金方式が不明なら API 相当の参考額として保持し、追加請求の確定額とは表示しない。
固定のサブスクリプション料金は呼び出しごとの追加費用に含めない。

費用不明の呼び出しを集計から落とさず、既知の小計と集計の完全性を表示する。
参考額は追加費用と合算しない。費用が不明なまま予算残額を確認済みと扱わない。
accounting ID、actor、tenant scope の既存の帰属と重複排除を維持する。

CLI adapter は既定では課金方式を `unknown` とする。契約内と分かる信頼済みの入力がある場合のみ `included` にでき、ログイン状態や実行ファイル名からは判断しない。
Gemini などのモデル別累計はモデルごとに記録するため、レポートの記録件数は provider の実 HTTP リクエスト数とは限らない。
Codex の対象は新規 `exec` の一つの prompt に対する最終 turn の計測であり、再開済みセッションの累計差分の実装は含まない。
既存の execution ledger に対する spend guard と resource settlement の境界は維持する。両方の台帳を無条件に合算すると二重課金になり得るため、task 帰属だけの resource 記録を新たな請求額として加算しない。

## 検証

ミッション `MSN-CLI-COST-20261028` に調査・設計・実装・検証の証跡を記録する。
重点検証は cache の重複排除、最終累計と途中応答の重複排除、偽の本文 JSON、異常値、未計測、契約内、明示的なゼロ、未知の単価、tenant 境界、予算上限制御を対象とする。
実課金との照合には provider の請求情報が別途必要であり、オフラインの回帰テストだけでは請求額一致を保証しない。
