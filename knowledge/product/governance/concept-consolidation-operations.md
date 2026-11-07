---
title: '共通概念の採用と安全な更新'
tags: [governance, development, actor-context, state, rate-limit, cli]
last_updated: 2026-11-06
kind: runbook
scope: repository
authority: reference
phase: [execution, review]
---

# 共通概念の採用と安全な更新

概念の統合では件数より契約を優先する。機構を共有しても、認証と帰属、固定窓と token bucket、JSON と JSONL、schema 固有の操作 union を同じものにはしない。

## 実行主体

`withActorContext` は canonical actor と検証済み scope を dispatch 内に伝える。`currentActor` が返す authority は既存の resolver から参照のたびに取得する。入力による role/sudo 指定、legacy 名からの人間認定、context の存在による承認省略をしてはならない。認可は引き続き既存の principal・scope・authority・approval 境界で行う。

## JSON 状態と更新

`defineCatalog` の fallback もファイルと同じ schema で検証してから通知・cache・返却する。
schema を満たさない fallback は cache せず失敗する。安全な disabled default は schema の
範囲内で定義し、必須の probe/security policy が無い場合は空の偽ポリシーで代用しない。
symlink・非 regular file・repository 境界の拒否は fallback の対象にしない。

新しい JSON 状態は `openJsonState` に schema と default、repository 内の path または登録済み logicalPath を渡す。`update` の read・同期 mutator・検証・atomic write は同じ正準 lock の内側で行われる。Promise を返す mutator と同じファイルの再入更新は拒否される。既存ファイルの破損は空状態への読み替えで上書きしない。JSONL は append ledger のまま扱う。

inbox と provider pins の更新では mutex identity が変わる。**旧 writer を停止 → 更新 → 新 writer を再起動**の順とし、新旧プロセスを同時に動かさない。ファイル形式の変換や利用額の初期化は不要。旧 mutex を残すだけでは正準 lock と相互排他にならない。

JSON state の lock と再入検出は Unicode 正規化と case folding を共有する。大文字小文字や合成文字だけが違うパスも同じ lock とし、同じ処理内の入れ子更新を拒否する。case-sensitive な filesystem でも保守的に共有するが、実際の I/O パスは変更しない。

`runtimeStatePath` はキーごとの既存の論理・物理配置を返す。confidential は有効な tenant が必要で、予約済み partition 名を tenant に指定できない。global な Dot 状態を推測で tenant に分割しない。

## 制限と失敗追跡

固定窓には `fixedWindowLimiter` を使う。未検証 token など攻撃者が新規キーを作れる場所では、満杯時に既存の live bucket を捨てず、新規キーを拒否する。既存 OIDC の LRU eviction と Express の HTTP adapter は明示した既存契約を保持する。閾値は `runtime-control-policy.json`、policy engine の閾値・窓は従来の governance rule に置く。policy engine の constructor で catalog I/O を行うと secure-io の初期化循環になるため禁止する。

失敗追跡では `createFailureTracker` に reset の意味と成功時リセットを指定する。機構は count と decision を返し、throw/open/demote/disable の実行は呼出側の既存ライフサイクルが担当する。重み付き token bucket の連続 refill と burst を固定窓に置き換えない。

共通 barrel や limiter adapter の import 時にも catalog I/O を行わず、操作の初回利用時に読み込む。利用時の欠落・不正な policy はエラーとして伝え、既定値で隠さない。依存のない limiter 機構は foundation に置く。

## CLI とチェック

`defineCommand` は既存の CLI guard と `defineScript` を合成する。help と unknown option の処理は副作用より前に行う。`defineCheck` は findings があれば常に exit 1、JSON は `{ok,id,findings}`、成功は `[check:<id>] OK` を返す。新しい check は `ci-gates.json` に実行条件も登録する。CLI の既存契約を変更する移行は checker ごとに検証する。

## 資産 Scope と保存配置

保存先の登録は既存 `store-catalog.json` の `registration` に family（state/ledger/floor）、
既存の export key、`retention_path` を宣言する。CI は全 runtime root の登録、重複・未知の key、
partition 形状、現在の最も具体的な保持規則への参照を突合する。保持 action/TTL と custody は
変更しない。state/floor は `<tier>/<tenant>` を必須とし、bare root は既存の2つの metrics
ledger と `unscoped-legacy` の組み合わせだけを互換例外とする。これは実行時の認可情報ではない。
現段階では既存 TypeScript root 定義との整合検査であり、root の生成・移行を完了したものではない。

資産の管理者（system / tenant / person）と tier は実行主体の `ScopeEnvelope`、Stance、
ファイルの保存場所から分けて扱う。`resolveAssetAddress` は注入された検証済みカタログから
解決し、混在する legacy 配置や管理者・tier が不明な資産は `unresolved` にする。
現在の tenant や移行先の属性で不足情報を補わない。保存先の移行はこの解決処理の前提にしない。

`inspectAssetScopeRead` の `decision` だけが既存の認可結果であり、`shadow` は管理者と
tier の閲覧上限の観測である。`shadow` の許可・拒否・例外で既存認可を置き換えない。
比較対象の ceiling はサーバーで解決し、クライアントの tenant/tier をそのまま渡さない。
計画中の保存先は観測対象にできるが許可には使わない。Grant と完全な認可への移行は
保存先ごとの契約テストと独立レビューを経て別段階で進める。

同期保存処理の token 寿命は `createSynchronousResourceGrantIssuer` に寄せる。issuer の
インスタンスは既存の統制された発行 facade 内に保持し、文字列の store 名や診断用 prefix
で発行者を認定しない。ドメインの binding を検証・凍結してから発行し、共通機構には
path 上限と token の寿命だけを任せる。DOT 結果保存はこの機構を採用している。
現在の凍結済み scope と一致しない複製、別 issuer の token、処理終了後の token は拒否する。
外側の ResourceAccessScope の上限は交差したまま維持する。

Promise/thenable を返す保存処理は拒否し、正常終了・例外とも `finally` で失効する。
戻り値の Symbol を含む data property・Map・Set を検査して token や scope の持ち出しを拒否する。
持ち出し検査では accessor を実行せず、Map/Set は組み込み iterator で調べる。
closure/accessor が token を保持しても、戻り値が呼出元へ渡る前に
失効する。これは権限の付与・保存先の正規化・内容検査の代替ではない。

操作と対象パスの上限は純粋関数 `decideResourceAccess(scope, target, operation)` を使う。
`read/write/append/mkdir/metadata` 以外の実行時の値は、name prefix や metadata の照合より
先に拒否する。空の対象パスは metadata の祖先探索にのみ使える。`resourceAccessDenial` は
すべての外側 scope にこの判定を適用し、scope が無い場合は従来どおり制約なしの `null` を返す。
DOT guard は private issuer と root を検証した後、発行済みの scope の操作判定を共有する。
関数単体の許可を発行証拠や最終認可として使わない。ロール・tenant・内容の検査は引き続き必要。

## 再増加の検出

`check_concept_consolidation.ts` は context env、JSON serialization at write、runtime literal、limiter/tracker 宣言、重複 export 型名、CLI parser の6指標を測る。comments・テスト・生成コード・build 出力を除外し、ファイル単位の上限と重複型名ごとのサイトを検査する。payload と永続状態の全てを静的に証明するものではなく、指標とレビューを併用する。新しい duplicate 名は古い duplicate を削って相殺できない。

今回の変更後の上限へ下げ、増加を通すための再 baseline はしない。全移行の到達状況は [実装計画](../../../docs/developer/improvement-plans-2026-10/CONCEPT_CONSOLIDATION_PLAN_2026-10-21.ja.md#10-実装レビューと今回の到達範囲2026-10-21) に記録する。
