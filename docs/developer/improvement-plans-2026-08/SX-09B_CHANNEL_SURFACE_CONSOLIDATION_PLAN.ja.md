---
title: SX-09b channel surface consolidation follow-up
tags: [simplicity, channel-adapter, surface, 2026-08]
last_updated: 2026-09-06
status: partial
---

# SX-09b: channel and viewer consolidation follow-up

SX-09 の現状は4 bridgeの `ChannelAdapter`/`runChannelTurn` 移行まで完了している。
viewer/auth は認可集合の正本を **1 core materializer** に集約したが、request parsing と
surface 固有 gate は4 adapterに残る。vocabulary lookup は browser 側を **1 shared resolver**
へ集約し、Node 側は secure-io を含む別実行環境の resolver として維持している。
本計画では、provider固有の配送を保ったまま、履歴・権限・語彙の重複を整理する。

## 対象

1. Discord/Telegramの thread 履歴重複を解消する。
2. viewer/auth の認可集合判定を4 adapterから1 core materializerへ統合する。
3. channel vocabulary lookup を共通 browser resolver へ集約し、Node/browser の実行環境差だけを adapter に残す。
4. bridge に残る `as any` **31** 件を型付き境界へ置換する。
5. Slack thread context を共通 formatter へ揃える。
6. typing、approval、proposal の共通 delivery gate を本番相当テストで固定する。
7. 日英の channel リテラルを `t()` 経由へ移行する。
8. viewer scope と tenant scope の表示・認可責務を一本化する。

## 完了条件

- 4 bridgeが共通 thread formatter と delivery gate を利用し、履歴が二重投入されない。
- viewer/auth の認可正本と browser vocabulary の正本が各1実装で、全対象 surface がそれを利用する。
- `as any` の残件を0にし、provider固有型は adapter 境界に閉じ込める。
- tenant scope、approval、external delivery の回帰テストが green である。

## 非目標

provider APIの置換や配送仕様の変更は行わない。外部送信は既存の人手承認・明示的な
`shouldSend` gateを維持し、release前のloopback/XFF移行はSX-08bと協調して別検証する。

## 実装状況（2026-08-28）

- Slack bridge は `SlackClient`、Slack modal view 境界、`unknown` payload reader を導入し、
  bridge 内の `any` / `as any` を **0件**にした。Bolt の provider 型と core の provider-neutral
  modal shape の接続は adapter 境界1か所に限定している。Discord は discord.js の interaction /
  component builder、Telegram は API 応答の `unknown` 正規化、iMessage は catch 境界を同じ
  方針へ移し、4 bridge 合計の対象ファイルを **0件**にした。
- `automationRegistrationReply` の optional scheduled result と、空の Slack delivery response
  を明示的に扱い、型付けによって露出した失敗経路を fail-closed にした。
- 検証: `pnpm --filter @kyberion/slack-bridge run build`、
  `pnpm exec vitest run satellites/slack-bridge/src/index.test.ts
libs/core/automation-blueprint-slack.test.ts`（2 files / 5 tests）。
- 4 bridge の thread context は全て共通 formatter に接続し、current message を履歴へ二重投入
  しない境界を揃えた。Telegram/Discord は persisted fallback の回帰、Slack は API 応答の
  current event 除外、iMessage は共通 runtime が current message を付加するため provider 側
  context から除外する回帰を持つ。viewer scope の materialization は
  `libs/core/surface-mutation-guard.ts` の `resolveSurfaceViewerScope` に正本化し、Chronos /
  Concierge / Presence Studio / Computer Surface が共通の credential、registration、tenant、
  loopback、tier policy を利用する。request parsing、rate limit、remote-safe path、wire shape
  は framework/surface 固有の adapter に残している。provider API や外部送信 gate は変更して
  いない。

## 2026-08-30 実装レビュー追記

Concierge の全 API route を再監査し、viewer 解決と mutation guard は共通化されている一方で、
Chronos のような request-level rate limit がなく、token／IP からの過剰な GET／POST を抑制できない
残存を検出した。共通 `resolveConciergeViewer` の入口に token または trusted IP、HTTP method 別の
sliding-window limiter を追加し、`Retry-After` を返す 429 応答へ統一した。mutation guard が viewer
解決を先行して呼ぶ場合も WeakSet で同一 request を二重計上しない。proxy header は
`KYBERION_TRUST_PROXY` が有効な場合だけ利用し、既存の viewer／CSRF／tenant 境界は変更していない。

検証: Concierge api guard／viewer rate limit／関連 scope の **4 files / 8 tests passed**、
`pnpm run typecheck`、`git diff --check` が green。

同じ request 境界を再監査し、message の `text` と通知設定の `surface`／`target` が配列・オブジェクト
でも `String(...)` により暗黙変換される残存を検出した。会話入力は文字列以外を必須入力不足として
扱い、通知設定は文字列だけを受け付けるよう修正した。さらに voice-hub／orchestrator の reply も
文字列だけを成功応答として扱い、壊れた provider payload を `[object Object]` として表示しないよう
にした。既存の viewer、CSRF、rate limit、外部配送 gate は変更していない。

検証: message input **1 file / 3 tests passed**、`pnpm run typecheck`、`git diff --check` が green。
production-like approval test、
framework-specific request parsing の全 route 回帰、日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 3

`setup` POST を再監査し、tenant／agent の nested object、profile fields、onboarding draft の
`voice.sample_refs` が配列・オブジェクトでも `String(...)` によって暗黙変換され、書き込みへ到達し得る
残存を検出した。共通 strict parser を導入し、JSON body／nested object／string／boolean／string array
を型検証して、不正入力を 400 で返すようにした。全フィールドの検証を tenant／profile の書き込み前に
行い、multipart の action／profile_id／source も文字列境界を揃えた。route 内の `pathResolver` 参照は
正規の core import へ接続した。

検証: setup parser／route input **2 files / 23 tests passed**、`pnpm run typecheck`、`pnpm run lint`、
`git diff --check` が green。production-like approval test、全 route の framework-specific parsing、
日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 4

voice `listen-once` route を再監査し、JSON body が null の場合に property access が先行して 500 となり、
backend／device／locale の配列・オブジェクトも既定値へ落ちて voice-hub 呼び出しへ進み得る残存を検出した。
Concierge 共通 request-input helper を追加し、body／文字列 field を strict に検証して malformed input を
400 で返し、voice-hub へは送らない回帰を固定した。setup route もこの共通 object／string primitive を
再利用している。

検証: voice／setup input **3 files / 28 tests passed**、`pnpm run typecheck`、`pnpm run lint`、
`git diff --check` が green。production-like approval test、全 route の framework-specific parsing、
日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 5

iMessage bridge の `/send` を再監査し、`recipient`／`text`／`serviceName`／`attachments` が配列・
オブジェクトでも `String(...)` または未検証値として送信処理へ到達し得る残存を検出した。strict な
`parseIMessageBridgeInput` を追加し、HTTP `/send` と CLI の input file の双方で object、string field、
string array を検証してから `handleSend` へ渡すよう修正した。BlueBubbles webhook の provider payload
は既存の専用 parser 契約を維持している。

検証: iMessage bridge **1 file / 5 tests passed**、`pnpm run typecheck`、`pnpm run lint`、
`git diff --check` が green。全 route の framework-specific parsing と日英 literal の全面移行は
引き続き未完了である。

## 2026-09-01 再レビュー修正 18

Presence Studio の browser onboarding preview／apply の入力契約を再監査し、route 側は core の
onboarding parser に委譲していたものの、Zod の既定挙動により top-level と nested object の未知 field が
破棄される残存を検出した。identity、voice、service、provider、reasoning、tools、tutorial と全体 draft を
strict 化し、未知入力を profile／connection artifact の生成前に拒否する回帰を追加した。

検証: browser onboarding **1 file / 1 regression test追加**、変更対象 Prettier、root typecheck、`git diff --check` が green。
全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-01 再レビュー修正 17

Presence Studio の held-action／approval decision route を再監査し、decision enum の比較だけで
`req.body` の object 性と未知 field を検証していない残存を検出した。共通の strict decision schema を
追加し、両承認 route で副作用前に同じ `approved|rejected` 契約を検証するよう修正した。既存の local-admin、
viewer scope、approval store、held-action の認可・保存責務は維持している。

検証: Presence Studio approval input／OS route **3 files / 15 tests passed**、変更対象 Prettier、root typecheck、
`git diff --check` が green。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は
引き続き未完了である。

## 2026-08-30 実装レビュー追記 8

terminal bridge の `/sessions` と WebSocket control message を再監査し、session ID・PTY サイズ・input payload
を暗黙受理していたため、runtime path に入る値の path traversal と不正な resize／write の余地が残っていた。
共有 session parser を追加し、ID を安全な basename に限定、HTTP body と init／input／resize の型・範囲・未知キーを
検証してから session／PTY へ渡すようにした。不正 JSON object は PTY へ書き戻さず、構造化 error を返す。既存の
認証、session persistence、未 JSON の terminal input fallback は維持している。

検証: terminal session/auth **2 files / 9 tests passed**、変更対象 lint、root typecheck、`git diff --check`、
`CI=true pnpm run check -- --scope full` **67/67** が green。レビュー追試で、壊れた JSON object を未 JSON の
terminal input fallback と誤認しない判定と、state の directory id／payload id 一致検証を追加した。
全 route の framework-specific parsing と日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 12

Chronos の deliverable review と knowledge feedback を再監査し、object 判定後に artifact ID、verdict、comment、
reason、tenant／organization／project を個別に既定値化していた残存を検出した。専用 parser を追加し、durable review
write と feedback 記録より前に、path-safe ID、knowledge path の traversal、enum、文字列の型・長さ、未知フィールドを
検証するようにした。viewer／tenant／tier／organization／project の既存 scope 判定と review／feedback の責務は維持している。

検証: Chronos deliverable／knowledge input **2 files / 4 tests passed**、変更対象 lint、root typecheck、
`git diff --check` が green。全 route の framework-specific parsing と日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 11

Chronos の `/api/connections` を再監査し、body が object であることだけを確認した後、binding ID、action、
note、tenant を個別に既定値化して connection review の durable write へ渡していた残存を検出した。専用 parser を
追加し、binding ID を path-safe な basename に限定、action enum、文字列 field の型・長さ、未知フィールドを
mutation 前に検証するようにした。viewer／tenant scope と connection review の既存権限・保存 gate は維持している。

検証: Chronos connections input **1 file / 2 tests passed**、変更対象 lint、root typecheck、`git diff --check` が green。
全 route の framework-specific parsing と日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 9

Presence Studio の高リスク request schema を再監査し、Zod の既定挙動で未知フィールドが破棄されるほか、
native-listen／location route が `Number(...)` で文字列を暗黙変換し、approval decision も `String(...)`
で入力を変換していた残存を検出した。voice／email／minutes／location／browser bootstrap の schema を
strict 化し、native-listen／location は検証済み body をそのまま受理、approval decision は文字列値だけを
許可するよう修正した。既存のブラウザ payload と承認 gate は維持している。

検証: Presence Studio security／OS route **3 files / 14 tests passed**、変更対象 lint、root typecheck、
`git diff --check` が green。全 route の framework-specific parsing と日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 10

Telegram bridge の `/send` と `--input` の send 分岐を再監査し、`chatId`／`text`／`parseMode` を
`|| ''` で既定値化していたため、配列・オブジェクト・空文字が provider 呼び出しへ到達し得る残存を検出した。
strict な `parseTelegramSendInput` を HTTP と CLI の双方へ接続し、chat ID、本文、parse mode、未知フィールドを
検証してから `sendTelegramMessage` を呼ぶようにした。webhook の provider payload parser と外部送信 gate は変更していない。

検証: Telegram bridge **1 file / 8 tests passed**、変更対象 lint、root typecheck、`git diff --check` が green。
全 route の framework-specific parsing と日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 6

voice-hub の `/api/stop-speaking`、`/api/ingest-text`、`/api/listen-once` を再監査し、Express の
`req.body?.field` 既定値化により、配列・`null` などの非 object JSON が request として処理され得る
残存を検出した。`readVoiceHubRequestObject` を独立した入力境界として追加し、3 endpoint で外部処理・
音声録音・状態変更より前に拒否するよう修正した。body が未指定の場合の既存既定値挙動は維持している。

検証: voice-hub request input **1 file / 2 tests passed**、`pnpm run typecheck`、`git diff --check` が
green。framework-specific parsing の全 route と日英 literal の全面移行は引き続き未完了である。

## 2026-08-30 実装レビュー追記 7

voice-hub の `scope` 入力を再監査し、object であることだけを確認して型キャストしていたため、tenant／tier／
scope kind の配列・未知フィールド・不正 enum が normalization 前に request 境界を通過し得る残存を検出した。
共通 `parseEventScopeInput` を追加し、voice-hub では `normalizeEventScope` と組み合わせて外部処理・stimulus
保存より前に strict 検証するようにした。scope の権限をクライアント入力で拡張する変更は行わず、既存の surface
ingress normalization と tier policy を維持している。

検証: event-scope／voice-hub request input **2 files / 12 tests passed**、変更対象 lint、`pnpm run typecheck`、
`git diff --check`、full gate **67/67** が green。framework-specific parsing の全 route と日英 literal の全面移行は
引き続き未完了である。

## 2026-08-30 実装レビュー追記 13

Chronos の OS share-grants mutation を再監査し、object 判定後に operation、taint、role、tenant、TTL、日時を
個別に既定値化・型キャストして共有グラフへ渡していた残存を検出した。operation ごとの strict parser を追加し、未知
フィールド、enum、path-safe な識別子、TTL 上限、expiresAt／connectedAt、非 public taint の provenance を graph／
session mutation より前に検証するようにした。localadmin、viewer actor、provenance、share-link token の既存認証・
認可責務は維持している。

## 2026-08-30 実装レビュー追記 14

Chronos の `/api/intelligence` action boundary を再監査し、action の whitelist だけでは各 action の未知 field、
型、enum、必須値を防げず、承認・memory・mission／surface・runtime の side effect へ暗黙変換値が到達し得る
残存を検出した。action ごとの strict parser を共通化し、control-plane side effect 前に拒否するよう修正した。
既存の localadmin／viewer scope、approval、mission worker、runtime supervisor の責務は変更していない。

検証: intelligence input／existing intelligence **2 files / 14 tests passed**、変更対象 lint、root typecheck、
`git diff --check` が green。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は
引き続き未完了である。

## 2026-08-30 実装レビュー追記 15

Chronos の conversational `/api/agent` request boundary を再監査し、object 判定だけの body が未知 field、
object／過大な query、locale、session、proposal action を暗黙受理し得る残存を検出した。strict parser を追加し、
会話 dispatch と mission proposal 操作より前に拒否するよう修正した。既存の viewer／localadmin gate、quick-action
制限、mission proposal の責務は変更していない。

検証: agent helper／route **2 files / 32 tests passed**、変更対象 lint、root typecheck、`git diff --check` が green。
全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

検証: Chronos share-grant input／route **2 files / 7 tests passed**、変更対象 lint、root typecheck、
`git diff --check` が green。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は
引き続き未完了である。

## 2026-09-01 再レビュー修正 16

operator-surface の inbox mutation を再監査し、JSON body は object 判定後に `Record<string, unknown>` へ
キャストし、FormData と JSON で別々に値を取り出していた残存を検出した。`entry_id` の空値、status enum、
File 値を共通 parser で mutation 前に検証し、両入力経路を同じ `InboxMutationInput` へ正規化した。
既存の operator mutation 認可、human receipt、redirect の責務は維持している。

検証: operator-surface inbox input／route **2 files / 13 tests passed**、変更対象 Prettier、root typecheck、
`git diff --check` が green。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は
引き続き未完了である。

## 2026-09-01 再レビュー修正: peer conversation／messaging CLI JSON 入力境界

peer conversation／peer messaging の CLI JSON 入力を再監査し、`metadata`／`payload` を JSON parse 成功だけで
会話保存・署名付き envelope 作成へ渡していた残存を検出した。共通 `scripts/lib/json-input.ts` を追加し、JSON value の
再帰 shape と `__proto__`／`constructor`／`prototype` を検証し、conversation metadata は object に限定してから下流へ渡すよう修正した。
既存の peer message payload、会話 transcript、送信 semantics は変更していない。

検証: peer JSON input／peer CLI **3 files / 5 tests passed**、変更対象 Prettier、root typecheck、`git diff --check` が green。
全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 19

Presence Studio の議事録開始／voice停止 request を再監査し、`missionId`、会議タイトル、言語、入力デバイス、停止理由が `String(...)` または個別の既定値化を経て、マイク起動・voice-hub転送へ到達し得る残存を修正した。既存の strict schema 群へ minutes session start／voice stop schema を追加し、未知フィールド、配列・オブジェクト、空文字を副作用前に 400 で拒否するようにした。正常系の trim と既定言語／停止理由、録音同意・外部 voice 配送 gate は維持している。

検証: Presence Studio security／minutes input **1 file / 4 tests passed**、対象 typecheck、Prettier、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 20

Presence Studio の demo frame request を再監査し、surface／agent／表示状態／字幕／transcript の各値を個別に既定値化し、未知 field と不正な transcript item が A2UI frame 生成へ到達し得る残存を修正した。strict な demo frame schema を追加し、配列・オブジェクト・空文字・未知 field を frame 生成前に 400 で拒否するようにした。body 未指定時の既存デモ既定値と A2UI dispatch semantics は維持している。

検証: Presence Studio request schema **1 file / 8 tests passed**、対象 typecheck、Prettier、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 21

Concierge の文書取込 multipart 境界を再監査し、`tenant`／`format`／`dry_run` を `String(FormData)` で暗黙変換していたため、File・未知フィールド・重複値・未定義の真偽値が tenant lookup／ファイル staging 前に曖昧化する残存を検出した。strict な `parseIngestForm` を追加し、対応フィールド、単一値、文字列型、format enum、dry-run enum、File 型を正規化してから既存の tenant registry 検証と ingest ceremony へ渡すようにした。未指定 `dry_run` は従来どおり false とし、既存の preview／commit semantics は変更していない。

検証: Concierge ingest input **1 file / 10 tests passed**、変更対象 Prettier、root typecheck、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 22

Concierge の JSON mutation route 群を再監査し、root object だけを検査して未知 field を各 route の暗黙既定値化へ通していた残存を検出した。共通 `readRequestObject` に route ごとの許可キー検証を接続し、message、notification、config mission、approval、outcome、hygiene、memory queue、plugin の各副作用前に未知 field を 400 で拒否するようにした。既存の route-specific enum／tenant／viewer／approval 検証と body 未指定時の契約は変更していない。

検証: Concierge request-input／ingest input／message input **4 files / 21 tests passed**、変更対象 Prettier、root typecheck、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 23

Concierge の契約テストを現行 `ConversationMessageResponse.reply` 契約と照合し、旧 `replyText` を要求する stale assertion が package-local test を失敗させていたため修正した。併せて共通 JSON key guard に `__proto__`／`constructor`／`prototype` の明示的な拒否を追加し、許可キー検証を prototype-shaped key に対しても fail-closed にした。会話 payload の canonical field と既存の返信 semantics は変更していない。

検証: Concierge contract **1 file / 23 tests passed**、request input等 **4 files / 21 tests passed**、変更対象 Prettier、root typecheck、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 24

Concierge setup の JSON／multipart 境界を再監査し、action ごとの未知 root field、tenant／agent の未知 nested field、FormData の未知／重複 field が設定書き込み前に無視される残存を検出した。共通 JSON／FormData key guard を接続し、`save_management`／`apply_onboarding` と avatar／voice sample の許可 field だけを受理するようにした。既存の型検証、profile／tenant／agent の governed write、onboarding draft semantics は変更していない。

検証: Concierge setup input／request input **2 files / 17 tests passed**、Concierge build、root typecheck、Prettier、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 25

Concierge の voice/listen-once proxy を再監査し、backend／device／locale の型検証はあるものの未知 JSON field を受理して voice-hub 呼び出しへ進める残存を検出した。共通 request key guard を接続し、許可された3 field 以外を外部接続前に 400 で拒否するようにした。既存のtrim、既定locale、voice-hub response parser、Tier-0 fallback semantics は変更していない。

検証: Concierge listen-once **1 file / 6 tests passed**、Concierge build、root typecheck、Prettier、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 26

Concierge の config-missions プリセット読込を再監査し、repository-local JSON を `JSON.parse` 後に domain parser へ渡していた残存を検出した。共有 `parseSafeJsonInput` を preset read 前へ接続し、malformed／primitive／配列／nested dangerous key を既存の unreadable preset skip へ閉じた。preset の一覧・入力 spec・draft creation semantics は変更していない。

検証: Concierge config-missions resource boundary **1 file / 1 test passed**、Concierge build、root typecheck、Prettier、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 27

Concierge ingest の外部CLI verdict parserを再監査し、marker後のJSON出力を直接 `JSON.parse` してから型判定していた残存を検出した。共有 `parseSafeJsonInput` を先行させ、malformed／primitive／配列／nested dangerous key を既存の verdict 不在扱いへ閉じた。dry-run／commit の判定と target path の既存型検証は変更していない。

検証: Concierge ingest output parser **1 file / 1 test passed**、Concierge build、root typecheck、Prettier、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-02 再レビュー修正 28

surface のJSON request readerを再監査し、Chronos／Concierge／operator-surface に重複していた malformed／非object body の読み取りを foundation の `readJsonObjectRequest` へ統合した。dangerous nested key も共通境界で拒否し、各surfaceの route-specific field parser、認可、approval、multipart、外部配送の責務は維持した。

検証: foundation／surface request input／operator inbox **4 files / 33 tests passed**、core package build、root typecheck、対象 lint／Prettier、`git diff --check`、canonical full gate **69/69 passed**。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-04 再レビュー修正 29

Computer Surface の `/a2ui/dispatch` を再監査し、tenant scope の検査後に `A2UIMessage` へ型アサーションするだけで、malformedな update data model／component／operation を state 適用へ渡す残存を修正した。A2UI wire の構造 validator を core へ移し、Presence Studio も同じ validator を利用するように統合した。既存の tenant scope、localadmin gate、A2UI state適用 semanticsは変更していない。

検証: A2UI validator／Computer Surface resource boundary **3 files / 追加回帰を含む focused tests**、root typecheck、root lint、`pnpm run check -- --scope full`。全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-04 再レビュー修正 30

A2UI 共通 validator の適用範囲を再監査し、既知 operation の組み合わせだけを検査していたため、root／operation payload／component の未知 field と、型不正な `children`／`titleKey` が内部 dispatch または surface 適用へ到達し得る残存を検出した。validator に許可キーの fail-closed 検査と wire 型検査を追加し、A2UI dispatcher 自身も transport 呼び出し前に検証するようにした。併せて JSON Schema の `additionalProperties` 制約を実装と揃えた。

検証: A2UI／Computer Surface **3 files / 17 tests passed**、root typecheck、root lint、`git diff --check`、knowledge index 生成。canonical full gate は修正後に再実行する。

## 2026-09-04 再レビュー修正 31

A2UI の wire Schema と runtime validator を再照合し、nested payload の未知 field と Component の `props` 欠落に対して Schema 側の制約が緩い残存を修正した。create／update／delete 各 payload、Component の `additionalProperties` と `props` 必須条件を runtime validator と一致させ、Schema 経由の検証でも同じ fail-closed 契約を適用するようにした。

検証: A2UI／Computer Surface **3 files / 17 tests passed**、root typecheck、root lint、`git diff --check`、knowledge index 生成、canonical full gate **69/69 passed**。

## 2026-09-06 再レビュー修正 32

channel adapter の共通 thread formatter を再監査し、履歴の見出し・話者ラベルだけが
`en` 固定で、operator locale を解決済みの各 bridge から渡せない残存を検出した。
formatter に `SupportedLocale` を受け取る optional 引数を追加し、Slack／Telegram／Discord／iMessage
の4 bridge が `resolveOperatorLocale()` を渡すようにした。既定値は `en` として既存の呼出し互換性を
維持し、delivery gate、current message 除外、履歴件数制限、provider 配送 semantics は変更していない。

検証: channel adapter／4 bridge **5 files／50 tests passed**、root typecheck、Prettier、`git diff --check`。
全 route の framework-specific parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 33

Slack の approval／mission proposal UI に残っていた contract label、approval control、確認文言の
日英直書きを bridge vocabulary へ移し、Slack bridge が `resolveOperatorLocale()` を UI builder へ渡すようにした。
省略時の既存互換表示と `shouldSend`／approval state／external delivery semantics は変更していない。

検証: Slack approval／proposal／surface agent **4 files／34 tests passed**、root typecheck、Prettier、
`git diff --check`。framework-specific request parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 34

共通 `ChannelAdapter` の text-only contract projection を再監査し、本文の言語推定だけに依存していた locale
決定を `ChannelTurnInput.locale` へ拡張した。4 bridgeがoperator localeを共通formatterへ渡し、thread contextと
approval／clarification contract labelsが同じlocaleで描画されるようにした。既存のdelivery gate、current message
除外、provider配送semanticsは維持している。

検証: channel adapter／4 bridge **5 files／51 tests passed**、root typecheck、Prettier、`git diff --check`。
framework-specific request parsing、provider 実機受入、日英 literal の全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 35

shared surface conversation inputへ `SupportedLocale` を追加し、orchestratorが生成する `IntentResolutionContract` の `next_action` label／consequenceまでbridgeのoperator localeを利用するようにした。専用channel formatterと契約直接描画のlocaleを同一経路へ揃え、既定の英語とprovider配送、approval／tenant scope semanticsは維持した。

検証: intent contract／surface interaction／orchestrator／4 bridge **8 files／83 tests passed**、root typecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 36

generic approval／proposal builderにoptional localeを追加し、Telegram／Discord／iMessage bridgeがoperator localeを渡すようにした。Slackで先行したapproval／proposalのvocabulary境界を3 bridgeにも適用し、既定の日本語とprovider配送、approval／tenant scope semanticsは維持した。

検証: generic approval／proposal／3 bridge **5 test files／46 tests passed**、root typecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 37

`resolveMissionProposalReply` の取消／発行結果へoptional localeを伝播し、Telegram／Discord／iMessage bridgeの確認後replyもoperator localeで描画するようにした。既定の日本語、proposal state、mission issuance、provider配送、approval／tenant scope semanticsは維持した。

検証: mission proposal／3 bridge **4 test files／35 tests passed**、root typecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 38

mission steering のapproval-gated replyへ `SurfaceConversationInput.locale` を伝播し、承認待ちの状態・選択肢・次アクションをoperator localeで描画するようにした。既定の日本語、approval／tenant scope、provider配送、human-only decision semanticsは維持した。

検証: mission steering **1 file／12 tests passed**、root typecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 39

voice-hub の入力言語を共有 surface conversation inputとtext-only contract projectionへ伝播し、音声surfaceでも応答本文・契約ラベル・fallback intent contractのlocaleを揃えた。voice-hub boundary testをroot Vitestのinclude対象へ追加し、既存のscope、provider配送、音声応答 semanticsは維持した。

検証: voice-hub boundary **1 file／2 tests passed**、root typecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 40

Slack automation／mission proposal と Discord interaction rejection に残っていた日英リテラルをshared vocabularyへ移し、operator localeを通して描画するようにした。approval／proposal decision、actor authorization、provider配送 semanticsは維持した。

検証: Slack／Discord bridge **2 files／16 tests passed**、catalog integrity、vocabulary generators、root typecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、残る日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 41

terminal-hud、Concierge fallback、Chronos APIのlocaleをshared conversation inputへ揃え、channel以外のoperator surfaceでもcontract label／next actionのlocaleが落ちないようにした。Concierge contract test suiteをroot Vitestへ登録し、3 surfaceのwire回帰を実行対象にした。

検証: terminal-hud／Concierge／Chronos **3 files／27 tests passed**、root typecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、残る日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 42

CLI／background review／iMessage demo／Telegram demoのsurface conversation inputにもlocaleを明示し、channel bridge以外の入口でもshared contractのlocale境界を落とさないようにした。既存のprovider配送、approval、tenant scope semanticsは変更していない。

検証: CLI trust-boundary／locale wiring、demo／backgroundのtypecheck、Prettier、`git diff --check`。framework-specific request parsing、provider実機受入、残る日英のchannelリテラル全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 43

Presence Studio の Cloudflare OS held-action decision／apply route を再監査し、Express の route param を
`String(...)` で暗黙変換して配列・オブジェクトを action ID として副作用へ渡し得る残存を検出した。
共通 `readPresenceStudioRouteParam` を追加し、単一 string の trim 済み値だけを held-action の決定・適用へ渡すようにした。
localadmin、tenant scope、approval decision、held-action apply semantics は変更していない。

検証: Presence Studio approval／OS control-plane **2 files／24 tests passed**、対象 ESLint、Prettier、`git diff --check`。隔離環境の root typecheck は既存の `discord.js` 型モジュール欠落で停止した。

## 2026-09-06 再レビュー修正 44

Presence Studio の approval、artifact、task-session route に残っていた `req.params` の暗黙 `String(...)`
変換を再監査し、request ID／artifact ID／session ID が配列・オブジェクトから生成され得る残存を検出した。
held-action route と同じ `readPresenceStudioRouteParam` を全 dynamic route parameter へ適用し、単一 string
だけを lookup／download／artifact projection へ渡すようにした。既存の resource scope、404、download semantics は維持した。

検証: Presence Studio route-parameter boundary **3 files／25 tests passed**、対象 ESLint、Prettier、`git diff --check`。

## 2026-09-06 再レビュー修正 45

Presence Studio の knowledge-ref／runtime-ref query path に残っていた `String(req.query.path || '')`
変換を再監査し、重複 query 値や object-shaped input が path resolver へ到達し得る残存を検出した。
route／query 共通の `readPresenceStudioStringParam` へ抽象化し、dynamic route parameter 6箇所と query path
2箇所で単一 string の trim 済み値だけを受理するようにした。既存の knowledge／runtime allowlist、safe file read、404／403 semantics は維持した。

検証: Presence Studio string-parameter boundary **3 files／25 tests passed**、対象 ESLint、Prettier、`git diff --check`。

## 2026-09-06 再レビュー修正 46

Presence Studio runtime-data の onboarding voice-sample `profile_id` query を再監査し、`String(...)`
変換で repeated／object-shaped query 値を profile lookup と音声 sample 保存へ渡し得る残存を検出した。
共通 `readPresenceStudioStringParam` を runtime-data の入口にも接続し、未指定値は空文字、単一 string だけを既存の onboarding path／保存契約へ渡すようにした。

検証: Presence Studio runtime-data boundary **1 file／3 tests passed**、対象 ESLint、Prettier、`git diff --check`。

## 2026-09-06 再レビュー修正 48

Chronos の filesystem／trace 系 Next route に残っていた framework query 値の個別読み取りを再監査し、
mission asset、deliverable preview、trace feed、knowledge/runtime/trace-log reference の path・ID・scope
値が route ごとの既定値化へ分散している残存を検出した。共通 `readChronosStringParam`／
`readChronosOptionalStringParam` を追加し、trim 済みの単一 string だけを path／artifact lookup／viewer
scope／trace projection へ渡すようにした。既存の tenant scope、safe path、404／403、trace filtering semantics
は変更していない。

検証: request-input **1 file／2 tests passed**、route source boundary **1 file／1 test passed**、対象 lint、
Prettier、`git diff --check`。全 route の framework-specific parsing、provider 実機受入、日英の channel
literal 全面移行は引き続き未完了である。

## 2026-09-06 再レビュー修正 49

Chronos の認可・一覧投影 route（approvals、deliverables、knowledge、tenant-scope、workitems）に残っていた
query 値の個別既定値化を再監査し、tenant／organization／project／listing filter が共通
`readChronosStringParam`／`readChronosOptionalStringParam` を通るようにした。trim 済みの単一 string だけを
認可計算・scope selector・一覧 projection へ渡し、既存の viewer scope、tier、limit、404／403 semantics は変更
していない。

検証: request-input boundary **1 file／2 tests passed**、対象 route の ESLint、Prettier、
`git diff --check`。Next runtime依存が隔離環境にないため既存 `workitems/route.test.ts` は
`next/server` import前に停止し、CIでの実行確認を継続する。

## 2026-09-06 再レビュー修正 50

Chronos の collaboration snapshot／stream と headless work-items／collaboration route に残っていた
scope query の個別既定値化を再監査し、mission／tenant／organization／project／task／session／scope kind／limit
を共通 `readChronosOptionalStringParam` へ接続した。trim 済みの単一 string だけを認可・projection・SSE filterへ
渡し、既存の collaboration snapshot／stream semantics と headless envelope semantics は変更していない。

検証: request-input boundary **1 file／2 tests passed**、対象 route の ESLint、Prettier、
`git diff --check`。provider 実機受入と Next runtime を含む統合実行は継続課題である。

## 2026-09-06 再レビュー修正 51

Chronos API全体を再走査し、agent activity／agents／connections／cost、headless operator-home／A2UI、
missions search、operator-home、organization operating model、OS control-plane、tenant design、
intelligence snapshot／stream まで残っていた query の既定値化を共通入力ヘルパーへ統一した。これにより
Chronos API **28 route** の query scope／filter／limit／flag が trim 済みの単一 string 境界を通り、認可・projection・
SSE・design resolutionへ渡る。既存の viewer scope、tier、headless envelope、OS read-only semantics は変更していない。

検証: request-input boundary **1 file／2 tests passed**、Chronos API directory ESLint、Prettier、
`git diff --check`。Next runtimeを含む統合実行とprovider実機受入はCI／環境依存の継続課題である。

## 2026-09-06 再レビュー修正 47

Presence Studio onboarding voice-sample の `content-type` header を再監査し、header array を `String(...)`
で暗黙連結して音声保存へ渡し得る残存を検出した。`readPresenceStudioStringParam` を header boundary にも接続し、単一 string 以外は空値として既存の content-type／保存処理へ渡すようにした。

検証: Presence Studio runtime-data boundary **1 file／3 tests passed**、対象 ESLint、Prettier、`git diff --check`。

## 2026-09-06 再レビュー修正 52

Presence Studio の `/api/ui-vocabulary` を再監査し、`req.query.locale` を locale normalizer へ直接渡して配列・object-shaped query が暗黙文字列化される残存を修正した。共有 `readSurfaceStringParam` を先行させ、単一 string 以外は既存の既定 locale `en` へ fail-closed にした。catalog lookup と既存の locale normalization semantics は維持している。

検証: Presence Studio route-parameter boundary **1 file／1 test passed**、対象 ESLint、Prettier、`git diff --check`。framework-specific request parsing、provider 実機受入、日英の channel literal 全面移行は継続課題である。
