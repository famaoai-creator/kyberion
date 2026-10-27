---
title: Hermes runtime reliability adoption into Kyberion
tags: [hermes-agent, routing, autonomous-loop, delegation, compaction]
last_updated: 2026-10-28
status: implemented
runtime_stages: [planning, execution, review]
---

# Hermes 実行制御の取り込み

対象は Hermes Agent の固定コミット `e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6`。
調査用 clone の静的なコード比較に基づく。ミッションは `MSN-HERMES-RUNTIME-20261028`。
新しいタスク台帳や所有権ストアを作らず、Kyberion の既存の経路・実行制御・成果物の境界を拡張する。

## 受け入れ条件

1. **モデル単位の待機と利用不可判定** — 明確なモデル利用資格の拒否とモデル単位の rate limit は、同一 provider の正常な別モデルを停止させない。provider 全体の認証障害と区別する。待機期限に provider の Retry-After を反映する。
2. **補助処理専用のモデル経路** — コンテキスト圧縮とバックグラウンドレビューを既存の名前付き route に接続する。個別モデル・timeout・候補順の設定に既存 policy を用い、egress と tenant 権限を維持する。
3. **結果込みの循環検出** — 引数だけでなく結果の変化を見て、変化のない複数操作の反復を検出する。有限の履歴を用い、正当なポーリングや進捗を誤って停止させない。
4. **圧縮処理の停止と回復** — 圧縮固有の期限と世代確認を設け、取消済み・古い要約が後から現在の状態を書き換えない。停止時の引き継ぎは決定的に生成し、不完全であることを明示する。固定コンテキストと既存の構造化 carryover は保持する。
5. **子の結果を親の空き容量へ収める** — 最新の prompt 使用量と出力予約から要約の上限を決める。全文は既存の scoped artifact に保存する。構造化された実行結果を切り詰めて無効な JSON にしない。累計 session token を現在の占有量として扱わない。
6. **進捗による連続実行の監督** — 継続モードは暗黙の総実行時間・ターン数上限に依存せず、意味のある進捗、各ステップの実行許可、予算、取消で管理する。単なる stdout の増加を進捗にしない。明示した上限は有効とし、取消と終端状態の後に届く結果が実行を成功へ戻さない。

## 既存機構を維持する境界

- Model registry、route policy、agent profile、provider の permission profile は異なる責務である。補助 route は新しい権限を与えない。
- 循環検出は実行結果から導く停止判断であり、自然言語だけでゴールの達成を認定しない。
- 圧縮失敗からの回復はメモリ表現の縮退である。外部作用の巻き戻しや再実行を許可しない。
- 子の結果の表示上限と、完全な成果物の保持は別の責務である。成果物の tier と tenant scope を変えない。
- 継続実行と一回の操作の期限を分ける。短い API 呼び出しや圧縮には有限の待機期限を設けられる。継続モードでも明示された予算・期限・取消を進捗で解除しない。進捗と heartbeat、取消要求と取消完了を区別する。
- 複数モデルによる MoA 助言、追加の自動レビュー呼び出し、資格情報の変更は今回の対象外。

## 連続実行に関する追加意図

実装中にユーザーから、より良い方式なら既存制約を外してよく、連続実行に固定時間上限は適さない場合がある、との指示を受けた。
これに基づき「既存の hard deadline をすべて必須のまま残す」という初期前提を変更する。
従来の有限実行と、監督された継続実行を区別し、継続モードを既存の実行経路へ接続する。
進捗を提供できない処理を、監督されているかのように扱って無期限実行へ切り替えない。

## 利用と運用

名前付き補助ルートを確認する。変更には既存の `reasoning:config` の profile 選択と role binding を用いる。
設定を追加しなければ、補助ルートは現在の default backend と固定 binding を継承する。

```sh
pnpm reasoning:config explain --role context_compaction --json
pnpm reasoning:config explain --role background_review --json
```

ゴールのドライバーの `executionMode: 'continuous'` は、毎ターン更新する `preStep` admission がある場合に暗黙の100ターン上限を外す。
mission の goal-driven WorkItem 経路は admission hook がある場合にこのモードを選ぶ。
明示した `maxTurns` と goal budget は優先する。取消は `signal` で伝達し、待機中のモデル・ツール・探索・手動実行許可から抜ける。
実行中ツールの結果が不明なまま取り消された場合は、結果を要照合とし、外部作用を巻き戻せるとは見なさない。

委譲は `delegation_execution: 'bounded' | 'continuous'` を区別する。
semantic progress を提供する native harness の continuable handle は、明示的な bounded 指定がなければ continuous を選択する。
この経路では暗黙の10分上限を外し、既定5分の inactivity window を意味のある進捗で更新する。window は `delegation_inactivity` で調整できる。
非対応の provider は従来の有限実行を維持し、明示的な continuous 要求には未対応と返す。
プロセスの生存通知や単なる stdout の増加だけでは inactivity window を更新しない。

子の結果は既定24,000 UTF-8 bytes以下の表示予算を持ち、親の最新 prompt の占有量が分かる場合はさらに絞る。
自動推定は trusted attribution ごとの直近 prompt と tool 定義の byte 数を保守的に用い、正確な `parentContext` を指定することもできる。
attribution がない場合は他の実行の占有量を流用せず固定上限を用いる。JSON と `task_result` は検証前の内容も含め元のまま返す。
全文の scoped artifact を安全に作成できない場合は、切り捨てて成功させず明示的なエラーにする。

圧縮の単発要約は既定で総待機60秒、進捗停止30秒を上限とし、進捗は停止時間だけを更新する。
2回の停滞後は元履歴の scoped archive を作成してから、`INCOMPLETE` を明示した決定的な引き継ぎへ縮退する。
archive を作成できなければ履歴を保持する。一般的な要約エラーは従来の3回失敗による `needs_attention` と区別する。

## 上流の根拠

- [モデル別 cooldown](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/credential_pool_model_cooldowns.py)
- [fallback の待機期限](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/fallback_cooldown.py)
- [補助処理の設定](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/auxiliary_task_config.py)
- [結果を含むツール反復検出](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/tool_guardrails.py)
- [コンテキスト圧縮](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/conversation_compression.py)
- [子の結果予算](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/tools/delegate_tool_results.py)
- [子の進捗停止監視](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/tools/delegate_tool_child_run.py)
