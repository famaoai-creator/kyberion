---
title: lockfile review — hyperframes 0.8.105 → 0.8.147 (2026-10-13)
tags: [release-governance, lockfile, hyperframes, 2026-10]
last_updated: 2026-10-13
status: active
---

# lockfile review — hyperframes 0.8.105 → 0.8.147

`pnpm-lock.yaml` sha256: ed501cbaa1275013fb6a26e89d2e8c310c117952c03bf0a9837b50ef15a476f5

## 変更内容

- ルート devDependency `hyperframes` を `^0.8.105` → `^0.8.147` に更新（0.8.105→0.8.147、解決版 0.8.147）。
- 副次的な更新は `yauzl` 2.10.0→3.4.0（hyperframes の推移的依存）のみ。それ以外の差分なし。

## 目的

- ナレーション付き動画パイプライン（pipeline-templates/narrated-explainer-video.json）が必要とする CLI 機能を確保するため。
- 0.8.147 で `hyperframes remove-background`（CoreML ベースの透過化）と安定した `check`/`render` が利用可能。0.8.105 系では未検証。

## 検証

- `pnpm check -- --scope pr` 内の pinned-deps / install-script-allowlist / supply-chain policy は個別に PASS。
- hyperframes 0.8.147 で check/preview/render/remove-background を実機検証済み（active/shared/tmp/explainer/ で MP4 出力成功、MSN-MEDIA-PIPELINE-20261013）。
