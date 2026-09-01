# Kyberion Browser Bridge

Chrome の現在タブで操作意図を記録し、Kyberion が review できる `browser-recording.v1` 下書きを作る Manifest V3 extension です。

## 現在の機能

- Side Panel から現在タブを接続し、クリック、選択、入力項目、送信を記録
- 接続解除と、同一 origin のページ遷移後の再接続・記録続行
- 入力値、password、OTP、token、Cookie、WebAuthn credential、raw CSS selector、contenteditable の本文を保存しない
- 記録した各操作を承認または除外し、承認済み操作だけを review 用の JSON 下書きに残す
- Native Messaging host 経由で Kyberion の preflight / 承認 / lease 発行 / Chrome 実行 / receipt 生成に接続
- preflight は browser-actuator の `browser` パイプライン step `op: extension_session`（`actuator-op-registry.json`）で検証
- Chrome 138 以降で利用可能な Built-in AI（`Summarizer` / `LanguageModel`）による、redaction 済みページ本文・抽出観測のローカル要約とシナリオ候補抽出（候補は実行不可）
- シナリオ候補の目的を確認して intent 入力へ渡し、既存の Pattern B（照合・承認・実行）または Pattern A（記録・Review）へ進む導線

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
- Built-in AI は任意機能です。API 非対応、モデル未取得、端末要件未達の場合は Built-in AI の処理を停止しますが、既存の Native host による実行・分析経路は変更されず利用できます。AI の結果だけで操作や承認は行いません。

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
