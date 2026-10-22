---
title: A2UI COMPONENT HOST PLAN 2026 09 15
tags: [improvement-plan, 2026-08, a2ui, surface, component-registry, headless, front-desk, ux]
last_updated: 2026-09-15
status: active
---

# A2UI 部品ホスト計画(AU-00〜AU-07)— surface ごとの Web UI から、部品レジストリ + 単一レンダラへ

> **作成日**: 2026-09-15
> **対象**: 6 つの surface(chronos-mirror-v2 / computer-surface / concierge / operator-surface / presence-studio / terminal-hud)がそれぞれ別の殻(Next.js × 2、Express + 静的 HTML × 2、TUI …)で UI を持っている現状を、**業務フロー単位の A2UI 部品** + **部品レジストリ** + **堅牢なレンダラ 1 つ(ホスト)** + **AI が叩けるヘッドレス API** に寄せる。
> **前提**: `libs/core/a2ui.ts`(A2UI message / component 契約・検証・dispatcher)、`libs/core/headless-surface-contract.ts`(operation descriptor・manifest・envelope・viewer scope)、chronos-mirror-v2 の `HeadlessA2UIWorkspace` + `A2UIComponentLibrary`(React レンダラの芽)、フロントデスクの共有レール([FRONT_DESK_REDESIGN_PLAN](./FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md) FD-00〜10)、フェーズ式ヒアリング([FRONT_DESK_HEARING_TRAINING_PLAN](./FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md))。
> **ステータス表記**: 各フェーズ末尾の「実装状況」節に記録(07 月次規約と同一)。

---

## 0. 目的と判断基準

1. **横断ルールはホストが 1 か所で持つ。** viewer scope とテナント narrowing、loopback / localadmin、語彙カタログによる i18n と内部語ゲート、レート制限、履歴、デザインカスケード、プロセス寿命。2026-09-14 の実機 QA で潰した不具合(テナント切替の二重修正、Next.js 側だけにあった loopback の穴、surface ごとに残った古いプロセス)は、すべてこれが殻ごとに複製されていたコストである。
2. **部品は業務フロー 1 つを司り、宣言的な UI(A2UI component 型)だけを出す。** HTML・スタイル・自前の React アプリは持ち込まない。Portlet が孤島化した失敗を、宣言的な部品と単一レンダラで避ける。
3. **API はヘッドレス一本。** 人の UI 専用 API を作らず、レンダラもエージェントも同じ operation(manifest)を叩く。
4. **業務状態は `libs/core` の facade 側、部品は薄い。** 共通ヘルパーが受けるのは整形・ページング・履歴表示。
5. **外部仕様(A2UI)の変化は adapter 一枚に閉じる。** repo 内の `A2UIMessage` 契約を正本にする。

## 1. 現状

| 要素           | ある                                                                                                                                                                                   | 無い                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A2UI 契約      | `A2UIMessage` / `A2UIComponent`(型・検証・dispatcher)、`display:*` 21 種 + chronos / presence 固有型                                                                                   | 人の入力(フォーム)の型、operation を伴う action の型                    |
| ヘッドレス契約 | operation descriptor(method / path / effect / required_role / schema / a2ui_projection)、manifest、envelope、viewer 別フィルタ。chronos・computer-surface・presence-studio に manifest | 部品単位の一覧(どの operation がどの業務フローに属するか)               |
| レンダラ       | chronos-mirror-v2 の React component library(`display:*` 21 種)                                                                                                                        | フロントデスク側の A2UI レンダラ。人向け 5 動詞の殻は静的 HTML で別実装 |
| レジストリ     | `active-surfaces.json`(プロセス単位)、各種 governed catalog                                                                                                                            | **部品レジストリ**(業務フロー単位の id・operation・配置・権限)          |
| 業務状態       | 決定台帳(`libs/core/decision-ledger`)、ヒアリング record、承認 store、mission                                                                                                          | —                                                                       |

## 2. 設計

### 2.1 三層

```
部品レジストリ(governed catalog)   何がある・どこに置く・誰が使える・どの operation を持つ
        │
ホスト(単一レンダラ)              グローバルメニュー / 部品メニュー / レイアウト / 履歴 / scope / i18n
        │  A2UI messages + action descriptors        ↑ ヘッドレス operation(同じ契約をエージェントも叩く)
部品(業務フロー)                  record → A2UI 投影(純関数)、action は operation の参照だけ
        │
libs/core の facade               状態・検証・権限(決定台帳、ヒアリング、承認 …)
```

### 2.2 部品レジストリ

`knowledge/product/orchestration/ui-component-registry.json`(schema `ui-component-registry.schema.json`、catalog integrity 登録)。1 部品 = 業務フロー 1 つ。

| 項目                        | 意味                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `id` / `kind`               | `flow`(状態を持つ業務フロー)/ `view`(読み取り投影)                                                  |
| `title_key` / `summary_key` | 語彙キー(内部語ゲート)                                                                              |
| `status`                    | `a2ui`(ホストで描く)/ `page`(従来ページへ遷移)/ `planned`                                           |
| `host` / `entry`            | ホストとなる surface、`a2ui_path`(投影 operation)・`page_path`・`input`(人の入力を受ける operation) |
| `menu`                      | グローバルメニューのどの動詞の下に、どの順で置くか                                                  |
| `operations`                | この部品が持つ headless operation id(manifest と突合)                                               |
| `required_role`             | 表示に要る最低ロール                                                                                |

### 2.3 ホスト

フロントデスクの共有レール(presence-studio)をホストに昇格させる。`/flow/<component>` が 1 ページで全部品を描く。左に 5 動詞のレール、次に部品メニュー(レジストリから)、中央に A2UI 描画、下に入力バー(部品が `entry.input` を宣言したときだけ)。

レンダラ(`static/a2ui-host.js`)は **固定の component library** を持ち、未知の型は「まだ表示できません」を描いて落ちない。描画は DOM API(`textContent`)のみで、HTML 文字列を挿入しない。`button` の `action` は operation descriptor(method / path / body)を持ち、ホストが実行して投影を再取得する。

### 2.4 部品(第 1 号: ヒアリング)

`hearing-a2ui.ts`(純関数)が `HearingRecord` + フェーズ進捗 + 次の質問を A2UI に投影する: `display:hero`(見出し・充足率)、`display:progress`(フェーズ)、`display:alert`(次の質問)、フェーズごとの `display:section` + `display:kv`(項目 → 答え)、`button`(決める / 依頼として渡す)。入力バーの答えは `presence.hearing.answer` operation(既存 `/api/hearing/:session/answer`)へ。決める・渡すも既存 operation の参照だけ。

### 2.5 ヘッドレス

presence-studio の manifest に `presence.components.read`(レジストリ一覧)、`presence.hearing.view.a2ui`(投影)、`presence.hearing.answer / decide / handoff`(write)を追加。エージェントは manifest → 投影 → operation の順で同じ面を使える。

### 2.6 守り線(部品に書かせないもの)

tenant / viewer / role の解決、HTML、スタイル、ポート番号、語彙以外の表示文言、他 surface への直接呼び出し。

## 3. フェーズ計画

### AU-00: 計画と判断(P0)

ホストは chronos-mirror-v2 の React レンダラではなく、フロントデスクの共有レールを育てる。理由: 人の 5 動詞と語彙ゲートが既にあり、利用者が触っている面だから。chronos の component library は `display:*` の型・props の正本として参照し、ホストの library はそれに揃える。

### AU-01: 部品レジストリ(P0)

schema + catalog + `libs/core/ui-component-registry.ts`(読込・ロール別一覧・id 検索)+ catalog integrity 登録。既存機能を登録: ヒアリング(`a2ui`)、決定台帳(`planned`)、承認(`page` → 秘書室)、進み具合(`page`)。

### AU-02: ホスト(P0)

`/flow/:component` ページ、`GET /api/components`、`GET /api/flow-vocabulary`、`static/a2ui-host.js`(固定 library・action 実行・未知型の安全な表示)、`static/flow.js`(レール・部品メニュー・入力バー・再取得)。

### AU-03: 第 1 部品 = ヒアリング(P0)

`hearing-a2ui.ts` + `GET /api/headless/a2ui/hearing`。manifest に hearing の operation を追加。`/flow/hearing` でフェーズ式ヒアリングが最初から最後(依頼として渡す)まで完了できること。

### AU-04: 決定台帳を部品化(P1)

`decision-ledger` の投影(`projection.ts`)を A2UI に写像し、`pnpm decisions` の operation をヘッドレスに載せる。ヒアリング(答える)と台帳(決める・突合結果)が同じホストの隣の部品になる。

### AU-05: 承認・進み具合を部品化し、重複ページを落とす(P1)

秘書室の承認キュー、相棒の進み具合を `view` 部品に。部品化できたページから静的ページ・Next ページを削除。

### AU-06: レンダラの堅牢性と契約テスト(P1、並走)

未知型・巨大メッセージ・不正 props で落ちない、CSP / sandbox の一律適用、内部語ゲート、viewer scope を送っても tenant が変わらない、を契約テストで固定。Playwright は設定が入ってから。

### AU-07: 外部 A2UI 仕様への adapter(P2)

repo 内契約 ⇄ 外部仕様の変換を 1 モジュールに閉じ、chronos の React library とホストの library の props 差分を解消する。

## 4. リスクと対応

| リスク                            | 対応                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 単一レンダラが単一障害点になる    | library 固定・未知型は描かず落とさない・action 失敗は文言で返す(AU-06)                                               |
| 部品に HTML / tenant 判定が漏れる | 部品は純関数で A2UI だけを返し、tenant / viewer は route で解決(§2.6)。契約テストで `innerHTML` 非使用と内部語を検査 |
| A2UI 外部仕様の変化               | repo 内契約を正本に、adapter 一枚(AU-07)                                                                             |
| 既存ページの二重運用が長引く      | レジストリの `status` で `a2ui` / `page` を明示し、部品化のたびに `page` を落とす(AU-05)                             |

## 5. 未決事項

- 人の入力(フォーム)を A2UI component 型として持つか、ホストの入力バー(部品が `entry.input` を宣言)に留めるか。初期は後者。
- chronos-mirror-v2 の React library とホストの JS library、長期的にどちらを正本にするか。
- 秘書室(Next.js)をホストに統合する時期。

## 6. 実装状況

- 2026-09-15: 計画作成。AU-00 の判断(ホスト = フロントデスク共有レール)を確定。
- 2026-09-15: **AU-01〜AU-03 初期実装(実装コンセプトが動く形)** —
  - レジストリ: `knowledge/product/orchestration/ui-component-registry.json` + schema(catalog integrity 登録)、`libs/core/ui-component-registry.ts`(ロール別一覧・id 検索・manifest との突合 `unknownComponentOperations`)。登録: ヒアリング(`a2ui`)、決定台帳(`planned`)、承認(`page` → 秘書室)、進み具合(`page`)。
  - ホスト: `/flow/:component`(`static/flow.html` / `flow.js` / `flow.css`)、`static/a2ui-host.js`(固定 library 13 種: text / button / card / container / display:hero / section / card / list / kv / progress / alert / badges / status。DOM API のみ、未知型は「まだ表示できません」、`button.action` はヘッドレス operation をホストが実行して再取得)、`GET /api/components`(レジストリをロール別に、語彙解決・href 付き)、`GET /api/flow-vocabulary`。
  - 第 1 部品: `hearing-a2ui.ts`(純関数の投影: hero / progress(フェーズ)/ alert(次の質問)/ フェーズごとの section + kv / decide・handoff ボタン)、`GET /api/headless/a2ui/hearing`(envelope `{a2ui, actions, input}`)。manifest に `presence.components.read`・`presence.hearing.view.a2ui`・`presence.hearing.answer / decide / handoff` を追加(write は localadmin + `surface.headless.write`)。
  - 実機(相棒 :3031、Playwright): `/flow/hearing` で部品メニュー → 7 項目を入力バーから回答 → フェーズ進捗が更新 → 「この内容で進める」→ 確定表示と「要件を確定して依頼にする」ボタンまで到達。console error 0、未知型 0。
  - 契約テスト: レジストリ ↔ manifest の operation 突合、投影が `validateA2UIMessage` を通り内部キーを漏らさない、ホスト script に HTML 挿入・内部語・ポート番号が無い。
  - **残件**: AU-04(決定台帳の部品化)、AU-05(承認・進み具合の部品化と重複ページ削除)、AU-06(巨大メッセージ・不正 props の耐性テスト、CSP)、AU-07(外部 A2UI 仕様 adapter)。人の入力は当面ホストの入力バー(§5)。
- 2026-09-15: **方針変更 — ホストを独立パッケージとして新規作成(`presence/displays/a2ui-host/`)**。相棒の HTML に上乗せする形は既存コードに引きずられるため、A2UI を扱うフレームワークを白紙から作り、相棒の `static/a2ui-host.js` は当面そのまま(将来はこの新フレームワークへ寄せる候補)。
  - フレームワーク(`src/framework/`、DOM 非依存で node テスト可): `protocol`(検証)→ `store`(`SurfaceStore`: 適用・履歴・`tree()`、不正メッセージは `rejected` として記録し落とさない)→ `registry`(型 → 描画関数、未知型は placeholder)→ `catalog`(標準 19 種: text / button / card / container / display:hero・section・card・list・kv・progress・alert・badges・status・metric・metrics-row・table・code・timeline・log)→ `renderer`(`DomAdapter` 経由、`children` id 参照と `props.items` インライン両対応、`{ "$ref": "a.b" }` でデータモデル束縛、深さ上限)→ `actions`(`/api/` 相対パスのみ、GET/POST のみ)→ `envelope`(配列 / `{a2ui}` / headless envelope / `{messages}` の吸収)。
  - サーバ(`server.ts`、:3036 loopback): `GET /api/providers`、`GET /api/providers/:id/catalog`(manifest の `a2ui_path` 付きリソース + 任意で `/api/components`)、`/api/providers/:id/proxy/api/...`(登録 provider の `/api/` だけを中継、tenant ヘッダ転送、非 JSON は 502)。CSP `script-src 'self'`、inline script なし。provider は `KYBERION_A2UI_HOST_PROVIDERS`(loopback 限定、env-registry 登録)。
  - ビューワ(`src/app/main.ts` + `static/`): provider ごとの部品・リソース一覧、パス直接読み込み、JSON 貼り付け、自動更新、サーフェスのタブ、入力バー(`input` 宣言時)、インスペクタ(描画結果 / 操作 / データモデル / 部品ツリー / メッセージ履歴)。tsc の出力(`dist/`)を ES module としてそのまま配信、バンドラなし。
  - テスト 28 件(store・protocol・renderer(fake adapter)・actions・envelope・routes(実ポートで proxy / catalog / 拒否系))。ESLint 0 警告。
- 2026-09-15: **読み込みエラーの修正(実機で「読み込めませんでした」だけが出ていた件)**。原因は computer-surface が `a2ui_path` 付きリソースを持たず、状態をスナップショット(`{ surfaces: { id: { catalogId, title, components, data } } }`)で返すこと、およびエラー理由を表示していなかったこと。
  - `envelope`: スナップショット形式(単体 / `surfaces` キー付き)を createSurface / updateComponents / updateDataModel に変換(`snapshotToMessages`)。
  - catalog: manifest の `a2ui_projection: true` な GET 操作もリソースとして列挙(stream 系と、投影済みリソースの query パス変種は除外。無投影リソースの名前・説明を引き継ぐ)。
  - ビューワ: 失敗時に provider・パス・HTTP ステータス・上流のエラー文を表示。A2UI を含まない JSON は「そのまま表示」サーフェス(alert + code)として描画。カタログ由来の読み込みには常に `session` を付与(ヒアリングの 400 を解消)。provider ブロックは並び順固定、空カタログには注記。
  - 実機(Playwright): 両 provider の全ソース 5 件が読み込み成功、console error は「誤った provider にパス直打ち」の 502 のみで、理由が status 行に出る。テスト 30 件。
