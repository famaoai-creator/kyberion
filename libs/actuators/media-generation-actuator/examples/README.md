# Media-Generation-Actuator Examples

`media-generation-actuator` 固有のサンプル入力を配置するディレクトリです。

- 実運用向けの共通 pipeline は `pipelines/` に置く
- `media-generation-actuator` 専用の検証・再現・テンプレート入力は `libs/actuators/media-generation-actuator/examples/` に置く
- ジョブの既定 retry は `manifest.json` の `recovery_policy` と `retry_policy` で制御する
- `secureFetch` 系の履歴取得は transient failure に対して自動再試行される

実行例:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js --input libs/actuators/media-generation-actuator/examples/music-adf-anniversary-country-ja.json
```

job submit 例:

```bash
node dist/libs/actuators/media-generation-actuator/src/index.js --input libs/actuators/media-generation-actuator/examples/submit-image-generation-job.json
node dist/libs/actuators/media-generation-actuator/src/index.js --input libs/actuators/media-generation-actuator/examples/submit-video-generation-job.json
node dist/libs/actuators/media-generation-actuator/src/index.js --input libs/actuators/media-generation-actuator/examples/submit-music-generation-job.json
```

利用可能な examples:

- `image-adf-country-cover.json`:
  `image-generation-adf` から SDXL 系 text-to-image workflow を組み立てて画像生成する
- `video-adf-drive-clip.json`:
  `video-generation-adf` から named template ベースの動画生成 request を組み立てる
- `submit-image-generation-job.json`:
  `image-generation-adf` を long-running `generation-job` として submit し、後で status / wait / collect できるようにする
- `submit-video-generation-job.json`:
  `video-generation-adf` を long-running `generation-job` として submit し、後で status / wait / collect できるようにする
- `music-adf-anniversary-country-ja.json`:
  `music-generation-adf` を使って、日本語の女性ボーカル・カントリー調アニバーサリー曲を ACE-Step 用 workflow にコンパイルし、ComfyUI に投入する
- `submit-music-generation-job.json`:
  同じ `music-generation-adf` を long-running `generation-job` として submit し、後で status / wait / collect できるようにする
- `music-generation-schedule-anniversary.json`:
  `generation-schedule` として毎月の音楽生成ルールを表現する。scheduler runtime が入ったときの登録対象
