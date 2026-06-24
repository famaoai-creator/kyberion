# Kyberion Browser Bridge

Chrome の現在タブで操作意図を記録し、Kyberion が review できる `browser-recording.v1` 下書きを作る Manifest V3 extension です。

## 現在の機能

- Side Panel から現在タブを接続し、クリック、選択、入力項目、送信を記録
- 接続解除と、同一 origin のページ遷移後の再接続・記録続行
- 入力値、password、OTP、token、Cookie、WebAuthn credential、raw CSS selector、contenteditable の本文を保存しない
- 記録した各操作を承認または除外し、承認済み操作だけを review 用の JSON 下書きに残す
- Native Messaging host 経由で Kyberion の preflight / 承認 / lease 発行 / Chrome 実行 / receipt 生成に接続
- preflight は browser-actuator の `browser` パイプライン step `op: extension_session`（`actuator-op-registry.json`）で検証

> 注: pipeline 上の operation 名は `browser` action 内の step `op: "extension_session"` です（`browser:extension_session` という単独 op ではありません）。

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

Native Messaging host の導入は [native-host/README.md](./native-host/README.md) を参照してください。

## ローカル読み込み

1. Chrome で `chrome://extensions` を開く。
2. Developer mode を有効にする。
3. `Load unpacked` からこの `tools/adf-replay-extension/` ディレクトリを選択する。
4. 通常の http(s) ページで拡張アイコンを押し、Side Panel から「このタブを接続」を選択する。
5. 初回接続時にサイトへのアクセス許可（optional host permission）を求められるので許可する。

> **サイトアクセス許可について**: `activeTab` のみだと、許可は拡張アイコンを押したそのページ1回限りで、ページ遷移やタブ切替で失効します（＝「一度別サイトに接続すると以後つながらない」「サブドメイン遷移で止まる」の原因）。「このタブを接続」で `optional_host_permissions` を一度許可すると、以後はページ遷移・再接続でも content script を再注入でき、同一 origin の遷移は自動で記録を再開します。別 origin（サブドメインを含む）への遷移は origin バウンドの記録境界により停止し、新しい記録が必要です。

実装方針と次フェーズは [IMPLEMENTATION_SPECIFICATION.ja.md](./IMPLEMENTATION_SPECIFICATION.ja.md) を参照してください。
