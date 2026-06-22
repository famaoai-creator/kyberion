---
title: Kyberion Chrome Browser Bridge Implementation Specification
kind: implementation-specification
scope: tools/adf-replay-extension
authority: proposed
status: draft
owner: ecosystem_architect
reviewed_at: 2026-06-23
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

| 状態 | 利用者に見せるもの | 実行可能な操作 |
| --- | --- | --- |
| 接続前 | 「このタブを接続」ボタン、対象 origin、権限説明 | 接続、読み取り専用の観察 |
| 観察中 | URL、タブ名、抽出範囲、ページから受け取った外部命令を信用しない注意 | snapshot、要素選択、記録開始 |
| 記録中 | 録画中表示、操作数、秘密入力を除外したこと、停止ボタン | 記録停止、一時停止、直前操作の破棄 |
| レビュー | 人間が読める操作文、対象、変数候補、リスク、差分 | 操作編集、削除、変数化、下書き提出 |
| 承認待ち | 実行対象、影響、承認者、期限 | 承認要求の送信、取り消し |
| 実行中 | 現在の手順、対象 tab、停止、証跡の要約 | 停止、緊急切断 |
| 完了/失敗 | 成功条件、検証結果、redaction 済み receipt、次の選択肢 | パイプラインへ保存、再レビュー |

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

| 責務 | 所有者 |
| --- | --- |
| Chrome tab の DOM 観察・操作 | 拡張 content script |
| 表示、ローカル一時状態、停止 | Side Panel / service worker |
| ADF / recording の schema 検証と compiler | Kyberion Browser Bridge service |
| capability、origin scope、期限の検証 | Kyberion Browser Bridge service |
| リスク分類と承認状態 | Kyberion approval policy |
| secret binding、redaction、永続化 | Kyberion secret/secure-io 境界 |
| trace、receipt、mission evidence | browser-actuator / mission lifecycle |

### 4.2 接続方式

V1 は Native Messaging のみを採用する。ローカル loopback HTTP、任意 WebSocket、外部 SaaS への直接通信は採用しない。Native host 名は `com.kyberion.browser_bridge` とし、Chrome extension ID を allowlist する。

起動時に service は短命の `execution_lease` を発行する。lease には `mission_id`、`pipeline_id`、`tab_id`、許可 origin、許可 operation、承認済み step hash、発行時刻、有効期限を含める。拡張は lease 範囲外の tab、origin、step を拒否する。ページ遷移、tab 切替、期限切れ、拡張再起動時は lease を失効させる。

## 5. 権限・データ保護

### 5.1 Manifest V3

- 必須権限は `activeTab`、`scripting`、`storage`、`sidePanel` に限定する。
- `tabs` は URL 表示が必要な場合だけ利用し、恒常的な閲覧履歴収集に使わない。
- `host_permissions: ["<all_urls>"]` は削除する。複数 origin の継続利用は `optional_host_permissions` を明示 consent で取得する。
- `externally_connectable`、remote code、eval、任意 URL からの script 読み込みを禁止する。
- `chrome://`、`chrome-extension://`、Chrome Web Store、file URL、incognito は V1 の対象外とし、理由を UI に表示する。

### 5.2 記録規則

記録の一次成果物は ADF ではなく `browser-recording.v1` とする。値を含むイベントは以下のように扱う。

| 入力種別 | 記録内容 |
| --- | --- |
| password、OTP、token、cookie、WebAuthn | 操作自体を記録しない。秘密入力が省略されたことだけを表示する。 |
| email、電話、住所、自由入力 | デフォルトでは値を記録しない。`{{input.name}}` の候補と入力項目の意味だけを記録する。 |
| select、checkbox、radio | 選択肢の表示名と value を別途リスク判定し、初期値は表示名だけを記録する。 |
| ファイル upload / download | パス・内容を記録しない。ファイル選択または download の intent と承認要否だけを記録する。 |

拡張の `storage.local` には、未送信 recording の redaction 済み要約だけを短期保存できる。完了、取消、7 日経過のいずれかで削除する。canonical record、証跡、変数定義は Kyberion 側で tier を指定して保存する。

### 5.3 ページを信頼しない

DOM、ページ本文、ARIA label、ページ内の指示、URL parameter は untrusted data とする。これらは UI 上で「ページ由来」と明示し、承認ポリシー、lease、操作許可リストを変更できない。外部送信や権限昇格を促すページ文言を発見した場合は warning として receipt に残す。

## 6. 操作契約

V1 の実行可能操作は browser-actuator v3 の `snapshot + ref` 方針に合わせる。raw CSS selector は recording の内部候補としてのみ保持し、executor の公開契約には出さない。

| 区分 | V1 操作 | ルール |
| --- | --- | --- |
| 観察 | `snapshot`、`screenshot`、`extract_text_ref`、`list_tabs` | 読み取り専用。内容は redaction 前に pipeline/LLM へ送らない。 |
| 低リスク実行 | `open_tab`、`select_tab`、`click_ref`、`fill_ref`、`select_ref`、`press_ref`、`wait_for_ref` | lease と ref 解決の成功が必須。`fill_ref` は secret ref または明示入力だけを受ける。 |
| 高リスク実行 | `submit_form`、`upload_file`、`download_file`、`delete`、`purchase`、`credential_submit`、`settings_change` | step ごとの明示承認と実行直前の再確認が必須。V1 では generic click に偽装しない。 |
| 非対応 | `evaluate`、任意 JavaScript、raw selector click/fill、passkey credential export | 拡張 execution lease では拒否する。Playwright 専用か専用の将来契約へ分離する。 |

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

新しい pipeline operation は `browser:extension_session` とする。これは Chrome Extension へ直接命令を送るものではなく、Bridge service に session と lease を要求する orchestration op である。

入力は `pipeline_id`、`mission_id`、`allowed_origins`、`mode`、`recording_id` または `compiled_plan_id`、`approval_context`。出力は `browser_session_id`、`lease_id`、`approval_status`、`receipt_ref`。既存の `browser:pipeline` は Playwright execution として維持する。

`recording -> reusable pipeline` は既存の `automate-browser-workflow` テンプレートの crystallization を利用し、生成された pipeline は draft として保存する。人間の review と実行 preflight を通過するまで reusable registry に昇格させない。

## 8. UI 構成

Side Panel は以下の 4 タブに固定する。

1. **Live**: 接続状態、tab、現在の操作、停止、lease 期限。
2. **Record**: 記録開始/停止、除外された秘密入力、操作タイムライン、直前の操作を破棄。
3. **Review**: 人間向け要約、変数化、対象確認、risk badge、生成候補。
4. **Run**: 承認状態、実行 plan、step progress、失敗時の再選択、receipt。

初回導線は「このタブで観察する」だけにし、記録・実行は別の明示操作にする。実行ボタンは、対象 origin、操作件数、承認が必要な件数、期限を一行で確認できる場合だけ有効化する。

アクセシビリティは keyboard 操作、フォーカス移動、状態変化の live region、色だけに依存しない risk 表現、200% zoom を受入条件とする。

## 9. プロトタイプからの移行

| 現在の実装 | 問題 | 移行先 |
| --- | --- | --- |
| Popup で JSON を貼り付けて Replay | 意味・影響・承認が見えず、誤実行しやすい | Side Panel の Review / Run と Bridge 経由の compiled plan |
| `<all_urls>` | 常時の過大な site access | `activeTab` と optional host permission |
| `chrome.storage.local.lastAdf` | 秘密値を含む ADF が残り得る | redaction 済み短期 draft のみ、canonical 保存は Kyberion |
| CSS selector / `nth-of-type` | UI 変更で壊れ、レビュー不能 | snapshot + ref、内部 locator は再解決のみ |
| `fill_ref` が DOM に直接値を書き込む | PII/secret の混入と React 等の互換性リスク | secret ref / 明示入力、native setter と実行前確認 |
| click を即時 dispatch | destructive action の保護がない | risk classifier、step approval、execution lease |
| 任意 ADF の `goto` / click 実行 | schema、capability、origin 制限なし | Bridge service の preflight 後に限定 execution |
| in-memory state のみ | service worker 停止で進行状態と停止理由が不明瞭 | resumable session summary、lease 再検証、明示的な aborted state |

## 10. 実装フェーズと受入条件

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

| 観点 | 発見 | 仕様への反映 |
| --- | --- | --- |
| 契約整合性 | プロトタイプの `click_ref` / `fill_ref` は browser-pipeline schema の op ではなく、selector-first で v3 方針とずれる | recording.v1 を中間契約にし、snapshot + ref と compiler/preflight を必須化 |
| セキュリティ | `<all_urls>`、任意 ADF、承認なし click/fill により任意サイトで高リスク操作を実行できる | activeTab、optional permission、origin/tab-bound lease、allowlisted op、step approval を採用 |
| 秘密・プライバシー | `change` event が自由入力値を ADF と storage に保存する | 値を記録しないデータ分類と secret ref を導入。保存期限も定義 |
| 信頼境界 | ページ DOM をそのまま操作対象・説明文として使うと prompt injection に影響される | ページを untrusted data とし、policy/lease をページから変更不可にした |
| 信頼性 | `nth-of-type` selector と固定 1 秒 wait は SPA で壊れやすい。service worker 停止も扱わない | accessibility ref、再 snapshot、ambiguity stop、lease 再検証、resumable summary に変更 |
| UX | JSON 貼り付けと技術用語中心で、記録・レビュー・承認が混在する | Side Panel の 4 タブ、目的中心の操作文、状態遷移、停止と破棄を分離 |
| パイプライン化 | 記録した ADF をそのまま再生し、Kyberion の ADF lifecycle と mission evidence を通らない | `browser:extension_session` と compiler/preflight/receipt を定義し、draft からのみ昇格 |
| Chrome 制約 | 特権ページや incognito を通常 tab と同じように扱えない | V1 の対象外を明示し、UI で実行不可理由を返す |
| 運用・監査 | 実行者、承認者、対象、証跡の関連が残らない | lease と receipt に mission/pipeline/approval/policy/version を結び付ける |

## 12. 実装開始前の確認事項

- Native Messaging host の配布先と OS ごとの署名・更新責任を決める。
- `browser:extension_session` の正式な operation 名と ADF schema version を Architecture review で確定する。
- 高リスク action taxonomy を既存 approval policy に拡張する際の承認者・有効期限・再承認条件を確定する。
- recording と receipt を保存する tier を、個人ブラウズは `personal`、組織業務は `confidential/{project}` として caller が必ず指定する。

この仕様の Phase 0 以降は実行権限、approval policy、パイプライン契約を変更するため、implementation 前に architecture approval を必要とする。
