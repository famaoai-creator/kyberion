---
title: SOP: TypeScript Core Base Stabilization
category: Governance
tags: [governance, base, stabilization, sop]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-21
---

# SOP: TypeScript Core Base Stabilization

TypeScript移行後の `libs/core` 等の基盤ライブラリにおいて、インポートエラー（`undefined` や `MODULE_NOT_FOUND`）が発生した際の標準復旧手順。

## 1. 統一エントリポイント (The Barrel Rule)
ライブラリ内の機能がバラバラにインポートされると、参照パスの解決が不安定になる。
- **Action**: `libs/{name}/index.ts` を作成し、外部に公開する全ての関数・型・定数を `export * from './module.js'` の形式で再エクスポートする。
- **Benefit**: AIおよびランタイムが `@agent/core` という単一の窓口からすべての機能にアクセスできるようになる。

## 2. 公開境界の固定 (The Package Contract Rule)
ソースコード (`.ts`) に直接依存すると、workspace 構造や ESM 解決順にランタイムが引きずられる。
- **Action**: 外部利用は package 名と `package.json#exports` に限定する。
- **Action**: `@agent/core/src/...` や `../libs/core/...` のような source-path import を禁止する。
- **Benefit**: workspace レイアウトから独立した安定した実行契約になる。

## 3. Shadow JavaScript の排除
TypeScript source の隣に古い `.js` 成果物が残ると、Node や loader が誤ってそちらを掴む。
- **Action**: `libs/core/` や `libs/core/src/` などの governed source tree から shadow `.js` を除去する。
- **Action**: 必要な runtime artifact は `dist/` にのみ存在させる。
- **Benefit**: source 実行時の `does not provide an export named ...` などの ESM/CJS 混線を防げる。

## 4. Package Exports の適正化
`package.json` の `exports` フィールドは、シンボリックリンク下でも動作するよう `./` 起点で定義する。
- **Action**: `dist` フォルダ内にも `package.json` が配置されるように調整するか、トップレベルの `package.json` でコンパイル済み成果物を確実に指し示す。

## 5. 型安全の一括確保 (Surgical Bulk Edit)
基盤側の型定義（シグネチャ）を変更した場合、依存する全てのスキルを速やかに修正する。
- **Strategy**: 
    1. `grep` で修正対象ファイルをリストアップ。
    2. `sed` などのストリームエディタを用いて、正規表現による一括置換。
    3. `npm run build` で物理的な型チェックを行い、エラーが0になるまで繰り返す。

## 6. 異常検知時のチェックリスト
実行時に `is not a function` や `undefined` が出たら以下を疑う：
- [ ] package import が `exports` に公開されているか？
- [ ] source tree に shadow `.js` が紛れ込んでいないか？
- [ ] インポート文に `.js` 拡張子が付いているか（TS出力仕様への準拠）？
- [ ] `pnpm run check:esm` は通るか？
