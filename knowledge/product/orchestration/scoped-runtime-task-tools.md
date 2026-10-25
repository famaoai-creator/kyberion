---
title: 'Scoped runtime task tools and autonomous continuation'
tags: [orchestration, runtime, tools, scope, mission, operations]
last_updated: 2026-10-26
runtime_stages: [preflight, execution, review]
---

# Scope とツールを保った自律実行

CLI からの直接作業、常駐 runtime、API モデルは同じ仕事契約を使う。
モデルのツール対応と、その実行先に必要なツールを渡せることは別に確認する。

## 実行契約

WorkItem の現在の claim holder、lease、task、mission、tenant、tier と
サーバ側で解決した role/profile を開始前に照合し、各ツール実行前にも再検査する。
別の仕事・lease に結び付いた runtime は再利用しない。処理中なら差し替えを拒否する。
payload、モデルの文章、assignee の表示名だけでは権限を増やさない。

CLI 型モデルは native 機能を確実に無効化できる adapter、API 型モデルは
function calling と同じ実行器を使う。未対応の host は開始前に理由を返す。
未知の CLI 版を推測で許可しない。既存の MCP 設定・hooks が native ツールを
再導入しないことも検証する。

task の入出力は、その task が宣言した成果物へ結び付ける。ツール結果は次の
モデルターンへ返し、成果物の書き込み・read-back・証跡の確認後に完了する。
自然文の「完了」や、成果物のない完了 signal は成功にしない。
reviewer は元の実装成果物を書き換えず、独立レビュー結果を返す。

ソース編集は正規 NEXT_TASKS の `source_edit_paths`（exact path）と必要に応じた
`source_edit_requires_approval`、pipeline は `allowed_pipelines` で owner が宣言する。
通常の進捗保存でもこれらの契約を保持する。書き込み後の成果物変更は証跡を無効化する。
ソースのみのタスクも実体の hash を controller 内で検証し、出力のない pipeline は
宣言した evidence artifact を生成する。空の proof で完了しない。

## 承認と再開

承認が必要な操作は既存の承認ストアに保存し、WorkItem に承認IDを残す。
pending はモデルの能力不足ではないので、model tier を上げたり別経路へ
fallback したりしない。人間の判断後に同じ契約を再開し、実行時に承認を消費する。
承認は scope や操作範囲を拡大する仕組みではない。

pipeline の承認は runtime prompt 承認と保存 channel が異なるため、kind と channel を
dispatch まで保持する。task-owned pipeline は承認ストアから別の detached process で
再開せず、元の run ID を新しい claim の下で再開する。ソースの hash が変わった場合や
開始結果が不確実な場合は自動再実行しない。

mission の verify、distill、finish と独立レビュー記録は owner の facade を使う。
MCP の引数に mission ID や operator を書くだけでは owner にならない。
サーバ側の mission_controller／mission binding を要求し、承認を対象状態と
レビュー対象の内容に固定する。不確実な実行結果は再送せず、証跡を確認する。
controller 内の変更直前にも snapshot と、task 実行なら mission の active 状態・
claim・lease・成果物の hash を再確認する。親プロセスの事前確認だけでは完了させない。

## Dot の情報境界

チャネル通知・handoff・state は tier、tenant、組織、project と personal owner
を保つ。未指定のscopeをprivate通知からpublicに補完しない。全体通知は
明示されたpublic通知に限定する。sharedの制御indexには件数・ID・状態のみを置き、
private本文はscoped保存先から権限付きで読む。

旧保存先の履歴tierが不明な場合は自動移動しない。履歴・Charterの所有者を確認し、
`pnpm kyberion dot migrate-state <dot-id> --legacy-tier <verified-tier> --apply`
で検証付き移行を行う。移行先の競合やリンクは拒否する。CLI の全体inventoryと
利用者scopeの一覧を区別し、tier／tenant／ownerを表示する。

## 停止原因の切り分け

| 観測                                     | 処置                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| provider 認証・workspace trust がない    | 正規の login／trust 手順をoperatorが行う。credentialやtrustを自動で書き換えない  |
| 別provider用のモデル名が渡る             | provider共通fallbackではforeign model IDを外し、該当providerにだけnative名を渡す |
| task tool profile／lease／scope が不一致 | claimと割当を再確認し、権限を緩めず仕事契約を修復する                            |
| compiler出力の更新中                     | sweepをdeferし、triggerを消費しない。ビルド完了後に再開する                      |
| 常駐processのコードが古い                | 稼働中の仕事を確認し、管理されたdaemon再起動で新しいbuildを読み込む              |
| 成果物がない、証跡登録に失敗             | own taskの診断artifactを確認する。textだけの成功に置き換えない                   |
| 承認待ち                                 | 同じ承認IDを提示して待機し、人間の判断後に再開する                               |

検証はfake backendだけのtool一覧確認で終えず、実際のNEXT_TASKS、成果物ファイル、
mission用Git、controllerのrecord-evidenceまで通す。CLI/APIの両経路でscope拒否、
lease失効、承認待ち・再開、モデルの虚偽完了を回帰テストに含める。

planner の固定provider選択で、CLI自体が必要なtool制約を投影できない場合は、
selection に `execution_route: agent_runtime` を明示する。登録された governed tool host があるproviderだけを候補にできる。
これは割当候補の判定であり、taskの権限付与ではない。起動時にも同じruntime経路、task binding、現在のleaseを検証する。
runtime専用として保存したroleをCLI経路へ切り替えることは拒否する。
