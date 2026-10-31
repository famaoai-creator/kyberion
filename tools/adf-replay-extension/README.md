# Kyberion Browser Bridge

Chrome の現在タブで操作意図を記録し、Kyberion が review できる `browser-recording.v1` 下書きを作る Manifest V3 extension です。

## 現在の機能

- Side Panel から現在タブを接続し、クリック、選択、入力項目、送信を記録
- 接続解除と、同一 origin のページ遷移後の再接続・記録続行
- 入力値、password、OTP、token、Cookie、WebAuthn credential、raw CSS selector、contenteditable の本文を保存しない
- 記録した各操作を承認または除外し、承認済み操作だけを review 用の JSON 下書きに残す
- 操作の直後に `role="status"` の完了表示（例：「保存しました」）が出て落ち着くと、それを待つ `wait_for_ref` ステップとして自動で記録（Review で承認/除外できます）。手順の golden シナリオはこの表示を成功条件に使うため、実行後に本当に成功したかを判定できます。記録の対象外：`role="alert"`、操作前から出ていた表示、PII 除去で伏せ字になった文言
- Native Messaging host 経由で Kyberion の preflight / 承認 / lease 発行 / Chrome 実行 / receipt 生成に接続
- preflight は browser-actuator の `browser` パイプライン step `op: extension_session`（`actuator-op-registry.json`）で検証
- Chrome 138 以降で利用可能な Built-in AI（Prompt API〔トークン残量の確認・ストリーミング・中断に対応〕、Summarizer、Translator、LanguageDetector、および機能検出できる場合のみ Writer / Rewriter / Proofreader と画像入力）による、redaction 済みページ本文・抽出観測のローカル要約とシナリオ候補抽出（候補は実行不可）
- シナリオ候補の目的を確認して intent 入力へ渡し、既存の Pattern B（照合・承認・実行）または Pattern A（記録・Review）へ進む導線
- **受信タブ**: Kyberion からの依頼（ページ観測・ローカル推論・お知らせ）と承認待ちを表示。ページ観測は「許可して応答」を押したときだけ応答
- **送信タブ / 右クリック「Kyberion に送る」**: ページ本文または選択範囲を、PII 除去済みで intent またはナレッジとして送る（右クリックは下書きを入れるだけで、自動送信しない）
- **このページが公開している AI ツール（WebMCP）**: ツール名・説明・入力項目名だけを表示（呼び出しはしない）

> 注: pipeline 上の operation 名は `browser` action 内の step `op: "extension_session"` です（`browser:extension_session` という単独 op ではありません）。

## Kyberion からの依頼（受信タブ）

Kyberion から拡張への連絡は、拡張が Native Messaging host に問い合わせる **pull 型の受信箱** です。拡張は待ち受けポートを開きません。

- 1 分ごとに問い合わせます（`chrome.alarms`）。Side Panel を開いている間は 5 秒ごとです。
- 要対応の件数を拡張アイコンのバッジに出します。新しいページ観測の依頼と承認待ちは Chrome の通知でも知らせます。
- **ページ観測**（`observe_tab`）: 依頼元・目的・対象サイト・残り時間を確認し、「許可して応答」で、Live タブで接続中の現在タブを PII 除去して返します。対象サイトが指定されている依頼は、そのサイトのタブでしか応答できません。押さなければ何も返しません。
- **ローカル推論**（`local_infer`）: Chrome 内蔵 AI でこの端末内で処理し、結果だけを返します。既定ではクリックが必要です。「ローカル推論依頼を自動応答」をオンにすると、このブラウザを閉じるまでローカル推論だけ自動で応答します（ページ観測には適用しません）。内蔵 AI が使えない場合は、理由を添えて失敗として返します。
  - 結果の `output` は文字列かオブジェクトです。`summarize` / `rewrite` / `write` は文字列、`translate` は `{ text, translated, source_language, target_language }`、`detect_language` は `{ language, confidence }`、`proofread` は `{ text, corrections }`、`classify` / `extract` はタスクごとの値です。上限（約 48 KB）を超える出力は切り詰めて `truncated: true` を付け、それでも送れない場合は失敗として返します。
- **お知らせ**（`notify`）: 情報・進捗は「確認」で既読にします。承認待ちは表示だけです。拡張では承認できず、表示されたコマンド（`pnpm kyberion approvals --approve <id>`）をコピーしてターミナルで実行します。
- 期限を過ぎた依頼は手元で消え、応答しません。

依頼は `pnpm kyberion browser-bridge request observe|infer|notify ...` で作成し、`pnpm kyberion browser-bridge status <id>` / `wait <id>` で結果を確認します。

## Kyberion に送る（送信タブ）

1. ページ上で右クリック →「Kyberion に送る」（選択中ならその範囲、なければページ本文）、または送信タブの「接続中のページを取り込む」。
2. 送信方法を選ぶ: **intent**（やりたいことを書くと登録済み手順と照合し、見つかれば Intent タブから Pattern B で実行できます）または **knowledge**（ナレッジとして取り込みます）。
3. 保存先の区分を選ぶ: personal（既定）/ confidential（テナント slug が必要）/ public（「公開してよい内容です」の確認が必要）。
4. PII 除去済みのプレビューを確認して「Kyberion に送信」。

## ページ構造を Kyberion CLI へ渡す

1. ターミナルで `pnpm kyberion browser inspect --mode extension` を実行します（保存先の区分は `--tier personal|confidential|public`、confidential は `--tenant <slug>` が必要。既定は personal、待ち時間は `--timeout` ミリ秒で最大 10 分）。
2. Live タブで対象ページを接続し、「ページ構造を解析」→「Kyberion CLIへ送信」。
3. 送信は native host（`submit_inspection`）経由です。ポートの設定はありません。待機中の CLI がなければ送信は拒否されます。入力欄の値は送らず、URL のクエリと fragment は落とします。

## 既存の導入を更新する

すでに拡張を読み込み済みの環境で、この版へ更新する手順です。

1. Kyberion 側を更新したら `pnpm build`（または `pnpm build:actuators`）で `dist/scripts/browser_bridge_host.js` を作り直します。host スクリプトに `poll_requests` / `respond_request` / `send_page` / `submit_inspection` が加わったためです。
2. `chrome://extensions` で、読み込み済みの拡張（unpacked）の「再読み込み」を押します。
3. Chrome が新しい権限 `alarms` / `contextMenus` / `notifications` の承認を求めるので受け入れます。拒否すると受信箱の定期問い合わせ、右クリック送信、通知が動きません。
4. native host の再導入（`native-host/install.sh`）は、通常は不要です。host の manifest（`com.kyberion.browser_bridge.json`）は変わっておらず、Chrome が起動するのは同じ `launch.sh` です。拡張 ID を変えた、リポジトリの場所を移した、`node` を入れ替えたなど、manifest の `path` や `allowed_origins` が変わる場合だけ再実行し、Chrome を完全に終了して開き直します。
5. 確認: Side Panel に「受信」タブが表示されること。続けて `pnpm kyberion browser-bridge request notify --title test --body hello` を実行し、1 分以内（Side Panel を開いていれば 5 秒以内）に受信タブへ届けば完了です。

## 権限

| 権限                      | 用途                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `activeTab` / `scripting` | 接続したタブへの content script 注入、WebMCP ツール一覧の読み取り                  |
| `storage`                 | 記録・受信箱・送信下書きの一時保存（`chrome.storage.session`、ブラウザ終了で破棄） |
| `sidePanel`               | Side Panel の表示                                                                  |
| `nativeMessaging`         | Kyberion（native host）との唯一の通信経路                                          |
| `alarms`                  | 受信箱の定期問い合わせ（1 分ごと）                                                 |
| `contextMenus`            | 右クリックの「Kyberion に送る」                                                    |
| `notifications`           | 新しいページ観測の依頼と承認待ちの通知                                             |

サイトへのアクセス（`optional_host_permissions`）は従来どおり、接続時に明示的に許可したサイトだけです。新しい host permission は追加していません。

## 実行フロー（Run タブ）

1. Review を確定（承認済み操作のみ）
2. `Kyberion preflight` — schema / policy / capability を検証
3. `承認済み操作を実行` — Native Bridge が承認を強制し、高リスク操作は approval-gate で承認待ちに。承認後に短命の execution lease を発行
4. lease 範囲内で承認済み操作だけを再 snapshot しながら実行し、対象が曖昧なら停止。結果を receipt 化

`fill_ref` の入力値は記録されないため、実行時に Run タブのフォームで都度入力します（その値も保存されません）。

## 明示的な制限

- この拡張は単独で ADF を再生しません。実行は必ず Native Bridge の lease を要します。
- 高リスク操作（送信・購入・削除等）は Kyberion の承認なしには実行されません。
- `chrome://`、Chrome Web Store、file URL、incognito は対象外です。
- 記録ドラフトは `chrome.storage.session` に保持され、ブラウザ終了で破棄されます（永続保存は Kyberion 側 tier 指定で行います）。
- Built-in AI は任意機能です。Prompt API / Summarizer / Translator / LanguageDetector と、利用できる場合だけ Writer / Rewriter / Proofreader を機能検出で使います。API 非対応、モデル未取得、端末要件未達の場合は Built-in AI の処理を停止しますが、既存の Native host による実行・分析経路は変更されず利用できます。AI の結果だけで操作や承認は行いません。

Native Messaging host の導入は [native-host/README.md](./native-host/README.md) を参照してください。

拡張機能の契約テストはリポジトリルートから `pnpm test -- --suite browser-bridge` で実行できます。

## ローカル読み込み

1. Chrome で `chrome://extensions` を開く。
2. Developer mode を有効にする。
3. `Load unpacked` からこの `tools/adf-replay-extension/` ディレクトリを選択する。
4. 通常の http(s) ページで拡張アイコンを押し、Side Panel から「このタブを接続」を選択する。
5. 初回接続時にサイトへのアクセス許可（optional host permission）を求められるので許可する。

> **サイトアクセス許可について**: `activeTab` のみだと、許可は拡張アイコンを押したそのページ1回限りで、ページ遷移やタブ切替で失効します（＝「一度別サイトに接続すると以後つながらない」「サブドメイン遷移で止まる」の原因）。「このタブを接続」で `optional_host_permissions` を一度許可すると、以後はページ遷移・再接続でも content script を再注入できます。同一 origin の遷移は自動で記録を再開し、別 origin（サブドメインを含む）は handoff として記録を継続します。対象 origin の許可が得られない場合は、その遷移で停止して新しい記録が必要です。

実装方針と次フェーズは [IMPLEMENTATION_SPECIFICATION.ja.md](./IMPLEMENTATION_SPECIFICATION.ja.md) を参照してください。
