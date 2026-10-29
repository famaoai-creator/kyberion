---
title: リアルタイム映像フィルタと会話アバターの運用
tags: [voice, realtime, obs, avatar, operations]
last_updated: 2026-10-29
role_affinity: [operator, implementer, reviewer]
---

# リアルタイム映像フィルタと会話アバター

## 構成

カメラ映像の処理はOBSの既存ソースとGPUフィルタに任せる。
Kyberionはobs-websocket v5で設定を制御し、毎フレームの画像をNode.jsへコピーしない。
このためピクセル転送用の巨大なキューや新しい生成動画モデルは不要。
フィルタのFPS、GPU/RSS、カメラ遅延は実機で測る必要がある。

会話はPresence Studioの既存 `/work` で開始する。
`/live-avatar` はその状態とホストの発話を表示するOBS向けの透過ページ。
同じPresence Studioへアクセスできるブラウザセッションが必要で、
OBSのブラウザソースは通常のブラウザのCookieを自動共有しない。
最初はログイン済みブラウザのウィンドウキャプチャで検証し、
ブラウザソースを使う場合はそのセッションにも通常の認証を行う。
トークンをURLへ埋め込んだり、認証を無効化したりしない。

表示ページだけではマイクも会話も起動しない。既存の口パクは発話状態に基づく合成動作で、
このページで音素精度のviseme、Live2D/VRM、顔トラッキングを実装したとは扱わない。
切断時は口を閉じ、ページを閉じたらストリームと描画を破棄する。
音声はホスト再生なので、OBSでは必要に応じて別途音声ルートを設定する。
既存の `voice:render_talking_avatar` は録画MP4用であり、ライブ表示の前処理には不要。

CLIの既存会話ループから表示へ連動させる場合は、通常の
[音声会話の前提条件と録音同意](../../public/procedures/media/realtime-voice-conversation.md)
を満たし、`--avatar-follow --delivery-mode artifact_and_playback` を指定する。
Presence Studioとvoice-hubの両方が必要で、`--avatar-follow` を省略したCLIのローカル再生は
この表示に発話状態を送らない。

## 映像加工の共通契約

公開CLIとSDKは `color_correction`、`chroma_key`、`crop` の共通契約を受け付ける。
加工は `video-filter-provider` seam、仮想カメラへの出力は既存の `CameraOutputBridge` が担う。
OBS固有のフィルタID、設定名、WebSocket、パスワードはOBSアダプターだけが扱う。
共通設定の調整範囲は契約の単位であり、異なるプロバイダの画素処理結果が同一になる保証ではない。

`--provider` で登録済みプロバイダを選ぶ。省略時の `auto` は登録が1件の場合だけ選択する。
複数候補、不明な名前、未対応の加工、選択後の失敗を別プロバイダで黙って代替しない。
標準のOBSプロバイダはループバック限定。OBS Studioでカメラソースを作り、
WebSocket Serverを有効にしてパスワードを設定する。
`KYBERION_OBS_WS_PASSWORD` はアダプター内のsecret guardで解決し、承認や出力へ値を記録しない。
接続先などの設定はホストのプロバイダ登録で与え、共通の加工入力には含めない。

```sh
pnpm kyberion video filter inspect --json
pnpm kyberion video filter inspect --source Camera --provider obs --json
pnpm kyberion video filter apply --input active/shared/tmp/video-filter.json --dry-run --json
pnpm kyberion video filter apply --input active/shared/tmp/video-filter.json --provider obs --json
```

`inspect` の能力一覧は登録された宣言で、可用性の確認とは区別する。
ソースを指定した場合に選択プロバイダから現在のフィルタを取得する。
未知のネイティブ種類は `unsupported` として返し、ネイティブ設定や機密値を公開しない。

`video-filter.json` の例:

```json
{
  "source_id": "Camera",
  "filter_id": "Kyberion Color",
  "type": "color_correction",
  "settings": { "saturation": -1 },
  "enabled": true
}
```

`apply` は専用の `video:filter_apply` 外部効果境界で、共通スキーマ、プロバイダ、
ソース・設定、接続先と認証に束縛された不透明な対象IDを使って承認する。
未承認時は適用しない。パスワードや設定を変えた場合は別の効果となる。
`--dry-run` は接続・認証解決をせず、共通契約だけを検証する。
この操作IDは外部効果の識別子であり、ADF actuator opとしての登録を意味しない。

カスタムキー色は `color: "custom"` と `custom_color: "#RRGGBB"` の組を必須とする。
他の色指定との混在を拒否し、内部の色チャンネル配列はアダプターで変換する。
cropの幾何指定には `relative` を明示する。相対指定は上下左右の辺だけ、絶対指定は
正の `width`・`height` と任意の `left`・`top` を使う。無視される設定の混在は事前に拒否する。
空のsettingsは既存フィルタの有効・無効変更に利用できる。
同名の別種類フィルタは上書きしない。既存フィルタへの設定は指定項目だけのoverlay。
OBSは新規フィルタを有効で作るため、存在しないフィルタを `enabled: false` で作る操作は拒否する。
既存フィルタは `enabled: false` にできる。
この操作はソース作成、シーン切替、仮想カメラ起動、録画・配信開始を行わない。
読み戻しが失敗した場合は適用済みの可能性があるので、`inspect` とプロバイダ側の画面で確認してから修復する。

## 検証と制限

OBSプロトコルの偽サーバー試験、承認境界、切断時のアバター停止、
音声ブリッジの依存性なし試験は、実OBS・カメラ・GPU性能の検証とは区別する。
2026-10-29の初期確認では管理対象のPocket/Kokoro/MLX/VADランタイムは未導入だった。
その後、既存のsetupでPocket 4.0.1を導入し、1.9Mモデルの実音声生成を確認した。
取得済み重みの再実行では4.32秒のWAVを2.264秒で生成し、コマンド最大RSSは約456MiBだった。
これはPythonを毎回起動するartifact経路の測定であり、PCM初回出力や会話全体の遅延ではない。
OBSの4455番ポートは接続確認できておらず、カメラの起動は行っていない。

音声モデルの採否は [技術評価](../architecture/realtime-av-technology-review-2026-10.md)、
confidential側の認証束縛は [bindTask運用](tenant-task-credential-binding.ja.md) を参照。
