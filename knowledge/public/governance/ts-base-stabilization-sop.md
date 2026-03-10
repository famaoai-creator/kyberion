---
title: SOP: TypeScript Core Base Stabilization
category: Governance
tags: [governance, base, stabilization, sop]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# SOP: TypeScript Core Base Stabilization

TypeScript移行後の `libs/core` 等の基盤ライブラリにおいて、インポートエラー（`undefined` や `MODULE_NOT_FOUND`）が発生した際の標準復旧手順。

## 1. 統一エントリポイント (The Barrel Rule)
ライブラリ内の機能がバラバラにインポートされると、参照パスの解決が不安定になる。
- **Action**: `libs/{name}/index.ts` を作成し、外部に公開する全ての関数・型・定数を `export * from './module.js'` の形式で再エクスポートする。
- **Benefit**: AIおよびランタイムが `@agent/core` という単一の窓口からすべての機能にアクセスできるようになる。

## 2. 成果物へのリンク (The Dist-Link Rule)
ソースコード (`.ts`) に直接シンボリックリンクを張ると、実行時の成果物解決が複雑化する。
- **Action**: `node_modules/@agent/{name}` のリンク先を、ソースディレクトリではなく **`dist/libs/{name}`（ビルド成果物）** に向ける。
- **Benefit**: 「型定義はソース、実行はJS」という一貫性が保たれ、ESM/CJS境界での不整合が根絶される。

## 3. Package Exports の適正化
`package.json` の `exports` フィールドは、シンボリックリンク下でも動作するよう `./` 起点で定義する。
- **Action**: `dist` フォルダ内にも `package.json` が配置されるように調整するか、トップレベルの `package.json` でコンパイル済み成果物を確実に指し示す。

## 4. 型安全の一括確保 (Surgical Bulk Edit)
基盤側の型定義（シグネチャ）を変更した場合、依存する全てのスキルを速やかに修正する。
- **Strategy**: 
    1. `grep` で修正対象ファイルをリストアップ。
    2. `sed` などのストリームエディタを用いて、正規表現による一括置換。
    3. `npm run build` で物理的な型チェックを行い、エラーが0になるまで繰り返す。

## 5. 異常検知時のチェックリスト
実行時に `is not a function` や `undefined` が出たら以下を疑う：
- [ ] `@agent/core` のシンボリックリンク先は正しいか？ (`ls -l node_modules`)
- [ ] `dist/` 内に最新の成果物はビルドされているか？
- [ ] インポート文に `.js` 拡張子が付いているか（TS出力仕様への準拠）？
