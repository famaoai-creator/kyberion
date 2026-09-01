---
title: SX-09b channel surface consolidation follow-up
tags: [simplicity, channel-adapter, surface, 2026-08]
last_updated: 2026-08-30
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
