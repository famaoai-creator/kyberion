---
title: node-pty Permission Recovery Procedure
category: Incidents
tags: [incident, recovery, node-pty, macos, permissions]
knowledge_type: explicit
intelligence_layer: methodology
importance: 8
author: Sovereign Concierge
last_updated: 2026-03-06
---

# node-pty Permission Recovery Procedure

macOS (特に ARM64) 環境において、`node-pty` が `posix_spawnp failed` エラーでクラッシュする場合の物理的復旧手順.

## 1. 事象
- ターミナル起動時に `Error: posix_spawnp failed` が発生する.
- `npm rebuild` を行っても解消しない.

## 2. 原因
`node-pty` が内部で使用するネイティブバイナリ（`pty.node`）およびヘルパーバイナリ（`spawn-helper`）の実行権限（x）が欠落している、あるいは macOS の隔離フラグが付与されている.

## 3. 復旧手順 (Manual Recovery)

以下のコマンドを実行して、物理的な実行権限を強制付与し、隔離フラグを除去する.

```bash
# 実行権限の付与
find node_modules/.pnpm/node-pty@* -name "pty.node" -o -name "spawn-helper" | xargs chmod +x

# 隔離フラグの除去 (必要な場合)
find node_modules/.pnpm/node-pty@* -name "pty.node" -o -name "spawn-helper" | xargs xattr -d com.apple.quarantine || true
```

## 4. 恒久対策
Kyberion の `libs/core/reflex-terminal.ts` は **Self-Healing Edition (v3.0)** にアップデートされている. これにより、物理的な故障が発生しても `child_process` エミュレーションモードへ自動フォールバックするため、システム全体のクラッシュは回避される.

---
*Created by M-LEARN-OPENCLAW-ANALYSIS*
