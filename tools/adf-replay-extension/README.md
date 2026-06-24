# Kyberion Browser Bridge

Chrome の現在タブで操作意図を記録し、Kyberion が review できる `browser-recording.v1` 下書きを作る Manifest V3 extension です。

## 現在の機能

- Side Panel から現在タブを接続し、クリック、選択、入力項目、送信を記録
- 接続解除と、同一 origin のページ遷移後の再接続・記録続行
- 入力値、password、OTP、token、Cookie、WebAuthn credential、raw CSS selector を保存しない
- 記録した各操作を承認または除外し、承認済み操作だけを review 用の JSON 下書きに残す
- browser-actuator の `browser:extension_session` で preflight 可能

## 明示的な制限

- この拡張は単独で ADF を再生しません。
- Native Messaging bridge、execution lease、承認済み Chrome 実行は未実装です。
- `chrome://`、Chrome Web Store、file URL、incognito は対象外です。

## ローカル読み込み

1. Chrome で `chrome://extensions` を開く。
2. Developer mode を有効にする。
3. `Load unpacked` からこの `tools/adf-replay-extension/` ディレクトリを選択する。
4. 通常の http(s) ページで拡張アイコンを押し、Side Panel から「このタブを接続」を選択する。

実装方針と次フェーズは [IMPLEMENTATION_SPECIFICATION.ja.md](./IMPLEMENTATION_SPECIFICATION.ja.md) を参照してください。
