---
title: Kyberion Chrome Browser Bridge Implementation Specification
kind: implementation-specification
scope: tools/adf-replay-extension
authority: proposed
status: draft
owner: ecosystem_architect
reviewed_at: 2026-10-31
tags: [chrome-extension, browser-actuator, pipeline, approval, ux]
---

# Kyberion Chrome Browser Bridge 実装仕様

## 1. 目的と決定

`tools/adf-replay-extension/` のプロトタイプを、Chrome 上で操作を記録・観察し、Kyberion が承認した browser-actuator 相当の操作だけを実行できる **Chrome Browser Bridge** に発展させる。

この拡張は browser-actuator の代替オーケストレータではない。Kyberion が ADF の検証、リスク判定、承認、永続化、証跡を一元管理し、拡張は現在ユーザーが開いている Chrome タブに対する観察・実行アダプタになる。

この分離により、ログイン済み Chrome を利用しながらも、サイトが提示する文章を命令として扱わず、未承認の操作や秘密情報をパイプラインに混入させない。

## 2. 非目標

- browser-actuator の Playwright 実行系、CDP 接続、セッション lease を廃止しない。
- 拡張単体で任意の ADF を貼り付けて即時実行する機能は提供しない。
- パスワード、Cookie、token、WebAuthn credential、フォーム入力値を記録・保存・転送しない。
- 決済、送信、削除、権限変更などを拡張の判定だけで自動実行しない。

## 3. 利用者体験

ポップアップは短時間で閉じるため、通常操作は Side Panel に移す。ポップアップは Side Panel を開く入口だけにする。

| 状態      | 利用者に見せるもの                                                  | 実行可能な操作                     |
| --------- | ------------------------------------------------------------------- | ---------------------------------- |
| 接続前    | 「このタブを接続」ボタン、対象 origin、権限説明                     | 接続、読み取り専用の観察           |
| 観察中    | URL、タブ名、抽出範囲、ページから受け取った外部命令を信用しない注意 | snapshot、要素選択、記録開始       |
| 記録中    | 録画中表示、操作数、秘密入力を除外したこと、停止ボタン              | 記録停止、一時停止、直前操作の破棄 |
| レビュー  | 人間が読める操作文、対象、変数候補、リスク、差分                    | 操作編集、削除、変数化、下書き提出 |
| 承認待ち  | 実行対象、影響、承認者、期限                                        | 承認要求の送信、取り消し           |
| 実行中    | 現在の手順、対象 tab、停止、証跡の要約                              | 停止、緊急切断                     |
| 完了/失敗 | 成功条件、検証結果、redaction 済み receipt、次の選択肢              | パイプラインへ保存、再レビュー     |

操作ラベルは `click_ref` や CSS selector を前面に出さない。例として `「請求書を作成」を選択`、`会社名を入力（値は保存しない）` のように、目的と影響を日本語で表示する。詳細ビューでのみ ref、locator 候補、検証結果を確認できる。

## 4. 境界アーキテクチャ

```text
Side Panel / Popup
        |
Chrome Extension (observe, record, render approved progress)
        | Native Messaging: local-only, authenticated
Kyberion Browser Bridge service
        | validated request / receipt
browser-actuator + approval policy + mission trace
        |
pipeline / mission evidence / governed knowledge
```

### 4.1 所有権

| 責務                                      | 所有者                               |
| ----------------------------------------- | ------------------------------------ |
| Chrome tab の DOM 観察・操作              | 拡張 content script                  |
| 表示、ローカル一時状態、停止              | Side Panel / service worker          |
| ADF / recording の schema 検証と compiler | Kyberion Browser Bridge service      |
| capability、origin scope、期限の検証      | Kyberion Browser Bridge service      |
| リスク分類と承認状態                      | Kyberion approval policy             |
| secret binding、redaction、永続化         | Kyberion secret/secure-io 境界       |
| trace、receipt、mission evidence          | browser-actuator / mission lifecycle |

### 4.2 接続方式

V1 は Native Messaging のみを採用する。ローカル loopback HTTP、任意 WebSocket、外部 SaaS への直接通信は採用しない。Native host 名は `com.kyberion.browser_bridge` とし、Chrome extension ID を allowlist する。

ページ構造解析の CLI への受け渡し（`pnpm kyberion browser inspect --mode extension`）も Native Messaging で行う。CLI は選んだ区分（`--tier personal|confidential|public`、confidential は `--tenant` 必須）の staging 区画（`active/shared/staging/<tier>/<tenant|shared>/browser-inspection/`）に有効期限つきの待機チケットを置き、6 文字の **ペアリングコード** を表示する（チケットにはコードの digest だけを保存し、ポートは開かない）。任意で `--origin <origin>` を付けると、その origin 以外の解析結果を host が拒否する。利用者は Live タブでコードを入力して「Kyberion CLIへ送信」を押す。service worker は接続中タブ（未接続なら拒否）を解析し直して PII 除去し、`submit_inspection`（`pairing_code` 付き）を native host へ送る。host は検証・上限適用・再 redaction（入力値は受け取らない、URL のクエリと fragment は落とす、64 KiB 上限）をして、**コードが一致する待機チケット 1 件だけ** に書き込む。「最も新しいチケット」への自動配送はしないため、別テナントや下位区分へ解析結果が流れることはない。コードなしは `pairing_code_required`、不一致は `pairing_mismatch`、待機なしは `no_waiting_cli`、同じコードのチケットが複数ある場合は `ambiguous_waiting_cli`、origin 固定に反する場合は `origin_mismatch` で拒否し、いずれも監査に記録する。confidential 区分では監査記録を書けない場合、チケットを作らず・書き込まず（`audit_unavailable`）に止める。有効期限の判定はチケットごとのロック内で現在時刻を取り直し、CLI のタイムアウト時もロック内で読み直して、締め切り直前に届いた結果は捨てずに返す。CLI は自分のチケットを読んで削除する（実装: `scripts/lib/browser-inspection-handoff.ts`）。

**例外（別拡張）**: `tools/meet-copilot-extension` は本仕様の対象外で、`ws://127.0.0.1:8779` の loopback WebSocket を使う。会議ドライバ（`libs/core/browser/chrome-extension-meeting-driver.ts`）は長時間動く Kyberion プロセス側がサーバーとなり、字幕・画面フレームの連続イベントと join / mute / leave などのコマンドを双方向に流す必要がある。Native Messaging の host は Chrome が接続ごとに起動する短命の stdio プロセスで、既存の Kyberion プロセスから拡張へ能動的に送れないため、この用途には合わない。代わりに loopback 限定とし、ドライバは `--extension-ws-host` に loopback 以外（127.0.0.0/8・`::1`・`localhost` 以外）が渡されると起動を拒否する（`MEET_EXTENSION_WS_HOST_NOT_LOOPBACK`）。hello で 32 文字以上の共有トークン（`meetCopilotAuthToken`）を照合し、認証前のメッセージは受け付けない。この例外は会議ドライバに限り、Browser Bridge（本拡張）は loopback HTTP / WebSocket を使わない。

### 4.3 Kyberion から拡張への依頼（pull mailbox）

Kyberion から拡張への方向も Native Messaging だけで行う。拡張が native host に問い合わせ（`poll_requests`）、host が統制された runtime store（`libs/core/browser/browser-bridge-mailbox.ts`）を読む **pull 型の受信箱** とする。拡張は待ち受けポートを開かない。

| 項目           | 規則                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 問い合わせ間隔 | `chrome.alarms` で 1 分ごと（Chrome の最小間隔）。Side Panel が `sidepanel` ポートで接続している間だけ 5 秒ごと。                                                                                                                                                                                                                                                            |
| 保持           | 受信した依頼は `chrome.storage.session` に置き、ブラウザ終了で破棄する。期限（`expires_at`）を過ぎた依頼は手元で消し、応答しない。                                                                                                                                                                                                                                           |
| 通知           | 拡張アイコンのバッジに要対応件数（ページ観測・ローカル推論・承認待ち通知）。新しいページ観測の依頼と承認待ちだけ Chrome 通知を出す（同じ依頼で 2 回出さない）。                                                                                                                                                                                                              |
| `observe_tab`  | 受信タブで「許可して応答」を押したときだけ応答する。対象は Live タブで接続中の現在タブ（http(s)）だけで、`allowed_origins` があればその origin に限る。観測は既存の PII 除去済み抽出（AI 要約用本文 / ページ構造解析）から作り、`browser-observation.v1`（`procedure_id: browser-bridge-observe`、`recording_id: <request_id>`、`lease_id: LEASE-<request_id>`）として返す。 |
| `local_infer`  | Side Panel で Chrome 内蔵 AI（`KyberionBuiltInAI.runLocalTask`）を実行し、結果（`executable: false`）を返す。既定はクリックが必要。セッション単位の「ローカル推論依頼を自動応答」（既定オフ、`local_infer` だけ）で自動応答できる。内蔵 AI が使えない場合は `failed` で理由を返す。                                                                                          |
| `notify`       | 情報・進捗は「確認」で既読応答する。承認待ちは表示だけで、承認コマンド（`pnpm kyberion approvals --approve <id>`）のコピーを出す。拡張に承認ボタンは置かない。                                                                                                                                                                                                               |
| 応答サイズ     | 1 応答 64 KiB 以内。観測本文は上限内に収まるよう切り詰める。                                                                                                                                                                                                                                                                                                                 |

ページからの送信（B3）は Side Panel の送信タブまたは右クリックの「Kyberion に送る」から行う。右クリックは送信フォームに下書きを入れるだけで、自動では送らない。送信方法（intent / knowledge）、保存先の区分（personal が既定、confidential はテナント slug 必須、public は明示確認必須）を選び、PII 除去済みの本文を `send_page` で渡す。

WebMCP（B5）は読み取りだけを行う。ページの MAIN world で `navigator.modelContextTesting?.listTools()` / `navigator.modelContext` を読み、ツール名・説明・入力スキーマの最上位キーだけ（50 件まで）を取り出し、拡張側で PII 除去してから Live タブに表示し、`observe_tab` の応答に `webmcp_tools` として添える。ツールは呼び出さない。

### 4.4 Execution lease

起動時に service は短命の `execution_lease` を発行する。lease には `mission_id`、`pipeline_id`、`tab_id`、許可 origin、許可 operation、承認済み step hash、発行時刻、有効期限を含める。拡張は lease 範囲外の tab、origin、step を拒否する。ページ遷移、tab 切替、期限切れ、拡張再起動時は lease を失効させる。

## 5. 権限・データ保護

### 5.1 Manifest V3

- 必須権限は `activeTab`、`scripting`、`storage`、`sidePanel`、`nativeMessaging` と、受信箱のための `alarms`（定期問い合わせ）、`contextMenus`（「Kyberion に送る」）、`notifications`（承認待ち・観測依頼の通知）に限定する。host permission は増やさない。
- `tabs` は URL 表示が必要な場合だけ利用し、恒常的な閲覧履歴収集に使わない。
- `host_permissions: ["<all_urls>"]` は削除する。複数 origin の継続利用は `optional_host_permissions` を明示 consent で取得する。
- `externally_connectable`、remote code、eval、任意 URL からの script 読み込みを禁止する。
- `chrome://`、`chrome-extension://`、Chrome Web Store、file URL、incognito は V1 の対象外とし、理由を UI に表示する。

### 5.2 記録規則

記録の一次成果物は ADF ではなく `browser-recording.v1` とする。値を含むイベントは以下のように扱う。

| 入力種別                               | 記録内容                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| password、OTP、token、cookie、WebAuthn | 操作自体を記録しない。秘密入力が省略されたことだけを表示する。                           |
| email、電話、住所、自由入力            | デフォルトでは値を記録しない。`{{input.name}}` の候補と入力項目の意味だけを記録する。    |
| select、checkbox、radio                | 選択肢の表示名と value を別途リスク判定し、初期値は表示名だけを記録する。                |
| ファイル upload / download             | パス・内容を記録しない。ファイル選択または download の intent と承認要否だけを記録する。 |

拡張側の一時状態（接続・記録・下書き・実行進捗）は `chrome.storage.session` に保持し、ブラウザ終了で破棄する（実装は `background.js` の `STATE_KEY`）。`storage.local` への永続保存は行わない。canonical record、証跡、変数定義、receipt は Kyberion 側で tier を指定して保存する。

### 5.3 ページを信頼しない

DOM、ページ本文、ARIA label、ページ内の指示、URL parameter は untrusted data とする。これらは UI 上で「ページ由来」と明示し、承認ポリシー、lease、操作許可リストを変更できない。外部送信や権限昇格を促すページ文言を発見した場合は warning として receipt に残す。

## 6. 操作契約

V1 の実行可能操作は browser-actuator v3 の `snapshot + ref` 方針に合わせる。raw CSS selector は recording の内部候補としてのみ保持し、executor の公開契約には出さない。

| 区分         | V1 操作                                                                                                     | ルール                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 観察         | `snapshot`、`screenshot`、`extract_text_ref`、`list_tabs`                                                   | 読み取り専用。内容は redaction 前に pipeline/LLM へ送らない。                        |
| 低リスク実行 | `open_tab`、`select_tab`、`click_ref`、`fill_ref`、`select_ref`、`press_ref`、`wait_for_ref`                | lease と ref 解決の成功が必須。`fill_ref` は secret ref または明示入力だけを受ける。 |
| 高リスク実行 | `submit_form`、`upload_file`、`download_file`、`delete`、`purchase`、`credential_submit`、`settings_change` | step ごとの明示承認と実行直前の再確認が必須。V1 では generic click に偽装しない。    |
| 非対応       | `evaluate`、任意 JavaScript、raw selector click/fill、passkey credential export                             | 拡張 execution lease では拒否する。Playwright 専用か専用の将来契約へ分離する。       |

各 ref は role、accessible name、可視性、親コンテキスト、snapshot hash を持つ。実行直前に再 snapshot し、対象が変わった、複数候補に増えた、または confidence が閾値未満の場合は停止して利用者に再選択を求める。

## 7. Recording から Pipeline まで

```text
recording.v1
  -> redact + normalize
  -> operator review
  -> validate recording schema
  -> compile candidate browser ADF
  -> schema / policy / capability preflight
  -> approval request (when required)
  -> signed execution lease
  -> extension execution
  -> receipt + verification
  -> optional reusable pipeline proposal
```

### 7.1 中間契約

`browser-recording.v1` は次の情報を必須にする。

- `recording_id`、`created_at`、`source: "chrome-extension"`
- `tab_origin`、開始 URL の origin hash、記録時の browser/session 情報
- redaction 済み action list と各 action の human-readable summary
- locator candidates（公開 ref、内部 locator、confidence、snapshot hash）
- data classification、risk classification、manual-review-required flags
- recording hash、extension version、policy version

compiler は recording を直接実行可能 ADF にしない。`browser-pipeline.schema.json` への変換後に、既存の ADF preflight、approval policy、capability check を実行し、失敗時は candidate としてレビュー画面へ戻す。

### 7.2 Pipeline の接続点

pipeline 上の接続点は、`browser` actuator パイプラインの step `op: "extension_session"` とする（`actuator-op-registry.json` の `browser.apply` に登録）。単独の `browser:extension_session` op ではない点に注意。これは Chrome Extension へ直接命令を送るものではなく、Bridge service に preflight と lease を要求する orchestration step である。

入力は `pipeline_id`、`mission_id`、`allowed_origins`、`mode`、`recording_id` または `compiled_plan_id`、`approval_context`。出力は `browser_session_id`、`lease_id`、`approval_status`、`receipt_ref`。既存の `browser:pipeline` は Playwright execution として維持する。

`recording -> reusable pipeline` は既存の `automate-browser-workflow` テンプレートの crystallization を利用し、生成された pipeline は draft として保存する。人間の review と実行 preflight を通過するまで reusable registry に昇格させない。

## 8. UI 構成

Side Panel は以下の 7 タブで構成する（WAI-ARIA の tabs パターン。矢印キー・Home/End で移動）。

1. **Intent**: やりたいことを入力し、登録済み手順と照合（Pattern B 実行 / Pattern A 記録）。
2. **Live**: 接続状態、tab、Chrome 内蔵 AI の要約、ページ構造解析、このページが公開している AI ツール（WebMCP、読み取りのみ）。
3. **受信**: Kyberion からの依頼（ページ観測・ローカル推論・お知らせ）と承認待ちの一覧。依頼元・種類・目的・対象 origin・残り時間を表示し、「許可して応答」「拒否」を選ぶ。新着は live region で読み上げる。
4. **送信**: ページ本文または選択範囲を intent / knowledge として Kyberion に送る。送る前に PII 除去済みの本文を確認できる。
5. **Record**: 記録開始/停止、除外された秘密入力、操作タイムライン、直前の操作を破棄。
6. **Review**: 人間向け要約、変数化、対象確認、risk badge、生成候補。
7. **Run**: 承認状態、実行 plan、step progress、失敗時の再選択、receipt。

初回導線は「このタブで観察する」だけにし、記録・実行は別の明示操作にする。実行ボタンは、対象 origin、操作件数、承認が必要な件数、期限を一行で確認できる場合だけ有効化する。

アクセシビリティは keyboard 操作、フォーカス移動、状態変化の live region、色だけに依存しない risk 表現、200% zoom を受入条件とする。受信タブの依頼種別・お知らせの区分・承認待ちのリスクは文字で表示する。

### 8.1 Chrome 内蔵 AI

Prompt API（`LanguageModel`）、Summarizer、Translator、LanguageDetector と、利用できる場合だけ Writer / Rewriter / Proofreader を機能検出で使う（`built-in-ai.js`）。ページ由来の文字列はモデルに渡す前と、モデル出力の後の両方で PII 除去する。出力は常に `executable: false` で、操作・承認の判断には使わない。文書系 API は service worker では使えないため、要約・ローカル推論は Side Panel で実行する。

## 9. プロトタイプからの移行

| 現在の実装                           | 問題                                            | 移行先                                                          |
| ------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------- |
| Popup で JSON を貼り付けて Replay    | 意味・影響・承認が見えず、誤実行しやすい        | Side Panel の Review / Run と Bridge 経由の compiled plan       |
| `<all_urls>`                         | 常時の過大な site access                        | `activeTab` と optional host permission                         |
| `chrome.storage.local.lastAdf`       | 秘密値を含む ADF が残り得る                     | redaction 済み短期 draft のみ、canonical 保存は Kyberion        |
| CSS selector / `nth-of-type`         | UI 変更で壊れ、レビュー不能                     | snapshot + ref、内部 locator は再解決のみ                       |
| `fill_ref` が DOM に直接値を書き込む | PII/secret の混入と React 等の互換性リスク      | secret ref / 明示入力、native setter と実行前確認               |
| click を即時 dispatch                | destructive action の保護がない                 | risk classifier、step approval、execution lease                 |
| 任意 ADF の `goto` / click 実行      | schema、capability、origin 制限なし             | Bridge service の preflight 後に限定 execution                  |
| in-memory state のみ                 | service worker 停止で進行状態と停止理由が不明瞭 | resumable session summary、lease 再検証、明示的な aborted state |

## 10. 実装フェーズと受入条件

> **実装状況（2026-06-23 時点）**
>
> - Phase 0–1: ✅ 完了（3 schema + op registry + preflight、最小権限 manifest、record-only、値・秘密・contenteditable 本文・raw selector を非記録）
> - Phase 2: ✅ 完了（Native Messaging host `scripts/browser_bridge_host.ts` + `native-host/`、recording→pipeline candidate compile）
> - Phase 3: ✅ 完了（高リスク op を approval-gate に接続、execution lease 発行、再 snapshot + ambiguity 停止の executor、receipt 生成/検証）
> - Phase 4: 🟡 一部完了（recording→draft pipeline crystallization `compileBrowserRecordingToPipeline` + schema 適合テスト、実行フロー回帰テスト、lease 期限切れ回帰、a11y 構造テストを追加。Chrome 実機 E2E の CI 化は未着手）
>
> Phase 3 の DOM 実行は Native Messaging host を登録した環境でのみ有効化される（未登録時は `bridgeAvailable=false` で execute がブロックされる）。

### Phase 0: 契約と threat model

- `browser-recording.v1`、`browser-extension-session.v1`、receipt schema を `knowledge/product/schemas/` に追加する。
- `browser:extension_session` の operation registry と pipeline preflight を追加する。
- origin scope、lease、risk taxonomy、redaction policy を schema とテストで固定する。

受入条件: schema の invalid case、期限切れ lease、異なる tab/origin、unknown op、raw selector、secret value がすべて拒否される。

### Phase 1: 安全な観察と記録

- Manifest を最小権限化し、Side Panel と接続/record/review の UX を実装する。
- role/name を中心に snapshot と ref を生成し、入力値を記録しない。
- recording を Kyberion Bridge に提出し、redaction と review summary を返す。

受入条件: password、OTP、token、Cookie、free-text value が draft、Chrome storage、trace に残らない。記録が 3 種類の SPA と通常 HTML ページで安定して動く。

### Phase 2: Bridge と pipeline draft

- Native Messaging host と Kyberion 側 request handler を実装する。
- recording を candidate ADF へ compile し、schema/policy/capability preflight と `automate-browser-workflow` に接続する。
- draft の tier、mission、evidence を明示して保存する。

受入条件: 未検証 recording は実行できず、preflight failure は人間が読める修正案付きで Review に戻る。

### Phase 3: 承認済み実行

- lease、step hash、origin/tab binding、execution receipt、停止/再開を実装する。
- 高リスク操作を policy の approval request と連携する。
- 実行前後 snapshot と user-visible verification を実装する。

受入条件: destructive step は承認なしに実行されず、DOM 変化で target ambiguity が生じた場合は停止する。失敗 receipt は原因、対象、redaction 済み evidence reference を含む。

### Phase 4: 再利用と品質保証

- 操作記録を reusable pipeline proposal として昇格する review flow を実装する。
- extension unit test、Chrome E2E、Bridge contract test、pipeline integration test、accessibility test を CI に追加する。

受入条件: replay 成功だけでなく、権限拒否、navigation、SPA rerender、iframe、prompt injection 文言、network 切断、service worker restart、approval expiry を回帰試験する。

## 11. レビュー記録と反映

| 観点               | 発見                                                                                                                 | 仕様への反映                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 契約整合性         | プロトタイプの `click_ref` / `fill_ref` は browser-pipeline schema の op ではなく、selector-first で v3 方針とずれる | recording.v1 を中間契約にし、snapshot + ref と compiler/preflight を必須化                   |
| セキュリティ       | `<all_urls>`、任意 ADF、承認なし click/fill により任意サイトで高リスク操作を実行できる                               | activeTab、optional permission、origin/tab-bound lease、allowlisted op、step approval を採用 |
| 秘密・プライバシー | `change` event が自由入力値を ADF と storage に保存する                                                              | 値を記録しないデータ分類と secret ref を導入。保存期限も定義                                 |
| 信頼境界           | ページ DOM をそのまま操作対象・説明文として使うと prompt injection に影響される                                      | ページを untrusted data とし、policy/lease をページから変更不可にした                        |
| 信頼性             | `nth-of-type` selector と固定 1 秒 wait は SPA で壊れやすい。service worker 停止も扱わない                           | accessibility ref、再 snapshot、ambiguity stop、lease 再検証、resumable summary に変更       |
| UX                 | JSON 貼り付けと技術用語中心で、記録・レビュー・承認が混在する                                                        | Side Panel の 4 タブ、目的中心の操作文、状態遷移、停止と破棄を分離                           |
| パイプライン化     | 記録した ADF をそのまま再生し、Kyberion の ADF lifecycle と mission evidence を通らない                              | `browser:extension_session` と compiler/preflight/receipt を定義し、draft からのみ昇格       |
| Chrome 制約        | 特権ページや incognito を通常 tab と同じように扱えない                                                               | V1 の対象外を明示し、UI で実行不可理由を返す                                                 |
| 運用・監査         | 実行者、承認者、対象、証跡の関連が残らない                                                                           | lease と receipt に mission/pipeline/approval/policy/version を結び付ける                    |

## 12. 実装開始前の確認事項

- Native Messaging host の配布先と OS ごとの署名・更新責任を決める。
- `browser:extension_session` の正式な operation 名と ADF schema version を Architecture review で確定する。
- 高リスク action taxonomy を既存 approval policy に拡張する際の承認者・有効期限・再承認条件を確定する。
- recording と receipt を保存する tier を、個人ブラウズは `personal`、組織業務は `confidential/{project}` として caller が必ず指定する。

この仕様の Phase 0 以降は実行権限、approval policy、パイプライン契約を変更するため、implementation 前に architecture approval を必要とする。
