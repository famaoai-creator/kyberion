---
title: FRONT DESK REDESIGN PLAN 2026 09 13
tags: [improvement-plan, 2026-08, surface, ux, tenant, members]
last_updated: 2026-09-13
status: active
---

# フロントデスク再設計計画(FD-00〜FD-10)— 秘書室 + 相棒を「人の動詞 5 つ」のメニューに統合する

> **作成日**: 2026-09-13
> **対象**: `presence/displays/concierge`(秘書室 :3050)と `presence/displays/presence-studio`(相棒 :3031)の人間向け UI 全体、両者が共有するレール、viewer 識別 API、最小限のメンバーモデル、人とエージェント(NHI)の役割・アクター語彙の整合
> **設計原本**: ワイヤーフレーム 9 枚(Claude Design キャンバス「Kyberion フロントデスク再設計」。方向確定後に `docs/assets/surfaces/` へ PNG を書き出して固定する)
> **ステータス表記**: 各フェーズ末尾の「実装状況」節に記録(07 月次規約と同一)
> **前提**: [CONCIERGE_SECRETARY_UX_PLAN](./CONCIERGE_SECRETARY_UX_PLAN_2026-08-02.ja.md)(CS-00〜05 完了)、[SX-08b](./SX-08B_SURFACE_INTENT_CONSOLIDATION_PLAN.ja.md)(意図解釈入口の統合)、[SURFACE_SCOPED_RBAC_AUTHORIZATION_PLAN](./SURFACE_SCOPED_RBAC_AUTHORIZATION_PLAN_2026-08-24.ja.md)(server-side viewer scope)

---

## 0. 目的と判断基準

**人が迷わず使えること**を唯一の基準にする。具体的には:

1. 初見の人が「いま何をすればよいか」を 3 秒で見つけられる(= ホームの 1 文と判断待ち上位 3 件)。
2. メニューは 5 つまで。ラベルは人の動詞。英語ラベル・ポート番号・内部語(mission / ADF / actuator / pipeline / stimuli)は人の画面に出さない([USER_EXPERIENCE_CONTRACT](../../USER_EXPERIENCE_CONTRACT.md) の 4 概念 = 依頼 / 実行単位 / 成果物 / 次の一手 に対応させる)。
3. 同じ機能が 2 か所にない(承認・成果・会話・設定の重複解消)。
4. **surface は増やさない**([SURFACES.md](../../SURFACES.md))。役割分担(秘書室 = 決める・設定、相棒 = ホーム・頼む・進み具合)はそのまま、人からは 1 つのアプリに見せる。
5. **テナントは常に見える**。人は「いまどのテナントを見ていて、そこで自分が何者か」を常に把握できる。
6. すべての書き込みは既存のガバナンス(viewer scope、operation permission、承認フロー、`mission_controller`)を通る。GUI の刷新で統制は緩めない。

## 1. 現状の問題(調査 2026-09-13)

| #   | 問題                                                                                                                                                                                                                                                                                                                                                                | 根拠                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | **メニューがシステム都合**: Companion Hub は Home / Learn / Discover / Work / Connect(英語)。Discover =「Web アプリ要望ヒアリング」、Connect = 別ポートを新規タブで開く                                                                                                                                                                                             | `presence-studio/static/companion-nav.js`, `hub.html`                                                                                      |
| P2  | **`/work` が開発者ダッシュボード**: 音声だけでボタン 4 + セレクト 5、メールにボタン 6、その下に Current Assistant / Tracks / Service Bindings / Mission Seeds / Intent Resolution / OS Control Plane / Observation Audit / Memory Detail など 25 パネルが平置き。[ceo-ux.md](../../../knowledge/product/architecture/ceo-ux.md) §3 が「見せない」と定めたものが露出 | `presence-studio/static/index.html:792-1069`                                                                                               |
| P3  | **二重・三重の重複**: 承認・成果・例外・会話が秘書室と相棒の両方にある。秘書室 Home は統合キューの後に同じ項目を 4 ペインで再表示。設定は `/setup`(8 節)と `/onboarding`(8 ステップ)の 2 系統                                                                                                                                                                       | `concierge/src/app/page.tsx:739-845`, `setup/page.tsx`, `presence-studio/static/onboarding.html`                                           |
| P4  | **文言混在**: 日本語 UI に "Approval Inbox" "Hold To Talk"、ヘッダに "governed voice-channel stimuli"                                                                                                                                                                                                                                                               | `presence-studio/static/index.html:773, 831, 1021`                                                                                         |
| P5  | **「私は誰か・どのテナントか」がどこにも出ない**: `/api/identity` は名前のみ(テナント・役割なし)。`/api/headless/manifest` の `viewer.scope` と `/api/setup` の `tenant` カタログが半分ずつ持ち、統合した応答がない。秘書室に `/api/identity` 自体がない                                                                                                            | `presence-studio/server.ts:109-139`, `presence-studio-runtime-data.ts:1127-1141`, `concierge/src/app/api/setup/route.ts:80-95`             |
| P6  | **人の概念がない**: viewer の principal は合成ラベル(`human:concierge-localadmin` 等)。役割は `readonly` / `localadmin` の 2 つ。テナント側の `assigned_role` は「単一オペレータの役割」で、人→役割→テナントの対応表が存在しない。承認の記録に「誰が」が残らない                                                                                                    | `libs/core/surface-mutation-guard.ts:72-80`, `chronos-access-registry.ts:13`, `knowledge/product/schemas/tenant-profile.schema.json:21-24` |

## 2. 設計

### 2.1 メニュー(両サーフェス共通レール)

| メニュー     | 答える問い        | 中身                                                                                                                                             | 担当サーフェス | 取り込む既存機能                                                                                                     |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **ホーム**   | 今日なにがある?   | ひとことブリーフィング(件数 + おすすめの一手)、入力欄、判断待ち上位 3、進み具合上位                                                              | 相棒           | 秘書室 briefing / queue、相棒 quick-actions / first-run                                                              |
| **頼む**     | 話す・書く        | 会話 1 か所(テキストとマイクは同じ入力欄、ハンズフリー切替はヘッダに 1 つ)、右に「この依頼について」(理解 / 状態 / 判断点 / 成果物)、チップ 4 つ | 相棒           | 音声 4 ボタン + セレクト 3、Conversation、Intent Resolution、Email、Browser Task、Discover、秘書室 conversation dock |
| **決める**   | いま何を判断する? | 1 本のキュー(急ぎ順)。カード = 何を / なぜ / 承認するとどうなる / 根拠。ボタンは種類ごとに最大 3 つ。フィルタ = 種類 × テナント                  | 秘書室         | 秘書室 inquiry-queue + approval / exception ペイン、相棒 Approval Inbox・OS Control Plane・Updates                   |
| **進み具合** | どこまで進んだ?   | 進行中(進捗 + いまやっていること)/ できたもの(開く / 受け取る / 直してもらう)/ 右に詳細(頼んだこと / いま / この先 / 経過)                       | 相棒           | Requested Work・In Progress・Work Detail・Latest Outcomes・Browser、秘書室 outcome feed・request ペイン              |
| **設定**     | ふだんは触らない  | あなたのこと / **組織とメンバー** / サービス連携 / 声と話し方 / 通知 / 拡張機能 / 詳細設定(→ 管制塔リンク)                                       | 秘書室         | `/setup` 8 節、`/onboarding` 8 ステップ、voice selects、Service Bindings                                             |

- 「メールを下書き」「会議を記録」「ブラウザで調べる」「Web アプリの要望をまとめる」は**頼む**の入力欄下のチップ(= 依頼テンプレート)。メニューにはしない。
- 「使い方を見る」(旧 Learn)はレール左下の 1 リンク。
- モバイルは同じ 5 項目の下タブ。
- **人の画面から外すもの**(管制塔 / 監査モニタへ): Current Assistant、Common Requests、Projects、Tracks、Service Bindings、Mission Seeds、Recent Inputs、Intent Resolution 生表示、Observation Audit、Memory Detail、Model Routing、dev panel、Email Triage 生ログ。

### 2.2 テナントの扱い

| 要素           | 仕様                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 表示           | レール上部に「いま見ているテナント · あなたの役割 · N テナント」。モバイルはヘッダ副題。                                                                                                                                                           |
| 切替           | viewer の `tenantSlugs` が 2 つ以上のときだけ切替 UI を出す。**見せる範囲を狭めるだけ**(既存の `?tenant=` narrowing と同じ意味論)。書き込み先テナントは server-side(`KYBERION_TENANT`)のまま変えない。選択は viewer ごとに `localStorage` に保持。 |
| 一覧           | 決める / 進み具合 / できたもの の各項目にテナントのチップ(単一テナント viewer には出さない)。「決める」の集計はテナント横断、フィルタで絞れる。                                                                                                    |
| 判断カード     | 「決める人: あなた(役割)」を表示。承認・却下は item のテナントに対して行う(viewer の閲覧テナントではない)。                                                                                                                                        |
| tier           | tier 名(`public` / `confidential` / `personal` / `shared`)はテナントではない(`RESERVED_SCOPE_NAMES`)。UI に tier 切替は置かない。閲覧役割では個人メモが見えないことを役割説明に書く。                                                              |
| 反映しない概念 | stance(`customer/{slug}/`)は人の画面に出さない。                                                                                                                                                                                                   |

### 2.3 最小限のメンバーモデル(ユーザ管理を「いよいよ」入れる範囲)

**入れる理由**: 判断カードの「誰が決めたか」、レールの「誰として見ているか」、テナント切替の「この人が見られるテナント集合」の 3 つは、人の概念なしには成立しない。既存の合成 principal では 2 人目(アシスタント・監査担当)が現れた瞬間に破綻する。

**入れない範囲**(ロードマップの非目標を維持): IdP / SSO、パスワード、課金連動 ACL、SaaS テナント自動受け入れ。入口は**ローカル自動(loopback = オーナー)か、オーナーが発行するアクセス用トークン**のみ。既存の `chronos-access.json` 登録をそのまま「メンバーの鍵」として使う。

| 要素           | 仕様                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| メンバー登録簿 | `knowledge/personal/members/{member_id}.json`(スキーマ新設): `member_id`、`display_name`、`status`、`memberships[]`(`tenant_slug` × `role`)、`access_registrations[]`(`chronos-access.json` の `label` を参照)。オーナー自身は初回起動時に `my-identity.json` から自動生成。                                                                                                     |
| 役割           | 人向け 3 種: **オーナー**(全部 + メンバー / テナント管理)/ **承認者**(頼む・決める。設定は自分のことだけ)/ **閲覧**(進み具合・できたものの閲覧のみ)。内部対応: オーナー = `localadmin`、閲覧 = `readonly`、承認者 = `localadmin` を `operation permission` で `surface.headless.write` のうち承認系のみに限定(FD-07 で `SurfacePermission` に `surface.decision.write` を追加)。 |
| viewer 解決    | `resolveSurfaceViewerScope` の結果(`principalId`)→ メンバー登録簿の `access_registrations` を逆引きし、`member` を viewer context に付与。未登録 principal は従来どおり合成ラベルで動く(後方互換)。                                                                                                                                                                              |
| 誰が決めたか   | 承認 / 却下 / 受領 / 差し戻しの記録に `decided_by: {member_id, display_name, role}` を残す(既存の audit 経路に追記。無い場合は principalId)。                                                                                                                                                                                                                                    |
| 管理 UI        | 「設定 › 組織とメンバー」: テナント一覧(自分の役割・状態)、メンバー一覧(役割変更・追加)。追加時にアクセス用トークンを 1 回だけ表示。テナント作成は `pnpm tenant create` の facade を叩く(直接ファイルを書かない)。                                                                                                                                                               |
| リモート初回   | 別端末からトークン無しで開いたときは「どなたですか?」画面(トークン貼付 → この鍵で入れる名前・役割・テナントを表示 → 入る)。loopback はこの画面を出さない。                                                                                                                                                                                                                       |

### 2.4 共通 API(両サーフェスが同じ形で返す)

`GET /api/me`(新設。相棒 `/api/identity` と秘書室 `/api/setup` の identity 部分を包含し、後者は互換のため残す):

```json
{
  "member": { "member_id": "famao", "display_name": "…", "source": "loopback" },
  "viewing": { "tenant_slug": "default", "display_name": "自社", "role": "owner" },
  "tenants": [
    { "tenant_slug": "default", "display_name": "自社", "role": "owner", "status": "active" }
  ],
  "write_tenant": "default",
  "available_operations": ["presence.overview.read", "…"],
  "onboarded": true
}
```

`role` は `owner | approver | viewer`。既存の `viewer.scope` は manifest に残す(headless / A2UI 互換)。

### 2.5 人とエージェントの役割(NHI との関係)

**現状(調査 2026-09-13)**: エージェント側は既に耐久的な識別を持つ。人側は持たない。

| 観点               | エージェント(NHI)                                                                                                                                                                                                                                     | 人                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 識別子             | `nhi_id = kyberion://agent/<org>/<slug>`(SPIFFE 型)。`libs/core/agent-identity.ts` の event-sourced 台帳(`active/shared/coordination/identity/agent-identities.jsonl`)。lifecycle = provisioned / active / suspended / retired                        | なし。`accountable_human_id` は自由文字列(既定 `"human:operator"`、`organization-profile.json:13`)。`my-identity.json` は名前のみ                                                   |
| 責任者             | `accountable_human_id` が必須(CO-06)。委譲チェーン(`delegation-chain.ts`)の root は `user:<id>` かオーケストレータ                                                                                                                                    | 参照先の登録簿が無いので、どの人にも解決できない                                                                                                                                    |
| 権限               | authority role(20 種、`governance/authority-roles/*.json`: write_scopes / allowed_actuators / tier_access)+ タスク限定グラント(`task-scoped-grants.ts`、24h 上限)+ KD-05 tier(implementer / explorer / planner)。オーナー権限はワーカーへ投影されない | viewer role = `readonly` / `localadmin` の 2 つ + tenant scope。秘書室は viewer から execution context を導出するが、相棒と手元ミラーは `ecosystem_architect` を固定(viewer 非依存) |
| 信頼               | `agent-policies.yaml` の `agent_tier`(評価される)、`AgentRecord.trustScore`、manifest `trust_required`、`personal/agent-identity.json` の `trust_tier`(自由文字列、どこにも評価されない)— **4 語彙が乖離**                                            | なし                                                                                                                                                                                |
| 監査での姿         | `AuditEntry.agentId` は自由文字列。`actor_type` / `nhi_id` / `on_behalf_of` は無い                                                                                                                                                                    | `decided_by_type: "human"` を要求するスキーマ(publication-approval)はあるが、誰かは残らない。`requested_by` / `approved_by` / `actor_id` が約 10 スキーマで別々に定義               |
| 同一機での共同実行 | co-session の参加者は `<provider>-<pid>`、work-coordination の `actorPeerId` は自由文字列。`KYBERION_NHI_ACTOR=warn`(既定)では未登録アクターも通る                                                                                                    | —                                                                                                                                                                                   |

**設計原則**(本計画で固定する):

1. **アクターは 2 種 + 1**: 人 = **メンバー**(`user:<member_id>`)、エージェント = **NHI**(`nhi_id`)、それ以外 = サービス。監査・依頼・判断の「誰が」はすべて同じ語彙 `actor = { kind: human | agent | service, id, on_behalf_of? }` で書く。既存の `actor_id` / `requested_by` / `approved_by` / `decided_by` はこの語彙への別名として整理し、新しい名前は増やさない。
2. **役割の種類は混ぜない**。人の役割(オーナー / 承認者 / 閲覧、テナント単位)は「この人は何を**決めて**よいか」、エージェントの役割(authority role + グラント)は「このエージェントは何を**書いて**よいか」を表す。エージェントが人の役割を持つことも、人が authority role を直接持つこともない。surface は人の役割から execution context を導出する(オーナー → localadmin 相当、閲覧 → readonly)。相棒・手元ミラーの `ecosystem_architect` 固定は秘書室と同じ viewer 由来に揃える。
3. **すべてのエージェントに責任者となるメンバーがいる**。`accountable_human_id` はメンバー登録簿に解決できる `user:<member_id>` に限定し、既定はオーナー。メンバーを閲覧に降格・停止したとき、その人が責任者のエージェントは「責任者の再指定」を要求する(孤児 NHI 監査 `listOrphanNhiIdentities` を再利用)。
4. **エージェントは人の代わりに動く**。依頼はメンバーが出し、実行はエージェントが担い、判断は人だけが下す。委譲チェーンの root はその依頼を出したメンバー。判断(承認 / 却下 / 受領 / 差し戻し)は `actor.kind = human` のみ許可し、UI の「決める人」とスキーマの `decided_by_type: human` を同じ検査で守る。
5. **信頼語彙は 1 つ**。評価されているのは `agent-policies.yaml` の `agent_tier` だけなので、これを正とし、`personal/agent-identity.json` の `trust_tier` は非推奨(スキーマにフィールドを宣言し、`agent_id → nhi_id` のリンクを持たせる)。`trustScore` / `trust_required` は tier への射影として文書化する。
6. **人の画面での見せ方**: 進み具合の詳細に「担当: <エージェント表示名>(<メンバー名>の代わりに)」、判断カードに「頼んだ人 / 決める人」、設定 › 組織とメンバーに **エージェント一覧**(表示名・責任者・状態・最終稼働。停止 / 退役は既存の governed facade 経由)。`nhi_id` の URI やプロバイダ名は人の画面に出さない(表示名のみ)。

### 2.6 実装上の原則

- ラベルはすべて `user-facing-vocabulary.json` の `concierge` / `presence_studio` ドメイン経由(`t()`)。新規は `front_desk` ドメインを切り、両サーフェスで共有する。
- 共有レールは `libs/` 側の 1 実装(`libs/core/front-desk-nav.ts` + 静的レンダラ)にし、相棒(静的 HTML)と秘書室(Next.js)の両方から同じ定義を読む。現行 `companion-nav.js` は置換対象。
- 相棒 `index.html`(3,857 行)は書き直す。既存の API ルートと `presence-studio-runtime-data.ts` は再利用し、パネル単位で「残す / 移す / 消す」を §2.1 の表で確定してから着手する。
- 色・書体は既存 `design-tokens.css` / `design-system.css` を正とし、新しいトークンを増やさない。
- テスト: 各フェーズで契約テスト(操作の権限、テナント narrowing が widen しないこと、内部語がラベルに出ないこと)を追加。UI スクリーンショットは [local-pads README gallery](../../../scripts/personal-pads/README.md) と同じ Playwright 手順で `docs/assets/surfaces/` に固定する。

## 3. フェーズ計画

ウェーブ制(ファイル所有を分離した並行実装 + レビューゲート)。FD-00 と FD-01 が土台で、FD-02〜06 は土台の上で並行できる。FD-07 は FD-01 と同じファイル群を触るので直列。

### FD-00: 語彙と共有レール(P0)

1. `front_desk` 語彙ドメインを追加(5 メニュー、役割 3 種、判断カードのラベル、ボタン)。`check:catalogs` / pseudo-locale を通す。
2. `libs/core/front-desk-nav.ts`: メニュー定義(id / href / 担当サーフェス / 所要役割)。相棒用静的レンダラと秘書室用 React コンポーネントは同じ定義を読む。
3. 両サーフェスのヘッダを新レールに置換。クロスサーフェス遷移は同タブ(`target="_blank"` 廃止)。ポート番号は `active-surfaces.json` から解決し、ハードコードを消す。

**受け入れ条件**: 両サーフェスで同じレールが出る / ラベルに英語・ポート番号が残っていない(契約テスト)。

### FD-01: `GET /api/me` と viewer への member 付与(P0)

1. `libs/core/front-desk-identity.ts`: `resolveSurfaceViewerScope` + テナント登録簿 + `my-identity.json` から §2.4 の応答を組み立てる。メンバー登録簿がまだ無い段階では `member` を `my-identity` から合成する。
2. 相棒・秘書室の両方に `/api/me` を実装(秘書室は `viewer-context.ts` 経由、相棒は `security.ts` 経由)。`?tenant=` narrowing の意味論は既存のまま。
3. レールの「いま見ているテナント」ブロックをこの API で描画。

**受け入れ条件**: 2 テナントを持つトークンで切替が出る / 1 テナントでは出ない / 切替で widen できない(契約テスト)。

### FD-02: ホーム(相棒 `/`)(P1)

ブリーフィング 1 文(既存 briefing の `sentence_ja` + counts を流用)、入力欄 + チップ 4、判断待ち上位 3(秘書室 queue API を read)、進み具合上位。first-run バナーは「まだ何もない」状態のホーム本文に統合。

### FD-03: 頼む(相棒 `/ask`)(P1)

会話 1 か所。音声の 4 ボタンを「マイク」1 つ + ヘッダのハンズフリー切替に集約(エンジン / デバイス選択は設定へ)。右パネル「この依頼について」は `IntentResolutionContract` から 4 項目(理解 / 状態 / 判断点 / 成果物)に整形して描画(SX-08b の描画経路と共有)。メール・ブラウザ・議事録・要望ヒアリングは依頼テンプレート(チップ)として同じ入力欄に流す。

### FD-04: 決める(秘書室 `/`)(P1)

統合キューを唯一の表示にし、4 ペインの重複を削除。カードを種類別に整形(承認 = 承認する / 却下 / あとで、例外 = 対応する / あとで、停滞 = 続ける / いったん終了 / 担当を変える、記憶 = 覚える / 忘れる)。フィルタ = 種類 × テナント。「決める人」表示。判断は既存の guarded API(`/api/hygiene/[id]`、`/api/outcomes/[id]`、approval decision)をそのまま呼ぶ。

### FD-05: 進み具合(相棒 `/progress`)(P1)

進行中(task session + browser task)/ できたもの(outcome feed。開く = `/api/outcomes/[id]/preview`、受け取る / 直してもらう = 既存 verdict API)/ 右パネル(Work Detail の 4 項目化 + 経過)。「手元の画面を見る」は手元ミラーへの 1 リンク。

### FD-06: 設定(秘書室 `/settings`)(P2)

`/setup` と相棒 `/onboarding` を 1 つに統合(初回だけ順番に出す = 同じセクションを「未完了のものから順に」並べる)。詳細設定(governance / operations / モデル)は 1 カードにまとめ、管制塔へリンク。相棒 `/onboarding` は `/settings` へ redirect。

### FD-07: メンバーモデル(P2、FD-01 の後に直列)

1. `member-profile.schema.json` + `libs/core/member-registry.ts`(read / write / list、`ensureOwnerMember`)。
2. `chronos-access.json` 登録に `member_id` を持たせ、`resolveSurfaceViewerScope` の結果から member を逆引き。
3. `SurfacePermission` に `surface.decision.write` を追加し、承認者役割を定義。`ROLE_TIER_ACCESS` は変更しない。
4. 承認 / 却下 / 受領 / 差し戻しの記録に `decided_by` を追記。
5. 「設定 › 組織とメンバー」UI + リモート初回画面。トークン発行は既存の access 登録 facade を使う。
6. ロードマップの非目標を更新: 「hosted user management は非目標のまま。self-hosted の**最小メンバー登録簿(ローカル + トークン、SSO なし)**は本計画で採用」。
7. メンバー登録簿を workforce resource(`workforce-resource-ref.schema.json` の `resource_type: human`)として読めるようにし、`accountable_human_id` の解決先にする(§2.5 原則 3)。

### FD-08: 開発者パネルの移設と旧 UI の削除(P2)

§2.1 の「外すもの」を管制塔の既存スコープ(operations / governance)へ移し、相棒 `index.html` の該当パネルと `hub.html` / `learn.html` / `discover.html` / `companion-nav.js` を削除。`/learn` の内容は「使い方を見る」(1 ページ)へ、`/discover` は依頼テンプレートへ。SURFACES.md の Companion Hub 節を書き換える。

### FD-09: 品質ゲート(各フェーズに並走)

契約テスト(権限 / narrowing / 内部語なし / i18n 全ラベル `t()` 経由)、Playwright スクリーンショットの固定、`pnpm check:catalogs`、CI 全緑。最終レビューで [ceo-ux.md](../../../knowledge/product/architecture/ceo-ux.md) §3 の「見せないもの」が人の画面に 0 件であることを確認。

### FD-10: アクター語彙の統一と NHI 連結(P2、FD-07 の後に直列)

§2.5 の原則を機構に落とす。人の画面の変更は小さく、台帳とスキーマの整合が主。

1. `libs/core/actor.ts`: `actor = { kind, id, on_behalf_of? }` の型と正規化(`user:<member_id>` / `nhi_id` / `service:<id>`)。`AuditEntry` に `actor` を**追加**(既存 `agentId` は残す。additive)。判断系の記録(`decided_by`)はこの型を使い、`kind = human` を検査で強制。
2. `personal-agent-identity.schema.json` にフィールド(`agent_id`、`nhi_id`、`trust_tier` = deprecated)を宣言し、onboarding の書き込みを検証する。`agent_id → nhi_id` のリンクを `ensureAgentIdentityProvisioned` 経由で張る。
3. 相棒(`server.ts` の `/api/identity` 等)と手元ミラーの execution context を viewer 由来に変更(秘書室 `concierge_localadmin | concierge_operator` と同じ形)。
4. 設定 › 組織とメンバーに「エージェント」一覧(`listAgentIdentities` の読み取り投影。停止 / 退役は既存 facade)。責任者の再指定 UI は孤児 NHI 監査の結果から出す。
5. `KYBERION_NHI_ACTOR` の既定を `warn` から `enforce` へ上げる条件(未登録アクター 0 件が一定期間続く)を運用手順に書く。co-session 参加者 id に `nhi_id` を載せるのは別計画(co-session 側)に委ねる。
6. 小修正: `governance/surfaces/mcp-server-cowork.json:11` の `KYBERION_PERSONA: "sovereign_concierge"` は `Persona` に無く `unknown` に正規化されている。正しい persona(`sovereign`)に直す(独立した 1 コミット)。

**受け入れ条件**: 監査エントリから「人か エージェントか、誰の代わりか」が機械的に答えられる / 責任者不明の NHI が 0 件 / 相棒の書き込みが viewer の役割で拒否される契約テスト。
**非目標**: エージェント個別の資格情報(NHI 計画と同じ)、人の SSO、`trustScore` の再設計。

## 4. リスクと対応

| リスク                                                        | 対応                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 相棒 `index.html` 書き直しで既存 E2E(voice smoke 等)が壊れる  | FD-03 で DOM id を維持するか、smoke パイプラインの selector を同 PR で更新。`pipelines/ui-voice-browser-smoke.json` 系を受け入れ条件に含める |
| メンバー導入で既存の合成 principal 依存(テスト・ログ)が崩れる | 未登録 principal は従来どおり動かす(後方互換)。member 付与は additive                                                                        |
| 「承認者」役割が `localadmin` と等価になり権限が広すぎる      | FD-07 で `surface.decision.write` を切るまでは承認者を作らない(UI 上も 2 役割で出す)                                                         |
| テナント切替が「書き込み先の切替」と誤解される                | 切替 UI の文言を「見せる範囲」に固定し、判断カードに item のテナントを常に出す                                                               |
| メンバー導入で人の役割と authority role が混同される          | §2.5 原則 2 を契約テストで固定(エージェントに人の役割を付与できない / 判断は `actor.kind = human` のみ)                                      |
| 二重実装期間の混乱                                            | 旧 UI はフェーズごとに redirect で閉じ、FD-08 で物理削除。並行期間中は旧 UI にバナーを出す                                                   |

## 5. 実装状況

- 2026-09-13: **FD-00 / FD-01 完了**(ブランチ `agent/front-desk-20260913`)— `front_desk` 語彙ドメイン(19 キー、en/ja + qps-ploc 生成)、`libs/core/front-desk-nav.ts`(5 項目の単一定義、manifest 由来ポート、役割ゲート)、`libs/core/front-desk-identity.ts`(`buildFrontDeskMe` 純関数 + `readFrontDeskMe`。`?tenant=` は狭めるだけ、archived は既定にしない)。相棒: `GET /api/me`・`GET /api/front-desk/nav`(remote token の read 許可リストに追加)、静的レール(`front-desk-rail.js/.css`: デスクトップ左レール / 720px 以下は下タブ)、`/ask` `/progress` `/help` の暫定 302。秘書室: 同 2 ルート、`FrontDeskRail` クライアント部品(ヘッダの nav リンクを置換)、`/settings` → `/setup` 暫定 redirect、⌘K に 5 項目追加。実機確認: 相棒を :3931 で起動し、レール描画(desktop / 400px)、`?tenant=` の非拡大、302 を確認。
  - **判明した前提**: loopback viewer はサーバ側 `KYBERION_TENANT` に束縛される(既存契約)ため、ローカルのオーナーは常に 1 テナント表示になり切替は出ない。複数テナントの閲覧・切替は、複数 `tenant_slugs` を持つ token 登録か FD-07 のメンバー所属(member → tenants)で解決する。
  - **既存の不具合(本計画外、記録のみ)**: 相棒 `index.html:3075` が state 未着時に `state.surfaces` を参照して TypeError、`/api/voice/speech-state` `/api/voice/input-devices` が voice-hub 停止時に 503(コンソールに出る)。FD-02/03 の書き直しで消える。
  - **判明した制約**: `@agent/core/front-desk-nav` は `surface-runtime`(node:fs)を引くためクライアントバンドルに入れられない。クライアント側は JSON(`/api/front-desk/nav`)かサーバ部品からの props で受け取る。
- 2026-09-13: **取り込み** — `fix/personal-workbench-governance` の秘書室側(`POST /api/oauth/begin`、`/setup` のサービス接続 UI、語彙 5 キー)を本ブランチへ移植。同ブランチの Companion Hub(hub / learn / discover)は FD-02〜05 で置き換えるため取り込まない。移植時に 2 点修正: lib への相対 import が 1 階層不足(元ブランチは未ビルド)、コールバック受け口の起動を `child_process.spawn` 直呼びから `surface_runtime start --surface oauth-callback-surface`(health 確認後)へ変更(プロセス境界契約)。
- 2026-09-13: **FD-02 完了** — 相棒 `/` がホーム(ブリーフィング 1 文 + おすすめの一手 / 入力欄 + チップ 4 / 判断待ち上位 3 / 進み具合上位)。`GET /api/home` は既存パネルと同じ読み取り元(承認待ち、保留中の OS 操作、presence タスクセッション、成果物レコード)を `presenceStudioRecordInScope` で絞る純関数 `buildHomePayload`。旧ワークベンチは `/work` へ(内容は未変更)。**判明**: この surface には例外・停滞・記憶の判断項目の読み取り元が無い(秘書室側にある)。成果物の「受領済み」状態も無いため、できたものは成果物レコード全件。
- 2026-09-13: **FD-04 完了** — 秘書室 `/` が「決める」(1 本のキュー、種類フィルタ、種類別の 3 ボタン、`あとで` はクライアント側の退避、決める人の表示、承認の期限)。重複 4 ペインとブリーフィングを削除。**判明**: キュー項目はテナント slug を持たない(`ceo-surface-summary.ts`)のでテナントフィルタは出せない。「承認するとどうなるか / 選べること」に相当する項目フィールドが無く、当面「なぜ判断が必要か」のみ表示。例外項目にサービス種別が無く `設定で再接続する` は出せない。成果物の「差し戻す」は理由付きの「直してもらう」に統合。
- 2026-09-13: **FD-05 完了** — 相棒 `/progress`(進行中 / できたもの / 終わったもの、詳細パネル、手元ミラーへのリンクは manifest 由来)。`POST /api/outcomes/:id/verdict`(localadmin のみ)は成果物レコードと deliverable inbox をパス一致で結び付けられた項目にだけ出す(id 空間が別)。**未決(要判断)**: この書き込みは `security-policy.json` の `authority_role_permissions.surface_runtime.allow_write` に `active/shared/inbox/` が無いため `POLICY_VIOLATION` で fail-closed する。宣言的な `authority-roles/surface_runtime.json` は `communication_surface` スコープで許可しており、2 つのガバナンス定義が乖離している。秘書室の同等ルートは `MISSION_ROLE` 未設定の既定 persona で動いているだけ。人の判断(受領 / 差し戻し)をどの authority role で実行するかを決めてから policy を揃える(FD-10 のアクター語彙と同じ論点)。「止める」はタスクセッションの中止 API が無いため未提供、「ひとこと伝える」は `/work` の会話欄への暫定リンク。
- 2026-09-13: **FD-06 完了** — 秘書室 `/settings`(左サブナビ 7 節 / 既存 8 ペインはアンカー id を保ったまま移設 / 組織とメンバーはテナント一覧 + メンバーは FD-07 待ち / 詳細設定は折りたたみ + 管制塔リンクは manifest 由来)。`/setup` は `/settings` へ redirect(hash 維持)。相棒 `/onboarding` は秘書室 `/settings` へ 302。修正: `/api/setup` の応答検証が空文字のプロフィールを弾き初回状態で失敗していた。判断: テナント編集欄は同一 POST で保存されるため詳細設定側に残置。
- 2026-09-14: **FD-03 完了** — 相棒 `/ask`(テキストとマイクが同じ入力欄、ハンズフリー切替はヘッダ 1 つ、UX 契約 shape チップと quick reply、「この依頼について」4 項目、最近の依頼)。`POST /api/conversation` は秘書室 `/api/message` の Node 移植(voice-hub → orchestrator → `unavailable` を正直に返す、UX 契約の検査と修復、localadmin のみ)。実機確認: stub backend で clarification shape の一往復。音声の設定セレクト(TTS/STT/デバイス/モード)は `/work` に残置(声と話し方への移設は FD-08/09 で判断)。**仕上げ項目(FD-09)**: 「理解したこと」「いまの状態」に `normalized_intent` / `resolution_shape` の内部 ID がそのまま出るので、語彙カタログで人向けの表記に変換する。
- 2026-09-14: **FD-07 完了** — `member-profile.schema.json` + `libs/core/member-registry.ts`(`knowledge/personal/members/{member_id}.json`: memberships[tenant × owner/approver/viewer]、access_registrations[label])。オーナーは初回の loopback `/api/me` で `my-identity.json` から冪等に自動登録。アクセストークン登録に `member_id`、`issueChronosAccessToken`(ハッシュのみ保存、平文は 1 回だけ返す)。`libs/core/front-desk-roles.ts` が人の役割 → server role + permission の唯一の対応(承認者 = `localadmin` + `surface.decision.write` のみ。明示 permission は role 既定を**置き換える**。既存呼び出しに明示 permission は無かった)。`/api/me` は `member.registered` と所属ベースのテナント役割(token viewer は所属分のみ)。秘書室の承認・成果物の判断に `decided_by = user:<member_id>` を既存メタデータ経由で記録。設定 › 組織とメンバーにメンバー一覧 / 役割変更 / 停止 / 追加(トークン 1 回表示)、`/signin`。**既存バグ修正**: `chronos-access.json` の存在確認が未仲介の機密パス読み取り、秘書室が実行コンテキスト外で登録簿を読んでいたため、bearer token viewer が常に拒否されていた。**FD-10 送り**: 停滞・記憶の判断は `mission_controller` CLI 経由(`--note` のみ)で `decided_by` の受け口が無い。FD-07 項目 7(メンバー登録簿を workforce resource として `accountable_human_id` の解決先にする)は未着手。
- 2026-09-14: **FD-08 完了** — `/work` から Current Assistant / Common Requests / Projects / Tracks / Service Bindings / Mission Seeds / Recent Inputs / Observation Audit / Memory Detail / Intent Resolution パネル(描画呼び出しは UX 契約テストのため残置)/ A2UI サンドボックス / first-run バナー / タグライン / できることブロックを削除。`/api/surface-agents` は他に参照が無く削除、他のルートは control-plane CLI や Work Detail が参照するため残置。静的 onboarding wizard を削除(`/api/onboarding/*` は秘書室の設定フローが使うため残置)、`/help` は実ページ。SURFACES.md を共有レールの記述に書き換え。`/work` の見出しは `tests/surface-smoke-contract.test.ts` が "Presence Studio" を固定しているため据え置き。
- 2026-09-14: **FD-09(品質ゲート)** — root の vitest 全体: 12,179 pass / 2 fail(`satellites/voice-hub/server.boundary.test.ts` と `chronos-mirror-v2 … share-grants/route.test.ts`。どちらも main checkout で同じく失敗する既存の不整合で、本ブランチは両領域に触れていない)。ギャラリー(`docs/assets/surfaces/presence-studio.jpg` = ホーム、`concierge.jpg` = 決める)を 1600×1000 で再生成し README の説明を更新。修正: 秘書室の承認 `reason` が summary を見ていなかった、ホームのテナントチップが slug 表示かつ単一テナントでも出ていた。
- 2026-09-14: **FD-09 仕上げ** — 「頼む」の 4 項目を人向け表記に(理解したこと = 標準インテントカタログの description、いまの状態 / 会話の shape チップ = `front_desk:shape_*` / `shape_chip_*`、不足入力は slug を語に展開)。既存失敗 2 件をテスト側で修復(voice-hub: ffd6252f5 のインライン化で変数名が変わった文字列固定 / chronos share-grants: vitest 5 の `clearMocks` 既定で import 時の呼び出しが消える → import 直後に回数を捕捉)。
- **残件(次の PR)**: FD-10(アクター語彙・NHI 連結、`decided_by` の停滞・記憶判断への拡張、成果物受領の authority role と `security-policy.json` の整合)、`/work` に残った音声設定セレクトの「声と話し方」への移設、メンバー追加フォームの見た目、ワイヤーフレーム PNG の `docs/assets/surfaces/` への保存。
- 2026-09-13: 計画作成。§2.5(人とエージェントの役割)と FD-10 を同日追記。ワイヤーフレーム 9 枚(メニュー構成 / ホーム / 頼む / 決める / 進み具合 / 設定 / 設定›組織とメンバー / リモートで開いたとき / モバイル)をキャンバスで合意。
