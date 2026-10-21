---
title: '共通概念の採用と安全な更新'
tags: [governance, development, actor-context, state, rate-limit, cli]
last_updated: 2026-10-21
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

新しい JSON 状態は `openJsonState` に schema と default、repository 内の path または登録済み logicalPath を渡す。`update` の read・同期 mutator・検証・atomic write は同じ正準 lock の内側で行われる。Promise を返す mutator と同じファイルの再入更新は拒否される。既存ファイルの破損は空状態への読み替えで上書きしない。JSONL は append ledger のまま扱う。

inbox と provider pins の更新では mutex identity が変わる。**旧 writer を停止 → 更新 → 新 writer を再起動**の順とし、新旧プロセスを同時に動かさない。ファイル形式の変換や利用額の初期化は不要。旧 mutex を残すだけでは正準 lock と相互排他にならない。

`runtimeStatePath` はキーごとの既存の論理・物理配置を返す。confidential は有効な tenant が必要で、予約済み partition 名を tenant に指定できない。global な Dot 状態を推測で tenant に分割しない。

## 制限と失敗追跡

固定窓には `fixedWindowLimiter` を使う。未検証 token など攻撃者が新規キーを作れる場所では、満杯時に既存の live bucket を捨てず、新規キーを拒否する。既存 OIDC の LRU eviction と Express の HTTP adapter は明示した既存契約を保持する。閾値は `runtime-control-policy.json`、policy engine の閾値・窓は従来の governance rule に置く。policy engine の constructor で catalog I/O を行うと secure-io の初期化循環になるため禁止する。

失敗追跡では `createFailureTracker` に reset の意味と成功時リセットを指定する。機構は count と decision を返し、throw/open/demote/disable の実行は呼出側の既存ライフサイクルが担当する。重み付き token bucket の連続 refill と burst を固定窓に置き換えない。

## CLI とチェック

`defineCommand` は既存の CLI guard と `defineScript` を合成する。help と unknown option の処理は副作用より前に行う。`defineCheck` は findings があれば常に exit 1、JSON は `{ok,id,findings}`、成功は `[check:<id>] OK` を返す。新しい check は `ci-gates.json` に実行条件も登録する。CLI の既存契約を変更する移行は checker ごとに検証する。

## 再増加の検出

`check_concept_consolidation.ts` は context env、JSON serialization at write、runtime literal、limiter/tracker 宣言、重複 export 型名、CLI parser の6指標を測る。comments・テスト・生成コード・build 出力を除外し、ファイル単位の上限と重複型名ごとのサイトを検査する。payload と永続状態の全てを静的に証明するものではなく、指標とレビューを併用する。新しい duplicate 名は古い duplicate を削って相殺できない。

今回の変更後の上限へ下げ、増加を通すための再 baseline はしない。全移行の到達状況は [実装計画](../../../docs/developer/improvement-plans-2026-10/CONCEPT_CONSOLIDATION_PLAN_2026-10-21.ja.md#10-実装レビューと今回の到達範囲2026-10-21) に記録する。
