# 動画生成プロバイダ

動画生成は `media-generation-actuator` の共通プロバイダ契約を経由します。アクチュエータやパイプラインから、Runway／Google／OpenAI／MiniMaxのHTTP仕様を直接呼び出してはいけません。

## 利用可能なバックエンド

| `backend_id`                                | モデル                     | 認証環境変数                                              |
| ------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| `media-generation.google.veo-3.1`           | `veo-3.1-generate-preview` | `KYBERION_GEMINI_VIDEO_API_KEY` または `GEMINI_API_KEY`   |
| `media-generation.runway.gen4.5`            | `gen4.5`                   | `KYBERION_RUNWAY_API_KEY` または `RUNWAYML_API_SECRET`    |
| `media-generation.runway.seedance2`         | `seedance2`                | `KYBERION_RUNWAY_API_KEY` または `RUNWAYML_API_SECRET`    |
| `media-generation.runway.gemini-omni-flash` | `gemini_omni_flash`        | `KYBERION_RUNWAY_API_KEY` または `RUNWAYML_API_SECRET`    |
| `media-generation.openai.sora-2`            | `sora-2`                   | `KYBERION_OPENAI_VIDEO_API_KEY` または `OPENAI_API_KEY`   |
| `media-generation.minimax.hailuo-2.3`       | `MiniMax-Hailuo-2.3`       | `KYBERION_MINIMAX_VIDEO_API_KEY` または `MINIMAX_API_KEY` |

既定値は従来どおり `video.hyperframes_cli` です。APIバックエンドは、明示的に `backend_id` を指定した場合だけ利用されます。認証情報がない場合にHyperFramesへ暗黙降格することはありません。

## 共通入力

```json
{
  "action": "generate_video",
  "params": {
    "backend_id": "media-generation.runway.gen4.5",
    "prompt": "A slow cinematic camera move across a quiet ocean at dawn",
    "duration_seconds": 5,
    "aspect_ratio": "16:9",
    "first_frame_image": "https://example.com/first-frame.png",
    "target_path": "active/shared/exports/ocean-dawn.mp4",
    "await_completion": false
  }
}
```

`await_completion: false`（既定）はジョブを送信して`provider_job_id`を返します。続けて既存の`get_generation_job`、`wait_generation_job`、`collect_generation_artifact`を使って追跡・回収します。

プロバイダが対応する範囲で、以下を共通フィールドとして扱います。

- `prompt`
- `duration_seconds`
- `resolution` / `aspect_ratio`
- `first_frame_image` / `last_frame_image`
- `reference_images`
- `generate_audio`
- `target_path`
- `egress_tier` / `tenant_slug`

参照画像はプロバイダの制約に従います。OpenAI Soraのアダプタは現在、`data:` URIの先頭フレームを`input_reference`として扱います。ローカルファイルをAPIへ送る場合は、プロバイダ固有実装を追加せず、共通入力契約の拡張として実装してください。

## 実装境界

- プロバイダ固有のURL、認証ヘッダー、状態値、成果物取得方法は `src/video-generation-provider.ts` に閉じ込める。
- 生成ジョブの永続化とリトライは既存の`GenerationJob`契約を使う。
- API成果物は取得時にKyberion管理下のパスへ保存し、外部の一時URLを利用者へ返さない。
- 機密データを外部へ送る場合は`egress_tier`と必要に応じて`tenant_slug`を指定する。egress policyにより未承認の送信は拒否される。
- `video.hyperframes_cli`とComfyUIの既存経路は変更しない。

## 設定

環境変数の正本は [`env-registry.json`](../../knowledge/product/governance/env-registry.json) です。設定面を変更した場合は次を実行します。

```bash
pnpm generate:env-registry
pnpm run check:env-registry
```
