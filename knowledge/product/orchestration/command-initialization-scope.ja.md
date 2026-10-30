---
title: コマンド初期化とスコープ・資格情報の契約
tags: [orchestration, scope, credentials, bootstrap, operations]
last_updated: 2026-10-30
---

# コマンド初期化とスコープ・資格情報の契約

コマンドは引数を解析・検証してから、必要な capability だけを初期化する。
help は provider、STT、資格情報を初期化しない。モデルを使わない保守 pipeline
（storage-janitor など）は reasoning の初期化を必要としない。
未知の op や、条件分岐・fallback に含まれる reasoning は保守扱いで省略しない。
mission create / start / kickoff は合意済み intent を記録・有効化する処理であり、
provider を起動しない。handoff の user_prompt provenance は保ち、
モデルによる再解釈の可否だけを別の extraction 方針で指定する。

## スコープと資格情報は別の寿命を持つ

scope.env は利用する tenant / project 等のコンテキストを保存する。
TaskCredentialBinding は認証済み dispatch が claim した WorkItem に対して作る
プロセス内の権限であり、scope use、承認、API キー環境変数では代替できない。
別の CLI プロセスへ binding が引き継がれるとは考えない。

| 状態                                                                   | 判定と動作                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| tenant なし、binding なし                                              | operator。既存の operator 認可を通して資格情報を解決する                                    |
| 正しい tenant、binding なし                                            | binding_required。任意の discovery は利用不可として返せるが、実行は正規 dispatch を要求する |
| 実行 tenant / mission / task と一致する binding                        | bound。binding 内の資格情報だけを使い、operator へ fallback しない                          |
| 不正な tenant、異なる envelope / resource / binding、別 scope の cache | scope / owner denied。文脈を修復するまで実行しない                                          |

共通の credentialBindingReadiness() は資格情報の値を返さず、この前提を検査する。
optional provider discovery で欠落扱いにできるのは
CREDENTIAL_BINDING_REQUIRED だけである。SCOPE_DENIED、OWNER_DENIED、
その他の失敗を「キー未設定」に置き換えない。
resolveServiceSecret と Gemini の実際の embed は引き続き厳密に認可する。

## 保存済みスコープの解除

空の KYBERION_TENANT は「環境からの指定なし」であり、保存済み tenant を
解除する指示ではない。現在の設定元は pnpm scope show --json で確認する。
永続設定を解除する意図がある時だけ pnpm scope clear を実行する。
一時的な切替には scope push / use / pop と、既存の
KYBERION_SCOPE_ENV_PATH を使う。移送された文脈は withScopeEnvOnly や明示的な
実行 scope clearing で扱い、資格情報を通すために tenant を自動解除しない。

## 初期化順序と再利用

secret-aware な mode 選択より前に secret resolver をインストールする。
bootstrap の cache は作成時の資格情報 identity に属する。
別 identity で既存 cache を再利用せず、正しい binding を確立した上で明示的に
refresh する。binding 不足で拒否した refresh は既存 chain を破棄しない。
同じ identity の再初期化は既存の idempotent な契約を保つ。
保存 scope の write / clear はプロセス scope cache を無効化する。
移送された withScopeEnvOnly の文脈は通常のプロセス cache を読まず、書き換えない。

hash embedding は、任意の embedding capability に資格情報がない場合の
既存 fallback として許容する。scope の矛盾を隠す手段にはしない。
検索・保存は既存の backend / model / dimensions の整合性契約に従う。

## 委任ホストと実行タスク

dispatch-workitems / dispatch-tickets のホストは、claim 前に資格情報 binding を
持つ必要はない。prepareReasoningExecutionHost は resolver / factory の準備だけを
行う。WorkItem の claim と bindTask が成功した後の callback 内で、
タスクごとの backend を構築する。並行タスク間で global backend を
install / reset / reselect して上書きしない。binding 不足は実行境界で拒否する。

## 常駐プロセスの回復

daemon の liveness と reasoning readiness は別である。heartbeat の
details.reasoning_backend は ready / unavailable / binding_required /
scope_denied を報告する。binding 不足や矛盾が続く間は readiness だけを
再検査し、同じ条件で provider を何度も起動しない。診断は状態遷移時に記録する。
readiness が回復すれば次の refresh で再開する。前提検査を通った後の
provider 障害は同じ identity のまま設定が直る場合があるため、周期的な回復確認を
続ける。人間の承認と資格情報 binding を混同しない。

検証: credential-binding / provider-registry / Gemini / service-secret-resolver、
reasoning-bootstrap、pipeline-bootstrap-needs、voice_cli_bootstrap、
supervisor-reasoning-readiness、error-classifier の各テスト。

## テストfixtureの資格情報境界

tenant scopeで推論処理を呼ぶE2Eテストは、stubを注入していてもbindingを明示する。
外部通信を行わないfixtureでは、テスト用tenantに一致する空の資格情報bindingで
実行を囲む。テストを通すために本番bootstrapのbinding検査を緩めない。
会議follow-upとreminder sweepの回帰検証はmeeting-to-value-e2e.test.tsで行う。
