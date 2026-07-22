# 手順: Presence Studio で TTS / STT を選択する

## 目的

Presence Studio の音声入出力を、用途・プライバシー・品質・運用コストに合わせて選択し、実際の実行経路へ反映する。TTS は読み上げエンジン、STT はマイク音声を文字へ変換するバックエンドを指す。

## 事前確認

1. リポジトリの状態を確認する。

   ```bash
   pnpm pipeline --input pipelines/baseline-check.json
   ```

2. ローカル音声ランタイムを使う場合は、準備状況を確認する。

   ```bash
   pnpm voice:setup --json
   pnpm voice:health
   ```

   `mlx_audio` は Qwen3-TTS、`mlx_whisper` はローカル STT 用である。未準備の場合は、表示された手順に従ってから `pnpm voice:setup --apply` を実行する。

## 選択手順

1. Presence Studio を開き、Voice パネルの `TTS output` と `Native STT backend` を確認する。
2. TTS を選択する。選択はプロファイル単位で保存され、ページを再読み込みしても維持される。
3. Native STT backend を選択する。`Auto` は利用可能性と設定済みの優先順位に従って自動フォールバックする。
4. Native Mic を使う場合は `Native input` で入力デバイスを選び、短い発話で確認する。
5. Browser Mic はブラウザの Web Speech API を使う別経路であり、`Native STT backend` の選択は Browser Mic の認識エンジンを変更しない。データの扱いを明確にしたい場合は Native Mic を使い、選択した STT の表示を確認する。

## 選択肢の判断基準

### TTS

| 選択肢                                      | 向いている用途                                               | データ・準備                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `Local System Voice` (`local_say`)          | 低遅延、安定した読み上げ、個人データを外部へ出したくない場合 | OS の音声コマンドを使用。ネットワーク不要                                                       |
| `Qwen3-TTS Voice Clone` (`mlx_audio_qwen3`) | ローカルで音色を合わせたい場合                               | 管理対象の `mlx_audio` ランタイムと、利用許諾済みの voice profile sample が必要                 |
| その他の登録済みエンジン                    | governed artifact の生成や将来の拡張                         | 現時点では live Presence reply の選択対象外。選択肢に表示されても `Not live` として無効化される |

### STT

| 選択肢                              | 向いている用途                                             | データ・準備                                                             |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Auto`                              | 通常運用。可用なバックエンドへ自動フォールバックしたい場合 | 現在の Auto 順序は画面の補足表示で確認する                               |
| `mlx-whisper (managed local)`       | Apple Silicon 上でローカル処理したい場合                   | 管理対象の `mlx_whisper` ランタイムが必要。音声は外部 STT へ送らない     |
| `whisper.cpp`                       | ローカル CLI とモデルを管理できる環境                      | CLI とモデルの配置が必要。CPU/GPU 性能により遅延が変わる                 |
| `Native Speech`                     | OS の音声 API と権限管理を使いたい場合                     | OS のマイク・音声認識権限が必要。OS の実装や設定に依存する               |
| `Hosted / OpenAI-compatible server` | 高品質モデルを共有サービスや GPU サーバーで使う場合        | 音声が設定先へ送信される。URL、API key、保存・保持方針を確認してから選ぶ |

外部送信が許可されていない会話、個人 voice sample、機密情報を含む会話では、まずローカルの TTS/STT を選ぶ。Hosted STT を使う場合は、送信先、認証、ログ保持、障害時のフォールバックを利用者へ説明する。

## 確認と障害切り分け

UI の選択状態は次の API でも確認できる。

```bash
curl -s http://127.0.0.1:3031/api/voice/selection
```

確認する項目は `preferences.tts_engine_id`、`preferences.stt_backend`、`stt.selected_order`、各候補の `status` / `reason` である。変更は UI を優先し、API を直接使う場合も候補として `selectable: true` のものだけを指定する。

音声が動かない場合は、次の順で切り分ける。

1. `voice:setup` でランタイムが準備済みか確認する。
2. `voice:health` で bridge とエンジンの準備状態を確認する。
3. `pnpm voice:route:probe` で入力デバイスとルートを確認する。
4. 入力デバイスが見つからない場合は、OS のマイク権限、CoreAudio、仮想デバイス（例: BlackHole）を確認する。これは STT エンジン未準備とは別の問題である。
5. Hosted STT のみ失敗する場合は、URL、API key、ネットワーク、送信先のヘルスを確認し、機密会話では Auto またはローカルへ戻す。

## 運用上の注意

- TTS 選択の保存先は active profile の `onboarding/voice-selection.json` である。プロファイルを切り替えた場合、選択状態も切り替わる。
- エンジンを選べない場合、`Needs setup` はランタイム準備不足、`Not live` は登録済みだが Presence の live reply 実行経路未対応を意味する。無理に設定ファイルを書き換えない。
- voice clone を使う場合は、本人の明示的な許諾がある sample だけを profile に登録する。不要になった sample は profile のライフサイクル手順に従って管理する。
- 選択変更後は短いテスト発話を行い、UI に表示された TTS/STT と実際の結果が一致することを確認する。変更履歴は Presence Studio の監査ログで追跡できる。

## 関連手順

- [リアルタイム音声会話](./realtime-voice-conversation.md)
- [音声プロファイルの登録](./register-voice-profile.md)
- [音声プロファイルの昇格](./promote-voice-profile.md)
- [BlackHole TTS ループバック](./blackhole-tts-loopback.md)
