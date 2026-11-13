# Surfaces — 入口の地図

Kyberion の操作系サーフェスの役割マップ。**各サーフェスは1つの役割**を持ち、画面ヘッダに役割バッジを表示する(定義の正: [`knowledge/product/governance/surface-roles.json`](../knowledge/product/governance/surface-roles.json))。

## まずどれを使う?(単独利用の既定)

単独利用では **concierge(秘書室)** から始める。ホーム・あなた待ち・仕事・組織・資料・運用・設定の 7 項目は、すべてこの 1 つのシェルにある。それ以外は必要になった時の opt-in。

| やりたいこと                             | 入口                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 何を判断すればよいか知りたい・承認したい | **concierge** ホーム `/`・あなた待ち `/inbox` / `pnpm kyberion approvals`                                           |
| 書いて頼みたい、進み具合を見たい         | **concierge** の会話ドック(ヘッダの「秘書に相談」)・仕事 › 依頼 `/work?tab=requests` / `pnpm kyberion ask "<依頼>"` |

| 必要になったら                                   | 入口                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 話して頼みたい・音声/メール/議事録の作業画面     | **presence-studio**(相棒)`/ask`・`/work`                                                             |
| システムの状態を見て介入したい                   | **concierge** の運用 `/ops`(運用コンソール。Discussion / Dialogue Room は `/ops?section=discussion`) |
| 成果物をレビューしたい                           | **concierge** の資料 `/library`                                                                      |
| 何が起きたかを証跡で確認したい                   | **operator-surface**(監査モニタ、読み取り専用)                                                       |
| Kyberion が手元で何をしているか見たい            | **computer-surface**(ミラー)                                                                         |
| お客様に確認・決定をお願いしたい                 | **customer-room**(招待リンクで開くお客様向け画面)                                                    |
| シェルから状態と次の一手を知りたい               | `pnpm kyberion`(統合ホーム)/ `pnpm tui`(常駐 HUD)                                                    |
| 手元の図・メモ・ファイルを取り込みたい           | `pnpm pads`([ローカル pad](#ローカル-pad127001-限定取り込み専用))                                    |
| Slack / Telegram / Discord / iMessage で頼みたい | [会話チャネル](#会話チャネルui以外)                                                                  |

迷ったら `pnpm kyberion setup report --persona first-time-user` が、今の準備状況に合わせて最初の入口を案内する。

## UI サーフェス(`presence/displays/*`)

スクリーンショット付きの一覧は [README の Surfaces](../README.md#surfaces--one-role-per-screen)(画像: `docs/assets/surfaces/`)。

| サーフェス            | 役割                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 答える問い                              | port | 書き込み                                                                            | 起動                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **concierge(秘書室)** | **CEO秘書 + 共通シェル** — レール 7 項目: ホーム `/`、あなた待ち `/inbox`(承認・判断・確認)、仕事 `/work`(ミッション・作業・依頼)、組織 `/org`(目標・プロジェクト・人)、資料 `/library`(成果物・ナレッジ・議事録・取込)、運用 `/ops`(運用コンソール。下記)、設定 `/settings`。ほかに `/first-job`(はじめての仕事)、`/help`(使い方)、`/setup/first-run`(初回セットアップ)、`/management`(組織・プロジェクト管理)。レールの会社スイッチャーが表示を選択した会社(tenant)に絞る。PWA としてインストール可・Web Push 通知(任意) | 「私は今なにを判断すればよいか」        | 3050 | scoped(依頼・承認・受領・取込・プラグイン承認。`/ops` の介入操作は localadmin のみ) | `active-surfaces.json`(`pnpm surfaces reconcile`)                                                                                  |
| **presence-studio**   | **相棒** — 頼む `/ask`(会話・音声)、`/work`(音声・メール・議事録の実行画面)、`/home`(スタジオのホーム)。`/` は concierge へ、`/progress`・`/first-job`・`/help`・`/onboarding` も concierge の該当ページへ 302 で引き継ぐ                                                                                                                                                                                                                                                                                                  | 「いま一緒に何を進めるか」              | 3031 | 実作業                                                                              | `active-surfaces.json`                                                                                                             |
| **chronos-mirror-v2** | **互換リダイレクト**(旧・管制塔)— 運用コンソールは concierge の `/ops`・`/api/ops` へ移設済み。このアプリは古いブックマークとスクリプトのために port 3000 を保持し、`/api/<path>` → `/api/ops/<path>`、`/discussion` → `/ops/discussion`、その他のパス → `/ops` へ 308 で転送する(クエリは保持。`/api/healthz` だけ自分で応答)。ここでは何も認可しない                                                                                                                                                                     | —(転送のみ)                             | 3000 | なし                                                                                | `active-surfaces.json` / `pnpm chronos:dev`(転送アプリの dev サーバー)                                                             |
| **operator-surface**  | **監査モニタ**(読み取り専用: ミッション・監査チェーン・ヘルス)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 「何が起きたかを証跡で確認したい」      | 3331 | なし(inbox既読化のみ例外)                                                           | `pnpm --dir presence/displays/operator-surface dev`(マニフェストには `enabled:false` で登録済み。`reconcile` は起動しない)         |
| **computer-surface**  | **作業の手元ミラー** — ブラウザ/ターミナルのいまの手元を映す                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 「Kyberion はいま手元で何をしているか」 | 3040 | なし                                                                                | `active-surfaces.json`                                                                                                             |
| **customer-room**     | **お客様向けの決定画面** — 招待リンクで開き、確認・決定・コメントを受け付ける。1 プロセス 1 テナント。公開 ingress の後ろに置く前提([README](../presence/displays/customer-room/README.md))                                                                                                                                                                                                                                                                                                                                | 「お客様に何を決めてもらうか」          | 3046 | scoped(お客様の回答のみ)                                                            | 手動: `KYBERION_CUSTOMER_ROOM_TENANT=<slug> node dist/presence/displays/customer-room/server.js`(マニフェストには `enabled:false`) |
| **a2ui-host**         | **A2UI ビューア**(開発者向け)— 任意の A2UI producer のメッセージを読み込み、固定カタログで描画してインスペクタで確認する。loopback 専用([README](../presence/displays/a2ui-host/README.md))                                                                                                                                                                                                                                                                                                                                | 「この A2UI は何を描くか」              | 3036 | なし                                                                                | 手動: `node dist/presence/displays/a2ui-host/server.js`(サーフェス manifest には未登録)                                            |

`presence/displays/terminal-hud` は Web UI ではなくターミナルの TUI(`pnpm tui`。[会話チャネル](#会話チャネルui以外)の表を参照)。

**運用コンソール(concierge `/ops`)**: 旧 Chronos の画面と API は concierge の中の 1 セクションとして動く。`/ops` が描画するのは 4 セクション(`?section=operations` エージェント運用 / `surface-control` 画面の管理 / `diagnostics` 診断 / `discussion` Discussion・Dialogue Room)と `/ops/automation`(スケジュール・パイプライン)。旧セクション(`home` / `missions` / `work-items` / `approvals` / `governance` / `organization` / `deliverables` / `knowledge`)は concierge の該当ページへ 308 で転送される(`presence/displays/concierge/src/lib/ia-routes.ts`)。レールは「運用」を owner にだけ有効にする(`front-desk-nav.ts` の `min_role: owner`。ナビの表示制御であり認可ではない)。認可は `/api/ops/*` がリクエストごとに行う(認証なしの死活確認 `/api/ops/healthz` だけが例外): concierge の viewer を解決できなければ 401、読み取りは `readonly` 以上、介入操作は `localadmin` + concierge の mutation gate(`presence/displays/concierge/src/lib/ops/ops-request-guard.ts`)。例外として `POST /api/ops/knowledge-feedback`(人のフィードバックを 1 件記録する)と `POST /api/ops/plan-preview`(プレビューを計算するだけ)は `readonly` の viewer で通る(cookie セッションの same-origin 確認と tenant budget は同じく適用される)。

### サーフェス登録簿(単一の正本)

port・health path・URL 上書き用 env・運用メモ(vocabulary キー)・復旧コマンドは、サーフェス manifest(`knowledge/product/governance/surfaces/*.json`。`active-surfaces.json` はその互換スナップショット)だけに書く。コードは `resolveSurfaceUrl(id)` / `resolveSurfacePort(id)`(`@agent/core/surface/surface-url`)で解決し、`127.0.0.1:<port>` を直書きしない(`urlEnv` が設定されていればそちらが優先)。`surface-roles.json` の port と `enabled` は manifest と一致させ、manifest にある `presence/displays/*` の UI サーフェスは必ず role を持つ(`tests/surface-registry-consistency.test.ts` が検査する)。

既定で `enabled:false` のサーフェス: 認証情報が必要な `slack-bridge` / `telegram-bridge` / `discord-bridge`、macOS 専用の `imessage-bridge`、および手動起動の `operator-surface` / `customer-room`(3046。公開 ingress の後ろに置くお客様向け画面) / `event-intake-surface`(8791。HMAC 認証の受信イベントで常駐 dot を起こす loopback 専用サービス。source は `event-intake-policy.json` で既定無効、ホストごとに `KYBERION_EVENT_INTAKE_SOURCES` で有効化) / `personal-pads`(8160。旧個別 pad の 8137 / 8147-8154 は登録しない) / `terminal-hud`(ポートなしの TUI)。新規インストールで `pnpm surfaces reconcile` がこれらを起動することはない。必要になったら認証を整えたうえで `pnpm surfaces enable --surface <id>` で有効化する(`pnpm surfaces setup` が無効行にこのコマンドを表示し、`setup-messaging-bridge` テンプレートも slack / imessage で自動実行する)。

### 共有 UI(A2UI kyberion-base)

concierge・presence-studio・operator-surface・computer-surface・customer-room は同じデザイン基盤で描画される(chronos-mirror-v2 は転送のみで画面を持たない): `kyberion-base` A2UI catalog(`ui:*` 型 + JSON Schema props)、トークンから生成する 1 枚の `kyberion-ui.css`、React(`@agent/shared-ui`。Next の concierge / operator-surface)と vanilla DOM(静的 HTML の presence-studio / computer-surface / customer-room)の 2 レンダラ。light/dark・`en`/`ja` すべてに対応する。全コンポーネントは presence-studio の [`/ui-gallery`](http://127.0.0.1:3031/ui-gallery) で一覧確認できる(スクリーンショット: [README](../README.md#shared-ui-a2ui-kyberion-base))。詳細・スキーマ・CSS の正本: [`docs/developer/design/DESIGN_SYSTEM.md`](./developer/design/DESIGN_SYSTEM.md)。

> **アクセス制御**: 各 headless surface は server-side viewer principal を解決し、共通の operation permission と tenant / organization / project / tier scope を評価する。`tenant` query は許可集合を狭めるだけで、権限を拡大しない。運用コンソール(concierge `/api/ops`。旧 Chronos)の `KYBERION_VIEWER_SCOPE=off|warn|enforce` は移行時の監査モード名を保持するが、未認可 tenant の要求は全モードで拒否する(`warn` は audit を先に記録する)。既定値は `warn`。実装計画は [`SURFACE_SCOPED_RBAC_AUTHORIZATION_PLAN_2026-08-24.ja.md`](./developer/improvement-plans-2026-08/SURFACE_SCOPED_RBAC_AUTHORIZATION_PLAN_2026-08-24.ja.md)。これは OSS / self-hosted の内部認可であり、SaaS の hosted account management ではない。運用手順: [`docs/developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md`](./developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md)。

> **ログイン(ブラウザ)**: 認証なしでページを開くと、concierge・presence-studio・operator-surface・computer-surface は共通のログイン画面(`/login`)へ 302 で誘導する(API 呼び出しは 401 JSON)。loopback(同じマシン)からの認証なしアクセスの扱いはサーフェスごとに異なる(下の表)。標準 OIDC(Authorization Code + PKCE。Google / Microsoft Entra 確認済み)でサインインし、署名付き HttpOnly cookie `kyberion_session` を受け取る。cookie に権限は無く、リクエストごとに member registry から範囲を再導出する。IdP アカウントが active な member に紐付いていなければセッションは発行されない。設定と紐付けの手順: [`docs/developer/SURFACE_OIDC_LOGIN_OPERATIONS.ja.md`](./developer/SURFACE_OIDC_LOGIN_OPERATIONS.ja.md)。

| サーフェス                           | 認証なしの loopback アクセス                                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| concierge(`/ops`・`/api/ops` を含む) | 初回セットアップが未完了で、サインインできる owner がまだいない間だけ localadmin(bootstrap)。owner が紐付いた後は loopback でもサインインかトークンが必要(API は 401、ページは `/login`)。自動化向けの抜け道は既定 off の `KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK` |
| presence-studio                      | 常に localadmin(ローカルの持ち主として扱う)                                                                                                                                                                                                                             |
| computer-surface                     | localadmin。`KYBERION_LOCALHOST_AUTOADMIN=false` でトークン必須にできる                                                                                                                                                                                                 |
| operator-surface                     | readonly(読み取りのみ)                                                                                                                                                                                                                                                  |
| chronos-mirror-v2                    | 認可しない(転送のみ。転送先の concierge が判定する)                                                                                                                                                                                                                     |

customer-room は招待リンクのトークンで開き、このログインは使わない。a2ui-host は loopback 専用でログインを持たない。

Computer Surface の `/api/identity`・`/api/state`・`/api/stream`・`/api/os/control-plane` は read operation、`/a2ui/dispatch` は localadmin の write operation とする。remote bearer access は `KYBERION_TENANT` に server-side bind し、内部 A2UI relay は `KYBERION_LOCALADMIN_TOKEN` を使用する。

運用コンソール(concierge)の `/api/ops/headless/a2ui/plugin-views` は承認済みプラグインの宣言的ビュー(EP-05)を返す。`GET` は read operation `chronos.plugin_view.read`(`activatable` かつ内容 digest が承認時と一致する managed プラグインのみ。ロール・tier・tenant は viewer から server-side で評価し、`tier` / `tenant` query は狭めるだけ)、`POST` は localadmin の write operation `chronos.plugin_view.action`(`authority: human` の操作は承認キューに積まれ、`agent` の操作はプラグインがそのプロセスで稼働中の場合のみ実行)。運用コンソールの operator-home 投影の下に「プラグインビュー」として表示する。詳細: [`plugin-permissions-and-views`](../knowledge/product/architecture/plugin-permissions-and-views.md)。

`sandboxed-iframe` ビュー(PH-02)の HTML 文書は `GET /api/ops/headless/a2ui/plugin-views/frame?plugin_id=…&view_id=…` が返す。認可は一覧と同じ(`chronos.plugin_view.read`、viewer から見えないビューは 404、改ざん・未承認のプラグインは 403)で、応答ヘッダは `pluginViewFrameResponseHeaders()` と完全一致(CSP `sandbox allow-scripts; default-src 'none'; …`、`nosniff`、`no-referrer`、`no-store`、CORP `same-origin`、Permissions-Policy 全拒否)。運用コンソールは `<iframe sandbox="allow-scripts">` で埋め込み、postMessage のアクション要求はホストの確認ダイアログを経て既存の `POST` に渡す。`/ops` のページは `frame-src 'self'`。プラグインホスト(PH-01)は `KYBERION_CHRONOS_PLUGIN_HOST`(名前は旧称のまま)で有効化した場合のみ承認済みプラグインを concierge のプロセス内で起動する。

**UI から呼ばない(headless 専用)API**: 運用コンソールの `/api/ops/os/share-grants`(share grant の読み取り)と `/api/ops/headless/*`(`libs/core/surface/headless-surface-contract.ts` が契約を定義する外部・自動化クライアント向けの面。画面が使うのは A2UI 投影の `/api/ops/headless/a2ui/*` だけ)は、画面からは呼ばれない。加えて、呼び出していた画面部品を 2026-11 に削除したため、`GET /api/ops/organization-dashboard`・`GET /api/ops/information-assets`・`GET /api/ops/workspace`・`POST /api/ops/workspace/autonomy`・`GET /api/ops/approvals`・`GET /api/ops/os/control-plane` も現在は画面から呼ばれない(ルートは残している)。画面を持たない呼び出し元(CLI・他ランタイム・自動化)のための API として意図的に残している。同じ viewer / scope 認可が適用される。

presence-studio の `/ui-gallery` は開発者向けのコンポーネントギャラリーであり、共有ナビ(`libs/core/surface/front-desk-nav.ts`)には載せない。presence-studio の `/ask`・`/home` はレールには載らないリンク先(`FRONT_DESK_LINKED_DESTINATIONS`)で、他の画面からのリンクとして解決される。サーフェスをまたぐリンク先 URL は surface manifest(`active-surfaces.json`)のポートまたは `urlEnv` から導出する。

## フロントデスク(共有レール)

レール(メニュー)は 7 項目で、**すべて秘書室(concierge)がホストする**。相棒(presence-studio)も同じ定義から同じレールを描画するので、どちらの画面にいても人には 1 つのメニューに見える(相棒から選ぶと concierge の該当ページへ移動する)。経緯は [FRONT_DESK_REDESIGN_PLAN](./developer/improvement-plans-2026-09/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md)(当初は「人の動詞 5 つ」を 2 サーフェスで分担していた)。

| メニュー       | 答える問い               | パス(concierge) | 最小ロール | 中身                                                                                       |
| -------------- | ------------------------ | --------------- | ---------- | ------------------------------------------------------------------------------------------ |
| **ホーム**     | 全体をひと目で           | `/`             | viewer     | —                                                                                          |
| **あなた待ち** | 承認・判断・確認         | `/inbox`        | approver   | —                                                                                          |
| **仕事**       | ミッションと作業         | `/work`         | viewer     | タブ: ミッション / 作業 `?tab=items` / 依頼 `?tab=requests`(進み具合)                      |
| **組織**       | 目標・プロジェクト・人   | `/org`          | viewer     | タブ: 概要 / プロジェクト `?tab=projects` / 人 `?tab=people`                               |
| **資料**       | 成果物・ナレッジ・取込   | `/library`      | viewer     | タブ: 成果物 / ナレッジ `?tab=knowledge` / 議事録 `?tab=minutes` / 取込 `?tab=ingest`      |
| **運用**       | エージェント・画面・診断 | `/ops`          | owner      | 運用コンソール(エージェント運用 / 画面の管理 / 診断 / ディスカッション、`/ops/automation`) |
| **設定**       | 初期設定と各種設定       | `/settings`     | owner      | レール最下部に固定                                                                         |

最小ロールは member role(`viewer` < `operator` < `approver` < `owner`)で、満たさない項目は `allowed: false` で返る。member に紐付かない viewer は `localadmin` → owner、`readonly` → viewer として扱う。これはメニューの表示制御であり、各ページと API は自分で viewer を再解決して認可する。

レールに載らないリンク先(他の画面から飛ぶ先): 頼む(相棒 `/ask`)、スタジオのホーム(相棒 `/home`)、はじめての仕事(秘書室 `/first-job`)、使い方(秘書室 `/help`。レールのヘルプリンク)、進み具合(秘書室 `/work?tab=requests`)。置き換えられた旧 URL(`/w`、`/w/<kind>`、`/ingest`、`/setup`、`/ops?section=missions` など)は新しいページへ 308 で転送される(`presence/displays/concierge/src/lib/ia-routes.ts`)。

レールの実装は 1 つ(`libs/core/surface/front-desk-nav.ts`)を両サーフェスが読む。ラベル・href・許可(role gate)はすべて各サーフェスの `GET /api/front-desk/nav` から、「私は誰でどのテナントを見ているか」は `GET /api/me` から取得する(`?tenant=` クエリは許可集合を狭めるだけで、絶対に拡大しない)。

写真からのアバター(PA-10): 秘書室「設定 › 写真・音声」で登録済みの写真から表情セットを作る。写真を送る前に送信先プロバイダ名を示す同意ダイアログを出し、生成結果は `avatar/draft/` に置かれ、「このアバターを使う」を選ぶまで今のアバターは変わらない。表情セットは personal tier で、所有者セッション限定の `/api/me/avatar` からだけ配信される。

FD-08 で廃止した旧 Companion Hub(Home / Learn / Discover / Work / Connect の英語 5 項目)の各機能は次に統合された:

- **Learn** → 秘書室 `/help`(使い方を見る)
- **Discover** → 相棒「頼む」ページ(`/ask`)の依頼テンプレートチップ(Web アプリ要望ヒアリング等)
- **Connect** → 秘書室「設定 › サービス連携」
- **Work** → 相棒 `/work`(作業台。旧ダッシュボードの開発者向けパネルは運用コンソール(現在は秘書室 `/ops`)へ移設し、音声・メール・議事録の実行画面だけを残した)

## 会話チャネル(UI以外)

| 入口                                  | 役割                                                                                                                                                                                                                                                                                                                                                                                              | 備考                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack / Telegram / Discord / iMessage | 会話・承認・通知(`runSurfaceMessageConversation` 経由)                                                                                                                                                                                                                                                                                                                                            | Slack の3経路(会話 / 配信 / API)は [SLACK_CHANNEL_ROUTES.ja.md](./SLACK_CHANNEL_ROUTES.ja.md)。`presence:dispatch` の非 Slack 配信は `telegram:` / `discord:` / `imessage:` prefix で同じ satellite outbox へ forward。深い履歴閲覧には不向き |
| Voice(voice-hub / presence-studio)    | ハンズフリー会話・口述。相棒 `/work`・`/ask` と秘書室の会話ドックに口パクするアバター(`ui:talking-avatar`)。ブラウザ再生(`/api/voice/synthesize`)は音量で、ホスト再生は `speech_state` で口を動かす                                                                                                                                                                                               | 一括レビューには不向き                                                                                                                                                                                                                        |
| **`pnpm kyberion`**                   | **ターミナルの統合ホーム**: 状態ダイジェスト+次の一手。`ask "<依頼>"`(ブリッジと同じ脳)、`inbox`(既読/受領)、`approvals`(承認/却下)、`notify`(通知先設定) が同居                                                                                                                                                                                                                                  | 迷ったらまずこれ                                                                                                                                                                                                                              |
| **`pnpm tui`**(terminal-hud)          | **ターミナル常駐 HUD**(Ink TUI): ミッション・work item・ランタイムをパネルで監視/操作、パネル 9「連携」で mission→task→agent→child agent の連携ツリーと待ち関係(承認待ち/子の完了待ち/クレーム待ち/ブロック)を表示([README](../presence/displays/terminal-hud/README.md))                                                                                                                         | 常駐監視向け                                                                                                                                                                                                                                  |
| MCP(mcp-server-cowork)                | Claude Cowork など MCP クライアント向けの MCP サーバー(facade、stdio。base role `sovereign` で起動)。秘書室(concierge)アプリとは別物。**discover** (`capability.*` / `skill.*` / knowledge) · **act** (allowlist pipeline / `service.*` / bounded `actuator.invoke`) · **govern** (mission / approval / audit)。モデル: [mcp-facade-model](../knowledge/product/architecture/mcp-facade-model.md) | `pnpm mcp:server`                                                                                                                                                                                                                             |

**共有 Slack チャンネルの `team` モード**: `KYBERION_SURFACE_CHANNEL_MODES` でチャンネルを `team`(`tenant_slug` / `max_tier` / `approvers`)と宣言すると、@メンションまたは参加済みスレッドにだけ応答し、発話者をメンバー registry で組織メンバーに解決して役割に応じた操作(承認 / 依頼 / 質問)だけを許す。ターンは tenant・tier ごとの tool-less runtime で動き、実作業は tenant スコープのミッション提案を経由する。メモリは `覚えて:` / `remember:` の明示時のみ保存する。

**公開 ingress**: `pnpm kyberion ingress probe` / `ingress status` / `ingress up` / `ingress down` は、manifest の `ingress.allowed` で opt-in した 1 つの loopback サーフェス(例: event-intake は `/events` のみ)を公開 HTTPS URL へ出す(承認済み `ingress:expose` が必要。Tailscale Funnel が最初の実プロバイダ)。

**常駐サービス(UI なし)**: `voice-hub`(3032)、`oauth-callback-surface`(8787。Personal tier の接続へトークン交換を完了する loopback 受信)、`terminal-bridge`(4000)、`nexus-daemon`(刺激ルーティング)。いずれも manifest で有効(`enabled:true`)。

### サテライト(`satellites/`)

会話チャネルと音声のネイティブ側を担う、UI を持たない外部接続コンポーネント。

| サテライト                                                                | 役割                                                                                                                                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack-bridge` / `telegram-bridge` / `discord-bridge` / `imessage-bridge` | 各チャットサービスの ingress/egress(Gateway)。`runSurfaceMessageConversation` 経由で会話・承認・通知を行う                                                                  |
| `voice-hub`                                                               | 音声入出力のハブ(STT/TTS/リスナー)。相棒・秘書室の音声と共通                                                                                                                |
| `fluid-audio-cli`                                                         | macOS 向け Swift 製 FluidAudio STT ブリッジ(`fluidaudio-bridge transcribe`)。`KYBERION_FLUID_AUDIO_STT_COMMAND` から呼ぶ([VOICE_LOCAL_BACKENDS](./VOICE_LOCAL_BACKENDS.md)) |
| `macos-camera`                                                            | macOS のカメラ静止画キャプチャ用 Swift ヘルパー(`swift macos-camera.swift <output_path>`)。現状コードからの参照はなく、手動実行用のスタンドアロンヘルパー                   |

## 会議・議事録

| 入口                                                    | 役割                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm minutes:record --mission <ID>`                    | マイク録音 → 文字起こし → 議事録(`meeting-followup` パイプライン)。presence-studio の「会議を記録」と同じ基盤 |
| `pnpm meeting:participate --driver in-room`             | **同席モード**: ブラウザを使わず、その場の会議にマイク/スピーカーで出席                                       |
| `pnpm meeting:participate`(既定 **browser-playwright**) | Meet/Zoom/Teams への**日常パス**。Playwright でブラウザ出席する。`meeting-browser-driver` が実装済みドライバ  |

**未実装シーム / deferred product (P2-4 docs-only):** `zoom-sdk` と `recall-ai` はドライバレジストリの名前だけ。実装しない。日常は browser-playwright。シームを埋めるな。

## ローカル pad(127.0.0.1 限定・取り込み専用)

手元にあるもの(図・会議メモ・スクリーンショット・ファイル・クリップボード・今日の TODO)を一つの localhost capture desk から取り込み、tenant・tier ごとの管理領域へ保存して履歴を確認できる。`pnpm pads` が一つの listener とメニューを提供する。外部リソース読込ゼロ、ファイル I/O は `secure-io` 経由、mission の自動起動や送信は行わない。スクリーンショット付きの一覧は [README の Local Pads](../README.md#local-pads--capture-at-your-desk-hand-off-to-kyberion)、索引は [`scripts/personal-pads/README.md`](../scripts/personal-pads/README.md)。既存の個別ポートは移行期間の互換入口として残る。全 pad は共通 UI(A2UI `kyberion-base`: `ui:toolbar` / `ui:dialog` / `ui:sketch-board` / `ui:voice-input` など、light/dark、en/ja)で描画され、表示言語はリクエストごとに決まる(`?lang=` → `kb-ui-locale` cookie → `Accept-Language`)。

| pad                                                    | port | 取り込むもの → 出力                                                                                      |
| ------------------------------------------------------ | ---: | -------------------------------------------------------------------------------------------------------- |
| [personal-pads](../scripts/personal-pads/)             | 8160 | 8 種の pad をメニュー選択 → tenant/tier 分離保存 + 認証済み履歴                                          |
| [report-review](../scripts/report-review/)             | 8137 | 任意の自己完結 HTML レポート → 編集・コメント・音声入力・直書き保存                                      |
| [sketch-input](../scripts/sketch-input/)               | 8147 | 描画ボード → PNG + handoff                                                                               |
| [meeting-notepad](../scripts/meeting-notepad/)         | 8148 | メモ・口述・録音・添付 → 議事録 + handoff                                                                |
| [memory-capture](../scripts/memory-capture/)           | 8149 | ブレインダンプ・タグ → 作業記憶 handoff                                                                  |
| [screenshot-annotate](../scripts/screenshot-annotate/) | 8150 | 画像の貼り付け/ドロップ + 注釈 → PNG + handoff(vision 向け)                                              |
| [clipboard-inbox](../scripts/clipboard-inbox/)         | 8151 | クリップボード断片 → inbox handoff                                                                       |
| [daily-desk](../scripts/daily-desk/)                   | 8152 | Journal / TODO / NOW → daily-desk handoff                                                                |
| [doc-drop](../scripts/doc-drop/)                       | 8153 | pdf / 画像 / txt / md / docx のドロップ → ingest handoff                                                 |
| [personal-workbench](../scripts/personal-workbench/)   | 8154 | Link / Task / Follow-up / Decision / Expense / Daily Review の提案 inbox(governed OCR・メール下書きのみ) |

統合入口は `KYBERION_BASE_ROLE=sovereign KYBERION_TENANT=<slug> pnpm pads`（`http://127.0.0.1:8160/`）。既存の個別入口は互換用に `node_modules/.bin/tsx scripts/<pad>/server.ts [--tier …] [port]` で起動できる。`confidential` / `personal` tier は server-side `KYBERION_TENANT` が必須。書き込み API は起動時に表示されるローカルトークンを要求するが、これは人間承認の代替ではない。

Related guidance:

- [`docs/EMAIL_OPERATOR.ja.md`](./EMAIL_OPERATOR.ja.md) — inbox/triage is Gmail/gws (`pnpm kyberion email`); `email-actuator` is delivery-only
- [`docs/OPERATOR_UX_GUIDE.md`](./OPERATOR_UX_GUIDE.md)
- [`knowledge/product/architecture/surface-responsibility-model.md`](../knowledge/product/architecture/surface-responsibility-model.md)
- [`knowledge/product/architecture/ceo-ux.md`](../knowledge/product/architecture/ceo-ux.md)
- [`knowledge/product/architecture/multi-tenant-operations.md`](../knowledge/product/architecture/multi-tenant-operations.md)
- [`docs/developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md`](./developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md)
- [`docs/developer/CLOUD_AGENT_ENVIRONMENT.md`](./developer/CLOUD_AGENT_ENVIRONMENT.md) — Cloud Agent VM: Node `>=24` and `pnpm build` before pipeline / MCP / doctor
