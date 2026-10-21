---
title: SSOD HEARING INTEGRATION PLAN 2026 09 14
tags: [improvement-plan, 2026-08, ssod, ssot, hearing, decision, governance, stance, surface]
last_updated: 2026-09-14
status: active
---

# 決定台帳(SSOD)とヒアリング surface の統合計画(SD-00〜SD-07)

> **作成日**: 2026-09-14
> **対象**: (1) テナント配下で検証してきた「決定を正本に置く」仕組み(SSOD = Single Source of Decisions: 実装からの観測 → 提案 → 人の決定 → lock → 実装検査 → PoC 再描画)を、プロダクト側の**器と governed facade**に昇格させる。(2) それを相棒(presence-studio :3031)の**ヒアリングモード**([FRONT_DESK_HEARING_TRAINING_PLAN](./FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md) HT-01〜03)の入口・出口にする。
> **前提**: HT-01〜03 第 1 段(`/ask?mode=hearing`、`HearingRecord`、`POST /api/hearing/:session/decide`、`decided_by = user:<member_id>`)、FD-10(人とエージェントの役割分離、アクター語彙)、[stance-tenant-customer-model](../../../knowledge/product/architecture/stance-tenant-customer-model.md)。**新しい surface は増やさない**。
> **ステータス表記**: 各フェーズ末尾の「実装状況」節に記録(07 月次規約と同一)。

---

## 0. 目的と判断基準

1. **決定は一度だけ、人が、根拠つきで下し、それが実装と PoC に同期する。** ヒアリングで「見て決めた」ことが会話の記録や mission brief の自由文で終わらず、id・根拠・束縛・決定権者を持つ決定レコードとして台帳に残り、後で実装と突合される。
2. **同じループを 2 つ作らない。** ヒアリング(質問 → キャンバス → 充足率 → 決める → mission)と SSOD(観測 → 提案 → 決定 → lock → 検査 → 再描画)は同型である。ヒアリングを SSOD の**入口**、SSOD をヒアリングの**台帳**とし、それぞれの最大の欠落(SSOD: 決定権者の実在化と保存の直結 / ヒアリング: 決めた要件の寿命)を互いに埋める。
3. **決定の出所は tenant と actor で持ち、stance では持たない。** stance は「いま誰として動いているか」の設定であって決定者ではない([stance-tenant-customer-model](../../../knowledge/product/architecture/stance-tenant-customer-model.md))。利用者の顧客が決めた値を、記録者(当社メンバー)が決めたことにしない。
4. [USER_EXPERIENCE_CONTRACT](../../USER_EXPERIENCE_CONTRACT.md) の 4 概念(依頼 / 実行単位 / 成果物 / 次の一手)と FD 計画 §0 の禁止(英語ラベル・ポート番号・内部語を人の画面に出さない)を守る。

## 1. 現状

### 1.1 テナント配下の検証で成立していること(2026-09-04〜09-14)

| 要素                                                                                                          | 実測                                                                                                       | 位置                                  |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 5 種のノード(actor / decision / external / convention / observation)と `why` / `impact` / `ask` の 3 つの問い | 実データで動く。`ask` は「まだ決まっていないもの」を決定権者別に返す                                       | テナント配下 `ssod-tool/`(Python)     |
| 決定の 2 階建て(product-fixed / product-axis / bank-value / undecided)                                        | プロダクトが軸を決め、顧客が値を選ぶ、が実装できる形で表現できた                                           | 同上                                  |
| 決定ループ(observed は機械が実装から抽出・decided は人だけ・lock・CI 検査・PoC 再生成)                        | 実装リポジトリを読んで突合し、決定と食い違う箇所を exit 1 で止める。上流 SSOT の更新を同じ窓口で取り込める | テナント配下 `decision-loop/`(Python) |
| 決定の書込み窓口の検証規則                                                                                    | 台帳に無い項目・根拠なし・同 item/key の active 決定に対する supersedes なし、を拒否                       | 同上 `decide.py`                      |

**欠けているもの**(検証側で明示されたもの): ①決定権者が文字列で実在の人・役割に結び付いていない ②決定の保存が「書き出し → import」の 2 手 ③選べる軸(product-axis)の選択肢が列挙されていないので「選ぶ」体験が無い ④すべて Python の検証コードで、Kyberion の secure-io / tier-guard / facade の外にある。

### 1.2 ヒアリング surface で成立していること(HT-01〜03 第 1 段)

- `HearingScenario`(要件 id・語彙キー・別名)を差し替えられ、会話ターンから要件を埋める純関数と充足率がある(`presence/displays/presence-studio/hearing.ts`)。
- キャンバスは固定テンプレート(`hearing-runtime.ts` の `renderHearingCanvas`)を fallback に、モデル生成 + サニタイズ(`hearing-canvas.ts`)。
- `decide` は全項目回答済みのときだけ、決定者は `HearingDecidedBy`(`kind: 'human'`、メンバー id、owner / approver / viewer)。確定した記録は mission brief に写像して `mission_controller` へ(`hearing-mission.ts`)。
- **欠けているもの**: 記録の置き場が `active/shared/tmp/hearing/`(24 時間 TTL の床)で台帳にならない。決めた要件の下流は brief の自由文。顧客同席時の `on_behalf_of` は未定義。

### 1.3 対応関係

| ヒアリング                       | SSOD                                                  | 備考                                                                 |
| -------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `HearingScenario.requirements[]` | `ask` が返す未決定の decision(提案・undecided)        | **要件 id = 決定 id** にする。これが統合の接点                       |
| 会話ターンで埋まった `answer`    | `proposed`(会話からの観測)                            | 決定ではない。誰が言ったかを `source_turn` で保つ                    |
| `decide`(人)                     | `proposed → decided` の昇格                           | 昇格は level に対する権限で判定する                                  |
| `decided_by`                     | decision の `who` / `approved_by`                     | `on_behalf_of` が入るまで、顧客の決定は decided にしない             |
| キャンバス                       | 決定からの投影(PoC)                                   | SSOD 領域では決定論的レンダラを使い、モデル生成は greenfield のみ    |
| 充足率                           | `ask` の残件数                                        | 同じ数                                                               |
| mission brief                    | 決定の下流の投影                                      | 決定は brief に溶かさず、brief が決定 id を参照する                  |
| Web アプリ要件 7 項目            | `product-concept`(誰のため・何を約束し・何をしないか) | greenfield の出力型を product-concept にすると、後続の決定に根がつく |

## 2. 設計

### 2.1 器と置き場

| もの                                                                                      | 置き場                                                                                                                 | tier / 書き手                                                                                        |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| スキーマ(decision / actor / external / convention / observation / product-concept / lock) | `knowledge/product/schemas/decision-*.schema.json`                                                                     | public。プロダクト                                                                                   |
| モデルと純関数(状態機械、権限判定、突合、投影ブリーフ)                                    | `libs/core/decision-ledger/`                                                                                           | secure-io 経由。テストは hermetic                                                                    |
| governed facade                                                                           | `pnpm decisions <verb>`(`scripts/decisions.ts`。`pnpm organization` と同じ流儀)                                        | 書込みは facade だけ。surface は built subprocess として呼ぶ(`hearing-mission-routes.ts` と同じ境界) |
| テナントの決定台帳                                                                        | `knowledge/confidential/<tenant>/decisions/<case>/`(`decisions.jsonl`・`observed.json`・`lock.json`・`proposals.json`) | confidential。`writeScopedArtifact()` で `artifact_class: decision-ledger`                           |
| 顧客(テナントの顧客)の actor と確認先                                                     | `knowledge/confidential/<tenant>/customers/<customer>/actors.json`                                                     | テナント配下に閉じる(同じ顧客が複数テナントに現れてよい)                                             |
| 会話中の一時状態(未確定の答え・キャンバス版)                                              | 従来どおり `pathResolver.sharedTmp()` 配下の hearing セッション                                                        | 24h TTL でよい。**確定した決定はここに残さない**                                                     |

### 2.2 状態機械と権限

```
observed(実装・材料から機械が抽出) ─┐
                                   ├─▶ proposed(会話の答え・上流の提案) ─▶ decided(人・根拠つき) ─▶ lock ─▶ 検査
enacted(稼働実績=決定があった証拠) ─┘                                        └─▶ rejected
```

昇格 `proposed → decided` の判定は **level × actor**:

| level                                       | 誰が decided にできるか         | ヒアリングでの扱い                                                                                    |
| ------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| product-fixed                               | プロダクト側の owner / approver | メンバーがその場で決められる                                                                          |
| product-axis(軸の宣言・選択肢の列挙)        | プロダクト側の owner / approver | 同上。**選択肢が空の axis は decided にできない**(`axis-without-options`)                             |
| bank-value / customer-value(軸上の値の選択) | テナントの顧客の actor          | メンバーは proposed までしか置けない。顧客の承認証跡(`approved_by`)か `on_behalf_of`(SD-04)で decided |
| undecided                                   | —                               | `ask` の対象。ヒアリングの議題そのもの                                                                |

### 2.3 stance の使いどころ

stance(`customer/{slug}/`・`KYBERION_CUSTOMER`)は決定の出所にしない。使うのは **議題の選択と承認ポリシー**である。

- プロダクト stance で開いたヒアリング: `ask --actor product` = プロダクトが決めるべき undecided / axis を議題にする。
- engagement stance で開いたヒアリング: `ask --actor <customer>` = 顧客に選んでもらう軸の値を議題にする。決定は customer-value として proposed に置く。
- どちらでも記録の tenant は viewer scope から server-side で決まる(`ViewerContext`)。クライアントが送る stance / tenant を authorization にしない。

### 2.4 キャンバス

- SSOD シナリオ(要件 id が決定 id)のキャンバスは、決定と観測から**決定論的に投影**する(`libs/core/decision-ledger/projection.ts` → 意味ブリーフ → `resolveCreativeDesign({surface:'web'})`)。実装との食い違い(conflict / stale)を赤で出し、提案中のものを添える。外部リソースなし・escape 済み・sandbox iframe は HT-02 と同じ。
- greenfield シナリオ(`web_app_build` など)は従来のモデル生成のまま。
- 差し込み口は HT-01 のテンプレート fallback と同じ位置(`HearingCanvasGenerationState` に `projected` を足す)。

### 2.5 実装上の原則

- 語彙: SSOD の項目名・決定の題はテナント機密の自由文で、`front_desk:*` 語彙キーにできない。`HearingScenarioRequirement` に `label_source: 'vocabulary' | 'tenant'` を足し、`tenant` のときは値をテナント台帳から引く(i18n ゲートは `vocabulary` のみに掛ける)。画面の骨組みの文言は従来どおり語彙キー。
- 書込みは facade のみ。surface が `withExecutionContext('mission_controller')` に昇格して直接書く既存パターンは、本計画の範囲では **増やさない**(HT-03 残件と同じ方向)。
- ファイルは 1500 行以内(`pnpm check -- --only max-file-lines`)。スキーマは `pnpm check -- --only catalogs` の対象に登録する。
- 検証コード(Python)はプロダクトへ持ち込まない。**振る舞いの正本はテナント配下の実測結果**とし、TypeScript で同じ判定に到達することをテストで固定する(移植の受入条件)。

## 3. フェーズ計画

### SD-00: 器の昇格 — スキーマと `libs/core/decision-ledger/`(P0)

1. `decision-record.schema.json` / `decision-customer-actors` / `decision-observed` / `decision-lock` / `product-concept.schema.json`(actor / external / convention のスキーマは後続) を `knowledge/product/schemas/` に置く(README 同梱、07 規約)。
2. `libs/core/decision-ledger/`: `model.ts`(型・語彙 `LEVELS` / `STATES` / `AUTHORITY`)、`ledger.ts`(append-only の読み書き、supersede、secure-io)、`promote.ts`(状態機械と level × actor の権限判定、純関数)、`conformance.ts`(decided × observed の突合と lock 生成、純関数)。
3. **受入条件**: テナント配下の実測(突合の verdict 分布・拒否される入力の 4 型)を fixture 化し、同じ結果に到達する hermetic テスト。

### SD-01: governed facade `pnpm decisions`(P0)

`ask [--actor]` / `decide --item --key --level --value --by --basis [--supersedes]` / `import <pending.jsonl>` / `check --impl <path>` / `sync --store <path>` / `list`。書込みはすべてここを通す。`decide` は SD-00 の権限判定に従い、権限外の level は `proposed` に置いて理由を返す。テナントは `KYBERION_TENANT` + persona(confidential 書込み規約)。

### SD-02: `ask` → `HearingScenario`(P1)

`buildHearingScenarioFromAsk(askResult, {actor, locale})`: 要件 id = 決定 id、`label_source: 'tenant'`、別名 = 項目ラベル。`/ask?mode=hearing&scenario=decisions-<case>-<actor>` で開く。会話の答えは `answer` → `proposed` へ(`source_turn` を evidence に)。`decide` は SD-01 の `import` を built subprocess で呼ぶ(brief 経由ではなく直接)。決定後、キャンバス・lock・検査が同期して更新される。

### SD-03: greenfield の出力型を product-concept に(P1)

`web_app_build` の 7 項目を `product-concept`(`for_whom` / `problem` / `promises[measured_by]` / `non_goals` / `constraints` / `variability_axes`)に写像し、`decide` で `PC-*` として台帳に置く。mission brief は `PC-*` を参照する(`intent` の自由文に溶かさない)。以後の決定は `bound_to` / `affects` で PC を指せる。

### SD-04: 決定権者の実在化 — `on_behalf_of` と確認先(P1)

`HearingDecidedBy` に `on_behalf_of?: { actor_id, confirm_target?, evidence? }` を足す(FD-10 のアクター語彙)。テナントの顧客の actor は `knowledge/confidential/<tenant>/customers/<customer>/actors.json`。customer-value の decided は、`on_behalf_of` が顧客 actor を指し、かつ evidence(承認記録・回答 id)があるときだけ許す。それ以外は proposed のまま「誰に聞くか」を次の一手に出す。

### SD-05: 投影キャンバス(P2)

`libs/core/decision-ledger/projection.ts`: 決定 + 観測 + 提案 → 意味ブリーフ(項目 / 出所 / 決定権 / カスタマイズ点 / 判定)→ `resolveCreativeDesign` → HTML。`HearingCanvasGenerationState` に `projected` を追加。会話ごとの再描画は決定論的なので非同期待ちが無い。

### SD-06: 実装側の CI ゲート(P2)

`pnpm decisions check --impl <repo>` を、実装リポジトリの CI から呼べる形にする(lock をコミット、exit 1 で停止)。観測の抽出器は実装ごとのプラグイン(`observers/<repo>.ts`)。抽出できない決定は `unprobed` として可視化し、隠さない。

### SD-07: 品質ゲート(各フェーズに並走)

契約テスト(権限 / narrowing / 内部語なし / iframe sandbox / **stance を送っても tenant が変わらない**)、schema の catalogs 検査、Playwright スクリーンショット、`pnpm check` 全ゲート。

## 4. リスクと対応

| リスク                                         | 対応                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 顧客の決定が当社メンバーの決定として記録される | SD-00 の権限判定で customer-value は proposed 止まり。SD-04 まで decided にしない                           |
| stance と actor の混同(3 つの customer)        | 記録の tenant は viewer scope から server-side、stance は議題選択と承認ポリシーのみ(§2.3)。契約テストで固定 |
| 決定が brief の自由文に溶ける                  | 要件 id = 決定 id、brief は id 参照(SD-02 / SD-03)                                                          |
| 確定した決定が TTL の床に残って消える          | 台帳は `writeScopedArtifact()`、tmp には未確定のみ(§2.1)                                                    |
| テナント機密の項目名が語彙ゲートに引っかかる   | `label_source: 'tenant'`(§2.5)                                                                              |
| Python 検証コードの移植で判定がずれる          | 実測結果を fixture にした受入テスト(SD-00 受入条件)                                                         |
| 選べる軸に選択肢が無く「選ぶ」体験が成立しない | `axis-without-options` を decided の拒否条件にし、`ask` が「選択肢を列挙せよ」を先に返す                    |
| 上流 SSOT(他リポジトリ)の版ずれ                | `sync` は決定 id と版を basis に凍結し、同 item/key は supersede で履歴を残す                               |

## 5. 未決事項

- `pnpm decisions` の verb 名と `pnpm organization` / `pnpm project` の語彙整合(FD-10 のアクター語彙とも)。
- 台帳の `artifact_class` 名と lifecycle GC の扱い(決定台帳は GC 対象外にする必要がある)。
- 複数テナントが同じ顧客を持つとき、顧客の actor を `tenant-groups` の shared に上げるかどうか(stance 文書は「意図的に重複させる」を既定としている)。
- 他リポジトリの実装を読む観測器(SD-06)を、Kyberion の sandbox / 承認方針のどこに置くか(read は全 provider 並列で自由、の原則に乗るはず)。
- (解決済 2026-09-30: `decision_ledger` role を導入) 台帳書込みの authority。facade は `knowledge_steward` 役(書込みスコープ `knowledge/`)で書くが、confidential tier の persona は呼び出し側の環境(`KYBERION_PERSONA`)に依存する。専用の authority role(`decision_ledger`)を `role-write-access.json` / `authority-role-index.json` に登録して書込み範囲を `knowledge/confidential/*/decisions/` に絞るかどうか。

## 6. 実装状況

- 2026-09-14: 計画作成。テナント配下の検証(SSOD 5 ノード・決定ループ・上流同期)と HT-01〜03 第 1 段の対応関係を固定し、繋ぐ層(record)と順番(actor を stance より先)を決めた。
- 2026-09-14: **SD-00 / SD-01 実装** — `knowledge/product/schemas/decision-{record,observed,lock,customer-actors}.schema.json` + `product-concept.schema.json`(README-decision-ledger.md 同梱)。`libs/core/decision-ledger/`(`model` 語彙 / `promote` level × actor の状態機械 / `conformance` 突合と lock / `ledger` 追記専用の台帳 I/O / `hearing-scenario` ask ↔ シナリオ / `product-concept`)。`pnpm decisions ask|list|propose|decide|import|check`(`scripts/decisions.ts`。書込みは `knowledge_steward` 役、`--dir` はテスト専用)。受入条件の同値テストは PoC の判定分布(一致 6 / 食い違い 4 / 古い版 1 / 抽出器なし 1 → red)と拒否 4 型を fixture 化(`libs/core/decision-ledger/*.test.ts` 28 件、`scripts/decisions.test.ts` 5 件)。
- 2026-09-14: **SD-02 / SD-03 / SD-04 第 1 段** — `presence/displays/presence-studio/hearing-ledger-routes.ts`: `GET /api/hearing/decisions/agenda?case=&actor=`(ask → シナリオ)と `POST /api/hearing/:session/record-decisions`(答えた要件 → 昇格要求 → `dist/scripts/decisions.js import` を built subprocess で実行。greenfield の `web_app_build` は `PC-*` として同じ台帳へ)。`/answer` は `scenario_ref`(`decisions-<case>-<actor>`)を viewer のテナント台帳から server-side で解決し、`HearingScenarioRequirement.label_source: 'tenant'` + `label_text` でテナント自由文ラベルを語彙ゲートの外に置く(§2.5)。`decided_by.on_behalf_of`(顧客 actor + evidence)を受け、`customer-value` は evidence が無ければ `proposed` のまま「誰に聞くか」を返す。`/ask?scenario=decisions-…` で開き、答えた項目だけ「決める」が押せる。語彙 5 キー追加(`hearing_req_tenant_item` ほか)。
- 2026-09-14: **命名の変更** — コード名を `ssod` から `decision-ledger`(モジュール・スキーマ・型 `Decision*` / `Ledger*`)、facade を `pnpm decisions`、ルートを `/api/hearing/decisions/agenda` と `/record-decisions`、シナリオ id を `decisions-<case>-<actor>` に改めた。SSOD(Single Source of Decisions)は本書の概念名としてのみ残す。人の画面と内部語は「決定台帳 / decisions」で揃える。
- 2026-09-14: **SD-05 / SD-06 / SD-07 実装** — (SD-05) `libs/core/decision-ledger/projection.ts`(台帳・観測・突合結果・会話の答えを行に束ねる純関数)と `hearing-ledger-canvas.ts`(`resolveCreativeDesign` のトークンだけで描く決定論的 HTML)。台帳ヒアリングでは `/answer` と `GET /canvas` がモデル生成を経ずに投影し、`canvas_generation: 'projected'` を返す。生成 HTML はモデル出力用サニタイザの禁止パターンをすべて満たすことをテストで固定。(SD-06) `probes.ts`(宣言的な観測プローブ: file × 正規表現 × capture 種別 7 つ、`stale_if`)、`decision-probes.schema.json`、台帳の `probes.json`、`pnpm decisions probe --impl <repo 内 checkout> [--probes] [--commit]` → `observed.json` → `check`。secure-io の制約でリポジトリ外は読めないため、実装 repo の CI では同じ probes で作った observed を `check --observed` に渡す運用。(SD-07) 契約テスト: `tenant` / `stance` クエリを送っても viewer の server-side tenant が使われる、投影キャンバスがサニタイザ契約を満たす、非台帳シナリオと未スコープ viewer では投影しない。既存の ask.js 内部語ゲートは通過。語彙 13 キー追加。Playwright は本リポジトリに設定が無いため未実施(vitest の契約テストで代替)。
- 2026-09-14: **ハードコードの抽象化** — level × role の権限を `knowledge/product/governance/decision-authority-policy.json`(schema あり・catalog integrity に登録)へ移し、`promote.ts` は policy を引数に取る純関数に。台帳のパス/ファイル名/ID 文法/実行 role を `model.ts` の `DECISION_LEDGER_LAYOUT` / `CASE_ID_PATTERN` / `CUSTOMER_SLUG_PATTERN` / `DECISIONS_SCENARIO_PREFIX` / `DECISION_LEDGER_ROLES` に一元化。投影キャンバスの寸法・書体は `resolveCreativeDesign` の typography roles と spacing steps から導出(数値リテラルなし)。surface の facade パス・tmp 名前空間・タイムアウトは `LEDGER_RUNTIME` に集約。クライアントはシナリオ id の文法を持たず、サーバが `is_ledger` を返す。
- 2026-09-30: **`decision_ledger` authority role 実装(§5 の最終項目を解決)** — 台帳の書込み role を `knowledge_steward`(`knowledge/` 全域)から専用の `decision_ledger` へ。書込み・読取りとも `knowledge/confidential/${KYBERION_TENANT}/decisions/` と `.../customers/` のみ(`security-policy.json` の `authority_role_permissions`、`authority-roles/decision_ledger.json`、`authority-role-index.json`、`role-write-access.json`)。テナント未指定なら grant なし。`pnpm decisions` は `--tenant` を `withExecutionContext` に渡す(`asLedgerWriter`)。presence_studio の子プロセスが引き受けられるよう `role-assumption-policy.json` に追加し、到達性レポートを再生成。`libs/core/decision-ledger/authority-role.test.ts` で自テナント可・他テナント/他パス/テナントなし不可を固定。
- 2026-10-01: **読取り側も `decision_ledger` へ** — `DECISION_LEDGER_ROLES.read` を `decision_ledger` にし、`hearing-ledger-routes.ts` の台帳読取り 3 か所は viewer の server-side テナントを渡して実行。メンバー名簿の参照は台帳データではないため `memberLookup: 'ecosystem_architect'` に分離。他テナントの台帳は読めないことをテストで固定(自テナント内の非台帳パスは analyst ペルソナの既存権限で読めるため、role では絞れない)。到達性レポート再生成済。surface に反映するには `pnpm build` が必要。
- **残件**: SD-06 の観測器を実装リポジトリ側 CI に配る配布形(probes の共有方法)、Playwright スクリーンショット。
