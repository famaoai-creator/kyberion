---
title: Local Pads 統合・永続化・デザイン改善計画
tags: [improvement-plan, local-pads, tenant, tier, ux]
last_updated: 2026-09-15
status: partial
---

# Local Pads を一つの作業場所へ

## 依頼と今回の成果物

毎回 `active/shared/tmp/` を使って個別起動する形から、一つのサーバーとメニューで pad を選び、用途ごとの保存先と履歴を使える形へ移す。Kyberion の tenant・tier を尊重し、画面も洗練する。大きな作業を Luna へ渡せるよう分割した計画を正本として、今回の共通 runtime と主要 pad 導線を実装した。

計画作成時点では未実装だった。今回の実装では、保存・履歴の共通層、8 pad の menu registry、`getMenu` / `getContent` / `getHistory` / `getTop` と action executor の typed seam、単一 localhost server、scope-aware API/UI、legacy handoff の dry-run/apply 移行器、起動導線を追加した。構造化入力・canvas・複数 file preview・ブラウザ連続録音と、managed artifact の保存・hash 検証・履歴復元までを共通 runtime に接続した。Workbench は typed action form、scoped artifact OCR、local-only email draft、approval record 必須の calendar proposal/apply とした。calendar の in-flight/unknown は provider agenda を read-only で照合し、一意一致時だけ確定する reconciliation 導線も追加した。今回さらに、registry の tier 別 storage policy 宣言、未知 policy の fail-closed、旧 8 server から共通 adapter を通す `legacy.ts` compatibility seam、stable handoff projection、Daily の明示的な `period_key`、画像フィールドへ再利用できる `overlay_field` drawing component（paste/drop、pen/eraser、矩形・楕円・線・矢印・テキスト、色、線幅、undo/clear、PNG download）と音声入力を追加した。旧個別 UI の機能を共通 descriptor へ移したことで、pad ごとの server 分岐を増やさず主要操作を維持できる。provider 資格情報を使った実環境 reconciliation の受入と mission_controller の gate 付き運用移行は後続 task とする。複数コンポーネントと権限境界を変更するため、以降の大きな変更は mission_controller の planned 作成、task 計画、宣言された gate の通過を経て実行する。この計画を gate 通過の代替にしない。

## 調査で確認した現状

- `scripts/personal-pads/README.md`: memory-capture / screenshot-annotate / clipboard-inbox / daily-desk / doc-drop / personal-workbench は 8149〜8154 の別サービス。meeting-notepad (8148) と sketch-input (8147) も統合対象とする。report-review は今回の入力 pad 群から除外する。
- `scripts/lib/local-artifact-pad.ts`: scope、request body 制限、handoff/session パス、CSS を共通化済み。単一サーバーのルーター・永続履歴ストアはここにはない。
- `scripts/daily-desk/server.ts`: `defaultDailyDeskOutputDir()` は `sharedTmp('daily-desk')`。working-memory の入力元もあり、出力先だけを変えて完了とはできない。
- `scripts/meeting-notepad/server.ts`: サーバー側 tenant と CLI hint の一致を検証し、session ごとの handoff を保存する。既存の scope 検証と機能を adapter 抽出時に保持する。
- 共通 receipt パスは `active/shared/observability/.../tenants/...`。tenant 別のパスだけで tier・本人の閲覧制限が保証されるわけではない。履歴 API のデータ源として無条件公開しない。
- 既存テストは各 pad の `server.test.ts` と一部の `context.test.ts` にある。新旧双方を回帰検証する。

2026-09-15 の baseline pipeline は完走。ただし report は `needs_attention`、`failed_layer: L5`、`circuit_broken: true`。今回の実装前後で再確認し、実装範囲のチェックは独立して通過した。context ranker は repository scope の public/product を対象とし、個別 tenant データは調査していない。

## 完成時の利用体験

一つの localhost サーバーを一度起動し、左メニューから 8 種の pad を選ぶ。上部に現在の作業先（tenant 名）、公開範囲（tier）、利用者を常時表示する。選択候補はサーバーが許可した範囲だけを返す。起動コマンドは `pnpm pads` を新設する案とし、具体ポートはサービスレジストリとの衝突検査後に固定する。

中央は入力に集中できる編集領域、右側は選択 pad の履歴と詳細。保存時刻・保存状態・保存先の人向け名称を明確にし、技術的なパスは詳細表示へ置く。履歴から内容と添付を再表示し、「コピーして編集」で新しい記録を作る。初期版は明示保存とし、自動保存や原本の上書き編集は別段階にする。

tenant/tier を切り替える際は未保存内容について保存・破棄・キャンセルを選べる。切替完了時には旧 scope の履歴、入力、添付、遅延レスポンスを破棄する。旧内容を新しい scope へ自動で持ち越さない。

## 設計契約

### 単一サーバーと pad adapter

HTTP listener は一つ。各 pad の parse / validate / capture / render を typed adapter として抽出する。メニュー、履歴、保存、scope 認可は共通層が担当する。個別サーバーを裏で 8 個起動する構成にはしない。既存 CLI は移行期間中、同じ adapter を呼ぶ互換入口として残す。

registry は pad ID、表示名、入力 schema、adapter、保存 policy ID を宣言する。保存 policy は version を持ち、保存先解決・容量・保持期間を定義する。任意のブラウザ入力をディレクトリとして受け取らない。通信の body/添付制限、タイムアウト、同時実行数制限も pad ごとに宣言可能とする。

pad 固有の変換・OS 連携・外部効果は `actions` seam に分離する。adapter は `PadActionDescriptor`（id、label、effect、capability）だけを公開し、HTTP は共通の `POST /api/action` dispatcher を通す。dispatcher は viewer/scope の解決、宣言済み action の照合、入力検証、既存 bridge/facade の実行を担当する。action は物理パスやコマンドをブラウザへ返さず、`draft_patch`（入力欄への反映）または認可済みの結果だけを返す。`derive` は下書きへ戻して明示保存、`propose` は承認待ち、`apply` は既存の approval record と payload hash を再検証してから実行する。この境界により、pad を追加しても server/page に pad ID の分岐を増やさずに済む。

### 保存・認可

保存先は `resolvePadStorage(scope, principal, padId, policy)` の一箇所で決定する。物理 root は LP-01 で既存 path-resolver / secure-io / tenant registry の契約に照合して確定し、文字列連結による別体系を作らない。tmp は一時処理専用とし、正式保存と index を janitor 対象外の管理領域に置く。

| tier         | 論理 partition                   | 閲覧条件                           |
| ------------ | -------------------------------- | ---------------------------------- |
| personal     | tenant + owner principal + pad   | 本人と、明示的に許可された主体のみ |
| confidential | tenant + pad（必要なら project） | 当該 tenant 内の許可された主体のみ |
| public       | 明示された public scope + pad    | 公開範囲を確認して保存したもののみ |

tenant と tier は別軸。personal/public を tenant 名にしない。組織・project・mission を持つ場合は canonical typed context に保持する。未指定 tenant を shared にフォールバックしない。tier の暗黙的降格や機密データの public コピーは禁止。

認可はサーバー側 ViewerContext 解決と既存ポリシーを再利用する。参考実装は `presence/displays/chronos-mirror-v2/src/lib/viewer-context.ts`。UI の tenant/tier は narrowing selector に限定し、一覧・件数・検索・詳細・添付・保存すべてで同じ認可を適用する。localStorage の scope や CLI hint を権限根拠にしない。localhost bind に加え、Host/Origin、書き込み token、起動時 principal を検証する。

保存 record は version、record ID、pad ID、owner、typed context、tier、作成時刻、タイトル、artifact manifest、handoff ref、storage policy version を持つ。任意の絶対パスは公開 API に出さない。原本を確定してから index へ反映し、途中失敗・同時保存・二重送信に耐える idempotency と回復規約を定義する。履歴は cursor pagination とし、index は認可済み manifest から再構築可能にする。

添付を含む全 I/O は secure-io。path traversal、symlink escape、壊れた manifest を拒否する。既存 daily-desk の working-memory 読み込みも選択 scope と一致させる。監査ログや receipt に本文・機密タイトルを無条件で複製しない。

### 移行

既存 session/handoff を明示した入力 root から棚卸しする dry-run を用意する。tenant/tier/owner が確認できないデータは移行保留として報告し、推測で public に置かない。初期移行は copy + hash 検証 + index 登録とし、原本は削除しない。同じ入力を再実行しても重複しない。失敗時は新規登録だけを取り消せるようにする。

### デザイン brief

落ち着いた作業机を目指す。ニュートラルな背景、控えめなアクセント、十分な余白、読みやすい日本語タイポグラフィを共通 token に集約する。既存 front desk の共有レールとの整合も確認する。色だけで tenant/tier や保存状態を区別しない。

メニューはアイコンと名称、現在位置を表示。主操作は「保存」、副操作は履歴・添付・受け渡しに整理する。空状態、保存中、保存失敗、権限不足、未設定の保存先それぞれで次の操作を示す。キーボード操作、focus、コントラスト、狭い画面、長い日本語タイトルを検証する。画面試作は semantic brief から行い、受け入れ後に共通 UI へ反映する。

## Luna 向け作業単位

各 task は対象ファイルを先に確認し、最小差分で実装する。原則 1 task ずつ委譲し、共有ファイルの同時編集を避ける。セキュリティ契約の変更は main agent がレビューする。

| ID    | 依存     | 作業範囲・成果物                                                                                     | 完了条件                                                                                             |
| ----- | -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| LP-01 | なし     | 保存 policy / record schema / resolver と認可契約。既存 core の再利用箇所、物理 root、保持期間を確定 | tenant A/B、personal owner A/B、全 tier の許可拒否表と hermetic tests。未知 scope・traversal 拒否    |
| LP-02 | 01       | 永続 record store、添付、index、一覧/詳細取得                                                        | 再起動後に復元、並行保存・二重送信・途中失敗・index 再構築テスト。権限外の件数も漏れない             |
| LP-03 | 01,02    | 共通 HTTP server、registry、memory-capture adapter と互換 CLI                                        | 一つの listener でメニュー、保存、履歴、詳細が HTTP 経由で動作。Origin/token/Host と認可の拒否テスト |
| LP-04 | 03       | clipboard-inbox / daily-desk / personal-workbench adapter                                            | 各既存機能と handoff を維持。daily-desk 入力元の scope 分離をテスト                                  |
| LP-05 | 03       | doc-drop / screenshot-annotate / sketch-input / meeting-notepad adapter                              | 添付・描画・録音等の既存機能、容量・並行制限を維持。旧 CLI テストも通過                              |
| LP-06 | 03       | 共通 shell と history UI、design token、未保存切替                                                   | ブラウザで保存→履歴→再表示→scope 切替を確認。空/失敗/狭幅画面の screenshot evidence                  |
| LP-07 | 02,04,05 | dry-run/copy 移行、サービス登録、起動コマンド、運用 docs                                             | 原本不変、hash 一致、再実行重複なし。不明 scope は保留。停止/再起動/バックアップ手順あり             |
| LP-08 | 全て     | セキュリティ・UX・運用・拡張性の独立レビューと回帰確認                                               | 全 8 pad を単一サーバーで実機確認。境界拒否・再起動・復旧を含む受入証拠、残課題の明記                |

Luna への共通指示例:

> この文書の LP-XX のみを実装してください。依存 task の証拠と対象コードを先に読み、mission owner の task contract 内で作業してください。secure-io と既存認可を再利用し、権限の緩和・推測の scope 補完をしないでください。変更、実行した検証と結果、未解決事項をファイル参照付きで返してください。同じ失敗が二度続いたら、原因仮説と証拠を owner に返してください。

## 検証・引き継ぎ

実装 task ごとに対象の `pnpm exec vitest run <test files>`、統合後に `pnpm run validate` を実行する。ネットワークや個人環境に依存しない fixture を使う。今回の HTTP 実機確認は合成内容で行った。in-app Browser は接続先を返さなかったため、browser-actuator を使って視覚受入を行った。

今回の再確認では `browser-actuator` の `navigation_policy.allow_private_network` を明示して localhost を開き、8 pad の menu、Sketch → Screenshot の実際の切替、Screenshot の image-overlay drawing（矩形・矢印・テキストを含む toolbar、色・線幅・消しゴム・undo/clear、PNG download）、confidential tier への切替後保存、履歴からの再編集、広い viewport と mobile viewport の表示を確認した。空欄 preview の placeholder が残らないことも確認した。証跡は `active/shared/tmp/personal-pads-browser-final-verified-sketch.png`、`active/shared/tmp/personal-pads-browser-final-verified.png`、`active/shared/tmp/personal-pads-browser-final.png`、`active/shared/tmp/personal-pads-browser-meeting-final.png`、`active/shared/tmp/personal-pads-browser-sketch-final.png`、`active/shared/tmp/personal-pads-browser-overlay-menu.png`、`active/shared/tmp/personal-pads-browser-parity-sketch.png`、`active/shared/tmp/personal-pads-browser-parity-screenshot.png`、`active/shared/tmp/personal-pads-browser-final-ui.png`、`active/shared/tmp/personal-pads-browser-history-final.png`、`active/shared/tmp/personal-pads-browser-mobile-final.png`（一時ファイル）に保存した。in-app Browser 自体は接続先を返さなかったため、同経路での手動 screenshot は未取得である。

今回のレビュー引き継ぎ先は LP-08。レビュー観点は物理保存 root、personal の本人境界、既存 ViewerContext の再利用方法、保持期間の既定値、既存 pad 固有機能の互換性。共通 runtime と主要 legacy UI parity の受入証拠は揃っており、資格情報を使う provider reconciliation の実環境受入と正式な mission 運用移行を残課題として明示する。

## 実装状況（2026-09-15）

- 完了: `scripts/personal-pads/registry.ts`、`adapters.ts`、`client-runtime.ts`、`page.ts`、`storage.ts`、`server.ts`、`migrate.ts` と各 focused test。`pnpm pads`、scope 分離保存、履歴 API、tier selector、旧 handoff 棚卸しを提供。
- 完了: メニュー追加は registry + typed adapter（field descriptor / composeCapture）だけで行える。`getMenu` / `getContent` / `getHistory` / `getTop` / `resolveStoragePolicyId` をまとめた `PERSONAL_PADS_SURFACE` seam を公開し、注入した surface contract は HTTP、page、browser runtime まで一貫して使われる。optional `getActionAvailability` / `executeAction` seam で埋め込み host の readiness と action executor も差し替えられる。HTTP、履歴、保存 policy、scope 認可、shell は共通 runtime が担当し、server に pad ごとの分岐を増やさない。
- 完了: protocol service / CLI / README / surfaces の登録と i18n・knowledge index の更新。
- 完了: `scripts/personal-pads/actions.ts` の typed action dispatcher を追加し、Meeting の STT／議事録、Clipboard 読み込み、Daily の owner-bound working-memory 読み込み、Screenshot capture、Workbench の typed actions を共通 `/api/action` へ接続した。action descriptor と handler registry を分離し、dispatcher は scope 検証・宣言照合・同時実行制限・handler lookup に集中する。結果は draft patch として UI に戻り、明示保存を経て immutable record になる。Workbench の proposal／draft 出力も scoped handoff 領域へ書き込む。旧個別 server は互換入口として残る。
- 完了: MediaRecorder の連続録音、複数添付、OS capability readiness、OCR の保存済み artifact-id 化、meeting minutes の要約・未解決事項を履歴へ反映する typed fields を実装した。メールは外部 provider に接続せず local-only draft とし、calendar apply は pending approval を自動昇格せず、in-flight/unknown receipt で重複作成を防ぐ。
- 完了: tier 切替は context 応答が確定するまで editor/save/action/history を停止し、旧 scope の draft を新 tier へ送らない。履歴添付は非同期復元を保存 gate とし、本文編集で未取得 artifact を捨てず、scope/pad 変更時だけ load token で無効化する。capture/history の browser projection と action/HTTP error code から physical path も除外した。
- 完了: 履歴 artifact の復元 token・pending・失敗状態を field 単位で管理し、Meeting の録音と添付、描画 artifact が互いに復元を中断しないようにした。Workbench の action fields も履歴 payload から復元し、再保存時に予定・メール等の入力を失わないようにした。Calendar apply は approval ID の安全な単一 segment、scoped proposal path、proposal binding、approval の requester/scope、payload hash を applied 分岐より前に検証する。
- 完了: calendar の in-flight/unknown proposal に対する provider agenda の read-only reconciliation を追加した。proposal 固有の correlation marker と summary・開始・終了 instant を照合し、0 件または複数件、marker 不在では再作成せず `reconciliation_required` のまま保持し、1 件だけのときに限り applied/completed へ遷移する。apply/reconcile は同じ proposal 単位 lock を共有し、provider エラー時も proposal は unknown のままにする。
- 完了: `scripts/personal-pads/legacy.ts` の共通変換を旧 8 server の capture 入口から呼び、旧 payload（Memory の `now`、Meeting の instruction/attachments、Daily の period など）を同じ typed adapter で正規化する。永続 handoff には旧 follow-up が扱える `compatibility` projection を付与した。旧 UI の画像 paste/drop、描画 shape toolbar、音声入力、PNG download も field descriptor と shared client component へ移し、個別 route の応答形式は互換入口として維持した。移行器は screenshot の session 原本を優先し、clipboard の復元済み本文、meeting minutes の summary/decisions/action_items/open_questions まで canonical payload に戻す。source identity・本文・添付・canonical payload と migration schema revision の組を idempotency key にし、canonical semantics の更新時は古い欠損移行を再実行できるようにした。欠落・unsafe・oversize・過剰添付は成功扱いせず held として理由を報告する。
- 後続: 実際の provider 資格情報を用いた reconciliation の運用受入、mission_controller の onboarding/gate 完了後の正式な運用移行。これは自由な path/action payload を公開しない action seam の後続 task とする。
- 計画全体の受入判定: LP-01〜07 の共通 runtime、legacy parity、移行基盤は完了。LP-08 は今回の browser/HTTP、policy fail-closed、provider fixture、gate 回帰を完了したが、provider 資格情報を使う実環境受入と正式な mission 運用移行を残課題として partial のまま引き継ぐ。
- 完了（実機確認）: browser-actuator の localhost 接続で 8 menu、Memory の入力→保存→履歴→再編集、Workbench の typed action form、mobile viewport の tier 表示を確認した。HTTP では idempotency、owner/tier 境界、calendar pending approval を確認した。in-app Browser は接続先を返さなかった。
- 回帰 gate: unified/core focused 46 tests と legacy-inclusive 117 tests、対象 lint、typecheck、`pnpm run build:repo` は完了。canonical `pnpm run validate` も下記検証記録で完了した。

## 検証記録（2026-09-15）

- `pnpm exec vitest run scripts/personal-pads/*.test.ts scripts/personal-workbench/*.test.ts scripts/{memory-capture,meeting-notepad,sketch-input,clipboard-inbox,daily-desk,doc-drop,screenshot-annotate}/*.test.ts`: **20 files / 117 tests passed**。owner-bound working-memory（明示 period を含む）、複数添付、legacy payload 正規化（空 submit の互換を含む）、legacy handoff 全8形状の本文再構築、session 原本優先、minutes/clipboard の再編集 payload、canonical payload semantics 改訂時の再移行、attachment fingerprint idempotency、欠落添付 held、policy fail-closed、idempotency、handoff、途中 payload の rebuild quarantine、browser history/capture response の path projection、calendar pending approval、marker 付き reconciliation の一意/複数/不一致/marker 不在マッチ、scope 切替中の操作停止と action field/artifact 復元 gate を含む。
- `pnpm exec eslint scripts/personal-pads/*.ts scripts/personal-workbench/actions.ts scripts/personal-workbench/server.test.ts`、`pnpm run typecheck`、`pnpm run build:repo`、`git diff --check`: **passed**。
- `pnpm run validate`: **69/69 gates passed**（build/typecheck を含む）。
- browser-actuator: localhost の一つの listener で 8 menu を確認し、Memory の入力→保存→履歴→再編集、Workbench の typed action form、mobile tier 表示を確認。HTTP の synthetic check で二重送信が同一 record、confidential-bound server の personal 要求が 403、calendar apply が pending のまま外部作成を行わないことを確認した。calendar reconciliation は provider 資格情報なしのため実環境確認を後続へ残す。in-app Browser は利用可能な接続先を返さなかった。
